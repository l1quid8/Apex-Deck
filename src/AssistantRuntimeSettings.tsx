import { useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from './backend.ts';
import type { PersonalLane } from './personalAssistant.ts';
import type { ModelChoice, ParticipantConfig } from './types.ts';
import { BotSettings } from './BotSettings.tsx';
import { providerForConfig } from './providers.ts';
import { assistantProviderProfile, assistantRuntimeModels, assistantRuntimeUsage, createAssistantRuntimeSession, loadAssistantRuntimeProviders } from './assistantRuntime.ts';
import './assistant-runtime.css';

type Props = { lane: PersonalLane; backend: Backend; anchor?: HTMLElement | null; inline?: boolean; profiles?: ParticipantConfig[]; close: () => void; onSettings: () => void };
type Confirmation = { resolve: () => void; reject: (cause: Error) => void };

/** Assistant runtime changes are saved on the assistant, never on a reusable bot or room. */
export function AssistantRuntimeSettings({ lane, backend, anchor = null, inline = false, close, onSettings }: Props) {
  const record = lane.assistant!;
  const session = useMemo(() => createAssistantRuntimeSession(lane, backend), [backend, record.hostId, record.id]);
  const [config, setConfig] = useState(() => structuredClone(record.profile!));
  const [checking, setChecking] = useState(true);
  const [offeredModels, setOfferedModels] = useState<ModelChoice[]>([]);
  const [reason, setReason] = useState('Checking this machine’s runtime capabilities…');
  const [providerBusy, setProviderBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationRef = useRef<Confirmation | null>(null);
  const mounted = useRef(true);
  const providerOperation = useRef(false);
  const providerKey = (profile: ParticipantConfig) => {
    const b = profile.backend;
    return b.kind === 'agent' ? JSON.stringify([b.kind, b.tool]) : b.kind === 'open_ai_compatible' ? JSON.stringify([b.kind, b.base_url, b.api_key_env]) : b.kind;
  };
  const [hostProfiles,setHostProfiles]=useState<ParticipantConfig[]>([]);
  useEffect(()=>{let active=true;void loadAssistantRuntimeProviders(backend).then(rows=>{if(active)setHostProfiles(rows);},cause=>{if(active)setError('Configured providers could not be loaded from this machine: '+String(cause));});return()=>{active=false;};},[backend]);
  const seenProviders = new Set<string>();
  const providers = hostProfiles.filter(profile => {
    if (profile.backend.kind !== 'agent' && profile.backend.kind !== 'open_ai_compatible') return false;
    const key = providerKey(profile);
    if (seenProviders.has(key)) return false;
    seenProviders.add(key); return true;
  });
  const currentProvider = providerKey(config);
  const selected = providers.findIndex(profile => providerKey(profile) === currentProvider);
  const meters = assistantRuntimeUsage(record);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; confirmationRef.current?.reject(new Error('Runtime settings closed before Full access was confirmed.')); confirmationRef.current = null; };
  }, []);
  useEffect(() => {
    let active = true;
    setChecking(true); setOfferedModels([]); setReason('Checking this machine’s runtime capabilities…');
    if (lane.offline) { setChecking(false); setReason('Reconnect the owning machine before changing this runtime.'); return; }
    if (!lane.configureWorkspace) { setChecking(false); setReason('Update this host to change assistant runtime settings.'); return; }
    void assistantRuntimeModels(backend, config).then(models => { if (active) { setOfferedModels(models); setReason(''); setChecking(false); } }, cause => { if (active) { setReason(cause instanceof Error ? cause.message : String(cause)); setChecking(false); } });
    return () => { active = false; };
  }, [backend, currentProvider, lane.offline, !!lane.configureWorkspace]);

  const save = async (next: ParticipantConfig, base: ParticipantConfig) => {
    if (lane.offline || !lane.configureWorkspace) throw new Error(reason || 'This assistant’s runtime cannot be changed on this host.');
    if(next.backend.kind==='agent'&&next.backend.model==='')next={...next,backend:{...next.backend,model:null}};
    const offered = await assistantRuntimeModels(backend, next);
    const modelId = 'model' in next.backend ? next.backend.model ?? '' : undefined;
    const model = offered.find(model => model.id === modelId);
    if (!model) throw new Error('Choose an offered text model from this provider.');
    if (next.effort && model.efforts && !model.efforts.includes(next.effort)) throw new Error('Choose a reasoning level supported by this model.');
    if (next.access === 'full' && base.access !== 'full') {
      await new Promise<void>((resolve, reject) => {
        const pending = { resolve, reject };
        confirmationRef.current = pending;
        setConfirmation(pending);
      });
    }
    if (!mounted.current) throw new Error('Runtime settings closed before this change was saved.');
    const saved = await session.save(next, base);
    if (mounted.current) setConfig(saved);
  };
  const switchProvider = async (index: number) => {
    if (providerOperation.current || !providers[index]) return;
    providerOperation.current = true; setProviderBusy(true); setError('');
    try {
      const base = await session.loadCurrent();
      const offered = await assistantRuntimeModels(backend, providers[index]);
      if (!mounted.current) return;
      await save(assistantProviderProfile(base, providers[index], offered), base);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { providerOperation.current = false; if (mounted.current) setProviderBusy(false); }
  };
  const confirm = (accept: boolean) => {
    const pending = confirmationRef.current;
    confirmationRef.current = null; setConfirmation(null);
    if (accept) pending?.resolve(); else pending?.reject(new Error('Full access was not changed.'));
  };
  const provider = <div className="assistant-runtime-provider">
    <label>Provider<select aria-label="Assistant runtime provider" disabled={checking || providerBusy || lane.offline || !lane.configureWorkspace || !!confirmation} value={selected} onChange={event => void switchProvider(Number(event.target.value))}>
      {selected < 0 && <option value={-1}>{providerForConfig(config)} (saved runtime)</option>}
      {providers.map((profile, index) => <option key={profile.id} value={index}>{profile.display_name} · {providerForConfig(profile)}</option>)}
    </select></label>
    <button type="button" onClick={() => { close(); onSettings(); }}>Full Settings</button>
    {config.backend.kind === 'agent' && !reason && <p className="muted">CLI installation found. Sign-in cannot be verified here; offered models may come from its cache.</p>}
    {error && <p role="alert" className="danger-text">{error}</p>}
    {confirmation && <div className="assistant-runtime-confirm" role="group" aria-label="Confirm Full access">
      <p>Allow Full access within existing folder grants? This does not grant any new folders.</p>
      {record.allowedFolders?.length ? <ul>{record.allowedFolders.map(folder => <li key={folder}>{folder}</li>)}</ul> : <p>No folders are granted. Assign projects through Settings.</p>}
      <button type="button" onClick={() => confirm(true)}>Use Full access</button><button type="button" onClick={() => confirm(false)}>Keep current access</button>
    </div>}
  </div>;
  return <BotSettings key={currentProvider} config={config} anchor={anchor} inline={inline} backend={backend} loadCurrent={session.loadCurrent} save={save} close={close} provider={provider}
    disabledReason={providerBusy ? 'Saving provider…' : confirmation ? 'Confirm Full access above before applying this change.' : reason || undefined} textOnly allowManualModel={false} allowDefaultModel={offeredModels.some(model=>model.id==='')} offeredModels={offeredModels}
    meters={<span className="assistant-runtime-meters"><span>{meters.context}</span><span>{meters.tokens}</span></span>}
    resets={<div className="assistant-runtime-resets"><p className="muted">{meters.resets}</p><button type="button" disabled title="This assistant host does not expose conversation compaction.">Compact unavailable</button><button type="button" disabled title="This assistant host does not expose conversation reset.">Reset unavailable</button></div>} />;
}
