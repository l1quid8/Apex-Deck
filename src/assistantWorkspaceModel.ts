import type { Backend } from './backend.ts';
import { projectIdentityKey, type AssistantRef, type ProjectRef } from './assistantIdentity.ts';
import type { ParticipantConfig, ModelChoice, Workspace } from './types.ts';
export type AssistantSection = 'conversation' | 'projects' | 'activity' | 'memory' | 'settings';
export type MainView = { kind: 'workspace' } | { kind: 'assistant'; assistant: AssistantRef; section: AssistantSection; previousSections?: AssistantSection[] };
export type AssistantNavigation = {kind:'open';assistant:AssistantRef} | {kind:'section';section:AssistantSection} | {kind:'back'} | {kind:'workspace'};
/** Navigation owns only the main canvas. Global Dashboard/Tasks panel state is retained verbatim. */
export function assistantNavigation<T extends {mainView:MainView}>(state:T,event:AssistantNavigation):T {
 let mainView:MainView=state.mainView;
 if(event.kind==='workspace')mainView={kind:'workspace'};
 else if(event.kind==='open')mainView={kind:'assistant',assistant:{...event.assistant},section:'conversation'};
 else if(mainView.kind==='assistant') {
  const {previousSections,...view}=mainView;
  if(event.kind==='back') {
   const history=[...(previousSections??[])];const section=history.pop()??'conversation';
   mainView={...view,section,...(history.length?{previousSections:history}:{})};
  } else if(event.section!==mainView.section) {
   const history=event.section==='settings'||event.section==='memory'?[...(previousSections??[]),mainView.section]:[];
   mainView={...view,section:event.section,...(history.length?{previousSections:history}:{})};
  }
 }
 return {...state,mainView};
}
export function textModels<T extends ModelChoice & {kind?:string|null}>(models:T[]):T[] { return models.filter(m=>!m.kind || m.kind==='text'); }
export function reconcileEffort(effort:string|null, model:ModelChoice|undefined):string|null {
 const levels=model?.efforts;return levels?.length ? (effort && levels.includes(effort) ? effort : levels[0]) : null;
}
export function runtimeProfile(base:ParticipantConfig,name:string,model:string,access:ParticipantConfig['access'],effort:string|null):ParticipantConfig {
 const backend=base.backend.kind==='agent'||base.backend.kind==='open_ai_compatible'?{...base.backend,model}:base.backend;
 return {...base,display_name:name.trim(),backend,access,effort};
}
export function validateAssistantDraft(d:{name:string;color:string;profile:Pick<ParticipantConfig,'backend'|'access'>|undefined;model:ModelChoice|undefined;effort:string|null;providerReady:boolean}):string|null {
 if(!d.name.trim() || [...d.name.trim()].length>64 || /[\x00-\x1f\x7f]/.test(d.name)) return 'Enter an assistant name of 1–64 characters.';
 if(!/^#[\da-fA-F]{6}$/.test(d.color)) return 'Choose an avatar color with six hexadecimal digits.';
 if(!d.providerReady || !d.profile) return 'Choose a compatible configured provider with available credentials.';
 if(!d.model) return 'Choose an offered text model from this provider.';
 if(d.effort && !d.model.efforts?.includes(d.effort)) return 'Choose a supported reasoning level.';
 return null;
}
export function rosterMessage(rows:readonly unknown[],hosts:readonly {state:string;problem?:string}[]):string|null {
 if(rows.length)return null;
 const problem=hosts.find(h=>h.problem)?.problem;if(problem)return problem;
 if(hosts.some(h=>h.state==='offline'))return 'Assistant machines are offline. Reconnect to load Your team.';
 return 'No assistants yet. Add a teammate to get started.';
}

/** Resolve transport aliases only through a current authenticated welcome identity.
 * Never fall back to workspace ID or normalize an owning host's canonical path. */
export function resolveAssistantProject(project:ProjectRef,workspaces:readonly Workspace[],authenticatedHost:(routeHostId:string)=>string|undefined,canonicalProjectForWorkspace?:(workspace:Workspace)=>ProjectRef|undefined):Workspace|null {
 return workspaces.find(workspace=>{
  const hostId=authenticatedHost(workspace.hostId??'local');
  if(workspace.hidden||workspace.id!==project.workspaceId||!hostId||hostId!==project.hostId)return false;
  const canonical=canonicalProjectForWorkspace?.(workspace);
  return canonical ? canonical.hostId===hostId&&canonical.workspaceId===workspace.id&&canonical.cwd===project.cwd : workspace.path===project.cwd;
 })??null;
}
export function assistantSettingsSaved(view:MainView,owner:AssistantRef):MainView {
 return view.kind==='assistant'&&view.section==='settings'&&view.assistant.hostId===owner.hostId&&view.assistant.assistantId===owner.assistantId ? {kind:'assistant',assistant:view.assistant,section:'conversation'} : view;
}

/** A read-only owning-host listing may prove an alias. It never rewrites the binding.
 * Caller also revalidates the captured route and raw workspace against live state. */
export async function resolveAssistantProjectFolder(project:ProjectRef,workspace:Workspace,backend:Pick<Backend,'host'|'listFolder'>,current:()=>boolean):Promise<ProjectRef|null> {
 const bound=()=>{const status=backend.host?.connection.get().status;return current()&&status?.kind==='connected'&&status.hostId===project.hostId;};
 try {
  if(workspace.hidden||workspace.id!==project.workspaceId||!bound())return null;
  const folder=await backend.listFolder(workspace.path);
  return bound()&&folder.path===project.cwd?{...project}:null;
 } catch {return null;}
}

/** Discover an unassigned workspace through its authenticated owning host.
 * A coordinator/task snapshot is not needed merely to offer an assignment. */
export async function discoverAssistantProjectFolder(workspace:Workspace,hostId:string,backend:Pick<Backend,'host'|'listFolder'>,current:()=>boolean):Promise<ProjectRef|null> {
 const bound=()=>{const status=backend.host?.connection.get().status;return current()&&status?.kind==='connected'&&status.hostId===hostId;};
 if(workspace.hidden||!bound())return null;
 const folder=await backend.listFolder(workspace.path);
 if(!bound())return null;
 const project={hostId,workspaceId:workspace.id,cwd:folder.path};
 projectIdentityKey(project);
 return project;
}
