// A client for apex-daemon's protocol (protocol v1, see
// crates/apex-daemon/src/protocol.rs): newline-delimited JSON over whatever
// link carries it. It says hello, matches replies to calls, hands events to
// listeners, and reconnects after a drop, resuming from the last event it
// saw. No DOM and no Electron here, so the phone app can use it too.

/** One connection to the daemon, carrying whole lines. */
export interface Link {
  send(line: string): void;
  close(): void;
  onLine(cb: (line: string) => void): void;
  /** `final` when retrying can't help (the host revoked this phone, say). */
  onClose(cb: (reason: string, final?: boolean) => void): void;
}

/** A link error that retrying can't fix. The client stops and says why. */
export class FinalError extends Error {
  readonly final = true;
}

/** Open a new link. A rejection counts as a connection that closed at once; a `FinalError` rejection stops retrying. */
export type Connect = () => Promise<Link>;

/** What `hello` answers. */
export interface Welcome {
  host_id: string;
  boot_id: string;
  protocol: number;
  last_seq: number;
  resumed: boolean;
  /** The apex-daemon version. Helpers older than 0.5.1 don't send it. */
  version?: string;
  /** Over iroh only: what this phone may do there. */
  access?: { tier: "read_only" | "chat" | "full"; threads: "all" | string[] };
  /** Over iroh only: the addresses the machine says it can be dialed on now. */
  addrs?: string[];
}

export type Status =
  | { kind: "connecting" }
  | { kind: "connected"; hostId: string }
  | { kind: "reconnecting"; attempt: number; reason: string; retryAt: number }
  /** Reconnected, but the events missed are gone; the window reloads. */
  | { kind: "resync" }
  /** The daemon refused us (a protocol mismatch, say); no automatic retry. */
  | { kind: "failed"; reason: string };

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const PROTOCOL = 1;
export const LOST = "The connection to the host was lost, so this may not have finished.";
export const NOT_CONNECTED = "Not connected to the host.";

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** 1, 2, 4, 8, 16, then 30 s. */
export function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
}

interface Pending {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class DaemonClient {
  private readonly connect: Connect;
  private readonly delay: (attempt: number) => number;
  private readonly timers: Timers;
  private link: Link | null = null;
  /** Past the welcome on the current link. */
  private ready = false;
  private helloId = -1;
  private helper: string | null | undefined = undefined;
  /** The apex-daemon version from the latest welcome: null for a helper too old to say, undefined before any welcome. */
  get helperVersion(): string | null | undefined {
    return this.helper;
  }
  private latest: Welcome | null = null;
  /** The latest welcome, null before the first. */
  get welcome(): Welcome | null {
    return this.latest;
  }
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly statusListeners = new Set<(status: Status) => void>();
  private status: Status = { kind: "connecting" };
  /** Where we are, once a welcome came; resuming needs both. */
  private bootId: string | null = null;
  private hostId = "";
  private lastSeq = 0;
  private attempt = 0;
  private retryTimer: unknown = null;
  /** Said by the daemon just before it closes the connection. */
  private parting: string | null = null;
  private closed = false;
  private started: Promise<Welcome> | null = null;
  private resolveStarted: ((welcome: Welcome) => void) | null = null;
  /** Sent with hello on a WebSocket. The desktop's stdio link doesn't use one. */
  private readonly token: string | null;

  constructor(connect: Connect, options: { delay?: (attempt: number) => number; timers?: Timers; token?: string } = {}) {
    this.connect = connect;
    this.delay = options.delay ?? backoff;
    this.timers = options.timers ?? realTimers;
    const token = options.token?.trim() ?? "";
    this.token = token ? token : null;
  }

  /** Connect, retrying until the first welcome. */
  start(): Promise<Welcome> {
    if (!this.started) {
      this.started = new Promise((resolve) => (this.resolveStarted = resolve));
      void this.open();
    }
    return this.started;
  }

