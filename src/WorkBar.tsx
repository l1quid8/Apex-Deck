import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { pickerMatches, type PickerRow, type WorkRow } from "./destinations.ts";
import { fileKind, findFiles, type RecentFile } from "./recentFiles.ts";
import { Glyph, ProjectFolder } from "./SidebarIcons";

// Codex's Work bar, on top of the message box: the project, Files, Tools,
// and at the far right where the thread runs. A thread that hasn't started
// goes wherever it is pointed; one that has shows a lock, and pointing it
// elsewhere asks first (App decides). Popovers open above the bar.

export interface WorkContext {
  project: { id: string; name: string; path: string; hostId: string; hostName: string; tint: string };
  started: boolean;
  /** The project picker's rows, recent first, with each machine's name and colour. */
  picker: { row: PickerRow; hostName: string; tint: string; twin: string }[];
  /** Work in's rows: every machine, one per folder. */
  workRows: (WorkRow & { hostName: string; tint: string; seen: string })[];
  servers: { id: string; name: string; tint: string; offline: boolean }[];
  choose(workspaceId: string): void;
  /** New project: a folder on This Mac, or (with `hostId`) on that server. */
  newProject(hostId?: string): void;
  noProject(): void;
  /** Work in on a machine with no copy yet: pick its folder there. */
  copyOn(hostId: string): void;
  addServer(): void;
  /** The Mac's file picker, for Browse all. */
  browseFile(): Promise<string | null>;
  /** Bumped by ⌥⇧⌘O to open the picker. */
  pickerRequest?: number;
}

export interface WorkTool { token: string; label: string; bot: string }

type Pop = "picker" | "work" | "files" | "tools" | null;

const LAPTOP = <Glyph name="laptop" size={15} />;

/** A searchable list: arrow keys move the highlight, Enter picks it. */
function Searchable<T>({ label, placeholder, items, keyOf, matches, row, onPick, none, children }: {
  label: string; placeholder: string; items: T[]; keyOf(item: T): string; matches(item: T, query: string): boolean;
  row(item: T, lit: boolean): ReactNode; onPick(item: T): void; none: string; children?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [lit, setLit] = useState(0);
  const shown = items.filter((item) => matches(item, query));
  const key = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setLit((at) => (shown.length ? (at + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length : 0));
    } else if (event.key === "Enter" && shown[lit]) { event.preventDefault(); onPick(shown[lit]); }
  };
  return <>
    <div className="search"><Glyph name="search" size={14} />
      <input autoFocus placeholder={placeholder} aria-label={label} spellCheck={false} autoComplete="off" value={query}
        onChange={(event) => { setQuery(event.target.value); setLit(0); }} onKeyDown={key} />
    </div>
    <div className={`list-wrap ${shown.length > 5 ? "fade" : ""}`}>
      <div className="list" role="listbox" aria-label={label}>
        {shown.map((item, i) => <div key={keyOf(item)} onMouseEnter={() => setLit(i)}>{row(item, i === lit)}</div>)}
        {shown.length === 0 && <div className="none">{none}</div>}
      </div>
    </div>
    {children}
  </>;
}

