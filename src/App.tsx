import { canvasPanes } from "./canvasPanes.ts";
import { normalizeWorkspaces, prepareHostSession, mergeHostSession, migrateCanvasLayouts, workspaceFamily, workspaceHost } from "./hostSession.ts";
import { paneDestination } from "./paneHost.ts";
import { HostPane, HostAgents, HostMonitors } from "./HostPane";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

import { getBackend, type Backend, type HostEntry } from "./backend";
import { connection, statusWords } from "./connection";
import { SettingsPage, type SettingsSection } from "./SettingsPage";
import { DEFAULT_SETTINGS, readSettings, type AppSettings } from "./settings";
import { DEFAULT_APPEARANCE, themeMode, themeVariables } from "./themes";
import { providerEnabled } from "./providers";
import { detailsOverlay, detailsThread, noteFocus, type DetailsSection } from "./detailsLayout";
import type { DetailsHost } from "./ThreadDetails";
import { ThreadName } from "./ThreadName";
import { ChatPane, type ThreadMenuRequest } from "./ChatPane";
import { ModOverlays, ModStatuses, OPEN_SETTINGS_EVENT } from "./ModView";
import { modHost } from "./mods/host";
import { startHub } from "./hub";
import { SectionNavigation, type SectionFlag } from "./SectionNavigation";
import { AgentsSection } from "./AgentsSection";
import { ApexAgentSources } from "./ApexAgentSources";
import { ApexAgentTasks } from "./ApexAgentTasks";
import { overviewProject, overviewOwner, overviewOwnerKey, visibleOverviewEntries, loadOverviewEntries, overviewRouting, handoffBatch, loadHandoffBatches, saveHandoffBatches, visibleHandoffChildren, type HandoffAssignment, type OverviewEntry } from "./apexAgentOverview.ts";
import { ApexAgentAll } from "./ApexAgentAll";
import { usePersonalAssistant } from "./personalAssistant";
import { ApexAgentWidget } from "./ApexAgentWidget";
import "./apex-agent-dock.css";
import { widgetCoordinates, widgetSidePanelPosition, type AssistantSourceDrop, type WidgetPosition } from "./apexAgentWidgetModel.ts";
import { LibraryView } from "./LibraryView";
import { DeckIcon } from "./DeckIcon";
import { LayoutPicker } from "./LayoutPicker";
import { NewMenu } from "./NewMenu";
import { TerminalPane } from "./TerminalPane";
import { PreviewPane, type ServerChoice } from "./PreviewPane";
import { isRunning, stateWord, terminalStatus, toolInstalled, toolName, type TerminalRun } from "./terminalRun";
import { nextTitle, programTitle } from "./terminalTitle";
import { hostLabel, sameServer } from "./previewAddress";
import { copyMenuItems, paneMenuItems, projectMenuItems, type CopyKind, type PaneMenuAction, type ProjectMenuAction } from "./paneMenu";
import { ProjectSidebar } from "./Sidebar";
import { ConnectionDialog, type ConnectionMode } from "./ConnectionDialog";
import { MenuList, type MenuAnchor, type MenuEntry } from "./Menu";
import { archiveThreads, hostTints, noteActive, setCollapsed, setUnread, toggleProjectPin, twinPath, unarchiveThreads } from "./sidebarModel.ts";
import { COPIED, folderCopyText, writeClipboard } from "./threadCopy.ts";
import { chooseOutcome, pickerRows, shortName, workInRows } from "./destinations.ts";
import { Glyph, ProjectFolder } from "./SidebarIcons";
import type { WorkContext } from "./WorkBar";
import { dotState } from "./hostFacts.ts";
import { MoveRefused, historyHasAttachments, placeThread, unsupported } from "./threadMove.ts";
import { loadRoomState } from "./roomRecovery.ts";
import { grid, insertBeside, leafIds, mainAndStack, rects, sync, type LayoutNode, type Rect } from "./layout";
import { Dividers, paneStyle, usePaneDrag } from "./PaneLayout";
import { badgeCount, clearReady, label, seenFlags, summarize, urgency, withApprovals, withPaneSignal, type Attention, type Signal } from "./attention";
import { cyclePane, shortcutFor } from "./shortcuts";
import type { AttentionItem } from "./AttentionMenu";
import { monitorAttentionEntries, reconcileMonitorHost, withMonitorSnapshot, type MonitorAttentionState } from "./monitorAttention.ts";
import { assistantTaskAttentionSignal } from "./monitorAttention.ts";
import { currentAssistantRegistry as selectCurrentAssistantRegistry, emptyAssistantRegistry, mergeAssistantPanes, reduceAssistantSnapshot, type AssistantRegistryState } from "./assistantRegistry.ts";
import { assistantTasksForOwner, assistantMessageArgs, clearPendingRequest, loadPendingRequest, savePendingRequest, type AssistantTaskOwner, type AssistantTaskSnapshot, type PendingAssistantRequest, type AssistantTask, type HandoffBatch, handoffPreparationArgs } from "./assistantTaskModel.ts";
import type { MonitorEvidence, ProjectMonitor } from "./apexAgentModel.ts";
import { ConfirmDialog, type Question } from "./ConfirmDialog";
import { PathPrompt } from "./PathPrompt";
import { SidebarHandle } from "./SidebarHandle";
import { SIDEBAR_DEFAULT, loadWidths, saveWidths, type Sidebar, type SidebarWidths } from "./sidebars";
import { workingFor } from "./composerStatus";
import { approvalSnapshot, dueEscalations, escalationKey, openCards, subscribeApprovals } from "./approvals";
import { UNDO_MS, closeNeedsConfirm, closeQuestion, loadedPanes, paneSection, quitQuestion, removeCounts, removeProjectQuestion, removeQuestion, restoredLayouts, savedLayouts, savedPanes, stillRunning } from "./closing";
import { remoteSessionEdit } from "./sessionSync";
import { activeAfter, addFolders, listedPanes, openThreadIds, pickWorkspaceFolder, removeWorkspacePanes, renameWorkspace, reopenThreads, setHidden, shownWorkspaces } from "./workspaces";
import { RightPanel } from "./RightPanel";
import { RightDashboard } from "./RightDashboard";
import { RightBrowser } from "./RightBrowser";
import { RightFilesTab } from "./RightFiles";
import { defaultPanel, loadPanel, openTab, parsePanel, savePanel, type RightPanelState } from "./rightPanelModel";
import type { AgentInfo, AppSection, AppSession, Layout, Pane, PaneStatus, ParticipantConfig, ThreadStatus, ToolServer, Workspace } from "./types";

const STORAGE_KEY = "apex-deck.workspaces.v1";
/** A pane counts as working if it produced output this recently. */
const WORKING_WINDOW_MS = 1500;

let counter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** macOS prints ⌘ shortcuts; elsewhere Ctrl+Shift. */
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function loadWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Workspace[]) : [];
    return Array.isArray(parsed) ? parsed.filter((w) => w && w.id && w.name) : [];
  } catch {
    return [];
  }
}

function saveWorkspaces(workspaces: Workspace[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
  } catch {
    // Storage can be unavailable; the list then lasts for this session only.
  }
}

/** The last part of a folder path, for display. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The layout of one section of one workspace is saved under this name. */
const layoutKey = (workspace: string | null, section: AppSection) => `${workspace ?? ""}:${section}`;

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
/** How long a toast without Undo stays up. */
const TOAST_MS = 4000;

