import type { Backend } from './backend';
import type { ProjectEntry } from './chatCatalog';
import type { Workspace } from './types';

/** An explicit project action goes to the folder's host before changing presentation. */
export async function changeProject(backend: Backend, workspace: Workspace, action: 'add' | 'rename' | 'remove', name?: string): Promise<Workspace> {
  if (!workspace.path || backend.demo) return {...workspace,...(name === undefined ? {} : {name:name.trim()}),hidden:action === 'remove'};
  if (backend.supports?.('project_lifecycle_v1') === false) throw new Error('Update Deck on the project machine to change projects from both interfaces.');
  const row = await backend.call<ProjectEntry>(`project_${action}`,{path:workspace.path,...(name === undefined ? {} : {name})});
  if (!row || typeof row.path !== 'string' || !row.path || typeof row.name !== 'string' || !row.name.trim() || typeof row.removed !== 'boolean' || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('The project machine did not confirm this change. Refresh before retrying.');
  return {...workspace,path:row.path,name:row.name,hidden:row.removed,hostProjectRevision:row.revision};
}
