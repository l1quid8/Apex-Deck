import { validate, leafIds } from "./layout.ts";

/** Pure geometry for the adaptive pane layouts. All rects use CSS pixels. */
export type PaneLayoutMode = "horizontal" | "vertical" | "grid" | "left" | "right";
export interface Size { w: number; h: number }
export interface Level extends Size { cols: number; rows: number; shown: number }

export const GAP = 8;
export const PANE_AR = 1.4;
export const COMFORT = { w: 280, h: 200 } as const;
export const MIN_PANE = { w: 120, h: 56 } as const;
export const BAND_MIN = { horizontal: 56, vertical: 120 } as const;

const hasArea = ({ w, h }: Size) => Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
const validCount = (count: number) => Number.isSafeInteger(count) && count > 0;
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(value, hi));

/** Most panes first, then progressively larger panes; columns never increase. */
export function gridLevels(count: number, area: Size): Level[] {
  if (!validCount(count) || !hasArea(area)) return [];
  const candidates: (Level & { score: number })[] = [];
  for (let cols = 1; cols <= Math.min(count, 10); cols++) {
    const w = (area.w - (cols - 1) * GAP) / cols;
    if (cols > 1 && w < MIN_PANE.w) break;
    const maxRows = Math.min(Math.ceil(count / cols), Math.max(1, Math.floor((area.h + GAP) / (MIN_PANE.h + GAP))));
    for (let rows = 1; rows <= maxRows; rows++) {
      const h = (area.h - (rows - 1) * GAP) / rows;
      candidates.push({ cols, rows, w, h, shown: Math.min(count, cols * rows), score: Math.abs(Math.log((w / h) / PANE_AR)) });
    }
  }
  const most = candidates.reduce((max, level) => Math.max(max, level.shown), 0);
  const best = (levels: typeof candidates) => levels.sort((a, b) => a.score - b.score)[0];
  const out = [best(candidates.filter(level => level.shown === most))];
  const counts = [...new Set(candidates.map(level => level.shown))].filter(n => n < most).sort((a, b) => b - a);
  for (const shown of counts) {
    const prev = out[out.length - 1];
    const next = best(candidates.filter(level => level.shown === shown && level.cols <= prev.cols &&
      level.w * level.h > prev.w * prev.h + 1 && (shown === 1 || level.score <= Math.log(2))));
    if (next) out.push(next);
  }
  if (out[out.length - 1].shown !== 1) out.push(candidates.find(level => level.cols === 1 && level.rows === 1)!);
  return out.map(({ score: _score, ...level }) => level);
}

export function bandLevels(count: number, area: Size, mode: "horizontal" | "vertical"): Level[] {
  if (!validCount(count) || !hasArea(area)) return [];
  const vertical = mode === "vertical";
  const span = vertical ? area.w : area.h;
  const most = Math.max(1, Math.min(count, Math.floor((span + GAP) / (BAND_MIN[mode] + GAP))));
  const levels: Level[] = [];
  for (let shown = most; shown >= 1; shown--) {
    const size = (span - (shown - 1) * GAP) / shown;
    levels.push(vertical
      ? { cols: shown, rows: 1, w: size, h: area.h, shown }
      : { cols: 1, rows: shown, w: area.w, h: size, shown });
  }
  return levels;
}

export function defaultLevel(levels: Level[], areaWidth: number): number {
  const idx = levels.findIndex(level => level.w >= Math.min(COMFORT.w, areaWidth) - 0.5 && level.h >= COMFORT.h);
  return idx < 0 ? levels.length - 1 : idx;
}

/** Zoom is relative to the default density, rather than a fixed pixel scale. */
export function levelIndex(levels: Level[], defaultIdx: number, zoom: number): number {
  if (!levels.length) return -1;
  const d = clamp(Number.isInteger(defaultIdx) ? defaultIdx : 0, 0, levels.length - 1);
  const target = levels[d].shown / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  let index = 0;
  let distance = Infinity;
  levels.forEach((level, i) => {
    const next = Math.abs(Math.log(level.shown / target));
    if (next < distance - 1e-9) { distance = next; index = i; }
  });
  return index;
}

export function zoomRange(levels: Level[], defaultIdx: number): [number, number] {
  if (!levels.length) return [1, 1];
  const d = clamp(Number.isInteger(defaultIdx) ? defaultIdx : 0, 0, levels.length - 1);
  return [levels[d].shown / levels[0].shown, levels[d].shown / levels[levels.length - 1].shown];
}

export interface PxRect extends Size { x: number; y: number }
export interface Arrangement { mode: PaneLayoutMode; order: string[]; zoom: number; focusShare: number }
export interface Placement {
  levels: Level[];
  levelIdx: number;
  defaultIdx: number;
  axis: "x" | "y";
  region: PxRect;
  world: Size;
  /** Coordinates relative to region; the focus pane is kept separately. */
  rects: Map<string, PxRect>;
  snaps: number[];
  focus: { id: string; rect: PxRect } | null;
}

