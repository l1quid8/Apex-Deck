import type { PersonalTask } from './personalAssistant.ts';
import { taskBelongsToAssistant, type AssistantTask } from './assistantTaskModel.ts';
import type { AssistantProjectBinding, AssistantRef, ProjectRef } from './assistantIdentity.ts';
import type { ParticipantConfig } from './types.ts';

/** The one place task states become an assistant status. The rail, the
 *  header, the Work tab and the project cards (isWorkingTask) all read it. */
export type AssistantStatusState = 'offline' | 'paused' | 'needs_you' | 'failed' | 'working' | 'ready';
export type AssistantStatus = { state: AssistantStatusState; needsYou: number; failed: number; working: number; label: string };
export type WorkItem = { key: string; source: 'personal' | 'delegated'; taskId: string; revision?: number; title: string; project?: ProjectRef; projectName?: string; worker?: string; status: string; atMs: number };
type Bucket = 'needsYou' | 'failed' | 'working' | 'finished' | 'cancelled' | 'deleted';

const PERSONAL: Record<PersonalTask['status'], Bucket> = { needsYou: 'needsYou', blocked: 'needsYou', failed: 'failed', running: 'working', queued: 'working', waiting: 'working', done: 'finished', cancelled: 'cancelled' };
const DELEGATED: Record<string, Bucket> = { needs_you: 'needsYou', needs_clarification: 'needsYou', ready_for_review: 'needsYou', proposed: 'needsYou', failed: 'failed', interrupted: 'failed', running: 'working', applying: 'working', queued: 'working', done: 'finished', cancelled: 'cancelled' };

/** Running delegated work, the same rule the status counts. */
export function isWorkingTask(task: Pick<AssistantTask, 'status' | 'desiredState' | 'resultData'>): boolean { return task.resultData?.deletedAtMs == null && DELEGATED[task.status] === 'working' && task.desiredState !== 'paused'; }
const isPausedTask = (task: Pick<AssistantTask, 'status' | 'desiredState'>) => DELEGATED[task.status] === 'working' && task.desiredState === 'paused';
function personalBucket(task: PersonalTask): Bucket { return task.deletedAt != null ? 'deleted' : PERSONAL[task.status] ?? 'finished'; }
function delegatedBucket(task: AssistantTask): Bucket | null {
  if (task.resultData?.deletedAtMs != null) return 'deleted';
  const bucket = DELEGATED[task.status] ?? null;
  // A paused worker is not doing anything, whatever its last status said.
  return bucket === 'working' && task.desiredState === 'paused' ? null : bucket;
}

export function assistantStatus(input: { offline: boolean; paused: boolean; personalTasks: readonly PersonalTask[]; delegatedTasks: readonly AssistantTask[] }): AssistantStatus {
  const count = { needsYou: 0, failed: 0, working: 0, finished: 0, cancelled: 0, deleted: 0 };
  for (const task of input.personalTasks) count[personalBucket(task)]++;
  for (const task of input.delegatedTasks) { const bucket = delegatedBucket(task); if (bucket) count[bucket]++; }
  const { needsYou, failed, working } = count;
  const state: AssistantStatusState = input.offline ? 'offline' : input.paused ? 'paused' : needsYou ? 'needs_you' : failed ? 'failed' : working ? 'working' : 'ready';
  const label = { offline: 'Offline', paused: 'Paused', needs_you: `Needs you · ${needsYou}`, failed: `Failed · ${failed}`, working: `Working · ${working}`, ready: 'Ready' }[state];
  return { state, needsYou, failed, working, label };
}

export function assistantWorkItems(personalTasks: readonly PersonalTask[], delegatedTasks: readonly AssistantTask[], projectName: (project: ProjectRef) => string, workerName?: (id: string, project?: ProjectRef) => string | undefined): { needsYou: WorkItem[]; working: WorkItem[]; finished: WorkItem[]; cancelled: WorkItem[]; deleted: WorkItem[] } {
  const lists = { needsYou: [] as WorkItem[], working: [] as WorkItem[], finished: [] as WorkItem[], cancelled: [] as WorkItem[], deleted: [] as WorkItem[] };
  // A failed task waits on a retry, so it is listed with the ones that need you.
  const place = (bucket: Bucket, item: WorkItem) => lists[bucket === 'failed' ? 'needsYou' : bucket].push(item);
  for (const task of personalTasks) place(personalBucket(task), { key: `personal:${task.id}`, source: 'personal', taskId: task.id, title: task.goal, status: task.status, atMs: task.deletedAt ?? task.updatedAt });
  for (const task of delegatedTasks) {
    const bucket = delegatedBucket(task) ?? 'working';
    const project = task.lineage?.project;
    place(bucket, { key: `delegated:${task.id}`, source: 'delegated', taskId: task.id, revision: task.revision, title: task.originalRequest.split('\n')[0].trim(), ...(project ? { project, projectName: projectName(project) } : {}), ...(task.workers[0] ? { worker: workerName?.(task.workers[0], project) || 'Worker unavailable' } : {}), status: isPausedTask(task) ? 'paused' : task.status, atMs: task.resultData?.deletedAtMs ?? task.updatedAtMs });
  }
  for (const list of Object.values(lists)) list.sort((a, b) => b.atMs - a.atMs);
  return lists;
}

export function delegatedTasksForAssistant(owners: Record<string, { snapshot?: { tasks: AssistantTask[] } }>, ref: AssistantRef, projects: readonly AssistantProjectBinding[], deletedTasks: readonly AssistantTask[] = [], purgedIds: readonly string[] = []): AssistantTask[] {
  const tasks = Object.values(owners).flatMap(entry => entry.snapshot?.tasks.filter(task => taskBelongsToAssistant(task, ref) && (task.resultData?.deletedAtMs != null || projects.some(binding => task.lineage?.project.hostId === binding.project.hostId && task.lineage.project.workspaceId === binding.project.workspaceId && task.lineage.project.cwd === binding.project.cwd))) ?? []);
  const merged = new Map<string, AssistantTask>();
  for (const task of [...tasks, ...deletedTasks.filter(task => taskBelongsToAssistant(task, ref) && task.resultData?.deletedAtMs != null)]) {
    const previous = merged.get(task.id);
    if (!previous || (task.revision ?? 0) >= (previous.revision ?? 0)) merged.set(task.id, task);
  }
  return [...merged.values()].filter(task => !purgedIds.includes(task.id));
}

export function accessLabel(access: ParticipantConfig['access']): string {
  return access === 'read' ? 'Read only' : access === 'ask' ? 'Asks first' : access === 'edits' ? 'Can edit files' : 'Full access';
}
