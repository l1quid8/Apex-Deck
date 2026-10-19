/** Hex colour helpers shared by the agent appearance editors. Colours are
 *  stored as lowercase `#rrggbb`, which is what `<input type="color">` wants. */

/** Accepts `#rgb` or `#rrggbb` (case-insensitive) and normalizes to lowercase
 *  `#rrggbb`. Returns null for anything else. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1];
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  return `#${full.toLowerCase()}`;
}

/** What someone typing into a hex field meant: `#aabbcc`, `aabbcc`, `#abc`
 *  and `abc` all resolve. Anything else is null. */
export function parseHexColorInput(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  return normalizeHexColor(text.startsWith("#") ? text : `#${text}`);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function hexLuminance(hex: string): number {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return 0;
  const channel = (start: number) => {
    const value = parseInt(normalized.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The chat surface the agent's name and avatar are drawn on. */
export const AGENT_SURFACE = "#0e141b";

/** Contrast ratio of `hex` against `background`, 1 (identical) to 21. */
export function contrastRatio(hex: string, background: string = AGENT_SURFACE): number {
  const one = hexLuminance(hex);
  const two = hexLuminance(background);
  const lighter = Math.max(one, two);
  const darker = Math.min(one, two);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Below 3:1 a colour reads as a smudge for the agent's name in chat. The
 *  editor warns but never blocks: it is the agent owner's call. */
export const MIN_AGENT_CONTRAST = 3;

export function isHardToReadOnDark(hex: string): boolean {
  return contrastRatio(hex) < MIN_AGENT_CONTRAST;
}
