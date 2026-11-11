/** Membership edits are unavailable while another edit saves; removing the last idle bot is allowed. */
export function botChangeGate(full: boolean, working: boolean, pending: boolean): string {
  if (!full) return 'Full access is needed to change agents. Change this phone’s access in Settings → Phones on this machine.';
  if (pending) return 'Saving an agent change…';
  if (working) return 'Stop this agent’s reply before removing it.';
  return '';
}
export function botSendGate(gate: { enabled: boolean; reason: string }, count: number) {
  return gate.enabled && count === 0 ? { enabled: false, reason: 'No agents yet. Add an agent to send a message.' } : gate;
}
