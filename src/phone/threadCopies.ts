// Opening a thread asks its machine for the whole thread. Until the answer comes, the phone used to
// show the empty new-thread screen, and an answer that never came left it there. Three small pieces
// fix that: a copy of the last few threads opened, shown at once while the fresh one loads; a load
// that says when it is slow but keeps waiting for its answer, since a big thread on a slow link is
// still on its way; and the waits between tries after a real failure.

/** Threads whose last copy the phone keeps while the app is open. */
export const KEPT_THREADS = 8;
/** A thread load still on its way after this long says "Still loading…". It is never given up on. */
export const SLOW_LOAD_MS = 10_000;
/** How long the phone waits for its machine to answer when the app comes back into sight. */
export const RESUME_CHECK_MS = 3_000;

/** The last copy of each recently opened thread, newest kept, oldest dropped past `limit`. In memory only. */
export function createThreadCopies<T>(limit = KEPT_THREADS) {
  const copies = new Map<string, { value: T; at: number }>();
  return {
    put(key: string, value: T, at = Date.now()) {
      copies.delete(key);
      copies.set(key, { value, at });
      while (copies.size > limit) copies.delete(copies.keys().next().value!);
    },
    get(key: string): { value: T; at: number } | undefined {
      return copies.get(key);
    },
    drop(key: string) { copies.delete(key); },
    get size() { return copies.size; },
  };
}

export type ThreadCopies<T> = ReturnType<typeof createThreadCopies<T>>;

/** Waits before trying a failed load again: 2, 4, 8, then every 15 s. */
export function loadRetryDelay(attempt: number): number {
  return attempt <= 1 ? 2000 : attempt === 2 ? 4000 : attempt === 3 ? 8000 : 15_000;
}

/**
 * `work` itself, untouched; `onSlow` runs once if it hasn't settled after `ms`. Nothing is given up
 * or asked for again: asking again would only queue a second copy behind the one still arriving.
 */
export function whenSlow<T>(work: Promise<T>, ms: number, onSlow: () => void, timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = globalThis): Promise<T> {
  const timer = timers.setTimeout(onSlow, ms);
  const done = () => timers.clearTimeout(timer);
  work.then(done, done);
  return work;
}

/** "12 s ago", "3 min ago": how old a kept copy is, for the Connection log. */
export function copyAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}