export function App() {
  const [section, setSection] = useState<AppSection>("threads");
  /** Bumped by the title bar's + New agent button. */
  const [newAgentRequest, setNewAgentRequest] = useState(0);
  /** What each thread reports: its head's words, and who is replying or stopped on a card. */
  const [threadStatus, setThreadStatus] = useState<Record<string, ThreadStatus>>({});
  const onThreadStatus = useCallback((paneId: string, status: ThreadStatus) => {
    setThreadStatus((all) => (JSON.stringify(all[paneId]) === JSON.stringify(status) ? all : { ...all, [paneId]: status }));
    // The newest message's time, saved with the thread, orders Recents.
    if (status.lastAt) setPanes((list) => noteActive(list, paneId, status.lastAt!));
  }, []);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const appearance = settings.appearance?.current.appearance ?? DEFAULT_APPEARANCE;
  useLayoutEffect(() => {
    const root = document.documentElement;
    const variables = themeVariables(appearance);
    root.dataset.deckTheme = themeMode(appearance);
    root.dataset.deckLight = String(appearance.light);
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
    return () => {
      for (const name of Object.keys(variables)) root.style.removeProperty(name);
      delete root.dataset.deckTheme;
      delete root.dataset.deckLight;
    };
  }, [appearance]);
  const disabledProviders = settings.disabledProviders;
  /** The settings section shown, or null while the deck is. */
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  /** False until settings.json has been read, so a file that can't be read is never overwritten. */
  const settingsRead = useRef(false);
  const settingsQueue = useRef<Promise<void>>(Promise.resolve());
  const closeSettings = useCallback(() => setSettingsOpen(null), []);
  // The mod panel's Options button opens Settings → Mods.
  useEffect(() => {
    const open = (e: Event) => setSettingsOpen((e as CustomEvent<SettingsSection>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open);
  }, []);
  const [profiles, setProfiles] = useState<ParticipantConfig[]>([]);
  const [storageError, setStorageError] = useState("");
  const saveQueue = useRef(Promise.resolve());
  const [backend, setBackend] = useState<Backend | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [records, setRecords] = useState<{ workspaces: Workspace[]; panes: Pane[]; importedHostSessions: string[] }>({workspaces: loadWorkspaces(), panes: [], importedHostSessions: []});
  const { workspaces, panes: savedPanesForSession, importedHostSessions } = records;
  const panes = savedPanesForSession;
  const [assistantRegistry, setAssistantRegistry] = useState<AssistantRegistryState>(() => emptyAssistantRegistry());
  const [assistantOwners, setAssistantOwners] = useState<Record<string, AssistantTaskOwner>>({});
  const [assistantTaskSignals, setAssistantTaskSignals] = useState<Record<string, Signal>>({});
  const [assistantTaskNeedsDetails, setAssistantTaskNeedsDetails] = useState<Record<string, string[]>>({});
  const [assistantTaskCounts, setAssistantTaskCounts] = useState<Record<string, number>>({});
  // Each project task's status, keyed by project and task, so a worker chat's menu knows whether its task is still going.
  const [assistantTaskStatuses, setAssistantTaskStatuses] = useState<Record<string, string>>({});
  const [assistantTaskErrors, setAssistantTaskErrors] = useState<Record<string, string>>({});
  const currentAssistantRegistry = useMemo(() => selectCurrentAssistantRegistry(
    assistantRegistry,
    Object.fromEntries(Object.entries(assistantOwners).filter(([workspaceId, owner]) => {
      const workspace = workspaces.find((item) => item.id === workspaceId && !item.hidden);
      return !!workspace && workspace.path === owner.cwd && workspaceHost(workspace) === owner.hostId;
    })),
  ), [assistantRegistry, assistantOwners, workspaces]);
  // Task worker panes are host-owned, so × is remembered here on this Mac.
  const [closedTaskPanes, setClosedTaskPanes] = useState<string[]>(() => { try { const ids = JSON.parse(localStorage.getItem("apex-agent-closed-task-panes") ?? "[]"); return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []; } catch { return []; } });
  const setTaskPaneClosed = (id: string, closed: boolean) => setClosedTaskPanes((ids) => {
    if (ids.includes(id) === closed) return ids;
    const next = closed ? [...ids, id] : ids.filter((other) => other !== id);
    try { localStorage.setItem("apex-agent-closed-task-panes", JSON.stringify(next)); } catch { /* Lasts for this window. */ }
    return next;
  });
  // A task pane's name is also this Mac's own; the task keeps its name on the host.
  const [taskPaneTitles, setTaskPaneTitles] = useState<Record<string, string>>(() => { try { const saved = JSON.parse(localStorage.getItem("apex-agent-task-pane-titles") ?? "{}"); return saved && typeof saved === "object" && !Array.isArray(saved) ? Object.fromEntries(Object.entries(saved).filter(([, title]) => typeof title === "string")) as Record<string, string> : {}; } catch { return {}; } });
  const setTaskPaneTitle = (id: string, title: string) => setTaskPaneTitles((all) => {
    const name = title.trim();
    const { [id]: _old, ...rest } = all;
    const next = name ? { ...rest, [id]: name } : rest;
    try { localStorage.setItem("apex-agent-task-pane-titles", JSON.stringify(next)); } catch { /* Lasts for this window. */ }
    return next;
  });
  const viewPanes = useMemo(() => {
    const closed = new Set(closedTaskPanes);
    return mergeAssistantPanes(panes, currentAssistantRegistry).map((pane) => {
      if (!pane.assistantTaskId) return pane;
      const title = taskPaneTitles[pane.id];
      return { ...pane, ...(title ? { title } : {}), ...(closed.has(pane.id) ? { closed: true } : {}) };
    });
  }, [panes, currentAssistantRegistry, closedTaskPanes, taskPaneTitles]);
  /** The newest lists, for work that finishes after a folder picker or a host call. */
  const latest = useRef({ workspaces, panes });
  const saveTag = useRef(Math.random().toString(36).slice(2));
  const saveSeq = useRef(0);
  latest.current = { workspaces, panes };
  const setWorkspaces = useCallback((next: Workspace[] | ((old: Workspace[]) => Workspace[])) => setRecords(r => ({ ...r, workspaces: typeof next === "function" ? next(r.workspaces) : next })), []);
  const setPanes = useCallback((next: Pane[] | ((old: Pane[]) => Pane[])) => setRecords(r => ({ ...r, panes: typeof next === "function" ? next(r.panes) : next })), []);
  const sessionRef = useRef<AppSession | null>(null);
  const [migrationNotice, setMigrationNotice] = useState("");
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  const [apexAgentWorkspace, setApexAgentWorkspace] = useState<string | null>(null);
  const [apexAgentDockFocused, setApexAgentDockFocused] = useState(false);
  const [apexAgentAppearanceRequest, setApexAgentAppearanceRequest] = useState(0);
  const [apexAgentHideRequest, setApexAgentHideRequest] = useState(0);
  const [apexAgentSelection, setApexAgentSelection] = useState<string | null>(() => {
    try { return localStorage.getItem("apex-agent-selected-project"); } catch { return null; }
  });
  /** ApexAgent opens on one conversation across every project; a single project opens only for its setup and sources. */
  const [apexAgentAllOpen, setApexAgentAllOpen] = useState(false);
  /** The project picked from the avatar's project list; null shows every project's conversation. */
  const [apexAgentFilter, setApexAgentFilter] = useState<string | null>(null);
  const [apexAvatarPosition, setApexAvatarPosition] = useState<WidgetPosition | null>(null);
  const [apexAgentFull, setApexAgentFull] = useState(() => { try { return localStorage.getItem("apex-agent-full-screen") === "1"; } catch { return false; } });
  // The conversation pop-up opens beside the avatar, on whichever edge it sits.
  const apexFloatStyle = (() => {
    if (apexAgentFull || !apexAvatarPosition || typeof window === "undefined") return undefined;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const avatar = widgetCoordinates(apexAvatarPosition, viewport);
    const width = Math.min(400, viewport.width - 48);
    const height = Math.min(600, viewport.height - 140);
    const top = Math.max(48, Math.min(avatar.top + 28 - height / 2, viewport.height - height - 16));
    return { ...widgetSidePanelPosition(apexAvatarPosition.edge, avatar.left, viewport.width, width, 56, 16, 12), top, bottom: "auto", width, height } as CSSProperties;
  })();
  const toggleApexAgentFull = () => setApexAgentFull((full) => { try { localStorage.setItem("apex-agent-full-screen", full ? "0" : "1"); } catch { /* Lasts for this window. */ } return !full; });
  const [, refreshAssistantRequests] = useState(0);
  // Requests this window is sending right now; they show as your chat message, not as an unconfirmed card.
  const assistantSending = useRef(new Set<string>());
  /** Clearing hides earlier messages on this Mac only; each project's assistant keeps its memory and open findings. */
  const [apexAgentClearedAt, setApexAgentClearedAt] = useState(() => { try { return Number(localStorage.getItem("apex-agent-cleared-at")) || 0; } catch { return 0; } });
  const [overviewEntries, setOverviewEntries] = useState<OverviewEntry[]>(() => loadOverviewEntries(localStorage));
  const overviewHistory = useRef(overviewEntries); overviewHistory.current = overviewEntries;
  const [handoffBatches, setHandoffBatches] = useState<HandoffBatch[]>(() => loadHandoffBatches(localStorage));
  const handoffHistory = useRef(handoffBatches);
  const handoffBusy = useRef(new Set<string>());
  const [handoffWorking, setHandoffWorking] = useState<string[]>([]);
  const [assistantTaskContext, setAssistantTaskContext] = useState<{ id: string; project: string; label: string; owner: AssistantTaskOwner; send: (text: string) => Promise<void> } | null>(null);

  const clearApexAgentConversation = () => { const at = Date.now(); setApexAgentClearedAt(at); try { localStorage.setItem("apex-agent-cleared-at", String(at)); } catch { /* Lasts for this window. */ } };
  // Only an explicit project pick (project list, notification jump) filters the conversation; ⌘K opens it unfiltered.
  const openApexAgent = (workspaceId: string, filterToProject = false) => {
    if (!latest.current.workspaces.some((workspace) => workspace.id === workspaceId && !workspace.hidden)) return;
    setApexAgentSelection(workspaceId);
    setApexAgentWorkspace(null);
    setApexAgentFilter(filterToProject ? workspaceId : null);
    setApexAgentAllOpen(true);
    try { localStorage.setItem("apex-agent-selected-project", workspaceId); } catch { /* Selection still lasts for this window. */ }
  };
  const openApexAgentProject = (workspaceId: string) => {
    if (!latest.current.workspaces.some((workspace) => workspace.id === workspaceId && !workspace.hidden)) return;
    setApexAgentSelection(workspaceId);
    setApexAgentWorkspace(workspaceId);
    setApexAgentAllOpen(true);
  };
  const closeApexAgent = () => { setApexAgentWorkspace(null); setApexAgentAllOpen(false); setApexAgentDockFocused(false); };
  const closeApexAgentAndReturnFocus = () => {
    closeApexAgent();
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".apex-widget-hit")?.focus());
  };

  /** Where you stopped reading each thread, saved with it for "New since you looked". */
  const onThreadSeen = useCallback((paneId: string, seq: number) => setPanes((list) => (
    list.some((p) => p.id === paneId && p.lastSeenSeq !== seq) ? list.map((p) => (p.id === paneId ? { ...p, lastSeenSeq: seq } : p)) : list
  )), []);
  const [focusedPane, setFocusedPane] = useState<string | null>(null);
  /** Threads in the order they were last focused, most recent first. */
  const [recentThreads, setRecentThreads] = useState<string[]>([]);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>("top");
  const [layoutPreset, setLayoutPreset] = useState<"grid" | Layout>("top");
  /** How the panes of each workspace section are arranged. */
  const [layouts, setLayouts] = useState<Record<string, LayoutNode>>({});
  /** True while a divider is being dragged. */
  const [resizing, setResizing] = useState(false);
  const gridArea = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  /** A question waiting for Cancel or go ahead. */
  const [question, setQuestion] = useState<Question | null>(null);
  /** Threads deleted but still inside their undo time, by pane id. */
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const deleteTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** The latest delete, offered for undo. */
  const [undoable, setUndoable] = useState<{ id: string; title: string } | null>(null);
  /** The latest workspace removed from the list, offered for undo with the threads that were open. */
  const [undoableRemove, setUndoableRemove] = useState<{ id: string; name: string; reopen: string[] } | null>(null);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The pane head whose ⋯ menu is open. The sidebar keeps its own menus. */
  const [headMenu, setHeadMenu] = useState<{ id: string; anchor: MenuAnchor; opener: HTMLElement | null } | null>(null);
  /** Short notes at the bottom: what was copied, archived, saved. Some offer Undo. */
  const [toasts, setToasts] = useState<{ id: number; text: string; undo?: () => void }[]>([]);
  const toastSeq = useRef(0);
  const toast = useCallback((text: string, undo?: () => void) => {
    const id = ++toastSeq.current;
    setToasts((all) => [...all.slice(-2), { id, text, undo }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), undo ? UNDO_MS : TOAST_MS);
  }, []);
  /** Saved machines, for the sidebar's server names and Copy folder path. */
  const [hostList, setHostList] = useState<HostEntry[]>([]);
  /** Edit connection… (or Add a server), while open. */
  const [connectionDialog, setConnectionDialog] = useState<ConnectionMode | null>(null);
  /** A started thread pointed somewhere else: it asks New thread or Fork there. With `why`, it couldn't move and only New thread is offered. */
  const [moveAsk, setMoveAsk] = useState<{ paneId: string; to: Workspace; why?: string } | null>(null);
  /** Bumped by ⌥⇧⌘O to open a thread's project picker. */
  const [pickerRequests, setPickerRequests] = useState<Record<string, number>>({});
  /** Threads being moved or forked right now, so a second choice waits. */
  const moving = useRef(new Set<string>());
  /** Bumped by ⌘T to open the + New menu. */
  const [newMenuRequest, setNewMenuRequest] = useState(0);
  /** Bumped to start renaming from the pane head's ⋯ menu. */
  const [renameRequests, setRenameRequests] = useState<Record<string, number>>({});
  /** Bumped to start renaming from the sidebar row, so the head editor stays closed. */
  const [railRename, setRailRename] = useState<Record<string, number>>({});
  /** Bumped to start a terminal again from its ⋯ menu. */
  const [startRequests, setStartRequests] = useState<Record<string, number>>({});
  /** Fork, Export, Share or Copy chosen in a ⋯ menu. Cleared once the thread takes it. */
  const [threadRequests, setThreadRequests] = useState<Record<string, { id: string; action: ThreadMenuRequest } | undefined>>({});
  const menuSeq = useRef(0);
  const [railOpen, setRailOpen] = useState(true);
  const [panel, setPanel] = useState<RightPanelState>(loadPanel);
  useEffect(() => savePanel(panel), [panel]);
  const detailsOpen = panel.open;
  const setDetailsOpen = (open: boolean) => setPanel((p) => ({ ...p, open }));
  const asideRef = useRef<HTMLElement | null>(null);
  const [detailsCollapsed, setDetailsCollapsed] = useState<Partial<Record<DetailsSection, boolean>>>({});
  const [detailsSlot, setDetailsSlot] = useState<HTMLElement | null>(null);
  const detailsTabActive = panel.tabs.find((t) => t.id === panel.active)?.kind === "details";
  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [, setBodyWidth] = useState(0);
  const compactApexAgentDock = false; // The v4 pop-up floats over the app, so the sidebar never has to give way.
  const railVisible = railOpen && !compactApexAgentDock;
  /** Sidebar widths the user dragged to; null keeps the default. */
  const [sidebarWidths, setSidebarWidths] = useState<SidebarWidths>(loadWidths);
  const setSidebarWidth = (which: Sidebar) => (width: number | null) => setSidebarWidths((old) => ({ ...old, [which]: width }));
  useEffect(() => saveWidths(sidebarWidths), [sidebarWidths]);
  const detailsToggle = useRef<HTMLButtonElement>(null);
  const focusDetails = useRef(false);
  /** Whether a thread is on screen for the sidebar; read by the Escape handler. */
  const detailsTargetRef = useRef<string | null>(null);
  const pendingSection = useRef<DetailsSection | undefined>(undefined);
  const detailsWidth = sidebarWidths.details ?? SIDEBAR_DEFAULT.details;
  const overlayDetails = detailsOverlay(availableWidth, detailsWidth);
  const closeDetails = () => { setDetailsOpen(false); detailsToggle.current?.focus(); };
  const showDetails = (target?: DetailsSection) => {
    pendingSection.current = target;
    focusDetails.current = true;
    if (target) setDetailsCollapsed(old => ({ ...old, [target]: false }));
    setPanel((p) => openTab({ ...p, open: true }, "details", Date.now()));
  };
  const detailsHostBase = { slot: detailsSlot, open: panel.open && detailsTabActive && section === "threads", overlay: overlayDetails, collapsed: detailsCollapsed,
    toggle: (target: DetailsSection) => setDetailsCollapsed(old => ({ ...old, [target]: !old[target] })), show: showDetails, close: closeDetails };
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      // Measure available pane space with the rail accounted for, before docking.
      const rail = body.querySelector<HTMLElement>(".rail");
      setBodyWidth(body.clientWidth);
      setAvailableWidth(body.clientWidth - (rail?.getBoundingClientRect().width ?? 0));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    if (canvasRef.current) observer.observe(canvasRef.current);
    measure();
    return () => observer.disconnect();
  }, [backend, railOpen, section]);
  useEffect(() => {
    if (!detailsOpen || !detailsSlot) return;
    if (focusDetails.current) {
      const target = pendingSection.current ? detailsSlot.querySelector<HTMLElement>(`#details-${pendingSection.current}`) : detailsSlot;
      target?.scrollIntoView({ block: "nearest" });
      (target?.querySelector<HTMLElement>("input, button, select, textarea") ?? detailsSlot).focus();
      focusDetails.current = false;
    }
  }, [detailsOpen, detailsSlot, detailsCollapsed]);
  useEffect(() => {
    if (!detailsOpen || section !== "threads" || !overlayDetails || !detailsTargetRef.current) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeDetails(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [detailsOpen, section, overlayDetails]);
  /** Where each terminal's program is: stopped, running or exited. TerminalPane reports it. */
  const [runs, setRuns] = useState<Record<string, TerminalRun>>({});
  /** The title each terminal's program gives itself, cleaned. TerminalPane reports it. */
  const [programTitles, setProgramTitles] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  /** Panes that want attention, by pane id. */
  const [attention, setAttention] = useState<Record<string, Signal>>({});
  /** ApexAgent findings belong to a workspace folder and host, not to a pane visit. */
  const [monitorAttention, setMonitorAttention] = useState<MonitorAttentionState>({});
  const monitorVersions = useRef(new Map<string, { signature: string; backend?: unknown; connection?: unknown; status?: unknown; revision?: number; version: number }>());
  const monitorVersionSequence = useRef(0);
  const lastOutput = useRef(new Map<string, number>());
  /** Terminals read back from the session file. They wait, Stopped, until started. */
  const restored = useRef(new Set<string>());
  /** When each terminal's current run of output began, for "Working 4m". */
  const runStart = useRef(new Map<string, number>());
  /** Every open approval card, app-wide (approvals.ts). */
  const approvalState = useSyncExternalStore(subscribeApprovals, approvalSnapshot);
  /** The Electron app's connection to its host, for the loading screen. */
  const link = useSyncExternalStore(connection.subscribe, connection.get);
  const [, countdown] = useState(0);
  useEffect(() => {
    // Count down to the next try.
    if (link.status.kind !== "reconnecting") return;
    const timer = setInterval(() => countdown((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [link.status]);

  useEffect(() => {
    let alive = true;
    getBackend().then(async (b) => {
      await startHub(b);
      if (!b.demo) modHost.start();
      const found = await (b.machines ? b.machines.discover() : b.detectAgents()).catch(() => []);
      const folders = await b.startupFolders().catch(() => []);
      const saved = await b.sessionLoad();
      const savedSettings = await b.settingsLoad().then((raw) => ({ raw }), (error) => ({ error }));
      if (!alive) return;
      if ("raw" in savedSettings) {
        setSettings(readSettings(savedSettings.raw, saved?.disabledProviders));
        settingsRead.current = true;
      } else {
        setSettings(readSettings(null, saved?.disabledProviders));
        setStorageError(`Could not read settings: ${String(savedSettings.error)}. Defaults are in use and the file has been kept.`);
      }
      setAgents(found);
      const known = normalizeWorkspaces(saved?.workspaces ?? loadWorkspaces());
      setWorkspaces(known);
      const loaded = loadedPanes(saved?.panes ?? [], known.map((w) => w.id));
      restored.current = new Set(loaded.filter((p) => p.kind === "terminal").map((p) => p.id));
      setPanes(loaded);
      setProfiles(saved?.profiles ?? []);
      setSection(saved?.section ?? "threads");
      setLayout(saved?.layout ?? "top");
      setLayoutPreset(saved?.layout ?? "top");
      setPanel(saved?.rightPanel ? parsePanel(JSON.stringify(saved.rightPanel)) : saved?.threadDetailsOpen ? { ...defaultPanel(), open: true, active: "details" } : loadPanel());
      setDetailsCollapsed(saved?.threadDetailsCollapsed ?? {});
      // A layout that cannot be read is dropped and rebuilt from the panes,
      // and panes that didn't load are taken out of the rest.
      const migrated = migrateCanvasLayouts({ version: 1, workspaces: known, panes: loaded, profiles: [], activeWorkspace: saved?.activeWorkspace ?? null, focusedPane: saved?.focusedPane ?? null, section: saved?.section ?? "threads", layout: saved?.layout ?? "top", layouts: saved?.layouts });
      setLayouts(restoredLayouts(migrated.layouts, loaded));
      setRecords(r => ({ ...r, importedHostSessions: saved?.importedHostSessions ?? [] }));
      setActiveWorkspace(saved?.activeWorkspace ?? known[0]?.id ?? null);
      setFocusedPane(saved?.focusedPane ?? null);
      if (folders.length > 0) {
        // Open folders named on the command line, reusing any already listed
        // and bringing back any removed from the list.
        const { list, ids } = addFolders(known, folders, () => newId("ws"), folderName);
        setWorkspaces(list);
        setActiveWorkspace(ids[0] ?? null);
      }
      setBackend(b);
    }).catch((error) => {
      if (alive) setStorageError(`Could not open saved chats: ${String(error)}. Your saved files have been kept.`);
    });
    return () => {
      alive = false;
    };
  }, []);

  const currentSession: AppSession = { version: 1, workspaces, panes: savedPanes(panes), profiles, activeWorkspace, focusedPane, section, layout, layouts: savedLayouts(layouts, workspaces.map(w => w.id)), rightPanel: panel, threadDetailsOpen: detailsOpen, threadDetailsCollapsed: detailsCollapsed, importedHostSessions, canvasVersion: 1 };
  sessionRef.current = currentSession;
  useEffect(() => {
    if (!backend?.machines || !backend.hosts) return;
    let alive = true;
    void backend.hosts.list().then(hosts => Promise.allSettled(hosts.filter(h => h.remote && !sessionRef.current?.importedHostSessions?.includes(h.id)).map(async host => {
      try {
        const remote = prepareHostSession(await backend.machines!.legacySession(host.id));
        const settings = await backend.machines!.legacySettings(host.id).catch(() => null) as { decision?: { enabled?: boolean } } | null;
        if (!alive) return;
        if (settings?.decision?.enabled) setMigrationNotice(`${host.name}'s decision observer is enabled in its own settings. Deck's observer switch controls This Mac's threads only.`);
        setRecords(old => {
          const merged = mergeHostSession({ ...sessionRef.current!, ...old }, host.id, remote);
          merged.session.panes.filter(p => p.kind === "terminal").forEach(p => restored.current.add(p.id));
          if (merged.conflicts.length) queueMicrotask(() => setMigrationNotice(`Imported ${host.name}; remapped/skipped conflicting IDs: ${merged.conflicts.join(", ")}`));
          return { workspaces: merged.session.workspaces, panes: merged.session.panes, importedHostSessions: merged.session.importedHostSessions! };
        });
      } catch (error) { if (alive) setMigrationNotice(`Saved chats on ${host.name} could not be imported: ${String(error)}. Deck will retry at next launch.`); }
    })));
    return () => { alive = false; };
  }, [backend]);

  useEffect(() => {
    if (!backend) return;
    void backend.hosts?.references?.(workspaces.map(workspaceHost)).catch(() => {});
    saveWorkspaces(workspaces);
    // Tagged so its echo from the helper is told apart from the phone's edits.
    const session = { ...sessionRef.current!, savedBy: `${saveTag.current}:${++saveSeq.current}` };
    // Keep writes in order so a slow old save cannot overwrite newer state.
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => backend.sessionSave(session));
    saveQueue.current.then(() => setStorageError(""), (error) => setStorageError(`Could not save changes: ${String(error)}`));
  }, [backend, workspaces, panes, profiles, activeWorkspace, focusedPane, section, layout, layouts, panel, detailsOpen, detailsCollapsed, importedHostSessions]);

  // The phone saves threads straight to the Mac's session. Take its edits in
  // before the next save here writes over them.
  useEffect(() => {
    if (!backend?.onSessionChanged) return;
    let off: (() => void) | undefined;
    let alive = true;
    backend.onSessionChanged((remote) => {
      const edit = remoteSessionEdit({ workspaces: latest.current.workspaces, panes: savedPanes(latest.current.panes) }, remote, { tag: saveTag.current, seq: saveSeq.current });
      if (!edit) return;
      const known = normalizeWorkspaces(edit.workspaces);
      setRecords((r) => ({ ...r, workspaces: known, panes: loadedPanes(edit.panes, known.map((w) => w.id)) }));
    }).then((stop) => { if (alive) off = stop; else stop(); }, () => {});
    return () => { alive = false; off?.(); };
  }, [backend]);

  // The saved machines, for server names in the sidebar. Settings can change them.
  useEffect(() => {
    if (!backend?.hosts || settingsOpen) return;
    let alive = true;
    backend.hosts.list().then((list) => { if (alive) setHostList(list); }, () => {});
    return () => { alive = false; };
  }, [backend, settingsOpen]);

  // settings.json, beside the session file. Written in order, like the session.
  useEffect(() => {
    if (!backend || !settingsRead.current) return;
    settingsQueue.current = settingsQueue.current.catch(() => {}).then(() => backend.settingsSave(settings));
    settingsQueue.current.catch((error) => setStorageError(`Could not save settings: ${String(error)}`));
  }, [backend, settings]);

  // The workspace in view is always a listed one: removing it moves on to the first listed.
  useEffect(() => {
    const next = activeAfter(workspaces, activeWorkspace);
    if (next !== activeWorkspace) setActiveWorkspace(next);
  }, [workspaces, activeWorkspace]);

  // Re-render once a second so status dots fall back to idle.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const onActivity = useCallback((paneId: string) => {
    lastOutput.current.set(paneId, Date.now());
  }, []);
  /** The newest local server address each running terminal printed, and each open thread's bots mentioned. */
  const [servers, setServers] = useState<Record<string, string>>({});
  /** An empty address means the pane no longer has one, as after /clear. */
  const onServer = useCallback((paneId: string, address: string) => {
    setServers((all) => {
      if (!address) {
        if (!(paneId in all)) return all;
        const rest = { ...all };
        delete rest[paneId];
        return rest;
      }
      return all[paneId] === address ? all : { ...all, [paneId]: address };
    });
  }, []);
  const forgetServer = useCallback((paneId: string) => {
    setServers((all) => {
      if (!(paneId in all)) return all;
      const rest = { ...all };
      delete rest[paneId];
      return rest;
    });
  }, []);

  const onRun = useCallback((paneId: string, run: TerminalRun) => {
    setRuns((all) => (all[paneId] === run ? all : { ...all, [paneId]: run }));
    // A terminal's server chip goes when its program stops or ends.
    if (run.state !== "running") forgetServer(paneId);
  }, [forgetServer]);
  const onTitle = useCallback((paneId: string, title: string) => {
    setProgramTitles((all) => ((all[paneId] ?? "") === title ? all : { ...all, [paneId]: title }));
  }, []);
  /** What a terminal's program says it is doing, shown muted after its name; "" for threads and when it only repeats a name. */
  const programOf = (pane: Pane): string => {
    if (pane.kind === "preview") return pane.url ? hostLabel(pane.url) : "";
    if (pane.kind !== "terminal") return "";
    const tool = agents.find((a) => a.key === pane.agent);
    return programTitle(programTitles[pane.id] ?? "", [pane.title, tool?.label ?? "", tool?.program ?? ""]);
  };
  const onRunStart = useCallback((paneId: string, startedAt: number) => {
    runStart.current.set(paneId, startedAt);
  }, []);

  /** The muted words each Preview shows in its pane head. */
  const [previewStatus, setPreviewStatus] = useState<Record<string, string>>({});
  const onPreviewStatus = useCallback((paneId: string, text: string) => {
    setPreviewStatus((all) => (all[paneId] === text ? all : { ...all, [paneId]: text }));
  }, []);

  const statusOf = (pane: Pane): PaneStatus => {
    if (pane.kind === "preview") return "idle";
    const working = Date.now() - (lastOutput.current.get(pane.id) ?? 0) < WORKING_WINDOW_MS;
    // A stopped or exited terminal reads "exited": it never asks before closing.
    if (pane.kind === "terminal") return terminalStatus(runs[pane.id], attention[pane.id]?.kind ?? null, working);
    if (attention[pane.id]) return attention[pane.id].kind;
    return working ? "working" : "idle";
  };

  /** Panes of listed workspaces. A removed workspace's threads are not mounted, so their rooms close. */
  const listed = useMemo(() => listedPanes(viewPanes, workspaces), [viewPanes, workspaces]);
  const currentMonitorAttention = useMemo(() => monitorAttentionEntries(monitorAttention, workspaces, Date.now()), [monitorAttention, workspaces, tick]);
  const visiblePanes = useMemo(() => canvasPanes(viewPanes, workspaces, deleting, section), [viewPanes, workspaces, deleting, section]);
  const shown = maximized && visiblePanes.some((p) => p.id === maximized) ? visiblePanes.filter((p) => p.id === maximized) : visiblePanes;
  useEffect(() => {
    if (focusedPane && viewPanes.some((p) => p.id === focusedPane && p.kind === "chat")) setRecentThreads((recent) => (recent[0] === focusedPane ? recent : noteFocus(recent, focusedPane)));
  }, [focusedPane, viewPanes]);
  /** The thread the details sidebar shows; null when no thread is on screen. */
  const detailsTarget = section === "threads" && !picking ? detailsThread(focusedPane, shown.filter((p) => p.kind === "chat").map((p) => p.id), recentThreads) : null;
  detailsTargetRef.current = detailsTarget;
  const detailsHost: DetailsHost = { ...detailsHostBase, target: detailsTarget };

  // The arrangement of the panes in view. Panes that were added or closed
  // since it was last stored are worked in here, so it always matches.
  const key = layoutKey(null, section);
  const visibleIds = visiblePanes.map((p) => p.id).join("\n");
  const tree = useMemo(() => {
    const box = gridArea.current?.getBoundingClientRect();
    const aspect = box && box.width > 0 && box.height > 0 ? box.width / box.height : 1.6;
    return sync(layouts[key] ?? null, visibleIds ? visibleIds.split("\n") : [], aspect);
  }, [layouts, key, visibleIds]);
  useEffect(() => {
    if (!tree || JSON.stringify(layouts[key]) === JSON.stringify(tree)) return;
    setLayouts((all) => ({ ...all, [key]: tree }));
  }, [tree, layouts, key]);
  const setTree = useCallback((next: LayoutNode) => setLayouts((all) => ({ ...all, [key]: next })), [key]);
  const placed = useMemo(() => rects(tree), [tree]);
  const paneDrag = usePaneDrag(maximized ? null : tree, gridArea, setTree);

  /** Rearrange the panes in view into one of the ready-made layouts. */
  const arrange = (preset: "grid" | Layout) => {
    const ids = leafIds(tree);
    if (ids.length < 2) return;
    const box = gridArea.current?.getBoundingClientRect();
    const aspect = box && box.width > 0 && box.height > 0 ? box.width / box.height : 1.6;
    // The pane in use becomes the large one.
    const main = focusedPane && ids.includes(focusedPane) ? focusedPane : ids[0];
    const next = preset === "grid" ? grid(ids, aspect) : mainAndStack([main, ...ids.filter((id) => id !== main)], preset);
    if (next) setTree(next);
    setLayoutPreset(preset);
    if (preset !== "grid") setLayout(preset);
    setMaximized(null);
  };
  const shownList = shownWorkspaces(workspaces);
  const current = shownList.find((w) => w.id === activeWorkspace) ?? null;

  const hostNameFor = (hostId: string) => { try { return backend?.machines?.connection(hostId).get().name ?? hostId; } catch { return hostId; } };
  const backendFor = (pane: Pane): Backend => {
    if (!backend) throw new Error("The backend is not ready yet.");
    const { hostId: workspaceHostId } = paneDestination(pane, workspaces);
    const hostId = (pane as Pane & { hostId?: string }).hostId ?? workspaceHostId;
    if (backend.machines) return backend.machines.get(hostId);
    if (hostId !== "local") throw new Error("This server is unavailable.");
    return backend;
  };
  const addWorkspace = async (_event?: unknown, hostId = "local") => {
    if (!backend) return;
    if (backend.demo) {
      // The preview has no folders to pick, so every workspace is new.
      const workspace = { id: newId("ws"), name: `workspace-${workspaces.length + 1}`, path: "" };
      setWorkspaces((list) => [...list, workspace]);
      setActiveWorkspace(workspace.id);
      return;
    }
    await pickWorkspaceFolder({ pick: () => (backend.machines?.get(hostId) ?? backend).pickFolder(),
      update: setWorkspaces, select: setActiveWorkspace, id: newId("ws"), nameOf: folderName, hostId });
  };

  /** Take a workspace out of the app, with a few seconds to Undo. Its folder
   *  on disk is never deleted, and its terminals end. Asks first only while something in it runs. */
  const removeWorkspace = (workspace: Workspace, always = false) => {
    const own = panes.filter((p) => p.workspaceId === workspace.id && !deleting.has(p.id));
    const counts = removeCounts(
      own.filter((p) => p.kind === "terminal").map((p) => statusOf(p)),
      own.filter((p) => p.kind === "chat").map((p) => threadStatus[p.id]),
    );
    const reopen = openThreadIds(own, workspace.id);
    const remove = () => {
      for (const pane of own) if (pane.kind === "terminal") lastOutput.current.delete(pane.id);
      setPanes((list) => removeWorkspacePanes(list, workspace.id));
      setWorkspaces((list) => setHidden(list, workspace.id, true));
      setFocusedPane((id) => (id && own.some((p) => p.id === id) ? null : id));
      setMaximized((id) => (id && own.some((p) => p.id === id) ? null : id));
      clearTimeout(removeTimer.current);
      setUndoableRemove({ id: workspace.id, name: workspace.name, reopen });
      removeTimer.current = setTimeout(() => setUndoableRemove((u) => (u?.id === workspace.id ? null : u)), UNDO_MS);
    };
    // The sidebar's Remove project… always asks; other removals ask only while something runs.
    const asked = always ? removeProjectQuestion(workspace.name, counts) : removeQuestion(workspace.name, counts);
    if (asked) setQuestion({ ...asked, onConfirm: remove });
    else remove();
  };

  // A removed project leaves the app for good once its Undo runs out. Its folder on disk is never touched.
  useEffect(() => {
    const gone = new Set(workspaces.filter((w) => w.hidden && w.id !== undoableRemove?.id).map((w) => w.id));
    if (gone.size === 0) return;
    setWorkspaces((list) => list.filter((w) => !gone.has(w.id)));
    setPanes((list) => list.filter((p) => !gone.has(p.workspaceId)));
  }, [workspaces, undoableRemove]);

  /** Undo a removal: the row and its threads come back. Its terminals can't. */
  const undoRemove = () => {
    if (!undoableRemove) return;
    clearTimeout(removeTimer.current);
    const { id, reopen } = undoableRemove;
    setWorkspaces((list) => setHidden(list, id, false));
    setPanes((list) => reopenThreads(list, reopen));
    setActiveWorkspace(id);
    setUndoableRemove(null);
  };

  /** A workspace with no folder and a thread of two scripted bots, to try a room without keys. */
  const trySample = () => {
    const workspace = { id: newId("ws"), name: "Sample", path: "" };
    const pane: Pane = { id: newId("pane"), workspaceId: workspace.id, kind: "chat", title: "Sample thread", sample: true };
    setWorkspaces((list) => [...list, workspace]);
    setActiveWorkspace(workspace.id);
    setPanes((list) => [...list, pane]);
    setFocusedPane(pane.id);
    setSection("threads");
    setPicking(false);
  };

  const renamePane = (id: string, title: string) => setPanes(list => list.map(p => p.id === id ? {...p, title} : p));

  const addPane = (kind: Pane["kind"], title: string, agent?: string, workspaceId = activeWorkspace) => {
    if (!workspaceId) return;
    // A second terminal or preview of the same name in a workspace is numbered: "Codex 2", "Preview 2".
    const name = kind === "chat" ? title : nextTitle(title, panes.filter((p) => p.workspaceId === workspaceId && p.kind === kind).map((p) => p.title));
    const pane: Pane = { id: newId("pane"), workspaceId, kind, title: name, agent };
    if (workspaceId !== activeWorkspace) setActiveWorkspace(workspaceId);
    // A Preview stays on the deck it was added from.
    if (kind === "preview" && section === "threads") pane.deck = "threads";
    setPanes((list) => [...list, pane]);
    setFocusedPane(pane.id);
    setSection(paneSection(pane));
    setMaximized(null);
    setPicking(false);
  };

  /** The sidebar's New thread (or terminal) in a project. */
  const newIn = (workspace: Workspace) => {
    if (section === "code") {
      // A terminal needs a tool chosen, so the project's picker opens.
      setActiveWorkspace(workspace.id);
      setPicking(true);
      setMaximized(null);
      return;
    }
    addPane("chat", "Group chat", undefined, workspace.id);
  };

  /** A Preview's address changed. A typed address has no source terminal or thread. */
  const setPreviewAddress = useCallback((paneId: string, address: string, servedBy?: string) => {
    setPanes((list) => list.map((p) => {
      if (p.id !== paneId) return p;
      const next: Pane = { ...p, url: address };
      if (servedBy) next.servedBy = servedBy;
      else delete next.servedBy;
      return next;
    }));
  }, []);

  /** The terminal or thread a Preview's address came from, while it is open. */
  const sourceOf = (pane: Pane) => {
    const source = pane.servedBy ? panes.find((p) => p.id === pane.servedBy && !p.closed && (p.kind === "terminal" || p.kind === "chat")) : undefined;
    if (!source) return null;
    const kind: "terminal" | "chat" = source.kind === "chat" ? "chat" : "terminal";
    return { pane: source, title: source.title, kind, running: kind === "chat" || isRunning(runs[source.id]) };
  };

  const openInBrowser = useCallback((address: string) => {
    backend?.openTarget(address, null, false).catch(() => {});
  }, [backend]);

  /** Servers from a workspace's terminals and open threads, for a Preview's empty page. */
  const serversFor = (workspaceId: string): ServerChoice[] =>
    Object.entries(servers).flatMap(([id, address]) => {
      const source = panes.find((p) => p.id === id && p.workspaceId === workspaceId && !p.closed);
      return source ? [{ address, source: source.title, sourceId: id }] : [];
    });

  /**
   * Show a server in a Preview right of the terminal or thread it came from,
   * on that pane's deck, or focus the Preview already showing it there.
   * `auto` is a thread's bot naming a new server: the thread's own Preview
   * moves to it (unless it already shows that server), or one opens, and focus stays where you are.
   */
  const openPreview = (address: string, sourceId: string, auto = false) => {
    const source = panes.find((p) => p.id === sourceId);
    if (!source) return;
    const deck = paneSection(source);
    const existing = panes.find((p) => p.kind === "preview" && p.workspaceId === source.workspaceId && paneSection(p) === deck && p.url === address);
    if (existing) {
      if (!auto) focusPane(existing);
      return;
    }
    const own = auto ? panes.find((p) => p.kind === "preview" && !p.closed && p.servedBy === sourceId && paneSection(p) === deck) : undefined;
    if (own) {
      // Another page on the server it already shows is left alone: bots name
      // paths in passing, and the page you're on shouldn't jump.
      if (own.url && sameServer(own.url, address)) return;
      setPreviewAddress(own.id, address, sourceId);
      return;
    }
    const id = newId("pane");
    const title = nextTitle("Preview", panes.filter((p) => p.workspaceId === source.workspaceId && p.kind === "preview").map((p) => p.title));
    const preview: Pane = { id, workspaceId: source.workspaceId, kind: "preview", title, url: address, servedBy: sourceId };
    if (deck === "threads") preview.deck = "threads";
    const key = layoutKey(null, deck);
    setPanes((list) => [...list, preview]);
    setLayouts((all) => (all[key] && leafIds(all[key]).includes(sourceId) ? { ...all, [key]: insertBeside(all[key], sourceId, id, "right") } : all));
    if (auto) return;
    setActiveWorkspace(source.workspaceId);
    setSection(deck);
    setPicking(false);
    setFocusedPane(id);
    setMaximized(null);
  };

  const forkThread = async (source: Pane, title: string, upto: number | null, at: number) => {
    const id = newId("pane");
    if (!backend) throw new Error("The backend is not ready yet.");
    await backendFor(source).roomFork(source.id, id, upto);
    const sourceHost = workspaces.find((w) => w.id === source.workspaceId);
    const fork = { from: source.id, title: source.title, host: hostNameFor(sourceHost ? workspaceHost(sourceHost) : "local"), at };
    setPanes((list) => [...list, { id, workspaceId: source.workspaceId, kind: "chat", title, fork }]);
    setFocusedPane(id);
    setSection("threads");
    setMaximized(null);
    return title;
  };

  // A pane the person is looking at right now does not need flagging,
  // except a terminal that is blocked on a question: its dot should say so.
  const watched = useRef<(paneId: string) => boolean>(() => false);
  watched.current = (paneId) => focusedPane === paneId && !picking && visiblePanes.some((p) => p.id === paneId) && (!maximized || maximized === paneId) && document.hasFocus();
  const kindOf = useRef<(paneId: string) => Pane["kind"] | undefined>(() => undefined);
  kindOf.current = (paneId) => panes.find((p) => p.id === paneId)?.kind;

  const onSignal = useCallback((paneId: string, kind: Attention | null, note = "") => {
    if (kind && watched.current(paneId) && !(kind === "needs_input" && kindOf.current(paneId) === "terminal")) return;
    setAttention((all) => withPaneSignal(all, paneId, kind ? { kind, note, at: Date.now() } : null));
  }, []);

  // A thread's open approval cards flag it until the last one is answered,
  // whether or not it is being looked at. See approvals.ts.
  const onApprovals = useCallback((paneId: string, signal: Signal | null) => setAttention((all) => withApprovals(all, paneId, signal)), []);

  // Looking at a pane settles its flag. A terminal that is still waiting on
  // an answer keeps its flag until something is typed into it, and a thread
  // stopped on an approval card keeps its flag until the card is answered.
  const [windowFocus, setWindowFocus] = useState(0);
  useEffect(() => {
    const seen = () => setWindowFocus((n) => n + 1);
    window.addEventListener("focus", seen);
    return () => window.removeEventListener("focus", seen);
  }, []);
  useEffect(() => {
    if (!focusedPane || !watched.current(focusedPane)) return;
    setAttention((all) => seenFlags(all, focusedPane, kindOf.current(focusedPane) === "terminal"));
  }, [focusedPane, activeWorkspace, section, picking, maximized, windowFocus, attention]);

  // Flags for panes that no longer exist, or whose workspace was removed
  // from the list, are dropped, and the app's icon shows how many are left.
  // A new flag raised while the app is in the background also draws the
  // eye to the icon.
  const flagged = useRef(0);
  useEffect(() => {
    // Archived threads are put away: they don't flag the app either.
    const live = Object.keys(attention).filter((id) => listed.some((p) => p.id === id && !p.archived));
    if (live.length !== Object.keys(attention).length) {
      setAttention((all) => Object.fromEntries(Object.entries(all).filter(([id]) => listed.some((p) => p.id === id && !p.archived))));
      return;
    }
    // The icon counts what needs you or failed; Ready shows only in the title bar and rail.
    const urgent = badgeCount([...live.map((id) => attention[id]), ...currentMonitorAttention.map((entry) => entry.signal), ...Object.values(assistantTaskSignals)]);
    const grew = urgent > flagged.current;
    flagged.current = urgent;
    backend?.flagAttention(urgent, grew && !document.hasFocus()).catch(() => {});
  }, [attention, listed, currentMonitorAttention, assistantTaskSignals, backend]);

  // An approval left waiting for 2 minutes while the window is in the
  // background asks for Critical attention, once per card. Ready flags and
  // terminal flags never escalate.
  const escalated = useRef(new Set<string>());
  useEffect(() => {
    if (!backend) return;
    const threads = listed.filter((p) => p.kind === "chat" && attention[p.id]?.blocking).map((p) => openCards(p.id, approvalState));
    const due = dueEscalations(threads, escalated.current, document.hasFocus(), Date.now());
    if (due.length === 0) return;
    for (const card of due) escalated.current.add(escalationKey(card));
    backend.requestCriticalAttention().catch(() => {});
  }, [tick, attention, approvalState, listed, backend]);

  /** Every project gets an entry, so the sidebar can tell "no blocker" from "not loaded". */
  const monitorSignalsByWorkspace = Object.fromEntries(workspaces.map((workspace) => {
    const monitorSignal = currentMonitorAttention.find((entry) => entry.workspaceId === workspace.id)?.signal ?? null;
    const taskSignal = assistantTaskSignals[workspace.id] ?? null;
    const signal = taskSignal?.kind === "needs_input" || !monitorSignal ? taskSignal ?? monitorSignal : monitorSignal;
    return [workspace.id, { blocking: !!signal?.blocking, signal }];
  }));
  const attentionItems: (AttentionItem & { monitor?: ProjectMonitor })[] = [...listed
    .filter((pane) => attention[pane.id] && !pane.archived)
    .map((pane) => ({
      paneId: pane.id,
      title: pane.title,
      workspace: workspaces.find((w) => w.id === pane.workspaceId)?.name ?? "",
      where: pane.kind === "chat" ? "Threads" : "Code",
      program: programOf(pane),
      signal: attention[pane.id],
      cards: pane.kind === "chat" ? openCards(pane.id, approvalState) : undefined,
      hostName: hostNameFor(workspaces.find(w => w.id === pane.workspaceId)?.hostId ?? "local"),
      available: (() => { try { return !backendFor(pane).host || backendFor(pane).host!.connection.get().status.kind === "connected"; } catch { return false; } })(),
    })), ...currentMonitorAttention.map((entry) => {
      const workspace = workspaces.find((item) => item.id === entry.workspaceId)!;
      return {
        paneId: `apex-monitor:${entry.workspaceId}`,
        title: entry.monitor.responsibility || workspace.name,
        workspace: workspace.name,
        where: "Threads",
        signal: entry.signal,
        hostName: hostNameFor(entry.hostId),
        available: (() => { try { return reachable(entry.hostId); } catch { return false; } })(),
        monitor: entry.monitor,
      };
    }), ...Object.entries(assistantTaskSignals).flatMap(([workspaceId, signal]) => {
      const workspace = workspaces.find((item) => item.id === workspaceId && !item.hidden);
      return workspace ? [{
        paneId: `apex-task:${workspaceId}`,
        title: signal.note,
        workspace: workspace.name,
        where: "Threads" as const,
        signal,
        hostName: hostNameFor(workspaceHost(workspace)),
        available: (() => { try { return reachable(workspaceHost(workspace)); } catch { return false; } })(),
      }] : [];
    }), ...Object.entries(assistantTaskErrors).flatMap(([workspaceId, error]) => {
      const workspace = workspaces.find((item) => item.id === workspaceId && !item.hidden);
      return workspace ? [{
        paneId: `apex-task:${workspaceId}`,
        title: `ApexAgent tasks unavailable: ${error}`,
        workspace: workspace.name,
        where: "Threads" as const,
        signal: { kind: "failed" as const, note: "ApexAgent task status unavailable", at: Date.now() },
        hostName: hostNameFor(workspaceHost(workspace)),
        available: (() => { try { return reachable(workspaceHost(workspace)); } catch { return false; } })(),
      }] : [];
    })];
  /** What each section tab shows on hover: its waiting items, most urgent first. */
  const flagFor = (where: "Code" | "Threads"): SectionFlag => {
    const mine = attentionItems.filter((item) => item.where === where);
    return {
      ...summarize(mine.map((item) => item.signal)),
      rows: [...mine].sort((a, b) => urgency(a.signal.kind) - urgency(b.signal.kind) || b.signal.at - a.signal.at).map((item) => ({
        key: item.paneId,
        title: item.title,
        note: item.signal.note || label(item.signal.kind),
        meta: `${item.workspace} · ${item.where}`,
        kind: item.signal.kind,
        at: item.signal.at,
        paneId: item.paneId,
        cards: item.cards,
        hostName: item.hostName,
        available: item.available,
      })),
    };
  };
  const sectionFlags: Record<"agents" | "code" | "threads", SectionFlag> = {
    agents: {
      ...summarize(Object.values(assistantTaskSignals).filter((signal) => signal.kind === "needs_input")),
      rows: Object.entries(assistantTaskSignals).flatMap(([workspaceId, signal]) => {
        const workspace = workspaces.find((item) => item.id === workspaceId && !item.hidden);
        if (!workspace || signal.kind !== "needs_input") return [];
        return (assistantTaskNeedsDetails[workspaceId] ?? [signal.note]).map((detail, index) => ({ key: `${workspaceId}:${index}`, title: detail, note: "Needs you", meta: `${workspace.name} · Agents`, kind: "needs_input" as const, at: signal.at, paneId: `apex-task:${workspaceId}` }));
      }),
    },
    code: flagFor("Code"),
    threads: flagFor("Threads"),
  };

  /** Allow once / Deny from a section tab's hover list. */
  const decideApproval = async (room: string, request: string, approve: boolean) => {
    const pane = panes.find(p => p.id === room); const card = openCards(room).find(c => c.request === request);
    if (!pane || !card) throw new Error("That approval is no longer available.");
    const b = backendFor(pane);
    if ((card.hostId ?? "local") !== (b.host?.id ?? "local") || (card.action.expires_at != null && card.action.expires_at <= Date.now())) throw new Error("That approval is no longer available.");
    await b.roomDecide(room, request, approve, false);
  };

  /** Go to whatever a section tab's hover list names. */
  const openAttention = (paneId: string) => {
    if (paneId.startsWith("apex-monitor:")) { openApexAgent(paneId.slice("apex-monitor:".length), true); return; }
    if (paneId.startsWith("apex-task:")) { openApexAgent(paneId.slice("apex-task:".length), true); return; }
    const pane = viewPanes.find((p) => p.id === paneId); if (pane) focusPane(pane);
  };

  /** Take a pane off the deck. */
  const takeOff = (id: string) => {
    if (maximized === id) setMaximized(null);
    if (focusedPane === id) setFocusedPane(null);
  };

  /** × on a pane head. It never deletes: a thread is closed and stays in the rail. */
  const closePane = (id: string) => {
    if (viewPanes.find((pane) => pane.id === id && (pane as Pane & { assistantTaskId?: string }).assistantTaskId)) {
      setTaskPaneClosed(id, true);
      takeOff(id);
      return;
    }
    const pane = panes.find((p) => p.id === id);
    if (!pane) return;
    if (pane.kind === "chat") {
      setPanes((list) => list.map((p) => (p.id === id ? { ...p, closed: true } : p)));
      // The thread reports its server again when it is opened.
      forgetServer(id);
      takeOff(id);
      return;
    }
    const end = () => {
      setPanes((list) => list.filter((p) => p.id !== id));
      lastOutput.current.delete(id);
      forgetServer(id);
      runStart.current.delete(id);
      setRuns(({ [id]: _ended, ...rest }) => rest);
      setProgramTitles(({ [id]: _gone, ...rest }) => rest);
      setPreviewStatus(({ [id]: _shown, ...rest }) => rest);
      takeOff(id);
    };
    const status = statusOf(pane);
    if (closeNeedsConfirm(pane.kind, status)) setQuestion({ ...closeQuestion(pane.title, status), onConfirm: end });
    else end();
  };

  /** Delete a thread once the undo time runs out. Quitting before then keeps it. */
  const deleteThread = (pane: Pane) => {
    setQuestion({
      title: `Delete ${pane.title}?`,
      body: "Its messages, pins and temp files are removed. This can't be undone after a few seconds.",
      action: "Delete thread",
      onConfirm: () => {
        setDeleting((set) => new Set(set).add(pane.id));
        takeOff(pane.id);
        setUndoable({ id: pane.id, title: pane.title });
        deleteTimers.current.set(pane.id, setTimeout(async () => {
          deleteTimers.current.delete(pane.id);
          try {
            await backendFor(pane).roomDelete(pane.id);
            setPanes((list) => list.filter((p) => p.id !== pane.id));
          } catch (error) {
            setStorageError(`Could not delete ${pane.title}: ${String(error)}`);
          }
          setDeleting((set) => { const next = new Set(set); next.delete(pane.id); return next; });
          setUndoable((u) => (u?.id === pane.id ? null : u));
        }, UNDO_MS));
      },
    });
  };

  /** Delete a task's worker chat. The task and its result stay in Tasks; the host marks the chat deleted so it can't come back. */
  const deleteTaskThread = (pane: Pane) => {
    setQuestion({
      title: `Delete ${pane.title}?`,
      body: "The worker's chat is removed from every device and won't come back. The task and its result stay in Tasks. This can't be undone.",
      action: "Delete chat",
      onConfirm: () => {
        setDeleting((set) => new Set(set).add(pane.id));
        takeOff(pane.id);
        void (async () => {
          try {
            await backendFor(pane).roomDelete(pane.id);
            setTaskPaneClosed(pane.id, false);
            setTaskPaneTitle(pane.id, "");
            setAssistantRegistry((state) => ({ owners: Object.fromEntries(Object.entries(state.owners).map(([key, entry]) => {
              const { [pane.id]: _gone, ...rest } = entry.panes;
              return [key, { ...entry, panes: rest, tombstonedChildIds: [...new Set([...entry.tombstonedChildIds, pane.id])] }];
            })) }));
            toast(`Deleted ${pane.title}. Its task is still in Tasks.`);
          } catch (error) {
            setStorageError(`Could not delete ${pane.title}: ${String(error)}`);
          }
          setDeleting((set) => { const next = new Set(set); next.delete(pane.id); return next; });
        })();
      },
    });
  };

  const undoDelete = () => {
    if (!undoable) return;
    clearTimeout(deleteTimers.current.get(undoable.id));
    deleteTimers.current.delete(undoable.id);
    setDeleting((set) => { const next = new Set(set); next.delete(undoable.id); return next; });
    setUndoable(null);
  };

  /** Show a workspace's folder in Finder. */
  const revealWorkspace = (workspace: Workspace) => {
    try {
      const destination = backendFor({ workspaceId: workspace.id } as Pane);
      void destination.openTarget(workspace.path, null, true).catch(error => setStorageError(`Could not show ${workspace.name}: ${String(error)}`));
    } catch (error) { setStorageError(String(error)); }
  };

  /** The workspace and machine of a pane, for its menus. */
  const hostOfPane = (pane: Pane) => {
    const workspace = workspaces.find((w) => w.id === pane.workspaceId);
    return { workspace, hostId: (pane as Pane & { hostId?: string }).hostId ?? (workspace ? workspaceHost(workspace) : "local") };
  };
  /** Agents found on a pane's machine; a server's never borrow the Mac's. */
  const agentsOn = (hostId: string): AgentInfo[] => {
    if (hostId === "local" || !backend?.machines) return agents;
    try { return backend.machines.connection(hostId).get().agents; } catch { return []; }
  };
  /** Put text on the clipboard and say what happened; never claims a copy that didn't happen. */
  const copyOut = (text: string, kind: CopyKind) => {
    void writeClipboard(text, navigator.clipboard).then((ok) => toast(ok ? `Copied ${COPIED[kind]}.` : "Couldn't reach the clipboard, so nothing was copied."));
  };
  const onThreadCopy = useCallback((text: string, kind: "markdown" | "reply") => {
    if (!text) { toast("There's nothing to copy yet."); return; }
    copyOut(text, kind);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const copyFromThread = (pane: Pane, kind: CopyKind) => {
    const { workspace, hostId } = hostOfPane(pane);
    if (kind === "path") copyOut(folderCopyText(workspace?.path ?? "", hostId === "local" ? undefined : hostList.find((h) => h.id === hostId)?.ssh), "path");
    else if (kind === "id") copyOut(pane.id, "id");
    else {
      // The thread builds its own text, open or closed; it stays where it is.
      const id = `${++menuSeq.current}`;
      setThreadRequests((all) => ({ ...all, [pane.id]: { id, action: kind === "markdown" ? "copy_markdown" : "copy_reply" } }));
    }
  };
  /** Archive threads, take them off the deck, and offer Undo. */
  const archive = (list: Pane[], words: string) => {
    const ids = list.map((p) => p.id);
    if (ids.length === 0) return;
    setPanes((all) => archiveThreads(all, ids));
    for (const id of ids) { forgetServer(id); takeOff(id); }
    toast(words, () => setPanes((all) => unarchiveThreads(all, ids)));
  };
  const restoreArchived = (pane: Pane) => {
    setPanes((all) => unarchiveThreads(all, [pane.id]));
    focusPane({ ...pane, archived: undefined, closed: true });
  };

  /** Run what was chosen in a pane's ⋯ menu. */
  const runPaneMenu = (pane: Pane, action: PaneMenuAction, from: "rail" | "head" = "head") => {
    const bump = (all: Record<string, number>) => ({ ...all, [pane.id]: (all[pane.id] ?? 0) + 1 });
    if ((pane as Pane & { assistantTaskId?: string }).assistantTaskId) {
      // Host-owned task panes: only this Mac's view of them changes; the task and its result stay.
      if (action === "rename") { if (from === "rail") setRailRename(bump); else setRenameRequests(bump); }
      else if (action === "close") closePane(pane.id);
      else if (action === "open") focusPane(pane);
      else if (action === "delete") deleteTaskThread(pane);
      return;
    }
    if (action === "rename") {
      if (from === "rail") {
        // The row to rename is under its project unless it is pinned: make sure it's showing.
        if (!pane.pinned) setWorkspaces((list) => setCollapsed(list, pane.workspaceId, false));
        setRailRename(bump);
      } else setRenameRequests(bump);
    } else if (action === "pin") setPanes((list) => list.map((p) => (p.id === pane.id ? { ...p, pinned: p.pinned ? undefined : true } : p)));
    else if (action === "mark_unread") setPanes((list) => setUnread(list, pane.id, !pane.unread));
    else if (action === "start") setStartRequests(bump);
    else if (action === "copy_path") {
      const path = workspaces.find((w) => w.id === pane.workspaceId)?.path;
      if (path) copyOut(path, "path");
    } else if (action === "copy_address") {
      if (pane.url) void writeClipboard(pane.url, navigator.clipboard).then((ok) => toast(ok ? "Copied the address." : "Couldn't reach the clipboard, so nothing was copied."));
    } else if (action === "close") closePane(pane.id);
    else if (action === "fork" || action === "export" || action === "share_pdf") {
      if (pane.closed) focusPane(pane);
      const id = `${++menuSeq.current}`;
      setThreadRequests((all) => ({ ...all, [pane.id]: { id, action } }));
    } else if (action === "archive") archive([pane], `Archived ${pane.title}.`);
    else if (action === "delete") deleteThread(pane);
  };

  /** A pane's ⋯ menu, on its head or its sidebar row. */
  const paneMenuEntries = (pane: Pane, from: "rail" | "head"): MenuEntry[] => {
    const taskId = (pane as Pane & { assistantTaskId?: string }).assistantTaskId;
    if (taskId) {
      const status = assistantTaskStatuses[`${pane.workspaceId}\u0000${taskId}`];
      const finished = status === "done" || status === "cancelled";
      return [
        pane.closed
          ? { key: "open", label: "Reopen", onSelect: () => runPaneMenu(pane, "open", from) }
          : { key: "close", label: "Close", onSelect: () => runPaneMenu(pane, "close", from) },
        { key: "rename", label: "Rename", onSelect: () => runPaneMenu(pane, "rename", from) },
        { key: "delete", label: "Delete", danger: true, separated: true, disabled: !finished,
          reason: finished ? undefined : status ? "This task is still going. Stop it in Tasks first, then delete its chat." : "Still loading this task's status.",
          onSelect: () => runPaneMenu(pane, "delete", from) },
      ];
    }
    const { workspace, hostId } = hostOfPane(pane);
    const found = agentsOn(hostId);
    const items = paneMenuItems(pane.kind, { running: isRunning(runs[pane.id]), installed: toolInstalled(pane.agent, found), tool: toolName(pane.agent, found), folder: workspace?.path ?? "" }, { address: pane.url ?? "" }, { pinned: pane.pinned, unread: pane.unread, mac: isMac });
    const ssh = hostId === "local" ? undefined : hostList.find((h) => h.id === hostId)?.ssh;
    return items.map((item) => ({
      key: item.action, label: item.label, disabled: item.disabled, reason: item.reason, danger: item.danger, separated: item.separated, keys: item.keys,
      submenu: item.action === "project" ? projectEntries(pane)
        : item.submenu ? copyMenuItems({ hasReply: !!threadStatus[pane.id]?.hasReply, path: folderCopyText(workspace?.path ?? "", ssh), id: pane.id })
          .map((c) => ({ key: c.kind, label: c.label, side: c.side, disabled: c.disabled, reason: c.reason, onSelect: () => copyFromThread(pane, c.kind) })) : undefined,
      onSelect: item.submenu ? undefined : () => runPaneMenu(pane, item.action, from),
    }));
  };

  /** Whether a thread has started; one that hasn't reported yet counts by its saved activity. */
  const startedOf = (pane: Pane) => threadStatus[pane.id]?.started ?? Boolean(pane.activeAt);
  /** A host's backend by id: the Mac's own, or a saved server's. */
  const hostBackend = (hostId: string): Backend => {
    if (!backend) throw new Error("The backend is not ready yet.");
    if (hostId === "local") return backend;
    if (!backend.machines) throw new Error("This server is unavailable.");
    return backend.machines.get(hostId);
  };
  const monitorVersion = (key: string, signature: string, hostId: string) => {
    let route: Backend | undefined, connection: unknown, status: unknown, revision: number | undefined;
    try {
      const ownerBackend = hostBackend(hostId);
      route = ownerBackend;
      connection = ownerBackend.host?.connection;
      const current = ownerBackend.host?.connection.get();
      status = current?.status;
      revision = current?.revision;
    } catch { /* Unavailable routes still get an epoch that changes with their binding. */ }
    const previous = monitorVersions.current.get(key);
    if (!previous || previous.signature !== signature || previous.backend !== route || previous.connection !== connection || previous.status !== status || previous.revision !== revision) {
      const version = ++monitorVersionSequence.current;
      monitorVersions.current.set(key, { signature, backend: route, connection, status, revision, version });
      return version;
    }
    return previous.version;
  };
  const monitorOwnerVersion = (workspaceId: string) => {
    const workspace = latest.current.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return monitorVersion(`workspace:${workspaceId}`, "removed", "local");
    const hostId = workspaceHost(workspace);
    return monitorVersion(`workspace:${workspaceId}`, JSON.stringify([workspace.id, hostId, workspace.path]), hostId);
  };
  const monitorHostVersion = (hostId: string) => {
    const bindings = latest.current.workspaces
      .filter((workspace) => workspaceHost(workspace) === hostId)
      .map((workspace) => [workspace.id, workspace.path])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
    return monitorVersion(`host:${hostId}`, JSON.stringify(bindings), hostId);
  };
  /** An ApexAgent snapshot counts only while its project keeps the folder, host and connection it was rendered with. */
  const guardedMonitorChange = (owner: { workspaceId: string; hostId: string; cwd: string; version: number; conversationId?: string }) =>
    (workspaceId: string, hostId: string, monitor: ProjectMonitor | null) => {
      if (workspaceId !== owner.workspaceId || hostId !== owner.hostId) return;
      if (monitor && (monitor.workspaceId !== workspaceId || monitor.hostId !== hostId || monitor.cwd !== owner.cwd)) return;
      const workspace = latest.current.workspaces.find((item) => item.id === workspaceId);
      if (!workspace || workspaceHost(workspace) !== hostId || workspace.path !== owner.cwd) return;
      if (monitorOwnerVersion(workspaceId) !== owner.version) return;
      setMonitorAttention((state) => {
        const existing = Object.values(state).find((entry) => entry.workspaceId === workspaceId && entry.hostId === hostId && entry.monitor.cwd === owner.cwd)?.monitor;
        if (owner.conversationId && existing && existing.conversationId !== owner.conversationId) return state;
        return withMonitorSnapshot(state, workspaceId, hostId, monitor, owner.cwd);
      });
    };
  /** A host's full monitor list replaces only that host's entries, and only if its projects haven't moved since the poll began. */
  const acceptHostMonitors = (version: number) => (hostId: string, monitors: ProjectMonitor[]) => {
    if (monitorHostVersion(hostId) !== version) return;
    setMonitorAttention((state) => reconcileMonitorHost(state, hostId, monitors, latest.current.workspaces));
  };
  // Child execution panes belong to each project host's task registry, never
  // the Mac-owned AppSession. Keep them in a view-only projection.
  useEffect(() => {
    if (!backend) return;
    let live = true;
    const versions = new Map<string, number>();
    const projects = workspaces.filter((workspace) => !workspace.hidden);
    const refresh = async (workspace: Workspace) => {
      const workspaceId = workspace.id;
      const ownerVersion = monitorOwnerVersion(workspaceId);
      const hostId = workspaceHost(workspace);
      let route: Backend;
      try { route = hostBackend(hostId); } catch { return; }
      const version = (versions.get(workspaceId) ?? 0) + 1;
      versions.set(workspaceId, version);
      const current = () => {
        const latestWorkspace = latest.current.workspaces.find((item) => item.id === workspaceId);
        return live && versions.get(workspaceId) === version && !!latestWorkspace && !latestWorkspace.hidden
          && latestWorkspace.path === workspace.path && workspaceHost(latestWorkspace) === hostId
          && monitorOwnerVersion(workspaceId) === ownerVersion && hostBackend(hostId) === route;
      };
      try {
        const monitor = await route.call<ProjectMonitor | null>("monitor_get", { workspaceId });
        if (!current()) return;
        if (monitor && (monitor.workspaceId !== workspaceId || monitor.hostId !== hostId || monitor.cwd !== workspace.path))
          throw new Error("ApexAgent returned an assignment for a different project folder or machine.");
        if (!monitor) {
          setAssistantTaskCounts((all) => { const { [workspaceId]: _old, ...rest } = all; return rest; });
          setAssistantOwners((all) => { const { [workspaceId]: _old, ...rest } = all; return rest; });
          setAssistantTaskSignals((all) => { const { [workspaceId]: _old, ...rest } = all; return rest; });
          setAssistantTaskNeedsDetails((all) => { const { [workspaceId]: _old, ...rest } = all; return rest; });
          setAssistantTaskErrors((all) => { const { [workspaceId]: _old, ...rest } = all; return rest; });
          return;
        }
        const owner: AssistantTaskOwner = { workspaceId, cwd: monitor.cwd, hostId, conversationId: monitor.conversationId };
        setAssistantOwners((all) => JSON.stringify(all[workspaceId]) === JSON.stringify(owner) ? all : { ...all, [workspaceId]: owner });
        const snapshot = await route.call<AssistantTaskSnapshot>("assistant_tasks_list", { owner });
        if (!current()) return;
        setAssistantRegistry((state) => reduceAssistantSnapshot(state, owner, snapshot));
        setAssistantTaskStatuses((all) => {
          const next = Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith(`${workspaceId}\u0000`)));
          for (const task of snapshot.tasks) next[`${workspaceId}\u0000${task.id}`] = task.status;
          return JSON.stringify(next) === JSON.stringify(all) ? all : next;
        });
        const signal = assistantTaskAttentionSignal(snapshot.tasks, owner);
        setAssistantTaskNeedsDetails((all) => {
          const details = snapshot.tasks
            .filter((task) => task.owner.conversationId === owner.conversationId && ["needs_you", "needs_clarification", "proposed"].includes(task.status))
            .map((task) => `${task.status === "proposed" ? "Proposed" : task.status === "needs_clarification" ? "Needs clarification" : "Needs you"}: ${(task.originalRequest || task.brief).slice(0, 120)}`);
          if (JSON.stringify(all[workspaceId] ?? []) === JSON.stringify(details)) return all;
          const next = { ...all };
          if (details.length) next[workspaceId] = details; else delete next[workspaceId];
          return next;
        });
        setAssistantTaskCounts((all) => ({ ...all, [workspaceId]: snapshot.tasks.filter((task) => ['proposed','needs_clarification','needs_you','ready_for_review','failed','interrupted'].includes(task.status)).length }));
        setAssistantTaskSignals((all) => {
          if (!signal && !(workspaceId in all)) return all;
          if (signal && JSON.stringify(all[workspaceId]) === JSON.stringify(signal)) return all;
          const next = { ...all };
          if (signal) next[workspaceId] = signal; else delete next[workspaceId];
          return next;
        });
        setAssistantTaskErrors((all) => { const { [workspaceId]: _old, ...rest } = all; return rest; });
      } catch (error) {
        if (current()) setAssistantTaskErrors((all) => ({ ...all, [workspaceId]: String(error) }));
      }
    };
    projects.forEach((workspace) => { void refresh(workspace); });
    const stops: (() => void)[] = [];
    const hostIds = [...new Set(projects.map(workspaceHost))];
    for (const hostId of hostIds) {
      let route: Backend;
      try { route = hostBackend(hostId); } catch { continue; }
      if (!route.onAssistantTasksChanged) continue;
      const owned = projects.filter((workspace) => workspaceHost(workspace) === hostId);
      void route.onAssistantTasksChanged((payload) => {
        if (!live) return;
        const changed = payload as { workspaceId?: string } | null;
        owned.filter((workspace) => !changed?.workspaceId || changed.workspaceId === workspace.id)
          .forEach((workspace) => { void refresh(workspace); });
      }).then((stop) => { if (live) stops.push(stop); else stop(); }).catch(() => {});
    }
    const timer = window.setInterval(() => projects.forEach((workspace) => { void refresh(workspace); }), 30_000);
    return () => { live = false; clearInterval(timer); stops.forEach((stop) => stop()); };
  }, [backend, workspaces, hostList]);
  /** Source saves and bubble replies keep the assignment they began with, even while the widget switches projects. */
  const mutateAssistant = async (workspaceId: string, command: string, args: Record<string, unknown>) => {
    const workspace = latest.current.workspaces.find((item) => item.id === workspaceId && !item.hidden);
    if (!workspace) throw new Error("That project is no longer available.");
    const hostId = workspaceHost(workspace);
    const route = hostBackend(hostId);
    const version = monitorOwnerVersion(workspaceId);
    const saved = Object.values(monitorAttention).find((entry) => entry.workspaceId === workspaceId && entry.hostId === hostId && entry.monitor.cwd === workspace.path)?.monitor;
    if (!saved) { openApexAgentProject(workspaceId); throw new Error("Give ApexAgent a responsibility before adding sources or replying."); }
    const result = await route.call<ProjectMonitor>(command, {
      workspaceId, cwd: workspace.path, hostId, conversationId: saved.conversationId, ...args,
    });
    const confirmed = await route.call<ProjectMonitor | null>('monitor_get', { workspaceId });
    const current = latest.current.workspaces.find((item) => item.id === workspaceId);
    if (!current || current.hidden || current.path !== workspace.path || workspaceHost(current) !== hostId || monitorOwnerVersion(workspaceId) !== version || hostBackend(hostId) !== route) {
      throw new Error("The project or connection changed while saving. Reopen ApexAgent to check its sources.");
    }
    if (!result || !confirmed || result.workspaceId !== workspaceId || result.hostId !== hostId || result.cwd !== workspace.path || result.conversationId !== saved.conversationId || confirmed.workspaceId !== workspaceId || confirmed.hostId !== hostId || confirmed.cwd !== workspace.path || confirmed.conversationId !== saved.conversationId) {
      throw new Error("ApexAgent returned a different assignment. Reopen its conversation.");
    }
    guardedMonitorChange({ workspaceId, hostId, cwd: workspace.path, version, conversationId: saved.conversationId })(workspaceId, hostId, confirmed);
  };
  const replyToAssistant = async (workspaceId: string, text: string, expectedRequest?: PendingAssistantRequest) => {
    const workspace = latest.current.workspaces.find((item) => item.id === workspaceId && !item.hidden);
    if (!workspace) throw new Error("That project is no longer available.");
    const hostId = workspaceHost(workspace);
    const route = hostBackend(hostId);
    const version = monitorOwnerVersion(workspaceId);
    const currentBinding = () => {
      const current = latest.current.workspaces.find((item) => item.id === workspaceId);
      return !!current && !current.hidden && current.path === workspace.path && workspaceHost(current) === hostId
        && monitorOwnerVersion(workspaceId) === version && hostBackend(hostId) === route;
    };
    const monitor = await route.call<ProjectMonitor | null>("monitor_get", { workspaceId });
    if (!currentBinding() || !monitor || monitor.workspaceId !== workspaceId || monitor.hostId !== hostId || monitor.cwd !== workspace.path) throw new Error("Reopen ApexAgent to check its assignment.");
    const owner: AssistantTaskOwner = { workspaceId, hostId, cwd: workspace.path, conversationId: monitor.conversationId };
    const existing = loadPendingRequest(localStorage, owner);
    if (expectedRequest && (!existing || existing.requestId !== expectedRequest.requestId
      || overviewOwnerKey(owner) !== overviewOwnerKey(expectedRequest.owner))) throw new Error("The saved request or project assignment changed. Reopen ApexAgent before retrying.");
    if (existing && existing.text !== text) throw new Error("A previous request is awaiting confirmation. Reopen ApexAgent to retry or discard it first.");
    const threadLabels = latest.current.panes.filter((pane) => pane.workspaceId === workspaceId && pane.kind === 'chat').map((pane) => ({ id: pane.id, label: pane.title }));
    const pending: PendingAssistantRequest = existing ?? { requestId: crypto.randomUUID(), owner, text, destination: null, newWorkerProfiles: [], mode: 'in_place', checks: [], threadLabels };
    savePendingRequest(localStorage, pending, owner);
    assistantSending.current.add(pending.requestId); refreshAssistantRequests((version) => version + 1);
    try {
      const result = await route.call<{ monitor: ProjectMonitor }>("assistant_message", assistantMessageArgs(owner, pending, threadLabels));
      const sameAssignment = (value: ProjectMonitor | null | undefined) => !!value && value.workspaceId === workspaceId
        && value.cwd === owner.cwd && value.hostId === owner.hostId && value.conversationId === owner.conversationId;
      if (!currentBinding() || !sameAssignment(result?.monitor)) throw new Error("The project assignment changed while sending. Reopen ApexAgent to confirm the reply.");
      // A reply may complete after reassignment on another device. Confirm the
      // live owner before acknowledging this durable request or painting its reply.
      const confirmed = await route.call<ProjectMonitor | null>("monitor_get", { workspaceId });
      if (!currentBinding() || !sameAssignment(confirmed)) throw new Error("The project assignment changed while sending. Reopen ApexAgent to confirm the reply.");
      guardedMonitorChange({ workspaceId, hostId, cwd: workspace.path, version })(workspaceId, hostId, confirmed);
      if (loadPendingRequest(localStorage, owner)?.requestId === pending.requestId) clearPendingRequest(localStorage, owner);
    } finally { assistantSending.current.delete(pending.requestId); refreshAssistantRequests((version) => version + 1); }
  };
  const openAssistantEvidence = async (workspaceId: string, evidence: MonitorEvidence) => {
    const workspace = latest.current.workspaces.find((item) => item.id === workspaceId && !item.hidden);
    if (!workspace) throw new Error("That project is no longer available.");
    const thread = latest.current.panes.find((pane) => pane.workspaceId === workspaceId && pane.kind === 'chat' && pane.id === evidence.sourceId.replace(/^thread:/, ''));
    if (thread) { focusPane(thread); return; }
    if (evidence.sourceId.startsWith('thread:')) throw new Error("That source thread is no longer available in this project.");
    const source = evidence.sourceId.replace(/^file:/, '');
    if (!evidence.sourceId.startsWith('git:') && (!source || source.startsWith('/') || source.split(/[\\/]/).some((part) => part === '..') || /^[a-zA-Z]:/.test(source))) throw new Error("That evidence path is outside the project.");
    await hostBackend(workspaceHost(workspace)).openTarget(evidence.sourceId.startsWith('git:') ? workspace.path : source, workspace.path || null, false);
  };
  const updateHandoffBatches = (batches: HandoffBatch[]) => {
    saveHandoffBatches(localStorage, batches);
    handoffHistory.current = batches; setHandoffBatches(batches);
  };
  const prepareHandoffBatch = async (batchId: string) => {
    if (handoffBusy.current.has(batchId)) return;
    handoffBusy.current.add(batchId); setHandoffWorking([...handoffBusy.current]);
    try {
      const batch = handoffHistory.current.find((item) => item.id === batchId);
      if (!batch) throw new Error('The handoff plan is unavailable.');
      for (let index = 0; index < batch.children.length; index++) {
        const child = handoffHistory.current.find((item) => item.id === batchId)!.children[index];
        if (child.status === 'proposed' || child.status === 'failed') continue;
        const owner = child.payload.owner;
        let status: HandoffBatch['children'][number]['status'] = 'uncertain'; let error = ''; let taskId: string | undefined;
        try {
          const workspace = latest.current.workspaces.find((item) => item.id === owner.workspaceId && !item.hidden);
          if (!workspace || workspace.path !== owner.cwd || workspaceHost(workspace) !== owner.hostId) { status = 'failed'; throw new Error('The project owner changed. Reconfirm this work.'); }
          if (!reachable(owner.hostId)) { status = 'offline'; throw new Error('Project machine is offline. Reconnect, then retry this saved proposal.'); }
          const route = hostBackend(owner.hostId), version = monitorOwnerVersion(owner.workspaceId);
          const bound = () => {
            const current = latest.current.workspaces.find((item) => item.id === owner.workspaceId && !item.hidden);
            return current && current.path === owner.cwd && workspaceHost(current) === owner.hostId
              && monitorOwnerVersion(owner.workspaceId) === version && reachable(owner.hostId) && hostBackend(owner.hostId) === route;
          };
          const monitor = await route.call<ProjectMonitor | null>('monitor_get', { workspaceId: owner.workspaceId });
          if (!bound() || !monitor || overviewOwnerKey(overviewOwner(monitor)) !== overviewOwnerKey(owner)) { status = 'failed'; throw new Error('The assignment or connection changed. Reconfirm this work.'); }
          // The destination host reconciles the request receipt before checking a stale revision.
          const receipt = await route.call<{ task: AssistantTask }>('assistant_handoff_prepare', { ...handoffPreparationArgs(child, overviewOwner(monitor)) });
          if (!bound() || !receipt.task || overviewOwnerKey(receipt.task.owner) !== overviewOwnerKey(owner)) throw new Error('The preparation reply is uncertain. Retry the saved proposal.');
          status = 'proposed'; taskId = receipt.task.id;
        } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
        updateHandoffBatches(handoffHistory.current.map((item) => item.id !== batchId ? item : { ...item, children: item.children.map((saved, childIndex) => childIndex !== index ? saved : { ...saved, status, error, taskId }) }));
      }
    } finally { handoffBusy.current.delete(batchId); setHandoffWorking([...handoffBusy.current]); }
  };
  const replyAcrossProjects = async (text: string) => {
    const startedAt = Date.now();
    const captured = assistantMonitors.map((monitor) => {
      const workspace = latest.current.workspaces.find((item) => item.id === monitor.workspaceId && !item.hidden)!;
      const offline = !reachable(monitor.hostId);
      return { monitor, workspace, offline, route: offline ? null : hostBackend(monitor.hostId), version: monitorOwnerVersion(workspace.id) };
    });
    const stillBound = () => captured.every(({ monitor, workspace, route, version }) => {
      const current = latest.current.workspaces.find((item) => item.id === workspace.id && !item.hidden);
      return !!current && current.path === monitor.cwd && workspaceHost(current) === monitor.hostId
        && monitorOwnerVersion(workspace.id) === version && (!route || hostBackend(monitor.hostId) === route);
    });
    const snapshots = await Promise.all(captured.map(async (item) => {
      if (!item.route) return item.monitor;
      const current = await item.route.call<ProjectMonitor | null>('monitor_get', { workspaceId: item.workspace.id });
      if (!current || overviewOwnerKey(overviewOwner(current)) !== overviewOwnerKey(overviewOwner(item.monitor))) throw new Error("A project assignment changed. Reopen ApexAgent.");
      return current;
    }));
    if (!stillBound()) throw new Error("A project or connection changed. Reopen ApexAgent.");
    const coordinatorIndex = captured.findIndex((item) => !!item.route);
    if (coordinatorIndex < 0) throw new Error("All project machines are offline. Reconnect one to ask ApexAgent.");
    const coordinator = captured[coordinatorIndex];
    const taskSnapshots = await Promise.all(captured.map(async (item, index) => {
      if (!item.route) return undefined;
      try {
        const owner = overviewOwner(snapshots[index]);
        const snapshot = await item.route.call<AssistantTaskSnapshot>('assistant_tasks_list', { owner });
        assistantTasksForOwner(snapshot, owner);
        return snapshot;
      } catch { return undefined; }
    }));
    if (!stillBound()) throw new Error("A project or connection changed. Reopen ApexAgent.");
    const projects = snapshots.map((monitor, index) => ({ ...overviewProject(monitor, captured[index].workspace.name, captured[index].offline, taskSnapshots[index]?.tasks), routingThreads: overviewRouting(taskSnapshots[index]) }));
    const history = visibleOverviewEntries(overviewHistory.current, snapshots).slice(-20).map((entry) => ({ role: entry.message.role, text: entry.message.text }));
    const result = await coordinator.route!.call<{ message: string; citations: OverviewEntry['citations']; assignments?: HandoffAssignment[]; clarification?: string }>('assistant_overview', { owner: overviewOwner(snapshots[coordinatorIndex]), text, projects, history });
    // Revalidate every live assignment after the tool-free synthesis, not just the coordinator.
    await Promise.all(captured.map(async (item) => {
      if (!item.route) return;
      const current = await item.route.call<ProjectMonitor | null>('monitor_get', { workspaceId: item.workspace.id });
      if (!current || current.revision !== snapshots[captured.indexOf(item)].revision || overviewOwnerKey(overviewOwner(current)) !== overviewOwnerKey(overviewOwner(item.monitor))) throw new Error("A project assignment changed while answering. Ask again.");
    }));
    if (!stillBound() || typeof result?.message !== 'string') throw new Error("The project context changed while answering. Ask again.");
    const batch = handoffBatch(crypto.randomUUID(), text, result.assignments ?? [], projects);
    if (batch.children.length) {
      // Persist the exact IDs and payloads before any host mutation, including uncertain replies.
      updateHandoffBatches([...handoffHistory.current, batch]);
    }
    const owners = snapshots.map(overviewOwner);
    const added: OverviewEntry[] = [
      { workspaceId: '*', project: 'All projects', owners, message: { id: crypto.randomUUID(), role: 'human', text, at: startedAt, evidence: [] } },
      { workspaceId: '*', project: 'All projects', owners, citations: result.citations, message: { id: crypto.randomUUID(), role: 'assistant', text: result.clarification ? `${result.message}\n${result.clarification}` : result.message, at: Date.now(), evidence: [] } },
    ];
    setOverviewEntries((previous) => { const next = [...previous, ...added].slice(-100); try { localStorage.setItem('apex-agent-overview-history', JSON.stringify(next)); } catch { /* Keep this window's conversation when storage is unavailable. */ } return next; });
    if (batch.children.length) await prepareHandoffBatch(batch.id);
  };
  const addAssistantSource = async (payload: AssistantSourceDrop) => {
    const workspace = latest.current.workspaces.find((item) => item.id === payload.workspaceId && !item.hidden);
    if (!workspace || workspaceHost(workspace) !== payload.hostId || workspace.path !== payload.cwd) throw new Error("That source belongs to a different project folder or machine.");
    if (payload.kind !== "file" && payload.kind !== "thread") throw new Error("Drop a project file or chat onto ApexAgent.");
    if (payload.kind === "thread" && !latest.current.panes.some((pane) => pane.id === payload.sourceId && pane.kind === "chat" && pane.workspaceId === workspace.id)) throw new Error("That chat belongs to a different project.");
    await mutateAssistant(workspace.id, "monitor_sources_update", {
      mode: "add", files: payload.kind === "file" ? [payload.sourceId] : [], threads: payload.kind === "thread" ? [payload.sourceId] : [],
    });
  };
  /** Whether a machine can take work now. */
  const reachable = (hostId: string) => {
    if (hostId === "local" || !backend?.machines) return true;
    try { return backend.machines.connection(hostId).get().status.kind === "connected"; } catch { return false; }
  };
  /** Gray in the lists: it dropped or failed. A server not used yet this session isn't offline. */
  const offlineHost = (hostId: string) => {
    if (hostId === "local" || !backend?.machines) return false;
    try { return dotState(backend.machines.connection(hostId).get().status) === "off"; } catch { return true; }
  };
  // The personal assistant on its durable host; polled only while the conversation is open.
  const personal = usePersonalAssistant({ hosts: hostList, hostBackend, offlineHost, open: apexAgentAllOpen, bridge: true });
  const reactToAssistant = async (workspaceId: string, messageId: string, emoji: string, enabled: boolean) => {
    if (workspaceId === 'personal') {
      if (!personal) throw new Error('The personal assistant is unavailable.');
      await personal.react(messageId, emoji, enabled);
      return;
    }
    try { await mutateAssistant(workspaceId, 'monitor_react', { messageId, emoji, enabled }); }
    catch (error) {
      if (unsupported(error, 'monitor_react')) throw new Error('This host does not support saved ApexAgent reactions. Update its service to use reactions here.');
      throw error;
    }
  };
  const saveAssistantAttachment = async (laneId: string, name: string, bytes: Uint8Array) => {
    if (laneId === 'personal') {
      const assistant = personal?.assistant;
      if (!assistant || personal!.offline) throw new Error('The personal assistant host is unavailable.');
      return personal!.saveAttachment(name, bytes);
    }
    const workspace = latest.current.workspaces.find((item) => item.id === laneId && !item.hidden);
    const monitor = assistantMonitors.find((item) => item.workspaceId === laneId);
    if (!workspace || !monitor || workspace.path !== monitor.cwd || workspaceHost(workspace) !== monitor.hostId) throw new Error('That ApexAgent project lane changed.');
    const route = hostBackend(monitor.hostId);
    const current = await route.call<ProjectMonitor | null>('monitor_get', { workspaceId: laneId });
    if (!current || current.cwd !== monitor.cwd || current.hostId !== monitor.hostId || current.conversationId !== monitor.conversationId) throw new Error('That ApexAgent project assignment changed.');
    const path = await route.saveAttachment(monitor.conversationId, name, bytes);
    const afterSave = await route.call<ProjectMonitor | null>('monitor_get', { workspaceId: laneId });
    const latestWorkspace = latest.current.workspaces.find((item) => item.id === laneId && !item.hidden);
    if (!afterSave || afterSave.cwd !== monitor.cwd || afterSave.hostId !== monitor.hostId || afterSave.conversationId !== monitor.conversationId || !latestWorkspace || latestWorkspace.path !== monitor.cwd || workspaceHost(latestWorkspace) !== monitor.hostId) throw new Error('The project changed while saving. Reopen ApexAgent to check the attachment.');
    return path;
  };
  const pickAssistantAttachmentFolder = async (laneId: string) => {
    if (laneId === 'personal') {
      if (!personal?.assistant || personal.offline) throw new Error('The personal assistant host is unavailable.');
      return personal.pickFolder();
    }
    const monitor = assistantMonitors.find((item) => item.workspaceId === laneId);
    if (!monitor) throw new Error('That ApexAgent project lane changed.');
    const route = hostBackend(monitor.hostId);
    const current = await route.call<ProjectMonitor | null>('monitor_get', { workspaceId: laneId });
    if (!current || current.cwd !== monitor.cwd || current.hostId !== monitor.hostId || current.conversationId !== monitor.conversationId) throw new Error('That ApexAgent project assignment changed.');
    const selectedPath = await route.pickFolder();
    if (!selectedPath) return null;
    const latestWorkspace = latest.current.workspaces.find((item) => item.id === laneId && !item.hidden);
    const afterPicker = await route.call<ProjectMonitor | null>('monitor_get', { workspaceId: laneId });
    if (!afterPicker || afterPicker.cwd !== monitor.cwd || afterPicker.hostId !== monitor.hostId || afterPicker.conversationId !== monitor.conversationId || !latestWorkspace || latestWorkspace.path !== monitor.cwd || workspaceHost(latestWorkspace) !== monitor.hostId) throw new Error('That project changed while choosing a folder. Reopen ApexAgent.');
    const path = await route.copyAttachment(monitor.conversationId, selectedPath);
    const afterPick = await route.call<ProjectMonitor | null>('monitor_get', { workspaceId: laneId });
    if (!afterPick || afterPick.cwd !== monitor.cwd || afterPick.hostId !== monitor.hostId || afterPick.conversationId !== monitor.conversationId) throw new Error('The project changed while choosing a folder. Reopen ApexAgent.');
    return path;
  };
  /** A thread's history and bots, read from where it runs now. */
  const snapshotOf = async (pane: Pane, workspace: Workspace) =>
    (await loadRoomState(hostBackend(workspaceHost(workspace)), pane.id, [], settings.newThread, workspace.path)).snapshot;
  /** Point a thread at another project: an unstarted one moves there, a started one asks first. */
  const choose = (pane: Pane, target: Workspace) => {
    const outcome = chooseOutcome(pane.workspaceId, target.id, startedOf(pane));
    if (outcome === "move") void moveDraft(pane, target);
    else if (outcome === "ask") { setMoveAsk({ paneId: pane.id, to: target }); focusPane(pane); }
  };
  /** Move a thread that hasn't started, with what was typed and its bots, to `target`. */
  const moveDraft = async (pane: Pane, target: Workspace) => {
    const source = latest.current.workspaces.find((w) => w.id === pane.workspaceId);
    if (!source || moving.current.has(pane.id)) return;
    const [fromHost, toHost] = [workspaceHost(source), workspaceHost(target)];
    if (!reachable(toHost)) { toast(`Can't reach ${hostNameFor(toHost)}, so ${pane.title} stays where it is.`); return; }
    if (!reachable(fromHost)) { toast(`Can't reach ${hostNameFor(fromHost)} to bring ${pane.title} over. Try again once it's back.`); return; }
    moving.current.add(pane.id);
    try {
      const snapshot = await snapshotOf(pane, source);
      await placeThread({ from: hostBackend(fromHost), to: hostBackend(toHost), id: pane.id, snapshot, cwd: target.path, sameHost: fromHost === toHost, hostName: hostNameFor(toHost) });
      setPanes((list) => list.map((p) => (p.id === pane.id ? { ...p, workspaceId: target.id } : p)));
      setMoveAsk((ask) => (ask?.paneId === pane.id ? null : ask));
      setActiveWorkspace(target.id);
    } catch (error) {
      if (error instanceof MoveRefused) { setMoveAsk({ paneId: pane.id, to: target, why: error.message }); focusPane(pane); }
      else toast(`Couldn't move ${pane.title}: ${String(error).replace(/^Error: /, "")}`);
    } finally {
      moving.current.delete(pane.id);
    }
  };
  /** Fork a thread into another project, on this machine or another: the history comes too, nothing runs until Send. */
  const forkTo = async (source: Pane, target: Workspace) => {
    const from = latest.current.workspaces.find((w) => w.id === source.workspaceId);
    if (!from) return;
    const [fromHost, toHost] = [workspaceHost(from), workspaceHost(target)];
    if (!reachable(toHost)) { toast(`Can't reach ${hostNameFor(toHost)}, so nothing was forked.`); return; }
    if (!reachable(fromHost)) { toast(`Can't reach ${hostNameFor(fromHost)} to read ${source.title}'s history.`); return; }
    try {
      const snapshot = await snapshotOf(source, from);
      const id = newId("pane");
      await hostBackend(toHost).roomImport(id, snapshot, target.path);
      const crossed = fromHost !== toHost && historyHasAttachments(snapshot.transcript);
      const fork = { from: source.id, title: source.title, host: hostNameFor(fromHost), at: snapshot.transcript.length, ...(crossed ? { crossed: true as const } : {}) };
      setPanes((list) => [...list, { id, workspaceId: target.id, kind: "chat", title: `${source.title} (fork)`, fork }]);
      setActiveWorkspace(target.id);
      setFocusedPane(id);
      setSection("threads");
      setMaximized(null);
    } catch (error) {
      toast(unsupported(error, "room_import")
        ? `${hostNameFor(toHost)}'s apex-daemon is too old to take a fork from another place. Update it there (docs/daemon-ubuntu.md).`
        : `Couldn't fork ${source.title}: ${String(error).replace(/^Error: /, "")}`);
    }
  };
  /** Pick a folder on a machine and list it as a project there. Resolves with that project, or null if cancelled. */
  const projectOn = async (hostId: string, title: string, name?: string, family?: string): Promise<Workspace | null> => {
    const path = await hostBackend(hostId).pickPath("directory", title);
    if (!path) return null;
    const nameOf = (p: string) => name ?? folderName(p);
    const made = addFolders(latest.current.workspaces, [path], () => newId("ws"), nameOf, hostId, family);
    const id = made.ids[0];
    // Merged into the newest list: a background import may have landed while the picker was open.
    setWorkspaces((list) => addFolders(list, [path], () => id, nameOf, hostId, family).list);
    return made.list.find((w) => w.id === id) ?? null;
  };
  /** The Work bar of one thread: its project, every place it could run, and the actions there. */
  const tints = useMemo(() => hostTints(hostList.filter((h) => h.remote).map((h) => h.id)), [hostList]);
  // Redraw when any server connects or drops, so Work in, the picker and Project › never show a stale state.
  const serverIds = hostList.filter((h) => h.remote).map((h) => h.id).join(",");
  const subscribeServers = useCallback((changed: () => void) => {
    const offs = serverIds ? serverIds.split(",").map((id) => { try { return backend?.machines?.connection(id).subscribe(changed) ?? (() => {}); } catch { return () => {}; } }) : [];
    return () => offs.forEach((off) => off());
  }, [backend, serverIds]);
  useSyncExternalStore(subscribeServers, () => (serverIds ? serverIds.split(",").map((id) => { try { return backend?.machines?.connection(id).get().status.kind; } catch { return "gone"; } }).join(",") : ""));
  const workFor = (pane: Pane): WorkContext | undefined => {
    const here = workspaces.find((w) => w.id === pane.workspaceId);
    if (!here || !backend) return undefined;
    const hostId = workspaceHost(here);
    const tint = (id: string) => tints.get(id) ?? "";
    const seen = (id: string) => {
      try { const at = backend.machines?.connection(id).get().seenAt; return at ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""; } catch { return ""; }
    };
    const servers = hostList.filter((h) => h.remote);
    return {
      project: { id: here.id, name: here.name, path: here.path, hostId, hostName: hostNameFor(hostId), tint: tint(hostId) },
      started: startedOf(pane),
      picker: pickerRows(workspaces, panes, here.id, offlineHost).map((row) => ({ row, hostName: hostNameFor(row.hostId), tint: tint(row.hostId), twin: twinPath(row.workspace, workspaces) })),
      workRows: workInRows(workspaces, ["local", ...servers.map((h) => h.id)], here, offlineHost).map((r) => ({ ...r, hostName: hostNameFor(r.hostId), tint: tint(r.hostId), seen: seen(r.hostId) })),
      servers: servers.map((h) => ({ id: h.id, name: h.name, tint: tint(h.id), offline: offlineHost(h.id) })),
      choose: (id) => { const target = latest.current.workspaces.find((w) => w.id === id); if (target) choose(pane, target); },
      newProject: (on = "local") => void projectOn(on, on === "local" ? "New project on This Mac" : `New project on ${hostNameFor(on)}`)
        .then((made) => { if (made) choose(pane, made); }, (error) => toast(String(error))),
      noProject: () => {
        const none = latest.current.workspaces.find((w) => !w.path && !w.hidden && workspaceHost(w) === "local" && w.name === "No project");
        if (none) { choose(pane, none); return; }
        const made: Workspace = { id: newId("ws"), name: "No project", path: "" };
        setWorkspaces((list) => [...list, made]);
        choose(pane, made);
      },
      copyOn: (on) => void projectOn(on, `Choose the folder for ${here.name} on ${hostNameFor(on)}. It's a separate copy from your Mac's; Deck doesn't copy files over`, here.name, workspaceFamily(here))
        .then((made) => { if (made) choose(pane, made); }, (error) => toast(String(error))),
      addServer: () => setConnectionDialog({ kind: "add" }),
      browseFile: () => backend.pickPath("file", "Attach a file"),
      pickerRequest: pickerRequests[pane.id],
    };
  };
  /** The prompt's words and actions for the pane that asked. */
  const askFor = (pane: Pane) => {
    if (!moveAsk || moveAsk.paneId !== pane.id) return undefined;
    const to = moveAsk.to;
    const here = workspaces.find((w) => w.id === pane.workspaceId);
    if (!here) return undefined;
    return {
      stays: hostNameFor(workspaceHost(here)), project: to.name, host: hostNameFor(workspaceHost(to)), why: moveAsk.why,
      onNew: () => { setMoveAsk(null); addPane("chat", "Group chat", undefined, to.id); },
      onFork: moveAsk.why ? undefined : () => { setMoveAsk(null); void forkTo(pane, to); },
      onCancel: () => setMoveAsk(null),
    };
  };
  /** Project ›, in a thread's menu: every project, recent first; picking one moves an unstarted thread or asks. */
  const projectEntries = (pane: Pane): MenuEntry[] => {
    const here = workspaces.find((w) => w.id === pane.workspaceId);
    const rows = pickerRows(workspaces, panes, pane.workspaceId, offlineHost);
    const stays = startedOf(pane)
      ? `Picking one starts a new thread or a fork there. This thread stays on ${hostNameFor(here ? workspaceHost(here) : "local")}.`
      : "This thread hasn't started, so it moves to the one you pick.";
    return [
      ...rows.map((row) => ({
        key: row.workspace.id, label: row.workspace.name, side: row.hostId === "local" ? "" : hostNameFor(row.hostId),
        checked: row.current, disabled: row.offline && !row.current, reason: row.offline ? `${hostNameFor(row.hostId)} can't be reached.` : "",
        onSelect: () => choose(pane, row.workspace),
      })),
      { key: "note", label: stays, note: true, separated: true },
    ];
  };

  /** What a server holds, for Edit connection: "2 threads and 1 project". */
  const hostUses = (hostId: string) => {
    const own = workspaces.filter((w) => workspaceHost(w) === hostId && !w.hidden);
    const threads = panes.filter((p) => p.kind === "chat" && own.some((w) => w.id === p.workspaceId) && !deleting.has(p.id)).length;
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    return own.length || threads ? `${plural(threads, "thread")} and ${plural(own.length, "project")}` : "";
  };

  /** Run what was chosen in a project's ⋯ menu. */
  const runProjectMenu = (workspace: Workspace, action: ProjectMenuAction) => {
    if (action === "pin") setWorkspaces((list) => toggleProjectPin(list, workspace.id));
    else if (action === "edit") setRenameRequests((all) => ({ ...all, [workspace.id]: (all[workspace.id] ?? 0) + 1 }));
    else if (action === "connection") setConnectionDialog({ kind: "edit", hostId: workspaceHost(workspace) });
    else if (action === "reveal") revealWorkspace(workspace);
    else if (action === "archive") {
      const own = panes.filter((p) => p.workspaceId === workspace.id && p.kind === "chat" && !p.archived && !deleting.has(p.id));
      archive(own, `Archived ${own.length} thread${own.length === 1 ? "" : "s"} in ${workspace.name}.`);
    } else if (action === "remove") removeWorkspace(workspace, true);
  };
  const projectMenuEntries = (workspace: Workspace): MenuEntry[] => projectMenuItems({
    pinned: workspace.pinned, remote: workspaceHost(workspace) !== "local", path: workspace.path,
    threads: panes.filter((p) => p.workspaceId === workspace.id && p.kind === "chat" && !p.archived && !deleting.has(p.id)).length,
  }).map((item) => ({ key: item.action, label: item.label, disabled: item.disabled, reason: item.reason, danger: item.danger, separated: item.separated, onSelect: () => runProjectMenu(workspace, item.action) }));

  const focusPane = (pane: Pane) => {
    // Opening a thread reads it, and brings it out of the archive.
    if (!(pane as Pane & { assistantTaskId?: string }).assistantTaskId && (pane.closed || pane.unread || pane.archived)) setPanes((list) => list.map((p) => {
      if (p.id !== pane.id) return p;
      const { unread: _read, archived: _out, ...rest } = p;
      return { ...rest, closed: false };
    }));
    if ((pane as Pane & { assistantTaskId?: string }).assistantTaskId) setTaskPaneClosed(pane.id, false);
    setActiveWorkspace(pane.workspaceId);
    setSection(paneSection(pane));
    setPicking(false);
    setFocusedPane(pane.id);
    if (maximized && maximized !== pane.id) setMaximized(null);
  };

  // Where the deck starts, for things that expand to the full window (the
  // Preview pane, the artifacts panel). Kept current as the title bar wraps.
  const deckTopWatch = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || deckTopWatch.current) return;
    const set = () => document.documentElement.style.setProperty("--deck-top", `${body.getBoundingClientRect().top}px`);
    set();
    deckTopWatch.current = new ResizeObserver(set);
    deckTopWatch.current.observe(body);
  });
  useEffect(() => () => deckTopWatch.current?.disconnect(), []);

  // Deck shortcuts, caught before a terminal or the composer sees them. See shortcuts.ts.
  const onShortcut = useRef<(event: KeyboardEvent) => void>(() => {});
  onShortcut.current = (event) => {
    const action = shortcutFor(event, /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
    if (!action || question) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === "settings") { setSettingsOpen((open) => (open ? null : "general")); return; }
    if (action.kind === "assistant") {
      const selected = workspaces.find((workspace) => workspace.id === apexAgentSelection && !workspace.hidden) ?? current ?? workspaces.find((workspace) => !workspace.hidden);
      if (selected) openApexAgent(selected.id);
      return;
    }
    // Any other deck shortcut is about the deck, so it closes settings first.
    setSettingsOpen(null);
    if (action.kind === "section") { setSection(action.section); setPicking(false); setMaximized(null); }
    else if (action.kind === "new_terminal") { if (current) { setSection("code"); setNewMenuRequest((n) => n + 1); } }
    else if (action.kind === "new_thread") { if (current) addPane("chat", "Group chat"); }
    else if (action.kind === "next_attention") {
      const next = [...attentionItems].sort((a, b) => urgency(a.signal.kind) - urgency(b.signal.kind) || b.signal.at - a.signal.at)[0];
      if (next?.paneId.startsWith("apex-monitor:")) openApexAgent(next.paneId.slice("apex-monitor:".length), true);
      else if (next?.paneId.startsWith("apex-task:")) openApexAgent(next.paneId.slice("apex-task:".length), true);
      else {
        const pane = next && viewPanes.find((p) => p.id === next.paneId);
        if (pane) focusPane(pane);
      }
    } else if (action.kind === "cycle_pane") {
      const next = cyclePane(leafIds(tree).filter((id) => shown.some((p) => p.id === id)), focusedPane, action.step);
      if (next) { setFocusedPane(next); if (maximized) setMaximized(next); }
    } else if (action.kind === "thread") {
      // ⌥⌘R, ⌥⌘P, ⇧⌘U and ⇧⌘A act on the thread in use, as its ⋯ menu would.
      const pane = panes.find((p) => p.id === focusedPane && p.kind === "chat");
      if (pane && action.action === "project") setPickerRequests((all) => ({ ...all, [pane.id]: (all[pane.id] ?? 0) + 1 }));
      else if (pane) runPaneMenu(pane, action.action, "head");
    } else if (action.kind === "maximize") {
      if (focusedPane && visiblePanes.some((p) => p.id === focusedPane)) setMaximized((m) => (m === focusedPane ? null : focusedPane));
    }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => onShortcut.current(event);
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  /** Quit once the last save has landed, or after a second if it hangs. */
  const quitNow = () => {
    if (!backend) return;
    void Promise.race([saveQueue.current.catch(() => {}), new Promise((done) => setTimeout(done, 1000))]).then(() => backend.quitApp());
  };

  // Asked to quit: the window's close button, ⌘W, ⌘Q or Quit in the app menu.
  // The desktop shell holds the quit until this answers (see quit.rs).
  const onQuitRequest = useRef<(request: number) => void>(() => {});
  onQuitRequest.current = (request) => {
    if (!backend) return;
    void backend.quitHeard(request).catch(() => {});
    const nameOf = (workspaceId: string) => workspaces.find((w) => w.id === workspaceId)?.name ?? "";
    const busy = stillRunning(
      listed.filter((p) => p.kind === "terminal" && workspaces.some(w => w.id === p.workspaceId && workspaceHost(w) === "local")).map((p) => ({ title: p.title, workspace: nameOf(p.workspaceId), agent: Boolean(p.agent), exited: !isRunning(runs[p.id]), status: statusOf(p) })),
      listed.filter((p) => p.kind === "chat" && !deleting.has(p.id) && workspaces.some(w => w.id === p.workspaceId && workspaceHost(w) === "local")).map((p) => ({ title: p.title, workspace: nameOf(p.workspaceId), status: threadStatus[p.id] })),
    );
    const asked = quitQuestion(busy, backend.quitStopsWork);
    if (asked) setQuestion({ ...asked, onConfirm: quitNow });
    else quitNow();
  };
  // The Electron app's menu: Settings… (⌘,) is a menu item there, so the key never reaches the window.
  useEffect(() => {
    if (!backend?.onMenu) return;
    let stop: (() => void) | undefined;
    let live = true;
    backend.onMenu((action) => {
      if (action === "settings") setSettingsOpen((open) => (open ? null : "general"));
      if (action === "hosts") setSettingsOpen("hosts");
    }).then((unlisten) => (live ? (stop = unlisten) : unlisten()));
    return () => { live = false; stop?.(); };
  }, [backend]);
  useEffect(() => {
    if (!backend) return;
    let stop: (() => void) | undefined;
    let live = true;
    backend.onQuitRequested((request) => onQuitRequest.current(request)).then((unlisten) => (live ? (stop = unlisten) : unlisten()));
    return () => { live = false; stop?.(); };
  }, [backend]);

  const assistantMonitors = Object.values(monitorAttention).flatMap((entry) => {
    const workspace = workspaces.find((item) => item.id === entry.workspaceId && !item.hidden);
    const monitor = entry.monitor;
    return workspace && workspaceHost(workspace) === entry.hostId && monitor.workspaceId === workspace.id && monitor.hostId === entry.hostId && monitor.cwd === workspace.path ? [monitor] : [];
  });
  const toolContextKey = assistantMonitors.map((monitor) => `${monitor.workspaceId}:${monitor.hostId}:${monitor.cwd}:${monitor.conversationId}:${monitor.threads.join(',')}`).sort().join('|');
  const [serversByLane, setServersByLane] = useState<Record<string, (ToolServer & { agent: string })[]>>({});
  const [serverStatusByLane, setServerStatusByLane] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!backend) return;
    let live = true;
    const load = async () => {
      const next: Record<string, (ToolServer & { agent: string })[]> = {};
      const statuses: Record<string, string> = {};
      for (const monitor of assistantMonitors) {
        const all: (ToolServer & { agent: string })[] = [];
        try {
          const route = hostBackend(monitor.hostId);
          const current = await route.call<ProjectMonitor | null>('monitor_get', { workspaceId: monitor.workspaceId });
          if (!current || current.cwd !== monitor.cwd || current.hostId !== monitor.hostId || current.conversationId !== monitor.conversationId) throw new Error('Project assignment changed.');
          for (const roomId of current.threads) {
            const room = await route.roomState?.(roomId);
            for (const participant of room?.snapshot.participants ?? []) {
              const found = await route.listToolServers(roomId, participant.id);
              all.push(...found.map((server) => ({ ...server, agent: participant.id })));
            }
          }
          next[monitor.workspaceId] = all.filter((server, index) => all.findIndex((other) => other.agent === server.agent && other.token === server.token) === index);
          statuses[monitor.workspaceId] = current.threads.length ? (all.length ? '' : 'The selected project chats have no tools available.') : 'Select a saved project chat in Sources to use its tools.';
        } catch (error) {
          next[monitor.workspaceId] = [];
          statuses[monitor.workspaceId] = `Could not load tools for this project: ${String(error instanceof Error ? error.message : error)}`;
        }
      }
      statuses.personal = 'Personal assistant integrations are managed in Connections; direct tool commands are unavailable in this lane.';
      if (live) { setServersByLane(next); setServerStatusByLane(statuses); }
    };
    void load();
    return () => { live = false; };
  }, [backend, toolContextKey, hostList]);

  if (!backend) return (
    <div className="loading">
      <img className="loading-mark" src="/branding/mark.svg" alt="Apex Deck" width="72" height="72" />
      <span>{storageError || (window.apexDeck ? statusWords(link.status, link.host, Date.now()) : "Starting…")}</span>
      {!storageError && (link.status.kind === "reconnecting" || link.status.kind === "failed") && link.status.reason && <small className="loading-reason">{link.status.reason}</small>}
      {/* Nothing else is on screen yet, so the way back to this Mac is here. */}
      {!storageError && window.apexDeck && (link.status.kind === "reconnecting" || link.status.kind === "failed") && (
        <div className="loading-actions">
          <button onClick={() => connection.retryNow()}>Try now</button>
        </div>
      )}
    </div>
  );

  let creationBackend: Backend | null = backend;
  try { if (current) creationBackend = backendFor({ workspaceId: current.id } as Pane); } catch { creationBackend = null; }
  const apexWorkspace = apexAgentWorkspace ? workspaces.find((w) => w.id === apexAgentWorkspace) ?? null : null;
  const selectedApexWorkspace = workspaces.find((workspace) => workspace.id === apexAgentSelection && !workspace.hidden) ?? current ?? workspaces.find((workspace) => !workspace.hidden) ?? null;
  let apexAgentBackend: Backend | null = null;
  try { if (apexWorkspace) apexAgentBackend = hostBackend(workspaceHost(apexWorkspace)); } catch { apexAgentBackend = null; }
  const apexMonitorChange = apexWorkspace ? guardedMonitorChange({
    workspaceId: apexWorkspace.id, hostId: workspaceHost(apexWorkspace), cwd: apexWorkspace.path, version: monitorOwnerVersion(apexWorkspace.id),
  }) : undefined;
  const monitorPollers = [...new Set(workspaces.map((workspace) => workspaceHost(workspace)))].flatMap((hostId) => {
    try { return [{ hostId, backend: hostBackend(hostId), version: monitorHostVersion(hostId) }]; } catch { return []; }
  });
  const picker = (pickerAgents: AgentInfo[]) => (
    <div className="picker">
      <div className="empty-emblem"><DeckIcon name={section === "threads" ? "chat" : "spark"} size={30} /></div>
      <span className="eyebrow">{current?.name} / {section === "threads" ? "Threads" : "Code"}</span>
      <h2>{section === "threads" ? "Great work starts with a conversation." : "Your next idea. Ready to run."}</h2>
      <p className="muted">{section === "threads" ? "Bring your bots into one conversation. Chats are saved automatically." : `Run your coding tools side by side in ${current?.name}.`}</p>
      <div className={`picker-grid ${section === "threads" ? "single" : ""}`}>
        {section === "code" && pickerAgents.filter((agent) => providerEnabled(agent.key, disabledProviders)).map((agent) => (
          <button key={agent.key} disabled={!agent.found} onClick={() => addPane("terminal", agent.label, agent.key)} title={agent.found ? `Runs ${agent.program}` : `${agent.program} was not found on this computer`}>
            <strong>{agent.label}</strong>
            <span>{agent.found ? agent.program : "not installed"}</span>
          </button>
        ))}
        {section === "code" && <button onClick={() => addPane("terminal", "Terminal")}>
          <strong>Terminal</strong>
          <span>your shell</span>
        </button>}
        {section === "threads" && <button className="accent" onClick={() => addPane("chat", "Group chat")}>
          <span className="picker-action-icon"><DeckIcon name="chat" size={22} /></span>
          <strong>Start a group chat</strong>
          <span>Different models. One shared conversation.</span>
          <DeckIcon name="arrow" />
        </button>}
      </div>
      <p className="picker-note">{section === "threads" ? "Choose your models inside the thread. Pick who answers with @mentions." : "Each terminal runs independently in your project folder."}</p>
      {visiblePanes.length > 0 && (
        <button className="ghost" onClick={() => setPicking(false)}>
          Back to panes
        </button>
      )}
    </div>
  );

  return (
    <div className="app">
      <header className="titlebar">
        {/* Three groups: the two sides take equal room, so the section tabs sit at the centre. */}
        <div className="titlebar-start">
        <span className="brand">
          <img className="brand-mark" src="/branding/mark.svg" alt="" width="28" height="28" />
          Apex Deck
        </span>
        <button className="icon" aria-expanded={railOpen && !compactApexAgentDock} onClick={() => setRailOpen((open) => !open)} disabled={compactApexAgentDock} aria-label={compactApexAgentDock ? "Workspaces hidden while ApexAgent is open" : railOpen ? "Hide workspaces" : "Show workspaces"} title={compactApexAgentDock ? "Workspaces return when ApexAgent closes" : railOpen ? "Hide workspaces" : "Show workspaces"}>
          <DeckIcon name="sidebar" />
        </button>
        {backend.demo && <span className="badge" title="Browser preview only. Terminals and model replies are simulated.">Preview mode</span>}
        </div>
        <SectionNavigation section={section} flags={sectionFlags} onOpen={openAttention} onMarkReadySeen={() => setAttention(clearReady)} onDecide={decideApproval} onChange={(next) => { setSettingsOpen(null); setSection(next); setPicking(false); setMaximized(null); }} />
        <div className="titlebar-end">
        <LayoutPicker value={layoutPreset} disabled={section === "agents" || visiblePanes.length < 2} onSelect={arrange} />
        {section === "agents" && <button className="primary titlebar-new" onClick={() => setNewAgentRequest((n) => n + 1)}>+ New agent</button>}
        {section !== "agents" && creationBackend && <HostAgents backend={creationBackend} agents={agents}>{hostAgents => <NewMenu
          section={section}
          label="+ New ▾"
          disabled={!current}
          agents={hostAgents}
          disabledProviders={disabledProviders}
          hasPanes={visiblePanes.length > 0}
          onShowPicker={() => setPicking(true)}
          onPick={(item) => addPane(item.kind, item.kind === "chat" ? "Group chat" : item.label, item.agent)}
          onManageProviders={() => setSettingsOpen("providers")}
          openRequest={newMenuRequest}
          where={current ? `${current.name} on ${hostNameFor(workspaceHost(current))}` : ""}
        />}</HostAgents>}
        <button ref={detailsToggle} className="icon" onClick={() => detailsOpen ? closeDetails() : setDetailsOpen(true)} aria-label={detailsOpen ? "Hide side panel" : "Show side panel"} title={detailsOpen ? "Hide side panel" : "Show side panel"} aria-expanded={detailsOpen} aria-controls="thread-details"><DeckIcon name="sidebar" /></button>
        </div>
      </header>

      <ApexAgentWidget workspaces={workspaces.filter((workspace) => !workspace.hidden)} workspaceId={selectedApexWorkspace?.id ?? null} open={!!apexWorkspace || apexAgentAllOpen} monitors={assistantMonitors}
        panelMode="dock" onPositionChange={setApexAvatarPosition}
        taskCounts={Object.fromEntries(Object.entries(assistantTaskCounts).filter(([id]) => { const owner = assistantOwners[id]; return !!owner && workspaces.some((workspace) => workspace.id === id && !workspace.hidden && workspace.path === owner.cwd && workspaceHost(workspace) === owner.hostId); }))}
        appearanceRequest={apexAgentAppearanceRequest} hideRequest={apexAgentHideRequest}
        offlineWorkspaceIds={workspaces.filter((workspace) => offlineHost(workspaceHost(workspace))).map((workspace) => workspace.id)}
        onOpen={(id) => openApexAgent(id, true)} onSelect={(id) => openApexAgent(id, true)} onClose={apexAgentFull ? toggleApexAgentFull : closeApexAgentAndReturnFocus} onAddSource={addAssistantSource}
        onReply={replyToAssistant}
        onRetry={(workspaceId) => mutateAssistant(workspaceId, "monitor_check_now", {})} />
      {monitorPollers.map(({ hostId, backend: hostRoute, version }) => <HostMonitors key={hostId} hostId={hostId} backend={hostRoute} getVersion={monitorHostVersion} onMonitors={acceptHostMonitors(version)} />)}
      {migrationNotice && <div className="connection-banner" role="status">{migrationNotice}<button onClick={() => setMigrationNotice("")}>Dismiss</button></div>}
      {storageError && <div className="storage-error" role="alert">{storageError}</div>}
      <div className={`body${apexWorkspace && apexAgentDockFocused ? " apex-agent-dock-focused" : ""}${compactApexAgentDock ? " apex-agent-dock-narrow" : ""}${apexAgentFull && (apexAgentAllOpen || !!apexWorkspace) ? " apex-agent-dock-expanded" : ""}`} ref={bodyRef}>
        {railVisible && (
          <ProjectSidebar
            backend={backend}
            section={section}
            panes={viewPanes}
            workspaces={workspaces}
            deleting={deleting}
            activeWorkspace={activeWorkspace}
            focusedPane={focusedPane}
            hosts={hostList}
            attention={attention}
            monitorAttention={monitorSignalsByWorkspace}
            threadStatus={threadStatus}
            statusOf={statusOf}
            programOf={programOf}
            paneRename={railRename}
            workspaceRename={renameRequests}
            paneMenu={(pane) => paneMenuEntries(pane, "rail")}
            projectMenu={projectMenuEntries}
            onOpenPane={focusPane}
            onTogglePin={(pane) => { if (!(pane as Pane & { assistantTaskId?: string }).assistantTaskId) runPaneMenu(pane, "pin", "rail"); }}
            onRenamePane={(id, title) => { if (viewPanes.find((pane) => pane.id === id && (pane as Pane & { assistantTaskId?: string }).assistantTaskId)) setTaskPaneTitle(id, title); else renamePane(id, title); }}
            onRenameWorkspace={(id, name) => setWorkspaces((list) => renameWorkspace(list, id, name))}
            onProjectClick={(workspace) => {
              setActiveWorkspace(workspace.id);
              setWorkspaces((list) => setCollapsed(list, workspace.id, !workspace.collapsed));
            }}
            onProjectPin={(workspace) => setWorkspaces((list) => toggleProjectPin(list, workspace.id))}
            onNewIn={newIn}
            onAddWorkspace={(hostId) => addWorkspace(undefined, hostId)}
            onManageHosts={() => setSettingsOpen("hosts")}
            appearanceOpen={settingsOpen === "appearance"}
            settingsOpen={settingsOpen !== null && settingsOpen !== "appearance"}
            onOpenAppearance={() => setSettingsOpen((open) => open === "appearance" ? null : "appearance")}
            onOpenSettings={() => setSettingsOpen((open) => open ? null : "general")}
            onRestore={restoreArchived}
            style={sidebarWidths.rail === null ? undefined : { width: sidebarWidths.rail }}
          />
        )}
        {railVisible && (
          <SidebarHandle
            which="rail"
            width={sidebarWidths.rail}
            measure={() => bodyRef.current?.querySelector<HTMLElement>(".rail")?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT.rail}
            onChange={setSidebarWidth("rail")}
            onActive={setResizing}
          />
        )}

        <main ref={canvasRef} className={`canvas section-${section}`} inert={apexAgentFull && (apexAgentAllOpen || !!apexWorkspace) ? true : undefined} aria-hidden={apexAgentFull && (apexAgentAllOpen || !!apexWorkspace) ? true : undefined}>
          {section === "agents" && <AgentsSection agents={agents} backend={backend} profiles={profiles} disabledProviders={disabledProviders} onChange={setProfiles} addRequest={newAgentRequest} />}
          {section === "library" && <LibraryView machines={[{ id: "local", name: hostNameFor("local"), offline: false }, ...hostList.filter((h) => h.remote).map((h) => ({ id: h.id, name: h.name, offline: offlineHost(h.id) }))]}
            backendOf={(id) => backend ? hostBackend(id) : null} threads={listed} workspaces={workspaces} onOpenThread={(room) => { const pane = viewPanes.find((p) => p.id === room); if (pane) focusPane(pane); }} />}
          {(section === "code" || section === "threads") && !current && (
            <div className="picker">
              <img className="welcome-logo" src="/branding/mark.svg" alt="" width="80" height="80" />
              <span className="eyebrow">Your workspace for what's next</span>
              <h2>One deck. Every perspective.</h2>
              <p className="muted">Bring your models, conversations, and terminals together. Start with a project folder and make it yours.</p>
              <button className="primary" onClick={addWorkspace}>
                <DeckIcon name="folder" /> Add a workspace <DeckIcon name="arrow" size={16} />
              </button>
              <button onClick={trySample}>Try a sample thread</button>
              <span className="muted welcome-note">Scripted bots. No keys needed.</span>
              <div className="welcome-capabilities"><span>01 / Agents</span><span>02 / Code</span><span>03 / Threads</span></div>
            </div>
          )}
          {(section === "code" || section === "threads") && current && (picking || visiblePanes.length === 0) && (creationBackend
            ? <HostAgents backend={creationBackend} agents={agents}>{picker}</HostAgents>
            : <div className="picker"><p>This workspace's machine is unavailable.</p></div>)}

          {/* Every pane of every workspace stays mounted so its session keeps
              running. Panes outside the current view are only hidden. */}
          <div ref={gridArea} className={`grid ${resizing || paneDrag.dragging ? "adjusting" : ""}`} style={{ display: section !== "agents" && current && !picking && visiblePanes.length > 0 ? "block" : "none" }}>
            {listed.map((pane) => {
              const visible = shown.some((p) => p.id === pane.id);
              const rect = maximized === pane.id ? FULL : placed.get(pane.id);
              const status = statusOf(pane);
              const workspace = workspaces.find((w) => w.id === pane.workspaceId);
              let paneBackend: Backend | null = null; let destinationError = "";
              try { paneBackend = backendFor(pane); } catch (error) { destinationError = String(error); }
              return (
                <section
                  key={pane.id}
                  data-pane-id={pane.id} data-host-id={(pane as Pane & { hostId?: string }).hostId ?? (workspace ? workspaceHost(workspace) : "missing")}
                  className={`pane ${pane.id === focusedPane ? "focused" : ""} ${paneDrag.dragging === pane.id ? "lifted" : ""}`}
                  style={visible && rect ? paneStyle(rect) : { display: "none" }}
                  onMouseDown={() => { setFocusedPane(pane.id); setActiveWorkspace(pane.workspaceId); if (pane.unread && !(pane as Pane & { assistantTaskId?: string }).assistantTaskId) setPanes((list) => setUnread(list, pane.id, false)); }}
                >
                  <div className="pane-head" onPointerDown={(event) => paneDrag.begin(pane.id, event)} title={[workspace?.name, maximized || visiblePanes.length < 2 ? "" : "Drag onto another pane to move it"].filter(Boolean).join(" · ")}>
                    <span className={`dot ${status}`} title={attention[pane.id] ? attention[pane.id].note || label(attention[pane.id].kind) : status} />
                    {/* The project and its machine always stay; the title and status words give way first. */}
                    {workspace && <span className="pane-ws" title={`${workspace.name}${((pane as Pane & { hostId?: string }).hostId ?? workspaceHost(workspace)) === "local" ? "" : ` on ${hostNameFor((pane as Pane & { hostId?: string }).hostId ?? workspaceHost(workspace))}`}${((pane as Pane & { executionPath?: string }).executionPath ?? workspace.path) ? ` · ${(pane as Pane & { executionPath?: string }).executionPath ?? workspace.path}` : ""}`}>
                      <ProjectFolder tint={((pane as Pane & { hostId?: string }).hostId ?? workspaceHost(workspace)) === "local" ? undefined : tints.get((pane as Pane & { hostId?: string }).hostId ?? workspaceHost(workspace))} size={12} />
                      <span className="nm">{workspace.name}</span><span className="nm-short">{shortName(workspace.name)}</span>
                    </span>}
                    <ThreadName className="pane-title" title={pane.title} onRename={title => { if ((pane as Pane & { assistantTaskId?: string }).assistantTaskId) setTaskPaneTitle(pane.id, title); else renamePane(pane.id, title); }} renameRequest={renameRequests[pane.id]} label={pane.kind === "chat" ? "Thread name" : pane.kind === "preview" ? "Preview name" : "Terminal name"} />
                    {paneBackend?.host && paneBackend.host.id !== "local" && <span className="pane-host" title={paneBackend.host.name}>
                      <span className="tint" style={{ color: tints.get(paneBackend.host.id) }}><Glyph name="globe" size={12} /></span><span className="hn">{paneBackend.host.name}</span>
                    </span>}
                    {programOf(pane) && <span className="program-title">· {programOf(pane)}</span>}
                    {!attention[pane.id] && <span className="pane-folder">{pane.kind === "chat" ? threadStatus[pane.id]?.text ?? "" : pane.kind === "preview" ? previewStatus[pane.id] ?? "" : status === "working" ? workingFor(runStart.current.get(pane.id) ?? Date.now(), Date.now()) : stateWord(runs[pane.id], false)}</span>}
                    {attention[pane.id] && <span className={`flag ${attention[pane.id].kind}`} title={attention[pane.id].note || label(attention[pane.id].kind)}>{attention[pane.id].note || label(attention[pane.id].kind)}</span>}
                    {(pane.kind === "terminal" || pane.kind === "chat") && servers[pane.id] && (
                      <button className="server-chip" onPointerDown={(event) => event.stopPropagation()} onClick={() => openPreview(servers[pane.id], pane.id)} title={pane.kind === "chat" ? "Open in Preview, beside this thread" : "Open in Preview, beside this terminal"}>
                        {hostLabel(servers[pane.id])}
                      </button>
                    )}
                    <span className="spacer" />
                    {pane.kind === "chat" && <ModStatuses paneId={pane.id} />}
                    {/* ChatPane puts Artifacts and Changes here. */}
                    {pane.kind === "chat" && <span className="pane-counts" />}

                    <button className="icon small" onClick={() => setMaximized((m) => (m === pane.id ? null : pane.id))} aria-label={maximized === pane.id ? "Restore layout" : "Maximize pane"} title={maximized === pane.id ? "Restore layout" : "Maximize"}>
                      {maximized === pane.id ? "▣" : "□"}
                    </button>
                    <span className="pane-menu-wrap" onPointerDown={(event) => event.stopPropagation()}>
                      <button className="icon small" disabled={!paneBackend} aria-label={`More actions for ${pane.title}`} aria-haspopup="menu" aria-expanded={headMenu?.id === pane.id} title="More"
                        onClick={(event) => { const opener = event.currentTarget; setHeadMenu((open) => (open?.id === pane.id ? null : { id: pane.id, anchor: { rect: opener.getBoundingClientRect() }, opener })); }}>
                        ⋯
                      </button>
                    </span>
                    <button className="icon small" onClick={() => closePane(pane.id)} aria-label={`Close ${pane.title}`} title={pane.kind === "chat" ? "Close (the thread stays in the list)" : "Close"}>
                      ×
                    </button>
                  </div>
                  <div className="pane-body">
                    {!paneBackend ? <div role="alert">{destinationError}</div> : <HostPane backend={paneBackend} agents={agents}>{hostAgents => pane.kind === "terminal" ? (
                      <TerminalPane pane={pane} cwd={workspace?.path ?? ""} backend={paneBackend} startRequest={startRequests[pane.id]} startOnMount={!restored.current.has(pane.id)} installed={toolInstalled(pane.agent, hostAgents)} toolLabel={toolName(pane.agent, hostAgents)} focused={pane.id === focusedPane && visible && !picking && !settingsOpen} onActivity={onActivity} onRun={onRun} onTitle={onTitle} onSignal={onSignal} onClose={closePane} onRunStart={onRunStart} onServer={onServer} fontSize={settings.terminal.fontSize} scrollback={settings.terminal.scrollback} />
                    ) : pane.kind === "preview" ? (
                      <PreviewPane
                        pane={pane}
                        backend={paneBackend}
                        visible={visible}
                        behind={Boolean(settingsOpen)}
                        servers={serversFor(pane.workspaceId)}
                        source={sourceOf(pane)}
                        openExternally={settings.preview.openExternally}
                        onOpenExternallyChange={(hosts) => setSettings({ ...settings, preview: { openExternally: hosts } })}
                        onAddress={setPreviewAddress}
                        onStatus={onPreviewStatus}
                        onStartSource={() => { const source = sourceOf(pane); if (source) setStartRequests((all) => ({ ...all, [source.pane.id]: (all[source.pane.id] ?? 0) + 1 })); }}
                        onShowSource={() => { const source = sourceOf(pane); if (source) focusPane(source.pane); }}
                        onOpenInBrowser={openInBrowser}
                      />
                    ) : (
                      <ChatPane onStatus={onThreadStatus} onCopy={onThreadCopy} menuRequest={(pane as Pane & { assistantTaskId?: string }).assistantTaskId ? undefined : threadRequests[pane.id]} onMenuDone={(id) => setThreadRequests((all) => all[pane.id]?.id === id ? { ...all, [pane.id]: undefined } : all)} onSeen={onThreadSeen} details={detailsHost} onFork={(title, upto, at) => (pane as Pane & { assistantTaskId?: string }).assistantTaskId ? Promise.resolve("") : forkThread(pane, title, upto, at)} moveAsk={askFor(pane)} work={workFor(pane)} pane={pane} cwd={(pane as Pane & { executionPath?: string }).executionPath ?? workspace?.path ?? ""} workspaceName={workspace?.name ?? ""} agents={hostAgents} backend={paneBackend} profiles={profiles} disabledProviders={disabledProviders} newThread={settings.newThread} newBotAccess={settings.newBotAccess} confirmSteer={settings.confirmSteer} chipParts={settings.botChips} onConfirmSteer={(confirmSteer) => setSettings((s) => ({ ...s, confirmSteer }))} onProfilesChange={setProfiles} focused={pane.id === focusedPane && visible && !picking && !settingsOpen} onActivity={onActivity} onSignal={onSignal} onApprovals={onApprovals} onServer={onServer} onPreview={(address, auto) => openPreview(address, pane.id, auto)} />
                    )}</HostPane>}
                  </div>
                </section>
              );
            })}
            {!maximized && <Dividers tree={tree} area={gridArea} onChange={setTree} onActive={setResizing} />}
            {paneDrag.preview && <div className="drop-preview" style={paneStyle(paneDrag.preview)} />}
          </div>
        </main>
        {!apexWorkspace && apexAgentAllOpen && <aside className={`apex-agent-dock apex-agent-float${apexAgentFull ? " apex-agent-full" : ""}`} style={apexFloatStyle} data-apex-agent-overlay aria-label="ApexAgent">
          <ApexAgentAll workspaces={workspaces.filter((workspace) => !workspace.hidden)} monitors={assistantMonitors} serversByLane={serversByLane} serverStatusByLane={serverStatusByLane} onReply={replyToAssistant} onMutate={mutateAssistant} onReact={reactToAssistant} saveAttachment={saveAssistantAttachment} pickAttachmentFolder={pickAssistantAttachmentFolder} onSetUp={openApexAgentProject} filterWorkspaceId={apexAgentFilter} onClearFilter={() => setApexAgentFilter(null)} onClose={closeApexAgentAndReturnFocus} onHide={() => { setApexAgentHideRequest((request) => request + 1); closeApexAgent(); }} onCustomize={() => setApexAgentAppearanceRequest((request) => request + 1)}
            offlineWorkspaceIds={workspaces.filter((workspace) => offlineHost(workspaceHost(workspace))).map((workspace) => workspace.id)} onOpenEvidence={openAssistantEvidence} onOverview={replyAcrossProjects} overviewEntries={visibleOverviewEntries(overviewEntries, assistantMonitors)} personal={personal}
            taskContext={assistantTaskContext && assistantMonitors.some((monitor) => overviewOwnerKey(overviewOwner(monitor)) === overviewOwnerKey(assistantTaskContext.owner)) ? assistantTaskContext : null} onClearTaskContext={() => setAssistantTaskContext(null)}
            tasks={[...handoffBatches.map((batch) => ({ ...batch, visibleChildren: visibleHandoffChildren(batch, assistantMonitors) })).filter((batch) => batch.visibleChildren.length > 0).map((batch) => <article className="assistant-chat-message assistant" key={batch.id}>
              <small>Task plan · {batch.children.length} assignment{batch.children.length === 1 ? '' : 's'}</small><p>{batch.visibleChildren.length === batch.children.length ? batch.originalRequest : 'Saved proposals for available projects. Changed project assignments need a new plan.'}</p>
              {batch.visibleChildren.map((child) => <div key={child.payload.requestId}><strong>{child.project} · {child.payload.destination.workers.join(', ')}</strong><p>{child.payload.brief}</p><small>{child.status === 'proposed' ? 'Prepared · task progress and review below' : child.status} · {child.payload.mode === 'isolated' ? 'Separate worktree' : 'Read only'}</small>{child.error && <p role="status">{child.error}</p>}</div>)}
              {batch.visibleChildren.some((child) => child.status !== 'proposed' && child.status !== 'failed') && <button type="button" disabled={handoffWorking.includes(batch.id)} onClick={() => void prepareHandoffBatch(batch.id)}>Retry saved proposals</button>}
            </article>), ...assistantMonitors.map((monitor) => {
              if (offlineHost(monitor.hostId)) return <article className="assistant-chat-message assistant" key={monitor.workspaceId}><small>{workspaces.find((workspace) => workspace.id === monitor.workspaceId)?.name} · Offline</small><p>Reconnect this machine to load and respond to delegated work.</p></article>;
              let route: Backend; try { route = hostBackend(monitor.hostId); } catch { return null; }
              const requestOwner = overviewOwner(monitor);
              const saved = loadPendingRequest(localStorage, requestOwner);
              const pending = saved && !assistantSending.current.has(saved.requestId) ? saved : null;
              const requestVersion = monitorOwnerVersion(monitor.workspaceId);
              const requestRecovery = {
                pending,
                retry: async () => {
                  if (!pending) return;
                  if (monitorOwnerVersion(monitor.workspaceId) !== requestVersion || hostBackend(monitor.hostId) !== route) throw new Error('The project connection changed. Reopen ApexAgent before retrying.');
                  await replyToAssistant(monitor.workspaceId, pending.text, pending);
                },
                discard: () => {
                  const workspace = latest.current.workspaces.find((item) => item.id === monitor.workspaceId && !item.hidden);
                  if (!workspace || workspace.path !== monitor.cwd || workspaceHost(workspace) !== monitor.hostId || monitorOwnerVersion(monitor.workspaceId) !== requestVersion || hostBackend(monitor.hostId) !== route) return;
                  if (pending && loadPendingRequest(localStorage, requestOwner)?.requestId === pending.requestId) {
                    clearPendingRequest(localStorage, requestOwner);
                    refreshAssistantRequests((version) => version + 1);
                  }
                },
              };
              return <ApexAgentTasks key={JSON.stringify([monitor.workspaceId, monitor.hostId, monitor.cwd, monitor.conversationId, monitorOwnerVersion(monitor.workspaceId)])} backend={route} requestRecovery={requestRecovery} projectName={workspaces.find((workspace) => workspace.id === monitor.workspaceId)?.name} owner={overviewOwner(monitor)} panes={viewPanes} profiles={profiles} view="conversation" clearedAt={apexAgentClearedAt} onSelectTask={(task, send) => setAssistantTaskContext({ id: task.id, project: workspaces.find((workspace) => workspace.id === monitor.workspaceId)?.name ?? 'Project', label: task.originalRequest, owner: task.owner, send })} onTaskClosed={(id) => setAssistantTaskContext((current) => current?.id === id ? null : current)} onOpenThread={(id) => { const pane = viewPanes.find((item) => item.id === id && item.workspaceId === monitor.workspaceId); if (pane) focusPane(pane); }} onMonitorUpdate={guardedMonitorChange({ workspaceId: monitor.workspaceId, hostId: monitor.hostId, cwd: monitor.cwd, version: monitorOwnerVersion(monitor.workspaceId) }).bind(null, monitor.workspaceId, monitor.hostId)} />;
            })]}
            clearedAt={apexAgentClearedAt} onClear={clearApexAgentConversation} fullScreen={apexAgentFull} onFullScreen={toggleApexAgentFull} />
        </aside>}
        {apexWorkspace && <aside className={`apex-agent-dock apex-agent-float${apexAgentFull ? " apex-agent-full" : ""}`} style={apexFloatStyle} data-apex-agent-overlay aria-label={`ApexAgent for ${apexWorkspace.name}`}>
          <button className="apex-agent-project-expand icon" type="button" onClick={toggleApexAgentFull} aria-pressed={apexAgentFull} aria-label={apexAgentFull ? "Collapse ApexAgent" : "Expand ApexAgent"} title={apexAgentFull ? "Collapse" : "Expand"}>{apexAgentFull ? "⤡" : "⤢"}</button>
          {apexAgentBackend
            ? <ApexAgentSources key={JSON.stringify([apexWorkspace.id, workspaceHost(apexWorkspace), apexWorkspace.path])} workspace={apexWorkspace} backend={apexAgentBackend} profiles={profiles} panes={viewPanes} onMonitorChange={apexMonitorChange} onClose={closeApexAgentAndReturnFocus} onBack={() => setApexAgentWorkspace(null)} />
            : <div className="apex-agent-dock-unavailable"><header><strong>ApexAgent</strong><button className="icon" onClick={closeApexAgentAndReturnFocus} aria-label="Close ApexAgent">×</button></header><p role="alert">The project machine is unavailable.</p><p>Reconnect the machine to use ApexAgent for {apexWorkspace.name}.</p></div>}
        </aside>}
        {detailsOpen && <>
          {overlayDetails && <button className="details-backdrop" style={{ left: railOpen ? bodyRef.current?.querySelector<HTMLElement>(".rail")?.getBoundingClientRect().width ?? 0 : 0 }} aria-label="Close side panel overlay" onClick={closeDetails} />}
          <SidebarHandle
            which="details"
            width={sidebarWidths.details}
            measure={() => asideRef.current?.getBoundingClientRect().width ?? detailsWidth}
            onChange={setSidebarWidth("details")}
            onActive={setResizing}
            className={overlayDetails ? "overlay" : ""}
            style={overlayDetails ? { right: `calc(min(${detailsWidth}px, 100% - 2 * var(--deck-gap, 0px)) + var(--deck-gap, 0px))` } : undefined}
          />
          <aside id="thread-details" tabIndex={-1} ref={asideRef} role={overlayDetails ? "dialog" : undefined} className={`thread-details ${overlayDetails ? "overlay" : "docked"}`} style={{ width: overlayDetails ? `min(${detailsWidth}px, 100% - 2 * var(--deck-gap, 0px))` : detailsWidth }} aria-label="Side panel">
            <RightPanel state={panel} onChange={setPanel} onClose={closeDetails} taskAttention={{ count: sectionFlags.agents.count, details: sectionFlags.agents.rows.map((row) => row.title).join("\n") || "ApexAgent tasks are waiting for your response" }} bodies={{
              dashboard: () => <RightDashboard rows={listed.filter((pane) => pane.kind === "chat" || pane.kind === "terminal").map((pane) => {
                const projectNeeds = listed.filter((candidate) => candidate.workspaceId === pane.workspaceId && attention[candidate.id]?.kind === "needs_input");
                return { id: pane.id, title: pane.title, project: workspaces.find((workspace) => workspace.id === pane.workspaceId)?.name ?? "", kind: pane.kind as "chat" | "terminal", status: statusOf(pane), note: attention[pane.id]?.note ?? "", ready: attention[pane.id]?.kind === "done", readyCount: listed.filter((candidate) => candidate.workspaceId === pane.workspaceId && attention[candidate.id]?.kind === "done").length, needsCount: attention[pane.id]?.kind === "needs_input" ? projectNeeds.length : undefined, needsDetails: projectNeeds.map((candidate) => `${candidate.title}: ${attention[candidate.id]?.note ?? "Needs your response"}`).join("; ") };
              })} onOpen={(id) => { const pane = listed.find((item) => item.id === id); if (pane) focusPane(pane); }} />,
              tasks: () => {
                const selected = listed.find((pane) => pane.id === focusedPane);
                const workspaceId = selected?.workspaceId ?? activeWorkspace;
                const monitor = assistantMonitors.find((item) => item.workspaceId === workspaceId);
                if (!monitor) return <p className="muted right-panel-empty">Pick a project with ApexAgent tasks.</p>;
                let route: Backend;
                try { route = hostBackend(monitor.hostId); } catch { return <p className="muted right-panel-empty">This project machine is unavailable.</p>; }
                return <ApexAgentTasks key={`side:${monitor.workspaceId}:${monitor.hostId}:${monitor.cwd}:${monitor.conversationId}`} backend={route} projectName={workspaces.find((workspace) => workspace.id === monitor.workspaceId)?.name} owner={overviewOwner(monitor)} panes={viewPanes} profiles={profiles} view="conversation" clearedAt={apexAgentClearedAt} onSelectTask={(task, send) => setAssistantTaskContext({ id: task.id, project: workspaces.find((workspace) => workspace.id === monitor.workspaceId)?.name ?? "Project", label: task.originalRequest, owner: task.owner, send })} onTaskClosed={(id) => setAssistantTaskContext((current) => current?.id === id ? null : current)} onOpenThread={(id) => { const pane = viewPanes.find((item) => item.id === id && item.workspaceId === monitor.workspaceId); if (pane) focusPane(pane); }} onMonitorUpdate={guardedMonitorChange({ workspaceId: monitor.workspaceId, hostId: monitor.hostId, cwd: monitor.cwd, version: monitorOwnerVersion(monitor.workspaceId) }).bind(null, monitor.workspaceId, monitor.hostId)} />;
              },
              browser: (tab, visible) => <RightBrowser id={tab.id} url={tab.url ?? ""} browser={backend.browser} visible={visible} onUrl={(url) => setPanel((current) => ({ ...current, tabs: current.tabs.map((item) => item.id === tab.id ? { ...item, url } : item) }))} />,
              files: (_tab, visible) => {
                const pane = listed.find((item) => item.id === focusedPane);
                const workspace = workspaces.find((item) => item.id === (pane?.workspaceId ?? activeWorkspace)) ?? null;
                let route: Backend | null = null;
                try { if (workspace) route = hostBackend(workspaceHost(workspace)); } catch { /* show the offline state */ }
                return <RightFilesTab root={workspace?.path || null} backend={route} threadId={pane?.kind === "chat" ? pane.id : null} visible={visible} onOpen={(path) => { if (route && workspace) void route.openTarget(path, workspace.path || null, false).catch(() => {}); }} />;
              },
              details: (_tab, visible) => detailsTarget
                ? <div ref={setDetailsSlot} tabIndex={-1} className="right-details-slot" hidden={!visible} />
                : <p className="muted right-panel-empty">Open a thread to see its details.</p>,
            }} />
          </aside>
        </>}
        {/* Over the deck, not instead of it: terminals and threads keep running underneath. */}
        {settingsOpen && <SettingsPage section={settingsOpen} onSection={setSettingsOpen} settings={settings} onChange={setSettings} agents={agents} profiles={profiles} backend={backend} onClose={closeSettings} />}
      </div>
      {question && <ConfirmDialog question={question} onCancel={() => setQuestion(null)} />}
      {connectionDialog && backend.hosts && <ConnectionDialog mode={connectionDialog} hosts={hostList} api={backend.hosts}
        uses={connectionDialog.kind === "edit" ? hostUses(connectionDialog.hostId) : ""}
        onClose={() => setConnectionDialog(null)}
        onSaved={(list, words) => { setHostList(list); setConnectionDialog(null); toast(words); }} />}
      <PathPrompt backend={backend} />
      <ModOverlays />
      {headMenu && (() => {
        const pane = viewPanes.find((p) => p.id === headMenu.id);
        return pane ? <MenuList id={`head:${pane.id}`} entries={paneMenuEntries(pane, "head")} anchor={headMenu.anchor} opener={headMenu.opener} onClose={() => setHeadMenu(null)} /> : null;
      })()}
      {(undoable || undoableRemove || toasts.length > 0) && (
        <div className="toasts">
          {undoable && (
            <div className="toast" role="status">
              <span>{undoable.title} deleted.</span>
              <button onClick={undoDelete}>Undo</button>
            </div>
          )}
          {undoableRemove && (
            <div className="toast" role="status">
              <span>{undoableRemove.name} removed.</span>
              <button onClick={undoRemove}>Undo</button>
            </div>
          )}
          {toasts.map((t) => (
            <div key={t.id} className="toast" role="status">
              <span>{t.text}</span>
              {t.undo && <button onClick={() => { t.undo!(); setToasts((all) => all.filter((x) => x.id !== t.id)); }}>Undo</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
