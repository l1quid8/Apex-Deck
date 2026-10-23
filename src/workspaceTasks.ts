import { assistantIdentityKey, projectIdentityKey, type AssistantRef, type ProjectRef } from './assistantIdentity.ts';
import { assistantTasksForOwner, taskDisplayStatus, type AssistantTask, type AssistantTaskOwner, type AssistantTaskSnapshot } from './assistantTaskModel.ts';
import type { PersonalTask, PersonalAssistantRecord } from './personalAssistant.ts';

export interface PersonalTaskSource {
  assistant: AssistantRef;
  name: string;
  tasks: readonly PersonalTask[];
  offline: boolean;
  observedAt: number;
  routeHostId?: string;
}
export interface ProjectTaskSource {
  project: ProjectRef;
  owner: AssistantTaskOwner;
  name: string;
  snapshot: AssistantTaskSnapshot | null;
  offline: boolean;
  observedAt: number;
  problem?: string;
}
export interface WorkspaceTaskRow {
  key: string;
  source: 'personal' | 'project';
  assistant: AssistantRef | null;
  project: ProjectRef | null;
  taskId: string;
  title: string;
  status: string;
  updatedAt: number;
  observedAt: number;
  offline: boolean;
  group: 'waiting' | 'working' | 'done';
  assistantName: string;
  projectName: string;
  owner: AssistantTaskOwner | null;
  revision: number | null;
  routeHostId: string;
}
export type WorkspaceTaskFilters = { assistant?: AssistantRef | 'unassigned' | null; project?: ProjectRef | null; query?: string; group?: WorkspaceTaskRow['group'] | 'all' };
export type WorkspaceTaskRoute = { source: 'project'; owner: AssistantTaskOwner; taskId: string; revision: number } | { source: 'personal'; assistant: AssistantRef; taskId: string };

export function workspaceTaskKey(source: 'personal', owner: AssistantRef, taskId: string): string;
export function workspaceTaskKey(source: 'project', owner: AssistantTaskOwner, taskId: string): string;
export function workspaceTaskKey(source: 'personal' | 'project', owner: AssistantRef | AssistantTaskOwner, taskId: string): string {
  return source === 'personal'
    ? JSON.stringify([source, assistantIdentityKey(owner as AssistantRef), taskId])
    : JSON.stringify([source, projectIdentityKey(owner as AssistantTaskOwner), (owner as AssistantTaskOwner).conversationId, taskId]);
}
function group(status: string): WorkspaceTaskRow['group'] {
  if (['proposed', 'needs_clarification', 'needs_you', 'needsYou', 'ready_for_review', 'interrupted', 'paused', 'waiting', 'blocked'].includes(status)) return 'waiting';
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
    if (canonical ? projectIdentityKey(canonical) !== projectIdentityKey(source.project) || canonical.workspaceId !== source.owner.workspaceId : projectIdentityKey(source.owner) !== projectIdentityKey(source.project)) throw new Error('Task snapshot belongs to a different project owner.');
    for (const task of assistantTasksForOwner(source.snapshot, source.owner)) {
      if (task.resultData?.archivedAtMs != null || task.resultData?.dismissedAtMs != null) continue;
      const assistant = lineage(task, source.project);
      const status = taskDisplayStatus(task).toLowerCase().replaceAll(' ', '_');
      const key = workspaceTaskKey('project', { ...task.owner, ...source.project }, task.id);
      rows.set(key, { key, source: 'project', assistant, project: source.project, taskId: task.id, title: task.originalRequest || task.brief,
        status, updatedAt: task.updatedAtMs, observedAt: source.observedAt, offline: source.offline, group: group(status),
        assistantName: assistant ? names.get(assistantIdentityKey(assistant)) ?? assistant.assistantId : 'Unassigned', projectName: source.name,
        owner: task.owner, revision: task.revision, routeHostId: source.owner.hostId });
    }
  }
  for (const source of personalSnapshots) {
    for (const task of source.tasks) {
      const key = workspaceTaskKey('personal', source.assistant, task.id);
      rows.set(key, { key, source: 'personal', assistant: source.assistant, project: null, taskId: task.id, title: task.goal,
        status: task.status, updatedAt: task.updatedAt, observedAt: source.observedAt, offline: source.offline,
        group: task.status === 'needsYou' && task.decision?.status === 'open' ? 'waiting' : ['queued', 'running', 'waiting', 'blocked', 'needsYou'].includes(task.status) ? 'working' : 'done',
        assistantName: source.name, projectName: 'Personal', owner: null, revision: null, routeHostId: source.routeHostId ?? source.assistant.hostId });
    }
  }
  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
}
export function filterWorkspaceTasks(rows: readonly WorkspaceTaskRow[], filters: WorkspaceTaskFilters): WorkspaceTaskRow[] {
  const query = filters.query?.trim().toLocaleLowerCase() ?? '';
  return rows.filter(row => (!filters.group || filters.group === 'all' || row.group === filters.group)
    && (!filters.assistant || (filters.assistant === 'unassigned' ? row.assistant === null : row.assistant !== null && assistantIdentityKey(row.assistant) === assistantIdentityKey(filters.assistant)))
    && (!filters.project || row.project !== null && projectIdentityKey(row.project) === projectIdentityKey(filters.project))
    && (!query || [row.title, row.assistantName, row.projectName, row.status].some(value => value.toLocaleLowerCase().includes(query))));
}
export function workspaceTaskRoute(row: WorkspaceTaskRow): WorkspaceTaskRoute {
  if (row.source === 'project' && row.owner && row.revision !== null) return { source: 'project', owner: row.owner, taskId: row.taskId, revision: row.revision };
  if (row.source === 'personal' && row.assistant) return { source: 'personal', assistant: row.assistant, taskId: row.taskId };
  throw new Error('This task has no verified owner.');
}
export function personalTaskForRow(row: WorkspaceTaskRow, record: Pick<PersonalAssistantRecord, 'id' | 'hostId' | 'tasks'> | null): PersonalTask | null {
  if (row.source !== 'personal' || !row.assistant || !record || assistantIdentityKey(row.assistant) !== assistantIdentityKey({ hostId: record.hostId, assistantId: record.id })) return null;
  return record.tasks.find(task => task.id === row.taskId) ?? null;
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
