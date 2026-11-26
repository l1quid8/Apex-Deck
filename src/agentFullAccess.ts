import type { Backend } from './backend';
import type { ParticipantConfig } from './types';

export const FULL_ACCESS_CONFIRMATION = 'Full access allows this agent to execute commands and code written by other agents within its allowed folders on this machine. This applies across threads and worktrees and survives restarts. It does not grant additional folders. Restricted access restores its normal checks.';

export async function confirmAgentFullAccess(
  backend: Backend,
  agent: Pick<ParticipantConfig, 'id' | 'display_name' | 'access'>,
  confirm: (message: string) => boolean = message => window.confirm(message),
): Promise<void> {
  if (agent.access !== 'full') return;
  if (!backend.supports?.('agent_full_access_v1')) {
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
