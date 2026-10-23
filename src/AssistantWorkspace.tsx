import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Backend } from './backend';
import type { ParticipantConfig, ModelChoice, Workspace } from './types';
import type { PersonalLane, PersonalWorkspaceConfigure } from './personalAssistant';
import { assistantAppearance, createAssistantAppearance, projectIdentityKey, type AssistantProjectBinding, type AssistantRef } from './assistantIdentity';
import { runtimeProfile, textModels, reconcileEffort, validateAssistantDraft, type AssistantSection } from './assistantWorkspaceModel';
import { providerEnabled, providerForConfig } from './providers';
import { Avatar } from './Avatar';
import { HexColorPicker } from './HexColorPicker';
import { AGENT_COLORS } from './identicon';
import { PersonalBrowser } from './PersonalBrowser';
import { PersonalPanels } from './PersonalPanels';
import { AssistantAvatarEditor } from './AssistantAvatarEditor';
import { createAssistantAvatarApi, type AvatarSelection } from './assistantAvatar';
import './assistant-workspace.css';

export type AssistantCreation = { workspaceVersion:4; name:string; folder:string; profile:ParticipantConfig; look:ReturnType<typeof createAssistantAppearance>; projects:AssistantProjectBinding[]; avatarDraftId?:string; avatarGenerationId?:string; avatarAssetId?:string };
type EditorProps = { backend:Backend; profiles:ParticipantConfig[]; disabledProviders?:string[]; lane?:PersonalLane; hostId:string; projects:Workspace[]; onCreate?:(input:AssistantCreation)=>Promise<void>; onSaved?:()=>void };
/** A single editor for creation and Settings. The captured revision is retained after conflicts. */
export function AssistantEditor({backend,profiles,disabledProviders=[],lane,hostId,projects,onCreate,onSaved}:EditorProps) {
 const [original] = useState(lane?.assistant ?? null);
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
   if(!['agent','open_ai_compatible'].includes(p.backend.kind)||!providerEnabled(providerForConfig(p),disabledProviders))return false;
   const b=p.backend;const key=b.kind==='agent'?b.tool:b.kind==='open_ai_compatible'?JSON.stringify([b.base_url,b.api_key_env]):'';
   if(seen.has(key))return false;seen.add(key);return true;
  });
 },[original,hostProfiles,disabledProviders]);
 const [provider,setProvider]=useState(0);
 const source=configured[provider];
 const [model,setModel]=useState(()=>original?.profile?.backend.kind==='agent'||original?.profile?.backend.kind==='open_ai_compatible'?original.profile.backend.model ?? '':'');
 const [effort,setEffort]=useState<string|null>(original?.profile?.effort ?? null);
 const [access,setAccess]=useState<ParticipantConfig['access']>(original?.profile?.access ?? 'ask');
 const [bindings,setBindings]=useState<AssistantProjectBinding[]>(original?.projects ?? []);
 const [models,setModels]=useState<ModelChoice[]>([]);
 const [providerReady,setProviderReady]=useState(false);
 const [discovery,setDiscovery]=useState('Loading offered models…');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [browserOpen,setBrowserOpen]=useState(false);
 const [browserStatus,setBrowserStatus]=useState(original?'Checking availability…':'Browser access is available after Create through the connected browser and assistant rules.');
 useEffect(()=>{let active=true;if(lane?.connectors)void lane.connectors().then(connectors=>{if(active)setBrowserStatus(connectors.some(item=>item.kind==='browser'&&item.connected)?'Connected browser available. Browser actions use the assistant’s sending approval rules.':'No connected browser is available on this machine.');}).catch(()=>{if(active)setBrowserStatus('Browser availability could not be checked. Reconnect this machine.');});return()=>{active=false;};},[backend,original?.id]);
 useEffect(()=>{
  let current=true;setModels([]);setProviderReady(false);setDiscovery('Loading offered models…');
  const discover=async()=>{
   if(!source)throw new Error('Configure a compatible provider in Agents before saving this assistant.');
   const b=source.backend;let offered:ModelChoice[]=[];
   if(b.kind==='agent') offered=await backend.agentModels(b.tool);
   else if(b.kind==='open_ai_compatible') {
    if(b.api_key_env){const status=await backend.apiKeyStatus([b.api_key_env]);if(!status[0]||status[0]==='missing')throw new Error('The provider credential is missing on this host. Add it in Settings.');}
    offered=textModels(await backend.apiModels(b.base_url,b.api_key_env));
   }
   if(!offered.length)throw new Error('No offered text models are available from this provider. Check its connection and credentials.');
   if(!current)return;setModels(offered);setProviderReady(true);setDiscovery('');
   setModel(before=>{const selected=offered.find(m=>m.id===before)??offered[0];setEffort(e=>reconcileEffort(e,selected));return selected.id;});
  };void discover().catch(e=>{if(current)setDiscovery(e instanceof Error?e.message:String(e));});return()=>{current=false;};
 },[backend,source]);
 const selected=models.find(m=>m.id===model);
 const invalid=profilesProblem || validateAssistantDraft({name,color:hexValid?appearance.color:'invalid',profile:source,model:selected,effort,providerReady});
 const save=async()=>{
  if(invalid||!source)return;setBusy(true);setError('');
  const profile=runtimeProfile({...original?.profile??source,backend:source.backend},name,model,access,effort);
  try {
   if(original){
    if(!lane?.configureWorkspace)throw new Error('Update this machine’s service to save assistant workspace settings.');
    const configuration:PersonalWorkspaceConfigure={expectedRevision:original.revision,settings:{name:name.trim(),look:appearance},profile,projects:bindings,...(avatar?{avatar}:{})};
    await lane.configureWorkspace(configuration);
   } else {
    if(!onCreate)throw new Error('Creation is unavailable on this machine.');
    await onCreate({workspaceVersion:4,name:name.trim(),folder:'~/apex-assistant',profile,look:appearance,projects:bindings,...(avatar?.kind==='image'?{avatarDraftId:draftId,avatarGenerationId:avatar.generationId,avatarAssetId:avatar.assetId}:{})});
   }
   onSaved?.();
  }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 const api=useMemo(()=>createAssistantAvatarApi(backend),[backend]);
 const owner=original?{kind:'assistant' as const,assistant:ref}:{kind:'creation' as const,hostId,draftId};
 return <div className="assistant-editor personal-panels-form">
  <section><h2>{original?'Assistant settings':'New teammate'}</h2><div className="assistant-name-preview"><Avatar seed={appearance.seed} color={appearance.color} image={appearance.kind==='image'?appearance.image:undefined} assistant={original?ref:undefined} avatarApi={api}/><label>Name<input aria-label="Assistant name" value={name} maxLength={128} onChange={e=>setName(e.target.value)}/></label></div><p className="muted">Use Conversation to share a work brief and coordinate with your assistant.</p></section>
  <section><h3>AI model</h3><label>Provider<select aria-label="Assistant provider" value={provider} onChange={e=>{setProvider(Number(e.target.value));setEffort(null);setModel('');}}>{!configured.length&&<option>No compatible configured providers</option>}{configured.map((p,i)=><option key={i} value={i}>{p.display_name} · {providerForConfig(p)}</option>)}</select></label><label>Model<select aria-label="Assistant model" value={model} disabled={!providerReady} onChange={e=>{setModel(e.target.value);setEffort(before=>reconcileEffort(before,models.find(m=>m.id===e.target.value)));}}>{!models.length&&<option value="">No offered text models</option>}{models.map(m=><option key={m.id} value={m.id}>{m.label??m.id}</option>)}</select></label><label>Reasoning<select aria-label="Assistant reasoning" value={effort??''} onChange={e=>setEffort(e.target.value||null)}>{!selected?.efforts?.length&&<option value="">{selected?.efforts?'No reasoning setting':'Provider default'}</option>}{selected?.efforts?.map(level=><option key={level} value={level}>{level}</option>)}</select></label>{discovery&&<p role="status">{discovery}</p>}</section>
  <section><h3>Access</h3><label>Project tools<select aria-label="Project tools" value={access} onChange={e=>{const value=e.target.value as ParticipantConfig['access'];setAccess(value);setBindings(before=>before.map(b=>({...b,tools:value==='full'?'full':value==='read'?'off':'ask'})));}}><option value="read">Read only</option><option value="ask">Ask for approval</option><option value="edits">Allow edits</option><option value="full">Full access</option></select></label><p className="muted">Applies to assigned projects. Machine and folder permissions remain managed on their owner.</p><h4>Browser</h4><p className="muted">{browserStatus}</p>{lane?.browserView&&<button type="button" disabled={busy||lane.offline} onClick={()=>setBrowserOpen(true)}>Open browser / Take over</button>}</section>
  {original&&<><section><h3>Connected context</h3><p className="muted">Assign projects on this machine. Existing assignments on other machines are retained.</p>{projects.map(project=>{const binding={hostId,workspaceId:project.id,cwd:project.path};const key=projectIdentityKey(binding);const checked=bindings.some(b=>projectIdentityKey(b.project)===key);return <label className="assistant-project-choice" key={key}><input type="checkbox" checked={checked} onChange={e=>setBindings(before=>e.target.checked?[...before,{project:binding,tools:access==='full'?'full':access==='read'?'off':'ask'}]:before.filter(b=>projectIdentityKey(b.project)!==key))}/>{project.name}</label>;})}{!projects.length&&<p className="muted">No projects on this machine.</p>}</section><section><h3>Skills &amp; tools</h3><p className="muted">Connected tools and standing rules are managed for this assistant.</p><PersonalPanels lane={lane!} initial="connections" onClose={()=>{}} embedded/></section></>}
  <section><h3>Avatar</h3><div className="assistant-avatar-preview"><Avatar seed={appearance.seed} color={appearance.color} size="lg" image={appearance.kind==='image'?appearance.image:undefined} assistant={original?ref:undefined} avatarApi={api}/></div><HexColorPicker label="Avatar color" value={appearance.color} presets={AGENT_COLORS} onChange={color=>setAppearance(before=>({...before,color}))} onValidityChange={setHexValid}/><AssistantAvatarEditor owner={owner} api={api} appearance={appearance} onAppearanceChange={next=>setAppearance(before=>({...before,...next}))} onApply={setAvatar} disabled={busy||lane?.offline}/></section>
  {error&&<p role="alert">{error}</p>}{invalid&&<p className="muted" role="status">{invalid}</p>}<form className="assistant-editor-save" onSubmit={e=>{e.preventDefault();void save();}}><button type="submit" className="primary" disabled={busy||!!invalid||lane?.offline}>{busy?'Saving…':original?'Save':'Create'}</button></form>
  {browserOpen&&lane?.browserView&&<PersonalBrowser lane={lane} onClose={()=>setBrowserOpen(false)}/>}
 </div>;
}

