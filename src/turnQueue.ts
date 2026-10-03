/** Serializes a room's turns; queued context never overlaps an active turn. */
export interface QueuedMessage { id: number; text: string }
export class TurnQueue {
  items: QueuedMessage[] = [];
  active = false;
  paused = false;
  private serial = 0;
  private post: (text: string) => Promise<void>;
  private stop: () => Promise<void>;
  private changed: (items: QueuedMessage[]) => void;
  private failed: (error: unknown) => void;
  constructor(post: (text: string) => Promise<void>, stop: () => Promise<void>, changed: (items: QueuedMessage[]) => void, failed: (error: unknown) => void = () => {}) {
    this.post = post; this.stop = stop; this.changed = changed; this.failed = failed;
  }
  send(text: string): number {
    const id = ++this.serial;
    this.items.push({id, text}); this.publish(); void this.drain(); return id;
  }
  edit(id: number, text: string) { this.items = this.items.map(item => item.id === id ? {...item, text} : item); this.publish(); }
  remove(id: number) { this.items = this.items.filter(item => item.id !== id); this.publish(); }
  resume() { this.paused = false; void this.drain(); }
  async steer(text: string) {
    // Reserve priority before stopping: stop may finish the current post.
    this.paused = true;
    this.items.unshift({id: ++this.serial, text}); this.publish();
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
        try { await this.post(item.text); }
        catch(error) { this.paused = true; this.failed(error); }
      }
    } finally { this.active = false; }
  }
}
