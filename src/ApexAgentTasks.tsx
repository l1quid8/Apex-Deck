import { useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from './backend.ts';
import type { Pane, ParticipantConfig } from './types.ts';
import type { ProjectMonitor } from './apexAgentModel.ts';
import { archivedTaskIds, assistantMessageArgs, assistantTaskActionArgs, assistantTasksForOwner, canReconcileTask, clearPendingRequest, isTaskOwnedBy, isTerminalTask, loadPendingRequest, retainRequestForRetry, savePendingRequest, shouldSuggestArchive, taskStatusLabel, taskThreadLinks, taskUsageLabel, taskWorkerChoices, type AssistantTask, type AssistantTaskDestination, type AssistantTaskOwner, type AssistantTaskSnapshot, type PendingAssistantRequest } from './assistantTaskModel.ts';
import './assistant-tasks.css';

type Action = 'clarify' | 'approve' | 'dismiss' | 'retry' | 'request_changes' | 'cancel' | 'accept' | 'archive' | 'reconcile';
type Props = {
  backend: Backend;
  owner: AssistantTaskOwner;
  panes: Pane[];
  profiles: ParticipantConfig[];
  onMonitorUpdate?: (monitor: ProjectMonitor) => void;
  onOpenThread?: (id: string) => void;
};

const objectText = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const taskFinal = (status: string) => isTerminalTask(status);
const formatBytes = (bytes: number): string => bytes < 1024 * 1024 ? `${Math.max(0, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const assistantMessageText = (message: unknown): string => {
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    const value = message as { text?: unknown; response?: unknown; content?: unknown };
    for (const candidate of [value.text, value.response, value.content]) if (typeof candidate === 'string') return candidate;
  }
  return message == null ? '' : objectText(message);
};

export function ApexAgentTasks({ backend, owner, panes, profiles, onMonitorUpdate, onOpenThread }: Props) {
  const [tasks, setTasks] = useState<AssistantTask[]>([]);
  const [archivedExecutions, setArchivedExecutions] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [assistantReply, setAssistantReply] = useState('');
  const [draft, setDraft] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [mode, setMode] = useState<'in_place' | 'isolated'>('in_place');
  const [checkCommands, setCheckCommands] = useState('');
  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([]);
  const [clarifications, setClarifications] = useState<Record<string, string>>({});
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [newTaskWorkers, setNewTaskWorkers] = useState<Record<string, string[]>>({});
  const [checks, setChecks] = useState<Record<string, string[]>>({});
  const [pendingRequest, setPendingRequest] = useState<PendingAssistantRequest | null>(null);
  const activeOwner = useRef(owner);
  activeOwner.current = owner;
  const generation = useRef(0);
  const listRequestVersion = useRef(0);
  const snapshotRevision = useRef(-1);
  const requestRef = useRef<PendingAssistantRequest | null>(null);
  const workerProfiles = useMemo(() => taskWorkerChoices(profiles), [profiles]);
  const chatThreads = useMemo(() => panes.filter((pane) => pane.kind === 'chat' && pane.workspaceId === owner.workspaceId && !pane.archived), [panes, owner.workspaceId]);
  const ownerKey = `${owner.workspaceId}\u0000${owner.cwd}\u0000${owner.hostId}\u0000${owner.conversationId}`;

  const currentOwner = (captured: AssistantTaskOwner, version: number) => generation.current === version
    && activeOwner.current.workspaceId === captured.workspaceId && activeOwner.current.cwd === captured.cwd
    && activeOwner.current.hostId === captured.hostId && activeOwner.current.conversationId === captured.conversationId;

  const loadTasks = async (captured = owner, version = generation.current) => {
    if (backend.demo) { if (currentOwner(captured, version)) { setTasks([]); setLoading(false); } return; }
    const listVersion = ++listRequestVersion.current;
    try {
      const snapshot = await backend.call<AssistantTaskSnapshot>('assistant_tasks_list', { owner: captured });
      const visible = assistantTasksForOwner(snapshot, captured);
      if (currentOwner(captured, version) && listRequestVersion.current === listVersion && snapshot.revision >= snapshotRevision.current) { snapshotRevision.current = snapshot.revision; setTasks(visible); setArchivedExecutions(archivedTaskIds(snapshot)); setError(''); }
    } catch (cause) {
      if (currentOwner(captured, version) && listRequestVersion.current === listVersion) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (currentOwner(captured, version) && listRequestVersion.current === listVersion) setLoading(false);
    }
  };

  useEffect(() => {
    const version = ++generation.current;
    const captured = owner;
    listRequestVersion.current++; snapshotRevision.current = -1;
    const recovered = loadPendingRequest(window.localStorage, captured);
    setTasks([]); setArchivedExecutions(new Set()); setBusy(false); setError(''); setAssistantReply(''); setLoading(true); setPendingRequest(recovered); requestRef.current = recovered;
    setDraft(recovered?.text ?? ''); setDestinationId(recovered?.destination?.newThread ? 'new' : recovered?.destination?.threadId ?? ''); setSelectedWorkers(recovered?.newWorkerProfiles.map((profile) => profile.id) ?? []); setMode(recovered?.mode ?? 'in_place'); setCheckCommands((recovered?.checks ?? []).map((argv) => JSON.stringify(argv)).join('\n')); setClarifications({}); setChanges({}); setDestinations({}); setNewTaskWorkers({}); setChecks({});
    void loadTasks(captured, version);
    if (!backend.onAssistantTasksChanged) return () => { generation.current++; };
    let unlisten: (() => void) | undefined;
    let alive = true;
    void backend.onAssistantTasksChanged((payload) => {
      const event = payload as { workspaceId?: string } | null;
      if (alive && (!event?.workspaceId || event.workspaceId === captured.workspaceId)) void loadTasks(captured, version);
    }).then((stop) => { if (alive) unlisten = stop; else stop(); }).catch(() => {});
    return () => { alive = false; generation.current++; unlisten?.(); };
  }, [backend, ownerKey]);

  const sendRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    let pending = requestRef.current;
    if (!pending) {
      if (!draft.trim()) { setError('Write a request before sending.'); return; }
      const newThread = destinationId === 'new';
      const newWorkers = newThread ? workerProfiles.filter((profile) => selectedWorkers.includes(profile.id)) : [];
      if (newThread && newWorkers.length === 0) { setError('Choose at least one worker profile for a new thread.'); return; }
      let parsedChecks: string[][];
      try {
        parsedChecks = checkCommands.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
        if (parsedChecks.some((argv) => !Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== 'string' || !arg.trim()))) throw new Error('Each check must be a JSON argv array of non-empty strings, such as ["npm","test"].');
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Checks must be JSON argv arrays.'); return; }
      const threadId = newThread ? null : destinationId;
      const workerIds = newThread ? newWorkers.map((profile) => profile.id) : selectedWorkers;
      const destination: AssistantTaskDestination | null = destinationId ? { threadId, newThread, workers: workerIds } : null;
      pending = {
        requestId: globalThis.crypto?.randomUUID?.() ?? `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text: draft.trim(), owner, destination, newWorkerProfiles: newWorkers, mode, checks: parsedChecks,
        threadLabels: chatThreads.map((pane) => ({ id: pane.id, label: pane.title })),
      };
      savePendingRequest(window.localStorage, pending, owner);
      requestRef.current = retainRequestForRetry(pending); setPendingRequest(pending);
    }
    const captured = owner;
    const version = generation.current;
    setBusy(true); setError('');
    try {
      const result = await backend.call<{ message: unknown; task?: AssistantTask | null; monitor: ProjectMonitor }>('assistant_message', assistantMessageArgs(captured, pending, chatThreads.map((pane) => ({ id: pane.id, label: pane.title }))));
      if (!currentOwner(captured, version)) return;
      if (!result.monitor || result.monitor.workspaceId !== captured.workspaceId || result.monitor.cwd !== captured.cwd || result.monitor.hostId !== captured.hostId || result.monitor.conversationId !== captured.conversationId) throw new Error('ApexAgent returned a different project assignment.');
      if (result.task && !isTaskOwnedBy(result.task, captured)) throw new Error('ApexAgent returned a task for a different assignment.');
      onMonitorUpdate?.(result.monitor);
      setAssistantReply(assistantMessageText(result.message));
      if (result.task) { listRequestVersion.current++; setTasks((current) => [result.task!, ...current.filter((task) => task.id !== result.task!.id)]); }
      requestRef.current = null; setPendingRequest(null); setDraft(''); setError(''); clearPendingRequest(window.localStorage, captured);
      void loadTasks(captured, version);
    } catch (cause) {
      if (currentOwner(captured, version)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (currentOwner(captured, version)) setBusy(false);
    }
  };

  const discardPending = () => {
    clearPendingRequest(window.localStorage, owner); requestRef.current = null; setPendingRequest(null);
    setDraft(''); setDestinationId(''); setSelectedWorkers([]); setError('');
  };

    const act = async (task: AssistantTask, action: Action, payload: { text?: string; destination?: AssistantTaskDestination; newWorkerProfiles?: ParticipantConfig[]; checks?: string[][]; mode?: 'in_place' | 'isolated' } = {}) => {
    if (busy || !isTaskOwnedBy(task, owner)) return;
    const captured = owner;
    const version = generation.current;
    setBusy(true); setError('');
    try {
      const result = await backend.call<AssistantTask>('assistant_task_action', assistantTaskActionArgs(task, action, payload));
      if (!currentOwner(captured, version)) return;
      if (!isTaskOwnedBy(result, captured)) throw new Error('ApexAgent returned a task for a different assignment.');
      listRequestVersion.current++;
      setTasks((current) => [result, ...current.filter((item) => item.id !== result.id)]);
      if (action === 'archive') setArchivedExecutions((current) => new Set([...current, task.id]));
      setClarifications((current) => ({ ...current, [task.id]: '' }));
      setChanges((current) => ({ ...current, [task.id]: '' }));
      void loadTasks(captured, version);
    } catch (cause) {
      if (currentOwner(captured, version)) { setError(cause instanceof Error ? cause.message : String(cause)); void loadTasks(captured, version); }
    } finally {
      if (currentOwner(captured, version)) setBusy(false);
    }
  };

  const taskDestination = (taskId: string): AssistantTaskDestination | null => {
    const selected = destinations[taskId] ?? '';
    if (!selected) return null;
    const newThread = selected === 'new';
    const newWorkers = workerProfiles.filter((profile) => (newTaskWorkers[taskId] ?? []).includes(profile.id));
    return { threadId: newThread ? null : selected, newThread, workers: newThread ? newWorkers.map((profile) => profile.id) : [] };
  };

  const renderChecks = (task: AssistantTask) => {
    const criteria = task.reviewCriteria ?? [];
    if (!criteria.length) return <p className="assistant-task-muted">No human review criteria were supplied. Accepting confirms the diff shown below.</p>;
    const selected = checks[task.id] ?? [];
    return <fieldset className="assistant-task-checks"><legend>Human review criteria</legend>{criteria.map((criterion) => <label key={criterion}><input type="checkbox" checked={selected.includes(criterion)} onChange={(event) => setChecks((current) => ({ ...current, [task.id]: event.target.checked ? [...selected, criterion] : selected.filter((item) => item !== criterion) }))} />I reviewed: {criterion}</label>)}</fieldset>;
  };

  return <section className="assistant-tasks" aria-label="Assistant tasks">
    <form className="assistant-request" onSubmit={sendRequest}>
      <strong>Give ApexAgent a task</strong>
      {pendingRequest && <p className="assistant-task-warning" role="status">The last response was uncertain. Retry uses the saved request ID, scope, text, destination, and mode.</p>}
      {assistantReply && <div className="assistant-task-response" aria-live="polite"><strong>ApexAgent</strong><p>{assistantReply}</p></div>}
      <label>Destination<select aria-label="Task destination" value={destinationId} disabled={busy || !!pendingRequest} onChange={(event) => { const value = event.target.value; setDestinationId(value); setSelectedWorkers([]); }}><option value="">Let ApexAgent route this message</option>{chatThreads.map((pane) => <option key={pane.id} value={pane.id}>{pane.title}</option>)}<option value="new">Create a new thread</option></select></label>
      {(destinationId === 'new' || pendingRequest?.destination?.newThread) && <fieldset className="assistant-task-workers"><legend>Worker profiles</legend>{workerProfiles.map((profile) => <label key={profile.id}><input type="checkbox" checked={selectedWorkers.includes(profile.id) || !!pendingRequest?.newWorkerProfiles.some((item) => item.id === profile.id)} disabled={busy || !!pendingRequest} onChange={(event) => setSelectedWorkers((current) => event.target.checked ? [...current, profile.id] : current.filter((id) => id !== profile.id))} />{profile.display_name}</label>)}</fieldset>}
      <textarea aria-label="Original task request" rows={2} value={pendingRequest?.text ?? draft} disabled={busy || !!pendingRequest} onChange={(event) => setDraft(event.target.value)} placeholder="Describe the work. ApexAgent will keep the request and result together." />
      {destinationId === 'new' && selectedWorkers.length === 0 && <p className="assistant-task-warning">Select at least one worker profile to create a new thread.</p>}
      <label>Execution mode<select aria-label="Execution mode" value={mode} disabled={busy || !!pendingRequest} onChange={(event) => setMode(event.target.value as 'in_place' | 'isolated')}><option value="in_place">In place · hold checkout through review</option><option value="isolated">Isolated · separate worktree (requires host delegation support)</option></select></label>
      <label>Exact checks (one JSON argv array per line)<textarea aria-label="Exact checks" rows={2} value={checkCommands} disabled={busy || !!pendingRequest} onChange={(event) => setCheckCommands(event.target.value)} placeholder={'["npm","test"]'} /></label>
      <p className="assistant-task-muted">Checks are passed as executable argv arrays; review criteria stay human acknowledgements.</p>
      <p className="assistant-task-muted">Messages may route naturally unless you choose a destination. In-place tasks edit this checkout and hold its writer lease through review; other Deck writers wait. A new thread requires an explicitly selected worker.</p>
      <button className="primary" disabled={busy || (!pendingRequest && (!draft.trim() || (destinationId === 'new' && selectedWorkers.length === 0)))}>{busy ? 'Sending…' : pendingRequest ? 'Retry request' : 'Send message'}</button>
      {pendingRequest && error && !busy && <button type="button" onClick={discardPending}>Discard saved request and start over</button>}
    </form>
    <div className="assistant-task-heading"><h2>Tasks</h2><button type="button" disabled={loading || busy} onClick={() => void loadTasks()}>Refresh</button></div>
    {tasks.some((task) => task.mode === 'isolated' && !archivedExecutions.has(task.id)) && <p className="assistant-task-muted">Isolated task folders: {formatBytes(tasks.filter((task) => task.mode === 'isolated' && !archivedExecutions.has(task.id)).reduce((bytes, task) => bytes + (task.resultData?.worktreeDiskBytes ?? 0), 0))}{tasks.some((task) => task.mode === 'isolated' && !archivedExecutions.has(task.id) && task.resultData?.worktreeDiskBytes == null) ? ' plus folders whose size is unavailable' : ''}</p>}
    {error && <p className="assistant-task-error" role="alert">{error}</p>}
    {loading && <p className="assistant-task-muted" role="status">Loading tasks…</p>}
    {!loading && tasks.length === 0 && <p className="assistant-task-muted">No tasks for this assignment yet.</p>}
    <div className="assistant-task-list">{tasks.map((task) => {
      const resultData = task.resultData ?? {};
      const pendingApprovals = resultData.pendingApprovals ?? [];
      const pendingQuestions = resultData.pendingQuestions ?? [];
      const selectedDestination = taskDestination(task.id);
      const reviewChecks = checks[task.id] ?? [];
      return <article className={`assistant-task-card status-${task.status}`} key={task.id}>
        <header><div><span className="assistant-task-status">{taskStatusLabel(task.status)}</span><span className="assistant-task-meta">Revision {task.revision} · {task.mode === 'in_place' ? 'In place' : 'Isolated'}</span></div><span className="assistant-task-usage">{taskUsageLabel(task.usage ?? task.attempts.at(-1)?.usage)}</span></header>
        <p className="assistant-task-original"><strong>Original request</strong>{task.originalRequest}</p>
        <p className="assistant-task-brief"><strong>Brief</strong>{task.brief}</p>
        {task.destination && <p className="assistant-task-muted">Destination: {task.destination.newThread ? 'New thread' : chatThreads.find((pane) => pane.id === task.destination?.threadId)?.title ?? task.destination.threadId ?? 'Needs clarification'}{task.destination.workers.length ? ` · Workers: ${task.destination.workers.join(', ')}` : ''}</p>}
        {task.mode === 'in_place' && task.status === 'queued' && <p className="assistant-task-lease">Queued for checkout access; work starts when the current writer releases it.</p>}
        {task.mode === 'in_place' && ['running', 'needs_you', 'ready_for_review', 'applying'].includes(task.status) && <p className="assistant-task-lease">Edits are already in the checkout. This task holds the writer lease through review; other Deck writers wait. Accept releases the lease, and Request changes keeps it.</p>}
        <nav className="assistant-task-links" aria-label="Related threads">{taskThreadLinks(task).map((link) => <button type="button" key={link.id} onClick={() => onOpenThread?.(link.id)}>{link.label}</button>)}</nav>
        {pendingApprovals.length > 0 && <div className="assistant-task-waits"><strong>Waiting for approval</strong>{pendingApprovals.map((approval, index) => <div key={index}><p>{objectText(approval)}</p><button type="button" disabled={!task.executionThreadId} onClick={() => task.executionThreadId && onOpenThread?.(task.executionThreadId)}>Open worker thread to approve</button></div>)}</div>}
        {pendingQuestions.length > 0 && <div className="assistant-task-waits"><strong>Waiting for your answer</strong>{pendingQuestions.map((question, index) => <div key={index}><p>{objectText(question)}</p><button type="button" disabled={!task.executionThreadId} onClick={() => task.executionThreadId && onOpenThread?.(task.executionThreadId)}>Open worker thread to answer</button></div>)}</div>}
        {task.status === 'needs_you' && resultData.startup != null && <p className="assistant-task-warning">Worker startup issue: {objectText(resultData.startup)}</p>}
        {task.result && <p className="assistant-task-result"><strong>Result</strong>{task.result}</p>}
        {typeof resultData.reviewDiff === 'string' && <details><summary>Review diff</summary><pre>{resultData.reviewDiff}</pre></details>}
        {Array.isArray(resultData.checks) && resultData.checks.length > 0 && <details><summary>Configured checks and results</summary><pre>{objectText({ commands: resultData.checks, results: resultData.checkResults ?? 'Awaiting verification' })}</pre></details>}
        {Array.isArray(resultData.exclusions) && resultData.exclusions.length > 0 && <p className="assistant-task-muted">Excluded: {resultData.exclusions.join(', ')}</p>}
        {(resultData.executionPath || resultData.baselineCommit || resultData.resultCommit) && <p className="assistant-task-muted">{[resultData.executionPath, resultData.baselineCommit && `Base ${resultData.baselineCommit}`, resultData.resultCommit && `Result ${resultData.resultCommit}`].filter(Boolean).join(' · ')}</p>}
        {task.mode === 'isolated' && !archivedExecutions.has(task.id) && typeof resultData.worktreeDiskBytes === 'number' && <p className="assistant-task-muted">Task folder: {formatBytes(resultData.worktreeDiskBytes)}</p>}
        {task.status === 'proposed' && <div className="assistant-task-actions"><label>Destination<select aria-label={`Destination for ${task.id}`} value={destinations[task.id] ?? ''} onChange={(event) => setDestinations((current) => ({ ...current, [task.id]: event.target.value }))}><option value="">Choose a thread</option>{chatThreads.map((pane) => <option key={pane.id} value={pane.id}>{pane.title}</option>)}<option value="new">Create new thread</option></select></label>{selectedDestination?.newThread && <fieldset className="assistant-task-workers"><legend>New thread workers</legend>{workerProfiles.map((profile) => <label key={profile.id}><input type="checkbox" checked={(newTaskWorkers[task.id] ?? []).includes(profile.id)} onChange={(event) => setNewTaskWorkers((current) => ({ ...current, [task.id]: event.target.checked ? [...(current[task.id] ?? []), profile.id] : (current[task.id] ?? []).filter((id) => id !== profile.id) }))} />{profile.display_name}</label>)}</fieldset>}<button type="button" disabled={busy || !selectedDestination || (selectedDestination.newThread && selectedDestination.workers.length === 0)} onClick={() => selectedDestination && void act(task, 'approve', { destination: selectedDestination, newWorkerProfiles: workerProfiles.filter((profile) => selectedDestination.workers.includes(profile.id)), mode: task.mode })}>Approve task</button><button type="button" disabled={busy} onClick={() => void act(task, 'dismiss')}>Dismiss</button></div>}
        {task.status === 'needs_clarification' && <div className="assistant-task-actions"><label>Clarify the request<textarea rows={2} value={clarifications[task.id] ?? ''} onChange={(event) => setClarifications((current) => ({ ...current, [task.id]: event.target.value }))} /></label><label>Destination<select aria-label={`Destination for ${task.id}`} value={destinations[task.id] ?? ''} onChange={(event) => setDestinations((current) => ({ ...current, [task.id]: event.target.value }))}><option value="">Choose a thread</option>{chatThreads.map((pane) => <option key={pane.id} value={pane.id}>{pane.title}</option>)}<option value="new">Create new thread</option></select></label>{selectedDestination?.newThread && <fieldset className="assistant-task-workers"><legend>New thread workers</legend>{workerProfiles.map((profile) => <label key={profile.id}><input type="checkbox" checked={(newTaskWorkers[task.id] ?? []).includes(profile.id)} onChange={(event) => setNewTaskWorkers((current) => ({ ...current, [task.id]: event.target.checked ? [...(current[task.id] ?? []), profile.id] : (current[task.id] ?? []).filter((id) => id !== profile.id) }))} />{profile.display_name}</label>)}</fieldset>}<button type="button" disabled={busy || !clarifications[task.id]?.trim() || !selectedDestination || (selectedDestination.newThread && selectedDestination.workers.length === 0)} onClick={() => selectedDestination && void act(task, 'clarify', { text: clarifications[task.id], destination: selectedDestination, newWorkerProfiles: workerProfiles.filter((profile) => selectedDestination.workers.includes(profile.id)), mode: task.mode })}>Send clarification</button></div>}
        {task.status === 'needs_you' && <div className="assistant-task-actions"><button type="button" disabled={!task.executionThreadId} onClick={() => task.executionThreadId && onOpenThread?.(task.executionThreadId)}>Open worker thread</button>{task.mode === 'isolated' && task.attempts.length === 0 && <button type="button" disabled={busy} onClick={() => void act(task, 'retry')}>Retry worker startup</button>}<button type="button" disabled={busy} onClick={() => void act(task, 'cancel')}>Cancel task</button></div>}
        {task.status === 'ready_for_review' && <div className="assistant-task-actions">{renderChecks(task)}<button type="button" disabled={busy || (task.reviewCriteria.length > 0 && reviewChecks.length !== task.reviewCriteria.length)} onClick={() => void act(task, 'accept')}>Accept and mark Done</button><label>Request changes<textarea rows={2} value={changes[task.id] ?? ''} onChange={(event) => setChanges((current) => ({ ...current, [task.id]: event.target.value }))} /></label><button type="button" disabled={busy || !changes[task.id]?.trim()} onClick={() => void act(task, 'request_changes', { text: changes[task.id] })}>Request changes</button></div>}
        {(task.status === 'queued' || task.status === 'running' || task.status === 'applying') && !canReconcileTask(task) && <div className="assistant-task-actions"><button type="button" disabled={busy} onClick={() => void act(task, 'cancel')}>Cancel task</button></div>}
        {(task.status === 'failed' || task.status === 'interrupted') && !canReconcileTask(task) && <div className="assistant-task-actions"><button type="button" disabled={busy} onClick={() => void act(task, 'retry')}>Retry task</button><button type="button" disabled={busy} onClick={() => void act(task, 'cancel')}>Cancel task</button></div>}
        {canReconcileTask(task) && <div className="assistant-task-actions"><p className="assistant-task-warning">An isolated integration stopped before its result was recorded. Recovery checks the saved integration journal and completes or rolls back that operation.</p><button type="button" disabled={busy} onClick={() => void act(task, 'reconcile')}>Recover interrupted integration</button></div>}
        {task.mode === 'isolated' && taskFinal(task.status) && !archivedExecutions.has(task.id) && <div className="assistant-task-actions">{shouldSuggestArchive(task) && <p className="assistant-task-warning">This terminal worktree is over 14 days old. Archive it to save disk space; the task result and history will remain available.</p>}<button type="button" disabled={busy} onClick={() => void act(task, 'archive')}>Archive isolated worktree</button><span className="assistant-task-muted">Removes the owned worktree and keeps this task’s result and history.</span></div>}
        {task.mode === 'isolated' && archivedExecutions.has(task.id) && <p className="assistant-task-muted">Isolated worktree archived{typeof resultData.worktreeDiskBytes === 'number' ? ` · saved worktree size ${formatBytes(resultData.worktreeDiskBytes)}` : ''}. Task result and history are retained.</p>}
        {taskFinal(task.status) && <p className="assistant-task-muted">This task is {task.status}{task.status === 'cancelled' && task.mode === 'in_place' ? '; existing checkout edits remain.' : '.'}</p>}
      </article>;
    })}</div>
  </section>;
}
