// Pictures in a phone thread: who may load them, and a small cache so
// swiping between threads doesn't fetch the same picture over and over.
import type { RemoteAccess } from "../phoneRules";

/**
 * Why pictures can't load on this machine, or null when they can. Reading a
 * picture file needs Full access on the machine (the host checks it), so a
 * phone paired lower gets a clear tile in place of a blank gap.
 */
export function pictureBlock(input: { access: RemoteAccess | null | undefined; online: boolean; machine: string }): string | null {
  if (input.access && input.access.tier !== "full") return `Pictures need Full access on ${input.machine}`;
  if (!input.online) return `${input.machine} is offline`;
  return null;
}

/** What a failed read says on its tile. */
export function pictureError(error: unknown): string {
  const text = String(error instanceof Error ? error.message : error).replace(/^Error: /, "");
  if (/frame|too large|too big|exceeds/i.test(text)) return "Too large to show on the phone";
  if (/not found|no such file|ENOENT/i.test(text)) return "The file is gone";
  return "Couldn't load";
}

/** Bytes of recently shown pictures, newest last, at most `limit` of them. */
export class PictureCache {
  private items = new Map<string, Promise<ArrayBuffer>>();
  private limit: number;
  constructor(limit = 40) { this.limit = limit; }
  get(key: string, read: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
    const had = this.items.get(key);
    if (had) { this.items.delete(key); this.items.set(key, had); return had; }
    const made = read();
    this.items.set(key, made);
    // A failed read isn't kept, so Retry reads again.
    made.catch(() => { if (this.items.get(key) === made) this.items.delete(key); });
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value as string);
    return made;
  }
  get size() { return this.items.size; }
}
