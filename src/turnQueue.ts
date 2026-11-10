/** Serializes a room's turns; queued context never overlaps an active turn. */
import type { TurnPolicy } from "./types";
import { hasMention } from "./recipients.ts";
import type { Mentionable } from "./slug.ts";
/** "turn" runs bots on the transcript as it is and posts no text (see ParticipantQueues.turn). */
export type TurnKind =
  "message" | "compact" | "curate" | "curate_undo" | "turn";
/** Context changes wait for the whole room and block every later turn. */
export function wholeRoom(kind: TurnKind): boolean {
  return kind === "compact" || kind === "curate" || kind === "curate_undo";
}
/** `hops` is set on "turn" items only: the cap on bot-to-bot rounds, null for the room's own. */
export interface QueuedMessage {
  id: number;
  text: string;
  kind: TurnKind;
  hops?: number | null;
  voice?: { requestId: string; canceled?: () => boolean };
}
export class TurnQueue {
  items: QueuedMessage[] = [];
  active = false;
  paused = false;
  private serial = 0;
  private post: (text: string, kind: TurnKind) => Promise<void>;
  private stop: () => Promise<void>;
  private changed: (items: QueuedMessage[]) => void;
  /** `unsent` is a message that never left and isn't kept here: the caller holds what it needs to give it back. */
  private failed: (error: unknown, unsent?: ParticipantMessage) => void;
  constructor(
    post: (text: string, kind: TurnKind) => Promise<void>,
    stop: () => Promise<void>,
    changed: (items: QueuedMessage[]) => void,
    failed: (error: unknown) => void = () => {},
  ) {
    this.post = post;
    this.stop = stop;
    this.changed = changed;
    this.failed = failed;
  }
  send(text: string, kind: TurnKind = "message"): number {
    const id = ++this.serial;
    this.items.push({ id, text, kind });
    this.publish();
    void this.drain();
    return id;
  }
  edit(id: number, text: string, kind: TurnKind = "message") {
    this.items = this.items.map((item) =>
      item.id === id ? { ...item, text, kind } : item,
    );
    this.publish();
  }
  remove(id: number) {
    this.items = this.items.filter((item) => item.id !== id);
    this.publish();
  }
  resume() {
    this.paused = false;
    void this.drain();
  }
  async steer(text: string) {
    // Reserve priority before stopping: stop may finish the current post.
    this.paused = true;
    this.items.unshift({ id: ++this.serial, text, kind: "message" });
    this.publish();
    try {
      if (this.active) await this.stop();
    } catch (error) {
      this.failed(error);
      return;
    }
    this.resume();
  }
  async halt() {
    this.paused = true;
    if (this.active) await this.stop();
  }
  private publish() {
    this.changed([...this.items]);
  }
  private async drain() {
    if (this.active || this.paused) return;
    this.active = true;
    try {
      while (this.items.length && !this.paused) {
        const item = this.items.shift()!;
        this.publish();
        try {
          await this.post(item.text, item.kind);
        } catch (error) {
          this.paused = true;
          this.failed(error);
        }
      }
    } finally {
      this.active = false;
    }
  }
}

export interface WireParts {
  typed: string;
  paths: string[];
  tldr: boolean;
}
export interface ItemMeta {
  routing: string;
  parts: WireParts;
  servers: string[];
}
export interface ParticipantMessage extends QueuedMessage {
  to: string[];
  pinned?: boolean;
  failed?: boolean;
  oneOff?: true;
  routing?: string;
  parts?: WireParts;
  servers?: string[];
  refused?: string;
  failure?: string;
  unmade?: Admission;
}
export type ItemState =
  | "preparing"
  | "waiting"
  | "posting"
  | "failed"
  | "posted"
  | "removed"
  | "closed"
  | "unknown";
