// The shared browser's rules, with no interface in them: how the person's input becomes page
// events, and how a tab's holder is named.

export type TabControl = { kind: "free" | "human" | "assistant" } | { kind: "bot"; thread: string; participant: string; label: string };
export interface PageDialog { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string; url?: string }
export interface BrowserTab { id: string; url: string; title: string; control: TabControl; rooms: string[]; assistant: boolean; popup: boolean; dialogOpen: boolean; dialog?: PageDialog | null; fileChooser: boolean; width: number; height: number }

export type PageEvent =
  | { kind: "mouse"; action: "down" | "up" | "move"; x: number; y: number; button: string; buttons: number; clicks: number; modifiers: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { kind: "key"; action: "down" | "up"; key: string; code: string; vk: number; text: string; modifiers: number; commands: string[] }
  | { kind: "text"; text: string }
  | { kind: "navigate"; url: string }
  | { kind: "back" } | { kind: "forward" } | { kind: "reload" } | { kind: "copy" } | { kind: "cut" }
  | { kind: "dialog"; accept: boolean; text?: string };

interface Modifiers { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
export function modifierBits(e: Modifiers): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const BUTTONS = ["left", "middle", "right"];
export const buttonName = (button: number) => BUTTONS[button] ?? "none";

/** A point on the view, in page pixels. The picture is letterboxed, so a point beside it is no point on the page. */
export function pagePoint(x: number, y: number, box: { left: number; top: number; width: number; height: number }, width: number, height: number): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0 || width <= 0 || height <= 0) return null;
  const scale = Math.min(box.width / width, box.height / height);
  const left = box.left + (box.width - width * scale) / 2, top = box.top + (box.height - height * scale) / 2;
  const px = (x - left) / scale, py = (y - top) / scale;
  if (px < 0 || py < 0 || px >= width || py >= height) return null;
  return { x: Math.round(px), y: Math.round(py) };
}

/** Keep the latest pointer position instead of every step on the way there. */
export function coalesce(queue: PageEvent[], next: PageEvent): PageEvent[] {
  const last = queue[queue.length - 1];
  if (next.kind === "mouse" && next.action === "move" && last?.kind === "mouse" && last.action === "move") return [...queue.slice(0, -1), next];
  return [...queue, next];
}

/**
 * Input in the order it happened, one batch at a time for each tab. Each event keeps the tab and
 * machine it was made on from the moment it's queued, so switching away can never send it
 * somewhere else, and a slow tab can't hold up the others.
 */
export function inputQueue<R>(deliver: (send: (events: PageEvent[]) => Promise<R>, events: PageEvent[]) => Promise<void>, onIdle: () => void, onFail: (cause: unknown) => void) {
  type Batch = { send: (events: PageEvent[]) => Promise<R>; events: PageEvent[] };
  const lines = new Map<string, Batch[]>();
  const clipboard = (batch: Batch) => { const kind = batch.events[batch.events.length - 1]?.kind; return kind === "copy" || kind === "cut"; };
  const run = async (to: string, line: Batch[]) => {
    while (line.length) {
      const batch = line[0];
      try { await deliver(batch.send, batch.events); line.shift(); onIdle(); }
      // What followed a failed event makes no sense without it.
      catch (cause) { line.length = 0; onFail(cause); }
    }
    if (lines.get(to) === line) lines.delete(to);
  };
  return {
    add(to: string, send: (events: PageEvent[]) => Promise<R>, ...events: PageEvent[]) {
      let line = lines.get(to);
      const idle = !line;
      if (!line) lines.set(to, line = []);
      for (const event of events) {
        // The batch being sent is out of reach, and a clipboard reply mustn't wait on anything after it.
        const last = line.length > (idle ? 0 : 1) ? line[line.length - 1] : undefined;
        if (last && !clipboard(last)) last.events = coalesce(last.events, event);
        else line.push({ send, events: [event] });
      }
      if (idle) void run(to, line);
    },
  };
}

/** What a page's dialog offers the person, as the page asked it. */
export function dialogChoices(dialog: PageDialog | null | undefined): { answer: boolean; ok: string; cancel: string | null } {
  switch (dialog?.type) {
    case "alert": return { answer: false, ok: "OK", cancel: null };
    case "prompt": return { answer: true, ok: "OK", cancel: "Cancel" };
    case "beforeunload": return { answer: false, ok: "Leave", cancel: "Stay" };
    default: return { answer: false, ok: "OK", cancel: "Cancel" };
  }
}

