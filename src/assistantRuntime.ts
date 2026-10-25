import type { Backend } from './backend.ts';
import type { AgentTool, ModelChoice, ParticipantConfig } from './types.ts';
import type { PersonalAssistantRecord, PersonalLane } from './personalAssistant.ts';
import { supportsSpeed } from './speed.ts';

export function assistantRuntimeUsage(record: Pick<PersonalAssistantRecord, 'costs' | 'contextBudgetChars'>) {
  const costs = record.costs ?? [];
  const reported = costs.filter(entry => entry.inputTokens != null || entry.outputTokens != null);
  const sum = (key: 'inputTokens' | 'outputTokens') => reported.some(entry => entry[key] != null) ? reported.reduce((total, entry) => total + (entry[key] ?? 0), 0).toLocaleString('en-US') : 'unavailable';
  const incomplete = costs.some(entry => entry.inputTokens == null || entry.outputTokens == null);
  return {
    tokens: reported.length ? `Saved assistant history across providers (partial): ${sum('inputTokens')} in · ${sum('outputTokens')} out${incomplete ? ' · other usage unavailable' : ''}` : 'Saved assistant history: token usage unavailable',
    context: `Context usage unavailable${record.contextBudgetChars != null ? ` · ${record.contextBudgetChars.toLocaleString('en-US')} character budget` : ''}`,
    resets: 'Provider usage and reset times unavailable',
  };
}

export function assistantProviderProfile(current: ParticipantConfig, selected: ParticipantConfig, offered: ModelChoice[]): ParticipantConfig {
  if (selected.backend.kind !== 'agent' && selected.backend.kind !== 'open_ai_compatible') throw new Error('Choose a configured text provider.');
  const backend = { ...selected.backend };
  const model = offered.find(item => item.id === backend.model) ?? offered[0];
  if (!model) throw new Error('No offered text models are available.');
  if (backend.kind === 'agent') backend.model = model.id || null; else backend.model = model.id;
  const effort = model.efforts?.includes(current.effort ?? '') ? current.effort : model.efforts?.[0] ?? null;
  return { ...current, backend, effort, speed: supportsSpeed(backend) ? current.speed : null };
}

/** One opened popover owns a saved assistant revision. A conflict never silently rebases it. */
export function createAssistantRuntimeSession(lane: PersonalLane, backend: Pick<Backend, 'call'>) {
  if (!lane.assistant?.profile) throw new Error('Open Settings to configure a text runtime.');
  let snapshot = structuredClone(lane.assistant);
  const owner = { hostId: lane.assistant.hostId, assistantId: lane.assistant.id };
  let busy = false;
  let needsRefresh = false;
  const loadCurrent = async () => {
    if (needsRefresh) throw new Error('Runtime saved, but its revision could not be verified. Close and reopen this control before making another change.');
    return structuredClone(snapshot.profile!);
  };
  const save = async (next: ParticipantConfig, base: ParticipantConfig) => {
    if (lane.offline) throw new Error('Reconnect this assistant’s machine before changing its runtime.');
    if (!lane.configureWorkspace) throw new Error('Update this host to change assistant runtime settings.');
    if (busy) throw new Error('Wait for the current runtime change to finish.');
    if (needsRefresh) await loadCurrent();
    if (base.id !== snapshot.profile!.id || next.id !== base.id || JSON.stringify(base) !== JSON.stringify(snapshot.profile)) throw new Error('The assistant runtime changed. Close and reopen this control before saving.');
    const profile = { ...structuredClone(next), id: snapshot.profile!.id, display_name: snapshot.name };
    busy = true;
    try {
      await lane.configureWorkspace({ expectedRevision: snapshot.revision, profile });
      // Until read-back succeeds the old revision must never be reused for another save.
      needsRefresh = true;
      const current = await backend.call<PersonalAssistantRecord>('personal_get', { assistantId: owner.assistantId });
      if (current.id !== owner.assistantId || current.hostId !== owner.hostId) throw new Error('The host returned a different assistant while verifying the runtime.');
      if (!current.profile || current.revision <= snapshot.revision) throw new Error('The saved runtime revision could not be verified. Close and reopen this control.');
      snapshot = structuredClone(current);
      needsRefresh = false;
      return structuredClone(snapshot.profile!);
    } finally { busy = false; }
  };
  return { loadCurrent, save };
}

