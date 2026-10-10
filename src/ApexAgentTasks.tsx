import { useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from './backend.ts';
import type { Pane, ParticipantConfig, Question } from './types.ts';
import type { ReactNode } from 'react';
import type { ProjectMonitor } from './apexAgentModel.ts';
import { archivedTaskIds, assistantMessageArgs, assistantTaskActionArgs, assistantTasksForOwner, canReconcileTask, clearPendingRequest, isTaskOwnedBy, isTerminalTask, loadPendingRequest, retainRequestForRetry, savePendingRequest, shouldSuggestArchive, taskStatusLabel, taskThreadLinks, taskUsageLabel, taskWorkerChoices, type AssistantTask, type AssistantTaskDestination, type AssistantTaskOwner, type AssistantTaskSnapshot, type PendingAssistantRequest } from './assistantTaskModel.ts';
import './assistant-tasks.css';

type Action = 'clarify' | 'approve' | 'dismiss' | 'retry' | 'request_changes' | 'cancel' | 'accept' | 'archive' | 'reconcile' | 'note' | 'set_budget' | 'resume_budget';
type Props = {
  onSelectTask?: (task: AssistantTask, send: (text: string) => Promise<void>) => void;
  projectName?: string;
  requestRecovery?: { pending: PendingAssistantRequest | null; retry: () => Promise<void>; discard: () => void };
  clearedAt?: number;
  backend: Backend;
  owner: AssistantTaskOwner;
  panes: Pane[];
  profiles: ParticipantConfig[];
  onMonitorUpdate?: (monitor: ProjectMonitor) => void;
  onOpenThread?: (id: string) => void;
  view?: 'chat' | 'tasks' | 'activity' | 'settings' | 'conversation';
  messages?: { id: string; role: string; text: string; at: number; evidence?: { sourceId: string; label: string; excerpt: string; observedAt: number }[] }[];
  focused?: boolean;
  onViewChange?: (view: 'chat' | 'tasks' | 'activity' | 'settings') => void;
  children?: ReactNode;
  onOpenEvidence?: (evidence: { sourceId: string; label: string; excerpt: string; observedAt: number }) => void;
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

export function ApexAgentTasks({ backend, owner, panes, profiles, onMonitorUpdate, onOpenThread, view = 'tasks', messages = [], focused, onViewChange, children, onOpenEvidence, projectName, clearedAt = 0, onSelectTask, requestRecovery }: Props) {
  const sharedSender = useRef<(taskId: string, text: string) => Promise<void>>(async () => { throw new Error('Task context is unavailable.'); });
  const [tasks, setTasks] = useState<AssistantTask[]>([]);
  const [routingThreads, setRoutingThreads] = useState<{ id: string; workers: ParticipantConfig[] }[] | undefined>(undefined);
  const [namedOnlyWorkerIds, setNamedOnlyWorkerIds] = useState<string[] | undefined>(undefined);
  const [archivedExecutions, setArchivedExecutions] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [assistantReply, setAssistantReply] = useState('');
  const [draft, setDraft] = useState('');
  const [draftsByContext, setDraftsByContext] = useState<Record<string, string>>({});
  const [destinationId, setDestinationId] = useState('');
  const [mode, setMode] = useState<'in_place' | 'isolated' | 'read_only'>('in_place');
  const [checkCommands, setCheckCommands] = useState('');
  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([]);
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [newTaskWorkers, setNewTaskWorkers] = useState<Record<string, string[]>>({});
  const [checks, setChecks] = useState<Record<string, string[]>>({});
  const [pendingRequest, setPendingRequest] = useState<PendingAssistantRequest | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [taskContextId, setTaskContextId] = useState<string | null>(null);
  const [taskWorkers, setTaskWorkers] = useState<Record<string, string[]>>({});
  const [reviewedRevision, setReviewedRevision] = useState<Record<string, number>>({});
  const [visibleReviewRevision, setVisibleReviewRevision] = useState<Record<string, number>>({});
  const detailScrollRef = useRef<HTMLDivElement | null>(null);
  const reviewMaterialRef = useRef<HTMLDivElement | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [spendCap, setSpendCap] = useState('');
  const [requestSpendCap, setRequestSpendCap] = useState('');
  const [inlineAnswer, setInlineAnswer] = useState<Record<string, string[]>>({});
  const [inlineOther, setInlineOther] = useState<Record<string, string>>({});
  const activeOwner = useRef(owner);
  activeOwner.current = owner;
  const generation = useRef(0);
  const listRequestVersion = useRef(0);
  const snapshotRevision = useRef(-1);
  const requestRef = useRef<PendingAssistantRequest | null>(null);
  const workerProfiles = useMemo(() => taskWorkerChoices(profiles).filter((profile) => !namedOnlyWorkerIds?.includes(profile.id)), [profiles, namedOnlyWorkerIds]);
  const chatThreads = useMemo(() => {
    const visible = panes.filter((pane) => pane.kind === 'chat' && pane.workspaceId === owner.workspaceId && !pane.archived).map((pane) => ({ id: pane.id, title: pane.title }));
    // The owning host also advertises saved chats that are closed or absent on this device.
    const saved = (routingThreads ?? []).filter((thread) => !visible.some((pane) => pane.id === thread.id)).map((thread) => ({ id: thread.id, title: `Saved chat · ${thread.id}` }));
    return [...visible, ...saved];
  }, [panes, owner.workspaceId, routingThreads]);
  const ownerKey = `${owner.workspaceId}\u0000${owner.cwd}\u0000${owner.hostId}\u0000${owner.conversationId}`;
  const composerContextKey = `${ownerKey}\u0000${taskContextId ?? 'new'}`;
  const setContextDraft = (value: string) => { setDraft(value); setDraftsByContext((current) => ({ ...current, [composerContextKey]: value })); };

  const currentOwner = (captured: AssistantTaskOwner, version: number) => generation.current === version
    && activeOwner.current.workspaceId === captured.workspaceId && activeOwner.current.cwd === captured.cwd
    && activeOwner.current.hostId === captured.hostId && activeOwner.current.conversationId === captured.conversationId;

  const loadTasks = async (captured = owner, version = generation.current) => {
    if (backend.demo) { if (currentOwner(captured, version)) { setTasks([]); setLoading(false); } return; }
    const listVersion = ++listRequestVersion.current;
    try {
      const snapshot = await backend.call<AssistantTaskSnapshot>('assistant_tasks_list', { owner: captured });
      const visible = assistantTasksForOwner(snapshot, captured);
      if (currentOwner(captured, version) && listRequestVersion.current === listVersion && snapshot.revision >= snapshotRevision.current) { snapshotRevision.current = snapshot.revision; setTasks(visible); const routing = snapshot as AssistantTaskSnapshot & { routingThreads?: { id: string; workers: ParticipantConfig[] }[]; namedOnlyWorkerIds?: string[] }; setRoutingThreads(routing.routingThreads); setNamedOnlyWorkerIds(routing.namedOnlyWorkerIds); setArchivedExecutions(archivedTaskIds(snapshot)); setError(''); }
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
    setTasks([]); setRoutingThreads(undefined); setNamedOnlyWorkerIds(undefined); setArchivedExecutions(new Set()); setBusy(false); setError(''); setAssistantReply(''); setLoading(true); setPendingRequest(recovered); requestRef.current = recovered;
    setDraft(recovered?.text ?? ''); setDraftsByContext(recovered?.text ? { [`${ownerKey}\u0000new`]: recovered.text } : {}); setTaskContextId(null); setDestinationId(recovered?.destination?.newThread ? 'new' : recovered?.destination?.threadId ?? ''); setSelectedWorkers(recovered?.newWorkerProfiles.map((profile) => profile.id) ?? []); setMode(recovered?.mode ?? 'in_place'); setCheckCommands((recovered?.checks ?? []).map((argv) => JSON.stringify(argv)).join('\n')); setRequestSpendCap(recovered?.spendLimitMicros == null ? '' : (recovered.spendLimitMicros / 1_000_000).toFixed(2)); setDestinations({}); setNewTaskWorkers({}); setTaskWorkers({}); setChecks({}); setDetailId(null); setReviewedRevision({});
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

  useEffect(() => {
    setChecks((current) => Object.fromEntries(Object.entries(current).filter(([key]) => tasks.some((task) => key === `${task.id}:${task.revision}`))));
    setReviewedRevision((current) => Object.fromEntries(Object.entries(current).filter(([id, revision]) => tasks.some((task) => task.id === id && task.revision === revision))));
    setVisibleReviewRevision((current) => Object.fromEntries(Object.entries(current).filter(([id, revision]) => tasks.some((task) => task.id === id && task.revision === revision))));
  }, [tasks]);

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
      const spendLimitMicros = requestSpendCap.trim() ? Math.round(Number(requestSpendCap) * 1_000_000) : null;
      if (spendLimitMicros !== null && (!Number.isSafeInteger(spendLimitMicros) || spendLimitMicros <= 0)) { setError('Enter a positive spend cap, or leave blank to remove it.'); return; }
      if (mode === 'read_only' && parsedChecks.length > 0) { setError('Checks are not supported in Read only mode. Switch mode or remove the configured checks.'); return; }
      pending = {
        requestId: globalThis.crypto?.randomUUID?.() ?? `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text: draft.trim(), owner, destination, newWorkerProfiles: newWorkers, mode, checks: parsedChecks,
        threadLabels: chatThreads.map((pane) => ({ id: pane.id, label: pane.title })),
        // Profiles are trusted catalog data for routing, not authorization to execute a task.
        workerProfiles, spendLimitMicros,
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
      requestRef.current = null; setPendingRequest(null); setContextDraft(''); setError(''); clearPendingRequest(window.localStorage, captured);
      void loadTasks(captured, version);
    } catch (cause) {
      if (currentOwner(captured, version)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (currentOwner(captured, version)) setBusy(false);
    }
  };

  const recoveryRequest = requestRecovery ? requestRecovery.pending : pendingRequest;
  const retryRecovery = async () => {
    if (busy) return;
    if (!requestRecovery) { await sendRequest({ preventDefault() {} } as React.FormEvent); return; }
    const captured = owner, version = generation.current;
    setBusy(true); setError('');
    try { await requestRecovery.retry(); }
    catch (cause) { if (currentOwner(captured, version)) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (currentOwner(captured, version)) setBusy(false); }
  };

  const discardPending = () => {
    clearPendingRequest(window.localStorage, owner); requestRef.current = null; setPendingRequest(null);
    setContextDraft(''); setDestinationId(''); setSelectedWorkers([]); setError('');
  };

  const act = async (task: AssistantTask, action: Action, payload: { text?: string; destination?: AssistantTaskDestination; newWorkerProfiles?: ParticipantConfig[]; checks?: string[][]; mode?: 'in_place' | 'isolated' | 'read_only'; spendLimitMicros?: number | null } = {}): Promise<boolean> => {
    if (busy || !isTaskOwnedBy(task, owner)) return false;
    const captured = owner;
    const version = generation.current;
    setBusy(true); setError('');
    try {
      const result = await backend.call<AssistantTask>('assistant_task_action', assistantTaskActionArgs(task, action, payload));
      if (!currentOwner(captured, version)) return false;
      if (!isTaskOwnedBy(result, captured)) throw new Error('ApexAgent returned a task for a different assignment.');
      listRequestVersion.current++;
      setTasks((current) => [result, ...current.filter((item) => item.id !== result.id)]);
      if (action === 'archive') setArchivedExecutions((current) => new Set([...current, task.id]));
      void loadTasks(captured, version);
      return true;
    } catch (cause) {
      if (currentOwner(captured, version)) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      if (currentOwner(captured, version)) setBusy(false);
    }
  };

  const taskDestination = (taskId: string): AssistantTaskDestination | null => {
    const initialTask = tasks.find((task) => task.id === taskId);
    const source = initialTask?.status === 'proposed' ? initialTask.destination : null;
    const selected = destinations[taskId] ?? (source?.newThread ? 'new' : source?.threadId ?? '');
    if (!selected) return null;
    const newThread = selected === 'new';
    if (!newThread && !chatThreads.some((pane) => pane.id === selected)) return null;
    const newWorkers = workerProfiles.filter((profile) => (newTaskWorkers[taskId] ?? source?.workers ?? []).includes(profile.id));
    const eligible = routingWorkers(selected).map((profile) => profile.id);
    const chosen = (taskWorkers[taskId] ?? source?.workers ?? []).filter((id) => eligible.includes(id));
    return { threadId: newThread ? null : selected, newThread, workers: newThread ? newWorkers.map((profile) => profile.id) : chosen };
  };
  const routingWorkers = (threadId: string) => routingThreads === undefined ? workerProfiles : routingThreads.find((thread) => thread.id === threadId)?.workers ?? [];
  const routingWorkersUnavailable = (threadId: string) => routingThreads !== undefined && !routingThreads.some((thread) => thread.id === threadId);

  const renderChecks = (task: AssistantTask) => {
    const criteria = task.reviewCriteria ?? [];
    if (!criteria.length) return <p className="assistant-task-muted">No review criteria were supplied. Confirm that you reviewed this result.</p>;
    const key = `${task.id}:${task.revision}`;
    const selected = checks[key] ?? [];
    return <fieldset className="assistant-task-checks"><legend>Human review criteria</legend>{criteria.map((criterion) => <label key={criterion}><input type="checkbox" checked={selected.includes(criterion)} onChange={(event) => setChecks((current) => ({ ...current, [key]: event.target.checked ? [...selected, criterion] : selected.filter((item) => item !== criterion) }))} />I reviewed: {criterion}</label>)}</fieldset>;
  };

  const destinationTitle = (task: AssistantTask) => task.destination?.newThread ? 'New thread' : task.destination?.threadId ? chatThreads.find((pane) => pane.id === task.destination?.threadId)?.title ?? task.destination.threadId : 'Not assigned';
  const workerNames = (task: AssistantTask) => (task.workers ?? []).map((id) => workerProfiles.find((profile) => profile.id === id)?.display_name ?? id).join(', ') || 'Unassigned';
  const budgetValue = (task: AssistantTask) => {
    const data = task.resultData as (AssistantTask['resultData'] & { spendLimitMicros?: number | null; budgetPaused?: boolean }) | null | undefined;
    return data?.spendLimitMicros;
  };
  const openTaskDetail = (task: AssistantTask) => {
    if (taskContextId !== task.id) setDraftsByContext((current) => ({ ...current, [composerContextKey]: draft }));
    setTaskContextId(task.id); setDraft(draftsByContext[`${ownerKey}\u0000${task.id}`] ?? ''); setDetailId(task.id); setReviewedRevision((current) => ({ ...current, [task.id]: -1 }));
    if (view === 'conversation' && onSelectTask && !taskFinal(task.status)) {
      const captured = owner; const version = generation.current;
      onSelectTask(task, async (text) => {
        if (!currentOwner(captured, version)) throw new Error('This task assignment changed. Select the task again.');
        await sharedSender.current(task.id, text);
      });
    }
    const limit = budgetValue(task); setSpendCap(limit == null ? '' : (limit / 1_000_000).toFixed(2));
  };
  const reviewed = (task: AssistantTask) => reviewedRevision[task.id] === task.revision;
  const hasCurrentRequest = (wait: unknown) => !!wait && typeof wait === 'object' && typeof (wait as { request?: unknown }).request === 'string' && !!(wait as { request: string }).request;
  const hasQuestionGroup = (wait: unknown): wait is { request: string; questions: Question[] } => hasCurrentRequest(wait) && !!wait && typeof wait === 'object' && Array.isArray((wait as { questions?: unknown }).questions) && (wait as { questions: unknown[] }).questions.length > 0 && (wait as { questions: unknown[] }).questions.every((question) => !!question && typeof question === 'object' && typeof (question as Question).question === 'string' && Array.isArray((question as Question).options));
  const hasApprovalAction = (wait: unknown) => hasCurrentRequest(wait) && !!wait && typeof wait === 'object' && !!(wait as { action?: unknown }).action && typeof (wait as { action: { title?: unknown; detail?: unknown } }).action.title === 'string' && typeof (wait as { action: { title?: unknown; detail?: unknown } }).action.detail === 'string';
  const selectedTask = tasks.find((task) => task.id === taskContextId && isTaskOwnedBy(task, owner));
  const hasReviewMaterial = (task: AssistantTask) => {
    const data = task.resultData ?? {};
    return task.mode === 'read_only'
      ? typeof data.reviewDiff === 'string' || !!task.result?.trim() || task.evidence.length > 0
      : typeof data.reviewDiff === 'string';
  };
  useEffect(() => {
    const task = selectedTask;
    if ((view !== 'tasks' && view !== 'conversation') || !task || detailId !== task.id || task.status !== 'ready_for_review' || !hasReviewMaterial(task)) return;
    const root = detailScrollRef.current;
    const target = reviewMaterialRef.current;
    if (!root || !target || typeof IntersectionObserver === 'undefined') return;
    const captured = owner;
    const version = generation.current;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.target === target && entry.isIntersecting && entry.intersectionRatio > 0)) return;
      const current = tasks.find((candidate) => candidate.id === task.id);
      if (!currentOwner(captured, version) || detailId !== task.id || !current || current.revision !== task.revision || !isTaskOwnedBy(current, captured)) return;
      setVisibleReviewRevision((previous) => ({ ...previous, [task.id]: task.revision }));
    }, { root, threshold: 0.01 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [view, detailId, selectedTask?.id, selectedTask?.revision, selectedTask?.status, tasks]);
  useEffect(() => { if (view === 'conversation' && clearedAt) { setDetailId(null); setTaskContextId(null); } }, [view, clearedAt]);
  const composerWaits: unknown[] = (selectedTask?.resultData?.pendingQuestions as unknown[] | undefined) ?? [];
  const composerSingleQuestion = !!selectedTask && composerWaits.length === 1 && hasQuestionGroup(composerWaits[0]) && composerWaits[0].questions?.length === 1;
  const composerNeedsInlineAnswers = composerWaits.length > 0 && !composerSingleQuestion;
  const composerActionLabel = !selectedTask ? 'Send' : selectedTask.status === 'ready_for_review' ? 'Request changes' : selectedTask.status === 'needs_clarification' ? 'Send routing clarification' : composerSingleQuestion ? 'Send answer' : composerNeedsInlineAnswers ? 'Answer inline questions' : 'Add note';
  const sendTaskText = async (task: AssistantTask, text: string): Promise<boolean> => {
    if (task.status === 'needs_clarification') {
      const destination = taskDestination(task.id);
      if (!destination || !destination.workers.length) { setError('Choose a destination and at least one eligible worker before sending this routing clarification.'); return false; }
      const ok = await act(task, 'clarify', { text, destination, newWorkerProfiles: destination.newThread ? workerProfiles.filter((profile) => destination.workers.includes(profile.id)) : [], mode: task.mode });
      return ok;
    }
    if (task.status === 'ready_for_review') {
      const ok = await act(task, 'request_changes', { text });
      return ok;
    }
    const waits: unknown[] = (task.resultData?.pendingQuestions as unknown[] | undefined) ?? [];
    const usable = waits.filter(hasQuestionGroup);
    if (waits.length) {
      if (waits.length !== 1 || usable.length !== 1 || usable[0].questions?.length !== 1) {
        setError('Complete every question in the inline answer cards above; this message is still saved in the composer.'); return false;
      }
      const ok = await answerQuestionText(task, usable[0], text);
      return ok;
    }
    const ok = await act(task, 'note', { text });
    return ok;
  };
  const submitTaskContext = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || !selectedTask || !isTaskOwnedBy(selectedTask, owner)) return;
    if (await sendTaskText(selectedTask, draft.trim())) setContextDraft('');
  };
  sharedSender.current = async (taskId, text) => {
    const task = tasks.find((item) => item.id === taskId && isTaskOwnedBy(item, owner));
    if (!task || taskFinal(task.status)) throw new Error('This task is no longer available for replies.');
    if (!text.trim() || busy) throw new Error('Wait for the current task action to finish.');
    if (!await sendTaskText(task, text.trim())) throw new Error('Task reply was not sent. Check the task controls and retry.');
  };
  const answerQuestionText = async (task: AssistantTask, wait: unknown, text: string): Promise<boolean> => {
    const item = wait && typeof wait === 'object' ? wait as { request?: unknown } : {};
    const current = tasks.find((candidate) => candidate.id === task.id);
    const currentWaits: unknown[] = (current?.resultData?.pendingQuestions as unknown[] | undefined) ?? [];
    const requestIsCurrent = typeof item.request === 'string' && currentWaits.some((entry) => !!entry && typeof entry === 'object' && (entry as { request?: unknown }).request === item.request);
    if (!task.executionThreadId || !current || !current.executionThreadId || current.revision !== task.revision || !isTaskOwnedBy(current, owner) || !requestIsCurrent || typeof item.request !== 'string' || !item.request) { setError('This wait has no usable request ID. Open the worker chat to respond.'); return false; }
    const captured = owner; const version = generation.current;
    setBusy(true); setError('');
    const threadId = current.executionThreadId;
    try { await backend.roomAnswer(threadId, item.request, [[text]]); if (!currentOwner(captured, version)) return false; await loadTasks(captured, version); return true; }
    catch (cause) { if (currentOwner(captured, version)) setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { if (currentOwner(captured, version)) setBusy(false); }
  };
  const answerWait = async (task: AssistantTask, wait: unknown) => {
    const item = wait && typeof wait === 'object' ? wait as { request?: unknown; questions?: Question[] } : {};
    const current = tasks.find((candidate) => candidate.id === task.id);
    const currentWaits = current?.resultData?.pendingQuestions ?? [];
    const requestIsCurrent = typeof item.request === 'string' && currentWaits.some((entry) => !!entry && typeof entry === 'object' && (entry as { request?: unknown }).request === item.request);
    if (!task.executionThreadId || !current || current.revision !== task.revision || !isTaskOwnedBy(current, owner) || !requestIsCurrent || typeof item.request !== 'string' || !item.request) {
      setError('This wait has no usable request ID. Open the worker chat to respond.'); return;
    }
    const questions = Array.isArray(item.questions) ? item.questions : [];
    if (!questions.length || questions.some((question) => !question || typeof question.question !== 'string' || !Array.isArray(question.options))) { setError('This wait uses an older question format. Open the worker chat to respond.'); return; }
    const answers = questions.map((_question, index) => [...(inlineAnswer[`${task.id}:${String(item.request)}:${index}`] ?? []), ...(inlineOther[`${task.id}:${String(item.request)}:${index}`]?.trim() ? [inlineOther[`${task.id}:${String(item.request)}:${index}`].trim()] : [])]);
    if (answers.some((answer) => answer.length === 0)) { setError('Answer every question before sending.'); return; }
    const captured = owner; const version = generation.current;
    setBusy(true); setError('');
    try {
      await backend.roomAnswer(current!.executionThreadId!, item.request, answers);
      if (!currentOwner(captured, version) || !isTaskOwnedBy(task, captured)) return;
      setInlineAnswer((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${task.id}:${String(item.request)}:`))));
      await loadTasks(captured, version);
    } catch (cause) { if (currentOwner(captured, version)) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (currentOwner(captured, version)) setBusy(false); }
  };
  const decideWait = async (task: AssistantTask, wait: unknown, approve: boolean) => {
    const item = wait && typeof wait === 'object' ? wait as { request?: unknown } : {};
    const current = tasks.find((candidate) => candidate.id === task.id);
    const currentWaits = current?.resultData?.pendingApprovals ?? [];
    const requestIsCurrent = typeof item.request === 'string' && currentWaits.some((entry) => !!entry && typeof entry === 'object' && (entry as { request?: unknown }).request === item.request);
    if (!task.executionThreadId || !current || current.revision !== task.revision || !isTaskOwnedBy(current, owner) || !requestIsCurrent || typeof item.request !== 'string' || !item.request) {
      setError('This wait has no usable request ID. Open the worker chat to respond.'); return;
    }
    const captured = owner; const version = generation.current;
    setBusy(true); setError('');
    try { await backend.roomDecide(current!.executionThreadId!, item.request, approve, false); if (currentOwner(captured, version)) await loadTasks(captured, version); }
    catch (cause) { if (currentOwner(captured, version)) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (currentOwner(captured, version)) setBusy(false); }
  };

  return <section className={`assistant-tasks${view === 'conversation' ? ' assistant-task-conversation' : ''}`} aria-label="Assistant workspace" data-assistant-workspace-id={owner.workspaceId} data-focused={focused ? 'true' : 'false'}>
    {view === 'chat' && <div className="assistant-chat-transcript" aria-live="polite">{messages.map((message) => <article className={`assistant-chat-message ${message.role}`} key={message.id}><small>{message.role === 'human' ? 'You' : 'ApexAgent'}</small><p>{message.text}</p>{message.evidence?.length ? <div className="assistant-chat-evidence">{message.evidence.map((item, index) => <button type="button" key={`${item.sourceId}:${index}`} title={item.excerpt} onClick={() => onOpenEvidence?.(item)}>{item.label}<small>{item.excerpt}</small></button>)}</div> : null}</article>)}{messages.length === 0 && <p className="assistant-task-muted">ApexAgent is ready to talk about this project.</p>}{children}{assistantReply && !messages.some((message) => message.text === assistantReply) && <article className="assistant-chat-message assistant"><small>ApexAgent</small><p>{assistantReply}</p></article>}</div>}


    {view === 'conversation' && recoveryRequest && <article className="assistant-chat-message assistant" role="status">
      <small>Unconfirmed message{projectName ? ` · ${projectName}` : ''}</small><p>{recoveryRequest.text}</p>
      <p>The last response was uncertain. Retry uses the saved request ID and original payload. Discard removes the local retry; it does not cancel work already received.</p>
      {error && <p className="assistant-task-warning">{error}</p>}
      <button type="button" disabled={busy} onClick={retryRecovery}>{busy ? 'Retrying…' : 'Retry request'}</button>
      <button type="button" disabled={busy} onClick={() => requestRecovery ? requestRecovery.discard() : discardPending()}>Discard saved request and start over</button>
    </article>}
    {view === 'conversation' && tasks.filter((task) => !taskFinal(task.status) || task.updatedAtMs > clearedAt).map((task) => <article className="assistant-chat-message assistant" data-assistant-task-id={task.id} key={task.id}>
      <small>Delegated work{projectName ? ` · ${projectName}` : ''} · {taskStatusLabel(task.status)}</small><p>{task.originalRequest}</p><p className="assistant-task-muted">Scope: {task.brief}</p>{typeof (task.resultData as { batchId?: unknown } | null)?.batchId === 'string' && <small>From your cross-project plan</small>}
      <button type="button" onClick={() => openTaskDetail(task)}>{task.status === 'ready_for_review' ? 'Review result' : 'Open task'} · {task.originalRequest}</button>
    </article>)}
    {view === 'conversation' && detailId && <button type="button" onClick={() => { setDetailId(null); setTaskContextId(null); }}>Close task details</button>}
    {view === 'activity' && <section className="assistant-task-activity">{children}<h2>Delegated task activity</h2>{tasks.map((task) => { const history = ((task.resultData as { taskHistory?: { atMs: number; kind: string; text: string }[] } | null)?.taskHistory ?? []).map((entry) => ({ at: entry.atMs, kind: entry.kind, text: entry.text })); const attempts = task.attempts.map((attempt) => ({ at: attempt.finishedAtMs ?? attempt.startedAtMs, kind: `Attempt ${attempt.number}`, text: taskStatusLabel(attempt.status) })); const entries = [...history, ...attempts].sort((left, right) => right.at - left.at); return <article key={task.id}><header><strong>{task.originalRequest}</strong><span>{taskStatusLabel(task.status)}</span></header>{entries.length ? entries.map((entry, index) => <p key={`${entry.at}:${index}`}><time>{new Date(entry.at).toLocaleString()}</time><b>{entry.kind}</b>{entry.text}</p>) : <p className="assistant-task-muted">No recorded attempt history yet.</p>}<nav className="assistant-task-links">{taskThreadLinks(task).map((link) => <button type="button" key={link.id} onClick={() => onOpenThread?.(link.id)}>{link.label}</button>)}</nav></article>; })}{tasks.length === 0 && <p className="assistant-task-muted">No delegated task activity yet.</p>}</section>}
    {view === 'tasks' && <div className={`assistant-task-heading${detailId ? ' is-detail' : ''}`}><div>{detailId ? <button type="button" className="assistant-back" onClick={() => setDetailId(null)}>← All tasks</button> : <h2>Task overview</h2>}</div><button type="button" disabled={loading || busy} onClick={() => void loadTasks()}>Refresh</button></div>}
    {view === 'tasks' && tasks.some((task) => task.mode === 'isolated' && !archivedExecutions.has(task.id)) && <p className="assistant-task-muted">Isolated task folders: {formatBytes(tasks.filter((task) => task.mode === 'isolated' && !archivedExecutions.has(task.id)).reduce((bytes, task) => bytes + (task.resultData?.worktreeDiskBytes ?? 0), 0))}{tasks.some((task) => task.mode === 'isolated' && !archivedExecutions.has(task.id) && task.resultData?.worktreeDiskBytes == null) ? ' plus folders whose size is unavailable' : ''}</p>}
    {error && <p className="assistant-task-error" role="alert">{error}</p>}
    {loading && <p className="assistant-task-muted" role="status">Loading tasks…</p>}
    {view === 'tasks' && !loading && tasks.length === 0 && <p className="assistant-task-muted">No tasks for this assignment yet.</p>}
    {view === 'tasks' && !detailId && <div className="assistant-task-groups">{['Needs you', 'In progress', 'Done and stopped'].map((group) => {
      const items = tasks.filter((task) => group === 'Needs you' ? ['proposed', 'needs_clarification', 'needs_you', 'ready_for_review', 'failed', 'interrupted'].includes(task.status) : group === 'In progress' ? ['queued', 'running', 'applying'].includes(task.status) : ['done', 'cancelled'].includes(task.status));
      return <section className="assistant-task-group" key={group}><h3>{group}<span>{items.length}</span></h3>{items.map((task) => <button type="button" className="assistant-task-overview-row" key={task.id} onClick={() => openTaskDetail(task)}><span><b>{taskStatusLabel(task.status)}</b>{task.originalRequest}</span><small>{workerNames(task)} · {destinationTitle(task)} · {task.origin === 'human_request' ? 'Human request' : 'ApexAgent proposal'}</small><small>{task.mode === 'read_only' ? 'Read only' : task.mode === 'in_place' ? 'In place' : 'Separate copy'} · {taskUsageLabel(task.usage ?? task.attempts.at(-1)?.usage)}</small></button>)}</section>;
    })}</div>}
    {(view === 'tasks' || view === 'conversation') && detailId && !selectedTask && <p className="assistant-task-muted">This task is no longer available in the current assignment.</p>}
    {(view === 'tasks' || view === 'conversation') && detailId && <div className="assistant-task-list">{tasks.filter((task) => task.id === detailId).map((task) => {
      const resultData = task.resultData ?? {};
      const pendingApprovals = resultData.pendingApprovals ?? [];
      const pendingQuestions = resultData.pendingQuestions ?? [];
      const selectedDestination = taskDestination(task.id);
      const reviewChecks = checks[`${task.id}:${task.revision}`] ?? [];
      const hasCapturedDiff = typeof resultData.reviewDiff === 'string';
      const hasReviewData = hasReviewMaterial(task);
      const currentReviewVisible = hasReviewData && visibleReviewRevision[task.id] === task.revision;
      return <article className={`assistant-task-card status-${task.status}`} key={task.id}>
        <header><div><span className="assistant-task-status">{taskStatusLabel(task.status)}</span><span className="assistant-task-meta">Revision {task.revision} · {task.mode === 'read_only' ? 'Read only' : task.mode === 'in_place' ? 'In place' : 'Separate copy'}</span></div><span className="assistant-task-usage">{taskUsageLabel(task.usage ?? task.attempts.at(-1)?.usage)}</span></header>
        <div className="assistant-task-detail-scroll" ref={detailScrollRef}>
        {typeof (resultData as { batchId?: unknown }).batchId === 'string' && <p className="assistant-task-muted">From your cross-project plan</p>}
        <details><summary>Original request and brief</summary><p className="assistant-task-original"><strong>Original request</strong>{task.originalRequest}</p><p className="assistant-task-brief"><strong>Brief</strong>{task.brief}</p></details>
        {task.destination && <p className="assistant-task-muted">Destination: {task.destination.newThread ? 'New thread' : chatThreads.find((pane) => pane.id === task.destination?.threadId)?.title ?? task.destination.threadId ?? 'Needs clarification'}{task.destination.workers.length ? ` · Workers: ${task.destination.workers.join(', ')}` : ''}</p>}
        {task.mode === 'in_place' && task.status === 'queued' && <p className="assistant-task-lease">Queued for checkout access; work starts when the current writer releases it.</p>}
        {task.mode === 'in_place' && ['running', 'needs_you', 'ready_for_review', 'applying'].includes(task.status) && <p className="assistant-task-lease">Edits are already in the checkout. This task holds the writer lease through review; other Deck writers wait. Accept releases the lease, and Request changes keeps it.</p>}
        <nav className="assistant-task-links" aria-label="Related threads">{taskThreadLinks(task).map((link) => <button type="button" key={link.id} onClick={() => onOpenThread?.(link.id)}>{link.label}</button>)}</nav>
        {task.status === 'ready_for_review' && hasReviewData && <div className="assistant-review-material" ref={reviewMaterialRef}>{task.result && <p className="assistant-task-result"><strong>Result</strong>{task.result}</p>}{hasCapturedDiff && <section className="assistant-review-diff"><h3>{resultData.reviewDiff ? 'Review diff' : 'Review result'}</h3>{resultData.reviewDiff ? <pre>{resultData.reviewDiff}</pre> : <p>No file changes in this result.</p>}</section>}{task.evidence.length > 0 && <section className="assistant-task-evidence"><h3>Findings and evidence</h3>{task.evidence.map((item, index) => <p key={index}>{item}</p>)}</section>}</div>}
        {task.status === 'ready_for_review' && <div className="assistant-review-criteria">{renderChecks(task)}</div>}
        {task.status === 'ready_for_review' && !hasReviewData && <p className="assistant-task-warning">The current result has no review diff or captured findings. Open the worker chat and refresh after its result is available.</p>}
        {task.status === 'ready_for_review' && hasReviewData && !currentReviewVisible && <p className="assistant-task-muted">Scroll the current result, diff, or findings into view to enable acknowledgement.</p>}
        {pendingApprovals.length > 0 && <div className="assistant-task-waits"><strong>Waiting for approval</strong>{pendingApprovals.map((approval, index) => { const action = approval && typeof approval === 'object' ? (approval as { action?: { title?: string; detail?: string } }).action : undefined; return <div key={index}><p><b>{action?.title ?? 'Worker approval'}</b>{action?.detail ? `\n${action.detail}` : `\n${objectText(approval)}`}</p></div>; })}</div>}
        {pendingQuestions.length > 0 && <div className="assistant-task-waits"><strong>Waiting for your answer</strong>{pendingQuestions.map((questionGroup, groupIndex) => { const group = questionGroup && typeof questionGroup === 'object' ? questionGroup as { request?: string; questions?: Question[] } : {}; const requestKey = group.request ?? `legacy-${groupIndex}`; return <div key={groupIndex}>{hasQuestionGroup(questionGroup) && (group.questions ?? []).map((question, questionIndex) => { const key = `${task.id}:${requestKey}:${questionIndex}`; const selected = inlineAnswer[key] ?? []; return <fieldset className="assistant-inline-question" key={key}><legend>{question.header || `Question ${questionIndex + 1}`}</legend><p>{question.question}</p>{question.options.map((option) => <label className="assistant-inline-option" key={option.label}><input type={question.multi_select ? 'checkbox' : 'radio'} name={key} checked={selected.includes(option.label)} onChange={(event) => setInlineAnswer((current) => ({ ...current, [key]: question.multi_select ? event.target.checked ? [...selected, option.label] : selected.filter((item) => item !== option.label) : [option.label] }))} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}<label className="assistant-inline-other">{question.options.length ? 'Other answer' : 'Your answer'}<input value={inlineOther[key] ?? ''} onChange={(event) => setInlineOther((current) => ({ ...current, [key]: event.target.value }))} /></label></fieldset>; })}{!hasQuestionGroup(questionGroup) && <p className="assistant-task-warning">This question uses older metadata. Continue in the worker chat.</p>}</div>; })}</div>}
        {task.status === 'needs_you' && resultData.startup != null && <p className="assistant-task-warning">Worker startup issue: {objectText(resultData.startup)}</p>}
        {task.result && (task.status === 'ready_for_review' ? null : <p className="assistant-task-result"><strong>Result</strong>{task.result}</p>)}
        {Array.isArray((resultData as { taskHistory?: unknown }).taskHistory) && <details><summary>Task history</summary><ol className="assistant-task-history">{((resultData as { taskHistory?: { atMs: number; kind: string; text: string }[] }).taskHistory ?? []).map((entry, index) => <li key={`${entry.atMs}:${index}`}><time>{new Date(entry.atMs).toLocaleString()}</time><b>{entry.kind}</b><span>{entry.text}</span></li>)}</ol></details>}
        <details className="assistant-task-budget" open={view !== 'conversation'}><summary>Spend limit</summary><p>{budgetValue(task) == null ? 'No spend limit set · cost may be unknown when the provider does not report it.' : `$${(budgetValue(task)! / 1_000_000).toFixed(2)} cap · enforced using the provider’s reported estimate.`}</p><form onSubmit={(event) => { event.preventDefault(); const micros = spendCap.trim() ? Math.round(Number(spendCap) * 1_000_000) : null; if (micros !== null && (!Number.isSafeInteger(micros) || micros <= 0)) { setError('Enter a positive spend cap, or leave blank to remove it.'); return; } void act(task, 'set_budget', { spendLimitMicros: micros }); }}><input aria-label="Spend cap in USD" inputMode="decimal" value={spendCap} onChange={(event) => setSpendCap(event.target.value)} placeholder="No cap" /><button type="submit" disabled={busy}>Set limit</button></form>{(resultData as { budgetPaused?: boolean }).budgetPaused && <><p className="assistant-task-warning">Paused at the provider-reported estimate limit. Raise or remove the cap, then resume. This keeps the task ID, edits, and history.</p><button type="button" disabled={busy} onClick={() => void act(task, 'resume_budget')}>Resume task</button></>}</details>
        {hasCapturedDiff && task.status !== 'ready_for_review' && <details><summary>Review diff</summary><pre>{resultData.reviewDiff}</pre></details>}
        {Array.isArray(resultData.checks) && resultData.checks.length > 0 && <details><summary>Configured checks and results</summary><pre>{objectText({ commands: resultData.checks, results: resultData.checkResults ?? 'Awaiting verification' })}</pre></details>}
        {Array.isArray(resultData.exclusions) && resultData.exclusions.length > 0 && <p className="assistant-task-muted">Excluded: {resultData.exclusions.join(', ')}</p>}
        {(resultData.executionPath || resultData.baselineCommit || resultData.resultCommit) && <p className="assistant-task-muted">{[resultData.executionPath, resultData.baselineCommit && `Base ${resultData.baselineCommit}`, resultData.resultCommit && `Result ${resultData.resultCommit}`].filter(Boolean).join(' · ')}</p>}
        {task.mode === 'isolated' && !archivedExecutions.has(task.id) && typeof resultData.worktreeDiskBytes === 'number' && <p className="assistant-task-muted">Task folder: {formatBytes(resultData.worktreeDiskBytes)}</p>}
        {(task.status === 'proposed' || (view === 'conversation' && task.status === 'needs_clarification')) && <details className="assistant-task-routing"><summary>Choose destination and worker</summary><label>Destination<select aria-label={`Destination for ${task.id}`} value={destinations[task.id] ?? (task.status === 'proposed' ? task.destination?.newThread ? 'new' : task.destination?.threadId ?? '' : '')} onChange={(event) => { setDestinations((current) => ({ ...current, [task.id]: event.target.value })); setTaskWorkers((current) => ({ ...current, [task.id]: [] })); setNewTaskWorkers((current) => ({ ...current, [task.id]: [] })); }}><option value="">Choose a thread</option>{chatThreads.map((pane) => <option key={pane.id} value={pane.id}>{pane.title}</option>)}<option value="new">Create new thread</option></select></label>{selectedDestination?.newThread ? <fieldset className="assistant-task-workers"><legend>New thread workers</legend>{workerProfiles.map((profile) => <label key={profile.id}><input type="checkbox" checked={(newTaskWorkers[task.id] ?? task.destination?.workers ?? []).includes(profile.id)} onChange={(event) => setNewTaskWorkers((current) => ({ ...current, [task.id]: event.target.checked ? [...(current[task.id] ?? (task.status === 'proposed' ? task.destination?.workers ?? [] : [])), profile.id] : (current[task.id] ?? (task.status === 'proposed' ? task.destination?.workers ?? [] : [])).filter((id) => id !== profile.id) }))} />{profile.display_name} <small>{profile.id}</small></label>)}</fieldset> : selectedDestination && <fieldset className="assistant-task-workers"><legend>Workers for {chatThreads.find((pane) => pane.id === selectedDestination.threadId)?.title ?? selectedDestination.threadId}</legend>{routingWorkers(selectedDestination.threadId ?? '').map((profile) => <label key={profile.id}><input type="checkbox" checked={(taskWorkers[task.id] ?? task.destination?.workers ?? []).includes(profile.id)} onChange={(event) => setTaskWorkers((current) => ({ ...current, [task.id]: event.target.checked ? [...(current[task.id] ?? (task.status === 'proposed' ? task.destination?.workers ?? [] : [])), profile.id] : (current[task.id] ?? (task.status === 'proposed' ? task.destination?.workers ?? [] : [])).filter((id) => id !== profile.id) }))} />{profile.display_name} <small>{profile.id}</small></label>)}{routingWorkersUnavailable(selectedDestination.threadId ?? '') && <p className="assistant-task-warning">Open or refresh the selected chat to load its worker list.</p>}{routingThreads === undefined && <p className="assistant-task-muted">Worker list unavailable; choices come from the saved non-media profile catalogue. The host validates this selection.</p>}</fieldset>}</details>}

        {task.mode === 'isolated' && taskFinal(task.status) && !archivedExecutions.has(task.id) && <div className="assistant-task-actions">{shouldSuggestArchive(task) && <p className="assistant-task-warning">This terminal worktree is over 14 days old. Archive it to save disk space; the task result and history will remain available.</p>}<button type="button" disabled={busy} onClick={() => void act(task, 'archive')}>Archive isolated worktree</button><span className="assistant-task-muted">Removes the owned worktree and keeps this task’s result and history.</span></div>}
        {task.mode === 'isolated' && archivedExecutions.has(task.id) && <p className="assistant-task-muted">Isolated worktree archived{typeof resultData.worktreeDiskBytes === 'number' ? ` · saved worktree size ${formatBytes(resultData.worktreeDiskBytes)}` : ''}. Task result and history are retained.</p>}
        {taskFinal(task.status) && <p className="assistant-task-muted">This task is {task.status}{task.status === 'cancelled' && task.mode === 'in_place' ? '; existing checkout edits remain.' : '.'}</p>}
        </div>
        {task.status === 'ready_for_review' && <div className="assistant-task-actions assistant-task-decision-actions"><label className="assistant-review-ack"><input type="checkbox" checked={reviewed(task)} disabled={!currentReviewVisible} onChange={(event) => setReviewedRevision((current) => ({ ...current, [task.id]: event.target.checked ? task.revision : -1 }))} />I opened and reviewed revision {task.revision}</label><button type="button" disabled={busy || !currentReviewVisible || !reviewed(task) || (task.reviewCriteria.length > 0 && reviewChecks.length !== task.reviewCriteria.length)} onClick={() => void act(task, task.mode === 'read_only' ? 'review' as Action : 'accept')}>{task.mode === 'read_only' ? 'Mark reviewed' : task.mode === 'isolated' ? 'Accept changes' : 'Accept and mark done'}</button></div>}
        {task.status !== 'ready_for_review' && <div className="assistant-task-actions assistant-task-status-actions">
          {pendingApprovals.map((approval, index) => <span className="assistant-task-pinned-decision" key={`approval-${index}`}>{hasApprovalAction(approval) && <><button type="button" disabled={busy} onClick={() => void decideWait(task, approval, true)}>Approve</button><button type="button" disabled={busy} onClick={() => void decideWait(task, approval, false)}>Deny</button></>}<button type="button" disabled={!task.executionThreadId} onClick={() => task.executionThreadId && onOpenThread?.(task.executionThreadId)}>Open worker chat</button></span>)}
          {pendingQuestions.map((questionGroup, index) => { const group = questionGroup && typeof questionGroup === 'object' ? questionGroup as { request?: string; questions?: Question[] } : {}; const requestKey = group.request ?? `legacy-${index}`; return hasQuestionGroup(questionGroup) ? <button key={`question-${index}`} type="button" disabled={busy || !(group.questions ?? []).every((_question, questionIndex) => ((inlineAnswer[`${task.id}:${requestKey}:${questionIndex}`] ?? []).length + (inlineOther[`${task.id}:${requestKey}:${questionIndex}`]?.trim() ? 1 : 0)) > 0)} onClick={() => void answerWait(task, questionGroup)}>Send answers</button> : null; })}
          {pendingQuestions.some((questionGroup) => !hasQuestionGroup(questionGroup)) && <button type="button" disabled={!task.executionThreadId} onClick={() => task.executionThreadId && onOpenThread?.(task.executionThreadId)}>Open worker chat</button>}
          {task.status === 'proposed' && <><button type="button" disabled={busy || !selectedDestination || selectedDestination.workers.length === 0} onClick={() => selectedDestination && void act(task, 'approve', { destination: selectedDestination, newWorkerProfiles: selectedDestination.newThread ? workerProfiles.filter((profile) => selectedDestination.workers.includes(profile.id)) : [], mode: task.mode })}>Approve task</button><button type="button" disabled={busy} onClick={() => void act(task, 'dismiss')}>Dismiss</button></>}
          {task.status === 'needs_you' && <><button type="button" disabled={!task.executionThreadId} onClick={() => task.executionThreadId && onOpenThread?.(task.executionThreadId)}>Open worker thread</button>{task.mode === 'isolated' && task.attempts.length === 0 && <button type="button" disabled={busy} onClick={() => void act(task, 'retry')}>Retry worker startup</button>}<button type="button" disabled={busy} onClick={() => void act(task, 'cancel')}>Cancel task</button></>}
          {(task.status === 'queued' || task.status === 'running' || task.status === 'applying') && !canReconcileTask(task) && <button type="button" disabled={busy} onClick={() => void act(task, 'cancel')}>Cancel task</button>}
          {(task.status === 'failed' || task.status === 'interrupted') && !canReconcileTask(task) && <><button type="button" disabled={busy} onClick={() => void act(task, 'retry')}>Retry task</button><button type="button" disabled={busy} onClick={() => void act(task, 'cancel')}>Cancel task</button></>}
          {canReconcileTask(task) && <button type="button" disabled={busy} onClick={() => void act(task, 'reconcile')}>Recover interrupted integration</button>}
        </div>}
      </article>;
    })}</div>}
    {(view === 'chat' || view === 'tasks') && <form className="assistant-request" onSubmit={selectedTask ? submitTaskContext : sendRequest}>
      <div className="assistant-composer-heading"><strong>{selectedTask ? `${selectedTask.status === 'ready_for_review' ? 'Request changes' : selectedTask.status === 'needs_clarification' ? 'Routing clarification' : composerSingleQuestion ? 'Answer worker question' : composerNeedsInlineAnswers ? 'Answer questions inline' : 'Task note'} · ${selectedTask.originalRequest.slice(0, 42)}` : 'New message'}</strong>{selectedTask && <button type="button" onClick={() => { setDraftsByContext((current) => ({ ...current, [composerContextKey]: draft })); setTaskContextId(null); setDraft(draftsByContext[`${ownerKey}\u0000new`] ?? ''); setDetailId(null); onViewChange?.('chat'); }}>New message</button>}</div>
      {selectedTask?.status === 'running' || selectedTask?.status === 'queued' || selectedTask?.status === 'applying' ? <p className="assistant-task-muted">This note is queued for the worker’s next continuation; it will not interrupt the current turn.</p> : null}
      {composerNeedsInlineAnswers && <p className="assistant-task-warning">Answer every question in its inline card above. This composer text is kept as a draft and will not be sent.</p>}
      {selectedTask?.status === 'needs_clarification' && <details className="assistant-task-routing"><summary>Choose destination and worker</summary><label>Destination<select aria-label={`Destination for ${selectedTask.id}`} value={destinations[selectedTask.id] ?? ''} onChange={(event) => { setDestinations((current) => ({ ...current, [selectedTask.id]: event.target.value })); setTaskWorkers((current) => ({ ...current, [selectedTask.id]: [] })); setNewTaskWorkers((current) => ({ ...current, [selectedTask.id]: [] })); }}><option value="">Choose a destination</option>{chatThreads.map((pane) => <option key={pane.id} value={pane.id}>{pane.title}</option>)}<option value="new">Create new thread</option></select></label>{(destinations[selectedTask.id] ?? '') === 'new' ? <fieldset className="assistant-task-workers"><legend>New thread workers</legend>{workerProfiles.map((profile) => <label key={profile.id}><input type="checkbox" checked={(newTaskWorkers[selectedTask.id] ?? []).includes(profile.id)} onChange={(event) => setNewTaskWorkers((current) => ({ ...current, [selectedTask.id]: event.target.checked ? [...(current[selectedTask.id] ?? []), profile.id] : (current[selectedTask.id] ?? []).filter((id) => id !== profile.id) }))} />{profile.display_name} <small>{profile.id}</small></label>)}</fieldset> : (() => { const pane = chatThreads.find((item) => item.id === destinations[selectedTask.id]); return pane ? <fieldset className="assistant-task-workers"><legend>Choose worker for {pane.title}</legend>{routingWorkers(pane.id).map((profile) => <label key={profile.id}><input type="checkbox" checked={(taskWorkers[selectedTask.id] ?? []).includes(profile.id)} onChange={(event) => setTaskWorkers((current) => ({ ...current, [selectedTask.id]: event.target.checked ? [...(current[selectedTask.id] ?? []), profile.id] : (current[selectedTask.id] ?? []).filter((id) => id !== profile.id) }))} />{profile.display_name} <small>{profile.id}</small></label>)}{routingWorkers(pane.id).length === 0 && <p className="assistant-task-warning">{routingWorkersUnavailable(pane.id) ? 'Open or refresh the selected chat to load its worker list.' : 'No eligible worker profile is available in this chat.'}</p>}{routingThreads === undefined && <p className="assistant-task-muted">Worker list unavailable; choices come from the saved non-media profile catalogue. The host validates this selection.</p>}</fieldset> : null; })()}{(!(taskDestination(selectedTask.id)?.workers.length)) && <p className="assistant-task-warning">Choose a destination and explicit worker ID before sending; the draft will remain saved until both are selected.</p>}</details>}
      {pendingRequest && <p className="assistant-task-warning" role="status">The last response was uncertain. Retry uses the saved request ID, scope, text, destination, and mode.</p>}
      {showAdvanced && !selectedTask && <><label>Destination<select aria-label="Task destination" value={destinationId} disabled={busy || !!pendingRequest} onChange={(event) => { const value = event.target.value; setDestinationId(value); setSelectedWorkers([]); }}><option value="">Let ApexAgent route this message</option>{chatThreads.map((pane) => <option key={pane.id} value={pane.id}>{pane.title}</option>)}<option value="new">Create a new thread</option></select></label>
      {(destinationId === 'new' || pendingRequest?.destination?.newThread) && <fieldset className="assistant-task-workers"><legend>Worker profiles</legend>{workerProfiles.map((profile) => <label key={profile.id}><input type="checkbox" checked={selectedWorkers.includes(profile.id) || !!pendingRequest?.newWorkerProfiles.some((item) => item.id === profile.id)} disabled={busy || !!pendingRequest} onChange={(event) => setSelectedWorkers((current) => event.target.checked ? [...current, profile.id] : current.filter((id) => id !== profile.id))} />{profile.display_name}</label>)}</fieldset>}</>}
      <textarea aria-label={selectedTask ? 'Task context message' : 'Message for ApexAgent'} rows={2} value={pendingRequest?.text ?? draft} disabled={busy || !!pendingRequest || composerNeedsInlineAnswers} onChange={(event) => setContextDraft(event.target.value)} placeholder={selectedTask ? 'Add a note, answer, or revision for this task…' : 'Ask about the project or describe work to delegate…'} />
      {destinationId === 'new' && selectedWorkers.length === 0 && <p className="assistant-task-warning">Select at least one worker profile to create a new thread.</p>}
      {showAdvanced && !selectedTask && <><label>Execution mode<select aria-label="Execution mode" value={mode} disabled={busy || !!pendingRequest} onChange={(event) => setMode(event.target.value as 'in_place' | 'isolated' | 'read_only')}><option value="in_place">In place · hold checkout through review</option><option value="isolated">Isolated · separate worktree</option><option value="read_only">Read only · no checkout edits</option></select></label><label>Exact checks (one JSON argv array per line)<textarea aria-label="Exact checks" rows={2} value={checkCommands} disabled={busy || !!pendingRequest} onChange={(event) => setCheckCommands(event.target.value)} placeholder={'["npm","test"]'} /></label>{mode === 'read_only' && <p className="assistant-task-warning">Read only mode does not run checks. Remove configured checks before sending.</p>}<label>Spend cap (optional, USD)<input aria-label="Spend cap" inputMode="decimal" value={requestSpendCap} onChange={(event) => setRequestSpendCap(event.target.value)} placeholder="No cap" /></label></>}
      {!selectedTask && <button type="button" className="assistant-advanced-toggle" onClick={() => setShowAdvanced((visible) => !visible)}>{showAdvanced ? 'Hide advanced' : 'Advanced options'}</button>}
      <button className="primary" disabled={busy || (!pendingRequest && (!draft.trim() || composerNeedsInlineAnswers || (destinationId === 'new' && selectedWorkers.length === 0) || (selectedTask?.status === 'needs_clarification' && !taskDestination(selectedTask.id)?.workers.length)))}>{busy ? 'Sending…' : pendingRequest ? 'Retry request' : composerActionLabel}</button>
      {pendingRequest && error && !busy && <button type="button" onClick={discardPending}>Discard saved request and start over</button>}
    </form>}
    {view === 'settings' && <div className="assistant-task-settings">{children}</div>}
  </section>;
}
