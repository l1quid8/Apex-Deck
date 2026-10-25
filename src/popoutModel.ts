// Where a popped-out pane or side-panel tab sat, so it can go back.
// Pure data + pure functions: no windows, no React, tested on its own.

import { addLeaf, insertBeside, leafIds, MIN_SHARE, normalize, removeLeaf, type Dir, type LayoutNode } from "./layout.ts";
import type { PanelTab, RightPanelState, TabKind } from "./rightPanelModel.ts";
import type { ChipParts } from "./botChip";
import type { DashboardDestination, DashRow } from "./dashboardModel";
import type { ServerChoice } from "./PreviewPane";
import type { LandingTextureSettings } from "./settings";
import type { AppearanceValues } from "./themes";
import type { Access, AgentInfo, Pane, ParticipantConfig, RoomOptions } from "./types";
import type { VoiceSettings } from "./voice/types";
import type { WorkspaceTaskRow } from "./workspaceTasks.ts";

export type PopoutKind = "pane" | "tab";

/** Artifacts follows the thread shown by its docked tab, even when a terminal has focus. */
export function followedTabPane(kind: TabKind, panes: Pane[], focused: string | null, artifactsTarget: string | null): Pane | null {
  const id = kind === "artifacts" ? artifactsTarget : focused;
  return panes.find((pane) => pane.id === id) ?? null;
}

/** Why a pane stays in Deck instead of popping out, or null when it may pop out.
 *  Task threads come from the assistant's own list, not Deck's: their titles,
 *  renames and forks live there too, so a pop-out of one could not stay in step —
 *  and Deck's gone-thread check would read it as deleted and close it at once. */
export function popoutRefusal(pane: Pane & { assistantTaskId?: string }): string | null {
  return pane.assistantTaskId ? "Task threads stay in Deck for now." : null;
}

/** Everything a popped thread needs to work like the owner's: the machines' agents,
 *  the saved Agents, and the person's settings. Sent whole at pop-out, then pushed
 *  again whenever any of it changes, so the pop-out never runs on stale copies. */
export interface ChatBundle {
  agents: AgentInfo[];
  profiles: ParticipantConfig[];
  disabledProviders: string[];
  workspaceName: string;
  newThread: RoomOptions;
  newBotAccess: Access;
  confirmSteer: boolean;
  chipParts: ChipParts;
  landingTexture: LandingTextureSettings;
  /** Settings → General "Run buttons on code blocks". */
  codeRunButtons: boolean;
  /** Call look, pause and voices, so a popped thread's call matches the owner's. */
  voice?: VoiceSettings;
}

/** How a fork the owner ran for a pop-out ended: the new thread's title, or why it failed. */
export interface ForkResult {
  requestId: string;
  title?: string;
  error?: string;
}

/** What the owner hands the pop-out window so it can show the same item. */
export interface PopoutSnapshot {
  pendingMount?: string | null;
  busyTurn?: boolean;
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
  /** A thread's agents, saved Agents and settings, so a popped chat works like the owner's. */
  chatConfig?: ChatBundle;
  /** A preview's servers, source and host handling, so the page loads the same address. */
  preview?: {
    servers: ServerChoice[];
    source: { title: string; kind: "terminal" | "chat"; running: boolean } | null;
    servedBy?: string;
    openExternally: string[];
  };
  /** A dashboard's rows at pop-out time; the owner keeps pushing them. */
  dashboardRows?: DashRow[];
  workspaceTaskRows?: WorkspaceTaskRow[];
  workspaceTaskProblems?: string[];
  /** A tasks tab's conversation, so it watches the same project. */
  conversationId?: string;
  /** The workspace's display name, for tab titles. */
  workspaceName?: string;
  /** The focused chat thread at pop-out time, which Files and Details follow. */
  activeChatId?: string | null;
  /** The owner's current skin, so the pop-out wears the same look as Deck. */
  appearance?: AppearanceValues;
}