/** Capability discovery stays on the owning machine. It does not verify a CLI's sign-in. */
export async function assistantRuntimeModels(backend: Pick<Backend, 'detectAgents' | 'agentModels' | 'apiKeyStatus' | 'apiModels'> & Partial<Pick<Backend,'supports'>>, profile: ParticipantConfig): Promise<ModelChoice[]> {
  const provider = profile.backend;
  let models: ModelChoice[];
  if (provider.kind === 'agent') {
    if (provider.tool !== 'claude_code' && backend.supports?.('assistant_provider_conversations_v1') === false) throw new Error('Update this assistant’s machine to use its other connected providers.');
    const installed=(await backend.detectAgents()).find(agent => agent.key === provider.tool || (provider.tool === 'claude_code' && agent.key === 'claude'));
    if (!installed?.found) throw new Error(`${provider.tool} is not installed on this machine. Connect it in Settings or choose another provider.`);
    if (provider.tool === 'gemini' && (installed.assistantProgram ?? installed.program) && (installed.assistantProgram ?? installed.program) !== 'gemini') throw new Error('Antigravity uses a shared background service. Assistant conversation requires the isolated Gemini CLI on this machine; your Antigravity provider remains available in Threads.');
    const nativeGemini = provider.tool === 'gemini' && installed.assistantProgram === 'gemini' && installed.program !== 'gemini';
    models = nativeGemini ? [] : await backend.agentModels(provider.tool);
    if (!models.length) {
      if (provider.model && !nativeGemini) return [{id:provider.model,label:`${provider.model} (configured model)`,efforts:profile.effort?[profile.effort]:[],note:'This CLI does not expose a model catalog. Account availability is checked when it replies.'},{id:'',label:'Provider default',efforts:[]}];
      return [{id:'',label:'Provider default',efforts:[]}];
    }
  } else if (provider.kind === 'open_ai_compatible') {
    if (provider.api_key_env) {
      const [status] = await backend.apiKeyStatus([provider.api_key_env]);
      if (!status || status === 'missing') throw new Error('This provider’s credential is missing on this host. Open Settings to connect it.');
    }
    models = (await backend.apiModels(provider.base_url, provider.api_key_env)).filter(model => !model.kind || model.kind === 'text');
  } else throw new Error('Open Settings to choose a compatible text provider.');
  if (!models.length) throw new Error('No offered text models are available. Check the provider connection in Settings.');
  return models;
}

/** Provider credentials/configurations belong to the assistant's machine, not
 * the currently selected desktop project or local reusable agent catalog. */
export const ASSISTANT_AGENT_TOOLS: readonly AgentTool[] = ['claude_code','codex','gemini','grok','muse'];
export function assistantTextProvider(profile: ParticipantConfig): boolean {
 return !profile.media && (profile.backend.kind==='open_ai_compatible'||profile.backend.kind==='agent'&&ASSISTANT_AGENT_TOOLS.includes(profile.backend.tool));
}
export async function loadAssistantRuntimeProviders(backend: Pick<Backend,'sessionLoad'> & Partial<Pick<Backend,'detectAgents'>>): Promise<ParticipantConfig[]> {
 const [session, detected]=await Promise.all([backend.sessionLoad(),backend.detectAgents?.().catch(()=>[])??Promise.resolve([])]);
 const profiles=(session?.profiles??[]).filter(assistantTextProvider);
 for(const agent of detected){
  const tool=(agent.key==='claude'?'claude_code':agent.key) as AgentTool;
  if(!ASSISTANT_AGENT_TOOLS.includes(tool)||profiles.some(p=>p.backend.kind==='agent'&&p.backend.tool===tool))continue;
  // Same host discovery/model adapters as Threads; never copy an unrelated room's credentials.
  profiles.push({id:`assistant-provider-${tool}`,display_name:agent.label,persona:'',access:'ask',effort:null,backend:{kind:'agent',tool,model:null}});
 }
 return profiles;
}
