/** Serializes a room's turns; queued context never overlaps an active turn. */
/** "turn" runs bots on the transcript as it is and posts no text (see ParticipantQueues.turn). */
export type TurnKind = "message" | "compact" | "turn";
/** `hops` is set on "turn" items only: the cap on bot-to-bot rounds, null for the room's own. */
export interface QueuedMessage { id: number; text: string; kind: TurnKind; hops?: number | null; manual?: boolean }
export class TurnQueue {
  items: QueuedMessage[] = [];
  active = false;
  paused = false;
  private serial = 0;
  private post: (text: string, kind: TurnKind) => Promise<void>;
  private stop: () => Promise<void>;
  private changed: (items: QueuedMessage[]) => void;
  private failed: (error: unknown) => void;
  constructor(post: (text: string, kind: TurnKind) => Promise<void>, stop: () => Promise<void>, changed: (items: QueuedMessage[]) => void, failed: (error: unknown) => void = () => {}) {
    this.post = post; this.stop = stop; this.changed = changed; this.failed = failed;
  }
  send(text: string, kind: TurnKind = "message"): number {
    const id = ++this.serial;
    this.items.push({id, text, kind}); this.publish(); void this.drain(); return id;
  }
  edit(id: number, text: string, kind: TurnKind = "message") { this.items = this.items.map(item => item.id === id ? {...item, text, kind} : item); this.publish(); }
  remove(id: number) { this.items = this.items.filter(item => item.id !== id); this.publish(); }
  resume() { this.paused = false; void this.drain(); }
  async steer(text: string) {
    // Reserve priority before stopping: stop may finish the current post.
    this.paused = true;
    this.items.unshift({id: ++this.serial, text, kind: "message"}); this.publish();
    try { if (this.active) await this.stop(); }
    catch(error) { this.failed(error); return; }
    this.resume();
  }
  async halt() { this.paused = true; if (this.active) await this.stop(); }
  private publish() { this.changed([...this.items]); }
  private async drain() {
    if (this.active || this.paused) return;
    this.active = true;
    try {
      while(this.items.length && !this.paused) {
        const item = this.items.shift()!; this.publish();
        try { await this.post(item.text, item.kind); }
        catch(error) { this.paused = true; this.failed(error); }
      }
    } finally { this.active = false; }
  }
}

export interface ParticipantMessage extends QueuedMessage { to: string[] }
/** One FIFO per recipient. Multi-recipient messages wait until every target
 * is free, then post once. Other participants can continue independently. */
