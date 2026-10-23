import type { ReactNode } from 'react';
import type { WorkItem, assistantWorkItems } from './assistantStatus';
import './assistant-work.css';

const STATUS_WORDS: Record<string, string> = {
  needsYou: 'Needs you', needs_you: 'Needs you', ready_for_review: 'Ready for review', needs_clarification: 'Question', proposed: 'Proposed', blocked: 'Blocked',
  failed: 'Failed', interrupted: 'Failed', running: 'Working', queued: 'Queued', waiting: 'Waiting', applying: 'Applying', paused: 'Paused', done: 'Done', cancelled: 'Cancelled',
};
const when = (atMs: number) => new Date(atMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const primary = (status: string) => status === 'proposed' || status === 'needsYou' ? 'Review plan' : status === 'needs_clarification' ? 'Answer question' : ['needs_you','blocked','failed','interrupted'].includes(status) ? 'Review options' : status === 'ready_for_review' ? 'Review result' : status === 'paused' ? 'Resume' : status === 'done' ? 'View result' : 'View task';
const cancellable = (status: string) => !['done','cancelled','failed','interrupted'].includes(status);
export type AssistantWorkProps = {
  items: ReturnType<typeof assistantWorkItems>; projects: ReactNode; onOpenTask: (item: WorkItem) => void;
  onCancelTask?: (item: WorkItem) => void; onDeleteTask?: (item: WorkItem) => void; onRestoreTask?: (item: WorkItem) => void;
  onEmptyDeleted?: (keys: string[]) => void; lifecycleDisabled?: boolean; lifecycleProblem?: string;
};

/** One openable task identity in every state, with lifecycle actions owned by the host. */
export function AssistantWork({ items, projects, onOpenTask, onCancelTask, onDeleteTask, onRestoreTask, onEmptyDeleted, lifecycleDisabled = false, lifecycleProblem }: AssistantWorkProps) {
  const deleted = items.deleted ?? [];
  const finishedCount = items.finished.length + items.cancelled.length;
  function row(item: WorkItem, isDeleted = false) {
    const meta = [item.projectName, item.worker].filter(Boolean).join(' · ');
    return <div className="assistant-work-row" key={item.key} data-status={item.status}>
      <div className="assistant-work-row-main"><strong>{item.title}</strong><span className="assistant-work-row-meta">{meta && <span>{meta}</span>}<time>{when(item.atMs)}</time></span><span className="assistant-work-row-status">{STATUS_WORDS[item.status] ?? item.status}</span></div>
      {isDeleted ? <button type="button" disabled={lifecycleDisabled || !onRestoreTask} onClick={() => onRestoreTask?.(item)}>Restore</button> : <>
        <button type="button" className="assistant-work-next" onClick={() => onOpenTask(item)}>{primary(item.status)}</button>
        <details className="assistant-work-actions"><summary aria-label={`Actions for ${item.title}`}>Actions</summary>
          <div className="assistant-work-menu">{cancellable(item.status) && <button type="button" disabled={lifecycleDisabled || !onCancelTask} onClick={() => onCancelTask?.(item)}>Cancel task</button>}
          <button type="button" disabled={lifecycleDisabled || !onDeleteTask} onClick={() => onDeleteTask?.(item)}>{cancellable(item.status) ? 'Cancel and delete' : 'Delete'}</button></div>
        </details>
      </>}
    </div>;
  }
  return <div className="assistant-work">
    {lifecycleProblem && <p role="status">{lifecycleProblem}</p>}
    <section className="assistant-work-section" aria-labelledby="assistant-work-needs"><h2 id="assistant-work-needs" data-state="needs_you">Needs you<span>{items.needsYou.length}</span></h2>{items.needsYou.length ? items.needsYou.map(item => row(item)) : <p className="assistant-work-empty">Nothing is waiting on you.</p>}</section>
    <section className="assistant-work-section" aria-labelledby="assistant-work-working"><h2 id="assistant-work-working">Working<span>{items.working.length}</span></h2>{items.working.length ? items.working.map(item => row(item)) : <p className="assistant-work-empty">Nothing running. New tasks you start in Chat show up here.</p>}</section>
    <section className="assistant-work-section" aria-labelledby="assistant-work-projects"><h2 id="assistant-work-projects">Projects</h2>{projects}</section>
    <details className="assistant-work-finished"><summary><h2>Finished<span>{finishedCount}</span></h2></summary>{items.finished.map(item => row(item))}{items.cancelled.length > 0 && <p className="assistant-work-cancelled">{items.cancelled.length} cancelled {items.cancelled.length === 1 ? 'task' : 'tasks'}</p>}{items.cancelled.map(item => row(item))}</details>
    <details className="assistant-work-deleted"><summary><h2>Deleted tasks<span>{deleted.length}</span></h2></summary>
      <p>Restoring cancelled work keeps it cancelled. Project files and saved project notes stay in place.</p>
      {deleted.map(item => row(item, true))}
      {!deleted.length && <p className="assistant-work-empty">No deleted tasks.</p>}
      <button type="button" disabled={lifecycleDisabled || !onEmptyDeleted || !deleted.length} onClick={() => {
        if (window.confirm(`Permanently delete ${deleted.length} deleted ${deleted.length === 1 ? 'task' : 'tasks'}? This cannot be undone. Project files and saved project notes stay in place.`)) onEmptyDeleted?.(deleted.map(item => item.key));
      }}>Empty deleted tasks ({deleted.length})</button>
    </details>
  </div>;
}
