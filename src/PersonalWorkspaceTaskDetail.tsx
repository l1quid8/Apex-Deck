import { useState } from 'react';
import { personalTaskForRow, type WorkspaceTaskRow } from './workspaceTasks.ts';
import { TASK_STATUS, type PersonalLane } from './personalAssistant.ts';

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
  return <article aria-label="Personal task details">
    <h3>{task.goal}</h3><p>{TASK_STATUS[task.status]}</p>
    {task.completionCriteria.length > 0 && <section><h4>Completion criteria</h4><ul>{task.completionCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul></section>}
    {task.operation && <section><h4>Operation</h4><p>{task.operation.host} · {task.operation.cwd}</p><pre>{task.operation.argv.join(' ')}</pre></section>}
    {task.lastUpdate && <p>{task.lastUpdate}</p>}
    {receipt && <section><h4>Latest receipt</h4><p>{receipt.phase}{receipt.exitCode !== undefined ? ` · Exit ${receipt.exitCode}` : ''}</p><pre>{receipt.outputExcerpt}</pre>{receipt.note && <p>{receipt.note}</p>}</section>}
    {decision && <section><h4>Waiting for your decision</h4><p>{decision.prompt}</p><div className="personal-panels-actions"><button type="button" disabled={locked} onClick={() => void act(() => lane.decide(decision.id, decision.paramsHash, true))}>Approve</button><button type="button" disabled={locked} onClick={() => void act(() => lane.decide(decision.id, decision.paramsHash, false))}>Dismiss</button></div></section>}
    {!['done', 'failed', 'cancelled'].includes(task.status) && <button type="button" disabled={locked} onClick={() => void act(() => lane.cancel(task.id))}>Cancel task</button>}
    {error && <p role="alert">{error}</p>}
  </article>;
}
