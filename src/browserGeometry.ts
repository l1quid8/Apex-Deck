// Where the docked browser's native view goes, and when something in the
// window is drawn over its pane. The view sits above every element of the
// page, so it has to step aside for menus and dialogs.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

/** A placeholder's CSS rect in the window's pixels at `zoom`, whole and never negative. */
export function viewBounds(rect: Box, zoom: number): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(rect.left * zoom),
    y: Math.round(rect.top * zoom),
    width: Math.max(0, Math.round(rect.width * zoom)),
    height: Math.max(0, Math.round(rect.height * zoom)),
  };
}

/** True when any overlay overlaps the pane by at least a pixel; touching edges don't count. */
export function covered(pane: Box, overlays: Box[]): boolean {
  return overlays.some((o) => Math.min(pane.right, o.right) - Math.max(pane.left, o.left) >= 1 && Math.min(pane.bottom, o.bottom) - Math.max(pane.top, o.top) >= 1);
}

/** What counts as drawn over the page. A modal dialog covers the whole window. */
export const OVERLAYS = "[role=dialog],[role=alertdialog],[role=menu],[role=listbox]";
export const MODAL = "[aria-modal=true]";
