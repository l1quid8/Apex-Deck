// The ApexRemote native plugin (iphone/ApexRemote) as the phone app sees it:
// iroh connections and QR pairing, each named by a handle. Every native event
// goes to the one subscriber for its handle; events for a handle nobody holds
// any more are dropped.

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type RemoteMode = "automatic" | "direct";
export type Route = "direct" | "relayed" | "none";

/** One native event. Codes below 1000 come from the host, 1000+ from the bridge. */
export type RemoteEvent =
  | { type: "opened"; handle: number }
  | { type: "route"; handle: number; route: Route }
  | { type: "line"; handle: number; line: string }
  | { type: "closed"; handle: number; code: number; reason: string }
  | { type: "pairCode"; handle: number; code: string; hostName: string }
  | {
      type: "pairDone";
      handle: number;
      hostEndpointId: string;
      addrs: string[];
      name: string;
      hostId?: string | null;
      hostName?: string | null;
      tier?: string | null;
      threads?: unknown;
    };

/** What the app needs from the plugin. Tests pass a fake. */
export interface RemotePlugin {
  identity(): Promise<string>;
  setMode(mode: RemoteMode): Promise<string>;
  /** Resolves with the handle before any dialing, so Cancel works at once. */
  connect(hostEndpointId: string, addrs: string[]): Promise<number>;
  send(handle: number, line: string): Promise<void>;
  close(handle: number): Promise<void>;
  pair(link: string, label: string): Promise<number>;
  pairCancel(handle: number): Promise<void>;
  /** Hear `handle`'s events, including any that came before this call. Returns the way to stop. */
  listen(handle: number, cb: (event: RemoteEvent) => void): () => void;
}

/** Codes the host closes with (crates/apex-daemon/src/remote.rs, pairing.rs). */
export const CLOSE = {
  BYE: 0,
  NOT_PAIRED: 1,
  REVOKED: 2,
  PAIR_UNKNOWN: 10,
  PAIR_EXPIRED: 11,
  PAIR_USED: 12,
  PAIR_BAD_PROOF: 13,
  PAIR_DENIED: 14,
  // The bridge's own (crates/iroh-mobile/src/lib.rs `close`).
  CLOSED: 1000,
  OVERFLOW: 1001,
  UNREACHABLE: 1002,
  WRONG_HOST: 1003,
  PROTOCOL: 1004,
  LOST: 1005,
  STOPPED: 1006,
  TIMEOUT: 1007,
} as const;

/** Events held for a handle before its subscriber arrives. */
const EARLY_EVENTS = 64;
/** Handles with early events held at once. */
const EARLY_HANDLES = 32;

/**
 * Routes a stream of native events to per-handle subscribers. A subscriber
 * may arrive after a handle's first events (the native call resolves on
 * another thread), so a few are held until it does. After `closed` the
 * handle is gone and later events for it are dropped. A handle whose early
 * events don't fit is closed through `onOverflow` and its subscriber hears an
 * OVERFLOW close, so the client reconnects and replays instead of missing lines.
 */
export class EventRouter {
  private readonly subscribers = new Map<number, (event: RemoteEvent) => void>();
  private readonly early = new Map<number, RemoteEvent[]>();
  private readonly ended = new Set<number>();
  private readonly overflowed = new Set<number>();
  private readonly onOverflow: (handle: number) => void;

  constructor(onOverflow: (handle: number) => void = () => {}) {
    this.onOverflow = onOverflow;
  }

  deliver(event: RemoteEvent): void {
    const handle = event.handle;
    if (typeof handle !== "number" || this.ended.has(handle)) return;
    const closed = event.type === "closed";
    if (closed) this.end(handle);
    const cb = this.subscribers.get(handle);
    if (cb) {
      if (closed) this.subscribers.delete(handle);
      cb(event);
      return;
    }
    let held = this.early.get(handle);
    if (!held) {
      if (this.early.size >= EARLY_HANDLES) return closed ? this.keepClose(handle, event) : this.overflow(handle);
      this.early.set(handle, (held = []));
    }
    // The final "closed" is always kept, so a late subscriber still hears how it ended.
    if (closed || held.length < EARLY_EVENTS) held.push(event);
    else this.overflow(handle);
  }