export interface Admission {
  kind: TurnKind;
  routing: string;
  servers?: string[];
  to: string[] | null;
  label: string;
  keep: boolean;
  prepare(to: string[]): Promise<{ text: string; parts?: WireParts }>;
}
export class QueueClosed extends Error {
  constructor() {
    super("This thread's queue is closed.");
    this.name = "QueueClosed";
  }
}
export class Unsent extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "Unsent";
  }
}
export type QueueHold = "connection" | "stopped" | "failed" | "behind";
interface Making {
  a: Admission;
  item: ParticipantMessage;
  entered: boolean;
  canceled?: unknown;
  cancel?: (error: unknown) => void;
  running: boolean;
  generation?: number;
}
/** A recipient FIFO, shared by thread composers, slices, phone and voice. */
export class ParticipantQueues {
  readonly instance = globalThis.crypto.randomUUID();
  connectionPaused = false;
  items: ParticipantMessage[] = [];
  state: Record<string, "idle" | "working"> = {};
  paused = new Set<string>();
  private halted = new Set<string>();
  private serial = 0;
  private accepting: Promise<unknown> = Promise.resolve();
  private draining = false;
  private rerun = false;
  private closed = false;
  private availabilityEpoch = 0;
  private states = new Map<number, { state: ItemState; error?: unknown }>();
  private listeners = new Map<
    number,
    Set<(state: ItemState, error?: unknown) => void>
  >();
  private terminal: number[] = [];
  private making = new Map<number, Making>();
  private suspensions = new Map<symbol, string>();
  private targets: (text: string) => Promise<string[]>;
  private post: (
    text: string,
    to: string[],
    kind: TurnKind,
    hops?: number | null,
    voice?: { requestId: string; canceled?: () => boolean },
    oneOff?: true,
    parts?: WireParts,
  ) => Promise<void>;
  private stop: (id?: string) => Promise<void>;
  private changed: (items: ParticipantMessage[]) => void;
  private failed: (error: unknown, unsent?: ParticipantMessage) => void;
  private available: () => boolean;
  private retainFailed: boolean;
  private ask: ((text: string) => Promise<string[]>) | null;
  private check:
    ((to: string[], item: ParticipantMessage) => string | null) | null;
  constructor(
    targets: (text: string) => Promise<string[]>,
    post: (
      text: string,
      to: string[],
      kind: TurnKind,
      hops?: number | null,
      voice?: { requestId: string; canceled?: () => boolean },
      oneOff?: true,
      parts?: WireParts,
    ) => Promise<void>,
    stop: (id?: string) => Promise<void>,
    changed: (items: ParticipantMessage[]) => void,
    failed: (error: unknown, unsent?: ParticipantMessage) => void = () => {},
    available: () => boolean = () => true,
    retainFailed = true,
    ask: ((text: string) => Promise<string[]>) | null = null,
    check:
      ((to: string[], item: ParticipantMessage) => string | null) | null = null,
  ) {
    this.targets = targets;
    this.post = post;
    this.stop = stop;
    this.changed = changed;
    this.failed = failed;
    this.available = available;
    this.retainFailed = retainFailed;
    this.ask = ask;
    this.check = check;
  }
  private setState(id: number, state: ItemState, error?: unknown) {
    const previous = this.states.get(id)?.state;
    this.states.set(id, { state, error });
    this.listeners.get(id)?.forEach((cb) => cb(state, error));
    if (
      ["posted", "removed", "closed", "unknown"].includes(state) &&
      previous !== state
    ) {
      this.terminal.push(id);
      while (this.terminal.length > 1000) {
        const old = this.terminal.shift()!;
        if (
          ["posted", "removed", "closed", "unknown"].includes(this.status(old))
        )
          this.states.delete(old);
      }
    }
  }
  status(id: number): ItemState {
    return this.states.get(id)?.state ?? "unknown";
  }
  watch(
    id: number,
    cb: (state: ItemState, error?: unknown) => void,
  ): () => void {
    const callbacks = this.listeners.get(id) ?? new Set();
    callbacks.add(cb);
    this.listeners.set(id, callbacks);
    const s = this.states.get(id);
    cb(s?.state ?? "unknown", s?.error);
    return () => {
      callbacks.delete(cb);
      if (!callbacks.size) this.listeners.delete(id);
    };
  }
  unsent(): number {
    return [...this.states.values()].filter((s) =>
      ["preparing", "waiting", "posting", "failed"].includes(s.state),
    ).length;
  }
  private get suspended() {
    return this.suspensions.values().next().value as string | undefined;
  }
  private requireAvailable(epoch = this.availabilityEpoch) {
    if (this.closed) throw new QueueClosed();
    if (this.suspended) throw new Unsent(this.suspended);
    if (!this.available() || epoch !== this.availabilityEpoch)
      throw new Error("Not connected to the host; nothing was queued.");
  }
  suspend(reason: string): () => void {
    const token = Symbol();
    this.suspensions.set(token, reason);
    for (const m of this.making.values())
      this.cancelMaking(m, new Unsent(reason));
    return () => {
      if (this.suspensions.delete(token)) void this.drain();
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, s] of this.states) {
      if (s.state === "posting") continue;
      if (
        s.state === "failed" &&
        !this.items.find((i) => i.id === id)?.unmade &&
        !this.items.find((i) => i.id === id)?.refused
      )
        this.setState(id, "unknown");
      else if (["preparing", "waiting", "failed"].includes(s.state))
        this.setState(id, "closed");
    }
    for (const m of this.making.values())
      this.cancelMaking(m, new QueueClosed());
    this.items = [];
  }
  availabilityChanged() {
    if (this.closed) return;
    if (!this.available()) {
      this.availabilityEpoch++;
      if (this.items.length || this.active) this.connectionPaused = true;
      this.publish();
      return;
    }
    if (this.connectionPaused) {
      this.connectionPaused = false;
      this.publish();
      void this.drain();
    }
  }
  holdOf(item: ParticipantMessage): QueueHold | null {
    if (this.connectionPaused) return "connection";
    for (const prior of this.items) {
      if (prior.id === item.id) break;
      if (
        (prior.unmade || prior.refused) &&
        (!prior.to.length ||
          wholeRoom(prior.kind) ||
          prior.to.some((id) => item.to.includes(id)))
      )
        return "behind";
    }
    const held = item.to.filter((id) => this.paused.has(id));
    return !held.length
      ? null
      : held.some((id) => this.halted.has(id))
        ? "stopped"
        : "failed";
  }
  get active() {
    return Object.values(this.state).includes("working");
  }
  send(
    text: string,
    kind: TurnKind = "message",
    meta?: ItemMeta,
  ): Promise<number> {
    return this.enqueue(text, kind, undefined, undefined, meta);
  }
  sendTo(
    text: string,
    to: string[],
    voice?: { requestId: string; canceled?: () => boolean },
  ): Promise<number> {
    return this.enqueue(text, "message", to, voice);
  }
  private enqueue(
    text: string,
    kind: TurnKind,
    to?: string[],
    voice?: { requestId: string; canceled?: () => boolean },
    meta?: ItemMeta,
  ): Promise<number> {
    const id = ++this.serial;
    const refusedAtCall = this.suspended;
    this.setState(id, this.closed ? "closed" : "preparing");
    const accepted = this.accepting
      .then(async () => {
        if (refusedAtCall) throw new Unsent(refusedAtCall);
        this.requireAvailable();
        const epoch = this.availabilityEpoch;
        const ids = to ?? (await this.targets(meta?.routing ?? text));
        this.requireAvailable(epoch);
        if (voice?.canceled?.())
          throw new Error("Voice turn canceled before dispatch");
        for (const target of ids)
          if (
            this.paused.has(target) &&
            !this.items.some((i) => i.to.includes(target))
          ) {
            this.paused.delete(target);
            this.halted.delete(target);
          }
        this.items.push({
          id,
          text,
          kind,
          to: [...ids],
          ...(to ? { pinned: true } : {}),
          ...(voice ? { voice } : {}),
          ...meta,
        });
        this.setState(id, "waiting");
        this.publish();
        await this.drain();
        return id;
      })
      .catch((error) => {
        if (this.status(id) === "preparing")
          this.setState(id, this.closed ? "closed" : "removed", error);
        throw error;
      });
    this.accepting = accepted.catch(() => {});
    return accepted;
  }
  sendOnce(text: string, to: string[], meta?: ItemMeta): Promise<number> {
    return this.admit({
      kind: "message",
      routing: meta?.routing ?? text,
      servers: meta?.servers,
      to,
      label: meta?.parts.typed ?? text,
      keep: false,
      prepare: async () => ({ text, parts: meta?.parts }),
    }).done;
  }
  admit(a: Admission): { id: number; done: Promise<number> } {
    const id = ++this.serial;
    const item: ParticipantMessage = {
      id,
      text: a.label,
      kind: a.kind,
      to: a.to ? [...a.to] : [],
      routing: a.routing,
      servers: a.servers,
      unmade: a,
      ...(a.to ? { pinned: true, oneOff: true as const } : {}),
    };
    const m: Making = { a, item, entered: false, running: false };
    this.making.set(id, m);
    this.setState(id, this.closed ? "closed" : "preparing");
    if (this.closed) {
      this.making.delete(id);
      return { id, done: Promise.reject(new QueueClosed()) };
    }
    if (this.suspended) this.cancelMaking(m, new Unsent(this.suspended));
    let drain: Promise<void> = Promise.resolve();
    const accepted = this.accepting.then(async () => {
      m.entered = true;
      if (this.closed) throw new QueueClosed();
      if (this.status(id) === "removed") {
        if (this.making.has(id) && m.canceled) {
          this.making.delete(id);
          throw m.canceled;
        }
        return;
      }
      try {
        await this.make(m);
        this.requireAvailable();
      } catch (error) {
        if (this.closed) {
          this.setState(id, "closed", error);
          throw error;
        }
        if (this.status(id) === "removed") return;
        if (a.keep) {
          item.failed = true;
          item.unmade = a;
          item.failure = String(error).replace(/^Error: /, "");
          this.items.push(item);
          this.setState(id, "failed", error);
          this.publish();
        } else {
          this.setState(id, "removed", error);
          this.making.delete(id);
        }
        throw error;
      }
      if (this.closed) throw new QueueClosed();
      if (this.status(id) === "removed") return;
      delete item.unmade;
      this.making.delete(id);
      for (const target of item.to)
        if (
          this.paused.has(target) &&
          !this.items.some((i) => i.to.includes(target))
        ) {
          this.paused.delete(target);
          this.halted.delete(target);
        }
      this.items.push(item);
      this.setState(id, "waiting");
      this.publish();
      drain = this.drain();
    });
    this.accepting = accepted.catch(() => {});
    return {
      id,
      done: accepted.then(async () => {
        await drain;
        return id;
      }),
    };
  }
  private cancelMaking(m: Making, error: unknown) {
    if (
      this.status(m.item.id) !== "preparing" &&
      !(error instanceof QueueClosed && m.running)
    )
      return;
    m.canceled = error;
    m.generation = (m.generation ?? 0) + 1;
    this.setState(
      m.item.id,
      error instanceof QueueClosed ? "closed" : m.a.keep ? "failed" : "removed",
      error,
    );
    m.cancel?.(error);
  }
  private async make(m: Making) {
    if (m.canceled) throw m.canceled;
    m.running = true;
    const generation = (m.generation = (m.generation ?? 0) + 1);
    const live = () => {
      if (m.generation !== generation)
        throw new Unsent("Preparation superseded");
      if (m.canceled) throw m.canceled;
    };
    try {
      await Promise.race([
        (async () => {
          this.requireAvailable();
          const epoch = this.availabilityEpoch;
          const to = m.a.to ?? (await this.targets(m.a.routing));
          live();
          this.requireAvailable(epoch);
          m.item.to = [...to];
          const result = await m.a.prepare(to);
          live();
          this.requireAvailable(epoch);
          m.item.text = result.text;
          m.item.parts = result.parts;
        })(),
        new Promise<never>((_, reject) => (m.cancel = reject)),
      ]);
    } finally {
      m.running = false;
      m.cancel = undefined;
    }
  }
  giveUp(id: number) {
    if (this.closed) return;
    const m = this.making.get(id);
    if (m) this.cancelMaking(m, new Unsent("Stopped waiting"));
  }
  started(id: string) {
    if (this.closed) return;
    this.state[id] = "working";
    if (!this.halted.has(id)) this.paused.delete(id);
    this.publish();
  }
  idle(id: string) {
    if (this.closed) return;
    this.state[id] = "idle";
    this.publish();
    void this.drain();
  }
  roomIdle() {
    if (this.closed) return;
    this.publish();
    void this.drain();
  }
  retry(id: number) {
    if (this.closed || this.suspended || !this.available()) return;
    const m = this.making.get(id);
    if (m && !m.entered && this.status(id) === "failed") {
      m.canceled = undefined;
      this.setState(id, "preparing");
      return;
    }
    const item = this.items.find((i) => i.id === id);
    if (!item?.failed) return;
    if (item.unmade) {
      if (m?.running) return;
      const remake = m ?? {
        a: item.unmade,
        item,
        entered: true,
        running: false,
      };
      remake.canceled = undefined;
      this.making.set(id, remake);
      this.setState(id, "preparing");
      void this.make(remake).then(
        () => {
          if (this.closed || this.status(id) === "removed") return;
          delete item.unmade;
          item.failed = false;
          this.making.delete(id);
          this.setState(id, "waiting");
          this.publish();
          void this.drain();
        },
        (error) => {
          if (this.closed || this.status(id) === "removed") return;
          item.failed = true;
          item.failure = String(error).replace(/^Error: /, "");
          this.setState(id, "failed", error);
          this.publish();
        },
      );
      return;
    }
    this.connectionPaused = false;
    item.failed = false;
    delete item.refused;
    item.to.forEach((t) => this.paused.delete(t));
    this.setState(id, "waiting");
    this.publish();
    void this.drain();
  }
  error(id: string) {
    if (this.closed) return;
    this.paused.add(id);
    this.publish();
  }
  resume(id?: string) {
    if (this.closed || !this.available()) return;
    this.connectionPaused = false;
    if (id) {
      this.paused.delete(id);
      this.halted.delete(id);
    } else {
      this.paused.clear();
      this.halted.clear();
    }
    this.publish();
    void this.drain();
  }
  async edit(
    id: number,
    text: string,
    kind: TurnKind = "message",
    meta?: ItemMeta,
    keepTo = false,
  ) {
    if (this.closed) return;
    const item = this.items.find((i) => i.id === id);
    if (!item || item.unmade) return;
    this.requireAvailable();
    const epoch = this.availabilityEpoch;
    const to = keepTo ? item.to : await this.targets(meta?.routing ?? text);
    this.requireAvailable(epoch);
    if (!this.items.includes(item)) return;
    const next = { ...item, text, kind, to };
    delete next.refused;
    if (item.refused) next.failed = false;
    delete next.routing;
    delete next.parts;
    delete next.servers;
    if (meta) Object.assign(next, meta);
    if (!keepTo && item.oneOff) {
      delete next.oneOff;
      delete next.pinned;
    }
    this.items = this.items.map((i) => (i === item ? next : i));
    this.setState(id, next.failed ? "failed" : "waiting");
    this.publish();
    void this.drain();
  }
  remove(id: number) {
    if (this.closed) return;
    const m = this.making.get(id);
    if (m) {
      this.cancelMaking(m, new Unsent("Removed"));
      this.making.delete(id);
    }
    if (this.status(id) === "posting" || this.status(id) === "posted") return;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.states.has(id)) this.setState(id, "removed");
    this.publish();
    void this.drain();
  }
  async steer(id: string, text: string) {
    if (this.closed || this.suspended) return;
    this.requireAvailable();
    this.paused.add(id);
    const item = {
      id: ++this.serial,
      text,
      kind: "message" as const,
      to: [id],
      pinned: true,
    };
    this.items.unshift(item);
    this.setState(item.id, "waiting");
    this.publish();
    try {
      if (this.state[id] === "working") await this.stop(id);
      this.resume(id);
    } catch (error) {
      this.failed(error);
    }
  }
  async steerQueued(id: number) {
    if (this.closed || this.suspended) return;
    this.requireAvailable();
    const item = this.items.find((i) => i.id === id);
    if (!item || item.unmade) return;
    item.to.forEach((t) => this.paused.add(t));
    this.items = [item, ...this.items.filter((i) => i !== item)];
    this.publish();
    try {
      await Promise.all(
        item.to
          .filter((t) => this.state[t] === "working")
          .map((t) => this.stop(t)),
      );
      if (this.closed) return;
      item.to.forEach((t) => this.paused.delete(t));
      this.publish();
      void this.drain();
    } catch (error) {
      this.failed(error);
    }
  }
  turn(to: string[], hops: number | null) {
    if (this.closed || this.suspended || !this.available()) return;
    to.forEach((id) => this.paused.delete(id));
    const item = {
      id: ++this.serial,
      text: "",
      kind: "turn" as const,
      to,
      hops,
      pinned: true,
    };
    this.items.unshift(item);
    this.setState(item.id, "waiting");
    this.publish();
    void this.drain();
  }
  async halt(id?: string) {
    if (this.closed) return;
    for (const t of id ? [id] : Object.keys(this.state)) {
      this.paused.add(t);
      this.halted.add(t);
    }
    this.publish();
    try {
      await this.stop(id);
    } catch (error) {
      this.failed(error);
    }
  }
  private publish() {
    if (!this.closed) this.changed([...this.items]);
  }
  private async drain() {
    if (
      this.closed ||
      this.suspended ||
      !this.available() ||
      this.connectionPaused
    )
      return;
    if (this.draining) {
      this.rerun = true;
      return;
    }
    this.draining = true;
    try {
      const blocked = new Set<string>();
      for (const id of this.items.map((i) => i.id)) {
        const item = this.items.find((i) => i.id === id);
        if (!item) continue;
        if (
          this.closed ||
          this.suspended ||
          !this.available() ||
          this.connectionPaused
        )
          break;
        if (item.voice?.canceled?.()) {
          this.remove(id);
          continue;
        }
        if (item.unmade || item.refused) {
          if (!item.to.length || wholeRoom(item.kind)) break;
          item.to.forEach((t) => blocked.add(t));
          continue;
        }
        if (
          item.failed ||
          item.to.some(
            (t) =>
              blocked.has(t) ||
              this.paused.has(t) ||
              this.state[t] === "working",
          ) ||
          (wholeRoom(item.kind) && this.active)
        ) {
          if (wholeRoom(item.kind)) break;
          item.to.forEach((t) => blocked.add(t));
          continue;
        }
        if (!item.pinned && this.ask) {
          const epoch = this.availabilityEpoch;
          let fresh: string[] | null = null,
            lost: unknown = null;
          try {
            fresh = await this.ask(item.routing ?? item.text);
          } catch (error) {
            lost = error;
          }
          if (
            this.closed ||
            this.suspended ||
            !this.available() ||
            epoch !== this.availabilityEpoch ||
            this.connectionPaused
          )
            break;
          if (!this.items.includes(item)) continue;
          if (!fresh) {
            item.to.forEach((t) => {
              blocked.add(t);
              this.paused.add(t);
            });
            if (this.retainFailed) {
              item.failed = true;
              this.setState(id, "failed", lost);
            } else {
              this.items = this.items.filter((i) => i !== item);
              this.setState(id, "removed", lost);
            }
            this.failed(lost, this.retainFailed ? undefined : item);
            this.publish();
            continue;
          }
          item.to = fresh;
          if (
            item.to.some(
              (t) =>
                blocked.has(t) ||
                this.paused.has(t) ||
                this.state[t] === "working",
            )
          ) {
            item.to.forEach((t) => blocked.add(t));
            continue;
          }
        }
        const refusal =
          item.kind === "message" && item.routing !== undefined
            ? this.check?.(item.to, item)
            : null;
        if (refusal) {
          item.failed = true;
          item.refused = refusal;
          this.setState(id, "failed", new Unsent(refusal));
          item.to.forEach((t) => blocked.add(t));
          this.failed(new Unsent(refusal));
          this.publish();
          continue;
        }
        item.to.forEach((t) => (this.state[t] = "working"));
        this.items = this.items.filter((i) => i !== item);
        this.setState(id, "posting");
        this.publish();
        try {
          await this.post(
            item.text,
            item.to,
            item.kind,
            item.hops,
            item.voice,
            item.oneOff,
            item.parts,
          );
          this.setState(id, "posted");
          if (wholeRoom(item.kind)) {
            item.to.forEach((t) => (this.state[t] = "idle"));
            this.publish();
          }
        } catch (error) {
          item.to.forEach((t) => {
            this.state[t] = "idle";
            this.paused.add(t);
          });
          if (this.closed) {
            this.setState(id, "unknown", error);
            continue;
          }
          if (this.retainFailed && item.kind !== "turn" && !item.voice) {
            this.items.unshift({ ...item, failed: true });
            this.setState(id, "failed", error);
          } else this.setState(id, "removed", error);
          this.failed(error);
          this.publish();
          if (wholeRoom(item.kind)) break;
        }
      }
    } finally {
      this.draining = false;
      if (this.rerun) {
        this.rerun = false;
        void this.drain();
      }
    }
  }
}

/**
 * Who an untagged message goes to while earlier ones still wait in the queue.
 * The thread only learns who was tagged last when a message is posted, so a
 * queued "@null" hasn't reached it yet; the untagged follow-up goes where the
 * last queued message goes, as it would once that one is posted. Null when the
 * thread's own answer stands: a tag in the text, a policy other than
 * last-tagged, or nothing queued.
 */
export function queuedSticky(
  text: string,
  people: readonly Mentionable[],
  policy: TurnPolicy,
  items: readonly ParticipantMessage[],
): string[] | null {
  if (policy !== "mention" || hasMention(text, people)) return null;
  const last = [...items]
    .reverse()
    .find((item) => item.kind === "message" && !item.oneOff);
  const to = last?.to.filter((id) => people.some((p) => p.id === id)) ?? [];
  return to.length ? to : null;
}
