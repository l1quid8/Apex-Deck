import type { PersonalAssistantRecord, PersonalTask } from './personalAssistant';

/** Existing host timestamps only; absent or inconsistent intervals stay absent. */
export function PersonalTaskTiming({ task, assistant }: { task: PersonalTask; assistant: PersonalAssistantRecord | null }) {
  const eventId = task.fromEvent ?? assistant?.messages?.find(message => message.taskId === task.id && message.eventId)?.eventId;
  const received = assistant?.events?.find(event => event.id === eventId)?.receivedAt;
  const latest = task.receipts.at(-1);
  const intervals = [
    { label: 'Request to plan', start: received, end: task.createdAt },
    { label: 'Waiting to start', start: task.createdAt, end: task.receipts[0]?.opId === `${task.id}-op-1` ? task.receipts[0].startedAt : undefined },
    { label: 'Latest action', start: latest?.startedAt, end: latest?.finishedAt },
  ].flatMap(({ label, start, end }) => start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end) && end >= start ? [{ label, elapsed: end - start }] : []);
  if (!intervals.length) return null;
  return <section aria-label="Task timing"><h3>Timing</h3><dl className="assistant-task-scope">{intervals.map(({ label, elapsed }) => <div key={label}><dt>{label}</dt><dd>{elapsed < 1000 ? `${Math.round(elapsed)} ms` : `${(elapsed / 1000).toFixed(1)} s`}</dd></div>)}</dl></section>;
}
