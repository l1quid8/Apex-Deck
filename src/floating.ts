// Where a popover goes beside the element that opened it, kept on screen.
// The bot badges sit at the bottom of the pane, so their cards open upward.

/** Space kept between a popover and the window's edge. */
const MARGIN = 8;

/** Fixed-position offsets for a popover `width` wide that opens above `anchor`: its left edge in line with the anchor's, moved left to stay on screen. */
export function aboveAnchor(anchor: { left: number; top: number }, viewport: { width: number; height: number }, width: number, gap = 6): { left: number; bottom: number } {
  return {
    left: Math.max(MARGIN, Math.min(anchor.left, viewport.width - width - MARGIN)),
    bottom: viewport.height - anchor.top + gap,
  };
}

/** The top of a popover `height` tall: below `anchor` when it fits there, otherwise above it, and always on screen. */
export function popoverTop(anchor: { top: number; bottom: number }, height: number, viewportHeight: number, gap = 6): number {
  const below = anchor.bottom + gap;
  const top = below + height + MARGIN <= viewportHeight ? below : anchor.top - gap - height;
  return Math.max(MARGIN, Math.min(top, viewportHeight - height - MARGIN));
}
