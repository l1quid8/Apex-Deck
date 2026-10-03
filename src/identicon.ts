/** One square of a participant's 5×5 avatar. */
export interface IdenticonCell {
  on: boolean;
  /** Step in the diagonal shimmer while the participant works: row + column, 0 to 8. */
  wave: number;
}

const MIN_LIT = 7;
const MAX_LIT = 18;

/** FNV-1a, 32-bit. Small and stable, which is all a picture needs. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The left three columns, row by row, from 15 bits of the hash. */
function halfFrom(bits: number): boolean[] {
  return Array.from({ length: 15 }, (_, i) => ((bits >>> i) & 1) === 1);
}

/** The cells of the avatar drawn from `seed`, mirrored left to right, row by
 *  row. The same seed always gives the same picture. */
export function identiconCells(seed: string): IdenticonCell[] {
  let half = halfFrom(hash(seed));
  // Re-draw a pattern that would be almost empty or almost solid. Bounded,
  // and keyed on the seed, so it stays deterministic.
  for (let attempt = 1; attempt < 16; attempt++) {
    const lit = half.reduce((n, on, i) => n + (on ? (i % 3 === 2 ? 1 : 2) : 0), 0);
    if (lit >= MIN_LIT && lit <= MAX_LIT) break;
    half = halfFrom(hash(`${seed}#${attempt}`));
  }
  const cells: IdenticonCell[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const source = col < 3 ? col : 4 - col;
      cells.push({ on: half[row * 3 + source], wave: row + col });
    }
  }
  return cells;
}

export interface AgentAppearance { seed: string; color: string }
export const AGENT_COLORS = ["#2dd4bf", "#f59e0b", "#a78bfa", "#f472b6", "#60a5fa", "#a3e635", "#fb7185", "#22d3ee"];

/** Older agents keep their handle pattern, with a stable color everywhere. */
export function legacyAppearance(id: string): AgentAppearance {
  return { seed: id, color: AGENT_COLORS[hash(id) % AGENT_COLORS.length] };
}

/** Randomize once, then store the result with the agent. */
export function createAppearance(used: AgentAppearance[] = []): AgentAppearance {
  const available = AGENT_COLORS.filter(color => !used.some(a => a.color === color));
  const palette = available.length ? available : AGENT_COLORS;
  const bits = crypto.getRandomValues(new Uint32Array(1))[0];
  const color = palette[bits % palette.length];
  const patterns = new Set(used.map(a => identiconCells(a.seed).map(c => +c.on).join("")));
  for (let attempt = 0; attempt < 256; attempt++) {
    const seed = crypto.randomUUID();
    if (!patterns.has(identiconCells(seed).map(c => +c.on).join(""))) return { seed, color };
  }
  return { seed: crypto.randomUUID(), color };
}
