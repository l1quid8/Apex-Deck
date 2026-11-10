import { assistantIdentityKey, projectIdentityKey, type AssistantRef, type ProjectRef } from './assistantIdentity.ts';
import { assistantTasksForOwner, taskDisplayStatus, canReconcileTask, type AssistantTask, type AssistantTaskOwner, type AssistantTaskSnapshot } from './assistantTaskModel.ts';
import type { Backend } from './backend.ts';
import { LOCAL_HOST_NAME } from './hostFacts.ts';
import type { PersonalTask, PersonalTodo, Schedule, PersonalAssistantRecord } from './personalAssistant.ts';

export interface PersonalTaskSource {
  assistant: AssistantRef;
  name: string;
  hostName?: string;
  tasks: readonly PersonalTask[];
  todos?: readonly PersonalTodo[];
  schedules?: readonly Schedule[];
  offline: boolean;
  observedAt: number;
  routeHostId?: string;
  revision?: number;
}
export interface ProjectTaskSource {
  project: ProjectRef;
  owner: AssistantTaskOwner;
  name: string;
  hostName?: string;
  snapshot: AssistantTaskSnapshot | null;
  offline: boolean;
  observedAt: number;
  problem?: string;
  authenticatedHostId?: string;
}
export interface WorkspaceTaskRow {
  key: string;
  source: 'personal' | 'project' | 'todo' | 'schedule';
  assistant: AssistantRef | null;
  project: ProjectRef | null;
  taskId: string;
  title: string;
  searchText?: string;
  status: string;
  updatedAt: number;
  observedAt: number;
  offline: boolean;
  group: 'waiting' | 'working' | 'scheduled' | 'done';
  dismissed?: boolean;
  purgeBlocked?: boolean;
  assistantRevision?: number;
  todo?: PersonalTodo;
  schedule?: Schedule;
  machineName?: string;
  assistantName: string;
  projectName: string;
  owner: AssistantTaskOwner | null;
  revision: number | null;
  routeHostId: string;
  verifiedHostId: string | null;
}
export type WorkspaceTaskFilters = { assistant?: AssistantRef | 'unassigned' | null; project?: ProjectRef | null; query?: string; group?: WorkspaceTaskRow['group'] | 'all' };
export type WorkspaceTaskRoute = { source: 'project'; owner: AssistantTaskOwner; taskId: string; revision: number } | { source: 'personal' | 'todo' | 'schedule'; assistant: AssistantRef; taskId: string };

export function workspaceTaskKey(source: 'personal' | 'todo' | 'schedule', owner: AssistantRef, taskId: string): string;
export function workspaceTaskKey(source: 'project', owner: AssistantTaskOwner, taskId: string): string;
export function workspaceTaskKey(source: 'personal' | 'project' | 'todo' | 'schedule', owner: AssistantRef | AssistantTaskOwner, taskId: string): string {
  return source !== 'project'
    ? JSON.stringify([source, assistantIdentityKey(owner as AssistantRef), taskId])
    : JSON.stringify([source, projectIdentityKey(owner as AssistantTaskOwner), (owner as AssistantTaskOwner).conversationId, taskId]);
}
function group(status: string): WorkspaceTaskRow['group'] {
  if (['failed', 'proposed', 'needs_clarification', 'needs_you', 'needsYou', 'ready_for_review', 'interrupted', 'paused', 'waiting', 'blocked'].includes(status)) return 'waiting';
  if (['queued', 'running', 'applying', 'pausing'].includes(status)) return 'working';
  return 'done';
}
function lineage(task: AssistantTask, project: ProjectRef): AssistantRef | null {
  const value = (task as AssistantTask & { lineage?: { assistant: AssistantRef; project: ProjectRef } | null }).lineage;
  if (!value) return null;
  if (projectIdentityKey(value.project) !== projectIdentityKey(project)) throw new Error('Task lineage belongs to a different project.');
  assistantIdentityKey(value.assistant);
  return value.assistant;
}

