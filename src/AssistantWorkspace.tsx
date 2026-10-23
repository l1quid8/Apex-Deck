import { useMemo, useState, type ReactNode } from 'react';
import type { Backend } from './backend';
import type { PersonalLane } from './personalAssistant';
import { assistantAppearance, projectIdentityKey, type AssistantProjectBinding, type ProjectRef } from './assistantIdentity';
import type { AssistantTask } from './assistantTaskModel';
import type { AssistantSection } from './assistantWorkspaceModel';
import { Avatar } from './Avatar';
import { createAssistantAvatarApi } from './assistantAvatar';
import { PersonalPanels } from './PersonalPanels';
export { AssistantEditor } from './AssistantEditor';
export type { AssistantCreation } from './AssistantEditor';
import './assistant-workspace.css';

export function AssistantWorkspaceAvatar({lane,backend}:{lane:PersonalLane;backend?:Backend}) {
 const record=lane.assistant;const ref=lane.ref??{hostId:record?.hostId??lane.hostName,assistantId:record?.id??lane.name};
 const look=assistantAppearance(ref,record?.look);const api=useMemo(()=>backend?createAssistantAvatarApi(backend):undefined,[backend]);
 return <Avatar seed={look.seed} color={look.color} image={look.kind==='image'?look.image:undefined} assistant={ref} avatarApi={api} size="sm"/>;
}

export function AssistantWorkspace({lane,backend,section,onNavigate,onBack,conversation,editor,projects,projectView,memoryProject,delegatedTasks=[],onOpenProject,projectUnavailable,onSubviewBack,previousSection='conversation',onAddAssistant}:{lane:PersonalLane;backend?:Backend;section:AssistantSection;onNavigate:(section:AssistantSection)=>void;onBack:()=>void;conversation:ReactNode;editor:ReactNode;projects:AssistantProjectBinding[];projectView?:ReactNode;memoryProject?:ProjectRef;delegatedTasks?:AssistantTask[];onOpenProject?:(project:ProjectRef)=>void;projectUnavailable?:(project:ProjectRef)=>string|undefined;onSubviewBack?:()=>void;previousSection?:AssistantSection;onAddAssistant?:()=>void}) {
 const record=lane.assistant;
 const ref=lane.ref??{hostId:record?.hostId??lane.hostName,assistantId:record?.id??lane.name};
 const look=assistantAppearance(ref,record?.look);
 const avatarApi=useMemo(()=>backend?createAssistantAvatarApi(backend):undefined,[backend]);
 const [pending,setPending]=useState(false);const [error,setError]=useState('');
 const working=(record?.tasks.filter(task=>task.status==='running'||task.status==='queued').length??0)+delegatedTasks.filter(task=>(task.status==='running'||task.status==='applying')&&task.desiredState!=='paused').length;
 const needsYou=(record?.tasks.filter(task=>task.status==='needsYou').length??0)+delegatedTasks.filter(task=>['needs_you','needs_clarification','ready_for_review','proposed','failed','interrupted'].includes(task.status)).length;
 const status=lane.offline?'Offline':record?.paused?'Paused':working?`Working on ${working} ${working===1?'task':'tasks'}`:needsYou?`${needsYou} need review`:'Ready';
 const activity=(record?.tasks.length??0)+(record?.notices?.length??0)+delegatedTasks.length;
 const subview=section==='settings'||section==='memory';
 const pause=async()=>{if(!lane.pause||pending)return;setPending(true);setError('');try{await lane.pause(!record?.paused);}catch(cause){setError(String(cause instanceof Error?cause.message:cause));}finally{setPending(false);}};
 return <section className="assistant-workspace" aria-label={`${lane.name} workspace`}>
  <header className="assistant-workspace-head">
   <Avatar seed={look.seed} color={look.color} image={look.kind==='image'?look.image:undefined} assistant={ref} avatarApi={avatarApi} working={working>0&&!record?.paused} size="md"/>
   <div className="assistant-workspace-identity"><h1>{lane.name}</h1><div className="assistant-workspace-descriptor"><span className="assistant-live-status" data-state={lane.offline?'offline':record?.paused?'paused':needsYou?'review':'ready'}>{status}</span><span> · Assistant · Ongoing conversation</span></div></div>
   <div className="assistant-workspace-actions">
    {lane.pause&&<button type="button" className="icon" aria-label={`${record?.paused?'Resume':'Pause'} ${lane.name}`} title={`${record?.paused?'Resume':'Pause'} ${lane.name}`} disabled={pending||lane.offline} onClick={()=>void pause()}>{record?.paused?'▷':'Ⅱ'}</button>}
    <details className="assistant-workspace-menu"><summary aria-label="Assistant options">⋯</summary><div role="menu">
     <button type="button" role="menuitem" onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');onBack();}}>Workspaces</button>
     <button type="button" role="menuitem" onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');onNavigate('memory');}}>Memory</button>
     <button type="button" role="menuitem" onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');onNavigate('settings');}}>Settings</button>
     {onAddAssistant&&<button type="button" role="menuitem" onClick={onAddAssistant}>Add a team member</button>}
    </div></details>
   </div>
  </header>
  {!subview&&<nav className="assistant-workspace-tabs" role="tablist" aria-label="Conversation sections">{(['conversation','projects','activity'] as const).map(tab=><button type="button" role="tab" id={`assistant-tab-${tab}`} aria-selected={section===tab} aria-controls={`assistant-panel-${tab}`} key={tab} onClick={()=>onNavigate(tab)}>{tab==='conversation'?'Conversation':tab==='projects'?'Projects':<>Activity{activity>0&&<span className="assistant-tab-count">{activity}</span>}</>}</button>)}</nav>}
  {(lane.problem||error)&&<p className="assistant-workspace-problem" role="alert">{error||lane.problem}</p>}
  <div id="assistant-panel-conversation" role="tabpanel" aria-labelledby="assistant-tab-conversation" className="assistant-workspace-content" hidden={section!=='conversation'}>{conversation}</div>
  {section!=='conversation'&&<div id={`assistant-panel-${section}`} role={subview?undefined:'tabpanel'} aria-labelledby={subview?undefined:`assistant-tab-${section}`} className="assistant-workspace-subview">{subview&&<button className="assistant-settings-back" onClick={()=>onSubviewBack?onSubviewBack():onNavigate(previousSection)}>‹ Back to {previousSection}</button>}{section==='settings'?editor:section==='projects'?(projectView??<><h2>Your projects, moving together.</h2>{!projects.length&&<p className="muted">Give each project a clear goal. Assign projects to coordinate work and bring the results back here.</p>}<button type="button" onClick={()=>onNavigate('settings')}>Assign projects</button>{projects.map(binding=>{const problem=projectUnavailable?.(binding.project);return <div key={projectIdentityKey(binding.project)}><button disabled={!!problem} onClick={()=>onOpenProject?.(binding.project)}>{binding.project.cwd} · {binding.tools}</button>{problem&&<p role="status">{problem}</p>}</div>;})}</>):<PersonalPanels delegatedTasks={delegatedTasks} key={section+JSON.stringify(memoryProject)} initialProject={section==='memory'?memoryProject:undefined} lane={lane} initial={section==='memory'?'memory':'activity'} onClose={()=>onNavigate('conversation')} embedded/>}</div>}
 </section>;
}
