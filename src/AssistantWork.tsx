import type { ReactNode } from 'react';
import type { WorkItem, assistantWorkItems } from './assistantStatus';

const STATUS_WORDS: Record<string, string> = {
  needsYou: 'Needs you', needs_you: 'Needs you', ready_for_review: 'Ready for review', needs_clarification: 'Question', proposed: 'Proposed', blocked: 'Blocked',
  failed: 'Failed', interrupted: 'Failed', running: 'Working', queued: 'Queued', waiting: 'Waiting', applying: 'Applying', done: 'Done', cancelled: 'Cancelled',
};
const when = (atMs: number) => new Date(atMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function row(item: WorkItem, onOpenTask: (item: WorkItem) => void, action?: string) {
  const meta = [item.projectName, item.worker].filter(Boolean).join(' · ');
  return <div className="assistant-work-row" key={item.key} data-status={item.status}>
    <div className="assistant-work-row-main">
      <strong>{item.title}</strong>
      <span className="assistant-work-row-meta">{STATUS_WORDS[item.status] ?? item.status}{meta ? ` · ${meta}` : ''} · {when(item.atMs)}</span>
    </div>
    {action && <button type="button" className="primary" onClick={() => onOpenTask(item)}>{action}</button>}
  </div>;
}

/** Everything an assistant is doing, most urgent first: what needs you, what
 *  is running, its projects, then what finished (folded away). */
export function AssistantWork({ items, projects, onOpenTask }: { items: ReturnType<typeof assistantWorkItems>; projects: ReactNode; onOpenTask: (item: WorkItem) => void }) {
  const finishedCount = items.finished.length + items.cancelled.length;
  return <div className="assistant-work">
    <section className="assistant-work-section" aria-labelledby="assistant-work-needs">
      <h2 id="assistant-work-needs" data-state="needs_you">Needs you<span>{items.needsYou.length}</span></h2>
      {items.needsYou.length ? items.needsYou.map(item => row(item, onOpenTask, 'Review')) : <p className="assistant-work-empty">Nothing is waiting on you.</p>}
    </section>
    <section className="assistant-work-section" aria-labelledby="assistant-work-working">
      <h2 id="assistant-work-working">Working<span>{items.working.length}</span></h2>
      {items.working.length ? items.working.map(item => row(item, onOpenTask)) : <p className="assistant-work-empty">Nothing running. New tasks you start in Chat show up here.</p>}
    </section>
    <section className="assistant-work-section" aria-labelledby="assistant-work-projects">
      <h2 id="assistant-work-projects">Projects</h2>
      {projects}
    </section>
    <details className="assistant-work-finished">
      <summary><h2>Finished<span>{finishedCount}</span></h2></summary>
      {items.finished.map(item => row(item, onOpenTask))}
      {items.cancelled.length > 0 && <p className="assistant-work-cancelled">{items.cancelled.length} cancelled {items.cancelled.length === 1 ? 'task' : 'tasks'}</p>}
    </details>
  </div>;
}