export class ParticipantQueues {
  connectionPaused = false;
  private availabilityEpoch = 0;
  private available: () => boolean;
  items: ParticipantMessage[] = [];
  state: Record<string, "idle" | "working"> = {};
  paused = new Set<string>();
  private halted = new Set<string>();
  private serial = 0;
  private accepting: Promise<unknown> = Promise.resolve();
  private draining = false;
  private rerun = false;
  private targets: (text: string) => Promise<string[]>;
  private post: (text: string, to: string[], kind: TurnKind, hops?: number | null, manual?: boolean) => Promise<void>;
  private stop: (id?: string) => Promise<void>;
  private changed: (items: ParticipantMessage[]) => void;
  private failed: (error: unknown) => void;
  constructor(targets: (text: string) => Promise<string[]>, post: (text: string, to: string[], kind: TurnKind, hops?: number | null, manual?: boolean) => Promise<void>, stop: (id?: string) => Promise<void>, changed: (items: ParticipantMessage[]) => void, failed: (error: unknown) => void = () => {}, available: () => boolean = () => true) {
    this.targets = targets; this.post = post; this.stop = stop; this.changed = changed; this.failed = failed;
    this.available = available;
  }
  private requireAvailable(epoch = this.availabilityEpoch) { if (!this.available() || epoch !== this.availabilityEpoch) throw new Error("Not connected to the host; nothing was queued."); }
  availabilityChanged() {
    if (!this.available()) { this.availabilityEpoch++; if (this.items.length || this.active) this.connectionPaused = true; this.publish(); }
  }
  get active() { return Object.values(this.state).includes("working"); }
  send(text: string, kind: TurnKind = "message"): Promise<number> {
    const accepted = this.accepting.then(async () => {
      this.requireAvailable(); const epoch = this.availabilityEpoch;
      const to = await this.targets(text);
      this.requireAvailable(epoch);
      const id = ++this.serial;
      // Stop pauses a bot so what was queued for it waits. A new message to a
      // stopped bot with nothing waiting is the person going on with it.
      for (const target of to) if (this.halted.has(target) && !this.items.some(item => item.to.includes(target))) { this.paused.delete(target); this.halted.delete(target); }
      this.items.push({id, text, kind, to}); this.publish();
      await this.drain(); return id;
    });
    this.accepting = accepted.catch(() => {});
    return accepted;
  }
  /** Queue `text` for exactly `to`, as a next step sent to the bot that suggested it. */
  sendTo(text: string, to: string[]): Promise<number> {
    const accepted = this.accepting.then(async () => {
      this.requireAvailable();
      const id = ++this.serial;
      this.items.push({ id, text, kind: "message", to, manual: true }); this.publish();
      await this.drain(); return id;
    });
    this.accepting = accepted.catch(() => {});
    return accepted;
  }
  started(id: string) { this.state[id] = "working"; this.publish(); }
  idle(id: string) { this.state[id] = "idle"; this.publish(); void this.drain(); }
  error(id: string) { this.paused.add(id); this.publish(); }
  resume(id?: string) { if (!this.available()) return; this.connectionPaused = false; if (id) { this.paused.delete(id); this.halted.delete(id); } else { this.paused.clear(); this.halted.clear(); } this.publish(); void this.drain(); }
  async edit(id: number, text: string, kind: TurnKind = "message") {
    this.requireAvailable(); const epoch = this.availabilityEpoch;
    const to = await this.targets(text);
    this.requireAvailable(epoch);
    this.items = this.items.map(item => item.id === id ? {...item, text, kind, to} : item);
    this.publish(); void this.drain();
  }
  remove(id: number) { this.items = this.items.filter(item => item.id !== id); this.publish(); }
  async steer(id: string, text: string) {
    this.requireAvailable();
    this.paused.add(id);
    this.items.unshift({id: ++this.serial, text, kind: "message", to: [id], manual: true}); this.publish();
    try { if (this.state[id] === "working") await this.stop(id); this.resume(id); }
    catch (error) { this.failed(error); }
  }
  /** Send a queued message now: stop its bots mid-turn and put it first. */
  async steerQueued(id: number) {
    this.requireAvailable();
    const item = this.items.find(x => x.id === id);
    if (!item) return;
    item.to.forEach(target => this.paused.add(target));
    this.items = [item, ...this.items.filter(x => x.id !== id)]; this.publish();
    try {
      await Promise.all(item.to.filter(target => this.state[target] === "working").map(target => this.stop(target)));
      item.to.forEach(target => this.paused.delete(target)); this.publish(); void this.drain();
    } catch (error) { this.failed(error); }
  }
  /** Run `to` once more on the transcript as it is, ahead of anything queued
   *  for them, posting no text. Their paused queues resume after it, since
   *  you chose to go on with them. `hops` caps the bot-to-bot rounds that
   *  may follow; null keeps the room's limit. */
  turn(to: string[], hops: number | null) {
    if (!this.available()) return;
    for (const id of to) this.paused.delete(id);
    this.items.unshift({ id: ++this.serial, text: "", kind: "turn", to, hops });
    this.publish(); void this.drain();
  }
  async halt(id?: string) {
    for (const target of id ? [id] : Object.keys(this.state)) { this.paused.add(target); this.halted.add(target); }
    this.publish();
    try { await this.stop(id); } catch (error) { this.failed(error); }
  }
  private publish() { this.changed([...this.items]); }
  private async drain() {
    if (!this.available() || this.connectionPaused) return;
    if (this.draining) { this.rerun = true; return; }
    this.draining = true;
    try {
      const blocked = new Set<string>();
      for (const item of [...this.items]) {
        if (!this.available() || this.connectionPaused) break;
        if (item.to.some(id => blocked.has(id) || this.paused.has(id) || this.state[id] === "working") || (item.kind === "compact" && this.active)) {
          if (item.kind === "compact") break;
          item.to.forEach(id => blocked.add(id)); continue;
        }
        item.to.forEach(id => { this.state[id] = "working"; });
        this.items = this.items.filter(x => x.id !== item.id); this.publish();
        try {
          await this.post(item.text, item.to, item.kind, item.hops, item.manual);
          if (item.kind === "compact") { item.to.forEach(id => { this.state[id] = "idle"; }); this.publish(); }
        }
        catch (error) {
          item.to.forEach(id => { this.state[id] = "idle"; this.paused.add(id); });
          this.failed(error); this.publish();
        }
      }
    } finally {
      this.draining = false;
      if (this.rerun) { this.rerun = false; void this.drain(); }
    }
  }
}