/** Which side of its neighbour a pane sat on. */
export type PopoutSide = "left" | "right" | "top" | "bottom";

/** Where a pane sat in its workspace layout. */
export interface PaneSpot {
  workspaceId: string;
  /** The neighbour in the pane's own split, nearest pane first: one pane, or every pane of a
   *  neighbouring group, so the return goes beside the whole group. Empty when the layout was left empty. */
  neighborIds: string[];
  /** Which side of the neighbour the pane sat on. */
  side: PopoutSide;
  /** The pane's share of its parent split (0 to 1), so a return keeps its size. */
  share: number;
  /** The layout with the pane still in place; an unchanged layout comes back exactly. */
  before: LayoutNode | null;
}

/** Where a tab sat in the side-panel tab strip. */
export interface TabSpot {
  index: number;
  active: string;
}

/** What a pop-out asks its owner to do. Starts, closes and saves run in the owner, never in the pop-out. */
export type PopoutAction =
  | { type: "mount-worktree"; id: string; path: string }
  | { type: "cancel-mount"; id: string }
  | { type: "restart-terminal" }
  | { type: "start-pane"; id: string }
  | { type: "show-pane"; id: string }
  | { type: "dashboard-open"; id: string; destination?: DashboardDestination }
  | { type: "close-pane" }
  | { type: "rename"; title: string }
  | { type: "preview-address"; address: string; servedBy?: string }
  | { type: "open-externally"; hosts: string[] }
  /** Only the saved Agents that changed, so a pop-out save never undoes the owner's newer list. */
  | { type: "profiles-upsert"; profiles: ParticipantConfig[] }
  /** Fork this thread in the owner, so the copy opens in Deck; the owner answers with a `forkResult`. */
  | { type: "fork"; title: string; upto: number | null; at: number; requestId: string }
  /** "Always" in the steer prompt: the setting lives in the owner. */
  | { type: "confirm-steer"; confirm: boolean }
  /** A call setting changed in the pop-out: the settings live in the owner. */
  | { type: "voice-settings"; voice: VoiceSettings }
  /** Reading in the pop-out marks the thread read in the owner too. */
  | { type: "seen"; seq: number }
  | { type: "tab-url"; url: string };

/** What the owner pushes to a pop-out while it is open: titles, selection, runs and rows. */
export interface PopoutUpdate {
  pendingMount?: string | null;
  busyTurn?: boolean;
  title?: string;
  workspaceId?: string;
  activePaneId?: string;
  /** The workspace folder, so selection-following tabs move projects with the main window. */
  cwd?: string;
  /** The followed workspace's daemon host, so tabs watch the right machine. */
  hostId?: string;
  /** The followed workspace's display name. */
  workspaceName?: string;
  /** The focused chat thread, if any, which Files and Details follow. */
  activeChatId?: string | null;
  /** The terminal's current run id; the view re-attaches when the owner restarts it. */
  ptyId?: string;
  /** A browser tab's address, when it changed in the main window. */
  url?: string;
  /** A tasks tab's conversation, pushed with its workspace so the owner never mixes projects. */
  conversationId?: string;
  /** A dashboard's current rows. */
  dashboardRows?: DashRow[];
  workspaceTaskRows?: WorkspaceTaskRow[];
  workspaceTaskProblems?: string[];
  /** A preview's source while it is still open. */
  previewSource?: { title: string; kind: "terminal" | "chat"; running: boolean } | null;
  /** A popped thread's agents, saved Agents and settings, resent whenever they change in Deck. */
  chatConfig?: ChatBundle;
  /** The outcome of a fork this pop-out asked for. */
  forkResult?: ForkResult;
  /** The owner's skin, resent whenever it changes so open pop-outs change with Deck. */
  appearance?: AppearanceValues;
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

type Split = Extract<LayoutNode, { kind: "split" }>;

/** A pane's parent split and the pane's seat in it. */
function parentSplit(node: LayoutNode, id: string): { split: Split; index: number } | null {
  if (node.kind === "leaf") return null;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.kind === "leaf" && child.id === id) return { split: node, index: i };
    if (child.kind === "split") {
      const found = parentSplit(child, id);
      if (found) return found;
    }
  }
  return null;
}

