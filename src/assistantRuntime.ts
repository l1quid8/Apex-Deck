import type { Backend } from './backend.ts';
import type { ModelChoice, ParticipantConfig } from './types.ts';
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
  backend.model = model.id;
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
export async function assistantRuntimeModels(backend: Pick<Backend, 'detectAgents' | 'agentModels' | 'apiKeyStatus' | 'apiModels'>, profile: ParticipantConfig): Promise<ModelChoice[]> {
  const provider = profile.backend;
  let models: ModelChoice[];
  if (provider.kind === 'agent') {
    if(provider.tool!=='claude_code')throw new Error('This agent does not support assistant replies. Choose a supported provider in Settings.');
    if (!(await backend.detectAgents()).some(agent => (agent.key === provider.tool || (provider.tool === 'claude_code' && agent.key === 'claude')) && agent.found)) throw new Error(`${provider.tool} is not installed on this machine. Open Settings to choose another provider.`);
    models = await backend.agentModels(provider.tool);
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
export async function loadAssistantRuntimeProviders(backend: Pick<Backend,'sessionLoad'>): Promise<ParticipantConfig[]> {
 const session=await backend.sessionLoad();
 return (session?.profiles??[]).filter(p=>!p.media&&(p.backend.kind==='open_ai_compatible'||p.backend.kind==='agent'&&p.backend.tool==='claude_code'));
}