export function AssistantWorkspace({lane,section,onNavigate,onBack,conversation,editor,projects,onOpenProject}:{lane:PersonalLane;section:AssistantSection;onNavigate:(section:AssistantSection)=>void;onBack:()=>void;conversation:ReactNode;editor:ReactNode;projects:AssistantProjectBinding[];onOpenProject?:(workspaceId:string)=>void}) {
 return <section className="assistant-workspace" aria-label={`${lane.name} workspace`}>
  <header className="assistant-workspace-head"><button type="button" onClick={onBack}>← Workspaces</button><strong>{lane.name}</strong><span className="muted">{lane.hostName}{lane.offline?' · Offline':''}</span><nav aria-label="Assistant workspace">{(['conversation','projects','activity'] as const).map(tab=><button key={tab} aria-current={section===tab?'page':undefined} onClick={()=>onNavigate(tab)}>{tab==='conversation'?'Conversation':tab==='projects'?'Projects':'Activity'}</button>)}</nav><details><summary aria-label="Assistant options">⋯</summary><button onClick={()=>onNavigate('memory')}>Memory</button><button onClick={()=>onNavigate('settings')}>Settings</button></details></header>
  {lane.problem&&<p role="alert">{lane.problem}</p>}
  <div className="assistant-workspace-content" hidden={section!=='conversation'}>{conversation}</div>
  {section!=='conversation'&&<div className="assistant-workspace-subview">{(section==='memory'||section==='settings')&&<button onClick={()=>onNavigate('conversation')}>← Back to Conversation</button>}{section==='settings'?editor:section==='projects'?<><h2>Projects</h2>{!projects.length&&<p className="muted">No projects assigned. Add connected context in Settings.</p>}{projects.map(binding=><button key={projectIdentityKey(binding.project)} onClick={()=>onOpenProject?.(binding.project.workspaceId)}>{binding.project.cwd} · {binding.tools}</button>)}</>:<PersonalPanels key={section} lane={lane} initial={section==='memory'?'memory':'activity'} onClose={()=>onNavigate('conversation')} embedded/>}</div>}
 </section>;
}