  listen(handle: number, cb: (event: RemoteEvent) => void): () => void {
    const held = this.early.get(handle) ?? [];
    this.early.delete(handle);
    if (this.overflowed.delete(handle)) held.push({ type: "closed", handle, code: CLOSE.OVERFLOW, reason: "too many events before the app was listening" });
    if (!this.ended.has(handle)) this.subscribers.set(handle, cb);
    held.forEach((event) => cb(event));
    return () => {
      if (this.subscribers.get(handle) === cb) this.subscribers.delete(handle);
    };
  }

  /** Drop what's held, close the handle natively, and tell the subscriber when it comes. */
  private overflow(handle: number) {
    this.early.delete(handle);
    this.end(handle);
    this.overflowed.add(handle);
    this.onOverflow(handle);
  }

  /** A close for a handle that found the early table full: keep only the close. */
  private keepClose(handle: number, event: RemoteEvent) {
    this.early.set(handle, [event]);
  }

  private end(handle: number) {
    this.ended.add(handle);
    // Handles only grow, so the oldest ended ones can go.
    if (this.ended.size > 4096) {
      const oldest = this.ended.values().next().value!;
      this.ended.delete(oldest);
      this.overflowed.delete(oldest);
      this.early.delete(oldest);
    }
  }
}

interface Native {
  identity(): Promise<{ endpointId: string }>;
  setMode(options: { mode: RemoteMode }): Promise<{ endpointId: string }>;
  connect(options: { hostEndpointId: string; addrs: string[] }): Promise<{ handle: number }>;
  send(options: { handle: number; line: string }): Promise<void>;
  close(options: { handle: number }): Promise<void>;
  pair(options: { link: string; label: string }): Promise<{ handle: number }>;
  pairCancel(options: { handle: number }): Promise<void>;
  addListener(eventName: "event", listener: (event: RemoteEvent) => void): Promise<PluginListenerHandle>;
}

class NativeRemote implements RemotePlugin {
  // Overflow closes natively; "close" also cancels a pairing handle.
  private readonly router = new EventRouter((handle) => { void this.native.close({ handle }).catch(() => {}); });
  private readonly ready: Promise<unknown>;
  private readonly native: Native;

  constructor(native: Native) {
    this.native = native;
    this.ready = native.addListener("event", (event) => this.router.deliver(event));
  }

  async identity() {
    return (await this.native.identity()).endpointId;
  }
  async setMode(mode: RemoteMode) {
    await this.ready;
    return (await this.native.setMode({ mode })).endpointId;
  }
  async connect(hostEndpointId: string, addrs: string[]) {
    await this.ready;
    return (await this.native.connect({ hostEndpointId, addrs })).handle;
  }
  send(handle: number, line: string) {
    return this.native.send({ handle, line });
  }
  close(handle: number) {
    return this.native.close({ handle });
  }
  async pair(link: string, label: string) {
    await this.ready;
    return (await this.native.pair({ link, label })).handle;
  }
  pairCancel(handle: number) {
    return this.native.pairCancel({ handle });
  }
  listen(handle: number, cb: (event: RemoteEvent) => void) {
    return this.router.listen(handle, cb);
  }
}

let shared: RemotePlugin | null = null;

/** The native plugin, or null outside the iPhone app (Safari, tests). */
export function remotePlugin(): RemotePlugin | null {
  if (!shared && Capacitor.isPluginAvailable("ApexRemote")) shared = new NativeRemote(registerPlugin<Native>("ApexRemote"));
  return shared;
}

/** The camera QR scanner, or null outside the iPhone app. Resolves with the code's text; rejects "cancelled" or "denied". */
export function qrScanner(): { scan(): Promise<string> } | null {
  if (!Capacitor.isPluginAvailable("ApexScanner")) return null;
  const native = registerPlugin<{ scan(): Promise<{ text: string }> }>("ApexScanner");
  return { scan: async () => (await native.scan()).text };
}
