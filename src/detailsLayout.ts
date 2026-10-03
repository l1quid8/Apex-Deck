/** Decide from available pane space before docking, avoiding resize feedback. */
export function detailsOverlay(available: number, sidebar = 320, minimum = 560): boolean {
  return available - sidebar < minimum;
}
export type DetailsSection = "bots" | "form" | "room" | "changes";
