import type { AssistantFloatContext, AssistantFloatThread } from './assistantFloat';
import { assistantIdentityKey, projectIdentityKey, type AssistantRef, type ProjectRef } from './assistantIdentity.ts';
import type { ChatCatalog } from './chatCatalog';
import type { PersonalAssistantRecord } from './personalAssistant';
import type { Pane, Workspace } from './types';

const LIMIT=64;
export type CompanionSelection={followedThreadIds:string[];activeThreadId:string|null};
export type CompanionProject={project:ProjectRef;name:string};
export type CompanionCatalog={
  owner:AssistantRef;routeHostId:string;hostId:string;valid:boolean;listed:boolean;
  threads:AssistantFloatThread[];projects:CompanionProject[];
  openThreadIds:string[];focusedThreadId:string|null;
  /** Exact host-qualified grant associated with each eligible room. */
  projectByThread:Record<string,ProjectRef>;
};
export type CompanionCatalogInput={
  owner:AssistantRef;
  assistant:Pick<PersonalAssistantRecord,'id'|'hostId'|'projects'>;
  routeHostId:string;
  authenticatedHostId:string|undefined;
  catalog:ChatCatalog;panes:readonly Pane[];workspaces:readonly Workspace[];
  focusedPane:string|null;excluded?:ReadonlySet<string>;
  /** Additional aliases are accepted only with a current authenticated welcome. */
  authenticatedHostForRoute?:(routeHostId:string)=>string|undefined;
  /** An optional host-returned canonical project, never client path normalization. */
  canonicalProjectForWorkspace?:(workspace:Workspace)=>ProjectRef|undefined;
  threadStatus?:(routeHostId:string,threadId:string)=>string|undefined;
};
const text=(value:unknown):string|undefined=>typeof value==='string'&&value.trim()?value:undefined;
const ids=(values:readonly string[],eligible:Set<string>,limit=LIMIT):string[]=>[...new Set(values.filter(value=>typeof value==='string'&&eligible.has(value)))].slice(0,limit);
const refCopy=(ref:ProjectRef):ProjectRef=>({...ref});