/** No selected-pane input: every exact owner contributes independently. */
export function collectWorkspaceTasks(personalSnapshots: readonly PersonalTaskSource[], projectSnapshots: readonly ProjectTaskSource[]): WorkspaceTaskRow[] {
  const names = new Map(personalSnapshots.map(source => [assistantIdentityKey(source.assistant), source.name]));
  const rows = new Map<string, WorkspaceTaskRow>();
  for (const source of projectSnapshots) {
    if (!source.snapshot) continue;
    const canonical = (source.snapshot as AssistantTaskSnapshot & { project?: ProjectRef }).project;
    if (canonical ? projectIdentityKey(canonical) !== projectIdentityKey(source.project) || canonical.workspaceId !== source.owner.workspaceId : projectIdentityKey({ ...source.owner, hostId: source.authenticatedHostId ?? source.owner.hostId }) !== projectIdentityKey(source.project)) throw new Error('Task snapshot belongs to a different project owner.');
    for (const task of assistantTasksForOwner(source.snapshot, source.owner)) {

      const assistant = lineage(task, source.project);
      const status = taskDisplayStatus(task).toLowerCase().replaceAll(' ', '_');
      const key = workspaceTaskKey('project', { ...task.owner, ...source.project }, task.id);
      rows.set(key, { key, source: 'project', assistant, project: source.project, taskId: task.id, title: task.originalRequest || task.brief, searchText: [task.result, ...task.evidence ?? []].filter(Boolean).join(' '), machineName: source.hostName ?? (source.owner.hostId === 'local' ? LOCAL_HOST_NAME : 'Remote machine'),
        status, updatedAt: task.updatedAtMs, observedAt: source.observedAt, offline: source.offline, group: task.resultData?.dismissedAtMs != null || task.resultData?.deletedAtMs != null || task.resultData?.archivedAtMs != null ? 'done' : group(status),
        assistantName: assistant ? names.get(assistantIdentityKey(assistant)) ?? assistant.assistantId : 'Unassigned', projectName: source.name,
        dismissed: task.resultData?.dismissedAtMs != null || task.resultData?.deletedAtMs != null || task.resultData?.archivedAtMs != null, purgeBlocked: canReconcileTask(task) || task.attempts?.some(attempt => attempt.finishedAtMs == null), owner: task.owner, revision: task.revision, routeHostId: source.owner.hostId, verifiedHostId: canonical?.hostId ?? source.authenticatedHostId ?? null });
    }
  }
  for (const source of personalSnapshots) {
    for (const schedule of source.schedules ?? []) {
      const key = workspaceTaskKey('schedule', source.assistant, schedule.id);
      rows.set(key, { key, source: 'schedule', assistant: source.assistant, project: null, taskId: schedule.id, title: schedule.goal, status: schedule.status, updatedAt: schedule.createdAt, observedAt: source.observedAt, offline: source.offline,
        group: schedule.status === 'cancelled' ? 'done' : schedule.status === 'proposed' ? 'waiting' : 'scheduled', schedule, purgeBlocked: schedule.status !== 'cancelled' || source.tasks.some(task => task.scheduleId === schedule.id && (!['done', 'failed', 'cancelled'].includes(task.status) || task.receipts?.some(receipt => receipt.finishedAt == null))), assistantRevision: source.revision, assistantName: source.name, projectName: 'Personal', machineName: source.hostName ?? 'Assistant machine', owner: null, revision: null, routeHostId: source.routeHostId ?? source.assistant.hostId, verifiedHostId: source.assistant.hostId });
    }
    for (const todo of source.todos ?? []) {
      const key = workspaceTaskKey('todo', source.assistant, todo.id);
      rows.set(key, { key, source: 'todo', assistant: source.assistant, project: null, taskId: todo.id, title: todo.text, machineName: source.hostName ?? (source.routeHostId === 'local' ? LOCAL_HOST_NAME : 'Assistant machine'), status: todo.status, updatedAt: todo.updatedAt, observedAt: source.observedAt, offline: source.offline,
        group: todo.status === 'done' ? 'done' : (todo.dueAt ?? todo.remindAt ?? 0) > Date.now() ? 'scheduled' : 'waiting', todo, assistantRevision: source.revision, assistantName: source.name, projectName: 'Personal', owner: null, revision: null, routeHostId: source.routeHostId ?? source.assistant.hostId, verifiedHostId: source.assistant.hostId });
    }
    for (const task of source.tasks) {
      const key = workspaceTaskKey('personal', source.assistant, task.id);
      rows.set(key, { key, source: 'personal', assistant: source.assistant, project: null, taskId: task.id, title: task.goal, searchText: [task.lastUpdate, ...task.receipts?.map(receipt => receipt.outputExcerpt) ?? []].filter(Boolean).join(' '), machineName: source.hostName ?? (source.routeHostId === 'local' ? LOCAL_HOST_NAME : 'Assistant machine'),
        status: task.status, updatedAt: task.updatedAt, observedAt: source.observedAt, offline: source.offline,
        dismissed: task.deletedAt != null, assistantRevision: source.revision, purgeBlocked: task.receipts?.some(receipt => receipt.finishedAt == null),
        group: task.deletedAt != null ? 'done' : task.status === 'failed' ? 'waiting' : task.status === 'waiting' && task.wait?.kind === 'timer' ? 'scheduled' : task.status === 'needsYou' && task.decision?.status === 'open' ? 'waiting' : ['queued', 'running', 'waiting', 'blocked', 'needsYou'].includes(task.status) ? 'working' : 'done',
        assistantName: source.name, projectName: 'Personal', owner: null, revision: null, routeHostId: source.routeHostId ?? source.assistant.hostId, verifiedHostId: source.assistant.hostId });
    }
  }
  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
}
export function filterWorkspaceTasks(rows: readonly WorkspaceTaskRow[], filters: WorkspaceTaskFilters): WorkspaceTaskRow[] {
  const query = filters.query?.trim().toLocaleLowerCase() ?? '';
  return rows.filter(row => (!filters.group || filters.group === 'all' || row.group === filters.group)
    && (!filters.assistant || (filters.assistant === 'unassigned' ? row.assistant === null : row.assistant !== null && assistantIdentityKey(row.assistant) === assistantIdentityKey(filters.assistant)))
    && (!filters.project || row.project !== null && projectIdentityKey(row.project) === projectIdentityKey(filters.project))
    && (!query || [row.title, row.assistantName, row.projectName, row.status, row.searchText ?? ''].some(value => value.toLocaleLowerCase().includes(query))));
}
export function workspaceTaskRoute(row: WorkspaceTaskRow): WorkspaceTaskRoute {
  if (row.source === 'project' && row.owner && row.revision !== null) return { source: 'project', owner: row.owner, taskId: row.taskId, revision: row.revision };
  if ((row.source === 'personal' || row.source === 'todo' || row.source === 'schedule') && row.assistant) return { source: row.source, assistant: row.assistant, taskId: row.taskId };
  throw new Error('This task has no verified owner.');
}
export function personalTaskForRow(row: WorkspaceTaskRow, record: Pick<PersonalAssistantRecord, 'id' | 'hostId' | 'tasks'> | null): PersonalTask | null {
  if (row.source !== 'personal' || !row.assistant || !record || assistantIdentityKey(row.assistant) !== assistantIdentityKey({ hostId: record.hostId, assistantId: record.id })) return null;
  return record.tasks.find(task => task.id === row.taskId) ?? null;
}
export function workspaceTaskHostMatches(row: Pick<WorkspaceTaskRow, 'verifiedHostId'>, status: { kind: string; hostId?: string } | undefined): boolean {
  return !!row.verifiedHostId && status?.kind === 'connected' && status.hostId === row.verifiedHostId;
}
/** A retained detail callback must not follow a transport alias onto a new host. */
export function guardWorkspaceTaskBackend<T extends object & { host?: { connection: { get(): { status: { kind: string; hostId?: string } } } } }>(row: Pick<WorkspaceTaskRow, 'verifiedHostId'>, backend: T): T {
  const methods = new Map<PropertyKey, unknown>();
  const need = () => { if (!workspaceTaskHostMatches(row, backend.host?.connection.get().status)) throw new Error('Reconnect the owning machine before using this task.'); };
  return new Proxy(backend, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (!['call', 'roomCreate', 'roomState', 'roomDecide', 'roomAnswer'].includes(String(key)) || typeof value !== 'function') return value;
    if (!methods.has(key)) methods.set(key, async (...args: unknown[]) => { need(); const result = await Reflect.apply(value, target, args); need(); return result; });
    return methods.get(key);
  } });
}
/** A failed poll marks retained data stale; it never turns an unavailable host into an empty ledger. */
export function reconcileWorkspaceTaskSources(previous: readonly ProjectTaskSource[], incoming: ProjectTaskSource): readonly ProjectTaskSource[] {
  const key = JSON.stringify([projectIdentityKey(incoming.project), incoming.owner.conversationId]);
  const index = previous.findIndex(source => JSON.stringify([projectIdentityKey(source.project), source.owner.conversationId]) === key);
  const old = previous[index];
  if (old && (incoming.observedAt < old.observedAt || incoming.snapshot && old.snapshot && incoming.snapshot.revision < old.snapshot.revision)) return previous;
  if (incoming.snapshot) assistantTasksForOwner(incoming.snapshot, incoming.owner);
  const next = !incoming.snapshot && old ? { ...incoming, snapshot: old.snapshot, observedAt: old.observedAt } : incoming;
  return index < 0 ? [...previous, next] : previous.map((source, i) => i === index ? next : source);
}

