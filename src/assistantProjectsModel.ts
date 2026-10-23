import { projectIdentityKey, type AssistantRef, type ProjectRef } from './assistantIdentity.ts';
import { assistantTasksForOwner, taskBelongsToAssistant, type AssistantTask, type AssistantTaskOwner, type AssistantTaskSnapshot } from './assistantTaskModel.ts';
import type { ParticipantConfig } from './types.ts';
import type { PersonalAssistantRecord } from './personalAssistant.ts';

export function projectTasks(snapshot: AssistantTaskSnapshot, owner: AssistantTaskOwner, project: ProjectRef, assistant: AssistantRef): AssistantTask[] {
  if (snapshot.project && projectIdentityKey(snapshot.project) !== projectIdentityKey(project)) throw new Error('The host returned a different project.');
  if (project.hostId !== assistant.hostId || project.workspaceId !== owner.workspaceId) throw new Error('This project is not on the assistant’s machine.');
  return assistantTasksForOwner(snapshot, owner).filter(task => taskBelongsToAssistant(task, assistant) && !!task.lineage && projectIdentityKey(task.lineage.project) === projectIdentityKey(project));
}
export function assignmentBlocked(record: PersonalAssistantRecord, project: ProjectRef): string | undefined {
  if (project.hostId !== record.hostId) return 'Assignments can be added only on this assistant’s machine.';
  const path = project.cwd.replace(/\/$/, '');
  if (!record.allowedFolders.some(folder => { const root = folder.replace(/\/$/, ''); return path === root || path.startsWith(`${root}/`); })) return 'This folder is outside the assistant’s existing folder grants. Manage machine access first.';
}
export function activeProjectTask(task: AssistantTask): boolean { return !['done','failed','cancelled'].includes(task.status); }

/** Saved worker IDs alone do not prove that the model, access or prompt still matches the roster. */
export function sameWorkerConfiguration(left: ParticipantConfig, right: ParticipantConfig): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