/** Which machine the side panel's browser shows: a link on its way there, then a link's machine while the person stays put. */
export function browserHostFor(focused: string, address: { hostId?: string } | null, pin: { hostId: string; focus: string } | null, focus: string): string {
  return address?.hostId ?? (pin?.focus === focus ? pin.hostId : focused);
}

export interface KeyLike extends Modifiers { key: string; code: string; keyCode: number }

/** What a key press does. `deck` leaves it to Deck's own shortcuts; `paste` waits for the paste event. */
export function keyAction(e: KeyLike, mac: boolean): { type: "deck" } | { type: "paste" } | { type: "address" } | { type: "events"; events: PageEvent[] } {
  const command = mac ? e.metaKey : e.ctrlKey;
  const letter = e.key.length === 1 ? e.key.toLowerCase() : "";
  if (command && !e.altKey) {
    if (letter === "v") return { type: "paste" };
    if (letter === "l") return { type: "address" };
    if (letter === "c") return { type: "events", events: [{ kind: "copy" }] };
    if (letter === "x") return { type: "events", events: [{ kind: "cut" }] };
    if (letter === "r") return { type: "events", events: [{ kind: "reload" }] };
    if (e.key === "[") return { type: "events", events: [{ kind: "back" }] };
    if (e.key === "]") return { type: "events", events: [{ kind: "forward" }] };
    const name = letter === "a" ? "selectAll" : letter === "z" ? (e.shiftKey ? "redo" : "undo") : "";
    if (!name) return { type: "deck" };
    return { type: "events", events: [{ kind: "key", action: "down", key: e.key, code: e.code, vk: e.keyCode, text: "", modifiers: modifierBits(e), commands: [name] }] };
  }
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  const text = e.key === "Enter" ? "\r" : printable ? e.key : "";
  return { type: "events", events: [{ kind: "key", action: "down", key: e.key, code: e.code, vk: e.keyCode, text, modifiers: modifierBits(e), commands: [] }] };
}

export function holderName(tab: BrowserTab, roomName: (id: string) => string | undefined, assistantName: string): string {
  const control = tab.control;
  switch (control.kind) {
    case "human": return "You";
    case "assistant": return assistantName;
    case "bot": { const room = roomName(control.thread); return room ? `${control.label} · ${room}` : control.label; }
    default: return "";
  }
}

/** The tab's short name in the strip. */
export function tabName(tab: BrowserTab): string {
  if (tab.title) return tab.title;
  try { const host = new URL(tab.url).host; if (host) return host; } catch { /* A new tab has no address yet. */ }
  return "New tab";
}

/** Which tab to show: the one asked for, then what's there. */
export function chosenTab(tabs: BrowserTab[], wanted: string | null, assistantFirst: boolean): string | null {
  if (wanted && tabs.some((tab) => tab.id === wanted)) return wanted;
  return (assistantFirst ? tabs.find((tab) => tab.assistant) : undefined)?.id ?? tabs[0]?.id ?? null;
}

export type BrowserCaller = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const sessions = new Map<string, Promise<string>>();

/**
 * Calls to the person's browser surface carry a session from the host's protected opening.
 * A restarted service forgets its sessions, so a refusal opens a new one and tries once more.
 */
export function browserCaller(host: string, call: BrowserCaller): BrowserCaller {
  const session = () => {
    let held = sessions.get(host);
    if (!held) {
      held = call<{ session: string }>("personal_browser_session").then((reply) => reply.session);
      sessions.set(host, held);
      held.catch(() => { if (sessions.get(host) === held) sessions.delete(host); });
    }
    return held;
  };
  return async <T,>(cmd: string, args: Record<string, unknown> = {}) => {
    const used = session();
    try { return await call<T>(cmd, { ...args, session: await used }); }
    catch (cause) {
      if (!String(cause).includes("browser_session_required")) throw cause;
      if (sessions.get(host) === used) sessions.delete(host);
      return call<T>(cmd, { ...args, session: await session() });
    }
  };
}

/** The open tab an address belongs in: the same page, or for a server that just started, any page of it. */
export function tabForAddress(tabs: BrowserTab[], address: string, sameServer: (a: string, b: string) => boolean, anyPage: boolean): BrowserTab | undefined {
  return tabs.find((tab) => tab.url === address) ?? (anyPage ? tabs.find((tab) => !!tab.url && sameServer(tab.url, address)) : undefined);
}
