// A short diagnostic log kept on this phone: when the app goes out of sight and comes back, what
// each machine's connection does, and how long each thread takes to load. It exists to find out why
// a thread can come back empty after the app was in the background, and where thread load time goes.
// Settings › Connection log shows it. It holds thread titles and timings, never message text.

export interface TraceLine { at: number; text: string }

const KEY = "apex-deck.phone.trace.v1";
const LIMIT = 400;

type Store = Pick<Storage, "getItem" | "setItem">;

export function createTrace(store: Store | null, now: () => number = Date.now) {
  let lines: TraceLine[] = [];
  try {
    const saved = JSON.parse(store?.getItem(KEY) ?? "[]");
    if (Array.isArray(saved)) lines = saved.filter((line) => line && typeof line.at === "number" && typeof line.text === "string").slice(-LIMIT);
  } catch { /* a damaged log starts over */ }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const save = () => {
    timer = null;
    try { store?.setItem(KEY, JSON.stringify(lines)); } catch { /* the log still lives in memory */ }
  };
  return {
    add(text: string) {
      lines = [...lines.slice(-(LIMIT - 1)), { at: now(), text }];
      // Saved soon rather than on every line; flush() saves at once when the app leaves sight.
      if (!timer) timer = setTimeout(save, 500);
      listeners.forEach((fn) => fn());
    },
    flush() { if (timer) clearTimeout(timer); save(); },
    lines: () => lines,
    clear() { lines = []; this.flush(); listeners.forEach((fn) => fn()); },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

export type Trace = ReturnType<typeof createTrace>;

let shared: Trace | null = null;
/** The phone's one log. */
export function phoneTrace(): Trace {
  if (!shared) {
    let store: Store | null = null;
    try { store = localStorage; } catch { /* memory only */ }
    shared = createTrace(store);
  }
  return shared;
}

/** One line per entry, with the time of day to the millisecond. */
export function traceText(lines: readonly TraceLine[]): string {
  return lines.map((line) => {
    const d = new Date(line.at);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ${line.text}`;
  }).join("\n");
}

/** Rough size of a loaded thread: characters of message text, in KB. */
export function roughKb(messages: readonly { text?: unknown }[]): number {
  let chars = 0;
  for (const message of messages) if (typeof message.text === "string") chars += message.text.length;
  return Math.round(chars / 1024);
}
