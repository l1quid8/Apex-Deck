import { useMemo, useState, type ReactNode } from 'react';
import type { Backend } from './backend';
import type { PersonalLane } from './personalAssistant';
import { assistantAppearance, type ProjectRef } from './assistantIdentity';
import { accessLabel, assistantStatus } from './assistantStatus';
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

export function AssistantWorkspace({lane,backend,section,onNavigate,chat,work,editor,memoryProject,delegatedTasks=[],onSubviewBack,previousSection='chat'}:{lane:PersonalLane;backend?:Backend;section:AssistantSection;onNavigate:(section:AssistantSection)=>void;chat:ReactNode;work:ReactNode;editor:ReactNode;memoryProject?:ProjectRef;delegatedTasks?:AssistantTask[];onSubviewBack?:()=>void;previousSection?:AssistantSection}) {
 const record=lane.assistant;
 const ref=lane.ref??{hostId:record?.hostId??lane.hostName,assistantId:record?.id??lane.name};
 const look=assistantAppearance(ref,record?.look);
 const avatarApi=useMemo(()=>backend?createAssistantAvatarApi(backend):undefined,[backend]);
 const [pending,setPending]=useState(false);const [error,setError]=useState('');
 const status=assistantStatus({offline:!!lane.offline,paused:!!record?.paused,personalTasks:record?.tasks??[],delegatedTasks});
 const runtime=record?.profile?.backend;const model=runtime&&'model' in runtime?runtime.model:undefined;
 const projectCount=record?.projects?.length??0;
 const meta=[model,record?.profile?accessLabel(record.profile.access):undefined,`${projectCount} ${projectCount===1?'project':'projects'}`].filter(Boolean).join(' · ');
 const attention=status.needsYou+status.failed;
 const subview=section==='settings'||section==='memory';
 const closeMenu=(target:EventTarget&HTMLElement)=>target.closest('details')?.removeAttribute('open');
 const pause=async()=>{if(!lane.pause||pending)return;setPending(true);setError('');try{await lane.pause(!record?.paused);}catch(cause){setError(String(cause instanceof Error?cause.message:cause));}finally{setPending(false);}};
 return <section className="assistant-workspace" aria-label={`${lane.name} workspace`}>
  <header className="assistant-workspace-head">
   <Avatar seed={look.seed} color={look.color} image={look.kind==='image'?look.image:undefined} assistant={ref} avatarApi={avatarApi} working={status.working>0&&!record?.paused} size="md"/>
   <div className="assistant-workspace-identity"><h1>{lane.name}{status.state!=='ready'&&<span className="assistant-workspace-flag" data-state={status.state}>{status.label}</span>}</h1><p className="assistant-workspace-meta">{meta}</p></div>
   {!subview&&<nav className="assistant-workspace-tabs" role="tablist" aria-label={`${lane.name} views`}>{(['chat','work'] as const).map(tab=><button type="button" role="tab" id={`assistant-tab-${tab}`} aria-selected={section===tab} aria-controls={`assistant-panel-${tab}`} key={tab} onClick={()=>onNavigate(tab)}>{tab==='chat'?'Chat':<>Work{attention>0&&<span className="assistant-tab-count">{attention}</span>}</>}</button>)}</nav>}
   <div className="assistant-workspace-actions">
    {lane.pause&&<button type="button" className="assistant-pause" disabled={pending||lane.offline} onClick={()=>void pause()}>{record?.paused?'Resume':'Pause'}</button>}
    <details className="assistant-workspace-menu"><summary aria-label="Memory and settings">⋯</summary><div role="menu">
     <button type="button" role="menuitem" onClick={event=>{closeMenu(event.currentTarget);onNavigate('memory');}}>Memory</button>
     <button type="button" role="menuitem" onClick={event=>{closeMenu(event.currentTarget);onNavigate('settings');}}>Settings</button>
    </div></details>
   </div>
  </header>
  {(lane.problem||error)&&<p className="assistant-workspace-problem" role="alert">{error||lane.problem}</p>}
  <div id="assistant-panel-chat" role="tabpanel" aria-labelledby="assistant-tab-chat" className="assistant-workspace-content" hidden={section!=='chat'}>{chat}</div>
  {section!=='chat'&&<div id={`assistant-panel-${section}`} role={subview?undefined:'tabpanel'} aria-labelledby={subview?undefined:`assistant-tab-${section}`} className="assistant-workspace-subview">{subview&&<button type="button" className="assistant-settings-back" onClick={()=>onSubviewBack?onSubviewBack():onNavigate(previousSection)}>{previousSection==='work'?'‹ Work':'‹ Chat'}</button>}{section==='settings'?editor:section==='work'?(work??<p className="muted">Connect this machine to see its projects and tasks.</p>):<PersonalPanels delegatedTasks={delegatedTasks} key={section+JSON.stringify(memoryProject)} initialProject={memoryProject} lane={lane} initial="memory" onClose={()=>onNavigate('chat')} embedded/>}</div>}
 </section>;
}
