// What a terminal pane is called.
//
// A terminal has the name you give it, numbered when its workspace already
// has a terminal by that name ("Codex 2"). The program inside may also set a
// title for itself (the OSC 0 and OSC 2 escape codes), such as Claude Code's
// "✳ Writing tests"; that title is cleaned up here and shown muted after the
// name, as plain text.

/** A new terminal's name: `base`, or `base 2`, `base 3`… when that name is taken in the workspace. */
export function nextTitle(base: string, taken: string[]): string {
  const used = new Set(taken.map((title) => title.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** The longest program title shown, in characters. */
export const TITLE_MAX = 60;
/** Program titles change at most four times a second. */
export const TITLE_INTERVAL_MS = 250;

// Escape sequences, then any other control character.
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/gu;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;
// Braille cells are what most spinners are drawn with (⠋ ⠙ ⠹ …).
const SPINNER_FRAMES = /[\u2800-\u28ff]/gu;
const LEADING_NON_LETTERS = /^[^\p{L}]+/u;

/**
 * A program's title as plain text: no escape codes, control characters or
 * spinner frames, nothing before its first letter, single spaces, and at
 * most `TITLE_MAX` characters. "" when nothing readable is left.
 */
export function cleanTitle(raw: string): string {
  const text = raw
    .replace(ESCAPES, "")
    .replace(CONTROLS, " ")
    .replace(SPINNER_FRAMES, "")
    .replace(LEADING_NON_LETTERS, "")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = [...text];
  return chars.length <= TITLE_MAX ? text : `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…`;
}

/** The program title shown after a pane's name, or "" when it would only repeat one of `names`. */
export function programTitle(title: string, names: string[]): string {
  const same = names.some((name) => name.trim() !== "" && name.trim().toLowerCase() === title.toLowerCase());
  return same ? "" : title;
}

/**
 * Lets a title through at most once every `TITLE_INTERVAL_MS`. A title that
 * arrives sooner is held, and only the latest held one is shown when its
 * time comes, so a spinner retitling many times a second shows at most four
 * titles a second and always ends on the last.
 */
export class TitleThrottle {
  private lastAt = Number.NEGATIVE_INFINITY;
  private held: string | null = null;

  /** A title arrived. Returns it if it may be shown now; otherwise holds it and returns null. */
  offer(title: string, now: number): string | null {
    if (now - this.lastAt >= TITLE_INTERVAL_MS) {
      this.lastAt = now;
      this.held = null;
      return title;
    }
    this.held = title;
    return null;
  }

  /** Milliseconds until a held title may be shown. */
  wait(now: number): number {
    return Math.max(0, this.lastAt + TITLE_INTERVAL_MS - now);
  }

  /** The held title, if there is one and its time has come. */
  flush(now: number): string | null {
    if (this.held === null || now - this.lastAt < TITLE_INTERVAL_MS) return null;
    const title = this.held;
    this.held = null;
    this.lastAt = now;
    return title;
  }
}
