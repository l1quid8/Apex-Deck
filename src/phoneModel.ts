// The Phone tab's plain logic: where a click lands on the picture, what a
// press or drag means, what a key does, and who has the phone in words.
// No React here, so it runs under node --test.

import type { PhoneInput, PhoneKey, PhoneStatus } from "./types";

/** How often the open tab asks for the latest picture. */
export const POLL_MS = 150;
/** Typed characters are sent as one piece this long after the last one. */
export const TYPE_FLUSH_MS = 150;
/** A press that moves less than this many picture pixels is a tap. */
export const DRAG_PX = 12;

const MIN_SWIPE_MS = 100;
const MAX_SWIPE_MS = 1000;

/**
 * The picture spot under a click. The picture is shown as large as fits in
 * `box`, centred, with empty bars on the sides it doesn't fill. Returns
 * `null` for a click on a bar, outside the box, or before there is a picture.
 */
export function toPicture(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
): { x: number; y: number } | null {
  const scale = Math.min(box.width / width, box.height / height);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const offsetX = (box.width - width * scale) / 2;
  const offsetY = (box.height - height * scale) / 2;
  const x = Math.floor((clientX - box.left - offsetX) / scale);
  const y = Math.floor((clientY - box.top - offsetY) / scale);
  if (!(x >= 0 && x < width && y >= 0 && y < height)) return null;
  return { x, y };
}

/** A press that ended close to where it began taps; a longer one swipes, as slowly as the drag was. */
export function gesture(
  start: { x: number; y: number; at: number },
  end: { x: number; y: number; at: number },
): PhoneInput {
  if (Math.hypot(end.x - start.x, end.y - start.y) < DRAG_PX) return { kind: "tap", x: start.x, y: start.y };
  const ms = Math.min(MAX_SWIPE_MS, Math.max(MIN_SWIPE_MS, end.at - start.at));
  return { kind: "swipe", x1: start.x, y1: start.y, x2: end.x, y2: end.y, ms };
}

const NAMED_KEYS: Record<string, PhoneKey> = {
  Enter: "enter",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "escape",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** What a key press does on the phone: type a character, press a key, or nothing. */
export function keyAction(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
): { text: string } | { key: PhoneKey } | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const named = NAMED_KEYS[event.key];
  if (named) return { key: named };
  if (event.key.length === 1) {
    const code = event.key.charCodeAt(0);
    if (code >= 32 && code <= 126) return { text: event.key };
  }
  return null;
}

/** Who has the phone, in plain words. */
export function holderLine(status: PhoneStatus): string {
  if (!status.on) return status.starting ? "Turning on…" : "Off";
  const holder = status.holder;
  if (holder.kind === "human") return `You have the phone. The bots get it back after ${holder.secondsLeft}s without a tap.`;
  if (holder.kind === "bot") return `${holder.name} is using the phone. Tap the screen to take over.`;
  return "Free. Tap the screen to take it.";
}