export function WorkBar({ work, attachedCount, files, tools, toolsWhere, canCopyFolder, onAttach, onCopyFolder, onTool }: {
  work: WorkContext;
  attachedCount: number;
  files: RecentFile[];
  tools: WorkTool[];
  /** "on Hetzner-EU" or "on This Mac", for the Tools heading. */
  toolsWhere: string;
  canCopyFolder: boolean;
  onAttach(path: string): void;
  onCopyFolder(): void;
  onTool(token: string): void;
}) {
  const [pop, setPop] = useState<Pop>(null);
  const [serverStep, setServerStep] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Popovers live on the page, not in the pane, so a narrow pane never clips them. They sit just above the bar.
  const [place, setPlace] = useState<CSSProperties>({ position: "fixed", visibility: "hidden" });
  const { project } = work;
  const remote = project.hostId !== "local";
  useEffect(() => { if (work.pickerRequest) { setServerStep(false); setPop("picker"); } }, [work.pickerRequest]);
  useLayoutEffect(() => {
    if (!pop || !root.current) return;
    const bar = root.current.getBoundingClientRect();
    const spot: CSSProperties = { position: "fixed", bottom: window.innerHeight - bar.top + 6, maxHeight: Math.max(160, bar.top - 14), overflowY: "auto" };
    if (pop === "work") spot.right = Math.max(8, window.innerWidth - bar.right);
    else spot.left = Math.max(8, Math.min(bar.left, window.innerWidth - 8 - (popRef.current?.offsetWidth ?? 340)));
    setPlace(spot);
  }, [pop, serverStep]);
  useEffect(() => {
    if (!pop) return;
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !popRef.current?.contains(target)) setPop(null);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPop(null); } };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", away, true); window.removeEventListener("keydown", key, true); };
  }, [pop]);
  const toggle = (next: Pop) => { setServerStep(false); setPop((open) => (open === next ? null : next)); };
  const close = () => setPop(null);
  const globe = (tint: string, size = 14) => <span className="tint" style={{ color: tint }}><Glyph name="globe" size={size} /></span>;

  const picker = () => serverStep ? (
    <div className="proj-picker" role="dialog" aria-label="New server project">
      <div className="head">New server project on</div>
      {work.servers.map((s) => <button key={s.id} className="pk-row" disabled={s.offline} title={s.offline ? `${s.name} can't be reached.` : undefined}
        onClick={() => { close(); work.newProject(s.id); }}>{globe(s.tint, 15)}<span className="nm">{s.name}</span>{s.offline && <span className="off">offline</span>}</button>)}
      {work.servers.length === 0 && <div className="none">No servers yet.</div>}
      <div className="foot"><button className="pk-row" onClick={() => { close(); work.addServer(); }}><Glyph name="plus" size={15} /><span>Add server…</span></button></div>
    </div>
  ) : (
    <div className="proj-picker" role="dialog" aria-label="Projects">
      <Searchable label="Search projects" placeholder="Search projects" items={work.picker} keyOf={(p) => p.row.workspace.id}
        matches={(p, q) => pickerMatches(p.row, p.hostName, q)} none="No projects match."
        onPick={(p) => { if (!p.row.offline || p.row.current) { close(); work.choose(p.row.workspace.id); } }}
        row={(p, lit) => (
          <button className={`pk-row ${lit ? "hl" : ""}`} role="option" aria-selected={p.row.current} data-workspace={p.row.workspace.id}
            disabled={p.row.offline && !p.row.current} title={p.row.workspace.path || "No folder"}
            onClick={() => { close(); work.choose(p.row.workspace.id); }}>
            <ProjectFolder tint={p.row.hostId === "local" ? undefined : p.tint} size={15} />
            <span className="nm">{p.row.workspace.name}</span>
            {p.row.hostId !== "local" && <span className="host">{globe(p.tint, 13)}{p.hostName}</span>}
            {p.twin && <span className="twin">{p.twin}</span>}
            {p.row.current ? <span className="check" aria-label="current">✓</span> : p.row.offline ? <span className="off">offline</span> : null}
          </button>
        )}>
        <div className="foot">
          <button className="pk-row" onClick={() => setServerStep(true)}><Glyph name="globe" size={15} /><span>New server project</span><span className="end"><Glyph name="chevRight" size={14} /></span></button>
          <button className="pk-row" onClick={() => { close(); work.newProject(); }}><Glyph name="plus" size={15} /><span>New project</span></button>
          <button className="pk-row" onClick={() => { close(); work.noProject(); }}><Glyph name="x" size={15} /><span>Don't work in a project</span></button>
        </div>
      </Searchable>
    </div>
  );

  const workIn = () => (
    <div className="pane-menu deck-menu work-menu" role="menu" aria-label="Work in">
      <div className="menu-head">Work in</div>
      {work.started && <div className="menu-note stays"><Glyph name="lock" size={12} /><span>This thread stays on {project.hostName}. Another machine starts a new thread or a fork there.</span></div>}
      {work.workRows.map((r) => {
        const sub = r.offline ? `offline${r.seen ? ` · last reached ${r.seen}` : ""}` : r.workspaceId ? r.path : "no copy yet · choose a folder…";
        return <button key={`${r.hostId}:${r.workspaceId ?? "none"}`} role="menuitemradio" aria-checked={r.current}
          className={r.first ? "" : "copy2"} data-host-id={r.hostId} data-workspace={r.workspaceId ?? ""} disabled={r.offline}
          aria-label={`${r.hostName}, ${sub}`}
          onClick={() => { close(); if (r.current) return; if (r.workspaceId) work.choose(r.workspaceId); else work.copyOn(r.hostId); }}>
          {r.first ? <>{r.hostId === "local" ? LAPTOP : globe(r.tint, 15)}<span className="label">{r.hostName}</span>{r.hostId !== "local" && <span className={`hdot ${r.offline ? "off" : "on"}`} />}</> : <span className="indent" />}
          <span className={`sub ${r.workspaceId ? "" : "nocopy"}`}>{sub}</span>
          {r.current && <span className="check" aria-label="current">✓</span>}
        </button>;
      })}
      <span className="pane-menu-sep" role="separator" />
      <button role="menuitem" onClick={() => { close(); work.addServer(); }}><Glyph name="plus" size={15} /><span className="label">Add server…</span></button>
      <div className="menu-note">{project.path ? `Each machine keeps its own copy of ${project.name}. Edits stay on that machine until you push or pull them.` : "Without a project, a server needs a folder first."}</div>
    </div>
  );

  const filesPop = () => (
    <div className="proj-picker files-pop" role="dialog" aria-label="Files">
      <Searchable label="Search files" placeholder="Search files…" items={files} keyOf={(f) => f.path}
        matches={(f, q) => findFiles([f], q).length > 0} none={files.length ? "No files match." : "Files you drop on a thread or browse to show up here."}
        onPick={(f) => { close(); onAttach(f.path); }}
        row={(f, lit) => (
          <button className={`pk-row ${lit ? "hl" : ""}`} role="option" aria-selected={false} title={f.path} onClick={() => { close(); onAttach(f.path); }}>
            <span className={`file-ico ${fileKind(f.name)}`}><Glyph name={fileKind(f.name) === "img" ? "image" : "doc"} size={15} /></span>
            <span className="nm">{f.name}</span>
          </button>
        )}>
        {remote && <div className="pop-note">{globe(project.tint, 12)}<span>Attached files are copied to {project.hostName} with your message.</span></div>}
        <div className="foot">
          <button className="pk-row" onClick={() => { close(); void work.browseFile().then((path) => { if (path) onAttach(path); }); }}><Glyph name="doc" size={15} /><span>Browse all</span></button>
          <button className="pk-row" disabled={!canCopyFolder} title={canCopyFolder ? undefined : `Folders can't be sent to ${project.hostName}; attach the files in it instead.`}
            onClick={() => { close(); onCopyFolder(); }}><Glyph name="folderPlus" size={15} /><span>Copy a folder in…</span></button>
        </div>
      </Searchable>
    </div>
  );

  const toolsPop = () => (
    <div className="proj-picker tools-pop" role="dialog" aria-label="Tools">
      <Searchable label="Search tools" placeholder="Search tools…" items={tools} keyOf={(t) => `${t.bot}:${t.token}`}
        matches={(t, q) => `${t.label} ${t.token} ${t.bot}`.toLowerCase().includes(q.trim().toLowerCase())}
        none={tools.length ? "No tools match." : "The bots here have no servers, apps or plugins yet."}
        onPick={(t) => { close(); onTool(t.token); }}
        row={(t, lit) => (
          <button className={`pk-row ${lit ? "hl" : ""}`} role="option" aria-selected={false} onClick={() => { close(); onTool(t.token); }}>
            <Glyph name="plug" size={15} /><span className="nm">{t.label}</span><span className="host mono">!{t.token}</span><span className="end">{t.bot}</span>
          </button>
        )}>
        <div className="pop-head">From the bots in this thread, {toolsWhere}</div>
      </Searchable>
    </div>
  );

  return (
    <div className="tray" ref={root}>
      <button type="button" className={`tray-chip proj ${pop === "picker" ? "on" : ""}`} aria-haspopup="dialog" aria-expanded={pop === "picker"}
        aria-label="Change the project for this thread" title="Change the project for this thread (⌥⇧⌘O)" onClick={() => toggle("picker")}>
        <ProjectFolder tint={remote ? project.tint : undefined} size={14} /><span className="pname">{project.name}</span>
      </button>
      <button type="button" className={`tray-chip files ${pop === "files" ? "on" : ""}`} aria-haspopup="dialog" aria-expanded={pop === "files"} title="Attach files" onClick={() => toggle("files")}>
        <Glyph name="doc" size={14} /><span className="lbl">Files</span>{attachedCount > 0 && <span className="count">{attachedCount}</span>}
      </button>
      <button type="button" className={`tray-chip tools ${pop === "tools" ? "on" : ""}`} aria-haspopup="dialog" aria-expanded={pop === "tools"} title="Use a server, app or plugin" onClick={() => toggle("tools")}>
        <Glyph name="plug" size={14} /><span className="lbl">Tools</span>
      </button>
      <span className="tray-gap" />
      <button type="button" className={`tray-chip work ${pop === "work" ? "on" : ""}`} aria-haspopup="menu" aria-expanded={pop === "work"}
        aria-label={`Work in ${project.hostName}`} title={work.started ? `This thread stays on ${project.hostName}` : `Work in ${project.hostName}${project.path ? ` · ${project.path}` : ""}`}
        onClick={() => toggle("work")}>
        {remote ? <>{globe(project.tint)}<span className="lbl">{project.hostName}</span></> : LAPTOP}
        {work.started && <span className="lock"><Glyph name="lock" size={12} /></span>}
      </button>
      {pop && createPortal(<div ref={popRef} className={`tray-pop ${pop}`} style={place}>{pop === "picker" ? picker() : pop === "work" ? workIn() : pop === "files" ? filesPop() : toolsPop()}</div>, document.body)}
    </div>
  );
}