const modes: readonly PaneLayoutMode[] = ["horizontal", "vertical", "grid", "left", "right"];

/** Validate saved state, retaining order while reconciling the live inventory. */
export function validArrangement(value: unknown, ids: string[]): Arrangement {
  const stored = value && typeof value === "object" ? value as Partial<Arrangement> : {};
  const live = new Set(ids);
  const ordered = Array.isArray(stored.order) ? stored.order.filter(id => typeof id === "string" && live.has(id)) : [];
  return {
    mode: modes.includes(stored.mode!) ? stored.mode! : "grid",
    order: [...new Set([...ordered, ...ids])],
    zoom: typeof stored.zoom === "number" && Number.isFinite(stored.zoom) && stored.zoom > 0 ? stored.zoom : 1,
    focusShare: typeof stored.focusShare === "number" && Number.isFinite(stored.focusShare) && stored.focusShare > 0 && stored.focusShare < 1 ? stored.focusShare : 0.58,
  };
}

/** Legacy `layout` may be stale: a Focus-left shape must corroborate it. */
export function arrangementFromSaved(tree: unknown, layout: unknown, ids: string[]): Arrangement {
  const node = validate(tree);
  const side = node?.kind === "split" ? node.children[1] : null;
  const focusLeft = layout === "left" && node?.kind === "split" && node.dir === "row" &&
    node.children.length === 2 && node.children[0].kind === "leaf" && node.sizes[0] > 0.52 &&
    (side?.kind === "leaf" || (side?.kind === "split" && side.dir === "column" && side.children.every(child => child.kind === "leaf")));
  return validArrangement({ mode: focusLeft ? "left" : "grid", order: leafIds(node) }, ids);
}

/** Place the scrolling region in its own coordinates and pin a Focus pane. */
export function place(arr: Arrangement, area: Size): Placement {
  const region = { x: 0, y: 0, w: hasArea(area) ? area.w : 0, h: hasArea(area) ? area.h : 0 };
  const result: Placement = {
    levels: [], levelIdx: -1, defaultIdx: -1, axis: arr.mode === "vertical" ? "x" : "y",
    region, world: { w: region.w, h: region.h }, rects: new Map(), snaps: [0], focus: null,
  };
  if (!arr.order.length || !hasArea(area)) return result;
  let ids = arr.order;
  if ((arr.mode === "left" || arr.mode === "right") && ids.length > 1 && area.w >= 320 + GAP + 260) {
    const width = clamp(Math.round((area.w - GAP) * arr.focusShare), 320, area.w - GAP - 260);
    result.focus = { id: ids[0], rect: { x: arr.mode === "left" ? 0 : area.w - width, y: 0, w: width, h: area.h } };
    region.x = arr.mode === "left" ? width + GAP : 0;
    region.w = area.w - width - GAP;
    ids = ids.slice(1);
  }
  const band = arr.mode === "horizontal" || arr.mode === "vertical" ? arr.mode : null;
  const levels = band ? bandLevels(ids.length, region, band) : gridLevels(ids.length, region);
  const d = defaultLevel(levels, region.w);
  const idx = levelIndex(levels, d, arr.zoom);
  Object.assign(result, { levels, defaultIdx: d, levelIdx: idx });
  const level = levels[idx];
  if (result.axis === "x") {
    ids.forEach((id, i) => result.rects.set(id, { x: i * (level.w + GAP), y: 0, w: level.w, h: region.h }));
    result.world = { w: ids.length * level.w + (ids.length - 1) * GAP, h: region.h };
  } else {
    const rows = Math.ceil(ids.length / level.cols);
    ids.forEach((id, i) => {
      const row = Math.floor(i / level.cols);
      const cols = Math.min(level.cols, ids.length - row * level.cols);
      const w = (region.w - (cols - 1) * GAP) / cols;
      result.rects.set(id, { x: (i % level.cols) * (w + GAP), y: row * (level.h + GAP), w, h: level.h });
    });
    result.world = { w: region.w, h: rows * level.h + (rows - 1) * GAP };
  }
  // Whole strides avoid rounding a final snap a fraction short of a row.
  const max = result.axis === "x"
    ? Math.max(0, ids.length - level.cols) * (level.w + GAP)
    : Math.max(0, Math.ceil(ids.length / level.cols) - level.rows) * (level.h + GAP);
  const starts = [...result.rects.values()].map(rect => Math.min(max, result.axis === "x" ? rect.x : rect.y));
  result.snaps = [...new Set([0, ...starts, max])].sort((a, b) => a - b);
  return result;
}