/** Render-time hints only. The host revalidates every selected room and project. */
export function deriveCompanionCatalog(input:CompanionCatalogInput):CompanionCatalog {
  const result:CompanionCatalog={owner:{...input.owner},routeHostId:input.routeHostId,hostId:input.owner.hostId,valid:false,listed:input.catalog.hosts[input.routeHostId]?.listedAt!==undefined,threads:[],projects:[],openThreadIds:[],focusedThreadId:null,projectByThread:Object.create(null) as Record<string,ProjectRef>};
  try {
    assistantIdentityKey(input.owner);
    if (!input.routeHostId || input.authenticatedHostId!==input.owner.hostId || input.assistant.hostId!==input.owner.hostId || input.assistant.id!==input.owner.assistantId) return result;
  } catch {return result;}
  result.valid=true;
  const projects=new Map<string,CompanionProject>();
  for(const binding of input.assistant.projects??[]) {
    if((binding.tools!=='ask'&&binding.tools!=='full')||binding.project.hostId!==input.owner.hostId)continue;
    try {const key=projectIdentityKey(binding.project);if(!projects.has(key))projects.set(key,{project:refCopy(binding.project),name:binding.project.workspaceId});}catch{/* malformed grants provide no scope */}
  }
  const authenticated=(route:string)=>route===input.routeHostId?input.authenticatedHostId:input.authenticatedHostForRoute?.(route);
  const workspaceProject=(workspace:Workspace):CompanionProject|undefined=>{
    if(workspace.hidden||authenticated(workspace.hostId??'local')!==input.owner.hostId)return;
    const canonical=input.canonicalProjectForWorkspace?.(workspace);
    if(canonical) {
      try{return projects.get(projectIdentityKey(canonical));}catch{return;}
    }
    const matches=[...projects.values()].filter(item=>item.project.cwd===workspace.path);
    return matches.find(item=>item.project.workspaceId===workspace.id)??(matches.length===1?matches[0]:undefined);
  };
  for(const workspace of input.workspaces){const project=workspaceProject(workspace);if(project&&text(workspace.name))project.name=workspace.name;}
  result.projects=[...projects.values()].map(item=>({project:refCopy(item.project),name:item.name}));
  const paneRows=input.panes.flatMap(pane=>{
    if(pane.kind!=='chat'||input.excluded?.has(pane.id))return [];
    const workspace=input.workspaces.find(item=>item.id===pane.workspaceId);
    if(!workspace)return [];
    const route=(pane as Pane&{hostId?:string}).hostId??workspace.hostId??'local';
    if(authenticated(route)!==input.owner.hostId)return [];
    const project=workspaceProject(workspace);return project?[{pane,project}]:[];
  });
  const host=input.catalog.hosts[input.routeHostId];
  const rows=host?.rooms??[];
  const authoritative=host?.listedAt!==undefined;
  const add=(id:string,title:string,project:CompanionProject,matches:typeof paneRows)=>{
    if(result.threads.some(item=>item.id===id)||input.excluded?.has(id)||matches.some(item=>item.pane.archived))return;
    const open=matches.some(item=>!item.pane.closed&&!item.pane.archived);
    const status=input.threadStatus?.(input.routeHostId,id);
    result.threads.push({id,title,hostId:input.owner.hostId,projectId:project.project.workspaceId,projectName:project.name,closed:!open,...(text(status)?{status}:{})});
    result.projectByThread[id]=refCopy(project.project);
    if(open)result.openThreadIds.push(id);
  };
  for(const row of rows) {
    if(row.hostId!==input.routeHostId||row.archived||row.trashedAt||row.movedTo||!row.cwd)continue;
    const candidates=[...projects.values()].filter(item=>item.project.cwd===row.cwd);
    const matchingPanes=paneRows.filter(item=>item.pane.id===row.id&&item.project.project.cwd===row.cwd);
    const project=matchingPanes[0]?.project??(candidates.length===1?candidates[0]:undefined);
    if(!project)continue;
    const paneTitle=text(matchingPanes[0]?.pane.title);
    const title=row.titleExplicit===true?text(row.title)??paneTitle:paneTitle??text(row.title);
    add(row.id,title??'Thread',project,matchingPanes);
  }
  // While the first list is loading, saved UI panes are useful hints. Once the
  // host has answered, an absent room is removed and must not be resurrected.
  if(!authoritative)for(const item of paneRows) {
    if(rows.some(row=>row.id===item.pane.id))continue;
    add(item.pane.id,text(item.pane.title)??'Thread',item.project,paneRows.filter(other=>other.pane.id===item.pane.id&&other.project.project.cwd===item.project.project.cwd));
  }
  if(input.focusedPane&&result.openThreadIds.includes(input.focusedPane))result.focusedThreadId=input.focusedPane;
  return result;
}

