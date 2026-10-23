import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Backend } from './backend';
import type { ParticipantConfig, ModelChoice, Workspace } from './types';
import type { PersonalLane, PersonalWorkspaceConfigure, PersonalAssistantRecord } from './personalAssistant';
import { assistantAppearance, createAssistantAppearance, projectIdentityKey, type AssistantProjectBinding, type AssistantRef } from './assistantIdentity';
import { dirtyFields, runtimeProfile, textModels, reconcileEffort, validateAssistantDraft } from './assistantWorkspaceModel';
import { providerEnabled, providerForConfig } from './providers';
import { Avatar } from './Avatar';
import { HexColorPicker } from './HexColorPicker';
import { NEW_AGENT_COLORS as AGENT_COLORS } from './identicon';
import { PersonalBrowser } from './PersonalBrowser';
import { PersonalPanels, type PanelName } from './PersonalPanels';
import { AssistantAvatarEditor } from './AssistantAvatarEditor';
import { createAssistantAvatarApi, type AvatarSelection } from './assistantAvatar';
import type { VoiceSettings } from './voice/types';
import { CALL_VOICES, defaultVoiceOf, readVoiceSettings } from './voice/settings';
import { CALL_LOOKS, voiceLabel } from './voice/callView';
import { VoiceSampleButton } from './voice/VoiceSampleButton';
import './assistant-editor.css';

