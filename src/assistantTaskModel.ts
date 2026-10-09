import type { Pane, ParticipantConfig, RoomOptions } from './types.ts';

export type AssistantTaskStatus = 'proposed' | 'needs_clarification' | 'queued' | 'running' | 'needs_you' | 'ready_for_review' | 'applying' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export interface AssistantTaskOwner {
  workspaceId: string;
  cwd: string;
  hostId: string;
  conversationId: string;
}
export interface AssistantExecutionPane extends Pane {
  kind: 'chat';
  participants: ParticipantConfig[];
  options: RoomOptions;
  started: true;
  assistantTaskId: string;
  hostId: string;
  executionPath: string;
}
export interface AssistantTaskDestination {
  threadId: string | null;
  workers: string[];
  newThread: boolean;
}
export interface AssistantTask {
  id: string;
  workspaceId: string;
  owner: AssistantTaskOwner;
  destination: AssistantTaskDestination | null;
  origin: 'human_request' | 'proposal';
  originalRequest: string;
  brief: string;
  evidence: string[];
  reviewCriteria: string[];
  parentThreadId: string | null;
  executionThreadId: string | null;
  workers: string[];
  attempts: { number: number; runId: string; status: AssistantTaskStatus; startedAtMs: number; finishedAtMs: number | null; reviewRevision: number | null; usage: TaskUsage | null }[];
  status: AssistantTaskStatus;
  result: string | null;
  resultData?: { reviewDiff?: string; checks?: unknown[]; checkResults?: unknown[]; exclusions?: string[]; executionPath?: string; baselineCommit?: string; resultCommit?: string; pendingApprovals?: unknown[]; pendingQuestions?: unknown[]; startup?: unknown; integrationPlan?: unknown; applyJournal?: string; archivedAtMs?: number; worktreeDiskBytes?: number } | null;
  revision: number;
  mode: 'in_place' | 'isolated';
  usage: TaskUsage | null;
  createdAtMs: number;
  updatedAtMs: number;
}
export interface TaskUsage { inputTokens?: number | null; outputTokens?: number | null; costMicros?: number | null }
export interface AssistantTaskSnapshot { workspaceId: string; revision: number; tasks: AssistantTask[]; executions: { taskId: string; workspaceId: string; threadId: string; mode: 'in_place' | 'isolated'; tombstonedAtMs: number | null; pane?: AssistantExecutionPane }[] }
export interface PendingAssistantRequest {
  requestId: string;
  text: string;
  owner: AssistantTaskOwner;
  destination: AssistantTaskDestination | null;
  newWorkerProfiles: ParticipantConfig[];
  mode: 'in_place' | 'isolated';
  checks: string[][];
  threadLabels?: { id: string; label: string }[];
}

export function pendingRequestStorageKey(owner: AssistantTaskOwner): string {
  return `apex-agent-pending:${encodeURIComponent(owner.workspaceId)}:${encodeURIComponent(owner.cwd)}:${encodeURIComponent(owner.hostId)}:${encodeURIComponent(owner.conversationId)}`;
}

export function pendingRequestMatchesOwner(pending: PendingAssistantRequest, owner: AssistantTaskOwner): boolean {
  return isTaskOwnedBy({ owner: pending.owner }, owner);
}

export function loadPendingRequest(storage: Pick<Storage, 'getItem' | 'removeItem'>, owner: AssistantTaskOwner): PendingAssistantRequest | null {
  const key = pendingRequestStorageKey(owner);
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as PendingAssistantRequest;
    if (typeof pending.requestId === 'string' && typeof pending.text === 'string' && pendingRequestMatchesOwner(pending, owner)) return { ...pending, checks: Array.isArray(pending.checks) ? pending.checks : [], mode: pending.mode === 'isolated' ? 'isolated' : 'in_place' };
  } catch { /* discard malformed local recovery state */ }
  storage.removeItem(key);
  return null;
}

export function savePendingRequest(storage: Pick<Storage, 'setItem'>, pending: PendingAssistantRequest, owner: AssistantTaskOwner): void {
  if (!pendingRequestMatchesOwner(pending, owner)) throw new Error('A pending request cannot be reused for a different assignment.');
  storage.setItem(pendingRequestStorageKey(owner), JSON.stringify(pending));
}

export function clearPendingRequest(storage: Pick<Storage, 'removeItem'>, owner: AssistantTaskOwner): void {
  storage.removeItem(pendingRequestStorageKey(owner));
}

export function assistantMessageArgs(owner: AssistantTaskOwner, pending: PendingAssistantRequest, threadLabels: { id: string; label: string }[], checks?: string[][]) {
  if (!pendingRequestMatchesOwner(pending, owner)) throw new Error('A pending request cannot be sent for a different assignment.');
  return {
    workspaceId: owner.workspaceId, cwd: owner.cwd, hostId: owner.hostId, conversationId: owner.conversationId,
    requestId: pending.requestId, text: pending.text, destination: pending.destination,
    newWorkerProfiles: pending.newWorkerProfiles, threadLabels: pending.threadLabels ?? threadLabels, mode: pending.mode,
    checks: checks ?? pending.checks,
  };
}

