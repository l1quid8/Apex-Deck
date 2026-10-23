import type { ReactNode } from 'react';
import type { WorkItem, assistantWorkItems } from './assistantStatus';
import './assistant-work.css';

const STATUS_WORDS: Record<string, string> = {
  needsYou: 'Needs you', needs_you: 'Needs you', ready_for_review: 'Ready for review', needs_clarification: 'Question', proposed: 'Proposed', blocked: 'Blocked',
  failed: 'Failed', interrupted: 'Failed', running: 'Working', queued: 'Queued', waiting: 'Waiting', applying: 'Applying', paused: 'Paused', done: 'Done', cancelled: 'Cancelled',
};
const primary = (status: string) => status === 'proposed' || status === 'needsYou' ? 'Review plan' : status === 'needs_clarification' ? 'Answer question' : ['needs_you','blocked','failed','interrupted'].includes(status) ? 'Review options' : status === 'ready_for_review' ? 'Review result' : status === 'paused' ? 'Resume' : status === 'done' ? 'View result' : 'View task';
const cancellable = (status: string) => !['done','cancelled','failed','interrupted'].includes(status);
export type AssistantWorkProps = {
  items: ReturnType<typeof assistantWorkItems>; projects: ReactNode; onOpenTask: (item: WorkItem) => void;
  onCancelTask?: (item: WorkItem) => void; onDeleteTask?: (item: WorkItem) => void; onRestoreTask?: (item: WorkItem) => void;
  projectCount?: number; projectsOpen?: boolean; onProjectsToggle?: () => void; onNewTask?: () => void; newTaskDisabledReason?: string;
  onEmptyDeleted?: (keys: string[]) => void; lifecycleDisabled?: boolean; lifecycleProblem?: string;
};

/** One openable task identity in every state, with lifecycle actions owned by the host. */
export function AssistantWork({ items, projects, onOpenTask, onCancelTask, onDeleteTask, onRestoreTask, onEmptyDeleted, lifecycleDisabled = false, lifecycleProblem, projectCount=0, projectsOpen=false, onProjectsToggle, onNewTask, newTaskDisabledReason }: AssistantWorkProps) {
  const deleted = items.deleted ?? [];
  const finishedCount = items.finished.length + items.cancelled.length;
  function row(item: WorkItem, isDeleted = false) {
    const meta = [item.projectName, item.worker].filter(Boolean).join(' · ');
    return <div className="assistant-work-row" key={item.key} data-status={item.status}>
      <div className="assistant-work-row-main">{isDeleted?<strong>{item.title}</strong>:<button type="button" className="assistant-work-title" onClick={()=>onOpenTask(item)}>{item.title}</button>}<span className="assistant-work-row-meta"><span className="assistant-work-row-status">{STATUS_WORDS[item.status] ?? item.status}</span>{meta && <span>{meta}</span>}</span></div>
      {isDeleted ? <button type="button" disabled={lifecycleDisabled || !onRestoreTask} onClick={() => onRestoreTask?.(item)}>Restore</button> : <>
        <button type="button" className="assistant-work-next" onClick={() => onOpenTask(item)}>{primary(item.status)}</button>
        <details className="assistant-work-actions"><summary aria-label={`Actions for ${item.title}`}>•••</summary>
          <div className="assistant-work-menu">{cancellable(item.status) && <button type="button" disabled={lifecycleDisabled || !onCancelTask} onClick={() => onCancelTask?.(item)}>Cancel task</button>}
          <button type="button" disabled={lifecycleDisabled || !onDeleteTask} onClick={() => onDeleteTask?.(item)}>{cancellable(item.status) ? 'Cancel and delete' : 'Delete'}</button></div>
        </details>
      </>}
    </div>;
  }
  return <div className="assistant-work">
    {lifecycleProblem && <p role="status">{lifecycleProblem}</p>}
    <header className="assistant-work-heading"><div><h2>Your tasks</h2><p>Decisions first. Everything else stays out of the way.</p></div><button type="button" className="primary" disabled={!onNewTask||!!newTaskDisabledReason} title={newTaskDisabledReason} onClick={onNewTask}>+ New task</button></header>
    {!!items.needsYou.length&&<section className="assistant-work-section" aria-labelledby="assistant-work-needs"><h3 id="assistant-work-needs">Needs you<span>{items.needsYou.length}</span></h3>{items.needsYou.map(item => row(item))}</section>}
    {!!items.working.length&&<section className="assistant-work-section" aria-labelledby="assistant-work-working"><h3 id="assistant-work-working">In progress<span>{items.working.length}</span></h3>{items.working.map(item => row(item))}</section>}
    {!items.needsYou.length&&!items.working.length&&<p className="assistant-work-caught-up">You’re caught up. Start a task whenever you’re ready.</p>}
    <details className="assistant-work-finished"><summary><span>History<small>Finished &amp; cancelled</small></span><span className="assistant-work-drawer-count">{finishedCount}<i aria-hidden="true">⌄</i></span></summary>{items.finished.map(item => row(item))}{items.cancelled.map(item => row(item))}{!finishedCount&&<p className="assistant-work-empty">No finished tasks yet.</p>}</details>
    <section className="assistant-work-projects"><button type="button" className="assistant-work-drawer-trigger" aria-expanded={projectsOpen} aria-controls="assistant-work-project-management" onClick={onProjectsToggle}><span>Projects<small>Folders this assistant can use</small></span><span className="assistant-work-drawer-count">{projectCount}<i aria-hidden="true">⌄</i></span></button><div id="assistant-work-project-management">{projects}</div></section>
    <details className="assistant-work-deleted"><summary>Deleted tasks{deleted.length?` (${deleted.length})`:""}</summary>
      <p>Restoring cancelled work keeps it cancelled. Project files and saved project notes stay in place.</p>
      {deleted.map(item => row(item, true))}
      {!deleted.length && <p className="assistant-work-empty">No deleted tasks.</p>}
      <button type="button" disabled={lifecycleDisabled || !onEmptyDeleted || !deleted.length} onClick={() => {
        if (window.confirm(`Permanently delete ${deleted.length} deleted ${deleted.length === 1 ? 'task' : 'tasks'}? This cannot be undone. Project files and saved project notes stay in place.`)) onEmptyDeleted?.(deleted.map(item => item.key));
      }}>Empty deleted tasks ({deleted.length})</button>
    </details>
  </div>;
}