export type AssistantCreation = { workspaceVersion:4; name:string; folder:string; profile:ParticipantConfig; look:ReturnType<typeof createAssistantAppearance>; projects:AssistantProjectBinding[]; avatarDraftId?:string; avatarGenerationId?:string; avatarAssetId?:string; firstBrief?:string };
const providerConnection=(profile?:ParticipantConfig|null)=>{const backend=profile?.backend;return backend?.kind==='agent'?JSON.stringify([backend.kind,backend.tool]):backend?.kind==='open_ai_compatible'?JSON.stringify([backend.kind,backend.base_url,backend.api_key_env]):'';};
type PreferenceDraft = {style:string;timezone:string;quietStart:string;quietEnd:string;dailyDollars:string;unknownCostOk:boolean;localOnly:boolean;endpoints:string;contextChars:string};
const preferenceDraft=(record:PersonalAssistantRecord|null):PreferenceDraft=>({style:record?.style??'',timezone:record?.timezone??'',quietStart:record?.quietHours?.start??'',quietEnd:record?.quietHours?.end??'',dailyDollars:record?.budget?.dailyLimitMicros!=null?String(record.budget.dailyLimitMicros/1e6):'',unknownCostOk:!!record?.budget?.unknownCostOk,localOnly:!!record?.privacy?.localOnly,endpoints:(record?.privacy?.allowedEndpoints??[]).join('\n'),contextChars:String(record?.contextBudgetChars??'')});
/** Only edited preferences join the main workspace transaction. Null clears quiet hours on the wire. */
function preferencePatch(record:PersonalAssistantRecord|null,draft:PreferenceDraft):NonNullable<PersonalWorkspaceConfigure['settings']>{
 const base=preferenceDraft(record),patch:NonNullable<PersonalWorkspaceConfigure['settings']>={};
 if(draft.style!==base.style)patch.style=draft.style;
 if(draft.timezone!==base.timezone)patch.timezone=draft.timezone.trim();
 if(draft.quietStart!==base.quietStart||draft.quietEnd!==base.quietEnd){
  if(!!draft.quietStart!==!!draft.quietEnd)throw new Error('Set both quiet hours, or clear both to turn them off.');
  if(draft.quietStart&&![draft.quietStart,draft.quietEnd].every(value=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)))throw new Error('Quiet hours must use valid 24-hour times.');
  patch.quietHours=draft.quietStart?{start:draft.quietStart,end:draft.quietEnd}:null;
 }
 if(draft.dailyDollars!==base.dailyDollars||draft.unknownCostOk!==base.unknownCostOk){const dollars=draft.dailyDollars.trim()===''?undefined:Number(draft.dailyDollars);if(dollars!==undefined&&(!Number.isFinite(dollars)||dollars<0||!Number.isSafeInteger(Math.round(dollars*1e6))))throw new Error('Enter a valid daily limit in dollars, or leave it empty for none.');patch.budget={...(record?.budget??{}),dailyLimitMicros:dollars===undefined?undefined:Math.round(dollars*1e6),unknownCostOk:draft.unknownCostOk};}
 if(draft.localOnly!==base.localOnly||draft.endpoints!==base.endpoints)patch.privacy={...(record?.privacy??{}),localOnly:draft.localOnly,allowedEndpoints:draft.endpoints.split('\n').map(value=>value.trim()).filter(Boolean)};
 if(draft.contextChars!==base.contextChars){const count=Number(draft.contextChars);if(!Number.isSafeInteger(count)||count<=0)throw new Error('Context budget must be a positive whole number of characters.');patch.contextBudgetChars=count;}
 return patch;
}
type EditorProps = { backend:Backend; profiles:ParticipantConfig[]; disabledProviders?:string[]; lane?:PersonalLane; hostId:string; projects:Workspace[]; onCreate?:(input:AssistantCreation)=>Promise<AssistantRef|void>; onSaved?:(created?:AssistantRef)=>void; onCommitted?:()=>void;onArchived?:()=>void; onOpenMemory?:()=>void;onOpenBrowser?:()=>void; machinePicker?:ReactNode; machineName?:string;voiceSettings?:VoiceSettings;onVoiceSettings?:(settings:VoiceSettings)=>void };
/** A single editor for creation and Settings. The captured revision is retained after conflicts. */
export function AssistantEditor({backend,profiles,disabledProviders=[],lane,hostId,projects,onCreate,onSaved,onCommitted,onArchived,onOpenBrowser,machinePicker,machineName,voiceSettings,onVoiceSettings}:EditorProps) {
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
 const [avatarEpoch,setAvatarEpoch]=useState(0);
 const [hexValid,setHexValid]=useState(true);
 const [hostProfiles,setHostProfiles]=useState<ParticipantConfig[]>([]);
 const [profilesProblem,setProfilesProblem]=useState('Loading configured providers…');
 useEffect(()=>{let active=true;void backend.sessionLoad().then(session=>{if(active){setHostProfiles(session?.profiles ?? []);setProfilesProblem('');}}).catch(()=>{if(active)setProfilesProblem('Configured providers could not be loaded from this machine. Reconnect before saving.');});return()=>{active=false;};},[backend,profiles]);
 const configured=useMemo(()=>{
  const candidates=[...(savedBase?.profile?[savedBase.profile]:[]),...hostProfiles];
  const seen=new Set<string>();return candidates.filter(p=>{
   // Keep the choices aligned with the host's monitor_profile_ok contract.
   const supported=p.backend.kind==='open_ai_compatible'||(p.backend.kind==='agent'&&p.backend.tool==='claude_code');
   if(!supported||p.media!=null||!providerEnabled(providerForConfig(p),disabledProviders))return false;
   const b=p.backend;const key=b.kind==='agent'?b.tool:b.kind==='open_ai_compatible'?JSON.stringify([b.base_url,b.api_key_env]):'';
   if(seen.has(key))return false;seen.add(key);return true;
  });
 },[savedBase,hostProfiles,disabledProviders]);
 const [provider,setProvider]=useState(0);
 const providerChosen=useRef(false);
 const [providerIntent,setProviderIntent]=useState(0);
 const providerSelection=useRef(0);
 const discoveryHandoff=useRef<{backend:Backend;profile:ParticipantConfig;offered:ModelChoice[];note:string}|null>(null);
 const source=configured[provider];
 const sourceConnection=providerConnection(source);
 const [model,setModel]=useState(()=>original?.profile?.backend.kind==='agent'||original?.profile?.backend.kind==='open_ai_compatible'?original.profile.backend.model ?? '':'');
 const [effort,setEffort]=useState<string|null>(original?.profile?.effort ?? null);
 const [folder,setFolder]=useState('~/apex-assistant');
 const [firstBrief,setFirstBrief]=useState('');
 const [voiceDraft,setVoiceDraft]=useState<Partial<Pick<VoiceSettings,'defaultVoice'|'silenceMs'|'look'>>>({});
 const sharedVoiceSettings=voiceSettings??(onVoiceSettings?readVoiceSettings(undefined):undefined);
 const latestVoiceSettings=useRef(sharedVoiceSettings);latestVoiceSettings.current=sharedVoiceSettings;
 const voice=sharedVoiceSettings?{...sharedVoiceSettings,...voiceDraft}:undefined;
 const [pendingFullAccess,setPendingFullAccess]=useState(false);
 const [access,setAccess]=useState<ParticipantConfig['access']>(original?.profile?.access ?? 'ask');
 const changeAccess=(value:ParticipantConfig['access'])=>{if(value==='full'&&access!=='full'){setPendingFullAccess(true);return;}setPendingFullAccess(false);setAccess(value);setBindings(before=>before.map(binding=>({...binding,tools:toolsFor(value)})));};
 const toolsFor=(value:ParticipantConfig['access']):AssistantProjectBinding['tools']=>value==='full'?'full':value==='read'?'off':'ask';
 const [bindings,setBindings]=useState<AssistantProjectBinding[]>(()=>(original?.projects ?? []).map(binding=>original?.profile?.access==='read'?{...binding,tools:'off'}:binding));
 const [models,setModels]=useState<ModelChoice[]>([]);
 const [providerReady,setProviderReady]=useState(false);
 const [discovery,setDiscovery]=useState('Loading offered models…');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [pendingFolder,setPendingFolder]=useState<Workspace|null>(null);
 const [grantedProjectKeys,setGrantedProjectKeys]=useState<string[]>([]);
 const canGrantFolder=backend.supports?.('assistant_project_folder_grant_v1')===true;
 const hasFolderGrant=(project:Workspace)=>grantedProjectKeys.includes(projectIdentityKey({hostId,workspaceId:project.id,cwd:project.path}))||(savedBase?.allowedFolders??[]).some(folder=>{const root=folder.replace(/\/$/,'');const path=project.path.replace(/\/$/,'');return path===root||path.startsWith(`${root}/`);});
 const [browserOpen,setBrowserOpen]=useState(false);
 const [confirmArchive,setConfirmArchive]=useState(false);
 const unfinishedPersonal=(lane?.assistant?.tasks??[]).some(task=>!['done','failed','cancelled'].includes(task.status));
 const unfinishedSchedules=(lane?.assistant?.schedules??[]).some(schedule=>schedule.status!=='cancelled');
 const archiveBlocked=unfinishedPersonal||unfinishedSchedules;
 const archive=async()=>{if(!lane?.archiveAssistant||!original||busy||lane.offline||archiveBlocked)return;const token=lifetime.current;setBusy(true);setError('');try{await lane.archiveAssistant(expectedRevision!);onCommitted?.();if(lifetime.current===token)onArchived?.();}catch(error){if(lifetime.current===token){const message=error instanceof Error?error.message:String(error);setError(message);setConflict(/revision|changed|stale/i.test(message));}}finally{if(lifetime.current===token)setBusy(false);}};
 const [preferences,setPreferences]=useState(()=>preferenceDraft(original));
 const editPreferences=(patch:Partial<PreferenceDraft>)=>setPreferences(before=>({...before,...patch}));
 const [settingsView,setSettingsView]=useState<PanelName|null>(null);
 const [visitedViews,setVisitedViews]=useState<PanelName[]>([]);
 const openSettingsView=(view:PanelName)=>{setVisitedViews(before=>before.includes(view)?before:[...before,view]);setSettingsView(view);};
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
 },[backend,sourceConnection,configured.length,providerIntent]);
 const selected=models.find(m=>m.id===model);
 const folderPath=folder.trim();
 const folderProblem=!original&&(!folderPath||/[\x00-\x1f\x7f]/.test(folderPath)||!(folderPath.startsWith('/')||folderPath.startsWith('~/')||/^[A-Za-z]:[\\/]/.test(folderPath)||/^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/.test(folderPath)))?'Enter a full path or home-relative path (~/) on the selected machine.':'';
 let preferenceProblem='';try{preferencePatch(savedBase,preferences);}catch(error){preferenceProblem=error instanceof Error?error.message:String(error);}
 const invalid=preferenceProblem || folderProblem || profilesProblem || validateAssistantDraft({name,color:hexValid||appearance.kind==='image'?appearance.color:'invalid',profile:source,model:selected,effort,providerReady});
 const save=async()=>{
  if(invalid||!source||busy)return;const token=lifetime.current;setBusy(true);setError('');
  const profile=runtimeProfile({...savedBase?.profile??source,backend:source.backend},name,model,access,effort);
  try {
   let created:AssistantRef|void=undefined;
   if(original){
    if(!lane?.configureWorkspace)throw new Error('Update this machine’s service to save assistant workspace settings.');
    const configuration:PersonalWorkspaceConfigure={expectedRevision:expectedRevision!,settings:{...preferencePatch(savedBase,preferences),name:name.trim(),look:appearance},profile,projects:bindings,...(avatar?{avatar}:{})};
    const result=await lane.configureWorkspace(configuration);
    const committed=result??await backend.call<PersonalAssistantRecord>('personal_get',{assistantId:original.id});
    if(committed.id!==original.id||committed.hostId!==hostId||!Number.isSafeInteger(committed.revision)||committed.revision<=expectedRevision!)throw new Error('The saved assistant owner or revision could not be verified. Refresh before saving again.');
    if(lifetime.current===token)acceptSavedRecord(committed);
   } else {
    if(!onCreate)throw new Error('Creation is unavailable on this machine.');
    created=await onCreate({workspaceVersion:4,name:name.trim(),folder:folderPath,profile,look:appearance,projects:bindings,avatarDraftId:draftId,...(firstBrief.trim()?{firstBrief:firstBrief.trim()}:{}),...(avatar?.kind==='image'?{avatarGenerationId:avatar.generationId,avatarAssetId:avatar.assetId}:{})});
   }
   onCommitted?.();
   if(lifetime.current===token&&latestVoiceSettings.current&&Object.keys(voiceDraft).length)onVoiceSettings?.({...latestVoiceSettings.current,...voiceDraft});
   if(lifetime.current===token)setVoiceDraft({});
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
   if(lifetime.current===token){setExpectedRevision(current.revision);setSavedBase(current);setGrantedProjectKeys([]);setConflict(false);setError('Revision refreshed. Your draft is preserved; review it and Save to retry.');}
  }catch(e){if(lifetime.current===token)setError(e instanceof Error?e.message:String(e));}finally{if(lifetime.current===token)setBusy(false);}
 };
 const allowProjectFolder=async()=>{
  if(!original||!pendingFolder||busy||lane?.offline||!canGrantFolder)return;
  const token=lifetime.current;const project={hostId,workspaceId:pendingFolder.id,cwd:pendingFolder.path};
  const assertOwner=()=>{const status=backend.host?.connection.get().status;if(backend.host&&(status?.kind!=='connected'||status.hostId!==hostId))throw new Error('The assistant machine identity changed. Reconnect before allowing this folder.');};
  setBusy(true);setError('');
  try{
   assertOwner();
   const result=await backend.call<{assistant:PersonalAssistantRecord}>('personal_workspace_configure',{assistantId:original.id,expectedRevision:expectedRevision!,folderGrant:project});
   assertOwner();const current=result.assistant;
   if(current.id!==original.id||current.hostId!==hostId||!Number.isSafeInteger(current.revision)||current.revision<expectedRevision!||!Array.isArray(current.allowedFolders))throw new Error('The folder grant owner could not be verified. Refresh before saving.');
   onCommitted?.();
   if(lifetime.current===token){setSavedBase(current);setExpectedRevision(current.revision);setGrantedProjectKeys(before=>[...before,projectIdentityKey(project)]);setBindings(before=>before.some(b=>projectIdentityKey(b.project)===projectIdentityKey(project))?before:[...before,{project,tools:toolsFor(access)}]);setPendingFolder(null);setConflict(false);setError('Folder allowed and project switched on. Save changes to keep it. Your settings draft is preserved.');}
  }catch(e){if(lifetime.current===token){const message=e instanceof Error?e.message:String(e);setError(message);setConflict(/revision|conflict|stale|assistant changed.*refresh/i.test(message));}}finally{if(lifetime.current===token)setBusy(false);}
 };
 const api=useMemo(()=>createAssistantAvatarApi(backend),[backend]);
 const owner=original?{kind:'assistant' as const,assistant:ref}:{kind:'creation' as const,hostId,draftId};
 const draftImage=avatar?.kind==='image'?{owner,generationId:avatar.generationId}:undefined;

 const savedModel=savedBase?.profile?.backend.kind==='agent'||savedBase?.profile?.backend.kind==='open_ai_compatible'?savedBase.profile.backend.model ?? '':'';
 const changes:string[]=original?dirtyFields({name:savedBase?.name??original.name,model:savedModel,effort:savedBase?.profile?.effort??null,access:savedBase?.profile?.access??'ask',projects:(savedBase?.projects??[]).map(b=>projectIdentityKey(b.project)),look:assistantAppearance(ref,savedBase?.look)},{name,model,effort,access,projects:bindings.map(b=>projectIdentityKey(b.project)),look:appearance}):[];
 if(original&&providerConnection(source)!==providerConnection(savedBase?.profile))changes.push('Provider');
 if(original&&Object.keys(voiceDraft).some(key=>voiceDraft[key as keyof typeof voiceDraft]!==voiceSettings?.[key as keyof typeof voiceDraft]))changes.push('Voice');
 if(original&&JSON.stringify(preferences)!==JSON.stringify(preferenceDraft(savedBase)))changes.push('Preferences');
 const acceptSavedRecord=(current:PersonalAssistantRecord)=>{
  setSavedBase(current);setExpectedRevision(current.revision);setName(current.name);setAppearance(assistantAppearance(ref,current.look));setAvatar(undefined);setAvatarEpoch(before=>before+1);setHexValid(true);setPreferences(preferenceDraft(current));setAccess(current.profile?.access??'ask');setBindings((current.projects??[]).map(binding=>current.profile?.access==='read'?{...binding,tools:'off'}:binding));setModel(current.profile?.backend.kind==='agent'||current.profile?.backend.kind==='open_ai_compatible'?current.profile.backend.model??'':'');setEffort(current.profile?.effort??null);setPendingFolder(null);setGrantedProjectKeys([]);setConflict(false);setError('');providerChosen.current=true;if(provider!==0||providerConnection(current.profile)!==providerConnection(source)){providerSelection.current++;discoveryHandoff.current=null;setProviderIntent(before=>before+1);}setProvider(0);
 };
 // Header runtime saves and other host updates can refresh a clean editor that
 // remains mounted behind Chat. An edited draft retains its captured revision.
 useEffect(()=>{const current=lane?.assistant;if(!original||!current||busy||changes.length||current.id!==original.id||current.hostId!==hostId||current.revision<=expectedRevision!)return;acceptSavedRecord(current);},[lane?.assistant?.revision,busy,changes.length]);
 /** Put every field the save bar counts back to the last saved record. */
 const discard=()=>{
  if(!savedBase)return;
  setAvatarEpoch(before=>before+1);setHexValid(true);setVoiceDraft({});setPendingFullAccess(false);setPreferences(preferenceDraft(savedBase));setName(savedBase.name);setAppearance(assistantAppearance(ref,savedBase.look));setAvatar(undefined);
  const savedAccess=savedBase.profile?.access??'ask';setAccess(savedAccess);
  setBindings((savedBase.projects??[]).map(binding=>savedAccess==='read'?{...binding,tools:'off'}:binding));
  setModel(savedModel);setEffort(savedBase.profile?.effort??null);setPendingFolder(null);setError('');
  if(provider!==0){providerChosen.current=true;providerSelection.current++;discoveryHandoff.current=null;setProviderIntent(before=>before+1);setProvider(0);}
 };
 const fullAccessConfirmation=pendingFullAccess?<div className="assistant-folder-confirm" role="group" aria-label="Confirm Full access"><strong>Use Full access?</strong><p className="assistant-control-note">This allows project actions within already permitted folders. It does not grant additional folders or change approved tasks.</p><button type="button" disabled={busy} onClick={()=>{setAccess('full');setBindings(before=>before.map(binding=>({...binding,tools:'full'})));setPendingFullAccess(false);}}>Use Full access</button><button type="button" onClick={()=>setPendingFullAccess(false)}>Keep current access</button></div>:null;
 if(original) return <div className="assistant-editor assistant-editor-settings">
  <div className="assistant-settings-main" hidden={settingsView!==null}>
  <section className="assistant-settings-section"><h3>General</h3>
   <div className="assistant-general-row"><Avatar seed={appearance.seed} color={appearance.color} size="lg" image={appearance.kind==='image'?appearance.image:undefined} assistant={original?ref:undefined} avatarApi={api} draftImage={draftImage}/><label className="assistant-setting-row"><span>Name</span><input aria-label="Assistant name" value={name} maxLength={64} placeholder="Choose a name" autoComplete="off" onChange={e=>setName(e.target.value)}/></label></div>
   <details className="assistant-avatar-details"><summary>Change avatar</summary><AssistantAvatarEditor key={avatarEpoch} owner={owner} api={api} appearance={appearance} onAppearanceChange={next=>setAppearance(before=>({...before,...next}))} onApply={setAvatar} disabled={busy||lane?.offline} pixelControls={<HexColorPicker label="Avatar color" value={appearance.color} presets={AGENT_COLORS} onChange={color=>setAppearance(before=>({...before,color}))} onValidityChange={setHexValid}/>}/></details>
  </section>
  <section className="assistant-settings-section"><h3>Model</h3>
   {configured.length>1&&<label className="assistant-setting-row"><span>Provider</span><select aria-label="Assistant provider" value={provider} onChange={e=>{providerChosen.current=true;providerSelection.current++;setProviderIntent(before=>before+1);discoveryHandoff.current=null;setProvider(Number(e.target.value));setEffort(null);setModel('');}}>{!configured.length&&<option>No compatible configured providers</option>}{configured.map((p,i)=><option key={i} value={i}>{p.display_name} · {providerForConfig(p)}</option>)}</select></label>}
   <label className="assistant-setting-row"><span>Model</span><select aria-label="Assistant model" value={model} disabled={!providerReady} onChange={e=>{setModel(e.target.value);setEffort(before=>reconcileEffort(before,models.find(m=>m.id===e.target.value)));}}>{!models.length&&<option value="">No offered text models</option>}{models.map(m=><option key={m.id} value={m.id}>{m.label??m.id}</option>)}</select></label>
   <label className="assistant-setting-row"><span>Reasoning</span><select aria-label="Assistant reasoning" value={effort??''} disabled={!selected?.efforts?.length} onChange={e=>setEffort(e.target.value||null)}>{!selected?.efforts?.length&&<option value="">{selected?.efforts?'No reasoning setting':'Provider default'}</option>}{selected?.efforts?.map(level=><option key={level} value={level}>{level}</option>)}</select></label>{discovery&&<p className="assistant-control-note" role="status">{discovery}</p>}
  </section>
  <section className="assistant-settings-section"><h3>Projects &amp; access</h3><p className="assistant-control-note">Turning a project on lets {original.name} open that folder and run your agents there.</p>
   <label className="assistant-setting-row"><span>Project tools</span><select aria-label="Project tools" value={access} onChange={e=>changeAccess(e.target.value as ParticipantConfig['access'])}><option value="ask">Ask first</option><option value="full">Full access</option><option value="read">Read only</option>{access==='edits'&&<option value="edits">Allow edits (legacy)</option>}</select></label>{fullAccessConfirmation}
   {projects.map(project=>{const binding={hostId,workspaceId:project.id,cwd:project.path};const key=projectIdentityKey(binding);const checked=bindings.some(b=>projectIdentityKey(b.project)===key);const changedFolder=!checked&&bindings.some(b=>b.project.hostId===hostId&&b.project.workspaceId===project.id);const granted=hasFolderGrant(project);return <div className="assistant-project-access" key={key}><label className="assistant-setting-row assistant-project-choice"><span>{project.name}<small className="assistant-project-path">{project.path}</small>{changedFolder&&<small role="status">The assigned folder could not be verified. Refresh or reconnect its machine; the saved assignment is retained.</small>}{!checked&&!changedFolder&&!granted&&!canGrantFolder&&<small>Update this machine’s service, then reconnect to allow this project folder.</small>}</span><input aria-label={`Use ${project.name}`} type="checkbox" role="switch" className="assistant-switch" checked={checked} disabled={busy||changedFolder||(!checked&&!granted&&(!canGrantFolder||!!lane?.offline))} onChange={e=>{if(e.target.checked&&!granted){setPendingFolder(project);return;}setBindings(before=>e.target.checked?(before.some(b=>projectIdentityKey(b.project)===key)?before:[...before,{project:binding,tools:toolsFor(access)}]):before.filter(b=>projectIdentityKey(b.project)!==key));}}/></label></div>;})}{pendingFolder&&<div className="assistant-folder-confirm" role="group" aria-label="Confirm project folder access"><strong>Allow {original.name} to access this folder and its subfolders?</strong><code>{pendingFolder.path}</code><p className="assistant-control-note">This permission saves immediately. Project tools still follow the access setting above.</p><button type="button" disabled={busy||lane?.offline} onClick={allowProjectFolder}>Allow this folder</button><button type="button" disabled={busy} onClick={()=>setPendingFolder(null)}>Cancel</button></div>}{!projects.length&&<p className="assistant-control-note">No projects on this machine.</p>}
   <div className="assistant-setting-row"><span>Browser<small>Open this assistant’s browser for a requested task</small></span>{lane?.browserView?<button type="button" disabled={busy||lane.offline} onClick={()=>onOpenBrowser?onOpenBrowser():setBrowserOpen(true)}>Open browser / Take over</button>:<span className="assistant-setting-value">After Create</span>}</div><p className="assistant-control-note">{browserStatus}</p>
  </section>
  <section className="assistant-settings-section"><h3>Preferences</h3>
   <label className="assistant-preference-field"><span>Reply style</span><textarea aria-label="Reply style" rows={3} value={preferences.style} onChange={event=>editPreferences({style:event.target.value})}/></label>
   <label className="assistant-setting-row"><span>Timezone</span><input aria-label="Timezone" placeholder="America/Los_Angeles" value={preferences.timezone} onChange={event=>editPreferences({timezone:event.target.value})}/></label>
   <label className="assistant-setting-row"><span>Quiet hours start</span><input type="time" aria-label="Quiet hours start" value={preferences.quietStart} onChange={event=>editPreferences({quietStart:event.target.value})}/></label>
   <label className="assistant-setting-row"><span>Quiet hours end</span><input type="time" aria-label="Quiet hours end" value={preferences.quietEnd} onChange={event=>editPreferences({quietEnd:event.target.value})}/></label>
  </section>
  <section className="assistant-settings-section"><h3>Costs &amp; privacy</h3>
   <label className="assistant-setting-row"><span>Daily spend limit<small>Dollars; leave empty for none</small></span><input type="number" min="0" step="0.01" aria-label="Daily spend limit" value={preferences.dailyDollars} onChange={event=>editPreferences({dailyDollars:event.target.value})}/></label>
   <label className="assistant-setting-row"><span>Allow replies whose cost isn't reported</span><input type="checkbox" aria-label="Allow unknown reply costs" checked={preferences.unknownCostOk} onChange={event=>editPreferences({unknownCostOk:event.target.checked})}/></label>
   <label className="assistant-setting-row"><span>Local only<small>No cloud model or network tools</small></span><input type="checkbox" aria-label="Local only" checked={preferences.localOnly} onChange={event=>editPreferences({localOnly:event.target.checked})}/></label>
   <label className="assistant-preference-field"><span>Allowed model endpoints<small>One per line</small></span><textarea aria-label="Allowed model endpoints" rows={3} value={preferences.endpoints} onChange={event=>editPreferences({endpoints:event.target.value})}/></label>
   <label className="assistant-setting-row"><span>Context budget<small>Characters</small></span><input type="number" min="1" step="1" aria-label="Context budget" value={preferences.contextChars} onChange={event=>editPreferences({contextChars:event.target.value})}/></label>
   <p className="assistant-control-note">Your conversation is stored on {lane?.hostName??hostId}. Each reply sends its context to the selected model provider.</p>
   <button type="button" className="assistant-settings-link" onClick={()=>openSettingsView('costs')}><span>Costs &amp; privacy<small>Reported, estimated and unknown cost history</small></span><span aria-hidden="true">›</span></button>
  </section>
  <section className="assistant-settings-section"><h3>Voice</h3><p className="assistant-control-note">Shared defaults for regular chat and assistant calls. Call-time voice overrides stay with their chat. Save changes to apply these app-wide defaults.</p>{voice&&onVoiceSettings?<>
   <div className="assistant-setting-row"><span>Voice for calls</span><span className="voice-pick"><select aria-label="Voice for calls" value={defaultVoiceOf(voice)} onChange={event=>setVoiceDraft(before=>({...before,defaultVoice:event.target.value}))}>{[...new Set([defaultVoiceOf(voice),...CALL_VOICES])].map(value=><option key={value} value={value}>{voiceLabel(value)}</option>)}</select><VoiceSampleButton voice={defaultVoiceOf(voice)}/></span></div>
   <label className="assistant-setting-row"><span>Pause before reply<small>{voice.silenceMs} ms · applies next call</small></span><input type="range" min="100" max="2000" step="50" aria-label="Pause before reply" value={voice.silenceMs} onChange={event=>setVoiceDraft(before=>({...before,silenceMs:Number(event.target.value)}))}/></label>
   <label className="assistant-setting-row"><span>Call controls</span><select aria-label="Call controls" value={voice.look} onChange={event=>setVoiceDraft(before=>({...before,look:event.target.value as VoiceSettings['look']}))}>{CALL_LOOKS.map(look=><option key={look.id} value={look.id}>{look.label}</option>)}</select></label>
  </>:<p className="assistant-control-note">Shared voice preferences are available in app Settings. Calls use those saved defaults.</p>}</section>
  <section className="assistant-settings-section"><h3>Memory</h3><button type="button" className="assistant-settings-link" onClick={()=>openSettingsView('memory')}><span>Personal notes<small>Private to {original.name} · project notebooks</small></span><span aria-hidden="true">›</span></button></section>
  <section className="assistant-settings-section"><h3>Tools &amp; rules</h3><p className="assistant-control-note">Connections, action modes, standing rules, memory, schedules and notices save through their own explicit actions.</p><nav className="assistant-tools-nav" aria-label="Assistant tools"><button type="button" onClick={()=>openSettingsView('connections')}>Connections</button><button type="button" onClick={()=>openSettingsView('rules')}>Rules</button><button type="button" onClick={()=>openSettingsView('scheduled')}>Schedules</button><button type="button" onClick={()=>openSettingsView('notices')}>Notices</button></nav></section>
  <section className="assistant-settings-section"><h3>Remove assistant</h3><p className="assistant-control-note">Remove {original.name} from your team. History, notes and projects are retained. Restore it from Archived assistants in Add teammate; restored assistants stay paused until you resume them.</p>{archiveBlocked&&<p className="assistant-control-note" role="status">Cancel unfinished tasks and schedules first, then wait for their final results before removing this assistant.</p>}{!lane?.archiveAssistant&&<p className="assistant-control-note">Update this machine’s service to remove and restore assistants.</p>}<button type="button" disabled={busy||lane?.offline||archiveBlocked||!lane?.archiveAssistant} onClick={()=>setConfirmArchive(true)}>Remove assistant</button>{confirmArchive&&<div className="assistant-folder-confirm" role="group" aria-label="Confirm assistant removal"><strong>Remove {original.name} and keep its history?</strong><p className="assistant-control-note">The owning machine checks that all work has stopped before saving removal. Unsaved settings are discarded. You can restore this same assistant later.</p><button type="button" disabled={busy||lane?.offline||archiveBlocked} onClick={archive}>Remove and keep history</button><button type="button" disabled={busy} onClick={()=>setConfirmArchive(false)}>Keep assistant</button></div>}</section>
  </div>
  {visitedViews.map(view=><section key={view} className="assistant-settings-subview" hidden={settingsView!==view}><button type="button" onClick={()=>setSettingsView(null)}>‹ Settings</button><h3>{{memory:'Memory',costs:'Costs & privacy',scheduled:'Schedules',notices:'Notices',connections:'Connections',rules:'Rules',activity:'Activity',settings:'Settings'}[view]}</h3><p className="assistant-control-note">Your settings draft is preserved. Actions in this view save separately.</p><PersonalPanels lane={lane!} initial={view} onOpenBrowser={onOpenBrowser} onClose={()=>setSettingsView(null)} embedded/></section>)}
  {error&&<p role="alert">{error}</p>}{conflict&&<button type="button" disabled={busy||lane?.offline} onClick={refreshRevision}>Refresh revision, keep draft</button>}{invalid&&<p className="assistant-control-note" role="status">{invalid}</p>}
  <form className="assistant-editor-save" onSubmit={e=>{e.preventDefault();void save();}}><p className="assistant-save-summary">{changes.length?`${changes.length} unsaved ${changes.length===1?'change':'changes'} · ${changes.join(', ')}`:'No unsaved changes'}</p><button type="button" disabled={busy||!changes.length} onClick={discard}>Discard</button><button type="submit" className="primary" disabled={busy||!!invalid||lane?.offline}>{busy?'Saving…':'Save changes'}</button></form>
  {browserOpen&&lane?.browserView&&<PersonalBrowser lane={lane} onClose={()=>setBrowserOpen(false)}/>}
 </div>;
 return <div className="assistant-editor assistant-editor-create">
  <div className="assistant-create-identity"><div className="assistant-create-avatar"><Avatar seed={appearance.seed} color={appearance.color} size="lg" image={appearance.kind==='image'?appearance.image:undefined} assistant={original?ref:undefined} avatarApi={api} draftImage={draftImage}/><button type="button" className="assistant-shuffle" aria-label="New avatar pattern" disabled={busy} onClick={()=>setAppearance(before=>({...before,seed:createAssistantAppearance().seed,kind:'pixel',image:undefined}))}>↻ Shuffle</button></div><label className="assistant-setting-row"><span>Name</span><input aria-label="Assistant name" value={name} maxLength={64} placeholder="Choose a name" autoComplete="off" onChange={e=>setName(e.target.value)}/></label></div>
  <details className="assistant-avatar-details"><summary>Customize avatar</summary><AssistantAvatarEditor key={avatarEpoch} owner={owner} api={api} appearance={appearance} onAppearanceChange={next=>setAppearance(before=>({...before,...next}))} onApply={setAvatar} disabled={busy} pixelControls={<HexColorPicker label="Avatar color" value={appearance.color} presets={AGENT_COLORS} onChange={color=>setAppearance(before=>({...before,color}))} onValidityChange={setHexValid}/>}/></details>
  <div className="assistant-create-model">{configured.length>1&&<label className="assistant-setting-row"><span>Provider</span><select aria-label="Assistant provider" value={provider} onChange={e=>{providerChosen.current=true;providerSelection.current++;setProviderIntent(before=>before+1);discoveryHandoff.current=null;setProvider(Number(e.target.value));setEffort(null);setModel('');}}>{!configured.length&&<option>No compatible configured providers</option>}{configured.map((p,i)=><option key={i} value={i}>{p.display_name} · {providerForConfig(p)}</option>)}</select></label>}<label className="assistant-setting-row"><span>Model</span><select aria-label="Assistant model" value={model} disabled={!providerReady} onChange={e=>{setModel(e.target.value);setEffort(before=>reconcileEffort(before,models.find(m=>m.id===e.target.value)));}}>{!models.length&&<option value="">No offered text models</option>}{models.map(m=><option key={m.id} value={m.id}>{m.label??m.id}</option>)}</select></label><label className="assistant-setting-row"><span>Reasoning</span><select aria-label="Assistant reasoning" value={effort??''} disabled={!selected?.efforts?.length} onChange={e=>setEffort(e.target.value||null)}>{!selected?.efforts?.length&&<option value="">{selected?.efforts?'No reasoning setting':'Provider default'}</option>}{selected?.efforts?.map(level=><option key={level} value={level}>{level}</option>)}</select></label>{discovery&&<p className="assistant-control-note" role="status">{discovery}</p>}</div>
  <label className="assistant-setting-row"><span>In those projects it may</span><select aria-label="Project tools" value={access} onChange={e=>changeAccess(e.target.value as ParticipantConfig['access'])}><option value="ask">Ask first</option><option value="full">Full access</option><option value="read">Read only</option>{access==='edits'&&<option value="edits">Allow edits (legacy)</option>}</select></label>{fullAccessConfirmation}
  <label className="assistant-setting-row assistant-first-brief"><span>First brief <small>· optional</small></span><textarea aria-label="First brief" rows={3} maxLength={4000} value={firstBrief} placeholder="e.g. Run the test suite every morning and tell me what broke." onChange={e=>setFirstBrief(e.target.value)}/></label>
  <p className="assistant-control-note">Added to its chat, ready to send.</p>
  <p className="assistant-create-summary" role="status">Machine: {machineName??lane?.hostName??hostId} · Folder: {folderPath||'Choose a folder'} · {access==='full'?'Full access':access==='read'?'Read only':'Ask first'}</p>
  <p className="assistant-control-note">Connect existing projects in Settings after creation. Each additional folder requires its own permission.</p>
  <details className="assistant-more-options" open={!!folderProblem}><summary>More options</summary>{machinePicker}<label className="assistant-setting-row"><span>Folder</span><input aria-label="Allowed project folder" aria-describedby="assistant-folder-scope" value={folder} disabled={busy} onChange={e=>setFolder(e.target.value)}/></label><p id="assistant-folder-scope" className="assistant-control-note">Choose a full path or ~/ on the selected machine. Create grants access to this folder and its subfolders. Full access controls project actions within this boundary.</p><p className="assistant-control-note">{browserStatus}</p></details>
  {error&&<p role="alert">{error}</p>}{conflict&&<button type="button" disabled={busy||lane?.offline} onClick={refreshRevision}>Refresh revision, keep draft</button>}{invalid&&<p className="assistant-control-note" role="status">{invalid}</p>}<form className="assistant-editor-save" onSubmit={e=>{e.preventDefault();void save();}}><button type="submit" className="primary" disabled={busy||!!invalid}>{busy?'Adding…':'Add teammate'}</button></form>
  {browserOpen&&lane?.browserView&&<PersonalBrowser lane={lane} onClose={()=>setBrowserOpen(false)}/>}
 </div>;
}
