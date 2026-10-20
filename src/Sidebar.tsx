import { useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Backend, HostEntry } from "./backend";
import type { AppSection, Pane, PaneStatus, ThreadStatus, Workspace } from "./types";
import { label as flagLabel, workspaceFlag, type Signal } from "./attention";
import { workspaceHost } from "./hostSession.ts";
import type { HostConnectionStore } from "./hostConnections";
import { ageWords, hostTints, projectGroups, sidebarSections, twinPath, type ProjectBlock } from "./sidebarModel.ts";
import { DOT_WORDS, dotState } from "./hostFacts.ts";
import { MenuList, type MenuAnchor, type MenuEntry } from "./Menu";
import { HoverCard, ProjectCard, ThreadCard, useHoverCard } from "./HoverCards";
import { Glyph, ProjectFolder } from "./SidebarIcons";
import { DeckIcon } from "./DeckIcon";
import { ThreadName } from "./ThreadName";
import { WorkspaceHostMenu } from "./WorkspaceHostMenu";

// The rail, as in Codex: Pinned, Projects and Recents. Projects mixes This
// Mac's folders and servers' folders in host groups. App owns the data and the actions; this
// draws them and keeps the rail's own menus and hover cards.

export interface ProjectSidebarProps {
  backend: Backend;
  section: AppSection;
  panes: Pane[];
  workspaces: Workspace[];
  deleting: ReadonlySet<string>;
  activeWorkspace: string | null;
  focusedPane: string | null;
  hosts: HostEntry[];
  attention: Record<string, Signal>;
  /** ApexAgent blockers per project; these stay until resolved, not until read. */
  monitorAttention?: Record<string, { blocking: boolean; signal: Signal | null }>;
  threadStatus: Record<string, ThreadStatus>;
  statusOf(pane: Pane): PaneStatus;
  programOf(pane: Pane): string;
  /** Bumped to rename a row in place. */
  paneRename: Record<string, number>;
  workspaceRename: Record<string, number>;
  paneMenu(pane: Pane): MenuEntry[];
  projectMenu(workspace: Workspace): MenuEntry[];
  onOpenPane(pane: Pane): void;
  onTogglePin(pane: Pane): void;
  onRenamePane(id: string, title: string): void;
  onRenameWorkspace(id: string, name: string): void;
  onProjectClick(workspace: Workspace): void;
  onProjectPin(workspace: Workspace): void;
  onReorderProject(sourceId: string, targetId: string, after: boolean): void;
  onNewIn(workspace: Workspace): void;
  onAddWorkspace(hostId: string): Promise<void>;
  onManageHosts(): void;
  appearanceOpen: boolean;
  settingsOpen: boolean;
  onOpenAppearance(): void;
  onOpenSettings(): void;
  onRestore(pane: Pane): void;
  style?: CSSProperties;
}

type OpenMenu = { kind: "pane" | "project" | "archived"; id: string; anchor: MenuAnchor; opener: HTMLElement | null };

const noStore = { subscribe: () => () => {}, get: () => null };

/** A server's name and connection dot, beside its project's name. */
function HostTag({ store, name }: { store?: HostConnectionStore; name: string }) {
  const source = store ?? noStore;
  const state = useSyncExternalStore(source.subscribe, source.get);
  const dot = state ? dotState(state.status) : "idle";
  return <span className="host-tag">
    <span className="host-name" title={name}>{name}</span>
    <span className={`hdot ${dot}`} role="img" aria-label={DOT_WORDS[dot]} title={`${name}: ${DOT_WORDS[dot]}`} />
  </span>;
}

/** Slide a long title along while the pointer is on its row. */
function marquee(row: HTMLElement) {
  const title = row.querySelector<HTMLElement>(".pane-row-clip > .pane-row-title");
  const clip = title?.parentElement;
  if (!title || !clip) return;
  const extra = title.scrollWidth - clip.clientWidth;
  row.style.setProperty("--shift", extra > 0 ? `${-extra - 2}px` : "0px");
}

const menuKey = (event: ReactKeyboardEvent) => event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

