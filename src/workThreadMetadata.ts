import type { Pane, Workspace } from './types';
import type { ChatCatalog } from './chatCatalog';
import { workspaceHost } from './hostSession.ts';

/** Reconcile only host-confirmed Work metadata with its owning desktop pane. */
export function reconcileWorkPanes(panes: Pane[], workspaces: readonly Workspace[], catalog: ChatCatalog, previous: ChatCatalog, online: (host: string) => boolean): Pane[] {
  let changed=false;
  const route=(pane:Pane)=>(pane as Pane & {hostId?:string}).hostId??workspaceHost(workspaces.find(w=>w.id===pane.workspaceId)??{id:'',name:'',path:''});
  const next=panes.flatMap(pane=>{
    if(pane.kind!=='chat')return [pane];
    const host=route(pane),list=catalog.hosts[host],before=previous.hosts[host];
    if(!online(host)||!list||list.listedAt===undefined)return [pane];
    const row=list.rooms.find(r=>r.id===pane.id&&r.kind==='work');
    // Deletion is a transition between two complete replies, never absence
    // from an unknown, offline, or incrementally updated list.
    if(!row){if(before?.listedAt!==undefined&&list.listedAt>before.listedAt&&before.rooms.some(r=>r.id===pane.id&&r.kind==='work')){changed=true;return [];}return [pane];}
    if(row.metadataRevision===undefined||row.metadataRevision<(pane.hostMetadataRevision??0))return [pane];
    const title=row.titleExplicit&&!pane.hostTitlePending?row.title:pane.title;
    const archived=pane.hostArchivePending?pane.archived:row.archived?true:row.metadataRevision===0||row.archiveExplicit===false?pane.archived:undefined;
    const closed=archived||row.trashedAt?true:pane.closed;
    if(title===pane.title&&archived===pane.archived&&closed===pane.closed&&pane.hostMetadataRevision===row.metadataRevision)return [pane];
    changed=true;return [{...pane,title,archived,closed,hostMetadataRevision:row.metadataRevision}];
  });
  for(const [host,list]of Object.entries(catalog.hosts)){
    if(!online(host)||list.listedAt===undefined)continue;
    for(const row of list.rooms){
      if(row.kind!=='work'||!row.cwd||row.trashedAt||row.metadataRevision===undefined||next.some(p=>p.id===row.id))continue;
      const workspace=workspaces.find(w=>workspaceHost(w)===host&&w.path===row.cwd);
      if(!workspace)continue;
      next.push({id:row.id,workspaceId:workspace.id,kind:'chat',title:row.title,closed:true,archived:row.archived||undefined,hostMetadataRevision:row.metadataRevision});changed=true;
    }
  }
  return changed?next:panes;
}
