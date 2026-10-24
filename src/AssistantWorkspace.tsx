import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Backend } from './backend';
import type { PersonalLane } from './personalAssistant';
import { assistantAppearance, type ProjectRef } from './assistantIdentity';
import { assistantStatus } from './assistantStatus';
import type { AssistantTask } from './assistantTaskModel';
import type { AssistantSection } from './assistantWorkspaceModel';
import { Avatar } from './Avatar';
import { createAssistantAvatarApi } from './assistantAvatar';
import { PersonalPanels } from './PersonalPanels';
import { AssistantRuntimeSettings } from './AssistantRuntimeSettings';
import type { ParticipantConfig } from './types';
export { AssistantEditor } from './AssistantEditor';
export type { AssistantCreation } from './AssistantEditor';
import './assistant-workspace.css';

export function AssistantWorkspaceAvatar({lane,backend}:{lane:PersonalLane;backend?:Backend}) {
 const record=lane.assistant;const ref=lane.ref??{hostId:record?.hostId??lane.hostName,assistantId:record?.id??lane.name};
 const look=assistantAppearance(ref,record?.look);const api=useMemo(()=>backend?createAssistantAvatarApi(backend):undefined,[backend]);
 return <Avatar seed={look.seed} color={look.color} image={look.kind==='image'?look.image:undefined} assistant={ref} avatarApi={api} size="sm"/>;
}

/** One chat per assistant, in a 60px session strip that floats over it.
 *  Everything else — the assistant's own settings, memory and project access —
 *  is a subview you reach from the ⋯ menu, and its details live in the app's
 *  right sidebar, never in a second one of its own. */
export function AssistantWorkspace({lane,backend,section,onNavigate,chat,projects,editor,memoryProject,delegatedTasks=[],onSubviewBack,previousSection='chat',profiles=[],callControls,browser,onOpenBrowser}:{lane:PersonalLane;backend?:Backend;section:AssistantSection;onNavigate:(section:AssistantSection)=>void;chat:ReactNode;projects:ReactNode;editor:ReactNode;memoryProject?:ProjectRef;delegatedTasks?:AssistantTask[];onSubviewBack?:()=>void;previousSection?:AssistantSection;profiles?:ParticipantConfig[];callControls?:ReactNode;browser?:ReactNode;onOpenBrowser?:()=>void}) {
 const record=lane.assistant;
 const ref=lane.ref??{hostId:record?.hostId??lane.hostName,assistantId:record?.id??lane.name};
 const look=assistantAppearance(ref,record?.look);
 const avatarApi=useMemo(()=>backend?createAssistantAvatarApi(backend):undefined,[backend]);
 const [pending,setPending]=useState(false);const [error,setError]=useState('');
 const [settingsVisited,setSettingsVisited]=useState(section==='settings');
 useEffect(()=>{if(section==='settings')setSettingsVisited(true);},[section]);
 const [runtimeAnchor,setRuntimeAnchor]=useState<HTMLElement|null>(null);
 useEffect(()=>{setRuntimeAnchor(null);},[ref.hostId,ref.assistantId,section]);
 const status=assistantStatus({offline:!!lane.offline,paused:!!record?.paused,personalTasks:record?.tasks??[],delegatedTasks});
 const runtimeReason=!backend?'Reconnect this machine to configure the runtime.':!record?.profile?'Open Settings to choose a compatible text provider.':undefined;
 const backLabel=({chat:'Chat',projects:'Projects & access',settings:'Settings',memory:'Memory'} as const)[previousSection];
 const closeMenu=(target:EventTarget&HTMLElement)=>target.closest('details')?.removeAttribute('open');
 const pause=async()=>{if(!lane.pause||pending)return;setPending(true);setError('');try{await lane.pause(!record?.paused);}catch(cause){setError(String(cause instanceof Error?cause.message:cause));}finally{setPending(false);}};
 return <section className="assistant-workspace" aria-label={`${lane.name} workspace`}>
  <header className="assistant-workspace-head">
   <div className="assistant-session">
    <button type="button" className="assistant-session-id" aria-label={`${lane.name}: runtime settings`} aria-haspopup="dialog" aria-expanded={!!runtimeAnchor} disabled={!!runtimeReason} title={runtimeReason||'Provider, model, reasoning, speed, access and usage'} onClick={event=>setRuntimeAnchor(runtimeAnchor?null:event.currentTarget)}>
     <Avatar seed={look.seed} color={look.color} image={look.kind==='image'?look.image:undefined} assistant={ref} avatarApi={avatarApi} working={status.working>0&&!record?.paused} size="md"/>
     <span className="assistant-session-text"><span className="assistant-session-name">{lane.name}</span><span className="assistant-session-status" data-state={status.state}>{status.label}</span></span>
    </button>
    {callControls&&<div className="assistant-session-call">{callControls}</div>}
   </div>
   <div className="assistant-strip-right">
    <details className="assistant-workspace-menu"><summary aria-label="Projects, memory and settings">⋯</summary><div role="menu">
     <button type="button" role="menuitem" onClick={event=>{closeMenu(event.currentTarget);setRuntimeAnchor(null);onNavigate('projects');}}>Projects &amp; access</button>
     <button type="button" role="menuitem" disabled={!onOpenBrowser||!lane.browserView} title={!lane.browserView?'This host does not expose the assistant browser.':undefined} onClick={event=>{closeMenu(event.currentTarget);setRuntimeAnchor(null);onOpenBrowser?.();}}>Browser</button>
     <button type="button" role="menuitem" onClick={event=>{closeMenu(event.currentTarget);setRuntimeAnchor(null);onNavigate('memory');}}>Memory</button>
     <button type="button" role="menuitem" onClick={event=>{closeMenu(event.currentTarget);setRuntimeAnchor(null);onNavigate('settings');}}>Settings</button>
     {lane.pause&&<button type="button" role="menuitem" className="assistant-pause" disabled={pending||lane.offline} onClick={()=>void pause()}>{record?.paused?'Resume':'Pause'}</button>}
    </div></details>
   </div>
  </header>
  {(lane.problem||error)&&<p className="assistant-workspace-problem" role="alert">{error||lane.problem}</p>}
  <div className="assistant-workspace-content" hidden={section!=='chat'}>{chat}</div>
  {section!=='chat'&&section!=='settings'&&<div className="assistant-workspace-subview">
   <button type="button" className="assistant-settings-back" onClick={()=>onSubviewBack?onSubviewBack():onNavigate(previousSection)}>{`‹ ${backLabel}`}</button>
   {section==='projects'?projects:<PersonalPanels delegatedTasks={delegatedTasks} key={section+JSON.stringify(memoryProject)} initialProject={memoryProject} lane={lane} initial="memory" onOpenBrowser={onOpenBrowser} onClose={()=>onNavigate('chat')} embedded/>}
  </div>}
  {settingsVisited&&<div className="assistant-workspace-subview" hidden={section!=='settings'} aria-label="Assistant settings"><button type="button" className="assistant-settings-back" onClick={()=>onSubviewBack?onSubviewBack():onNavigate(previousSection)}>{`‹ ${backLabel}`}</button>{editor}</div>}
  {browser}
  {runtimeAnchor&&backend&&record?.profile&&<AssistantRuntimeSettings key={JSON.stringify([ref.hostId,ref.assistantId])} lane={lane} backend={backend} anchor={runtimeAnchor} profiles={profiles} close={()=>setRuntimeAnchor(null)} onSettings={()=>onNavigate('settings')}/>}
 </section>;
}
