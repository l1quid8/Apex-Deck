import { useState } from 'react';
import { personalTaskForRow, type WorkspaceTaskRow } from './workspaceTasks.ts';
import { TASK_STATUS, type PersonalLane } from './personalAssistant.ts';
import './assistant-projects.css';

/** The lane is resolved by the row's immutable AssistantRef, never by view selection. */
export function PersonalWorkspaceTaskDetail({ row, lane }: { row: WorkspaceTaskRow; lane: Pick<PersonalLane, 'assistant' | 'offline' | 'decide' | 'cancel'> | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const task = personalTaskForRow(row, lane?.assistant ?? null);
  if (!lane || !task) return <p role="status">This task is no longer available from its owning assistant.</p>;
  const receipt = task.receipts.at(-1);
  const decision = task.decision?.status === 'open' ? task.decision : null;
  const locked = busy || row.offline || lane.offline;
  const act = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  return <div className="assistant-projects"><article className="assistant-project-detail assistant-personal-task-detail" aria-label="Personal task details">
    <header className="assistant-task-heading"><div><p className="assistant-task-phase">Task details</p><h2 className="assistant-project-title">{task.goal}</h2></div><span className="assistant-project-status" data-state={task.status}>{TASK_STATUS[task.status]}</span></header>
    {task.operation&&<dl className="assistant-task-scope"><div><dt>Machine</dt><dd>{task.operation.host}</dd></div><div><dt>Folder</dt><dd>{task.operation.cwd}</dd></div></dl>}
    {task.lastUpdate&&task.lastUpdate!==receipt?.outputExcerpt&&<p>{task.lastUpdate}</p>}
    {receipt?.outputExcerpt&&<section className="assistant-task-result-body"><h3>Result</h3><pre>{receipt.outputExcerpt}</pre></section>}
    {task.completionCriteria.length > 0 && <section className="assistant-task-criteria"><h3>Completion criteria</h3><ul>{task.completionCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul></section>}
    {decision&&<section className="assistant-task-review"><h3>Waiting for your decision</h3><p>{decision.prompt}</p><div className="assistant-task-commandbar"><button className="primary assistant-task-primary" type="button" disabled={locked} onClick={() => void act(() => lane.decide(decision.id, decision.paramsHash, true))}>Approve</button><button type="button" disabled={locked} onClick={() => void act(() => lane.decide(decision.id, decision.paramsHash, false))}>Dismiss</button></div></section>}
    {!['done', 'failed', 'cancelled'].includes(task.status)&&<div className="assistant-task-commandbar"><details className="assistant-task-actions-menu"><summary>Task actions</summary><div className="assistant-task-menu-content"><button type="button" disabled={locked} onClick={() => void act(() => lane.cancel(task.id))}>Cancel task</button></div></details></div>}
    {(task.operation||receipt)&&<details><summary>Operation and receipts</summary>{task.operation&&<><h3>Operation</h3><pre>{task.operation.argv.join(' ')}</pre></>}{receipt&&<><h3>Latest receipt</h3><p>{receipt.phase}{receipt.exitCode !== undefined ? ` · Exit ${receipt.exitCode}` : ''}</p>{receipt.note&&<p>{receipt.note}</p>}</>}</details>}
    {error&&<p role="alert">{error}</p>}
  </article></div>;

}
