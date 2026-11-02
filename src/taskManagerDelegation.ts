import { assistantIdentityKey, projectIdentityKey, type AssistantRef, type ProjectRef } from './assistantIdentity.ts';
import type { Backend } from './backend.ts';
import type { ParticipantConfig } from './types.ts';
import type { PersonalAssistantRecord } from './personalAssistant.ts';
import type { ProjectMonitor } from './apexAgentModel.ts';
import type { AssistantTaskSnapshot } from './assistantTaskModel.ts';
import { collectWorkspaceTasks, guardWorkspaceTaskBackend } from './workspaceTasks.ts';

export type TaskDelegationTarget = { assistant: AssistantRef; project: ProjectRef; name: string };
export type TaskDelegationDraft = { id: string; threadId?: string; threadKey?: string };
export type TaskWorkerThreadCreator = (project: ProjectRef, profile: ParticipantConfig, assistant: AssistantRef) => Promise<string>;
export function parseTaskQuickAdd(value: string, profiles: readonly ParticipantConfig[]): { kind: 'todo' | 'assistant'; text: string } | { kind: 'worker'; text: string; profile: ParticipantConfig } {
  const text = value.trim();
  if (!text) throw new Error('Enter a task.');
  if (!text.startsWith('@')) return { kind: 'todo', text };
  const match = /^@(?:"([^"\r\n]+)"|([^\s"@]+))\s+([\s\S]+)$/.exec(text);
  if (!match || !match[3].trim()) throw new Error('Use @worker followed by a task brief. Quote worker names that contain spaces.');
  const handle = (match[1] ?? match[2]).toLocaleLowerCase();
  if (handle === 'alfred') return { kind: 'assistant', text: match[3].trim() };
  const workers = profiles.filter(profile => !profile.media && [profile.id, profile.display_name].some(name => name.toLocaleLowerCase() === handle));
  if (workers.length !== 1) throw new Error(workers.length ? 'That worker name is ambiguous. Use its saved worker ID.' : 'Choose a configured worker after @.');
  return { kind: 'worker', text: match[3].trim(), profile: workers[0] };
}

/** Creates a human-reviewed proposal only; approval remains a separate task action. */
export async function proposeWorkerTask({ backend, assistant, project, projectName, assistantName, profile, brief, draft, createWorkerThread, routeHostId = assistant.hostId, mode = 'read_only' }: {
  backend: Backend; assistant: AssistantRef; project: ProjectRef; projectName: string; assistantName: string; profile: ParticipantConfig; brief: string; draft: TaskDelegationDraft; createWorkerThread?: TaskWorkerThreadCreator; routeHostId?: string; mode?: 'read_only' | 'isolated';
}) {
  assistantIdentityKey(assistant); projectIdentityKey(project);
  if (project.hostId !== assistant.hostId) throw new Error('Choose a project on this assistant’s machine.');
  if (!brief.trim() || brief.trim().length > 16000 || !draft.id) throw new Error('Enter a task brief of up to 16,000 characters.');
  if (!createWorkerThread) throw new Error('Reconnect this project to create a saved worker thread.');
  const guarded = guardWorkspaceTaskBackend({ verifiedHostId: assistant.hostId }, backend);
  const readAssistant = async () => {
    const record = await guarded.call<PersonalAssistantRecord>('personal_get', { assistantId: assistant.assistantId });
    if (record.id !== assistant.assistantId || record.hostId !== assistant.hostId) throw new Error('The assistant owner changed.');
    const binding = (record.projects ?? []).find(item => projectIdentityKey(item.project) === projectIdentityKey(project));
    if (!binding || binding.tools === 'off' || record.paused) throw new Error('Choose an enabled project assigned to this assistant and resume it before delegating.');
    if (mode === 'isolated' && record.profile?.access === 'read') throw new Error('This assistant permits read-only tasks.');
    return record;
  };
  let record = await readAssistant();
  let monitor = await guarded.call<ProjectMonitor | null>('monitor_get', { workspaceId: project.workspaceId });
  if (!monitor) {
    if (!record.profile) throw new Error('Configure this assistant before delegating.');
    monitor = await guarded.call<ProjectMonitor>('monitor_assign', { workspaceId: project.workspaceId, cwd: project.cwd, hostId: routeHostId, text: `Coordinate work for ${projectName}.`, files: [], threads: [], profile: record.profile, onlyIfAbsent: true });
  }
  if (!monitor || monitor.workspaceId !== project.workspaceId || monitor.hostId !== routeHostId || !monitor.conversationId) throw new Error('The project coordinator returned a different owner.');
  const owner = { workspaceId: monitor.workspaceId, cwd: monitor.cwd, hostId: monitor.hostId, conversationId: monitor.conversationId };
  const readSnapshot = async () => {
    const snapshot = await guarded.call<AssistantTaskSnapshot>('assistant_tasks_list', { owner, includeDiffs: true });
    if (!snapshot.project || projectIdentityKey(snapshot.project) !== projectIdentityKey(project)) throw new Error('The project coordinator returned a different folder.');
    return snapshot;
  };
  await readSnapshot();
  const threadKey = JSON.stringify([assistantIdentityKey(assistant), projectIdentityKey(project), profile]);
  if (draft.threadKey !== threadKey) { draft.threadId = undefined; draft.threadKey = threadKey; }
  if (!draft.threadId) draft.threadId = await createWorkerThread(project, profile, assistant);
  if (!draft.threadId) throw new Error('Create a saved worker thread before delegating.');
  record = await readAssistant();
  const receipt = await guarded.call<{ taskId: string }>('personal_project_propose_ui', { assistantId: record.id, project, sourceEventId: '', delegationId: draft.id, brief: brief.trim(), destination: { threadId: draft.threadId, workers: [profile.id], newThread: false }, mode, reviewCriteria: [], expectedRevision: record.revision });
  const snapshot = await readSnapshot();
  const rows = collectWorkspaceTasks([{ assistant, name: assistantName, tasks: [], offline: false, observedAt: Date.now() }], [{ project, owner, name: projectName, snapshot, offline: false, observedAt: Date.now(), authenticatedHostId: assistant.hostId }]);
  const row = rows.find(item => item.taskId === receipt.taskId && item.assistant && assistantIdentityKey(item.assistant) === assistantIdentityKey(assistant));
  if (!row || row.status !== 'proposed') throw new Error('The saved proposal could not be verified. Keep this draft and retry to reopen it.');
  return rows;
}