  call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const link = this.link;
    if (!link || !this.ready) return Promise.reject(new Error(NOT_CONNECTED));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { command: cmd, resolve: resolve as (value: unknown) => void, reject });
      link.send(JSON.stringify({ id, cmd, args }));
    });
  }

  on<T>(event: string, cb: (payload: T) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const listener = cb as (payload: unknown) => void;
    set.add(listener);
    return () => set.delete(listener);
  }

  /** `cb` hears the current status at once, then every change. */
  onStatus(cb: (status: Status) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  /** Try to connect now instead of waiting. */
  retryNow(): void {
    if (this.closed || (this.link && this.ready)) return;
    if (this.link) return; // an attempt is already under way
    this.cancelRetry();
    void this.open();
  }

  close(): void {
    this.closed = true;
    this.cancelRetry();
    const link = this.link;
    this.drop(LOST);
    link?.close();
  }

  /** Recovery has read this host's rooms; ordinary commands can resume. */
  finishResync(): void {
    if (this.ready && this.status.kind === "resync") this.setStatus({ kind: "connected", hostId: this.hostId });
  }

  private setStatus(status: Status) {
    this.status = status;
    this.statusListeners.forEach((cb) => cb(status));
  }

  private async open() {
    let link: Link;
    try {
      link = await this.connect();
    } catch (e) {
      if (e instanceof FinalError) this.stop(e.message);
      else this.lost(e instanceof Error ? e.message : String(e));
      return;
    }
    if (this.closed) {
      link.close();
      return;
    }
    this.link = link;
    this.ready = false;
    this.parting = null;
    link.onLine((line) => {
      if (this.link === link) this.receive(link, line);
    });
    link.onClose((reason, final) => {
      if (this.link !== link) return;
      if (final) this.stop(reason);
      else this.lost(this.parting ?? reason);
    });
    this.helloId = this.nextId++;
    const args: Record<string, unknown> = { protocol: PROTOCOL };
    if (this.token) args.token = this.token;
    if (this.bootId !== null) args.since = { boot_id: this.bootId, seq: this.lastSeq };
    link.send(JSON.stringify({ id: this.helloId, cmd: "hello", args }));
  }

  private receive(link: Link, line: string) {
    let frame: { id?: number | null; ok?: unknown; err?: string; reason?: unknown; seq?: number; event?: string; payload?: unknown };
    try {
      frame = JSON.parse(line);
    } catch {
      link.close();
      const shown = line.length > 80 ? `${line.slice(0, 80)}…` : line;
      this.lost(`The host sent something that isn't part of the protocol: "${shown}". A shell startup file there may be printing it.`);
      return;
    }
    if (typeof frame.seq === "number" && typeof frame.event === "string") {
      if (!this.ready || frame.seq <= this.lastSeq) return;
      this.lastSeq = frame.seq;
      this.listeners.get(frame.event)?.forEach((cb) => cb(frame.payload));
      return;
    }
    if (frame.id === null || frame.id === undefined) {
      // The daemon is about to close the connection, and says why.
      if (typeof frame.err === "string") this.parting = frame.err;
      return;
    }
    if (frame.id === this.helloId && !this.ready) {
      this.welcomed(link, frame);
      return;
    }
    const waiting = this.pending.get(frame.id);
    if (!waiting) return;
    this.pending.delete(frame.id);
    // A refusal's `reason` word, when the daemon gives one, rides on the error for callers that switch on it.
    if (typeof frame.err === "string") {
      const unsupportedMonitor = waiting.command.startsWith("monitor_")
        && frame.err.includes(`unknown variant \`${waiting.command}\``);
      const message = unsupportedMonitor
        ? "This host’s Apex Deck service does not support project monitoring. Update the service on the project machine, then reconnect."
        : frame.err;
      waiting.reject(Object.assign(new Error(message), {
        ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}),
        ...(unsupportedMonitor ? { reason: "monitor_unsupported" } : {}),
      }));
    }
    else waiting.resolve(frame.ok ?? null);
  }

  private welcomed(link: Link, frame: { ok?: unknown; err?: string }) {
    const welcome = frame.ok as Welcome | undefined;
    if (typeof frame.err === "string" || !welcome) {
      this.fail(link, frame.err ?? "The host didn't answer hello.");
      return;
    }
    if (welcome.protocol !== PROTOCOL) {
      this.fail(link, `The host speaks protocol ${welcome.protocol}, and this app speaks ${PROTOCOL}; update one of them.`);
      return;
    }
    const wasConnected = this.bootId !== null;
    this.helper = typeof welcome.version === "string" ? welcome.version : null;
    this.latest = welcome;
    this.ready = true;
    this.attempt = 0;
    this.bootId = welcome.boot_id;
    this.hostId = welcome.host_id;
    // Resuming, the replay that follows starts after where we were.
    if (!welcome.resumed) this.lastSeq = welcome.last_seq;
    if (wasConnected && !welcome.resumed) this.setStatus({ kind: "resync" });
    else this.setStatus({ kind: "connected", hostId: welcome.host_id });
    this.resolveStarted?.(welcome);
    this.resolveStarted = null;
  }

  /** Refused: say why and wait to be asked again. */
  private fail(link: Link, reason: string) {
    this.link = null;
    this.ready = false;
    link.close();
    this.rejectPending(LOST);
    this.setStatus({ kind: "failed", reason });
  }

  /** The link can't come back by itself: fail what's in flight, no retry timer. */
  private stop(reason: string) {
    this.drop(LOST);
    if (this.closed) return;
    this.cancelRetry();
    this.setStatus({ kind: "failed", reason });
  }

  /** The link went away: fail what's in flight and plan the next try. */
  private lost(reason: string) {
    this.drop(LOST);
    if (this.closed) return;
    this.attempt += 1;
    const wait = this.delay(this.attempt);
    this.setStatus({ kind: "reconnecting", attempt: this.attempt, reason, retryAt: this.timers.now() + wait });
    this.cancelRetry();
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, wait);
  }

  private drop(why: string) {
    this.link = null;
    this.ready = false;
    this.rejectPending(why);
  }

  private rejectPending(why: string) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    pending.forEach((p) => p.reject(new Error(why)));
  }

  private cancelRetry() {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
