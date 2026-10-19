// Where a popped-out pane or side-panel tab sat, so it can go back.
// Pure data + pure functions: no windows, no React, tested on its own.

import { addLeaf, insertBeside, leafIds, removeLeaf, type LayoutNode } from "./layout.ts";
import type { PanelTab, RightPanelState, TabKind } from "./rightPanelModel.ts";

export type PopoutKind = "pane" | "tab";

/** What the owner hands the pop-out window so it can show the same item. */
export interface PopoutSnapshot {
  kind: PopoutKind;
  /** Pane id when kind is pane, tab id when kind is tab. */
  id: string;
  title: string;
  /** Terminal run id "<paneId>:<generation>" when the pane is a running terminal. */
  ptyId?: string;
  /** Workspace the pane or tab belongs to, so selection-following tabs keep up. */
  workspaceId?: string;
  /** Daemon host of the pane's project ("local" on this Mac). */
  hostId?: string;
  /** Terminal agent key and workspace folder, so the view matches the owner's. */
  agent?: string;
  cwd?: string;
  /** Side-panel tab kind + url when kind is tab. */
  tabKind?: TabKind;
  url?: string;
  /** Which project/pane is selected in the main window (Files/Details/Worktrees follow it). */
  activePaneId?: string;
}

/** Where a pane sat in its workspace layout. */
export interface PaneSpot {
  workspaceId: string;
  /** A neighbour leaf to sit beside on return; null when the layout was left empty. */
  neighborId: string | null;
}

/** Where a tab sat in the side-panel tab strip. */
export interface TabSpot {
  index: number;
  active: string;
}

/** What a pop-out asks its owner to do. Restart and close run in the owner, never in the pop-out. */
export type PopoutAction =
  | { type: "restart-terminal" }
  | { type: "close-pane" }
  | { type: "rename"; title: string };

/** What the owner pushes to a pop-out while it is open: titles, selection and the terminal run. */
export interface PopoutUpdate {
  title?: string;
  workspaceId?: string;
  activePaneId?: string;
  /** The terminal's current run id; the view re-attaches when the owner restarts it. */
  ptyId?: string;
}

export interface PaneTakeout {
  layout: LayoutNode | null;
  spot: PaneSpot;
}

export interface TabTakeout {
  panel: RightPanelState;
  tab: PanelTab;
  spot: TabSpot;
}

/** Take a pane leaf out of its layout, remembering a neighbour to return beside. */
export function takePaneOut(layout: LayoutNode | null, workspaceId: string, paneId: string): PaneTakeout {
  const ids = layout ? leafIds(layout) : [];
  const at = ids.indexOf(paneId);
  const neighborId = at < 0 ? null : (ids[at + 1] ?? ids[at - 1] ?? null);
  const next = layout ? removeLeaf(layout, paneId) : null;
  // The removed pane itself must never be its own neighbour.
  const safeNeighbor = neighborId === paneId ? null : neighborId;
  return { layout: next, spot: { workspaceId, neighborId: safeNeighbor } };
}

/** Put a popped-out pane back where it was, or beside the workspace root when the neighbour is gone. */
export function restorePane(layout: LayoutNode | null, paneId: string, spot: PaneSpot): LayoutNode {
  if (layout && leafIds(layout).includes(paneId)) return layout;
  if (!layout) return { kind: "leaf", id: paneId };
  if (spot.neighborId && leafIds(layout).includes(spot.neighborId)) {
    return insertBeside(layout, spot.neighborId, paneId, "right");
  }
  const ids = leafIds(layout);
  if (ids.length === 0) return { kind: "leaf", id: paneId };
  return addLeaf(layout, paneId);
}

/** Take a side-panel tab out, remembering its strip index and which tab was active. */
export function takeTabOut(panel: RightPanelState, tabId: string): TabTakeout | null {
  const at = panel.tabs.findIndex((t) => t.id === tabId);
  if (at < 0) return null;
  const tab = panel.tabs[at];
  const tabs = panel.tabs.filter((t) => t.id !== tabId);
  const active = panel.active === tabId ? (panel.tabs[at - 1]?.id ?? tabs[0]?.id ?? "dashboard") : panel.active;
  return { panel: { ...panel, tabs, active }, tab, spot: { index: at, active: panel.active } };
}

/** Put a popped-out tab back where it was, clamped when tabs were added or closed meanwhile. */
export function restoreTab(panel: RightPanelState, tab: PanelTab, spot: TabSpot): RightPanelState {
  if (panel.tabs.some((t) => t.id === tab.id)) return panel;
  if (panel.tabs.some((t) => t.kind === tab.kind && tab.kind !== "browser" && t.kind !== "browser")) {
    return panel;
  }
  const at = Math.max(0, Math.min(spot.index, panel.tabs.length));
  const tabs = [...panel.tabs.slice(0, at), tab, ...panel.tabs.slice(at)];
  const active = panel.tabs.some((t) => t.id === spot.active) ? spot.active : tab.id;
  return { ...panel, tabs, active };
}
