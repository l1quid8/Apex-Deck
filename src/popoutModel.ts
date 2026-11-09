// Where a popped-out pane or side-panel tab sat, so it can go back.
// Pure data + pure functions: no windows, no React, tested on its own.

import type { PanelTab, RightPanelState, TabKind } from "./rightPanelModel.ts";
import type { ChipParts } from "./botChip";
import type { DashboardDestination, DashRow } from "./dashboardModel";
import type { ServerChoice } from "./PreviewPane";
import type { LandingTextureSettings } from "./settings";
import type { AppearanceValues, AppearanceSettings } from "./themes";
import type { Access, AgentInfo, Pane, ParticipantConfig, RoomOptions } from "./types";
import type { VoiceSettings } from "./voice/types";
import type { TaskDelegationTarget } from "./taskManagerDelegation.ts";
import type { PersonalTaskSource, WorkspaceTaskRow } from "./workspaceTasks.ts";

import type { AssistantRef, ProjectRef } from "./assistantIdentity.ts";

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
  taskPersonalSources?: PersonalTaskSource[];
  taskDelegationTargets?: TaskDelegationTarget[];
  workspaceTaskProblems?: string[];
  /** A tasks tab's conversation, so it watches the same project. */
  conversationId?: string;
  /** The workspace's display name, for tab titles. */
  workspaceName?: string;
  /** The focused chat thread at pop-out time, which Files and Details follow. */
  activeChatId?: string | null;
  /** The owner's current skin, so the pop-out wears the same look as Deck. */
  appearance?: AppearanceValues | AppearanceSettings;
}

/** Where a pane sat in its section's computed order. */
export interface PaneSpot {
  workspaceId: string;
  index: number;
  before: string[];
}

/** Return beside the nearest surviving old neighbour, then fall back to its index. */
export function restoreOrder(order: string[], paneId: string, spot: PaneSpot): string[] {
  if (order.includes(paneId)) return order;
  const next = [...order];
  const oldIndex = spot.before.indexOf(paneId);
  const preceding = oldIndex < 0 ? [] : spot.before.slice(0, oldIndex).reverse();
  const following = oldIndex < 0 ? [] : spot.before.slice(oldIndex + 1);
  const prior = preceding.find(id => order.includes(id));
  const after = following.find(id => order.includes(id));
  const index = prior !== undefined ? order.indexOf(prior) + 1
    : after !== undefined ? order.indexOf(after)
    : Number.isFinite(spot.index) ? Math.trunc(spot.index) : next.length;
  next.splice(Math.max(0, Math.min(index, next.length)), 0, paneId);
  return next;
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
  | { type: "task-open-project"; project: ProjectRef }
  | { type: "task-open-thread"; project: ProjectRef; id: string }
  | { type: "task-keep-thread"; project: ProjectRef; id: string }
  | { type: "task-create-worker"; project: ProjectRef; profile: ParticipantConfig; assistant: AssistantRef; requestId: string }
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
  taskPersonalSources?: PersonalTaskSource[];
  taskDelegationTargets?: TaskDelegationTarget[];
  workspaceTaskProblems?: string[];
  /** A preview's source while it is still open. */
  previewSource?: { title: string; kind: "terminal" | "chat"; running: boolean } | null;
  /** A popped thread's agents, saved Agents and settings, resent whenever they change in Deck. */
  chatConfig?: ChatBundle;
  /** The outcome of a fork this pop-out asked for. */
  forkResult?: ForkResult;
  /** Saved worker thread id (title), or the owner's failure. */
  taskWorkerResult?: ForkResult;
  /** The owner's skin, resent whenever it changes so open pop-outs change with Deck. */
  appearance?: AppearanceValues | AppearanceSettings;
}

export interface TabTakeout {
  panel: RightPanelState;
  tab: PanelTab;
  spot: TabSpot;
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
