/** The agent's measured output level, 0 to 1. Kept outside call state: it changes twenty times a second. */
let level = 0;
const listeners = new Set<(level: number) => void>();
export function publishPlaybackLevel(value: number) {
  level = value;
  listeners.forEach((fn) => fn(value));
}
export function subscribePlaybackLevel(fn: (level: number) => void) {
  listeners.add(fn);
  fn(level);
  return () => void listeners.delete(fn);
}
