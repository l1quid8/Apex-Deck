// How wide the two sidebars are: the workspaces rail on the left and the
// thread details on the right. A width of null means the user has not
// dragged that sidebar, so the stylesheet's default (and its narrower
// sizes for small windows) still applies.

export type Sidebar = "rail" | "details";

export type SidebarWidths = Record<Sidebar, number | null>;

export const SIDEBAR_DEFAULT: Record<Sidebar, number> = { rail: 240, details: 320 };
export const SIDEBAR_LIMITS: Record<Sidebar, { min: number; max: number }> = {
  rail: { min: 160, max: 480 },
  details: { min: 260, max: 640 },
};
/** How far one arrow key press moves a sidebar's edge. */
export const SIDEBAR_STEP = 16;

const STORAGE_KEY = "apex-deck.sidebars.v1";

export function clampWidth(which: Sidebar, width: number): number {
  const { min, max } = SIDEBAR_LIMITS[which];
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * The width after the pointer moved `dx` pixels from where the drag began.
 * The rail's edge is on its right, so moving right widens it; the details'
 * edge is on its left, so moving left widens it.
 */
export function dragWidth(which: Sidebar, start: number, dx: number): number {
  return clampWidth(which, which === "rail" ? start + dx : start - dx);
}

/** Read saved widths, dropping anything missing or malformed. */
export function parseWidths(raw: string | null): SidebarWidths {
  const out: SidebarWidths = { rail: null, details: null };
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    for (const which of ["rail", "details"] as const) {
      const value = parsed?.[which];
      if (typeof value === "number" && Number.isFinite(value)) out[which] = clampWidth(which, value);
    }
  } catch {
    // A damaged entry just means default widths.
  }
  return out;
}

export function loadWidths(): SidebarWidths {
  try {
    return parseWidths(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { rail: null, details: null };
  }
}

export function saveWidths(widths: SidebarWidths) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Storage can be unavailable; the widths then last for this session only.
  }
}
