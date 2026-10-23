import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from './backend.ts';
import { TaskViewContext, projectTaskGroup, projectTaskKey, type TaskSummary } from './apexAgentTaskView.ts';
import type { Pane, ParticipantConfig, Question } from './types.ts';
import type { ProjectMonitor } from './apexAgentModel.ts';
import { archivedTaskIds, assistantMessageArgs, assistantTaskActionArgs, assistantTasksForOwner, canReconcileTask, clearPendingRequest, isTaskOwnedBy, isTerminalTask, loadPendingRequest, shouldSuggestArchive, taskStatusLabel, taskThreadLinks, taskUsageLabel, taskWorkerChoices, type AssistantTask, type AssistantTaskDestination, type AssistantTaskOwner, type AssistantTaskSnapshot, type PendingAssistantRequest } from './assistantTaskModel.ts';
import { LegacyBadge } from './LegacyImportScreen';
import { subscribeToImports } from './legacyImportRefresh.ts';
import './assistant-tasks.css';

type Action = 'clarify' | 'approve' | 'dismiss' | 'retry' | 'request_changes' | 'cancel' | 'accept' | 'review' | 'archive' | 'reconcile' | 'note' | 'resume_budget';
type Props = {
  onSelectTask?: (task: AssistantTask, send: (text: string) => Promise<void>) => void;
  /** A task left the conversation (dismissed), so any reply context pointing at it should close. */
  onTaskClosed?: (taskId: string) => void;
  projectName?: string;
  requestRecovery?: { pending: PendingAssistantRequest | null; retry: () => Promise<void>; discard: () => void };
  clearedAt?: number;
  backend: Backend;
  owner: AssistantTaskOwner;
  panes: Pane[];
  profiles: ParticipantConfig[];
  onMonitorUpdate?: (monitor: ProjectMonitor) => void;
  onOpenThread?: (id: string) => void;
  /** Compact project rows in the workspace sidebar; conversation remains the default. */
  view?: 'conversation' | 'sidebar';
  focused?: boolean;
};

/** Shown when ApexAgent proposed no chat that can run this task. The human answers in the main conversation. */
const NO_CHAT_NOTE = "ApexAgent didn't pick a chat for this. Reply to it with which chat to use.";
const objectText = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const taskFinal = (status: string) => isTerminalTask(status);
const formatBytes = (bytes: number): string => bytes < 1024 * 1024 ? `${Math.max(0, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
/** The chat and workers ApexAgent proposed for a task, or null when it named none that can run. */
const proposedDestination = (task: AssistantTask): AssistantTaskDestination | null => {
  const destination = task.destination;
  if (!destination || !destination.workers.length || (!destination.newThread && !destination.threadId)) return null;
  return { threadId: destination.newThread ? null : destination.threadId, newThread: destination.newThread, workers: [...destination.workers] };
};

/** First sentence of a long scope, cut to fit one line, so the card's buttons stay near the top. */
function scopeSummary(brief: string): string {
  const flat = brief.replace(/\s+/g, ' ').trim();
  const sentence = flat.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? flat;
  return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}…` : sentence;
}

