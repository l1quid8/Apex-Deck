// Threads, as the Quiet List mockup (docs/mockups/phone-threads-quiet-v2.html): plain rows with
// no boxes or borders, one dot per row for its state, and projects under the machine they run on.

import { useRef, type ReactNode } from "react";
import { workspaceHost } from "../hostSession";
import { ageWords, type ProjectBlock, type SidebarSections } from "../sidebarModel";
import type { LinkView } from "../phoneRules";
import type { Pane, Workspace } from "../types";
import { ChevronRight, Pin, Plus } from "./icons";
import { archivedLine, foldChoice, DOT_WORDS, machineGroups, machineNote, recentFirst, strongestDot, threadState, type MachineNote, type ThreadState } from "./threadListRules";

export interface ThreadListProps {
  sections: SidebarSections;
  workspaces: Workspace[];
  links: LinkView[];
  folded: Record<string, boolean>;
  /** The thread being started, with its unsent text: a Draft row in its project. */
  draft: { id: string; workspaceId: string; text: string } | null;
  waiting: Record<string, string[]>;
  busy: Record<string, readonly string[]>;
  nameOf(botId: string): string;
  /** False until the saved threads have been read, so "No threads yet" doesn't flash. */
  loaded: boolean;
  covered: boolean;
  /** Ages are measured from here. */
  now: number;
  machineIcon(hostId: string, size?: number): ReactNode;
  onToggle(id: string): void;
  onOpen(id: string): void;
  /** Absent when this phone may not start threads. */
  onNew?(workspace: Workspace): void;
  /** "New thread" when there are none yet: opens the project picker. Absent when this phone may not start threads. */
  onPick?(): void;
  onThreadMenu(id: string): void;
  onProjectMenu(id: string): void;
  onMachines(): void;
  onRetry(hostId: string): void;
  /** How many threads are archived. The Archived line shows only when this is above zero. */
  archived: number;
  /** Opens the Archived sheet. */
  onArchived?(): void;
}

/** Tap, or hold for a menu as on iOS. `held` stops the tap that ends a hold from also opening the row. */
export function useLongPress() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  return {
    held,
    bind: (fn: () => void) => ({
      onPointerDown: () => { held.current = false; clear(); timer.current = setTimeout(() => { held.current = true; fn(); }, 500); },
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
      onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); clear(); held.current = true; fn(); },
    }),
  };
}

/** The dot is only colour, so it carries its words for VoiceOver unless the row already says them. */
function Dot({ state, said }: { state: ThreadState["dot"]; said: boolean }) {
  if (!state) return null;
  return said ? <i className={`ph-tl-dot ${state}`} aria-hidden="true" /> : <i className={`ph-tl-dot ${state}`} role="img" aria-label={DOT_WORDS[state]} />;
}

