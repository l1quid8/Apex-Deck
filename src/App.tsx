import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getBackend, type Backend } from "./backend";
import { ProviderSettings } from "./ProviderSettings";
import { providerEnabled } from "./providers";
import { ThreadName } from "./ThreadName";
import { ChatPane } from "./ChatPane";
import { startHub } from "./hub";
import { SectionNavigation } from "./SectionNavigation";
import { AgentsSection } from "./AgentsSection";
import { DeckIcon } from "./DeckIcon";
import { TerminalPane } from "./TerminalPane";
import { grid, leafIds, mainAndStack, rects, sync, validate, type LayoutNode, type Rect } from "./layout";
import { Dividers, paneStyle, usePaneDrag } from "./PaneLayout";
import { label, summarize, type Attention, type Signal } from "./attention";
import { AttentionMenu, type AttentionItem } from "./AttentionMenu";
import type { AgentInfo, AppSection, AppSession, Layout, Pane, PaneStatus, ParticipantConfig, Workspace } from "./types";

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

export function App() {
  const [section, setSection] = useState<AppSection>("threads");
  const [disabledProviders, setDisabledProviders] = useState<string[]>([]);
  const [managingProviders, setManagingProviders] = useState(false);
  const [profiles, setProfiles] = useState<ParticipantConfig[]>([]);
  const [storageError, setStorageError] = useState("");
  const saveQueue = useRef(Promise.resolve());
  const [backend, setBackend] = useState<Backend | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(loadWorkspaces);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  const [panes, setPanes] = useState<Pane[]>([]);
  const [focusedPane, setFocusedPane] = useState<string | null>(null);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>("top");
  /** How the panes of each workspace section are arranged. */
  const [layouts, setLayouts] = useState<Record<string, LayoutNode>>({});
  /** True while a divider is being dragged. */
  const [resizing, setResizing] = useState(false);
  const gridArea = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [exited, setExited] = useState<Set<string>>(new Set());
  const [, setTick] = useState(0);
  /** Panes that want attention, by pane id. */
  const [attention, setAttention] = useState<Record<string, Signal>>({});
  const lastOutput = useRef(new Map<string, number>());

  useEffect(() => {
    let alive = true;
    getBackend().then(async (b) => {
      await startHub(b);
      const found = await b.detectAgents().catch(() => []);
      const folders = await b.startupFolders().catch(() => []);
      const saved = await b.sessionLoad();
      if (!alive) return;
      setAgents(found);
      const known = saved?.workspaces ?? loadWorkspaces();
      setWorkspaces(known);
      setPanes((saved?.panes ?? []).filter((p) => p.kind === "chat" && known.some((w) => w.id === p.workspaceId)));
      setProfiles(saved?.profiles ?? []);
      setDisabledProviders(saved?.disabledProviders ?? []);
      setSection(saved?.section ?? "threads");
      setLayout(saved?.layout ?? "top");
      // A layout that cannot be read is dropped and rebuilt from the panes.
      const arranged: Record<string, LayoutNode> = {};
      for (const [key, value] of Object.entries(saved?.layouts ?? {})) {
        const tree = validate(value);
        if (tree) arranged[key] = tree;
      }
      setLayouts(arranged);
      setActiveWorkspace(saved?.activeWorkspace ?? known[0]?.id ?? null);
      setFocusedPane(saved?.focusedPane ?? null);
      if (folders.length > 0) {
        // Open folders named on the command line, reusing any already listed.
        const added = folders
          .filter((path) => !known.some((w) => w.path === path))
          .map((path) => ({ id: newId("ws"), name: folderName(path), path }));
        const all = [...known, ...added];
        setWorkspaces(all);
        setActiveWorkspace(all.find((w) => w.path === folders[0])?.id ?? null);
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
    // Terminals are not restored, so only the arrangement of threads is kept.
    const kept = Object.fromEntries(Object.entries(layouts).filter(([key]) => key.endsWith(":threads") && workspaces.some((w) => key === layoutKey(w.id, "threads"))));
    const session: AppSession = { version: 1, workspaces, panes: panes.filter((p) => p.kind === "chat"), profiles, disabledProviders, activeWorkspace, focusedPane, section, layout, layouts: kept };
    // Keep writes in order so a slow old save cannot overwrite newer state.
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => backend.sessionSave(session));
    saveQueue.current.then(() => setStorageError(""), (error) => setStorageError(`Could not save changes: ${String(error)}`));
  }, [backend, workspaces, panes, profiles, disabledProviders, activeWorkspace, focusedPane, section, layout, layouts]);

  useEffect(() => {
    if (activeWorkspace && workspaces.some((w) => w.id === activeWorkspace)) return;
    setActiveWorkspace(workspaces[0]?.id ?? null);
  }, [workspaces, activeWorkspace]);

  // Re-render once a second so status dots fall back to idle.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const onActivity = useCallback((paneId: string) => {
    lastOutput.current.set(paneId, Date.now());
  }, []);
  const onExit = useCallback((paneId: string) => {
    setExited((set) => new Set(set).add(paneId));
  }, []);

  const statusOf = (pane: Pane): PaneStatus => {
    if (attention[pane.id]) return attention[pane.id].kind;
    if (exited.has(pane.id)) return "exited";
    const last = lastOutput.current.get(pane.id) ?? 0;
    return Date.now() - last < WORKING_WINDOW_MS ? "working" : "idle";
  };

  const visiblePanes = useMemo(() => panes.filter((p) => p.workspaceId === activeWorkspace && (section === "code" ? p.kind === "terminal" : section === "threads" && p.kind === "chat")), [panes, activeWorkspace, section]);
  const shown = maximized && visiblePanes.some((p) => p.id === maximized) ? visiblePanes.filter((p) => p.id === maximized) : visiblePanes;

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
  const current = workspaces.find((w) => w.id === activeWorkspace) ?? null;

  const addWorkspace = async () => {
    if (!backend) return;
    let path = "";
    let name = "";
    if (backend.demo) {
      name = `workspace-${workspaces.length + 1}`;
    } else {
      const picked = await backend.pickFolder();
      if (!picked) return;
      const existing = workspaces.find((w) => w.path === picked);
      if (existing) return setActiveWorkspace(existing.id);
      path = picked;
      name = folderName(picked);
    }
    const workspace = { id: newId("ws"), name, path };
    setWorkspaces((list) => [...list, workspace]);
    setActiveWorkspace(workspace.id);
  };

  const removeWorkspace = async (id: string) => {
    try {
      for (const pane of panes.filter((p) => p.workspaceId === id && p.kind === "chat")) await backend?.roomDelete(pane.id);
    } catch (error) { setStorageError(String(error)); return; }
    setPanes((list) => list.filter((p) => p.workspaceId !== id));
    setWorkspaces((list) => list.filter((w) => w.id !== id));
  };

  const renamePane = (id: string, title: string) => setPanes(list => list.map(p => p.id === id ? {...p, title} : p));

  const addPane = (kind: Pane["kind"], title: string, agent?: string) => {
    if (!activeWorkspace) return;
    const pane: Pane = { id: newId("pane"), workspaceId: activeWorkspace, kind, title, agent };
    setPanes((list) => [...list, pane]);
    setFocusedPane(pane.id);
    setSection(kind === "chat" ? "threads" : "code");
    setMaximized(null);
    setPicking(false);
  };

  // A pane the person is looking at right now does not need flagging,
  // except a terminal that is blocked on a question: its dot should say so.
  const watched = useRef<(paneId: string) => boolean>(() => false);
  watched.current = (paneId) => focusedPane === paneId && !picking && visiblePanes.some((p) => p.id === paneId) && (!maximized || maximized === paneId) && document.hasFocus();
  const kindOf = useRef<(paneId: string) => Pane["kind"] | undefined>(() => undefined);
  kindOf.current = (paneId) => panes.find((p) => p.id === paneId)?.kind;

  const onSignal = useCallback((paneId: string, kind: Attention | null, note = "") => {
    if (kind && watched.current(paneId) && !(kind === "needs_input" && kindOf.current(paneId) === "terminal")) return;
    setAttention((all) => {
      if (!kind) {
        if (!all[paneId]) return all;
        const { [paneId]: _cleared, ...rest } = all;
        return rest;
      }
      const old = all[paneId];
      if (old && old.kind === kind && old.note === note) return all;
      return { ...all, [paneId]: { kind, note, at: Date.now() } };
    });
  }, []);

  // Looking at a pane settles its flag. A terminal that is still waiting on
  // an answer keeps its flag until something is typed into it.
  const [windowFocus, setWindowFocus] = useState(0);
  useEffect(() => {
    const seen = () => setWindowFocus((n) => n + 1);
    window.addEventListener("focus", seen);
    return () => window.removeEventListener("focus", seen);
  }, []);
  useEffect(() => {
    if (!focusedPane || !watched.current(focusedPane)) return;
    setAttention((all) => {
      const flag = all[focusedPane];
      if (!flag || (flag.kind === "needs_input" && kindOf.current(focusedPane) === "terminal")) return all;
      const { [focusedPane]: _seen, ...rest } = all;
      return rest;
    });
  }, [focusedPane, activeWorkspace, section, picking, maximized, windowFocus, attention]);

  // Flags for panes that no longer exist are dropped, and the app's icon
  // shows how many are left. A new flag raised while the app is in the
  // background also draws the eye to the icon.
  const flagged = useRef(0);
  useEffect(() => {
    const live = Object.keys(attention).filter((id) => panes.some((p) => p.id === id));
    if (live.length !== Object.keys(attention).length) {
      setAttention((all) => Object.fromEntries(Object.entries(all).filter(([id]) => panes.some((p) => p.id === id))));
      return;
    }
    const grew = live.length > flagged.current;
    flagged.current = live.length;
    backend?.flagAttention(live.length, grew && !document.hasFocus()).catch(() => {});
  }, [attention, panes, backend]);

  const attentionItems: AttentionItem[] = panes
    .filter((pane) => attention[pane.id])
    .map((pane) => ({
      paneId: pane.id,
      title: pane.title,
      workspace: workspaces.find((w) => w.id === pane.workspaceId)?.name ?? "",
      where: pane.kind === "chat" ? "Threads" : "Code",
      signal: attention[pane.id],
    }));
  const sectionFlags = {
    code: summarize(attentionItems.filter((i) => i.where === "Code").map((i) => i.signal)),
    threads: summarize(attentionItems.filter((i) => i.where === "Threads").map((i) => i.signal)),
  };

  const closePane = async (id: string) => {
    if (panes.find((p) => p.id === id)?.kind === "chat") {
      try { await backend?.roomDelete(id); } catch (error) { setStorageError(String(error)); return; }
    }
    setPanes((list) => list.filter((p) => p.id !== id));
    lastOutput.current.delete(id);
    if (maximized === id) setMaximized(null);
    if (focusedPane === id) setFocusedPane(null);
  };

  const focusPane = (pane: Pane) => {
    setActiveWorkspace(pane.workspaceId);
    setSection(pane.kind === "chat" ? "threads" : "code");
    setPicking(false);
    setFocusedPane(pane.id);
    if (maximized && maximized !== pane.id) setMaximized(null);
  };

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
        <button className="icon" onClick={() => setRailOpen((open) => !open)} aria-label={railOpen ? "Hide workspaces" : "Show workspaces"} title={railOpen ? "Hide workspaces" : "Show workspaces"}>
          <DeckIcon name="sidebar" />
        </button>
        <span className="brand">
          <img className="brand-mark" src="/branding/mark.svg" alt="" width="28" height="28" />
          Apex Deck
        </span>
        {backend.demo && <span className="badge" title="Browser preview only. Terminals and model replies are simulated.">Preview mode</span>}
        <SectionNavigation section={section} flags={sectionFlags} onChange={(next) => { setSection(next); setPicking(false); setMaximized(null); }} />
        <span className="spacer" />
        <AttentionMenu items={attentionItems} onOpen={(paneId) => { const pane = panes.find((p) => p.id === paneId); if (pane) focusPane(pane); }} />
        <button className="ghost" onClick={() => setManagingProviders((open) => !open)} aria-expanded={managingProviders}>Providers</button>
        {section !== "agents" && (
          <div className="layout-presets" role="group" aria-label="Arrange panes">
            <button onClick={() => arrange("grid")} disabled={visiblePanes.length < 2} title="Even grid" aria-label="Arrange as an even grid">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" /><rect x="9" y="1.5" width="5.5" height="5.5" rx="1" /><rect x="1.5" y="9" width="5.5" height="5.5" rx="1" /><rect x="9" y="9" width="5.5" height="5.5" rx="1" /></svg>
            </button>
            <button onClick={() => arrange("top")} disabled={visiblePanes.length < 2} title="Large pane on top, the rest below" aria-label="Arrange with a large pane on top">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="7.5" rx="1" /><rect x="1.5" y="11" width="5.5" height="3.5" rx="1" /><rect x="9" y="11" width="5.5" height="3.5" rx="1" /></svg>
            </button>
            <button onClick={() => arrange("left")} disabled={visiblePanes.length < 2} title="Large pane on the left, the rest beside it" aria-label="Arrange with a large pane on the left">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="7.5" height="13" rx="1" /><rect x="11" y="1.5" width="3.5" height="5.5" rx="1" /><rect x="11" y="9" width="3.5" height="5.5" rx="1" /></svg>
            </button>
          </div>
        )}
        {section !== "agents" && <button className="primary" onClick={() => setPicking(true)} disabled={!current}>
          {section === "threads" ? "+ New thread" : "+ New terminal"}
        </button>}
      </header>

      {managingProviders && <ProviderSettings agents={agents} disabled={disabledProviders} onChange={setDisabledProviders} onClose={() => setManagingProviders(false)} />}
      {storageError && <div className="storage-error" role="alert">{storageError}</div>}
      <div className="body">
        {railOpen && section !== "agents" && (
          <aside className="rail">
            <div className="rail-head">
              <span>Workspaces</span>
              <button className="icon" onClick={addWorkspace} aria-label="Add workspace" title="Add a folder">
                +
              </button>
            </div>
            {workspaces.length === 0 && <p className="muted rail-empty">Add a folder to get started.</p>}
            {workspaces.map((workspace) => {
              const own = panes.filter((p) => p.workspaceId === workspace.id && p.kind === (section === "code" ? "terminal" : "chat"));
              return (
                <div key={workspace.id} className="ws">
                  <div className={`ws-row ${workspace.id === activeWorkspace ? "active" : ""}`}>
                    <button className="ws-name" onClick={() => setActiveWorkspace(workspace.id)} title={workspace.path || workspace.name}>
                      <DeckIcon name="folder" size={16} /><span className="ws-label">{workspace.name}</span>
                      {own.length > 0 && <span className="count">{own.length}</span>}
                      {(() => {
                        const inside = panes.filter((p) => p.workspaceId === workspace.id && attention[p.id]).map((p) => attention[p.id]);
                        const { count, worst } = summarize(inside);
                        return count > 0 ? <span className={`flag-count ${worst ?? ""}`} title={`${count} want attention in this workspace`}>{count}</span> : null;
                      })()}
                    </button>
                    <button className="icon small" onClick={() => removeWorkspace(workspace.id)} aria-label={`Remove ${workspace.name}`} title="Remove from list (closes its panes, keeps the folder)">
                      ×
                    </button>
                  </div>
                  {own.map((pane) => (
                    <div role="button" tabIndex={0} key={pane.id} onKeyDown={e => {if(e.key === "Enter") focusPane(pane);}} className={`pane-row ${pane.id === focusedPane ? "focused" : ""}`} onClick={() => focusPane(pane)}>
                      <span className={`dot ${statusOf(pane)}`} title={statusOf(pane)} />
                      <ThreadName className="pane-row-title" title={pane.title} onRename={title => renamePane(pane.id, title)} />
                      {attention[pane.id] && <span className={`flag ${attention[pane.id].kind}`} title={attention[pane.id].note}>{label(attention[pane.id].kind)}</span>}
                    </div>
                  ))}
                </div>
              );
            })}
          </aside>
        )}

        <main className={`canvas section-${section}`}>
          {section === "agents" && <AgentsSection agents={agents} backend={backend} profiles={profiles} disabledProviders={disabledProviders} onChange={setProfiles} />}
          {section !== "agents" && !current && (
            <div className="picker">
              <img className="welcome-logo" src="/branding/mark.svg" alt="" width="80" height="80" />
              <span className="eyebrow">Your workspace for what's next</span>
              <h2>One deck. Every perspective.</h2>
              <p className="muted">Bring your models, conversations, and terminals together. Start with a project folder and make it yours.</p>
              <button className="primary" onClick={addWorkspace}>
                <DeckIcon name="folder" /> Add a workspace <DeckIcon name="arrow" size={16} />
              </button>
              <div className="welcome-capabilities"><span>01 / Agents</span><span>02 / Code</span><span>03 / Threads</span></div>
            </div>
          )}
          {section !== "agents" && current && (picking || visiblePanes.length === 0) && picker}

          {/* Every pane of every workspace stays mounted so its session keeps
              running. Panes outside the current view are only hidden. */}
          <div ref={gridArea} className={`grid ${resizing || paneDrag.dragging ? "adjusting" : ""}`} style={{ display: section !== "agents" && current && !picking && visiblePanes.length > 0 ? "block" : "none" }}>
            {panes.map((pane) => {
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
                  <div className="pane-head" onPointerDown={(event) => paneDrag.begin(pane.id, event)} title={maximized || visiblePanes.length < 2 ? undefined : "Drag onto another pane to move it"}>
                    <span className={`dot ${status}`} title={status} />
                    {pane.kind === "chat" ? <ThreadName className="pane-title" title={pane.title} onRename={title => renamePane(pane.id, title)} /> : <span className="pane-title">{pane.title}</span>}
                    <span className="pane-folder">{workspace?.name}</span>
                    {attention[pane.id] && <span className={`flag ${attention[pane.id].kind}`}>{attention[pane.id].note || label(attention[pane.id].kind)}</span>}
                    <span className="spacer" />
                    <button className="icon small" onClick={() => setMaximized((m) => (m === pane.id ? null : pane.id))} aria-label={maximized === pane.id ? "Restore layout" : "Maximize pane"} title={maximized === pane.id ? "Restore layout" : "Maximize"}>
                      {maximized === pane.id ? "▣" : "□"}
                    </button>
                    <button className="icon small" onClick={() => closePane(pane.id)} aria-label={pane.kind === "chat" ? "Delete thread" : "Close pane"} title={pane.kind === "chat" ? "Delete this saved thread" : "Close (ends what is running in it)"}>
                      ×
                    </button>
                  </div>
                  <div className="pane-body">
                    {pane.kind === "terminal" ? (
                      <TerminalPane pane={pane} cwd={workspace?.path ?? ""} backend={backend} focused={pane.id === focusedPane && visible} onActivity={onActivity} onExit={onExit} onSignal={onSignal} />
                    ) : (
                      <ChatPane pane={pane} cwd={workspace?.path ?? ""} agents={agents} backend={backend} profiles={profiles} disabledProviders={disabledProviders} onProfilesChange={setProfiles} focused={pane.id === focusedPane && visible} onActivity={onActivity} onSignal={onSignal} />
                    )}
                  </div>
                </section>
              );
            })}
            {!maximized && <Dividers tree={tree} area={gridArea} onChange={setTree} onActive={setResizing} />}
            {paneDrag.preview && <div className="drop-preview" style={paneStyle(paneDrag.preview)} />}
          </div>
        </main>
      </div>
    </div>
  );
}
