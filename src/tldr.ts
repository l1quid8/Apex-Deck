/** TL;DR mode: a per-chat switch that quietly asks every model for a short
 *  answer. The instruction rides on the message but never shows in the chat. */

export const TLDR_LINE = "[TL;DR mode: answer in 2–4 sentences. Lead with the answer. No preamble, no headings. Expand only if asked.]";

export const withTldr = (message: string, on: boolean) => (on && message ? `${message}\n\n${TLDR_LINE}` : message);

/** The message as the human wrote it, and whether it was sent in TL;DR mode. */
export function splitTldr(text: string): { text: string; tldr: boolean } {
  const at = text.lastIndexOf(TLDR_LINE);
  if (at < 0) return { text, tldr: false };
  return { text: (text.slice(0, at) + text.slice(at + TLDR_LINE.length)).trim(), tldr: true };
}

const key = (pane: string) => `deck.tldr.${pane}`;
export const loadTldr = (pane: string) => { try { return localStorage.getItem(key(pane)) === "1"; } catch { return false; } };
export const saveTldr = (pane: string, on: boolean) => { try { on ? localStorage.setItem(key(pane), "1") : localStorage.removeItem(key(pane)); } catch { /* private mode */ } };

/** Shake the text box once when a TL;DR message goes out. Skipped under reduced motion. */
export function wiggle(box: HTMLElement | null) {
  if (!box || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  box.animate([
    { transform: "none" },
    { transform: "rotate(-1.2deg) translateX(-4px)" },
    { transform: "rotate(1.2deg) translateX(4px)" },
    { transform: "rotate(-.8deg) translateX(-2px)" },
    { transform: "rotate(.6deg) translateX(2px)" },
    { transform: "none" },
  ], { duration: 500, easing: "ease-in-out" });
}