export function assistantTaskActionArgs(task: AssistantTask, action: string, payload: { text?: string; destination?: AssistantTaskDestination; newWorkerProfiles?: ParticipantConfig[]; checks?: string[][]; mode?: 'in_place' | 'isolated' } = {}) {
  return { taskId: task.id, revision: task.revision, owner: task.owner, mode: task.mode, action, ...payload };
}

export function assistantProfileChoices(profiles: ParticipantConfig[]): ParticipantConfig[] {
  return profiles.filter((profile) => !profile.media && (profile.backend.kind === 'open_ai_compatible'
    || (profile.backend.kind === 'agent' && profile.backend.tool === 'claude_code')));
}

/** A new task worker is an ordinary text participant, separate from the restricted assistant profile. */
export function taskWorkerChoices(profiles: ParticipantConfig[]): ParticipantConfig[] {
  return profiles.filter((profile) => !profile.media);
}

export function isTaskOwnedBy(task: Pick<AssistantTask, 'owner'>, owner: AssistantTaskOwner): boolean {
  return task.owner.workspaceId === owner.workspaceId && task.owner.cwd === owner.cwd
    && task.owner.hostId === owner.hostId && task.owner.conversationId === owner.conversationId;
}

export function taskStatusLabel(status: AssistantTaskStatus | string): string {
  const labels: Record<string, string> = {
    proposed: 'Proposed', needs_clarification: 'Needs clarification', queued: 'Queued', running: 'Running',
    needs_you: 'Needs you', ready_for_review: 'Ready for review', applying: 'Applying', done: 'Done',
    failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
  };
  return labels[status] ?? status.replaceAll('_', ' ');
}

export function taskUsageLabel(usage?: TaskUsage | null): string {
  if (!usage) return 'Usage: Unknown';
  const count = (value?: number | null) => value == null ? 'Unknown' : String(value);
  const cost = usage.costMicros == null ? 'Unknown' : `$${(usage.costMicros / 1_000_000).toFixed(4)}`;
  return `Usage: ${count(usage.inputTokens)} in · ${count(usage.outputTokens)} out · cost ${cost}`;
}

/** Keep the request ID and its original scope when a reply may have been lost. */
export function retainRequestForRetry<T extends PendingAssistantRequest>(pending: T): T { return pending; }

export function taskThreadLinks(task: Pick<AssistantTask, 'parentThreadId' | 'executionThreadId'>): { id: string; label: string }[] {
  const links = task.parentThreadId ? [{ id: task.parentThreadId, label: 'Parent thread' }] : [];
  if (task.executionThreadId && task.executionThreadId !== task.parentThreadId) links.push({ id: task.executionThreadId, label: 'Linked worker chat' });
  return links;
}

/** Reject a snapshot from a different project/host/folder, but hide tasks left by an older monitor assignment. */
export function assistantTasksForOwner(snapshot: AssistantTaskSnapshot, owner: AssistantTaskOwner): AssistantTask[] {
  if (snapshot.workspaceId !== owner.workspaceId) throw new Error('ApexAgent received tasks for a different project.');
  for (const task of snapshot.tasks) {
    if (task.workspaceId !== owner.workspaceId || task.owner.workspaceId !== owner.workspaceId
      || task.owner.cwd !== owner.cwd || task.owner.hostId !== owner.hostId) {
      throw new Error('ApexAgent received a task for a different project folder or machine.');
    }
  }
  return snapshot.tasks.filter((task) => task.owner.conversationId === owner.conversationId);
}

export function isSnapshotForOwner(snapshot: AssistantTaskSnapshot, owner: AssistantTaskOwner): boolean {
  try { assistantTasksForOwner(snapshot, owner); return true; } catch { return false; }
}

export function archivedTaskIds(snapshot: AssistantTaskSnapshot): Set<string> {
  return new Set([
    ...snapshot.executions.filter((entry) => entry.tombstonedAtMs != null).map((entry) => entry.taskId),
    ...snapshot.tasks.filter((task) => typeof task.resultData?.archivedAtMs === 'number').map((task) => task.id),
  ]);
}

export function canReconcileTask(task: Pick<AssistantTask, 'status' | 'mode' | 'resultData'>): boolean {
  return task.mode === 'isolated' && (task.status === 'applying' || task.status === 'interrupted')
    && task.resultData?.integrationPlan != null && typeof task.resultData.applyJournal === 'string'
    && task.resultData.applyJournal.length > 0;
}

export function isTerminalTask(status: AssistantTaskStatus | string): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

export function shouldSuggestArchive(task: Pick<AssistantTask, 'mode' | 'status' | 'updatedAtMs' | 'resultData'>, nowMs = Date.now()): boolean {
  return task.mode === 'isolated' && isTerminalTask(task.status) && typeof task.resultData?.archivedAtMs !== 'number'
    && nowMs - task.updatedAtMs >= 14 * 24 * 60 * 60 * 1000;
}
