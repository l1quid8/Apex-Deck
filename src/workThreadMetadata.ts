import type { Pane, Workspace } from './types';
import type { ChatCatalog } from './chatCatalog';
import { workspaceHost } from './hostSession.ts';
import { addFolders } from './workspaces.ts';

function projectPath(list: ChatCatalog['hosts'][string], path: string): string {
  return list.projects?.find(p=>p.path===path||p.aliases?.includes(path))?.path ?? path;
}

/** Hide confirmed missing folders in presentation only; saved history and Remove state stay intact. */
export function workPresentation<T extends Pane>(workspaces: Workspace[], panes: T[], catalog: ChatCatalog, online: (host: string) => boolean): { workspaces: Workspace[]; panes: T[] } {
  const missing = new Set<string>();
  const rowOf = (pane: T) => {
    const workspace = workspaces.find(workspace => workspace.id === pane.workspaceId);
    if (!workspace) return undefined;
    const host = (pane as T & {hostId?: string}).hostId ?? workspaceHost(workspace), list = catalog.hosts[host];
    if (!online(host) || list?.listedAt === undefined) return undefined;
    return list.rooms.find(row => row.kind === 'work' && row.id === pane.id);
  };
  const missingPanes = new Set(panes.filter(pane => pane.kind === 'chat' && rowOf(pane)?.cwdAvailable === false));
  for (const workspace of workspaces) {
    const host = workspaceHost(workspace), list = catalog.hosts[host];
    if (!workspace.path || !online(host) || list?.listedAt === undefined) continue;
    const rows = list.rooms.filter(row => row.kind === 'work' && row.cwd === workspace.path);
    // A missing row is not a missing directory. Unknown/conflicting checks
    // preserve the project until its owning host can confirm the folder.
    const liveMount = panes.some(pane => pane.workspaceId === workspace.id && pane.kind === 'chat' && rowOf(pane)?.cwdAvailable === true);
    if (rows.length && rows.every(row => row.cwdAvailable === false) && !liveMount) missing.add(workspace.id);
  }
  return {
    workspaces: missing.size ? workspaces.filter(workspace => !missing.has(workspace.id)) : workspaces,
    panes: missing.size || missingPanes.size ? panes.filter(pane => !missing.has(pane.workspaceId) && !missingPanes.has(pane)) : panes,
  };
}

/** Discover host-owned projects without undoing an explicit Remove. */
export function discoverWorkspaces(workspaces: Workspace[], catalog: ChatCatalog, online: (host: string) => boolean, makeId: () => string, nameOf: (path: string) => string): Workspace[] {
  let next = workspaces;
  for (const [host, list] of Object.entries(catalog.hosts)) {
    if (!online(host) || list.listedAt === undefined) continue;
    for (const project of list.projects ?? []) {
      const existing = next.find(w => workspaceHost(w) === host && (w.path === project.path || project.aliases?.includes(w.path)));
      if (existing) {
        if (project.revision < (existing.hostProjectRevision ?? 0)) continue;
        if (existing.path !== project.path || existing.name !== project.name || !!existing.hidden !== project.removed || existing.hostProjectRevision !== project.revision) {
          next = next.map(w => w !== existing ? w : {...w,path:project.path,name:project.name,hidden:project.removed,hostProjectRevision:project.revision});
        }
      } else if (!project.removed) {
        next = addFolders(next,[project.path],makeId,()=>project.name,host).list.map(w => workspaceHost(w) === host && w.path === project.path ? {...w,hostProjectRevision:project.revision} : w);
      }
    }
    for (const row of list.rooms) {
      if (row.kind !== 'work' || !row.cwd || row.cwdAvailable === false || row.trashedAt || row.archived) continue;
      const path = projectPath(list,row.projectCwd ?? row.cwd);
      if (list.projects?.some(project => (project.path === path || project.aliases?.includes(path)) && project.removed)) continue;
      if (next.some(w => workspaceHost(w) === host && w.path === path)) continue;
      next = addFolders(next, [path], makeId, path => row.folderName ?? nameOf(path), host).list;
    }
  }
  return next;
}

/** Reconcile only host-confirmed Work metadata with its owning desktop pane. */
export function reconcileWorkPanes(panes: Pane[], workspaces: readonly Workspace[], catalog: ChatCatalog, previous: ChatCatalog, online: (host: string) => boolean): Pane[] {
  let changed=false;
  const route=(pane:Pane)=>(pane as Pane & {hostId?:string}).hostId??workspaceHost(workspaces.find(w=>w.id===pane.workspaceId)??{id:'',name:'',path:''});
  const next=panes.flatMap(pane=>{
    if(pane.kind!=='chat')return [pane];
    const host=route(pane),list=catalog.hosts[host],before=previous.hosts[host];
    if(!online(host)||!list||list.listedAt===undefined)return [pane];
    if(list.deletedThreads?.includes(pane.id)){changed=true;return [];}
    const row=list.rooms.find(r=>r.id===pane.id&&r.kind==='work');
    // Deletion is a transition between two complete replies, never absence
    // from an unknown, offline, or incrementally updated list.
    if(!row){if(before?.listedAt!==undefined&&list.listedAt>before.listedAt&&before.rooms.some(r=>r.id===pane.id&&r.kind==='work')){changed=true;return [];}return [pane];}
    if(row.metadataRevision===undefined||row.metadataRevision<(pane.hostMetadataRevision??0))return [pane];
    const title=row.titleExplicit&&!pane.hostTitlePending?row.title:pane.title;
    const archived=pane.hostArchivePending?pane.archived:row.archived?true:row.metadataRevision===0||row.archiveExplicit===false?pane.archived:undefined;
    const closed=archived||row.trashedAt?true:pane.closed;
    const project = row.projectCwd ? workspaces.find(w=>workspaceHost(w)===host&&w.path===projectPath(list,row.projectCwd!)) : undefined;
    const workspaceId=project?.id??pane.workspaceId;
    const mount=project ? row.cwd && row.cwd !== project.path ? row.cwd : undefined : pane.mount;
    if(title===pane.title&&archived===pane.archived&&closed===pane.closed&&workspaceId===pane.workspaceId&&mount===pane.mount&&pane.hostMetadataRevision===row.metadataRevision)return [pane];
    changed=true;return [{...pane,title,archived,closed,workspaceId,mount,hostMetadataRevision:row.metadataRevision}];
  });
  for(const [host,list]of Object.entries(catalog.hosts)){
    if(!online(host)||list.listedAt===undefined)continue;
    for(const row of list.rooms){
      if(row.kind!=='work'||!row.cwd||row.cwdAvailable===false||row.trashedAt||list.deletedThreads?.includes(row.id)||next.some(p=>p.id===row.id))continue;
      const workspace=workspaces.find(w=>workspaceHost(w)===host&&w.path===projectPath(list,row.projectCwd??row.cwd!));
      if(!workspace)continue;
      next.push({id:row.id,workspaceId:workspace.id,kind:'chat',title:row.title,closed:true,archived:row.archived||undefined,hostMetadataRevision:row.metadataRevision});changed=true;
    }
  }
  return changed?next:panes;
}