export function ThreadList({ sections, workspaces, links, folded, draft, waiting, busy, nameOf, loaded, covered, now, machineIcon, onToggle, onOpen, onNew, onPick, onThreadMenu, onProjectMenu, onMachines, onRetry, archived, onArchived }: ThreadListProps) {
  const press = useLongPress();
  const workspaceOf = (pane: Pane) => workspaces.find((item) => item.id === pane.workspaceId);
  const linkOf = (hostId: string) => links.find((link) => link.id === hostId) ?? null;
  const stateOf = (pane: Pane): ThreadState => {
    const workspace = workspaceOf(pane);
    return threadState({
      down: machineNote(workspace ? linkOf(workspaceHost(workspace)) : null).down,
      waiting: (waiting[pane.id]?.length ?? 0) > 0,
      working: (busy[pane.id] ?? []).map(nameOf),
      unread: Boolean(pane.unread),
    });
  };

  // Inside its project a row only adds what's happening; in Pinned and Recent it also says where.
  const threadRow = (pane: Pane, inside: boolean) => {
    const state = stateOf(pane);
    const workspace = workspaceOf(pane);
    const hostId = workspace ? workspaceHost(workspace) : "local";
    const words = state.words && !(inside && state.tone === "paused") ? state.words : "";
    return (
      <button key={pane.id} type="button" className="ph-tl-thread" aria-haspopup="menu" {...press.bind(() => onThreadMenu(pane.id))} onClick={() => { if (!press.held.current) onOpen(pane.id); }}>
        <Dot state={state.dot} said={Boolean(words)} />
        <span className="ph-tl-l1">
          <span className={`ph-tl-name${pane.unread ? " unread" : ""}`}>{pane.title}</span>
          <span className="ph-tl-age">{pane.activeAt ? ageWords(now - pane.activeAt) : "New"}</span>
        </span>
        {inside ? words && <span className="ph-tl-l2"><span className={`ph-tl-${state.tone}`}>{words}</span></span> : (
          <span className="ph-tl-l2">
            {words && <><span className={`ph-tl-${state.tone}`}>{words}</span><span>in</span></>}
            {hostId !== "local" && machineIcon(hostId, 12)}
            <span className="ph-tl-where">{workspace?.name ?? ""}</span>
          </span>
        )}
      </button>
    );
  };

  const projectBlock = ({ workspace, panes }: ProjectBlock, note: MachineNote) => {
    const threads = panes.filter((pane) => pane.kind === "chat");
    const closed = foldChoice(folded, `project:${workspace.id}`, Boolean(workspace.collapsed));
    const dot = closed && !note.down ? strongestDot(threads.map((pane) => stateOf(pane).dot)) : "";
    const drafting = draft?.workspaceId === workspace.id ? draft : null;
    return (
      <div key={workspace.id} className={`ph-tl-project${closed ? "" : " open"}`}>
        <div className="ph-tl-prow">
          <button type="button" className="ph-tl-p" aria-expanded={!closed} aria-haspopup="menu" {...press.bind(() => onProjectMenu(workspace.id))} onClick={() => { if (!press.held.current) onToggle(`project:${workspace.id}`); }}>
            <Dot state={dot} said={false} />
            <span className="ph-tl-pname">{workspace.name}{workspace.pinned && <span className="ph-tl-pin" role="img" aria-label="Pinned"><Pin size={13} /></span>}</span>
            {closed && <span className="ph-tl-count" aria-label={`${threads.length} ${threads.length === 1 ? "thread" : "threads"}`}>{threads.length}</span>}
            <span className="ph-tl-chev"><ChevronRight size={15} /></span>
          </button>
          {/* + sits where the count was, so the chevron never moves. */}
          {!closed && !note.down && onNew && <button type="button" className="ph-tl-add" aria-label={`New thread in ${workspace.name}`} onClick={() => onNew(workspace)}><Plus size={20} /></button>}
        </div>
        {!closed && (
          <div className="ph-tl-in">
            {drafting && (
              <button type="button" className="ph-tl-thread ph-tl-draft" onClick={() => onOpen(drafting.id)}>
                <span className="ph-tl-l1"><span className="ph-tl-name">{drafting.text.trim().split("\n")[0].slice(0, 40) || "New thread"}</span><span className="ph-tl-age">Draft</span></span>
              </button>
            )}
            {threads.map((pane) => threadRow(pane, true))}
            {threads.length === 0 && !drafting && <p className="ph-tl-none">No threads yet</p>}
          </div>
        )}
      </div>
    );
  };

  const sectionHeading = (key: string, name: string, threads: Pane[], icon?: ReactNode, note?: MachineNote, hostId?: string) => {
    const closed = foldChoice(folded, key);
    return (
      <div className="ph-tl-heading">
        <button type="button" className="ph-tl-p ph-tl-section" aria-expanded={!closed} onClick={() => onToggle(key)}>
          {closed && <Dot state={strongestDot(threads.map((pane) => stateOf(pane).dot))} said={false} />}
          {icon}
          <span className="ph-tl-pname">{name}</span>
          {note?.words && <span className={note.action === "Fix" ? "ph-tl-bad" : note.down ? "ph-tl-warn" : undefined}>{note.words}</span>}
          {closed && <span className="ph-tl-count" aria-label={`${threads.length} threads`}>{threads.length}</span>}
          <span className="ph-tl-chev"><ChevronRight size={15} /></span>
        </button>
        {note?.action && <button type="button" className="ph-tl-retry" aria-label={`${note.action} ${name}`} onClick={() => note.action === "Retry" ? onRetry(hostId!) : onMachines()}>{note.action}</button>}
      </div>
    );
  };

  if (links.length === 0) {
    return (
      <main className="ph-content ph-tl" inert={covered}>
        <div className="ph-tl-empty">
          <img src="/branding/mark.svg" alt="" width="88" height="88" />
          <strong>Pair this phone with your Mac</strong>
          <p>Then pair each server on its own, so a sleeping Mac doesn't cut them off.</p>
          <button type="button" className="primary ph-wide" onClick={onMachines}>Open Machines</button>
        </div>
      </main>
    );
  }

  const groups = machineGroups(sections.projects, (block) => workspaceHost(block.workspace), links);
  const unpinned = sections.projects.flatMap((block) => block.panes.filter((pane) => pane.kind === "chat"));
  const recent = recentFirst(unpinned, stateOf, (pane) => pane.activeAt ?? 0);
  const none = loaded && sections.pinned.length === 0 && unpinned.length === 0 && !draft;
  // Plain text, not a box: it sits at the bottom of both the list and "No threads yet", so every thread stays reachable.
  const archivedLink = archived > 0 && onArchived ? <button type="button" className="ph-tl-archived" onClick={onArchived}>{archivedLine(archived)}</button> : null;


  return (
    <main className="ph-content ph-tl" inert={covered}>
      {none && <div className="ph-tl-empty"><strong>No threads yet</strong><p>{onPick ? "Pick a project to start one." : "Threads started on your Mac show up here."}</p>{onPick && <button type="button" className="primary ph-wide" onClick={onPick}>New thread</button>}</div>}
      {sections.pinned.length > 0 && <>{sectionHeading("section:pinned", "Pinned", sections.pinned)}{!foldChoice(folded, "section:pinned") && sections.pinned.map((pane) => threadRow(pane, false))}</>}
      {recent.length > 0 && <>{sectionHeading("section:recent", "Recent", recent)}{!foldChoice(folded, "section:recent") && recent.map((pane) => threadRow(pane, false))}</>}
      {groups.map((group) => {
        const note = machineNote(group.link);
        return (
          <section key={group.hostId} className={`ph-tl-machine${note.down ? " down" : ""}`} aria-label={group.name}>
            {sectionHeading(`machine:${group.hostId}`, group.name, [...sections.pinned.filter((pane) => { const workspace = workspaceOf(pane); return workspace && workspaceHost(workspace) === group.hostId; }), ...group.projects.flatMap((block) => block.panes.filter((pane) => pane.kind === "chat"))], machineIcon(group.hostId, 14), note, group.hostId)}
            {!foldChoice(folded, `machine:${group.hostId}`) && group.projects.map((block) => projectBlock(block, note))}
          </section>
        );
      })}
      {archivedLink}
    </main>
  );
}
