import type { PersonalTask } from './personalAssistant.ts';
import { taskBelongsToAssistant, type AssistantTask } from './assistantTaskModel.ts';
import type { AssistantProjectBinding, AssistantRef, ProjectRef } from './assistantIdentity.ts';
import type { ParticipantConfig } from './types.ts';

/** The one place task states become an assistant status. The rail, the
 *  header, the Work tab and the project cards (isWorkingTask) all read it. */
export type AssistantStatusState = 'offline' | 'paused' | 'needs_you' | 'failed' | 'working' | 'ready';
export type AssistantStatus = { state: AssistantStatusState; needsYou: number; failed: number; working: number; label: string };
export type WorkItem = { key: string; source: 'personal' | 'delegated'; taskId: string; title: string; project?: ProjectRef; projectName?: string; worker?: string; status: string; atMs: number };
type Bucket = 'needsYou' | 'failed' | 'working' | 'finished' | 'cancelled';

const PERSONAL: Record<PersonalTask['status'], Bucket> = { needsYou: 'needsYou', blocked: 'needsYou', failed: 'failed', running: 'working', queued: 'working', waiting: 'working', done: 'finished', cancelled: 'cancelled' };
const DELEGATED: Record<string, Bucket> = { needs_you: 'needsYou', needs_clarification: 'needsYou', ready_for_review: 'needsYou', proposed: 'needsYou', failed: 'failed', interrupted: 'failed', running: 'working', applying: 'working', queued: 'working', done: 'finished', cancelled: 'cancelled' };

/** Running delegated work, the same rule the status counts. */
export function isWorkingTask(task: Pick<AssistantTask, 'status' | 'desiredState'>): boolean { return DELEGATED[task.status] === 'working' && task.desiredState !== 'paused'; }
const isPausedTask = (task: Pick<AssistantTask, 'status' | 'desiredState'>) => DELEGATED[task.status] === 'working' && task.desiredState === 'paused';
function personalBucket(task: PersonalTask): Bucket { return PERSONAL[task.status] ?? 'finished'; }
function delegatedBucket(task: AssistantTask): Bucket | null {
  const bucket = DELEGATED[task.status] ?? null;
  // A paused worker is not doing anything, whatever its last status said.
  return bucket === 'working' && task.desiredState === 'paused' ? null : bucket;
}

export function assistantStatus(input: { offline: boolean; paused: boolean; personalTasks: readonly PersonalTask[]; delegatedTasks: readonly AssistantTask[] }): AssistantStatus {
  const count = { needsYou: 0, failed: 0, working: 0, finished: 0, cancelled: 0 };
  for (const task of input.personalTasks) count[personalBucket(task)]++;
  for (const task of input.delegatedTasks) { const bucket = delegatedBucket(task); if (bucket) count[bucket]++; }
  const { needsYou, failed, working } = count;
  const state: AssistantStatusState = input.offline ? 'offline' : input.paused ? 'paused' : needsYou ? 'needs_you' : failed ? 'failed' : working ? 'working' : 'ready';
  const label = { offline: 'Offline', paused: 'Paused', needs_you: `Needs you · ${needsYou}`, failed: `Failed · ${failed}`, working: `Working · ${working}`, ready: 'Ready' }[state];
  return { state, needsYou, failed, working, label };
}

export function assistantWorkItems(personalTasks: readonly PersonalTask[], delegatedTasks: readonly AssistantTask[], projectName: (project: ProjectRef) => string): { needsYou: WorkItem[]; working: WorkItem[]; finished: WorkItem[]; cancelled: WorkItem[] } {
  const lists = { needsYou: [] as WorkItem[], working: [] as WorkItem[], finished: [] as WorkItem[], cancelled: [] as WorkItem[] };
  // A failed task waits on a retry, so it is listed with the ones that need you.
  const place = (bucket: Bucket, item: WorkItem) => lists[bucket === 'failed' ? 'needsYou' : bucket].push(item);
  for (const task of personalTasks) place(personalBucket(task), { key: `personal:${task.id}`, source: 'personal', taskId: task.id, title: task.goal, status: task.status, atMs: task.updatedAt });
  for (const task of delegatedTasks) {
    const bucket = delegatedBucket(task) ?? 'working';
    const project = task.lineage?.project;
    place(bucket, { key: `delegated:${task.id}`, source: 'delegated', taskId: task.id, title: task.originalRequest.split('\n')[0].trim(), ...(project ? { project, projectName: projectName(project) } : {}), ...(task.workers[0] ? { worker: task.workers[0] } : {}), status: isPausedTask(task) ? 'paused' : task.status, atMs: task.updatedAtMs });
  }
  for (const list of Object.values(lists)) list.sort((a, b) => b.atMs - a.atMs);
  return lists;
}

export function delegatedTasksForAssistant(owners: Record<string, { snapshot?: { tasks: AssistantTask[] } }>, ref: AssistantRef, projects: readonly AssistantProjectBinding[]): AssistantTask[] {
  return Object.values(owners).flatMap(entry => entry.snapshot?.tasks.filter(task => taskBelongsToAssistant(task, ref) && projects.some(binding => task.lineage?.project.hostId === binding.project.hostId && task.lineage.project.workspaceId === binding.project.workspaceId && task.lineage.project.cwd === binding.project.cwd)) ?? []);
}

export function accessLabel(access: ParticipantConfig['access']): string {
  return access === 'read' ? 'Read only' : access === 'ask' ? 'Asks first' : access === 'edits' ? 'Can edit files' : 'Full access';
}
