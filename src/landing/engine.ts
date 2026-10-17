// Landing texture: pure interaction math. No DOM, no GL — tests import this.
// Clean-room implementation from the behavioral spec in
// docs/landing-texture-plan.md. All times are seconds, distances CSS px.

export type RippleShape = "circle" | "diamond" | "logo";
export type LandingMode = "rainbow" | "single";

export const CELL_W = 6.5;
export const CELL_H = 13;
export const WAKE_MAX = 48;
export const WAKE_LIFE = 2.4;
export const TAP_MAX = 6;
export const TAP_LIFE = 3.6;
export const FRONT_MAX = 620;
export const SETTLE_AFTER = 180;
export const SETTLE_FADE = 8;
export const RESUME_FADE = 3;

/** Original 42-char glyph sequence for this repo. Cells cycle through it. */
export const SEQUENCE = "APEXDECKapexdeck0123456789<>/\\|+-*=:;.#@%?";
export const ATLAS_CHARS = [...new Set(SEQUENCE)].join("");

export interface Wake {
  /** Segment center. */ x: number; y: number;
  /** Unit direction of travel. */ dx: number; dy: number;
  /** Half-length of the segment. */ len: number;
  force: number;
  at: number;
}

export interface Tap {
  x: number; y: number; at: number;
  shape: "circle" | "diamond";
}

export interface FieldState {
  wakes: Wake[];
  taps: Tap[];
  tapCount: number;
  last: { x: number; y: number; at: number } | null;
  anchor: { x: number; y: number; at: number } | null;
  speed: number;
  lastInteract: number;
}

export function createFieldState(now = 0): FieldState {
  return { wakes: [], taps: [], tapCount: 0, last: null, anchor: null, speed: 0, lastInteract: now };
}

/** Reach of a ripple front at offset (dx, dy). Diamond = Manhattan distance.
 *  "logo" resolves to diamond until the Phase 2 SDF branch lands. */
export function shapeReach(dx: number, dy: number, shape: RippleShape): number {
  if (shape === "circle") return Math.hypot(dx, dy);
  return Math.abs(dx) + Math.abs(dy);
}

export function effectiveShape(setting: RippleShape): "circle" | "diamond" {
  return setting === "circle" ? "circle" : "diamond";
}

const smoothstep = (v: number) => { const t = Math.min(1, Math.max(0, v)); return t * t * (3 - 2 * t); };

/** Wake force from smoothed pointer speed (px/s) and segment length (px).
 *  Speed at or below 60 px/s warms nothing; 800 px/s saturates. */
export function wakeForce(speed: number, segLen: number): number {
  if (!Number.isFinite(speed) || !Number.isFinite(segLen) || segLen <= 0) return 0;
  return smoothstep((speed - 60) / 740) * (segLen / (segLen + 90));
}

/** Feed a pointermove. Mouse/pen only; returns the emitted wake, if any. */
export function pointerMove(state: FieldState, x: number, y: number, now: number, pointerType = "mouse"): Wake | null {
  if (pointerType !== "mouse" && pointerType !== "pen") return null;
  if (!state.last || !state.anchor) {
    state.last = { x, y, at: now };
    state.anchor = state.last;
    return null;
  }
  const dt = Math.max(now - state.last.at, 1 / 240);
  const dist = Math.hypot(x - state.last.x, y - state.last.y);
  state.speed += (dist / dt - state.speed) * (1 - Math.exp(-dt / 0.08));
  state.last = { x, y, at: now };

  const seg = Math.hypot(x - state.anchor.x, y - state.anchor.y);
  if (seg < 18 || now - state.anchor.at < 0.035) return null;
  const from = state.anchor;
  state.anchor = state.last;
  state.lastInteract = now;
  const force = wakeForce(state.speed, seg);
  if (force < 0.04) return null;
  const wake: Wake = {
    x: (x + from.x) / 2, y: (y + from.y) / 2,
    dx: (x - from.x) / seg, dy: (y - from.y) / seg,
    len: seg / 2, force, at: now,
  };
  state.wakes.push(wake);
  if (state.wakes.length > WAKE_MAX) state.wakes.splice(0, state.wakes.length - WAKE_MAX);
  return wake;
}

export function pointerLeave(state: FieldState): void {
  state.last = null;
  state.anchor = null;
}

/** Feed a click. Every 3rd tap takes the configured shape; the rest are circles. */
export function pointerTap(state: FieldState, x: number, y: number, now: number, setting: RippleShape): Tap {
  state.tapCount += 1;
  state.lastInteract = now;
  const tap: Tap = { x, y, at: now, shape: state.tapCount % 3 === 0 ? effectiveShape(setting) : "circle" };
  state.taps.push(tap);
  if (state.taps.length > TAP_MAX) state.taps.splice(0, state.taps.length - TAP_MAX);
  return tap;
}

/** Drop expired wakes and taps. */
export function prune(state: FieldState, now: number): void {
  state.wakes = state.wakes.filter((w) => now - w.at < WAKE_LIFE);
  state.taps = state.taps.filter((t) => now - t.at < TAP_LIFE);
}

/** Ripple front radius (px) at a given age: 0 at birth, asymptotes to 620. */
export function frontRadius(age: number): number {
  if (age <= 0) return 0;
  return FRONT_MAX * (1 - Math.exp(-age / 1.3));
}

export function frontWidth(age: number): number {
  return 85 + 60 * Math.max(0, age);
}

/** Cell grid for a surface of the given CSS size. */
export function gridSize(width: number, height: number): { cols: number; rows: number } {
  return {
    cols: Math.max(0, Math.floor(width / CELL_W)),
    rows: Math.max(0, Math.floor(height / CELL_H)),
  };
}

/** Rainbow hue for a point at time t. Always in [0, 360); speed 0 freezes it. */
export function rainbowHue(px: number, py: number, t: number, speed: number): number {
  const hue = px * 0.55 + py * 0.35 + t * 45 * (Number.isFinite(speed) ? speed : 1);
  return ((hue % 360) + 360) % 360;
}

/** Parse "#rgb" or "#rrggbb" to [r, g, b] in 0..1, or null. */
export function hexToRgb(hex: string): [number, number, number] | null {
  let h = typeof hex === "string" ? hex.trim() : "";
  if (/^#[0-9a-f]{3}$/i.test(h)) h = "#" + [...h.slice(1)].map((c) => c + c).join("");
  if (!/^#[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Single-mode glow: brighten the base color toward white. Stays in gamut. */
export function glowMix(base: [number, number, number], glow: number): [number, number, number] {
  const k = 0.55 * Math.min(1, Math.max(0, Number.isFinite(glow) ? glow : 0));
  return [base[0] + (1 - base[0]) * k, base[1] + (1 - base[1]) * k, base[2] + (1 - base[2]) * k];
}

/** Frame budget: 10ms while a ripple lives, 83ms once settled, else 40ms. */
export function frameIntervalMs(state: FieldState, now: number): number {
  if (state.taps.length > 0) return 10;
  if (now - state.lastInteract > SETTLE_AFTER) return 83;
  return 40;
}

/** How visible the field is: full until 180s idle, fading out over 8s. */
export function idleVisibility(state: FieldState, now: number): number {
  const idle = now - state.lastInteract;
  if (idle <= SETTLE_AFTER) return 1;
  return Math.max(0, 1 - (idle - SETTLE_AFTER) / SETTLE_FADE);
}
