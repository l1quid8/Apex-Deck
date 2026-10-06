import { canvasPanes } from "./canvasPanes.ts";
import { normalizeWorkspaces, prepareHostSession, mergeHostSession, migrateCanvasLayouts, workspaceHost } from "./hostSession.ts";
import { paneDestination } from "./paneHost.ts";
import { HostPane, HostAgents } from "./HostPane";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { getBackend, type Backend, type HostEntry } from "./backend";
import { connection, statusWords } from "./connection";
import { SettingsPage, type SettingsSection } from "./SettingsPage";
import { DEFAULT_SETTINGS, readSettings, type AppSettings } from "./settings";
import { providerEnabled } from "./providers";
import { detailsOverlay, detailsThread, noteFocus, type DetailsSection } from "./detailsLayout";
import type { DetailsHost } from "./ThreadDetails";
import { ThreadName } from "./ThreadName";
import { ChatPane, type ThreadMenuRequest } from "./ChatPane";
import { ModOverlays, ModStatuses, OPEN_SETTINGS_EVENT } from "./ModView";
import { modHost } from "./mods/host";
import { startHub } from "./hub";
import { SectionNavigation } from "./SectionNavigation";
import { AgentsSection } from "./AgentsSection";
import { DeckIcon } from "./DeckIcon";
import { NewMenu } from "./NewMenu";
import { TerminalPane } from "./TerminalPane";
import { PreviewPane, type ServerChoice } from "./PreviewPane";
import { isRunning, stateWord, terminalStatus, toolInstalled, toolName, type TerminalRun } from "./terminalRun";
import { nextTitle, programTitle } from "./terminalTitle";
import { hostLabel, sameServer } from "./previewAddress";
import { copyMenuItems, paneMenuItems, projectMenuItems, type CopyKind, type PaneMenuAction, type ProjectMenuAction } from "./paneMenu";
import { ProjectSidebar } from "./Sidebar";
import { MenuList, type MenuAnchor, type MenuEntry } from "./Menu";
import { archiveThreads, noteActive, setCollapsed, setUnread, toggleProjectPin, unarchiveThreads } from "./sidebarModel.ts";
import { COPIED, folderCopyText, writeClipboard } from "./threadCopy.ts";
import { grid, insertBeside, leafIds, mainAndStack, rects, sync, type LayoutNode, type Rect } from "./layout";
import { Dividers, paneStyle, usePaneDrag } from "./PaneLayout";
import { badgeCount, clearReady, label, seenFlags, summarize, urgency, withApprovals, withPaneSignal, type Attention, type Signal } from "./attention";
import { cyclePane, shortcutFor } from "./shortcuts";
import { AttentionMenu, type AttentionItem } from "./AttentionMenu";
import { ConfirmDialog, type Question } from "./ConfirmDialog";
import { PathPrompt } from "./PathPrompt";
import { SidebarHandle } from "./SidebarHandle";
import { SIDEBAR_DEFAULT, loadWidths, saveWidths, type Sidebar, type SidebarWidths } from "./sidebars";
import { workingFor } from "./composerStatus";
import { approvalSnapshot, dueEscalations, escalationKey, openCards, subscribeApprovals } from "./approvals";
import { UNDO_MS, closeNeedsConfirm, closeQuestion, loadedPanes, paneSection, quitQuestion, removeCounts, removeProjectQuestion, removeQuestion, restoredLayouts, savedLayouts, savedPanes, stillRunning } from "./closing";
import { activeAfter, addFolders, listedPanes, openThreadIds, pickWorkspaceFolder, removeWorkspacePanes, renameWorkspace, reopenThreads, setHidden, shownWorkspaces } from "./workspaces";
import type { AgentInfo, AppSection, AppSession, Layout, Pane, PaneStatus, ParticipantConfig, ThreadStatus, Workspace } from "./types";

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
  /** Code or Threads, whichever was used last; a workspace clicked in Agents opens there. */
  const [lastDeck, setLastDeck] = useState<"code" | "threads">("threads");
  useEffect(() => { if (section !== "agents") setLastDeck(section); }, [section]);
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
  const { workspaces, panes, importedHostSessions } = records;
  const setWorkspaces = useCallback((next: Workspace[] | ((old: Workspace[]) => Workspace[])) => setRecords(r => ({ ...r, workspaces: typeof next === "function" ? next(r.workspaces) : next })), []);
  const setPanes = useCallback((next: Pane[] | ((old: Pane[]) => Pane[])) => setRecords(r => ({ ...r, panes: typeof next === "function" ? next(r.panes) : next })), []);
  const sessionRef = useRef<AppSession | null>(null);
  const [migrationNotice, setMigrationNotice] = useState("");
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);

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
      setDetailsOpen(saved?.threadDetailsOpen ?? false);
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

  const currentSession: AppSession = { version: 1, workspaces, panes: savedPanes(panes), profiles, activeWorkspace, focusedPane, section, layout, layouts: savedLayouts(layouts, workspaces.map(w => w.id)), threadDetailsOpen: detailsOpen, threadDetailsCollapsed: detailsCollapsed, importedHostSessions, canvasVersion: 1 };
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
    const session = sessionRef.current!;
    // Keep writes in order so a slow old save cannot overwrite newer state.
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => backend.sessionSave(session));
    saveQueue.current.then(() => setStorageError(""), (error) => setStorageError(`Could not save changes: ${String(error)}`));
  }, [backend, workspaces, panes, profiles, activeWorkspace, focusedPane, section, layout, layouts, detailsOpen, detailsCollapsed, importedHostSessions]);

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
  const listed = useMemo(() => listedPanes(panes, workspaces), [panes, workspaces]);
  const visiblePanes = useMemo(() => canvasPanes(panes, workspaces, deleting, section), [panes, workspaces, deleting, section]);
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
    if (preset !== "grid") setLayout(preset);
    setMaximized(null);
  };
  const shownList = shownWorkspaces(workspaces);
  const current = shownList.find((w) => w.id === activeWorkspace) ?? null;

  /** Put a removed workspace back on the list and show it. Its threads come back closed. */
  const bringBack = (id: string) => {
    setWorkspaces((list) => setHidden(list, id, false));
    setActiveWorkspace(id);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-workspace="${id}"]`)?.focus());
  };

  const hostNameFor = (hostId: string) => { try { return backend?.machines?.connection(hostId).get().name ?? hostId; } catch { return hostId; } };
  const backendFor = (pane: Pane): Backend => {
    if (!backend) throw new Error("The backend is not ready yet.");
    const { hostId } = paneDestination(pane, workspaces);
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

  /** Take a workspace off the list. Nothing is deleted: its threads stay saved
   *  and closed, and its terminals end. Asks first only while something in it runs. */
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

  const forkThread = async (source: Pane, title: string, upto: number | null) => {
    const id = newId("pane");
    if (!backend) throw new Error("The backend is not ready yet.");
    await backendFor(source).roomFork(source.id, id, upto);
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
    // Archived threads are put away: they don't flag the app either.
    const live = Object.keys(attention).filter((id) => listed.some((p) => p.id === id && !p.archived));
    if (live.length !== Object.keys(attention).length) {
      setAttention((all) => Object.fromEntries(Object.entries(all).filter(([id]) => listed.some((p) => p.id === id && !p.archived))));
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
    return { workspace, hostId: workspace ? workspaceHost(workspace) : "local" };
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
    const { workspace, hostId } = hostOfPane(pane);
    const found = agentsOn(hostId);
    const items = paneMenuItems(pane.kind, { running: isRunning(runs[pane.id]), installed: toolInstalled(pane.agent, found), tool: toolName(pane.agent, found), folder: workspace?.path ?? "" }, { address: pane.url ?? "" }, { pinned: pane.pinned, unread: pane.unread, mac: isMac });
    const ssh = hostId === "local" ? undefined : hostList.find((h) => h.id === hostId)?.ssh;
    return items.map((item) => ({
      key: item.action, label: item.label, disabled: item.disabled, reason: item.reason, danger: item.danger, separated: item.separated, keys: item.keys,
      submenu: item.submenu ? copyMenuItems({ hasReply: !!threadStatus[pane.id]?.hasReply, path: folderCopyText(workspace?.path ?? "", ssh), id: pane.id })
        .map((c) => ({ key: c.kind, label: c.label, side: c.side, disabled: c.disabled, reason: c.reason, onSelect: () => copyFromThread(pane, c.kind) })) : undefined,
      onSelect: item.submenu ? undefined : () => runPaneMenu(pane, item.action, from),
    }));
  };

  /** Run what was chosen in a project's ⋯ menu. */
  const runProjectMenu = (workspace: Workspace, action: ProjectMenuAction) => {
    if (action === "pin") setWorkspaces((list) => toggleProjectPin(list, workspace.id));
    else if (action === "edit") setRenameRequests((all) => ({ ...all, [workspace.id]: (all[workspace.id] ?? 0) + 1 }));
    else if (action === "connection") setSettingsOpen("hosts");
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
    if (pane.closed || pane.unread || pane.archived) setPanes((list) => list.map((p) => {
      if (p.id !== pane.id) return p;
      const { unread: _read, archived: _out, ...rest } = p;
      return { ...rest, closed: false };
    }));
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
    } else if (action.kind === "thread") {
      // ⌥⌘R, ⌥⌘P, ⇧⌘U and ⇧⌘A act on the thread in use, as its ⋯ menu would.
      const pane = panes.find((p) => p.id === focusedPane && p.kind === "chat");
      if (pane) runPaneMenu(pane, action.action, "head");
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
          onDecide={async (room, request, approve) => {
            const pane = panes.find(p => p.id === room); const card = openCards(room).find(c => c.request === request);
            if (!pane || !card) throw new Error("That approval is no longer available.");
            const b = backendFor(pane);
            if ((card.hostId ?? "local") !== (b.host?.id ?? "local") || (card.action.expires_at != null && card.action.expires_at <= Date.now())) throw new Error("That approval is no longer available.");
            await b.roomDecide(room, request, approve, false);
          }}
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
        />}</HostAgents>}
        <button className={settingsOpen ? "icon active" : "icon"} onClick={() => setSettingsOpen((open) => (open ? null : "general"))} aria-label="Settings" title="Settings (⌘,)" aria-pressed={!!settingsOpen}><DeckIcon name="settings" /></button>
        {section === "threads" && <button ref={detailsToggle} className="icon" onClick={() => detailsOpen ? closeDetails() : showDetails()} aria-label={detailsOpen ? "Hide thread details" : "Show thread details"} title={detailsOpen ? "Hide thread details" : "Show thread details"} aria-expanded={detailsOpen} aria-controls="thread-details"><DeckIcon name="sidebar" /></button>}
        </div>
      </header>

      {migrationNotice && <div className="connection-banner" role="status">{migrationNotice}<button onClick={() => setMigrationNotice("")}>Dismiss</button></div>}
      {storageError && <div className="storage-error" role="alert">{storageError}</div>}
      <div className="body" ref={bodyRef}>
        {railOpen && (
          <ProjectSidebar
            backend={backend}
            section={section}
            panes={panes}
            workspaces={workspaces}
            deleting={deleting}
            activeWorkspace={activeWorkspace}
            focusedPane={focusedPane}
            hosts={hostList}
            attention={attention}
            threadStatus={threadStatus}
            statusOf={statusOf}
            programOf={programOf}
            paneRename={railRename}
            workspaceRename={renameRequests}
            paneMenu={(pane) => paneMenuEntries(pane, "rail")}
            projectMenu={projectMenuEntries}
            onOpenPane={focusPane}
            onTogglePin={(pane) => runPaneMenu(pane, "pin", "rail")}
            onRenamePane={renamePane}
            onRenameWorkspace={(id, name) => setWorkspaces((list) => renameWorkspace(list, id, name))}
            onProjectClick={(workspace) => {
              // In Agents a project opens on the deck; elsewhere its row folds like Codex's.
              if (section === "agents") { setActiveWorkspace(workspace.id); setSection(lastDeck); }
              else setWorkspaces((list) => setCollapsed(list, workspace.id, !workspace.collapsed));
            }}
            onProjectPin={(workspace) => setWorkspaces((list) => toggleProjectPin(list, workspace.id))}
            onNewIn={newIn}
            onAddWorkspace={(hostId) => addWorkspace(undefined, hostId)}
            onManageHosts={() => setSettingsOpen("hosts")}
            onBringBack={bringBack}
            onRestore={restoreArchived}
            style={sidebarWidths.rail === null ? undefined : { width: sidebarWidths.rail }}
          />
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
          {section !== "agents" && current && (picking || visiblePanes.length === 0) && (creationBackend
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
                  data-pane-id={pane.id} data-host-id={workspace ? workspaceHost(workspace) : "missing"}
                  className={`pane ${pane.id === focusedPane ? "focused" : ""} ${paneDrag.dragging === pane.id ? "lifted" : ""}`}
                  style={visible && rect ? paneStyle(rect) : { display: "none" }}
                  onMouseDown={() => { setFocusedPane(pane.id); setActiveWorkspace(pane.workspaceId); if (pane.unread) setPanes((list) => setUnread(list, pane.id, false)); }}
                >
                  <div className="pane-head" onPointerDown={(event) => paneDrag.begin(pane.id, event)} title={[workspace?.name, maximized || visiblePanes.length < 2 ? "" : "Drag onto another pane to move it"].filter(Boolean).join(" · ")}>
                    <span className={`dot ${status}`} title={status} />
                    <ThreadName className="pane-title" title={pane.title} onRename={title => renamePane(pane.id, title)} renameRequest={renameRequests[pane.id]} label={pane.kind === "chat" ? "Thread name" : pane.kind === "preview" ? "Preview name" : "Terminal name"} />
                    <span className="pane-project" title={workspace?.path}>{workspace?.name}</span>
                    {paneBackend?.host && paneBackend.host.id !== "local" && <span className="pane-machine" title={paneBackend.host.name}>{paneBackend.host.name}</span>}
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
                      <ChatPane onStatus={onThreadStatus} onCopy={onThreadCopy} menuRequest={threadRequests[pane.id]} onMenuDone={(id) => setThreadRequests((all) => all[pane.id]?.id === id ? { ...all, [pane.id]: undefined } : all)} onSeen={onThreadSeen} details={detailsHost} onFork={(title, upto) => forkThread(pane, title, upto)} pane={pane} cwd={workspace?.path ?? ""} workspaceName={workspace?.name ?? ""} agents={hostAgents} backend={paneBackend} profiles={profiles} disabledProviders={disabledProviders} newThread={settings.newThread} newBotAccess={settings.newBotAccess} confirmSteer={settings.confirmSteer} onConfirmSteer={(confirmSteer) => setSettings((s) => ({ ...s, confirmSteer }))} onProfilesChange={setProfiles} focused={pane.id === focusedPane && visible && !picking && !settingsOpen} onActivity={onActivity} onSignal={onSignal} onApprovals={onApprovals} onServer={onServer} onPreview={(address, auto) => openPreview(address, pane.id, auto)} />
                    )}</HostPane>}
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
          <aside id="thread-details" tabIndex={-1} ref={setDetailsSlot} role={overlayDetails ? "dialog" : undefined} className={`thread-details ${overlayDetails ? "overlay" : "docked"}`} style={{ width: overlayDetails ? `min(${detailsWidth}px, 100%)` : detailsWidth }} aria-label="Thread details">
          </aside>
        </>}
        {/* Over the deck, not instead of it: terminals and threads keep running underneath. */}
        {settingsOpen && <SettingsPage section={settingsOpen} onSection={setSettingsOpen} settings={settings} onChange={setSettings} agents={agents} profiles={profiles} backend={backend} onClose={closeSettings} />}
      </div>
      {question && <ConfirmDialog question={question} onCancel={() => setQuestion(null)} />}
      <PathPrompt backend={backend} />
      <ModOverlays />
      {headMenu && (() => {
        const pane = panes.find((p) => p.id === headMenu.id);
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