/** Only settled records are eligible; the host repeats these checks atomically. */
export function canPurgeWorkspaceTask(row: WorkspaceTaskRow): boolean {
  return !row.offline && !row.purgeBlocked && (row.source === 'todo' || ['done', 'failed', 'cancelled', 'interrupted'].includes(row.status));
}
/** Confirmed rows are immutable deletion scope. All reads complete before any mutation. */
export async function purgeWorkspaceTasks(rows: readonly WorkspaceTaskRow[], backendForRow: (row: WorkspaceTaskRow) => Backend | null): Promise<void> {
  const unique = [...new Map(rows.map(row => [row.key, row])).values()];
  const operations: { backend: Backend; command: string; args: Record<string, unknown>; keys: string[] }[] = [];
  const personalGroups = new Map<string, { backend: Backend; rows: WorkspaceTaskRow[] }>();
  for (const row of unique) {
    if (!canPurgeWorkspaceTask(row)) throw new Error('Reconnect offline tasks and stop active tasks or recover pending integration before deleting.');
    const backend = backendForRow(row);
    if (!backend || !workspaceTaskHostMatches(row, backend.host?.connection.get().status)) throw new Error('Reconnect the owning machine before deleting.');
    if (backend.supports?.('assistant_task_purge_v1') !== true) throw new Error('Update the owning machine to enable permanent task deletion.');
    const guarded = guardWorkspaceTaskBackend(row, backend);
    if ((row.source === 'personal' || row.source === 'todo' || row.source === 'schedule') && row.assistant) {
      const key = assistantIdentityKey(row.assistant);
      const group = personalGroups.get(key) ?? { backend: guarded, rows: [] };
      group.rows.push(row); personalGroups.set(key, group);
    } else if (row.source === 'project' && row.owner) {
      const snapshot = await guarded.call<AssistantTaskSnapshot>('assistant_tasks_list', { owner: row.owner, includeDiffs: false });
      const current = collectWorkspaceTasks([], [{ project: row.project!, owner: row.owner, snapshot, name: row.projectName, offline: false, observedAt: Date.now(), authenticatedHostId: row.verifiedHostId ?? undefined }]).find(task => task.key === row.key);
      if (!current || current.revision !== row.revision || current.updatedAt !== row.updatedAt || !canPurgeWorkspaceTask(current)) throw new Error('The task changed. Review it and confirm deletion again.');
      operations.push({ keys: [row.key], backend: guarded, command: 'project_task_lifecycle', args: { taskId: row.taskId, revision: row.revision, owner: row.owner, action: 'purge' } });
    } else throw new Error('This task has no verified owner.');
  }
  for (const { backend, rows: group } of personalGroups.values()) {
    const assistant = group[0].assistant!;
    const record = await backend.call<PersonalAssistantRecord>('personal_get', { assistantId: assistant.assistantId });
    if (record.id !== assistant.assistantId || record.hostId !== assistant.hostId) throw new Error('The assistant owner changed.');
    for (const row of group) {
      if (row.source === 'schedule') {
        const schedule = record.schedules?.find(schedule => schedule.id === row.taskId);
        if (record.tasks.some(task => task.scheduleId === row.taskId && (!['done', 'failed', 'cancelled'].includes(task.status) || task.receipts?.some(receipt => receipt.finishedAt == null)))) throw new Error('Wait for the scheduled task and final receipt before deleting.');
        if (!schedule || schedule.status !== 'cancelled' || schedule.createdAt !== row.updatedAt || row.assistantRevision != null && row.assistantRevision !== record.revision) throw new Error('The schedule changed. Review it and confirm deletion again.');
        continue;
      }
      if (row.source === 'todo') {
        const todo = record.taskManagerTodos?.find(todo => todo.id === row.taskId);
        if (!todo || todo.updatedAt !== row.updatedAt || todo.status !== row.status || row.assistantRevision != null && row.assistantRevision !== record.revision) throw new Error('The to-do changed. Review it and confirm deletion again.');
        continue;
      }
      const task = personalTaskForRow(row, record);
      if (!task || task.updatedAt !== row.updatedAt || task.status !== row.status || row.assistantRevision != null && row.assistantRevision !== record.revision || task.receipts?.some(receipt => receipt.finishedAt == null)) throw new Error('The task changed. Review it and confirm deletion again.');
    }
    for (const row of group.filter(row => row.source === 'todo')) operations.push({ keys: [row.key], backend, command: 'personal_todo', args: { assistantId: assistant.assistantId, expectedRevision: record.revision, action: 'purge', todoId: row.taskId } });
    if (group.some(row => row.source === 'personal' || row.source === 'schedule')) operations.push({ keys: group.filter(row => row.source === 'personal' || row.source === 'schedule').map(row => row.key), backend, command: 'personal_task_lifecycle', args: { assistantId: assistant.assistantId, expectedRevision: record.revision, action: 'purge', tasks: group.filter(row => row.source === 'personal' || row.source === 'schedule').map(row => ({ source: row.source, taskId: row.taskId })) } });
  }
  const revisions = new Map<string, number>();
  const purgedKeys: string[] = [];
  for (const [index, operation] of operations.entries()) {
    try {
      const key = operation.args.assistantId ? JSON.stringify([operation.backend.host?.connection.get().status, operation.args.assistantId]) : '';
      const revision = revisions.get(key);
      const args = revision == null ? operation.args : { ...operation.args, expectedRevision: revision };
      const result = await operation.backend.call<{ assistant?: PersonalAssistantRecord }>(operation.command, args);
      purgedKeys.push(...operation.keys);
      if (key && operations.slice(index + 1).some(next => next.args.assistantId === args.assistantId && next.backend.host === operation.backend.host)) {
        const status = operation.backend.host?.connection.get().status;
        if (!result?.assistant || result.assistant.id !== args.assistantId || status?.kind !== 'connected' || result.assistant.hostId !== status.hostId || result.assistant.revision !== Number(args.expectedRevision) + 1) throw new Error('The assistant changed during deletion. Confirm the remaining tasks again.');
        revisions.set(key, result.assistant.revision);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw Object.assign(new Error(purgedKeys.length ? `${purgedKeys.length} task${purgedKeys.length === 1 ? '' : 's'} removed. Review the remaining tasks before retrying. ${message}` : message), { purgedKeys });
    }
  }
}