/** Give a leaf a share of its parent split, scaling its siblings to fit. */
function setLeafShare(node: LayoutNode, id: string, share: number): LayoutNode {
  if (!Number.isFinite(share)) return node;
  const want = Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, share));
  const place = (n: LayoutNode): LayoutNode => {
    if (n.kind === "leaf" || n.children.length < 2) return n;
    const at = n.children.findIndex((c) => c.kind === "leaf" && c.id === id);
    if (at >= 0) {
      const old = n.sizes[at] > 0 ? n.sizes[at] : 1 / n.children.length;
      const rest = 1 - old;
      const sizes = n.sizes.map((s, i) => (i === at ? want : rest > 0 ? (s / rest) * (1 - want) : (1 - want) / (n.children.length - 1)));
      return { ...n, sizes };
    }
    return { ...n, children: n.children.map(place) };
  };
  return place(node);
}

/** Put a pane against one side of a group of panes: the subtree holding exactly them, or a run
 *  of children in one split holding exactly them, which is where a pop-out folds a two-child
 *  split's group. A group broken up meanwhile falls back to its nearest pane. */
function insertBesideGroup(node: LayoutNode, group: string[], newId: string, side: PopoutSide): LayoutNode {
  const want = new Set(group);
  const exactly = (ids: string[]) => ids.length === want.size && ids.every((id) => want.has(id));
  const dir: Dir = side === "left" || side === "right" ? "row" : "column";
  const pane: LayoutNode = { kind: "leaf", id: newId };
  const wrap = (target: LayoutNode): LayoutNode => ({ kind: "split", dir, children: side === "left" || side === "top" ? [pane, target] : [target, pane], sizes: [0.5, 0.5] });
  let placed = false;
  const place = (n: LayoutNode): LayoutNode => {
    if (placed) return n;
    if (exactly(leafIds(n))) {
      placed = true;
      return wrap(n);
    }
    if (n.kind === "leaf") return n;
    const holds = n.children.map((c) => leafIds(c).some((id) => want.has(id)));
    const from = holds.indexOf(true);
    const to = holds.lastIndexOf(true);
    const run = n.children.slice(from, to + 1);
    if (from >= 0 && from < to && exactly(run.flatMap(leafIds))) {
      placed = true;
      const runSizes = n.sizes.slice(from, to + 1);
      const total = runSizes.reduce((a, b) => a + b, 0);
      const regrouped: LayoutNode = { kind: "split", dir: n.dir, children: run, sizes: runSizes.map((s) => s / total) };
      return { ...n, children: [...n.children.slice(0, from), wrap(regrouped), ...n.children.slice(to + 1)], sizes: [...n.sizes.slice(0, from), total, ...n.sizes.slice(to + 1)] };
    }
    return { ...n, children: n.children.map(place) };
  };
  const next = place(node);
  return placed ? (normalize(next) ?? pane) : insertBeside(node, group[0], newId, side);
}

/** Take a pane leaf out of its layout, remembering the neighbour in its own split to return beside. */
export function takePaneOut(layout: LayoutNode | null, workspaceId: string, paneId: string): PaneTakeout {
  const next = layout ? removeLeaf(layout, paneId) : null;
  const parent = layout ? parentSplit(layout, paneId) : null;
  // Prefer the sibling after the pane, which the pane sat before; else the one before it.
  const after = parent?.split.children[parent.index + 1];
  const sibling = after ?? parent?.split.children[parent.index - 1];
  const neighborIds = !sibling ? [] : after ? leafIds(sibling) : leafIds(sibling).reverse();
  const dir = parent?.split.dir ?? "row";
  const side: PopoutSide = dir === "column" ? (after ? "top" : "bottom") : (after ? "left" : "right");
  const share = parent ? parent.split.sizes[parent.index] : 0.5;
  return { layout: next, spot: { workspaceId, neighborIds, side, share, before: layout } };
}

