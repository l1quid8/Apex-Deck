import { useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from './backend';
import type { ParticipantConfig, ModelChoice, Workspace } from './types';
import type { PersonalLane, PersonalWorkspaceConfigure, PersonalAssistantRecord } from './personalAssistant';
import { assistantAppearance, createAssistantAppearance, projectIdentityKey, type AssistantProjectBinding, type AssistantRef } from './assistantIdentity';
import { runtimeProfile, textModels, reconcileEffort, validateAssistantDraft } from './assistantWorkspaceModel';
import { providerEnabled, providerForConfig } from './providers';
import { Avatar } from './Avatar';
import { HexColorPicker } from './HexColorPicker';
import { NEW_AGENT_COLORS as AGENT_COLORS } from './identicon';
import { PersonalBrowser } from './PersonalBrowser';
import { PersonalPanels } from './PersonalPanels';
import { AssistantAvatarEditor } from './AssistantAvatarEditor';
import { createAssistantAvatarApi, type AvatarSelection } from './assistantAvatar';
import './assistant-editor.css';

export type AssistantCreation = { workspaceVersion:4; name:string; folder:string; profile:ParticipantConfig; look:ReturnType<typeof createAssistantAppearance>; projects:AssistantProjectBinding[]; avatarDraftId?:string; avatarGenerationId?:string; avatarAssetId?:string };
type EditorProps = { backend:Backend; profiles:ParticipantConfig[]; disabledProviders?:string[]; lane?:PersonalLane; hostId:string; projects:Workspace[]; onCreate?:(input:AssistantCreation)=>Promise<AssistantRef|void>; onSaved?:(created?:AssistantRef)=>void; onCommitted?:()=>void };
/** A single editor for creation and Settings. The captured revision is retained after conflicts. */
export function AssistantEditor({backend,profiles,disabledProviders=[],lane,hostId,projects,onCreate,onSaved,onCommitted}:EditorProps) {
 const [original] = useState(lane?.assistant ?? null);
 const lifetime=useRef(0);
 useEffect(()=>{lifetime.current++;return()=>{lifetime.current++;};},[backend,hostId,lane?.assistant?.id]);
 const [savedBase,setSavedBase]=useState(original);
 const [expectedRevision,setExpectedRevision]=useState(original?.revision);
 const [conflict,setConflict]=useState(false);
 const [draftId] = useState(()=>crypto.randomUUID());
 const ref:AssistantRef={hostId,assistantId:original?.id ?? draftId};
 const [name,setName]=useState(original?.name ?? '');
 const [appearance,setAppearance]=useState(()=>original ? assistantAppearance(ref,original.look) : createAssistantAppearance());
 const [avatar,setAvatar]=useState<AvatarSelection>();
 const [hexValid,setHexValid]=useState(true);
 const [hostProfiles,setHostProfiles]=useState<ParticipantConfig[]>([]);
 const [profilesProblem,setProfilesProblem]=useState('Loading configured providers…');
 useEffect(()=>{let active=true;void backend.sessionLoad().then(session=>{if(active){setHostProfiles(session?.profiles ?? []);setProfilesProblem('');}}).catch(()=>{if(active)setProfilesProblem('Configured providers could not be loaded from this machine. Reconnect before saving.');});return()=>{active=false;};},[backend,profiles]);
 const configured=useMemo(()=>{
  const candidates=[...(original?.profile?[original.profile]:[]),...hostProfiles];
  const seen=new Set<string>();return candidates.filter(p=>{
   // Keep the choices aligned with the host's monitor_profile_ok contract.
   const supported=p.backend.kind==='open_ai_compatible'||(p.backend.kind==='agent'&&p.backend.tool==='claude_code');
   if(!supported||p.media!=null||!providerEnabled(providerForConfig(p),disabledProviders))return false;
   const b=p.backend;const key=b.kind==='agent'?b.tool:b.kind==='open_ai_compatible'?JSON.stringify([b.base_url,b.api_key_env]):'';
   if(seen.has(key))return false;seen.add(key);return true;
  });
 },[original,hostProfiles,disabledProviders]);
 const [provider,setProvider]=useState(0);
 const providerChosen=useRef(false);
 const [providerIntent,setProviderIntent]=useState(0);
 const providerSelection=useRef(0);
 const discoveryHandoff=useRef<{backend:Backend;profile:ParticipantConfig;offered:ModelChoice[];note:string}|null>(null);
 const source=configured[provider];
 const [model,setModel]=useState(()=>original?.profile?.backend.kind==='agent'||original?.profile?.backend.kind==='open_ai_compatible'?original.profile.backend.model ?? '':'');
 const [effort,setEffort]=useState<string|null>(original?.profile?.effort ?? null);
 const [folder,setFolder]=useState('~/apex-assistant');
 const [access,setAccess]=useState<ParticipantConfig['access']>(original?.profile?.access ?? 'ask');
 const [bindings,setBindings]=useState<AssistantProjectBinding[]>(original?.projects ?? []);
 const [models,setModels]=useState<ModelChoice[]>([]);
 const [providerReady,setProviderReady]=useState(false);
 const [discovery,setDiscovery]=useState('Loading offered models…');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [browserOpen,setBrowserOpen]=useState(false);
 const [toolsPanel,setToolsPanel]=useState<'connections'|'rules'>('connections');
 const [browserStatus,setBrowserStatus]=useState(original?'Checking availability…':'Browser access is available after Create through the connected browser and assistant rules.');
 useEffect(()=>{let active=true;if(lane?.connectors)void lane.connectors().then(connectors=>{if(active)setBrowserStatus(connectors.some(item=>item.kind==='browser'&&item.connected)?'Connected browser available. Browser actions use the assistant’s sending approval rules.':'No connected browser is available on this machine.');}).catch(()=>{if(active)setBrowserStatus('Browser availability could not be checked. Reconnect this machine.');});return()=>{active=false;};},[backend,original?.id]);
 useEffect(()=>{
  let current=true;const selection=providerSelection.current;setModels([]);setProviderReady(false);setDiscovery('Loading offered models…');
  const offeredBy=async(profile:ParticipantConfig)=>{
   const handoff=discoveryHandoff.current;
   if(handoff?.backend===backend&&handoff.profile===profile){discoveryHandoff.current=null;return handoff;}
   const b=profile.backend;let offered:ModelChoice[]=[];
   if(b.kind==='agent') {
    const installed=await backend.detectAgents();
    if(!installed.some(agent=>agent.key===b.tool&&agent.found))throw new Error(`${b.tool} is not installed on this machine. Install it and sign in before saving.`);
    offered=await backend.agentModels(b.tool);
   }
   else if(b.kind==='open_ai_compatible') {
    if(b.api_key_env){const status=await backend.apiKeyStatus([b.api_key_env]);if(!status[0]||status[0]==='missing')throw new Error('The provider credential is missing on this host. Add it in Settings.');}
    offered=textModels(await backend.apiModels(b.base_url,b.api_key_env));
   }
   if(!offered.length)throw new Error('No offered text models are available from this provider. Check its connection and credentials.');
   return {backend,profile,offered,note:b.kind==='agent'?'CLI installation found. Sign-in cannot be verified here; this model list comes from its cache.':''};
  };
  const discover=async()=>{
   if(!source)throw new Error('Configure a compatible provider in Agents before saving this assistant.');
   // Creation probes configured APIs first, then an installed CLI. Settings and
   // explicit choices keep their provider even when that connection is unavailable.
   const hasHandoff=discoveryHandoff.current?.backend===backend&&discoveryHandoff.current.profile===source;
   const candidates=!hasHandoff&&!original&&!providerChosen.current?[...configured].sort((a,b)=>Number(b.backend.kind==='open_ai_compatible')-Number(a.backend.kind==='open_ai_compatible')):[source];
   let failure:unknown;
   for(const candidate of candidates){
    try {
     const result=await offeredBy(candidate);
     if(!current||selection!==providerSelection.current)return;
     if(candidate!==source){discoveryHandoff.current=result;setProvider(configured.indexOf(candidate));return;}
     setModels(result.offered);setProviderReady(true);setDiscovery(result.note);
     setModel(before=>{const preferred=before||(candidate.backend.kind==='agent'||candidate.backend.kind==='open_ai_compatible'?candidate.backend.model:'');const selected=result.offered.find(m=>m.id===preferred)??result.offered[0];setEffort(e=>reconcileEffort(e,selected));return selected.id;});
     return;
    }catch(error){failure=error;if(!current||selection!==providerSelection.current)return;}
   }
   throw failure;
  };void discover().catch(e=>{if(current&&selection===providerSelection.current)setDiscovery(e instanceof Error?e.message:String(e));});return()=>{current=false;};
 },[backend,source,configured.length,providerIntent]);
 const selected=models.find(m=>m.id===model);
 const folderPath=folder.trim();
 const folderProblem=!original&&(!folderPath||/[\x00-\x1f\x7f]/.test(folderPath)||!(folderPath.startsWith('/')||folderPath.startsWith('~/')||/^[A-Za-z]:[\\/]/.test(folderPath)||/^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/.test(folderPath)))?'Enter a full path or home-relative path (~/) on the selected machine.':'';
 const invalid=folderProblem || profilesProblem || validateAssistantDraft({name,color:hexValid||appearance.kind==='image'?appearance.color:'invalid',profile:source,model:selected,effort,providerReady});
 const save=async()=>{
  if(invalid||!source||busy)return;const token=lifetime.current;setBusy(true);setError('');
  const profile=runtimeProfile({...savedBase?.profile??source,backend:source.backend},name,model,access,effort);
  try {
   let created:AssistantRef|void=undefined;
   if(original){
    if(!lane?.configureWorkspace)throw new Error('Update this machine’s service to save assistant workspace settings.');
    const configuration:PersonalWorkspaceConfigure={expectedRevision:expectedRevision!,settings:{name:name.trim(),look:appearance},profile,projects:bindings,...(avatar?{avatar}:{})};
    await lane.configureWorkspace(configuration);
   } else {
    if(!onCreate)throw new Error('Creation is unavailable on this machine.');
    created=await onCreate({workspaceVersion:4,name:name.trim(),folder:folderPath,profile,look:appearance,projects:bindings,avatarDraftId:draftId,...(avatar?.kind==='image'?{avatarGenerationId:avatar.generationId,avatarAssetId:avatar.assetId}:{})});
   }
   onCommitted?.();
   if(lifetime.current===token)onSaved?.(created||undefined);
  }catch(e){if(lifetime.current===token){const message=e instanceof Error?e.message:String(e);setError(message);setConflict(/revision|conflict|stale|assistant changed.*refresh/i.test(message));}}finally{if(lifetime.current===token)setBusy(false);}
 };
 const refreshRevision=async()=>{
  if(!original||busy)return;const token=lifetime.current;setBusy(true);
  try {
   const current=await backend.call<PersonalAssistantRecord>('personal_get',{assistantId:original.id});
   const status=backend.host?.connection.get().status;
   if(backend.host&&(status?.kind!=='connected'||status.hostId!==hostId))throw new Error('The assistant machine identity changed. Reconnect before refreshing.');
   if(current.id!==original.id||current.hostId!==hostId||!Number.isSafeInteger(current.revision))throw new Error('The refreshed assistant owner could not be verified.');
   if(lifetime.current===token){setExpectedRevision(current.revision);setSavedBase(current);setConflict(false);setError('Revision refreshed. Your draft is preserved; review it and Save to retry.');}
  }catch(e){if(lifetime.current===token)setError(e instanceof Error?e.message:String(e));}finally{if(lifetime.current===token)setBusy(false);}
 };
 const api=useMemo(()=>createAssistantAvatarApi(backend),[backend]);
 const owner=original?{kind:'assistant' as const,assistant:ref}:{kind:'creation' as const,hostId,draftId};
 const draftImage=avatar?.kind==='image'?{owner,generationId:avatar.generationId}:undefined;
 return <div className={`assistant-editor${original?' assistant-editor-settings':' assistant-editor-create'}`}>
  {original&&<header className="assistant-editor-heading"><h2>Settings</h2><p>Make {original.name} yours.</p></header>}
  <section className="assistant-editor-identity">{original&&<h3>Identity</h3>}<label className="assistant-setting-row"><span>Name</span><input aria-label="Assistant name" value={name} maxLength={64} placeholder="Choose a name" autoComplete="off" onChange={e=>setName(e.target.value)}/></label>{!original&&<p className="assistant-setup-intro">Each assistant has its own conversation, memory, and projects. Give it a work brief in Conversation after creating it.</p>}</section>
  <fieldset className="assistant-config"><legend>AI model</legend>
   <label className="assistant-setting-row"><span>Provider</span><select aria-label="Assistant provider" value={provider} onChange={e=>{providerChosen.current=true;providerSelection.current++;setProviderIntent(before=>before+1);discoveryHandoff.current=null;setProvider(Number(e.target.value));setEffort(null);setModel('');}}>{!configured.length&&<option>No compatible configured providers</option>}{configured.map((p,i)=><option key={i} value={i}>{p.display_name} · {providerForConfig(p)}</option>)}</select></label>
   <label className="assistant-setting-row"><span>Model</span><select aria-label="Assistant model" value={model} disabled={!providerReady} onChange={e=>{setModel(e.target.value);setEffort(before=>reconcileEffort(before,models.find(m=>m.id===e.target.value)));}}>{!models.length&&<option value="">No offered text models</option>}{models.map(m=><option key={m.id} value={m.id}>{m.label??m.id}</option>)}</select></label>
   <label className="assistant-setting-row"><span>Reasoning</span><select aria-label="Assistant reasoning" value={effort??''} disabled={!selected?.efforts?.length} onChange={e=>setEffort(e.target.value||null)}>{!selected?.efforts?.length&&<option value="">{selected?.efforts?'No reasoning setting':'Provider default'}</option>}{selected?.efforts?.map(level=><option key={level} value={level}>{level}</option>)}</select></label>{discovery&&<p className="assistant-control-note" role="status">{discovery}</p>}
  </fieldset>
  <fieldset className="assistant-config"><legend>Access</legend>
   <label className="assistant-setting-row"><span>Project tools</span><select aria-label="Project tools" value={access} onChange={e=>{const value=e.target.value as ParticipantConfig['access'];setAccess(value);setBindings(before=>before.map(b=>({...b,tools:value==='full'?'full':value==='read'?'off':'ask'})));}}><option value="read">Read only</option><option value="ask">Ask for approval</option><option value="edits">Allow edits</option><option value="full">Full access</option></select></label>
   <div className="assistant-setting-row"><span>Browser<small>Borrow a tab for a requested task</small></span>{lane?.browserView?<button type="button" disabled={busy||lane.offline} onClick={()=>setBrowserOpen(true)}>Open browser / Take over</button>:<span className="assistant-setting-value">After Create</span>}</div><p className="assistant-control-note">{browserStatus}</p>
   {!original&&<details className="assistant-folder-boundary" open={!!folderProblem}><summary>Allowed project folder <span>{folder}</span></summary><label className="assistant-setting-row"><span>Folder</span><input aria-label="Allowed project folder" aria-describedby="assistant-folder-scope" value={folder} disabled={busy} onChange={e=>setFolder(e.target.value)}/></label><p id="assistant-folder-scope" className="assistant-control-note">Choose a full path or ~/ on the selected machine. Create grants access to this folder and its subfolders. Full access controls project actions within this boundary.</p></details>}
  </fieldset>
  {original&&<><section className="assistant-settings-section"><h3>Connected context</h3><p className="assistant-control-note">Choose the projects the assistant can follow.</p>{projects.map(project=>{const binding={hostId,workspaceId:project.id,cwd:project.path};const key=projectIdentityKey(binding);const checked=bindings.some(b=>projectIdentityKey(b.project)===key);const changedFolder=!checked&&bindings.some(b=>b.project.hostId===hostId&&b.project.workspaceId===project.id);return <label className="assistant-setting-row assistant-project-choice" key={key}><span>{project.name}{changedFolder&&<small role="status">The assigned folder could not be verified. Refresh or reconnect its machine; the saved assignment is retained.</small>}</span><input type="checkbox" checked={checked} disabled={changedFolder} onChange={e=>setBindings(before=>e.target.checked?[...before,{project:binding,tools:access==='full'?'full':access==='read'?'off':'ask'}]:before.filter(b=>projectIdentityKey(b.project)!==key))}/></label>;})}{!projects.length&&<p className="assistant-control-note">No projects on this machine.</p>}</section>
   <section className="assistant-settings-section"><h3>Skills &amp; tools</h3><details className="assistant-connected-tools"><summary className="assistant-setting-row"><span>Connected tools &amp; standing rules<small>Manage this assistant’s connections and permissions</small></span><span aria-hidden="true">›</span></summary><nav className="assistant-tools-nav" aria-label="Assistant tools"><button type="button" aria-pressed={toolsPanel==='connections'} onClick={()=>setToolsPanel('connections')}>Connections</button><button type="button" aria-pressed={toolsPanel==='rules'} onClick={()=>setToolsPanel('rules')}>Rules</button></nav><PersonalPanels key={toolsPanel} lane={lane!} initial={toolsPanel} onClose={()=>{}} embedded/></details></section></>}
  <fieldset className="assistant-config assistant-appearance"><legend>Avatar</legend><div className="assistant-avatar-intro"><Avatar seed={appearance.seed} color={appearance.color} size="lg" image={appearance.kind==='image'?appearance.image:undefined} assistant={original?ref:undefined} avatarApi={api} draftImage={draftImage}/><div><strong>Your assistant’s look</strong><p>Keep a pixel pattern or create something of your own.</p></div></div><AssistantAvatarEditor owner={owner} api={api} appearance={appearance} onAppearanceChange={next=>setAppearance(before=>({...before,...next}))} onApply={setAvatar} disabled={busy||lane?.offline} pixelControls={<HexColorPicker label="Avatar color" value={appearance.color} presets={AGENT_COLORS} onChange={color=>setAppearance(before=>({...before,color}))} onValidityChange={setHexValid}/>}/></fieldset>
  {error&&<p role="alert">{error}</p>}{conflict&&<button type="button" disabled={busy||lane?.offline} onClick={refreshRevision}>Refresh revision, keep draft</button>}{invalid&&<p className="assistant-control-note" role="status">{invalid}</p>}<form className="assistant-editor-save" onSubmit={e=>{e.preventDefault();void save();}}>{original&&<p>Name, model, and avatar changes save below.</p>}<button type="submit" className="primary" disabled={busy||!!invalid||lane?.offline}>{busy?'Saving…':original?'Save changes':'Create'}</button></form>
  {browserOpen&&lane?.browserView&&<PersonalBrowser lane={lane} onClose={()=>setBrowserOpen(false)}/>}
 </div>;
}
