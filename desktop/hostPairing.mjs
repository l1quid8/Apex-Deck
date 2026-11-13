import crypto from 'node:crypto';

export function validPairedHost(host, taken = []) {
  if (host.transport !== 'paired' || !/^[0-9a-f]{64}$/.test(host.hostEndpointId ?? '') || !Array.isArray(host.addrs) || !host.addrs.every(a => typeof a === 'string') || !['read_only', 'chat', 'full'].includes(host.tier)) throw new Error('Invalid paired host.');
  if (typeof host.name !== 'string' || !host.name.trim() || host.name.length > 40 || host.name.toLowerCase() === 'this mac' || taken.some(n => n.toLowerCase() === host.name.toLowerCase())) throw new Error('Invalid or duplicate host name.');
  if (typeof host.daemonHostId !== 'string' || !host.daemonHostId) throw new Error('Missing daemon identity.');
  return { transport: 'paired', name: host.name, hostEndpointId: host.hostEndpointId, addrs: host.addrs, tier: host.tier, daemonHostId: host.daemonHostId };
}

export function pairedHost(made, hosts, verifiedId) {
  if (made.hostId && made.hostId !== verifiedId) throw new Error('The host identity changed during pairing.');
  if (hosts.some(h => h.hostEndpointId === made.hostEndpointId || h.daemonHostId === verifiedId)) throw new Error('This machine is already saved. Remove its old connection before pairing again.');
  const base = (made.hostName || made.name || 'Paired host').trim().slice(0, 35) || 'Paired host';
  let name = base;
  for (let n = 2; name.toLowerCase() === 'this mac' || hosts.some(h => h.name.toLowerCase() === name.toLowerCase()); n++) name = `${base} ${n}`;
  return { id: `h-${crypto.randomUUID()}`, ...validPairedHost({ transport: 'paired', name, hostEndpointId: made.hostEndpointId, addrs: made.addrs, tier: made.tier, daemonHostId: verifiedId }) };
}

/** One invitation per window. A cancelled verifier can never save a late result. */
export function createHostPairing({ open, verify, save }) {
  let state = { kind: 'idle' }, generation = 0, link, controller;
  const cancel = () => { generation++; controller?.abort(); link?.close(); link = null; state = { kind: 'idle' }; };
  return {
    cancel,
    status: () => state,
    start(invitation) {
      cancel();
      const ticket = generation;
      const attempt = controller = new AbortController();
      state = { kind: 'dialing' };
      let approved = false;
      try {
        link = open(invitation, event => {
          if (ticket !== generation) return;
          if (approved) return;
          if (event.type === 'pairCode') state = { kind: 'code', code: event.code, hostName: event.hostName };
          if (event.type === 'closed' && !approved) {
            state = { kind: 'failed', message: event.code === 14 ? 'Pairing was denied on the host.' : `Pairing ended: ${event.reason || 'request a fresh invitation and try again.'}` };
            link?.close(); link = null;
          }
          if (event.type !== 'pairDone' || approved) return;
          approved = true; state = { kind: 'verifying' };
          Promise.resolve().then(() => verify(event, attempt.signal)).then(id => {
            if (ticket !== generation) return;
            // save is synchronous: cancellation cannot interleave with persistence.
            state = { kind: 'done', hosts: save(event, id) };
            link?.close(); link = null;
          }).catch(error => {
            if (ticket === generation) { state = { kind: 'failed', message: error.message }; link?.close(); link = null; }
          });
        });
      } catch (error) { state = { kind: 'failed', message: error.message }; }
    },
  };
}
