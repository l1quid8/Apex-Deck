// Opening a thread asks its machine for the whole thread. Until the answer comes, the phone used to
// show the empty new-thread screen, and an answer that never came left it there. Three small pieces
// fix that: a copy of the last few threads opened, shown at once while the fresh one loads; a load
// that gives up after a while instead of waiting forever; and the waits between tries after a failure.

/** Threads whose last copy the phone keeps while the app is open. */
export const KEPT_THREADS = 8;
/** A thread load still waiting after this long is tried again. */
export const LOAD_DEADLINE_MS = 10_000;
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

export class LoadTimeout extends Error {
  constructor(ms: number) { super(`No answer after ${Math.round(ms / 1000)} s`); }
}

/** `work`, or a LoadTimeout once `ms` pass without an answer. A late answer is ignored. */
export function withDeadline<T>(work: Promise<T>, ms: number, timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = globalThis): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = timers.setTimeout(() => reject(new LoadTimeout(ms)), ms);
    work.then(
      (value) => { timers.clearTimeout(timer); resolve(value); },
      (error) => { timers.clearTimeout(timer); reject(error); },
    );
  });
}

/** "12 s ago", "3 min ago": how old a kept copy is, for the Connection log. */
export function copyAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}