export function stepZoom(arr: Arrangement, area: Size, dir: 1 | -1): number {
  const placement = place(arr, area);
  if (placement.levelIdx < 0) return arr.zoom;
  const idx = clamp(placement.levelIdx + dir, 0, placement.levels.length - 1);
  if (idx === placement.levelIdx) return arr.zoom;
  return placement.levels[placement.defaultIdx].shown / placement.levels[idx].shown;
}

export type ZoomAnchor = { kind: "active"; ids: string[] } | { kind: "pane"; id: string };

function bounds(p: Placement, ids: string[]): PxRect | null {
  const rects = ids.flatMap(id => { const rect = p.rects.get(id); return rect ? [rect] : []; });
  if (!rects.length) return null;
  const x = Math.min(...rects.map(r => r.x));
  const y = Math.min(...rects.map(r => r.y));
  return { x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y };
}

/** Snaps that show the entire target, including both ends of a group. */
function visibleSnaps(p: Placement, r: PxRect): number[] {
  if (r.w > p.region.w + 0.01 || r.h > p.region.h + 0.01) return [];
  const start = p.axis === "x" ? r.x : r.y;
  const end = start + (p.axis === "x" ? r.w : r.h);
  const span = p.axis === "x" ? p.region.w : p.region.h;
  return p.snaps.filter(s => s <= start + 0.01 && s + span >= end - 0.01);
}

export function chooseAnchor(next: Placement, active: string[], pointerId: string | null, held: string | null, centre: string | null = null): ZoomAnchor | null {
  const ids = [...new Set(active.filter(id => next.rects.has(id)))];
  const r = bounds(next, ids);
  if (r && visibleSnaps(next, r).length) return { kind: "active", ids };
  const id = [held, pointerId, ids[0], centre].find(candidate => candidate != null && next.rects.has(candidate));
  return id ? { kind: "pane", id } : null;
}

const distanceToRect = (r: PxRect, x: number, y: number) => Math.hypot(Math.max(r.x - x, 0, x - r.x - r.w), Math.max(r.y - y, 0, y - r.y - r.h));

/** Prefer the containing pane; when the centre lands in a gap, use its neighbour. */
export function centreId(p: Placement, scroll: number): string | null {
  const offset = Number.isFinite(scroll) ? scroll : 0;
  const x = p.region.w / 2 + (p.axis === "x" ? offset : 0);
  const y = p.region.h / 2 + (p.axis === "y" ? offset : 0);
  let id: string | null = null;
  let best = Infinity;
  for (const [candidate, rect] of p.rects) {
    const distance = distanceToRect(rect, x, y);
    if (distance < best) { best = distance; id = candidate; }
  }
  return id;
}

const nearest = (values: number[], target: number) => values.reduce((best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best, values[0] ?? 0);

export function scrollFor(next: Placement, anchor: ZoomAnchor | null, current: number): number {
  const offset = Number.isFinite(current) ? current : 0;
  const r = anchor ? bounds(next, anchor.kind === "active" ? anchor.ids : [anchor.id]) : null;
  if (!r) return nearest(next.snaps, offset);
  const fits = visibleSnaps(next, r);
  if (fits.length) return nearest(fits, offset);
  const centre = next.axis === "x" ? r.x + r.w / 2 - next.region.w / 2 : r.y + r.h / 2 - next.region.h / 2;
  return nearest(next.snaps, centre);
}

/** Point is viewport-relative to the full pane area; only map panes scroll. */
export function insertIndex(p: Placement, point: { x: number; y: number }, dragged: string, scroll = 0): number {
  const offset = Number.isFinite(scroll) ? scroll : 0;
  const slots: [string, PxRect][] = [
    ...(p.focus ? [[p.focus.id, p.focus.rect] as [string, PxRect]] : []),
    ...[...p.rects].map(([id, r]): [string, PxRect] => [id, {
      ...r,
      x: r.x + p.region.x - (p.axis === "x" ? offset : 0),
      y: r.y + p.region.y - (p.axis === "y" ? offset : 0),
    }]),
  ];
  let best = Math.max(0, slots.findIndex(([id]) => id === dragged));
  let distance = Infinity;
  slots.forEach(([, rect], i) => {
    const d = distanceToRect(rect, point.x, point.y) * 4 + Math.hypot(point.x - rect.x - rect.w / 2, point.y - rect.y - rect.h / 2) * 0.001;
    if (d < distance) { distance = d; best = i; }
  });
  return best;
}

export function reorder(order: string[], id: string, index: number): string[] {
  if (!order.includes(id)) return [...order];
  const next = order.filter(candidate => candidate !== id);
  next.splice(clamp(Number.isFinite(index) ? Math.trunc(index) : 0, 0, next.length), 0, id);
  return next;
}
