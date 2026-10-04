/** Decide from available pane space before docking, avoiding resize feedback. */
export function detailsOverlay(available: number, sidebar = 320, minimum = 560): boolean {
  return available - sidebar < minimum;
}
export type DetailsSection = "bots" | "form" | "room" | "changes";

/**
 * Which thread the details sidebar shows: the focused one if it is on
 * screen, else the visible one focused most recently, else the first
 * visible one. Null when no thread is on screen, so nothing is shown.
 */
export function detailsThread(focused: string | null, visible: string[], recent: string[]): string | null {
  if (focused && visible.includes(focused)) return focused;
  return recent.find((id) => visible.includes(id)) ?? visible[0] ?? null;
}

/** Most recent first, without repeats, capped. */
export function noteFocus(recent: string[], id: string, keep = 20): string[] {
  return [id, ...recent.filter((other) => other !== id)].slice(0, keep);
}
