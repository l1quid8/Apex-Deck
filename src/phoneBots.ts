/** Membership edits are unavailable while another edit saves; removing the last idle bot is allowed. */
export function botChangeGate(full: boolean, working: boolean, pending: boolean): string {
  if (!full) return 'Full access is needed to change bots. Change this phone’s access in Settings → Paired devices on this machine.';
  if (pending) return 'Saving a bot change…';
  if (working) return 'Stop this bot’s reply before removing it.';
  return '';
}
export function botSendGate(gate: { enabled: boolean; reason: string }, count: number) {
  return gate.enabled && count === 0 ? { enabled: false, reason: 'No bots yet. Add a bot to send a message.' } : gate;
}