/** One line of text, cut with an ellipsis when it is longer than `max`. */
const oneLine = (text: string, max = 120): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
/** The first readable line of a result: no code-fence markers and no protocol-looking <tags>. */
function readableResult(text: string | null | undefined): string {
  const cleaned = (text ?? '').replace(/^\s*```.*$/gm, '').replace(/<\/?[A-Za-z][\w:-]*(?:\s[^<>\n]*)?\/?>/g, '');
  const first = cleaned.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return oneLine(first, 160);
}
/** Worker display names for the task's destination (or its recorded workers); ids are shown only when no profile matches. */
const workerLabel = (task: AssistantTask, profiles: ParticipantConfig[]): string => {
  const ids = task.destination?.workers?.length ? task.destination.workers : task.workers ?? [];
  return ids.length ? ids.map((id) => profiles.find((profile) => profile.id === id)?.display_name ?? id).join(', ') : 'Not chosen yet';
};
/** Verification from saved check results; each entry records whether it succeeded. */
function verificationLabel(task: AssistantTask): string {
  const results = task.resultData?.checkResults;
  if (!Array.isArray(results) || !results.length) return 'Not verified';
  return results.every((item) => (item as { success?: unknown } | null)?.success === true) ? 'Checks passed' : 'Checks failed';
}
const modeLabel = (mode: AssistantTask['mode']): string => mode === 'read_only' ? 'Read only' : mode === 'in_place' ? 'In place' : 'Separate copy';

export function ApexAgentTasks({ backend, owner, panes, profiles, onMonitorUpdate, onOpenThread, focused, projectName, clearedAt = 0, onSelectTask, onTaskClosed, requestRecovery, view = 'conversation' }: Props) {
  const sharedSender = useRef<(taskId: string, text: string) => Promise<void>>(async () => { throw new Error('Task context is unavailable.'); });
  const [tasks, setTasks] = useState<AssistantTask[]>([]);
  const [receipt, setReceipt] = useState<{ requestId: string; status: 'pending' | 'completed' | 'interrupted' | 'unknown' | 'unchecked'; taskId?: string | null } | null>(null);
  const [routingThreads, setRoutingThreads] = useState<{ id: string; workers: ParticipantConfig[] }[] | undefined>(undefined);
  const [namedOnlyWorkerIds, setNamedOnlyWorkerIds] = useState<string[] | undefined>(undefined);
  const [archivedExecutions, setArchivedExecutions] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checks, setChecks] = useState<Record<string, string[]>>({});
  const [pendingRequest, setPendingRequest] = useState<PendingAssistantRequest | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [taskContextId, setTaskContextId] = useState<string | null>(null);
  const [reviewedRevision, setReviewedRevision] = useState<Record<string, number>>({});
  const [visibleReviewRevision, setVisibleReviewRevision] = useState<Record<string, number>>({});
  // The sidebar keeps its own selection, separate from the assistant's unified Tasks view.
  const sidebarView = view === 'sidebar';
  const sharedTaskView = useContext(TaskViewContext);
  const taskView = sidebarView ? null : sharedTaskView;
  const contextMode = taskView !== null;
  const taskDetailView = sidebarView || contextMode;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [changeOpen, setChangeOpen] = useState<Record<string, boolean>>({});
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const storeKey = `project:${owner.hostId}:${owner.workspaceId}`;
  const keyFor = (id: string) => projectTaskKey(owner.hostId, owner.workspaceId, id);
  const detailScrollRef = useRef<HTMLDivElement | null>(null);
  const reviewMaterialRef = useRef<HTMLDivElement | null>(null);
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

  const currentOwner = (captured: AssistantTaskOwner, version: number) => generation.current === version
    && activeOwner.current.workspaceId === captured.workspaceId && activeOwner.current.cwd === captured.cwd
    && activeOwner.current.hostId === captured.hostId && activeOwner.current.conversationId === captured.conversationId;

  const loadTasks = async (captured = owner, version = generation.current) => {
    if (backend.demo) { if (currentOwner(captured, version)) { setTasks([]); setLoading(false); } return; }
    const listVersion = ++listRequestVersion.current;
    try {
      const unsure = loadPendingRequest(window.localStorage, captured);
      const snapshot = await backend.call<AssistantTaskSnapshot & { request?: { requestId: string; status: 'pending' | 'completed' | 'interrupted'; taskId?: string | null } | null }>('assistant_tasks_list', unsure ? { owner: captured, requestId: unsure.requestId } : { owner: captured });
      const visible = assistantTasksForOwner(snapshot, captured);
      // Reconcile an unconfirmed message with what the service actually did, so Retry never stands beside work it already received.
      if (unsure && currentOwner(captured, version) && listRequestVersion.current === listVersion) {
        const found = snapshot.request && snapshot.request.requestId === unsure.requestId ? snapshot.request : null;
        if (found?.status === 'completed' && loadPendingRequest(window.localStorage, captured)?.requestId === unsure.requestId) {
          if (requestRecovery) requestRecovery.discard();
          else { clearPendingRequest(window.localStorage, captured); if (requestRef.current?.requestId === unsure.requestId) requestRef.current = null; setPendingRequest((current) => current?.requestId === unsure.requestId ? null : current); }
          setReceipt(null);
        } else setReceipt(found ? { requestId: unsure.requestId, status: found.status, taskId: found.taskId } : { requestId: unsure.requestId, status: snapshot.request === null ? 'unknown' : 'unchecked' });
      }
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
    setTasks([]); setRoutingThreads(undefined); setNamedOnlyWorkerIds(undefined); setArchivedExecutions(new Set()); setBusy(false); setError(''); setLoading(true); setPendingRequest(recovered); requestRef.current = recovered;
    setTaskContextId(null); setChecks({}); setDetailId(null); setReviewedRevision({});
    void loadTasks(captured, version);
    // An import writes tasks this owner now has; whatever the host does or does not
    // push, re-read once when one finishes rather than trusting a stale list.
    const stopImports = subscribeToImports(() => { void loadTasks(captured, version); });
    if (!backend.onAssistantTasksChanged) return () => { generation.current++; stopImports(); };
    let unlisten: (() => void) | undefined;
    let alive = true;
    void backend.onAssistantTasksChanged((payload) => {
      const event = payload as { workspaceId?: string } | null;
      if (alive && (!event?.workspaceId || event.workspaceId === captured.workspaceId)) void loadTasks(captured, version);
    }).then((stop) => { if (alive) unlisten = stop; else stop(); }).catch(() => {});
    return () => { alive = false; generation.current++; stopImports(); unlisten?.(); };
  }, [backend, ownerKey]);

  useEffect(() => {
    setChecks((current) => Object.fromEntries(Object.entries(current).filter(([key]) => tasks.some((task) => key === `${task.id}:${task.revision}`))));
    setReviewedRevision((current) => Object.fromEntries(Object.entries(current).filter(([id, revision]) => tasks.some((task) => task.id === id && task.revision === revision))));
    setVisibleReviewRevision((current) => Object.fromEntries(Object.entries(current).filter(([id, revision]) => tasks.some((task) => task.id === id && task.revision === revision))));
  }, [tasks]);

  // Sends only a saved request (Retry). New messages are written in the main conversation.
  const sendRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    const pending = requestRef.current;
    if (busy || !pending) return;
    const captured = owner;
    const version = generation.current;
    setBusy(true); setError('');
    try {
      const result = await backend.call<{ message: unknown; task?: AssistantTask | null; monitor: ProjectMonitor }>('assistant_message', assistantMessageArgs(captured, pending, chatThreads.map((pane) => ({ id: pane.id, label: pane.title }))));
      if (!currentOwner(captured, version)) return;
      if (!result.monitor || result.monitor.workspaceId !== captured.workspaceId || result.monitor.cwd !== captured.cwd || result.monitor.hostId !== captured.hostId || result.monitor.conversationId !== captured.conversationId) throw new Error('ApexAgent returned a different project assignment.');
      if (result.task && !isTaskOwnedBy(result.task, captured)) throw new Error('ApexAgent returned a task for a different assignment.');
      onMonitorUpdate?.(result.monitor);
      if (result.task) { listRequestVersion.current++; setTasks((current) => [result.task!, ...current.filter((task) => task.id !== result.task!.id)]); }
      requestRef.current = null; setPendingRequest(null); setError(''); clearPendingRequest(window.localStorage, captured);
      void loadTasks(captured, version);
    } catch (cause) {
      if (currentOwner(captured, version)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (currentOwner(captured, version)) setBusy(false);
    }
  };

  const recoveryRequest = requestRecovery ? requestRecovery.pending : pendingRequest;
  useEffect(() => {
    if (!recoveryRequest) { setReceipt(null); return; }
    const captured = owner, version = generation.current;
    void loadTasks(captured, version);
  }, [recoveryRequest?.requestId]);
  useEffect(() => {
    // A received message still being answered: look again shortly instead of offering Retry.
    if (receipt?.status !== 'pending') return;
    const captured = owner, version = generation.current;
    const timer = window.setTimeout(() => void loadTasks(captured, version), 5000);
    return () => window.clearTimeout(timer);
  }, [receipt]);
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
    clearPendingRequest(window.localStorage, owner); requestRef.current = null; setPendingRequest(null); setError('');
  };

  const act = async (task: AssistantTask, action: Action, payload: { text?: string; destination?: AssistantTaskDestination; newWorkerProfiles?: ParticipantConfig[]; mode?: 'in_place' | 'isolated' | 'read_only' } = {}): Promise<boolean> => {
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
      if (action === 'dismiss') { setDetailId(null); setTaskContextId(null); onTaskClosed?.(task.id); }
      void loadTasks(captured, version);
      return true;
    } catch (cause) {
      if (currentOwner(captured, version)) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      if (currentOwner(captured, version)) setBusy(false);
    }
  };

  // Approve uses the chat and workers ApexAgent proposed, and the task's own mode.
  const approveProposal = (task: AssistantTask, destination: AssistantTaskDestination) => act(task, 'approve', {
    destination, newWorkerProfiles: destination.newThread ? workerProfiles.filter((profile) => destination.workers.includes(profile.id)) : [], mode: task.mode,
  });

  const renderChecks = (task: AssistantTask) => {
    const criteria = task.reviewCriteria ?? [];
    if (!criteria.length) return <p className="assistant-task-muted">No review criteria were supplied. Confirm that you reviewed this result.</p>;
    const key = `${task.id}:${task.revision}`;
    const selected = checks[key] ?? [];
    return <fieldset className="assistant-task-checks"><legend>Human review criteria</legend>{criteria.map((criterion) => <label key={criterion}><input type="checkbox" checked={selected.includes(criterion)} onChange={(event) => setChecks((current) => ({ ...current, [key]: event.target.checked ? [...selected, criterion] : selected.filter((item) => item !== criterion) }))} />I reviewed: {criterion}</label>)}</fieldset>;
  };

  const openTaskDetail = (task: AssistantTask) => {
    if (!isTaskOwnedBy(task, activeOwner.current)) return;
    setTaskContextId(task.id); setDetailId(task.id); setReviewedRevision((current) => ({ ...current, [task.id]: -1 }));
    if (!sidebarView && onSelectTask && !taskFinal(task.status)) {
      const captured = owner; const version = generation.current;
      onSelectTask(task, async (text) => {
        if (!currentOwner(captured, version)) throw new Error('This task assignment changed. Select the task again.');
        await sharedSender.current(task.id, text);
      });
    }
  };
  const reviewed = (task: AssistantTask) => reviewedRevision[task.id] === task.revision;
  const hasCurrentRequest = (wait: unknown) => !!wait && typeof wait === 'object' && typeof (wait as { request?: unknown }).request === 'string' && !!(wait as { request: string }).request;
  const hasQuestionGroup = (wait: unknown): wait is { request: string; questions: Question[] } => hasCurrentRequest(wait) && !!wait && typeof wait === 'object' && Array.isArray((wait as { questions?: unknown }).questions) && (wait as { questions: unknown[] }).questions.length > 0 && (wait as { questions: unknown[] }).questions.every((question) => !!question && typeof question === 'object' && typeof (question as Question).question === 'string' && Array.isArray((question as Question).options));
  const hasApprovalAction = (wait: unknown) => hasCurrentRequest(wait) && !!wait && typeof wait === 'object' && !!(wait as { action?: unknown }).action && typeof (wait as { action: { title?: unknown; detail?: unknown } }).action.title === 'string' && typeof (wait as { action: { title?: unknown; detail?: unknown } }).action.detail === 'string';
  // In context mode the Tasks view's selection drives the detail; otherwise the local card selection does.
  const contextTask = taskView && taskView.selectedKey ? tasks.find((task) => isTaskOwnedBy(task, owner) && keyFor(task.id) === taskView.selectedKey) ?? null : null;
  const activeTaskId = contextMode ? (contextTask?.id ?? null) : detailId;
  const selectedTask = tasks.find((task) => task.id === (contextMode ? activeTaskId : taskContextId) && isTaskOwnedBy(task, owner));
  const hasReviewMaterial = (task: AssistantTask) => {
    const data = task.resultData ?? {};
    return task.mode === 'read_only'
      ? typeof data.reviewDiff === 'string' || !!task.result?.trim() || task.evidence.length > 0
      : typeof data.reviewDiff === 'string';
  };
  useEffect(() => {
    const task = selectedTask;
    if (!task || activeTaskId !== task.id || task.status !== 'ready_for_review' || !hasReviewMaterial(task)) return;
    const root = detailScrollRef.current;
    const target = reviewMaterialRef.current;
    if (!root || !target || typeof IntersectionObserver === 'undefined') return;
    const captured = owner;
    const version = generation.current;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.target === target && entry.isIntersecting && entry.intersectionRatio > 0)) return;
      const current = tasks.find((candidate) => candidate.id === task.id);
      if (!currentOwner(captured, version) || activeTaskId !== task.id || !current || current.revision !== task.revision || !isTaskOwnedBy(current, captured)) return;
      setVisibleReviewRevision((previous) => ({ ...previous, [task.id]: task.revision }));
    }, { root, threshold: 0.01 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [activeTaskId, selectedTask?.id, selectedTask?.revision, selectedTask?.status, tasks]);
  useEffect(() => { if (clearedAt) { setDetailId(null); setTaskContextId(null); } }, [clearedAt]);

  // Report this store's rows to the unified Tasks list. Finished tasks stay (Clear only hides chat); dismissed ones do not.
  const summaryRows = useMemo<TaskSummary[]>(() => tasks.filter((task) => isTaskOwnedBy(task, owner) && !task.resultData?.dismissedAtMs).map((task) => ({
    key: keyFor(task.id), source: 'project', hostId: owner.hostId, workspaceId: owner.workspaceId, id: task.id,
    title: oneLine(task.originalRequest), place: projectName ?? 'Project', worker: workerLabel(task, profiles), status: task.status, statusLabel: taskStatusLabel(task.status),
    group: projectTaskGroup(task), result: readableResult(task.result), updatedAt: task.updatedAtMs,
  })), [tasks, ownerKey, projectName, profiles]);
  // The report function is deliberately left out of the deps: a changing identity must not re-report and loop.
  useEffect(() => { taskView?.report(storeKey, summaryRows); }, [summaryRows, storeKey, contextMode]);
  useEffect(() => () => { taskView?.report(storeKey, []); }, [storeKey]);
  // Moving to a selected task moves focus to its title.
  useEffect(() => { if ((contextMode && taskView?.selectedKey && contextTask) || (sidebarView && detailId)) titleRef.current?.focus?.(); }, [taskView?.selectedKey, contextTask?.id, sidebarView, detailId]);
  const sendTaskText = async (task: AssistantTask, text: string): Promise<boolean> => {
    if (task.status === 'needs_clarification') {
      const destination = proposedDestination(task);
      if (!destination) { setError(NO_CHAT_NOTE); return false; }
      return act(task, 'clarify', { text, destination, newWorkerProfiles: destination.newThread ? workerProfiles.filter((profile) => destination.workers.includes(profile.id)) : [], mode: task.mode });
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

  // Conversation rows (legacy cards, or one link line each in context mode) and the detail. Links never act or bind the composer.
  const sidebarTasks = tasks.filter((task) => isTaskOwnedBy(task, owner) && !task.resultData?.dismissedAtMs);
  const visibleCards = sidebarTasks.filter((task) => !taskFinal(task.status) || task.updatedAtMs > clearedAt);
  const tasksOnly = taskView?.display === 'tasks';
  const detailVisible = contextMode ? tasksOnly && !!contextTask : !!detailId;
  // Reply text is kept per task and per kind, so it survives re-renders until it is sent.
  const draftKey = (taskId: string, kind: string) => `${taskId}\u0000${kind}`;
  const draftText = (taskId: string, kind: string) => drafts[draftKey(taskId, kind)] ?? '';
  const setDraft = (taskId: string, kind: string, value: string) => setDrafts((current) => ({ ...current, [draftKey(taskId, kind)]: value }));
  const sendDraft = async (task: AssistantTask, kind: string) => {
    const text = draftText(task.id, kind).trim();
    if (!text) return;
    if (await sendTaskText(task, text)) setDraft(task.id, kind, '');
  };
  const taskLink = (task: AssistantTask) => {
    const key = keyFor(task.id);
    const title = oneLine(task.originalRequest, 60);
    const label = task.status === 'ready_for_review' ? `Review result · ${title}` : task.status === 'done' && task.result?.trim() ? `Result ready · ${title}` : `Task · ${taskStatusLabel(task.status)} · ${title}`;
    return <button type="button" className="assistant-task-link" key={key} onClick={() => taskView?.openTask(key)}>{`${label} ›`}</button>;
  };

  return <section className={`assistant-tasks ${sidebarView ? 'assistant-task-sidebar' : 'assistant-task-conversation'}`} aria-label={sidebarView ? 'Project tasks' : 'Assistant workspace'} data-assistant-workspace-id={owner.workspaceId} data-focused={focused ? 'true' : 'false'}>
    {sidebarView && <header className="assistant-task-sidebar-heading"><h2>Tasks</h2><p>{projectName ?? owner.workspaceId}</p>{detailId && <button type="button" className="assistant-back" onClick={() => { setDetailId(null); setTaskContextId(null); }}>Back to tasks</button>}</header>}
    {!tasksOnly && recoveryRequest && <article className="assistant-chat-message assistant" role="status">
      <small>Unconfirmed message{projectName ? ` · ${projectName}` : ''}</small><p>{recoveryRequest.text}</p>
      {(() => { const known = receipt?.requestId === recoveryRequest.requestId ? receipt : null; return <>
        <p>{known?.status === 'pending' ? 'The service received this and is still answering it. Retry is off so it can’t run twice.' : known?.status === 'interrupted' ? `The service received this but restarted before answering${known.taskId ? '. It had already created its task, so Retry shows that task instead of making a second one' : ''}.` : known?.status === 'unknown' ? 'The service never received this message. Retry sends it once.' : known?.status === 'unchecked' ? 'The last response was uncertain. Retry reuses the saved request ID, so the service won’t do it twice.' : 'Checking whether the service received this…'}</p>
        {error && <p className="assistant-task-warning">{error}</p>}
        {known?.status !== 'pending' && <button type="button" disabled={busy || !known} onClick={retryRecovery}>{busy ? 'Retrying…' : 'Retry request'}</button>}
      </>; })()}
      <button type="button" disabled={busy} onClick={() => requestRecovery ? requestRecovery.discard() : discardPending()}>Discard saved request and start over</button>
    </article>}
    {taskView?.display === 'links' && visibleCards.map(taskLink)}
    {sidebarView && !detailId && <div className="assistant-task-sidebar-list">{sidebarTasks.map((task) => <button type="button" className="assistant-task-sidebar-row" data-assistant-task-id={task.id} key={task.id} onClick={() => openTaskDetail(task)}>
      <span className="assistant-task-sidebar-summary"><strong title={task.originalRequest}>{oneLine(task.originalRequest)}</strong><small>{workerLabel(task, profiles)}</small></span><span className={`assistant-task-sidebar-status status-${task.status}`}>{taskStatusLabel(task.status)}</span>{task.legacy && <LegacyBadge />}
    </button>)}{!loading && !error && !sidebarTasks.length && <p className="assistant-task-muted">No tasks for this project yet.</p>}</div>}
    {!contextMode && !sidebarView && visibleCards.map((task) => <article className="assistant-chat-message assistant" data-assistant-task-id={task.id} key={task.id}>
      <small>Delegated work{projectName ? ` · ${projectName}` : ''} · {taskStatusLabel(task.status)}</small><p className="assistant-task-request" title={task.originalRequest}>{task.originalRequest}</p>{typeof (task.resultData as { batchId?: unknown } | null)?.batchId === 'string' && <small>From your cross-project plan</small>}
      <div className="assistant-task-card-actions"><button type="button" onClick={() => openTaskDetail(task)}>{task.status === 'ready_for_review' ? 'Review result' : 'Open task'}</button>
      {(task.status === 'proposed' || task.status === 'needs_clarification') && <button type="button" disabled={busy} onClick={() => void act(task, 'dismiss')}>Dismiss</button>}</div>
      {task.brief.length > 160 ? <details className="assistant-task-scope"><summary>Scope: {scopeSummary(task.brief)}</summary><p>{task.brief}</p></details> : <p className="assistant-task-muted">Scope: {task.brief}</p>}
    </article>)}
    {!contextMode && !sidebarView && detailId && <button type="button" onClick={() => { setDetailId(null); setTaskContextId(null); }}>Close task details</button>}
    {(!tasksOnly || contextTask) && error && <p className="assistant-task-error" role="alert">{error}</p>}
    {(!tasksOnly || contextTask) && loading && <p className="assistant-task-muted" role="status">Loading tasks…</p>}
    {!contextMode && detailId && !selectedTask && <p className="assistant-task-muted">This task is no longer available in the current assignment.</p>}
    {detailVisible && <div className="assistant-task-list">{tasks.filter((task) => task.id === activeTaskId && isTaskOwnedBy(task, owner)).map((task) => {
      const resultData = task.resultData ?? {};
      const pendingApprovals = resultData.pendingApprovals ?? [];
      const pendingQuestions = resultData.pendingQuestions ?? [];
      const proposal = proposedDestination(task);
      const reviewChecks = checks[`${task.id}:${task.revision}`] ?? [];
      const hasCapturedDiff = typeof resultData.reviewDiff === 'string';
      const hasReviewData = hasReviewMaterial(task);
      const currentReviewVisible = hasReviewData && visibleReviewRevision[task.id] === task.revision;
      return <article className={`assistant-task-card status-${task.status}`} key={task.id}>
        {taskDetailView && <h2 className="assistant-task-title" id={`assistant-task-title-${task.id}`} tabIndex={-1} ref={titleRef}>{oneLine(task.originalRequest)}</h2>}
        <header><div><span className="assistant-task-status">{taskStatusLabel(task.status)}</span>{task.legacy && <LegacyBadge />}<span className="assistant-task-meta">Revision {task.revision} · {task.mode === 'read_only' ? 'Read only' : task.mode === 'in_place' ? 'In place' : 'Separate copy'}</span></div><span className="assistant-task-usage">{taskUsageLabel(task.usage ?? task.attempts.at(-1)?.usage)}</span></header>
        <div className="assistant-task-detail-scroll" ref={detailScrollRef}>
        {taskDetailView && task.result?.trim() && <section className="assistant-task-result-block" aria-label="Result">
          <h3>Result</h3>
          <p className="assistant-task-result-text">{task.result}</p>
          <p className="assistant-task-muted">{`Worker: ${workerLabel(task, profiles)} · Project: ${projectName ?? owner.workspaceId} · Machine: ${owner.hostId} · ${taskFinal(task.status) ? 'Finished' : 'Updated'} ${new Date(task.updatedAtMs).toLocaleString()} · ${verificationLabel(task)}`}</p>
          {task.executionThreadId ? <button type="button" onClick={() => task.executionThreadId && onOpenThread?.(task.executionThreadId)}>Open worker chat</button> : <p className="assistant-task-muted">No result file to open — the result is the text above.</p>}
        </section>}
        {typeof (resultData as { batchId?: unknown }).batchId === 'string' && <p className="assistant-task-muted">From your cross-project plan</p>}
        <details><summary>Original request and brief</summary><p className="assistant-task-original"><strong>Original request</strong>{task.originalRequest}</p><p className="assistant-task-brief"><strong>Brief</strong>{task.brief}</p></details>
        {taskDetailView && (task.status === 'proposed' || task.status === 'needs_clarification') && <p className="assistant-task-plan"><strong>Plan</strong> {task.brief}</p>}
        {taskDetailView && task.status === 'needs_clarification' && <p className="assistant-task-warning">{proposedDestination(task) ? 'ApexAgent has a question before it starts. Its question is in the conversation; answer it below.' : "ApexAgent didn't pick a chat for this. Say which chat to use below, or Dismiss it."}</p>}
        {task.status === 'proposed' && <dl className="assistant-task-proposal" aria-label="Proposed destination">
          <div><dt>Worker</dt><dd>{workerLabel(task, profiles)}</dd></div>
          <div><dt>Destination chat</dt><dd>{task.destination ? (task.destination.newThread ? 'New thread' : chatThreads.find((pane) => pane.id === task.destination?.threadId)?.title ?? task.destination.threadId ?? 'Needs clarification') : 'Needs clarification'}</dd></div>
          <div><dt>Machine</dt><dd>{owner.hostId}</dd></div>
          <div><dt>Mode</dt><dd>{modeLabel(task.mode)}</dd></div>
        </dl>}
        {task.destination && task.status !== 'proposed' && <p className="assistant-task-muted">Destination: {task.destination.newThread ? 'New thread' : chatThreads.find((pane) => pane.id === task.destination?.threadId)?.title ?? task.destination.threadId ?? 'Needs clarification'}{task.destination.workers.length ? ` · Workers: ${task.destination.workers.join(', ')}` : ''}</p>}
        {task.mode === 'in_place' && task.status === 'queued' && <p className="assistant-task-lease">Queued for checkout access; work starts when the current writer releases it.</p>}
        {task.mode === 'in_place' && ['running', 'needs_you', 'ready_for_review', 'applying'].includes(task.status) && <p className="assistant-task-lease">Edits are already in the checkout. This task holds the writer lease through review; other Deck writers wait. Accept releases the lease, and Request changes keeps it.</p>}
        <nav className="assistant-task-links" aria-label="Related threads">{taskThreadLinks(task).map((link) => <button type="button" key={link.id} onClick={() => onOpenThread?.(link.id)}>{link.label}</button>)}</nav>
        {task.status === 'ready_for_review' && hasReviewData && <div className="assistant-review-material" ref={reviewMaterialRef}>{!taskDetailView && task.result && <p className="assistant-task-result"><strong>Result</strong>{task.result}</p>}{hasCapturedDiff && <section className="assistant-review-diff"><h3>{resultData.reviewDiff ? 'Review diff' : 'Review result'}</h3>{resultData.reviewDiff ? <pre>{resultData.reviewDiff}</pre> : <p>No file changes in this result.</p>}</section>}{task.evidence.length > 0 && <section className="assistant-task-evidence"><h3>Findings and evidence</h3>{task.evidence.map((item, index) => <p key={index}>{item}</p>)}</section>}</div>}
        {task.status === 'ready_for_review' && <div className="assistant-review-criteria">{renderChecks(task)}</div>}
        {task.status === 'ready_for_review' && !hasReviewData && <p className="assistant-task-warning">The current result has no review diff or captured findings. Open the worker chat and refresh after its result is available.</p>}
        {task.status === 'ready_for_review' && hasReviewData && !currentReviewVisible && <p className="assistant-task-muted">Scroll the current result, diff, or findings into view to enable acknowledgement.</p>}
        {pendingApprovals.length > 0 && <div className="assistant-task-waits"><strong>Waiting for approval</strong>{pendingApprovals.map((approval, index) => { const action = approval && typeof approval === 'object' ? (approval as { action?: { title?: string; detail?: string } }).action : undefined; return <div key={index}><p><b>{action?.title ?? 'Worker approval'}</b>{action?.detail ? `\n${action.detail}` : `\n${objectText(approval)}`}</p></div>; })}</div>}
        {pendingQuestions.length > 0 && <div className="assistant-task-waits"><strong>Waiting for your answer</strong>{pendingQuestions.map((questionGroup, groupIndex) => { const group = questionGroup && typeof questionGroup === 'object' ? questionGroup as { request?: string; questions?: Question[] } : {}; const requestKey = group.request ?? `legacy-${groupIndex}`; return <div key={groupIndex}>{hasQuestionGroup(questionGroup) && (group.questions ?? []).map((question, questionIndex) => { const key = `${task.id}:${requestKey}:${questionIndex}`; const selected = inlineAnswer[key] ?? []; return <fieldset className="assistant-inline-question" key={key}><legend>{question.header || `Question ${questionIndex + 1}`}</legend><p>{question.question}</p>{question.options.map((option) => <label className="assistant-inline-option" key={option.label}><input type={question.multi_select ? 'checkbox' : 'radio'} name={key} checked={selected.includes(option.label)} onChange={(event) => setInlineAnswer((current) => ({ ...current, [key]: question.multi_select ? event.target.checked ? [...selected, option.label] : selected.filter((item) => item !== option.label) : [option.label] }))} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}<label className="assistant-inline-other">{question.options.length ? 'Other answer' : 'Your answer'}<input value={inlineOther[key] ?? ''} onChange={(event) => setInlineOther((current) => ({ ...current, [key]: event.target.value }))} /></label></fieldset>; })}{!hasQuestionGroup(questionGroup) && <p className="assistant-task-warning">This question uses older metadata. Continue in the worker chat.</p>}</div>; })}</div>}
        {task.status === 'needs_you' && resultData.startup != null && <p className="assistant-task-warning">Worker startup issue: {objectText(resultData.startup)}</p>}
        {!taskDetailView && task.result && (task.status === 'ready_for_review' ? null : <p className="assistant-task-result"><strong>Result</strong>{task.result}</p>)}
        {Array.isArray((resultData as { taskHistory?: unknown }).taskHistory) && <details><summary>Task history</summary><ol className="assistant-task-history">{((resultData as { taskHistory?: { atMs: number; kind: string; text: string }[] }).taskHistory ?? []).map((entry, index) => <li key={`${entry.atMs}:${index}`}><time>{new Date(entry.atMs).toLocaleString()}</time><b>{entry.kind}</b><span>{entry.text}</span></li>)}</ol></details>}
        {(resultData as { budgetPaused?: boolean }).budgetPaused && <div className="assistant-task-budget"><p className="assistant-task-warning">Paused at its spend limit. Raise the daily limit in Rules, then resume. This keeps the task ID, edits, and history.</p><button type="button" disabled={busy} onClick={() => void act(task, 'resume_budget')}>Resume task</button></div>}
        {hasCapturedDiff && task.status !== 'ready_for_review' && <details><summary>Review diff</summary><pre>{resultData.reviewDiff}</pre></details>}
        {Array.isArray(resultData.checks) && resultData.checks.length > 0 && <details><summary>Configured checks and results</summary><pre>{objectText({ commands: resultData.checks, results: resultData.checkResults ?? 'Awaiting verification' })}</pre></details>}
        {Array.isArray(resultData.exclusions) && resultData.exclusions.length > 0 && <p className="assistant-task-muted">Excluded: {resultData.exclusions.join(', ')}</p>}
        {(resultData.executionPath || resultData.baselineCommit || resultData.resultCommit) && <p className="assistant-task-muted">{[resultData.executionPath, resultData.baselineCommit && `Base ${resultData.baselineCommit}`, resultData.resultCommit && `Result ${resultData.resultCommit}`].filter(Boolean).join(' · ')}</p>}
        {task.mode === 'isolated' && !archivedExecutions.has(task.id) && typeof resultData.worktreeDiskBytes === 'number' && <p className="assistant-task-muted">Task folder: {formatBytes(resultData.worktreeDiskBytes)}</p>}

        {task.mode === 'isolated' && taskFinal(task.status) && !archivedExecutions.has(task.id) && <div className="assistant-task-actions">{shouldSuggestArchive(task) && <p className="assistant-task-warning">This terminal worktree is over 14 days old. Archive it to save disk space; the task result and history will remain available.</p>}<button type="button" disabled={busy} onClick={() => void act(task, 'archive')}>Archive isolated worktree</button><span className="assistant-task-muted">Removes the owned worktree and keeps this task’s result and history.</span></div>}
        {task.mode === 'isolated' && archivedExecutions.has(task.id) && <p className="assistant-task-muted">Isolated worktree archived{typeof resultData.worktreeDiskBytes === 'number' ? ` · saved worktree size ${formatBytes(resultData.worktreeDiskBytes)}` : ''}. Task result and history are retained.</p>}
        {taskDetailView && task.status === 'needs_clarification' && <div className="assistant-task-reply">
          <label><span>{"Answer ApexAgent's question"}</span><textarea rows={2} value={draftText(task.id, 'answer')} onChange={(event) => setDraft(task.id, 'answer', event.target.value)} /></label>
          <button type="button" disabled={busy || !draftText(task.id, 'answer').trim()} onClick={() => void sendDraft(task, 'answer')}>Send answer</button>
        </div>}
        {taskDetailView && task.status === 'ready_for_review' && <div className="assistant-task-reply">
          {changeOpen[task.id] ? <>
            <label><span>What should change</span><textarea rows={3} value={draftText(task.id, 'changes')} onChange={(event) => setDraft(task.id, 'changes', event.target.value)} /></label>
            <button type="button" disabled={busy || !draftText(task.id, 'changes').trim()} onClick={() => void sendDraft(task, 'changes')}>{`Send change request to ${workerLabel(task, profiles)}`}</button>
          </> : <button type="button" disabled={busy} onClick={() => setChangeOpen((current) => ({ ...current, [task.id]: true }))}>Request changes…</button>}
        </div>}
        {taskDetailView && ['queued', 'running', 'applying', 'needs_you'].includes(task.status) && pendingQuestions.length === 0 && <div className="assistant-task-reply">
          <label><span>Add a note for the worker</span><textarea rows={2} value={draftText(task.id, 'note')} onChange={(event) => setDraft(task.id, 'note', event.target.value)} /></label>
          <button type="button" disabled={busy || !draftText(task.id, 'note').trim()} onClick={() => void sendDraft(task, 'note')}>Send note</button>
        </div>}
        {taskFinal(task.status) && <p className="assistant-task-muted">{task.resultData?.dismissedAtMs ? 'You dismissed this proposal, so nothing ran.' : <>This task is {task.status}{task.status === 'cancelled' && task.mode === 'in_place' ? '; existing checkout edits remain.' : '.'}</>}</p>}
        </div>
        {task.status === 'ready_for_review' && <div className="assistant-task-actions assistant-task-decision-actions"><label className="assistant-review-ack"><input type="checkbox" checked={reviewed(task)} disabled={!currentReviewVisible} onChange={(event) => setReviewedRevision((current) => ({ ...current, [task.id]: event.target.checked ? task.revision : -1 }))} />I opened and reviewed revision {task.revision}</label><button type="button" disabled={busy || !currentReviewVisible || !reviewed(task) || (task.reviewCriteria.length > 0 && reviewChecks.length !== task.reviewCriteria.length)} onClick={() => void act(task, task.mode === 'read_only' ? 'review' : 'accept')}>{task.mode === 'read_only' ? 'Mark reviewed' : task.mode === 'isolated' ? 'Accept changes' : 'Accept and mark done'}</button></div>}
        {task.status !== 'ready_for_review' && <div className="assistant-task-actions assistant-task-status-actions">
          {pendingApprovals.map((approval, index) => <span className="assistant-task-pinned-decision" key={`approval-${index}`}>{hasApprovalAction(approval) && <><button type="button" disabled={busy} onClick={() => void decideWait(task, approval, true)}>Approve</button><button type="button" disabled={busy} onClick={() => void decideWait(task, approval, false)}>Deny</button></>}<button type="button" disabled={!task.executionThreadId} onClick={() => task.executionThreadId && onOpenThread?.(task.executionThreadId)}>Open worker chat</button></span>)}
          {pendingQuestions.map((questionGroup, index) => { const group = questionGroup && typeof questionGroup === 'object' ? questionGroup as { request?: string; questions?: Question[] } : {}; const requestKey = group.request ?? `legacy-${index}`; return hasQuestionGroup(questionGroup) ? <button key={`question-${index}`} type="button" disabled={busy || !(group.questions ?? []).every((_question, questionIndex) => ((inlineAnswer[`${task.id}:${requestKey}:${questionIndex}`] ?? []).length + (inlineOther[`${task.id}:${requestKey}:${questionIndex}`]?.trim() ? 1 : 0)) > 0)} onClick={() => void answerWait(task, questionGroup)}>Send answers</button> : null; })}
          {pendingQuestions.some((questionGroup) => !hasQuestionGroup(questionGroup)) && <button type="button" disabled={!task.executionThreadId} onClick={() => task.executionThreadId && onOpenThread?.(task.executionThreadId)}>Open worker chat</button>}
          {task.status === 'needs_clarification' && <button type="button" disabled={busy} onClick={() => void act(task, 'dismiss')}>Dismiss</button>}
          {task.status === 'proposed' && (proposal
            ? <><button type="button" disabled={busy} onClick={() => void approveProposal(task, proposal)}>Approve task</button><button type="button" disabled={busy} onClick={() => void act(task, 'dismiss')}>Dismiss</button></>
            : <><p className="assistant-task-warning">{NO_CHAT_NOTE}</p><button type="button" disabled={busy} onClick={() => void act(task, 'dismiss')}>Dismiss</button></>)}
          {task.status === 'needs_you' && <><button type="button" disabled={!task.executionThreadId} onClick={() => task.executionThreadId && onOpenThread?.(task.executionThreadId)}>Open worker thread</button>{task.mode === 'isolated' && task.attempts.length === 0 && <button type="button" disabled={busy} onClick={() => void act(task, 'retry')}>Retry worker startup</button>}<button type="button" disabled={busy} onClick={() => void act(task, 'cancel')}>Cancel task</button></>}
          {(task.status === 'queued' || task.status === 'running' || task.status === 'applying') && !canReconcileTask(task) && <button type="button" disabled={busy} onClick={() => void act(task, 'cancel')}>Cancel task</button>}
          {task.legacy && (task.status === 'failed' || task.status === 'interrupted' || task.status === 'needs_you')
            && <p className="assistant-task-warning">Came from an older copy. It was saved for <span className="mono">{task.owner.cwd}</span> — check that folder exists here before you retry it.</p>}
          {(task.status === 'failed' || task.status === 'interrupted') && !canReconcileTask(task) && <><button type="button" disabled={busy} onClick={() => void act(task, 'retry')}>Retry task</button><button type="button" disabled={busy} onClick={() => void act(task, 'cancel')}>Cancel task</button></>}
          {canReconcileTask(task) && <button type="button" disabled={busy} onClick={() => void act(task, 'reconcile')}>Recover interrupted integration</button>}
        </div>}
      </article>;
    })}</div>}
  </section>;
}
