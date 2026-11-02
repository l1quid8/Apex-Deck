/** A thread's own saved state — its draft, quotes, TL;DR switch and folded panel — belongs to one
 *  thread on one machine, and two machines can each have a thread with the same id. Keys name both.
 *  These carry state saved under a thread's old bare-id key over to the new one. */

/** The same map with the thread's saved entry moved to its machine-and-id key. Nothing is moved when
 *  the new key already has an entry, when the keys are the same, or when there is nothing to carry. */
export function carriedEntry<T>(all: Record<string, T>, key: string, legacy: string): Record<string, T> {
  if (all[key] !== undefined || legacy === key || all[legacy] === undefined) return all;
  const { [legacy]: carried, ...rest } = all;
  return { ...rest, [key]: carried };
}

/** An on/off switch saved under a thread's old bare-id key moves to its new key the first time it is
 *  read, so one set before the change survives it. The old key is cleared so it can't come back. */
export function carriedFlag(read: (key: string) => boolean, write: (key: string, on: boolean) => void, key: string, legacy: string): boolean {
  const saved = read(key);
  if (saved || legacy === key || !read(legacy)) return saved;
  write(key, true);
  write(legacy, false);
  return true;
}
