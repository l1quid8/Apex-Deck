import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";

import { getBackend, type Backend } from "./backend";
import { SettingsPage, type SettingsSection } from "./SettingsPage";
import { DEFAULT_SETTINGS, readSettings, type AppSettings } from "./settings";
import { providerEnabled } from "./providers";
import { detailsOverlay, detailsThread, noteFocus, type DetailsSection } from "./detailsLayout";
import type { DetailsHost } from "./ThreadDetails";
import { ThreadName } from "./ThreadName";
import { ChatPane } from "./ChatPane";
import { startHub } from "./hub";
import { SectionNavigation } from "./SectionNavigation";
import { AgentsSection } from "./AgentsSection";
import { DeckIcon } from "./DeckIcon";
import { NewMenu } from "./NewMenu";
import { TerminalPane } from "./TerminalPane";
import { PreviewPane, type ServerChoice } from "./PreviewPane";
import { isRunning, stateWord, terminalStatus, toolInstalled, toolName, type TerminalRun } from "./terminalRun";
import { nextTitle, programTitle } from "./terminalTitle";
import { hostLabel } from "./previewAddress";
import { paneMenuItems, type PaneMenuAction } from "./paneMenu";
import { grid, insertBeside, leafIds, mainAndStack, rects, sync, type LayoutNode, type Rect } from "./layout";
import { Dividers, paneStyle, usePaneDrag } from "./PaneLayout";
import { badgeCount, clearReady, label, seenFlags, summarize, urgency, withApprovals, withPaneSignal, workspaceFlag, type Attention, type Signal } from "./attention";
import { cyclePane, shortcutFor } from "./shortcuts";
import { AttentionMenu, type AttentionItem } from "./AttentionMenu";
import { ConfirmDialog, type Question } from "./ConfirmDialog";
import { SidebarHandle } from "./SidebarHandle";
import { SIDEBAR_DEFAULT, loadWidths, saveWidths, type Sidebar, type SidebarWidths } from "./sidebars";
import { workingFor } from "./composerStatus";
import { approvalSnapshot, dueEscalations, escalationKey, openCards, subscribeApprovals } from "./approvals";
import { UNDO_MS, closeNeedsConfirm, closeQuestion, loadedPanes, openPanes, paneSection, quitQuestion, removeCounts, removeQuestion, restoredLayouts, savedLayouts, savedPanes, stillRunning } from "./closing";
import { activeAfter, addFolders, hiddenWorkspaces, listedPanes, openThreadIds, removeWorkspacePanes, renameWorkspace, reopenThreads, setHidden, shownWorkspaces } from "./workspaces";
import type { AgentInfo, AppSection, AppSession, Layout, Pane, PaneStatus, ParticipantConfig, ThreadStatus, Workspace } from "./types";

const STORAGE_KEY = "apex-deck.workspaces.v1";
/** A pane counts as working if it produced output this recently. */
const WORKING_WINDOW_MS = 1500;

let counter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

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
/** The `paneMenu` id of the rail's Removed · Show menu. */
const REMOVED_MENU = "removed-workspaces";

