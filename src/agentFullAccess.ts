import type { Backend } from './backend';
import type { ParticipantConfig } from './types';

export const FULL_ACCESS_CONFIRMATION = 'Full access allows this agent to execute commands and code written by other agents within its allowed folders on this machine. This applies across threads and worktrees and survives restarts. It does not grant additional folders. Restricted access restores its normal checks. You can revoke this approval in agent settings.';

export async function confirmAgentFullAccess(
  backend: Backend,
  agent: Pick<ParticipantConfig, 'id' | 'display_name' | 'access'>,
  confirm: (message: string) => boolean = message => window.confirm(message),
  previousAccess?: ParticipantConfig['access'],
): Promise<void> {
  if (agent.access !== 'full') return;
  if (!backend.supports?.('agent_full_access_v1')) {
    if (previousAccess === 'full') return;
    throw new Error('Update this machine’s Apex Deck service to confirm agent-wide Full access.');
  }
  const status = await backend.call<{ approved: boolean }>('agent_full_access', { agent: agent.id });
  if (status.approved) return;
  const machine = backend.host?.name ?? 'this machine';
  if (!confirm(`Confirm Full access for ${agent.display_name} on ${machine}?\n\n${FULL_ACCESS_CONFIRMATION}`)) {
    throw new Error('Full access was not confirmed.');
  }
  const saved = await backend.call<{ approved: boolean }>('agent_full_access', { agent: agent.id, confirm: true });
  if (!saved.approved) throw new Error('The machine did not save the Full access confirmation.');
}

/** Creation must save a legacy copied identity before granting it on a new host.
 * Consent comes first; a failed grant leaves the created agent visible in settings.
 */
export async function addWithAgentFullAccess(
  backend: Backend,
  agent: Pick<ParticipantConfig, 'id' | 'display_name' | 'access'>,
  add: () => Promise<unknown>,
  confirm: (message: string) => boolean = message => window.confirm(message),
): Promise<string | undefined> {
  return addWithAgentsFullAccess(backend, [agent], add, confirm);
}

export async function addWithAgentsFullAccess<T>(
  backend: Backend,
  agents: ReadonlyArray<Pick<ParticipantConfig, 'id' | 'display_name' | 'access'>>,
  add: () => Promise<T>,
  confirm: (message: string) => boolean = message => window.confirm(message),
): Promise<string | undefined> {
  const grants = [];
  for (const agent of agents) {
    if (agent.access !== 'full') continue;
    if (!backend.supports?.('agent_full_access_v1')) throw new Error('Update this machine’s Apex Deck service to confirm agent-wide Full access.');
    const status = await backend.call<{ approved: boolean }>('agent_full_access', { agent: agent.id });
    if (!status.approved) {
      if (!confirm(`Confirm Full access for ${agent.display_name} on ${backend.host?.name ?? 'this machine'}?\n\n${FULL_ACCESS_CONFIRMATION}`)) throw new Error('Full access was not confirmed.');
      grants.push(agent);
    }
  }
  await add();
  const warnings = [];
  for (const agent of grants) {
    try {
      const status = await backend.call<{ approved: boolean }>('agent_full_access', { agent: agent.id, confirm: true });
      if (!status.approved) throw new Error('The machine did not save the confirmation.');
    } catch (error) {
      warnings.push(`${agent.display_name} was added, but Full access confirmation failed. Open its settings to retry. ${String(error)}`);
    }
  }
  return warnings.length ? warnings.join('\n') : undefined;
}