/** Put a popped-out pane back where it was, or beside the workspace root when the neighbour is gone. */
export function restorePane(layout: LayoutNode | null, paneId: string, spot: PaneSpot): LayoutNode {
  if (layout && leafIds(layout).includes(paneId)) return layout;
  if (!layout) return { kind: "leaf", id: paneId };
  // Nothing changed since the pop-out: put the exact layout back, side and sizes intact.
  if (spot.before && JSON.stringify(layout) === JSON.stringify(removeLeaf(spot.before, paneId))) return spot.before;
  // Something changed: return to the remembered side of the neighbour's panes still open, at the remembered size.
  const open = new Set(leafIds(layout));
  const group = spot.neighborIds.filter((id) => open.has(id));
  if (group.length > 0) return setLeafShare(insertBesideGroup(layout, group, paneId, spot.side), paneId, spot.share);
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

/** Record a popped tab's new address on its saved copy, so it comes back with it.
 *  The tab has left the strip, so strip updates alone would lose the navigation. */
export function retargetPoppedTab<T extends { token: string; tab: PanelTab }>(list: T[], token: string, url: string): T[] {
  return list.map((rec) => (rec.token === token ? { ...rec, tab: { ...rec.tab, url } } : rec));
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

/** The saved Agents that are new in `after`, or differ from `before` — all a pop-out
 *  may send back, so its older copy of the list never replaces the owner's newer one. */
export function changedProfiles(before: ParticipantConfig[], after: ParticipantConfig[]): ParticipantConfig[] {
  const known = new Map(before.map((p) => [p.id, JSON.stringify(p)]));
  return after.filter((p) => known.get(p.id) !== JSON.stringify(p));
}

/** Fold changed saved Agents into the owner's list by id: known ones are replaced in
 *  place, new ones appended, and everything else — including edits made in Deck while
 *  the pop-out was open — is left exactly as it was. */
export function upsertProfiles(list: ParticipantConfig[], changed: ParticipantConfig[]): ParticipantConfig[] {
  if (changed.length === 0) return list;
  const next = [...list];
  for (const profile of changed) {
    const at = next.findIndex((p) => p.id === profile.id);
    if (at >= 0) next[at] = profile;
    else next.push(profile);
  }
  return next;
}

/** Popped-out panes whose thread is gone from Deck — closed, archived or deleted, or
 *  no longer listed because its project was removed. Their windows close without
 *  restoring: there is nothing left to put back. */
export function orphanedPopouts<T extends { id: string }>(poppedOut: T[], panes: Pane[], listed: { id: string }[]): T[] {
  const listedIds = new Set(listed.map((p) => p.id));
  const byId = new Map(panes.map((p) => [p.id, p]));
  return poppedOut.filter((rec) => {
    const pane = byId.get(rec.id);
    return !pane || pane.closed === true || pane.archived === true || !listedIds.has(rec.id);
  });
}

/** Fork requests a pop-out is waiting on. `request()` hands back the id to send and a
 *  promise that settles only when the owner's real result arrives: the new thread's
 *  title, or the fork's own error — never a guessed success. */
export function createForkChannel() {
  const pending = new Map<string, { resolve: (title: string) => void; reject: (error: Error) => void }>();
  let seq = 0;
  return {
    request(): { requestId: string; result: Promise<string> } {
      const requestId = `fork-${++seq}`;
      const result = new Promise<string>((resolve, reject) => pending.set(requestId, { resolve, reject }));
      return { requestId, result };
    },
    settle(result: ForkResult): boolean {
      const entry = pending.get(result.requestId);
      if (!entry) return false;
      pending.delete(result.requestId);
      if (result.error) entry.reject(new Error(result.error));
      else entry.resolve(result.title ?? "");
      return true;
    },
    pendingCount: (): number => pending.size,
  };
}

export type ForkChannel = ReturnType<typeof createForkChannel>;