export function App() {
  const [section, setSection] = useState<AppSection>("threads");
  /** Code or Threads, whichever was used last; a workspace clicked in Agents opens there. */
  const [lastDeck, setLastDeck] = useState<"code" | "threads">("threads");
  useEffect(() => { if (section !== "agents") setLastDeck(section); }, [section]);
  /** Bumped by the title bar's + New agent button. */
  const [newAgentRequest, setNewAgentRequest] = useState(0);
  /** What each thread reports: its head's words, and who is replying or stopped on a card. */
  const [threadStatus, setThreadStatus] = useState<Record<string, ThreadStatus>>({});
  const onThreadStatus = useCallback((paneId: string, status: ThreadStatus) => setThreadStatus((all) => (JSON.stringify(all[paneId]) === JSON.stringify(status) ? all : { ...all, [paneId]: status })), []);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const disabledProviders = settings.disabledProviders;
  /** The settings section shown, or null while the deck is. */
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  /** False until settings.json has been read, so a file that can't be read is never overwritten. */
  const settingsRead = useRef(false);
  const settingsQueue = useRef<Promise<void>>(Promise.resolve());
  const closeSettings = useCallback(() => setSettingsOpen(null), []);
  const [profiles, setProfiles] = useState<ParticipantConfig[]>([]);
  const [storageError, setStorageError] = useState("");
  const saveQueue = useRef(Promise.resolve());
  const [backend, setBackend] = useState<Backend | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(loadWorkspaces);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  const [panes, setPanes] = useState<Pane[]>([]);
  /** Where you stopped reading each thread, saved with it for "New since you looked". */
  const onThreadSeen = useCallback((paneId: string, seq: number) => setPanes((list) => (
    list.some((p) => p.id === paneId && p.lastSeenSeq !== seq) ? list.map((p) => (p.id === paneId ? { ...p, lastSeenSeq: seq } : p)) : list
  )), []);
  const [focusedPane, setFocusedPane] = useState<string | null>(null);
  /** Threads in the order they were last focused, most recent first. */
  const [recentThreads, setRecentThreads] = useState<string[]>([]);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>("top");
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
  /** The pane whose ⋯ menu is open. */
  const [paneMenu, setPaneMenu] = useState<string | null>(null);
  /** Bumped by ⌘T to open the + New menu. */
  const [newMenuRequest, setNewMenuRequest] = useState(0);
  /** Bumped to start renaming a thread from its ⋯ menu. */
  const [renameRequests, setRenameRequests] = useState<Record<string, number>>({});
  /** Bumped to start a terminal again from its ⋯ menu. */
  const [startRequests, setStartRequests] = useState<Record<string, number>>({});
  /** Fork or Export chosen in a thread's ⋯ menu; `n` goes up on each choice. */
  const [threadRequests, setThreadRequests] = useState<Record<string, { action: "fork" | "export"; n: number }>>({});
  const [railOpen, setRailOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState<Partial<Record<DetailsSection, boolean>>>({});
  const [detailsSlot, setDetailsSlot] = useState<HTMLElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  /** Sidebar widths the user dragged to; null keeps the default. */
  const [sidebarWidths, setSidebarWidths] = useState<SidebarWidths>(loadWidths);
  const setSidebarWidth = (which: Sidebar) => (width: number | null) => setSidebarWidths((old) => ({ ...old, [which]: width }));
  useEffect(() => saveWidths(sidebarWidths), [sidebarWidths]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
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
    setDetailsOpen(true);
  };
  const detailsHostBase = { slot: detailsSlot, open: detailsOpen && section === "threads", overlay: overlayDetails, collapsed: detailsCollapsed,
    toggle: (target: DetailsSection) => setDetailsCollapsed(old => ({ ...old, [target]: !old[target] })), show: showDetails, close: closeDetails };
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const observer = new ResizeObserver(() => {
      // Measure available pane space with the rail accounted for, before docking.
      const rail = body.querySelector<HTMLElement>(".rail");
      setAvailableWidth(body.clientWidth - (rail?.getBoundingClientRect().width ?? 0));
    });
    observer.observe(body);
    if (canvasRef.current) observer.observe(canvasRef.current);
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
  const lastOutput = useRef(new Map<string, number>());
  /** Terminals read back from the session file. They wait, Stopped, until started. */
  const restored = useRef(new Set<string>());
  /** When each terminal's current run of output began, for "Working 4m". */
  const runStart = useRef(new Map<string, number>());
  /** Every open approval card, app-wide (approvals.ts). */
  const approvalState = useSyncExternalStore(subscribeApprovals, approvalSnapshot);

  useEffect(() => {
    let alive = true;
    getBackend().then(async (b) => {
      await startHub(b);
      const found = await b.detectAgents().catch(() => []);
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
      const known = saved?.workspaces ?? loadWorkspaces();
      setWorkspaces(known);
      const loaded = loadedPanes(saved?.panes ?? [], known.map((w) => w.id));
      restored.current = new Set(loaded.filter((p) => p.kind === "terminal").map((p) => p.id));
      setPanes(loaded);
      setProfiles(saved?.profiles ?? []);
      setSection(saved?.section ?? "threads");
      setLayout(saved?.layout ?? "top");
      setDetailsOpen(saved?.threadDetailsOpen ?? false);
      setDetailsCollapsed(saved?.threadDetailsCollapsed ?? {});
      // A layout that cannot be read is dropped and rebuilt from the panes,
      // and panes that didn't load are taken out of the rest.
      setLayouts(restoredLayouts(saved?.layouts, loaded));
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

  useEffect(() => {
    if (!backend) return;
    saveWorkspaces(workspaces);
    const session: AppSession = { version: 1, workspaces, panes: savedPanes(panes), profiles, activeWorkspace, focusedPane, section, layout, layouts: savedLayouts(layouts, workspaces.map((w) => w.id)), threadDetailsOpen: detailsOpen, threadDetailsCollapsed: detailsCollapsed };
    // Keep writes in order so a slow old save cannot overwrite newer state.
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => backend.sessionSave(session));
    saveQueue.current.then(() => setStorageError(""), (error) => setStorageError(`Could not save changes: ${String(error)}`));
  }, [backend, workspaces, panes, profiles, activeWorkspace, focusedPane, section, layout, layouts, detailsOpen, detailsCollapsed]);

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
  const listed = useMemo(() => listedPanes(panes, workspaces), [panes, workspaces]);
  const visiblePanes = useMemo(() => openPanes(panes, deleting).filter((p) => p.workspaceId === activeWorkspace && paneSection(p) === section), [panes, deleting, activeWorkspace, section]);
  const shown = maximized && visiblePanes.some((p) => p.id === maximized) ? visiblePanes.filter((p) => p.id === maximized) : visiblePanes;
  useEffect(() => {
    if (focusedPane && panes.some((p) => p.id === focusedPane && p.kind === "chat")) setRecentThreads((recent) => (recent[0] === focusedPane ? recent : noteFocus(recent, focusedPane)));
  }, [focusedPane, panes]);
  /** The thread the details sidebar shows; null when no thread is on screen. */
  const detailsTarget = section === "threads" && !picking ? detailsThread(focusedPane, shown.filter((p) => p.kind === "chat").map((p) => p.id), recentThreads) : null;
  detailsTargetRef.current = detailsTarget;
  const detailsHost: DetailsHost = { ...detailsHostBase, target: detailsTarget };

  // The arrangement of the panes in view. Panes that were added or closed
  // since it was last stored are worked in here, so it always matches.
  const key = layoutKey(activeWorkspace, section);
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
    if (preset !== "grid") setLayout(preset);
    setMaximized(null);
  };
  const shownList = shownWorkspaces(workspaces);
  const hiddenList = hiddenWorkspaces(workspaces);
  const current = shownList.find((w) => w.id === activeWorkspace) ?? null;

  /** Put a removed workspace back on the list and show it. Its threads come back closed. */
  const bringBack = (id: string) => {
    setPaneMenu(null);
    setWorkspaces((list) => setHidden(list, id, false));
    setActiveWorkspace(id);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-workspace="${id}"]`)?.focus());
  };

  const addWorkspace = async () => {
    if (!backend) return;
    if (backend.demo) {
      // The preview has no folders to pick, so every workspace is new.
      const workspace = { id: newId("ws"), name: `workspace-${workspaces.length + 1}`, path: "" };
      setWorkspaces((list) => [...list, workspace]);
      setActiveWorkspace(workspace.id);
      return;
    }
    const picked = await backend.pickFolder();
    if (!picked) return;
    // A folder already listed is reused; one removed from the list comes back.
    const { list, ids } = addFolders(workspaces, [picked], () => newId("ws"), folderName);
    setWorkspaces(list);
    setActiveWorkspace(ids[0]);
  };

  /** Take a workspace off the list. Nothing is deleted: its threads stay saved
   *  and closed, and its terminals end. Asks first only while something in it runs. */
  const removeWorkspace = (workspace: Workspace) => {
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
    const asked = removeQuestion(workspace.name, counts);
    if (asked) setQuestion({ ...asked, onConfirm: remove });
    else remove();
  };

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

  const addPane = (kind: Pane["kind"], title: string, agent?: string) => {
    if (!activeWorkspace) return;
    // A second terminal or preview of the same name in a workspace is numbered: "Codex 2", "Preview 2".
    const name = kind === "chat" ? title : nextTitle(title, panes.filter((p) => p.workspaceId === activeWorkspace && p.kind === kind).map((p) => p.title));
    const pane: Pane = { id: newId("pane"), workspaceId: activeWorkspace, kind, title: name, agent };
    // A Preview stays on the deck it was added from.
    if (kind === "preview" && section === "threads") pane.deck = "threads";
    setPanes((list) => [...list, pane]);
    setFocusedPane(pane.id);
    setSection(paneSection(pane));
    setMaximized(null);
    setPicking(false);
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
   * moves to it, or one opens, and focus stays where you are.
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
      setPreviewAddress(own.id, address, sourceId);
      return;
    }
    const id = newId("pane");
    const title = nextTitle("Preview", panes.filter((p) => p.workspaceId === source.workspaceId && p.kind === "preview").map((p) => p.title));
    const preview: Pane = { id, workspaceId: source.workspaceId, kind: "preview", title, url: address, servedBy: sourceId };
    if (deck === "threads") preview.deck = "threads";
    const key = layoutKey(source.workspaceId, deck);
    setPanes((list) => [...list, preview]);
    setLayouts((all) => (all[key] && leafIds(all[key]).includes(sourceId) ? { ...all, [key]: insertBeside(all[key], sourceId, id, "right") } : all));
    if (auto) return;
    setActiveWorkspace(source.workspaceId);
    setSection(deck);
    setPicking(false);
    setFocusedPane(id);
    setMaximized(null);
  };

  const forkThread = async (source: Pane, title: string, upto: number | null) => {
    const id = newId("pane");
    if (!backend) throw new Error("The backend is not ready yet.");
    await backend.roomFork(source.id, id, upto);
    setPanes((list) => [...list, { id, workspaceId: source.workspaceId, kind: "chat", title }]);
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
    const live = Object.keys(attention).filter((id) => listed.some((p) => p.id === id));
    if (live.length !== Object.keys(attention).length) {
      setAttention((all) => Object.fromEntries(Object.entries(all).filter(([id]) => listed.some((p) => p.id === id))));
      return;
    }
    // The icon counts what needs you or failed; Ready shows only in the title bar and rail.
    const urgent = badgeCount(live.map((id) => attention[id]));
    const grew = urgent > flagged.current;
    flagged.current = urgent;
    backend?.flagAttention(urgent, grew && !document.hasFocus()).catch(() => {});
  }, [attention, listed, backend]);

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

  const attentionItems: AttentionItem[] = listed
    .filter((pane) => attention[pane.id])
    .map((pane) => ({
      paneId: pane.id,
      title: pane.title,
      workspace: workspaces.find((w) => w.id === pane.workspaceId)?.name ?? "",
      where: pane.kind === "chat" ? "Threads" : "Code",
      program: programOf(pane),
      signal: attention[pane.id],
      cards: pane.kind === "chat" ? openCards(pane.id, approvalState) : undefined,
    }));
  const sectionFlags = {
    code: summarize(attentionItems.filter((i) => i.where === "Code").map((i) => i.signal)),
    threads: summarize(attentionItems.filter((i) => i.where === "Threads").map((i) => i.signal)),
  };

  /** Take a pane off the deck. */
  const takeOff = (id: string) => {
    if (maximized === id) setMaximized(null);
    if (focusedPane === id) setFocusedPane(null);
  };

  /** × on a pane head. It never deletes: a thread is closed and stays in the rail. */
  const closePane = (id: string) => {
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
      body: "Its messages and pins are removed.",
      action: "Delete thread",
      onConfirm: () => {
        setDeleting((set) => new Set(set).add(pane.id));
        takeOff(pane.id);
        setUndoable({ id: pane.id, title: pane.title });
        deleteTimers.current.set(pane.id, setTimeout(async () => {
          deleteTimers.current.delete(pane.id);
          try {
            await backend?.roomDelete(pane.id);
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

  const undoDelete = () => {
    if (!undoable) return;
    clearTimeout(deleteTimers.current.get(undoable.id));
    deleteTimers.current.delete(undoable.id);
    setDeleting((set) => { const next = new Set(set); next.delete(undoable.id); return next; });
    setUndoable(null);
  };

  // A ⋯ menu closes on a click elsewhere or Escape. Escape puts focus back on
  // the button that opened it.
  const menuOpener = useRef<HTMLElement | null>(null);
  const toggleMenu = (id: string, event: ReactMouseEvent<HTMLElement>) => {
    menuOpener.current = event.currentTarget;
    setPaneMenu((open) => (open === id ? null : id));
  };
  useEffect(() => {
    if (!paneMenu) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".pane-menu-wrap")) setPaneMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setPaneMenu(null); menuOpener.current?.focus(); } };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key); };
  }, [paneMenu]);

  /** Show a workspace's folder in Finder. */
  const revealWorkspace = (workspace: Workspace) => {
    backend?.openTarget(workspace.path, null, true).catch((error) => setStorageError(`Could not show ${workspace.name} in Finder: ${String(error)}`));
  };

  /** Run what was chosen in a pane's ⋯ menu. */
  const runPaneMenu = (pane: Pane, action: PaneMenuAction) => {
    const bump = (all: Record<string, number>) => ({ ...all, [pane.id]: (all[pane.id] ?? 0) + 1 });
    if (action === "rename") setRenameRequests(bump);
    else if (action === "start") setStartRequests(bump);
    else if (action === "copy_path") {
      const path = workspaces.find((w) => w.id === pane.workspaceId)?.path;
      if (path) navigator.clipboard?.writeText(path).catch(() => {});
    } else if (action === "copy_address") {
      if (pane.url) navigator.clipboard?.writeText(pane.url).catch(() => {});
    } else if (action === "close") closePane(pane.id);
    else if (action === "fork" || action === "export") setThreadRequests((all) => ({ ...all, [pane.id]: { action, n: (all[pane.id]?.n ?? 0) + 1 } }));
    else if (action === "delete") deleteThread(pane);
  };

  const focusPane = (pane: Pane) => {
    if (pane.closed) setPanes((list) => list.map((p) => (p.id === pane.id ? { ...p, closed: false } : p)));
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
    // Any other deck shortcut is about the deck, so it closes settings first.
    setSettingsOpen(null);
    if (action.kind === "section") { setSection(action.section); setPicking(false); setMaximized(null); }
    else if (action.kind === "new_terminal") { if (current) { setSection("code"); setNewMenuRequest((n) => n + 1); } }
    else if (action.kind === "new_thread") { if (current) addPane("chat", "Group chat"); }
    else if (action.kind === "next_attention") {
      const next = [...attentionItems].sort((a, b) => urgency(a.signal.kind) - urgency(b.signal.kind) || b.signal.at - a.signal.at)[0];
      const pane = next && panes.find((p) => p.id === next.paneId);
      if (pane) focusPane(pane);
    } else if (action.kind === "cycle_pane") {
      const next = cyclePane(leafIds(tree).filter((id) => shown.some((p) => p.id === id)), focusedPane, action.step);
      if (next) { setFocusedPane(next); if (maximized) setMaximized(next); }
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
      listed.filter((p) => p.kind === "terminal").map((p) => ({ title: p.title, workspace: nameOf(p.workspaceId), agent: Boolean(p.agent), exited: !isRunning(runs[p.id]), status: statusOf(p) })),
      listed.filter((p) => p.kind === "chat" && !deleting.has(p.id)).map((p) => ({ title: p.title, workspace: nameOf(p.workspaceId), status: threadStatus[p.id] })),
    );
    const asked = quitQuestion(busy);
    if (asked) setQuestion({ ...asked, onConfirm: quitNow });
    else quitNow();
  };
  useEffect(() => {
    if (!backend) return;
    let stop: (() => void) | undefined;
    let live = true;
    backend.onQuitRequested((request) => onQuitRequest.current(request)).then((unlisten) => (live ? (stop = unlisten) : unlisten()));
    return () => { live = false; stop?.(); };
  }, [backend]);

  if (!backend) return (
    <div className="loading">
      <img className="loading-mark" src="/branding/mark.svg" alt="Apex Deck" width="72" height="72" />
      <span>{storageError || "Starting…"}</span>
    </div>
  );

  const picker = (
    <div className="picker">
      <div className="empty-emblem"><DeckIcon name={section === "threads" ? "chat" : "spark"} size={30} /></div>
      <span className="eyebrow">{current?.name} / {section === "threads" ? "Threads" : "Code"}</span>
      <h2>{section === "threads" ? "Great work starts with a conversation." : "Your next idea. Ready to run."}</h2>
      <p className="muted">{section === "threads" ? "Bring your bots into one conversation. Chats are saved automatically." : `Run your coding tools side by side in ${current?.name}.`}</p>
      <div className={`picker-grid ${section === "threads" ? "single" : ""}`}>
        {section === "code" && agents.filter((agent) => providerEnabled(agent.key, disabledProviders)).map((agent) => (
          <button key={agent.key} disabled={!agent.found} onClick={() => addPane("terminal", agent.label, agent.key)} title={agent.found ? `Runs ${agent.program}` : `${agent.program} was not found on this computer`}>
            <strong>{agent.label}</strong>
            <span>{agent.found ? agent.program : "not installed"}</span>
          </button>
        ))}
        {section === "code" && <button onClick={() => addPane("terminal", "Terminal")}>
          <strong>Terminal</strong>
          <span>your shell</span>
        </button>}
        {section === "code" && <button onClick={() => addPane("preview", "Preview")}>
          <strong>Preview</strong>
          <span>a web page</span>
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
        <button className="icon" onClick={() => setRailOpen((open) => !open)} aria-label={railOpen ? "Hide workspaces" : "Show workspaces"} title={railOpen ? "Hide workspaces" : "Show workspaces"}>
          <DeckIcon name="sidebar" />
        </button>
        <span className="brand">
          <img className="brand-mark" src="/branding/mark.svg" alt="" width="28" height="28" />
          Apex Deck
        </span>
        {backend.demo && <span className="badge" title="Browser preview only. Terminals and model replies are simulated.">Preview mode</span>}
        {/* Just left of the tabs: it grows away from them, so neither the tabs nor the right-hand controls move. */}
        <AttentionMenu
          items={attentionItems}
          onOpen={(paneId) => { const pane = panes.find((p) => p.id === paneId); if (pane) focusPane(pane); }}
          onDecide={(room, request, approve) => backend.roomDecide(room, request, approve, false)}
          onMarkReadySeen={() => setAttention(clearReady)}
        />
        </div>
        <SectionNavigation section={section} flags={sectionFlags} onChange={(next) => { setSection(next); setPicking(false); setMaximized(null); }} />
        <div className="titlebar-end">
        {(
          <div className="layout-presets" role="group" aria-label="Arrange panes">
            <button onClick={() => arrange("grid")} disabled={section === "agents" || visiblePanes.length < 2} title="Even grid" aria-label="Arrange as an even grid">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" /><rect x="9" y="1.5" width="5.5" height="5.5" rx="1" /><rect x="1.5" y="9" width="5.5" height="5.5" rx="1" /><rect x="9" y="9" width="5.5" height="5.5" rx="1" /></svg>
            </button>
            <button onClick={() => arrange("top")} disabled={section === "agents" || visiblePanes.length < 2} title="Large pane on top, the rest below" aria-label="Arrange with a large pane on top">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="7.5" rx="1" /><rect x="1.5" y="11" width="5.5" height="3.5" rx="1" /><rect x="9" y="11" width="5.5" height="3.5" rx="1" /></svg>
            </button>
            <button onClick={() => arrange("left")} disabled={section === "agents" || visiblePanes.length < 2} title="Large pane on the left, the rest beside it" aria-label="Arrange with a large pane on the left">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="7.5" height="13" rx="1" /><rect x="11" y="1.5" width="3.5" height="5.5" rx="1" /><rect x="11" y="9" width="3.5" height="5.5" rx="1" /></svg>
            </button>
          </div>
        )}
        {section === "agents" && <button className="primary" onClick={() => setNewAgentRequest((n) => n + 1)}>+ New agent</button>}
        {section !== "agents" && <NewMenu
          section={section}
          label="+ New ▾"
          disabled={!current}
          agents={agents}
          disabledProviders={disabledProviders}
          hasPanes={visiblePanes.length > 0}
          onShowPicker={() => setPicking(true)}
          onPick={(item) => addPane(item.kind, item.kind === "chat" ? "Group chat" : item.label, item.agent)}
          onManageProviders={() => setSettingsOpen("providers")}
          openRequest={newMenuRequest}
        />}
        <button className={settingsOpen ? "icon active" : "icon"} onClick={() => setSettingsOpen((open) => (open ? null : "general"))} aria-label="Settings" title="Settings (⌘,)" aria-pressed={!!settingsOpen}><DeckIcon name="settings" /></button>
        {section === "threads" && <button ref={detailsToggle} className="icon" onClick={() => detailsOpen ? closeDetails() : showDetails()} aria-label={detailsOpen ? "Hide thread details" : "Show thread details"} title={detailsOpen ? "Hide thread details" : "Show thread details"} aria-expanded={detailsOpen} aria-controls="thread-details"><DeckIcon name="sidebar" /></button>}
        </div>
      </header>

      {storageError && <div className="storage-error" role="alert">{storageError}</div>}
      <div className="body" ref={bodyRef}>
        {railOpen && (
          <aside className="rail" style={sidebarWidths.rail === null ? undefined : { width: sidebarWidths.rail }}>
            <div className="rail-head">
              <span>Workspaces</span>
              <button className="icon" onClick={addWorkspace} aria-label="Add workspace" title="Add a folder">
                +
              </button>
            </div>
            {shownList.length === 0 && <p className="muted rail-empty">Add a folder to get started.</p>}
            {shownList.map((workspace) => {
              const own = section === "agents" ? [] : panes.filter((p) => p.workspaceId === workspace.id && !deleting.has(p.id) && paneSection(p) === section);
              const inside = panes
                .filter((p) => p.workspaceId === workspace.id && attention[p.id] && !deleting.has(p.id))
                .map((p) => ({ where: p.kind === "chat" ? "Threads" as const : "Code" as const, signal: attention[p.id] }));
              const flag = workspaceFlag(inside, section === "code" ? "Code" : section === "threads" ? "Threads" : null);
              const openWorkspace = () => { setActiveWorkspace(workspace.id); if (section === "agents") setSection(lastDeck); };
              const rename = () => setRenameRequests((all) => ({ ...all, [workspace.id]: (all[workspace.id] ?? 0) + 1 }));
              return (
                <div key={workspace.id} className="ws">
                  <div className={`ws-row ${workspace.id === activeWorkspace ? "active" : ""}`}>
                    {/* A div, not a button, so the name inside can be renamed in place (as pane rows do). */}
                    <div role="button" tabIndex={0} data-workspace={workspace.id} className="ws-name" title={workspace.path || workspace.name}
                      aria-label={[workspace.name, flag?.title].filter(Boolean).join(", ")}
                      onClick={openWorkspace}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openWorkspace(); }
                        else if (event.key === "F2") { event.preventDefault(); rename(); }
                      }}>
                      <DeckIcon name="folder" size={16} />
                      <ThreadName className="ws-label" title={workspace.name} label="Workspace name" tooltip={workspace.path || workspace.name} renameRequest={renameRequests[workspace.id]} onRename={(name) => setWorkspaces((list) => renameWorkspace(list, workspace.id, name))} />
                      {flag && <span className={`flag-count ${flag.worst ?? ""}`} title={flag.title} aria-label={flag.title}>{flag.text}</span>}
                    </div>
                    <span className="pane-menu-wrap">
                      <button className="icon small" onClick={(event) => toggleMenu(workspace.id, event)} aria-label={`More for ${workspace.name}`} aria-haspopup="menu" aria-expanded={paneMenu === workspace.id} title="More">
                        ⋯
                      </button>
                      {paneMenu === workspace.id && (
                        <span className="pane-menu" role="menu">
                          <button role="menuitem" onClick={() => { setPaneMenu(null); rename(); }}>Rename</button>
                          <button role="menuitem" disabled={!workspace.path} title={workspace.path ? undefined : "This workspace has no folder"} onClick={() => { setPaneMenu(null); revealWorkspace(workspace); }}>Reveal in Finder</button>
                          <span className="pane-menu-sep" role="separator" />
                          <button role="menuitem" className="danger-text" onClick={() => { setPaneMenu(null); removeWorkspace(workspace); }}>Remove from list…</button>
                        </span>
                      )}
                    </span>
                  </div>
                  {own.map((pane) => (
                    <div role="button" tabIndex={0} key={pane.id} onKeyDown={e => {if(e.key === "Enter") focusPane(pane);}} className={`pane-row ${pane.id === focusedPane && !pane.closed ? "focused" : ""} ${pane.closed ? "closed" : ""}`} title={pane.closed ? "Closed. Click to open it again." : undefined} onClick={() => focusPane(pane)}>
                      <span className={`dot ${statusOf(pane)}`} title={statusOf(pane)} />
                      <ThreadName className="pane-row-title" title={pane.title} onRename={title => renamePane(pane.id, title)} label={pane.kind === "chat" ? "Thread name" : pane.kind === "preview" ? "Preview name" : "Terminal name"} />
                      {programOf(pane) && <span className="program-title">· {programOf(pane)}</span>}
                      {attention[pane.id] && <span className={`flag ${attention[pane.id].kind}`} title={attention[pane.id].note}>{label(attention[pane.id].kind)}</span>}
                    </div>
                  ))}
                </div>
              );
            })}
            {hiddenList.length > 0 && (
              <div className="rail-foot">
                <span>Removed ({hiddenList.length})</span>
                <span aria-hidden="true">·</span>
                <span className="pane-menu-wrap">
                  <button className="ghost" onClick={(event) => toggleMenu(REMOVED_MENU, event)} aria-label="Show removed workspaces" aria-haspopup="menu" aria-expanded={paneMenu === REMOVED_MENU}>Show</button>
                  {paneMenu === REMOVED_MENU && (
                    <span className="pane-menu" role="menu" aria-label="Removed workspaces">
                      {hiddenList.map((workspace) => (
                        <button key={workspace.id} role="menuitem" title={workspace.path || workspace.name} onClick={() => bringBack(workspace.id)}>{workspace.name}</button>
                      ))}
                    </span>
                  )}
                </span>
              </div>
            )}
          </aside>
        )}
        {railOpen && (
          <SidebarHandle
            which="rail"
            width={sidebarWidths.rail}
            measure={() => bodyRef.current?.querySelector<HTMLElement>(".rail")?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT.rail}
            onChange={setSidebarWidth("rail")}
            onActive={setResizing}
          />
        )}

        <main ref={canvasRef} className={`canvas section-${section}`}>
          {section === "agents" && <AgentsSection agents={agents} backend={backend} profiles={profiles} disabledProviders={disabledProviders} onChange={setProfiles} addRequest={newAgentRequest} />}
          {section !== "agents" && !current && (
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
          {section !== "agents" && current && (picking || visiblePanes.length === 0) && picker}

          {/* Every pane of every workspace stays mounted so its session keeps
              running. Panes outside the current view are only hidden. */}
          <div ref={gridArea} className={`grid ${resizing || paneDrag.dragging ? "adjusting" : ""}`} style={{ display: section !== "agents" && current && !picking && visiblePanes.length > 0 ? "block" : "none" }}>
            {listed.map((pane) => {
              const visible = shown.some((p) => p.id === pane.id);
              const rect = maximized === pane.id ? FULL : placed.get(pane.id);
              const status = statusOf(pane);
              const workspace = workspaces.find((w) => w.id === pane.workspaceId);
              return (
                <section
                  key={pane.id}
                  className={`pane ${pane.id === focusedPane ? "focused" : ""} ${paneDrag.dragging === pane.id ? "lifted" : ""}`}
                  style={visible && rect ? paneStyle(rect) : { display: "none" }}
                  onMouseDown={() => setFocusedPane(pane.id)}
                >
                  <div className="pane-head" onPointerDown={(event) => paneDrag.begin(pane.id, event)} title={[workspace?.name, maximized || visiblePanes.length < 2 ? "" : "Drag onto another pane to move it"].filter(Boolean).join(" · ")}>
                    <span className={`dot ${status}`} title={status} />
                    <ThreadName className="pane-title" title={pane.title} onRename={title => renamePane(pane.id, title)} renameRequest={renameRequests[pane.id]} label={pane.kind === "chat" ? "Thread name" : pane.kind === "preview" ? "Preview name" : "Terminal name"} />
                    {programOf(pane) && <span className="program-title">· {programOf(pane)}</span>}
                    {!attention[pane.id] && <span className="pane-folder">{pane.kind === "chat" ? threadStatus[pane.id]?.text ?? "" : pane.kind === "preview" ? previewStatus[pane.id] ?? "" : status === "working" ? workingFor(runStart.current.get(pane.id) ?? Date.now(), Date.now()) : stateWord(runs[pane.id], false)}</span>}
                    {attention[pane.id] && <span className={`flag ${attention[pane.id].kind}`} title={attention[pane.id].note || label(attention[pane.id].kind)}>{attention[pane.id].note || label(attention[pane.id].kind)}</span>}
                    {(pane.kind === "terminal" || pane.kind === "chat") && servers[pane.id] && (
                      <button className="server-chip" onPointerDown={(event) => event.stopPropagation()} onClick={() => openPreview(servers[pane.id], pane.id)} title={pane.kind === "chat" ? "Open in Preview, beside this thread" : "Open in Preview, beside this terminal"}>
                        {hostLabel(servers[pane.id])}
                      </button>
                    )}
                    <span className="spacer" />
                    <button className="icon small" onClick={() => setMaximized((m) => (m === pane.id ? null : pane.id))} aria-label={maximized === pane.id ? "Restore layout" : "Maximize pane"} title={maximized === pane.id ? "Restore layout" : "Maximize"}>
                      {maximized === pane.id ? "▣" : "□"}
                    </button>
                    <span className="pane-menu-wrap" onPointerDown={(event) => event.stopPropagation()}>
                      <button className="icon small" onClick={(event) => toggleMenu(pane.id, event)} aria-label={`More actions for ${pane.title}`} aria-haspopup="menu" aria-expanded={paneMenu === pane.id} title="More">
                        ⋯
                      </button>
                      {paneMenu === pane.id && (
                        <span className="pane-menu" role="menu">
                          {paneMenuItems(pane.kind, { running: isRunning(runs[pane.id]), installed: toolInstalled(pane.agent, agents), tool: toolName(pane.agent, agents), folder: workspace?.path ?? "" }, { address: pane.url ?? "" }).map((item) => (
                            <Fragment key={item.action}>
                              {item.separated && <span className="pane-menu-sep" role="separator" />}
                              <button role="menuitem" className={item.danger ? "danger-text" : undefined} disabled={item.disabled} title={item.reason || undefined} onClick={() => { setPaneMenu(null); runPaneMenu(pane, item.action); }}>{item.label}</button>
                            </Fragment>
                          ))}
                        </span>
                      )}
                    </span>
                    <button className="icon small" onClick={() => closePane(pane.id)} aria-label={`Close ${pane.title}`} title={pane.kind === "chat" ? "Close (the thread stays in the list)" : "Close"}>
                      ×
                    </button>
                  </div>
                  <div className="pane-body">
                    {pane.kind === "terminal" ? (
                      <TerminalPane pane={pane} cwd={workspace?.path ?? ""} backend={backend} startRequest={startRequests[pane.id]} startOnMount={!restored.current.has(pane.id)} installed={toolInstalled(pane.agent, agents)} toolLabel={toolName(pane.agent, agents)} focused={pane.id === focusedPane && visible && !picking && !settingsOpen} onActivity={onActivity} onRun={onRun} onTitle={onTitle} onSignal={onSignal} onClose={closePane} onRunStart={onRunStart} onServer={onServer} fontSize={settings.terminal.fontSize} scrollback={settings.terminal.scrollback} />
                    ) : pane.kind === "preview" ? (
                      <PreviewPane
                        pane={pane}
                        backend={backend}
                        visible={visible}
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
                      <ChatPane onStatus={onThreadStatus} menuRequest={threadRequests[pane.id]} onSeen={onThreadSeen} details={detailsHost} onFork={(title, upto) => forkThread(pane, title, upto)} pane={pane} cwd={workspace?.path ?? ""} workspaceName={workspace?.name ?? ""} agents={agents} backend={backend} profiles={profiles} disabledProviders={disabledProviders} newThread={settings.newThread} newBotAccess={settings.newBotAccess} confirmSteer={settings.confirmSteer} onConfirmSteer={(confirmSteer) => setSettings((s) => ({ ...s, confirmSteer }))} onProfilesChange={setProfiles} focused={pane.id === focusedPane && visible && !picking && !settingsOpen} onActivity={onActivity} onSignal={onSignal} onApprovals={onApprovals} onServer={onServer} onPreview={(address, auto) => openPreview(address, pane.id, auto)} />
                    )}
                  </div>
                </section>
              );
            })}
            {!maximized && <Dividers tree={tree} area={gridArea} onChange={setTree} onActive={setResizing} />}
            {paneDrag.preview && <div className="drop-preview" style={paneStyle(paneDrag.preview)} />}
          </div>
        </main>
        {section === "threads" && detailsOpen && detailsTarget && <>
          {overlayDetails && <button className="details-backdrop" style={{ left: railOpen ? bodyRef.current?.querySelector<HTMLElement>(".rail")?.getBoundingClientRect().width ?? 0 : 0 }} aria-label="Close thread details overlay" onClick={closeDetails} />}
          <SidebarHandle
            which="details"
            width={sidebarWidths.details}
            measure={() => detailsSlot?.getBoundingClientRect().width ?? detailsWidth}
            onChange={setSidebarWidth("details")}
            onActive={setResizing}
            className={overlayDetails ? "overlay" : ""}
            style={overlayDetails ? { right: `min(${detailsWidth}px, 100%)` } : undefined}
          />
          <aside id="thread-details" tabIndex={-1} ref={setDetailsSlot} className={`thread-details ${overlayDetails ? "overlay" : "docked"}`} style={{ width: overlayDetails ? `min(${detailsWidth}px, 100%)` : detailsWidth }} aria-label="Thread details">
          </aside>
        </>}
        {/* Over the deck, not instead of it: terminals and threads keep running underneath. */}
        {settingsOpen && <SettingsPage section={settingsOpen} onSection={setSettingsOpen} settings={settings} onChange={setSettings} agents={agents} profiles={profiles} backend={backend} onClose={closeSettings} />}
      </div>
      {question && <ConfirmDialog question={question} onCancel={() => setQuestion(null)} />}
      {(undoable || undoableRemove) && (
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
        </div>
      )}
    </div>
  );
}