/** null means no saved choice yet; an explicit empty followed set stays empty. */
export function reconcileCompanionSelection(catalog:CompanionCatalog,selection:CompanionSelection|null|undefined):CompanionSelection {
  const eligible=new Set(catalog.threads.map(thread=>thread.id));
  return {followedThreadIds:ids(selection?.followedThreadIds??catalog.openThreadIds,eligible),activeThreadId:selection?.activeThreadId&&eligible.has(selection.activeThreadId)?selection.activeThreadId:null};
}
export function companionFloatContext(catalog:CompanionCatalog,selection:CompanionSelection|null|undefined):AssistantFloatContext {
  const reconciled=reconcileCompanionSelection(catalog,selection);
  return {threads:catalog.threads.map(thread=>({...thread})),followedThreadIds:[...reconciled.followedThreadIds],activeThreadId:reconciled.activeThreadId,canCreateThread:companionNewThreadTarget(catalog,reconciled).kind==='project'};
}
export type CompanionViewContext={hostId:string;focusedThreadId?:string;openThreadIds:string[];followedThreadIds:string[]};
/** New arrays are returned for every send; subsequent picker edits cannot mutate a request. */
export function companionViewContext(catalog:CompanionCatalog,selection:CompanionSelection|null|undefined):CompanionViewContext {
  const reconciled=reconcileCompanionSelection(catalog,selection);
  const focused=reconciled.activeThreadId??catalog.focusedThreadId;
  const open=focused&&catalog.openThreadIds.includes(focused)?[focused,...catalog.openThreadIds.filter(id=>id!==focused)]:catalog.openThreadIds;
  return {hostId:catalog.hostId,...(focused?{focusedThreadId:focused}:{}),openThreadIds:[...open].slice(0,LIMIT),followedThreadIds:[...reconciled.followedThreadIds]};
}
export type CompanionNewThreadTarget={kind:'project';hostId:string;routeHostId:string;project:ProjectRef}|{kind:'selection-required'|'unavailable';message:string};
export function companionNewThreadTarget(catalog:CompanionCatalog,selection:CompanionSelection|null|undefined):CompanionNewThreadTarget {
  if(!catalog.valid||!catalog.projects.length)return {kind:'unavailable',message:'Connect to the assistant’s owning machine and assign an enabled project before creating a thread.'};
  const reconciled=reconcileCompanionSelection(catalog,selection);
  const selected=reconciled.activeThreadId??catalog.focusedThreadId;
  const project=(selected?catalog.projectByThread[selected]:undefined)??(catalog.projects.length===1?catalog.projects[0].project:undefined);
  return project?{kind:'project',hostId:catalog.hostId,routeHostId:catalog.routeHostId,project:refCopy(project)}:{kind:'selection-required',message:'Choose a thread in the target project before creating a new thread.'};
}

export const companionSelectionKey=(owner:AssistantRef):string=>`apex-deck.assistant-companion-context.v1:${assistantIdentityKey(owner)}`;
export function loadCompanionSelection(storage:Pick<Storage,'getItem'>|null|undefined,owner:AssistantRef,catalog:CompanionCatalog):CompanionSelection {
  const fallback=()=>reconcileCompanionSelection(catalog,null);
  try {
    if(assistantIdentityKey(owner)!==assistantIdentityKey(catalog.owner))return fallback();
    const raw=storage?.getItem(companionSelectionKey(owner));if(!raw)return fallback();
    const value:unknown=JSON.parse(raw);
    if(!value||typeof value!=='object')return fallback();
    const saved=value as {version?:unknown;owner?:AssistantRef;followedThreadIds?:unknown;activeThreadId?:unknown};
    if(saved.version!==1||!saved.owner||assistantIdentityKey(saved.owner)!==assistantIdentityKey(owner)||!Array.isArray(saved.followedThreadIds)||!saved.followedThreadIds.every(id=>typeof id==='string')||(saved.activeThreadId!==null&&typeof saved.activeThreadId!=='string'))return fallback();
    return reconcileCompanionSelection(catalog,{followedThreadIds:saved.followedThreadIds,activeThreadId:saved.activeThreadId});
  }catch{return fallback();}
}
export function saveCompanionSelection(storage:Pick<Storage,'setItem'>|null|undefined,owner:AssistantRef,catalog:CompanionCatalog,selection:CompanionSelection):boolean {
  try {
    if(!storage||!catalog.valid||!catalog.listed||assistantIdentityKey(owner)!==assistantIdentityKey(catalog.owner))return false;
    const reconciled=reconcileCompanionSelection(catalog,selection);
    storage.setItem(companionSelectionKey(owner),JSON.stringify({version:1,owner:{...owner},...reconciled}));return true;
  }catch{return false;}
}
