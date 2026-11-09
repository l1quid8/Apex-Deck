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