export function ProjectSidebar(props: ProjectSidebarProps) {
  const { backend, section, panes, workspaces, deleting, hosts } = props;
  const lists = useMemo(() => sidebarSections(panes, workspaces, section, deleting), [panes, workspaces, section, deleting]);
  const groups = useMemo(() => projectGroups(lists.projects, hosts.map(h => h.id)), [lists.projects, hosts]);
  const tints = useMemo(() => hostTints(hosts.filter((h) => h.remote).map((h) => h.id)), [hosts]);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [collapsedHosts, setCollapsedHosts] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const dragSource = useRef<string | null>(null);
  const pendingDrop = useRef<{ id: string; after: boolean } | null>(null);
  const [moveStatus, setMoveStatus] = useState("");
  const hover = useHoverCard();
  const rail = useRef<HTMLElement>(null);
  const now = Date.now();

  const hostName = (hostId: string) => {
    if (hostId === "local") return "This Mac";
    const saved = hosts.find((h) => h.id === hostId)?.name;
    if (saved) return saved;
    try { return backend.machines?.connection(hostId).get().name ?? hostId; } catch { return hostId; }
  };
  const storeOf = (hostId: string): HostConnectionStore | undefined => {
    try { return backend.machines?.connection(hostId); } catch { return undefined; }
  };
  const open = (next: OpenMenu) => { hover.hide(); setMenu(next); };
  const toggle = (kind: OpenMenu["kind"], id: string, button: HTMLElement) =>
    menu?.kind === kind && menu.id === id ? setMenu(null) : open({ kind, id, anchor: { rect: button.getBoundingClientRect() }, opener: button });

  const clearDrop = () => { pendingDrop.current = null; setDropTarget(null); };
  const endDrag = () => { dragSource.current = null; setDragging(null); clearDrop(); };
  const reorder = (source: Workspace, target: Workspace, after: boolean) => {
    props.onReorderProject(source.id, target.id, after);
    setMoveStatus(`${source.name} moved ${after ? "after" : "before"} ${target.name} on ${hostName(workspaceHost(source))}.`);
  };
  const neighbors = (workspace: Workspace) => {
    const own = (groups.find(g => g.hostId === workspaceHost(workspace))?.projects ?? [])
      .filter(p => !!p.workspace.pinned === !!workspace.pinned);
    const i = own.findIndex(p => p.workspace.id === workspace.id);
    return { up: own[i - 1]?.workspace, down: own[i + 1]?.workspace };
  };
  const moveProject = (workspace: Workspace, direction: "up" | "down") => {
    const target = neighbors(workspace)[direction];
    if (target) reorder(workspace, target, direction === "down");
  };

  const row = (pane: Pane, where: "pinned" | "project" | "recent") => {
    const flat = where !== "project";
    const workspace = workspaces.find((w) => w.id === pane.workspaceId);
    const hostId = workspace ? workspaceHost(workspace) : "local";
    const status = props.statusOf(pane);
    const flag = props.attention[pane.id];
    const program = props.programOf(pane);
    const lit = menu?.kind === "pane" && menu.id === pane.id;
    const more = (el: HTMLElement) => el.querySelector<HTMLElement>(".row-more");
    const kindName = pane.kind === "chat" ? "Thread name" : pane.kind === "preview" ? "Preview name" : "Terminal name";
    const title = <ThreadName className="pane-row-title" title={pane.title} onRename={(name) => props.onRenamePane(pane.id, name)} renameRequest={where === "recent" ? undefined : props.paneRename[pane.id]} label={kindName} />;
    return (
      <div role="button" tabIndex={0} key={`${where}:${pane.id}`} data-pane-row={pane.id}
        draggable={pane.kind === "chat" && !!workspace}
        onDragStart={(event) => {
          if (pane.kind !== "chat" || !workspace) return;
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData("application/x-apex-agent-source", JSON.stringify({ workspaceId: workspace.id, hostId, cwd: workspace.path, kind: "thread", sourceId: pane.id }));
        }}
        className={["pane-row", flat && "flat", pane.id === props.focusedPane && !pane.closed && "focused", pane.closed && "closed", !pane.closed && "on-canvas", pane.unread && "unread", lit && "lit"].filter(Boolean).join(" ")}
        title={pane.closed ? "Closed. Click to open it again." : undefined}
        onClick={() => props.onOpenPane(pane)}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); open({ kind: "pane", id: pane.id, anchor: { x: event.clientX, y: event.clientY }, opener: more(event.currentTarget) }); }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter") { event.preventDefault(); props.onOpenPane(pane); }
          else if (menuKey(event)) {
            event.preventDefault();
            const button = more(event.currentTarget);
            if (button) open({ kind: "pane", id: pane.id, anchor: { rect: button.getBoundingClientRect() }, opener: button });
          }
        }}
        onMouseEnter={(event) => { marquee(event.currentTarget); if (pane.kind === "chat") hover.enter("thread", pane.id, event.currentTarget); }}
        onMouseLeave={hover.leave}>
        <span className={`dot ${status}`} title={status} />
        {pane.kind === "chat" ? <span className="pane-row-clip">{title}</span> : title}
        {program && <span className="program-title">· {program}</span>}
        {flag && <span className={`flag ${flag.kind}`} title={flag.note}>{flagLabel(flag.kind)}</span>}
        {pane.unread && <span className="unread-mark" role="img" aria-label="Unread" title="Unread" />}
        {flat && hostId !== "local" && <span className="globe-end" title={hostName(hostId)} style={{ color: tints.get(hostId) }}><Glyph name="globe" size={14} /></span>}
        <span className="row-acts" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <button className="act row-more" aria-label={`More for ${pane.title}`} aria-haspopup="menu" aria-expanded={lit} title="More"
            onClick={(event) => toggle("pane", pane.id, event.currentTarget)}><Glyph name="dots" size={15} /></button>
          <button className={`act ${pane.pinned ? "on" : ""}`} aria-label={pane.pinned ? `Unpin ${pane.title}` : `Pin ${pane.title}`} title={pane.pinned ? "Unpin" : "Pin"}
            onClick={() => props.onTogglePin(pane)}><Glyph name="pin" size={13} /></button>
        </span>
      </div>
    );
  };

  const project = ({ workspace, panes: own }: ProjectBlock) => {
    const hostId = workspaceHost(workspace);
    const remote = hostId !== "local";
    const twin = twinPath(workspace, workspaces);
    const folded = !!workspace.collapsed;
    const lit = menu?.kind === "project" && menu.id === workspace.id;
    const inside = panes
      .filter((p) => p.workspaceId === workspace.id && props.attention[p.id] && !deleting.has(p.id) && !p.archived)
      .map((p) => ({ where: p.kind === "chat" ? "Threads" as const : "Code" as const, signal: props.attention[p.id] }));
    const monitorSignal = props.monitorAttention?.[workspace.id]?.signal;
    if (monitorSignal) inside.push({ where: "Threads", signal: monitorSignal });
    const flag = workspaceFlag(inside, section === "code" ? "Code" : section === "threads" ? "Threads" : null);
    const more = (el: HTMLElement) => el.querySelector<HTMLElement>(".project-more");
    const newWhat = section === "code" ? "terminal" : "thread";
    return (
      <div key={workspace.id} className="ws">
        <div className={`ws-row ${workspace.id === props.activeWorkspace ? "active" : ""} ${lit ? "lit" : ""} ${dragging === workspace.id ? "project-dragging" : ""} ${dropTarget?.id === workspace.id ? dropTarget.after ? "project-drop-after" : "project-drop-before" : ""}`} data-host-id={hostId}
          onDragOver={(event) => {
            const source = workspaces.find(w => w.id === dragSource.current && !w.hidden);
            if (!source || source.id === workspace.id || workspaceHost(source) !== hostId || !!source.pinned !== !!workspace.pinned) { clearDrop(); return; }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            const next = { id: workspace.id, after: event.clientY > rect.top + rect.height / 2 };
            pendingDrop.current = next;
            if (dropTarget?.id !== next.id || dropTarget.after !== next.after) setDropTarget(next);
          }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearDrop(); }}
          onDrop={(event) => {
            const source = workspaces.find(w => w.id === dragSource.current && !w.hidden);
            const target = pendingDrop.current;
            if (source && target?.id === workspace.id && workspaceHost(source) === hostId && !!source.pinned === !!workspace.pinned) {
              event.preventDefault();
              event.stopPropagation();
              reorder(source, workspace, target.after);
            }
            endDrag();
          }}
          onMouseEnter={(event) => hover.enter("project", workspace.id, event.currentTarget)} onMouseLeave={hover.leave}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); open({ kind: "project", id: workspace.id, anchor: { x: event.clientX, y: event.clientY }, opener: more(event.currentTarget) }); }}>
          {/* A div, not a button, so the name inside can be renamed in place. */}
          <div role="button" tabIndex={0} data-workspace={workspace.id} className="ws-name" title={workspace.path || workspace.name}
            draggable
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            onDragStart={(event) => {
              if ((event.target as HTMLElement).closest("input, textarea")) { event.preventDefault(); return; }
              hover.hide(); setMenu(null); dragSource.current = workspace.id; setDragging(workspace.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-apex-project-order", workspace.id);
            }}
            onDragEnd={endDrag}
            aria-expanded={!folded}
            aria-label={[workspace.name, remote ? `on ${hostName(hostId)}` : "", flag?.title].filter(Boolean).join(", ")}
            onClick={() => props.onProjectClick(workspace)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); moveProject(workspace, event.key === "ArrowUp" ? "up" : "down"); }
              else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onProjectClick(workspace); }
              else if (event.key === "F2") { event.preventDefault(); props.projectMenu(workspace).find((e) => e.key === "edit")?.onSelect?.(); }
              else if (menuKey(event)) {
                event.preventDefault();
                const button = more(event.currentTarget.parentElement!);
                if (button) open({ kind: "project", id: workspace.id, anchor: { rect: button.getBoundingClientRect() }, opener: button });
              }
            }}>
            <ProjectFolder open={!folded} tint={remote ? tints.get(hostId) : undefined} />
            <span className={`ws-label ${twin ? "two" : ""}`}>
              <ThreadName className="ws-title" title={workspace.name} label="Project name" tooltip={workspace.path || workspace.name} renameRequest={props.workspaceRename[workspace.id]} onRename={(name) => props.onRenameWorkspace(workspace.id, name)} />
              {twin && <span className="twin" title={workspace.path}>{twin}</span>}
            </span>
            {remote && <HostTag store={storeOf(hostId)} name={hostName(hostId)} />}
            {flag && <span className={`flag-count ${flag.worst ?? ""}`} title={flag.title} aria-label={flag.title}>{flag.text}</span>}
          </div>
          <span className="row-acts">
            <button className="act project-more" aria-label={`More for ${workspace.name}`} aria-haspopup="menu" aria-expanded={lit} title="More"
              onClick={(event) => toggle("project", workspace.id, event.currentTarget)}><Glyph name="dots" size={15} /></button>
            {section !== "agents" && <button className="act" aria-label={`New ${newWhat} in ${workspace.name}`} title={`New ${newWhat} in ${workspace.name}`}
              onClick={() => props.onNewIn(workspace)}><Glyph name="newIn" size={14} /></button>}
          </span>
        </div>
        {!folded && (own.length > 0 ? own.map((p) => row(p, "project")) : (section === "code" || section === "threads") ? <div className="no-threads">{section === "code" ? "No terminals" : "No threads"}</div> : null)}
      </div>
    );
  };

  const menuEntries = (): MenuEntry[] => {
    if (!menu) return [];
    if (menu.kind === "pane") { const pane = panes.find((p) => p.id === menu.id); return pane ? props.paneMenu(pane) : []; }
    if (menu.kind === "project") {
      const w = workspaces.find((x) => x.id === menu.id);
      if (!w) return [];
      const near = neighbors(w);
      return [...props.projectMenu(w),
        { key: "move-up", label: "Move up", keys: "⌥↑", separated: true, disabled: !near.up, onSelect: () => moveProject(w, "up") },
        { key: "move-down", label: "Move down", keys: "⌥↓", disabled: !near.down, onSelect: () => moveProject(w, "down") }];
    }
    return lists.archived.map((pane) => ({ key: pane.id, label: pane.title, side: workspaces.find((w) => w.id === pane.workspaceId)?.name ?? "", onSelect: () => props.onRestore(pane) }));
  };

  const card = () => {
    const target = hover.target;
    if (!target || menu) return null;
    const left = (rail.current?.getBoundingClientRect().right ?? 0) + 6;
    const frame = (children: React.ReactNode) => <HoverCard left={left} top={target.top} onEnter={hover.keep} onLeave={hover.leave}>{children}</HoverCard>;
    if (target.kind === "project") {
      const w = workspaces.find((x) => x.id === target.id);
      if (!w) return null;
      const hostId = workspaceHost(w);
      const remote = hostId !== "local";
      const threads = panes.filter((p) => p.workspaceId === w.id && p.kind === "chat" && !p.archived && !deleting.has(p.id)).length;
      return frame(<ProjectCard name={w.name} path={w.path} remote={remote} hostName={hostName(hostId)} tint={tints.get(hostId) ?? ""} threads={threads}
        pinned={!!w.pinned} store={remote ? storeOf(hostId) : undefined} folder={<ProjectFolder tint={remote ? tints.get(hostId) : undefined} size={14} />}
        onPin={() => props.onProjectPin(w)} onRetry={() => storeOf(hostId)?.retryNow()} onConnect={() => { try { backend.machines?.get(hostId); } catch { /* removed meanwhile */ } }} />);
    }
    const pane = panes.find((p) => p.id === target.id);
    const w = pane && workspaces.find((x) => x.id === pane.workspaceId);
    if (!pane || !w) return null;
    const hostId = workspaceHost(w);
    const remote = hostId !== "local";
    return frame(<ThreadCard title={pane.title} project={w.name} hostName={hostName(hostId)} remote={remote} tint={tints.get(hostId) ?? ""} twin={twinPath(w, workspaces)}
      age={pane.activeAt ? ageWords(now - pane.activeAt) : ""} who={props.threadStatus[pane.id]?.who ?? []} folder={<ProjectFolder tint={remote ? tints.get(hostId) : undefined} size={14} />} />);
  };

  return (
    <aside ref={rail} className="rail" style={props.style} onScroll={hover.hide}>
      {lists.pinned.length > 0 && <>
        <div className="rail-sec" data-sec="pinned">Pinned</div>
        {lists.pinned.map((pane) => row(pane, "pinned"))}
      </>}
      <div className="rail-sec" data-sec="projects">
        <button className="rail-sec-toggle" aria-expanded={projectsOpen} onClick={() => setProjectsOpen((was) => !was)}>
          Projects <Glyph name={projectsOpen ? "chevDown" : "chevRight"} size={12} />
        </button>
        <WorkspaceHostMenu backend={backend} choose={props.onAddWorkspace} manage={props.onManageHosts} />
      </div>
      {projectsOpen && (lists.projects.length === 0 ? <p className="muted rail-empty">Add a folder to get started.</p> : groups.map(group => {
        const folded = collapsedHosts.has(group.hostId);
        return <section className="project-host-group" data-project-host={group.hostId} key={group.hostId} aria-label={`${hostName(group.hostId)} projects`}>
          <button type="button" className="project-host-toggle" aria-expanded={!folded} onClick={() => {
            hover.hide(); endDrag();
            setCollapsedHosts(old => { const next = new Set(old); if (next.has(group.hostId)) next.delete(group.hostId); else next.add(group.hostId); return next; });
          }}>
            <Glyph name={folded ? "chevRight" : "chevDown"} size={12} />
            <span className="project-host-name" title={hostName(group.hostId)}>{hostName(group.hostId)}</span>
            <span className="project-host-count">{group.projects.length}</span>
          </button>
          {!folded && group.projects.map(project)}
        </section>;
      }))}
      <span className="project-order-status" role="status">{moveStatus}</span>
      {lists.recents.length > 0 && <>
        <div className="rail-sec" data-sec="recents">Recents</div>
        {lists.recents.map((pane) => row(pane, "recent"))}
      </>}
      {lists.archived.length > 0 && (
        <div className="rail-foot">
          <span className="rail-foot-item">
            <span>Archived ({lists.archived.length})</span><span aria-hidden="true">·</span>
            <button className="ghost" aria-label="Show archived threads" aria-haspopup="menu" aria-expanded={menu?.kind === "archived"} onClick={(event) => toggle("archived", "archived", event.currentTarget)}>Show</button>
          </span>
        </div>
      )}
      <div className="rail-controls" aria-label="Preferences">
        <span className="rail-version" title={`Apex Deck ${__APP_VERSION__}`}>Apex Deck <span>{__APP_VERSION__}</span></span>
        <button className={props.appearanceOpen ? "icon active" : "icon"} onClick={props.onOpenAppearance} aria-label="Appearance" title="Appearance" aria-pressed={props.appearanceOpen}>
          <DeckIcon name="moon" />
        </button>
        <button className={props.settingsOpen ? "icon active" : "icon"} onClick={props.onOpenSettings} aria-label="Settings" title="Settings (⌘,)" aria-pressed={props.settingsOpen}>
          <DeckIcon name="settings" />
        </button>
      </div>
      {menu && <MenuList id={`${menu.kind}:${menu.id}`} entries={menuEntries()} anchor={menu.anchor} opener={menu.opener}
        label={menu.kind === "archived" ? "Archived threads" : undefined} onClose={() => setMenu(null)} />}
      {card()}
    </aside>
  );
}
