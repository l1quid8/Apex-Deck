import { useEffect, useState } from 'react';
import type { Backend } from './backend';
import { computerSummary } from './assistantCapabilities';
import type { PersonalAssistantRecord } from './personalAssistant';
import type { ParticipantConfig } from './types';
import { OPEN_SETTINGS_EVENT } from './ModView';

/** Explains capabilities that are set elsewhere; there is no per-assistant switch for
 *  Unified Computer Use, and model image support is shown only as what it limits. */
export function AssistantCapabilities({backend,name,profile,record,access,offline,onPopOut}:{backend:Backend;name:string;profile?:ParticipantConfig|null;record:PersonalAssistantRecord;access?:string;offline:boolean;onPopOut?:()=>void}) {
 const [status,setStatus]=useState<{available?:boolean;enabled?:boolean}|null>(null);
 useEffect(()=>{let live=true;void Promise.resolve().then(()=>backend.call<{available?:boolean;enabled?:boolean}>('computer_status')).then(next=>{if(live)setStatus(next);}).catch(()=>{if(live)setStatus({});});return()=>{live=false;};},[backend]);
 const summary=computerSummary({name,profile,record,access,enabled:status?.enabled,available:status?.available});
 const fullAccess=(access??profile?.access)==='full';
 return <section className="assistant-settings-section"><h3>Capabilities</h3>
  <div className="assistant-setting-row"><span>Unified Computer Use<small>Set once for all agents. {fullAccess?'Full access uses enabled apps without assistant approval prompts. macOS permissions still apply.':`${name} asks before each app, and your choice lasts for this conversation at most.`}</small></span><span className="assistant-setting-value" role="status">{status?summary.state:'Checking…'}</span></div>
  {status&&summary.notes.map(note=><p className="assistant-control-note" key={note}>{note}</p>)}
  <p className="assistant-control-note">Work happens in the background with {name}’s own browser. Your pointer and keyboard stay yours, and anything that would need the foreground is reported instead of done.</p>
  <button type="button" className="assistant-settings-link" onClick={()=>window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT,{detail:'computer'}))}><span>Computer use settings<small>On or off, permissions, cursor and action labels</small></span><span aria-hidden="true">›</span></button>
  <div className="assistant-setting-row"><span>Floating window<small>A small window sharing this chat, draft and call. Keep it on top from inside the window.</small></span><button type="button" disabled={!onPopOut||offline} title={onPopOut?undefined:'Available in the Deck app.'} onClick={()=>onPopOut?.()}>Pop out</button></div>
 </section>;
}
