import { validHost } from './hosts.mjs';

export function checkWelcome(expectedId, welcome) {
  if (!welcome || welcome.protocol !== 1) throw new Error('The host protocol is incompatible.');
  if (typeof welcome.host_id !== 'string' || !welcome.host_id.trim()) throw new Error('The host has no valid daemon identity.');
  if (expectedId && expectedId !== welcome.host_id) throw new Error('This address reaches a different daemon identity. Add it as a new server instead.');
  return welcome.host_id;
}
export function bindHostIdentity(state, hostId, welcome) {
  const host = state.hosts.find(h => h.id === hostId);
  if (!host) throw new Error('There is no such host.');
  const daemonHostId = checkWelcome(host.daemonHostId, welcome);
  if (state.hosts.some(h => h.id !== hostId && h.daemonHostId === daemonHostId)) throw new Error('This machine is already saved under another host.');
  return { ...state, hosts: state.hosts.map(h => h.id === hostId ? { ...h, daemonHostId } : h) };
}
/** Main observes the actual hello; commands cannot precede identity persistence. */
export async function verifiedLink({ open, handlers, accept }) {
  let hello = null; let ready = false; let link; let ended = false;
  link = await open({
    onClose: reason => { ended = true; handlers.onClose(reason); },
    onLine: line => {
      if (ended) return;
      if (ready) { handlers.onLine(line); return; }
      let frame;
      try { frame = JSON.parse(line); } catch { handlers.onClose('The host sent invalid protocol data.'); link?.close(); ended = true; return; }
      if (hello === null || frame.id !== hello) return;
      if (frame.err) { handlers.onLine(line); return; }
      try { accept(frame.ok); ready = true; handlers.onLine(line); }
      catch (error) {
        handlers.onLine(JSON.stringify({ id: hello, err: error.message }));
        ended = true; link?.close();
      }
    },
  });
  return {
    send(line) {
      if (ended) return;
      let frame; try { frame = JSON.parse(line); } catch { return; }
      if (!ready) { if (frame.cmd !== 'hello' || hello !== null) return; hello = frame.id; }
      link.send(line);
    },
    close() { ended = true; link.close(); },
  };
}

const failure = (code, message) => Object.assign(new Error(message), { code });

/**
 * Say hello to a daemon at candidate settings and nothing else: no command
 * runs there. Resolves with the welcome; the link is always closed.
 * `open(handlers)` opens the link, as sshLink does.
 */
export async function probeWelcome(open, { timeoutMs = 20000 } = {}) {
  let link = null;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The connection timed out.')), timeoutMs);
      Promise.resolve().then(() => open({
        onLine: (line) => {
          let frame;
          try { frame = JSON.parse(line); } catch { return; }
          if (frame.id !== 0) return;
          if (typeof frame.err === 'string') reject(new Error(frame.err));
          else resolve(frame.ok);
        },
        onClose: (reason) => reject(new Error(reason || 'The connection closed.')),
      })).then((opened) => {
        link = opened;
        link.send(JSON.stringify({ id: 0, cmd: 'hello', args: { protocol: 1 } }));
      }, reject);
    });
  } finally {
    clearTimeout(timer);
    link?.close();
  }
}

/**
 * Save an edit to a saved host, against the latest saved state, after any
 * probe. A new address or command needs a probe that reached the same
 * machine (or, for a host never connected, one no other host already is).
 * Errors carry `code`: changed, invalid, unreachable, known or different.
 */
export function applyHostUpdate(state, hostId, fields, { before, probed }) {
  const host = state.hosts.find((h) => h.id === hostId);
  if (!host || host.name !== before.name || host.ssh !== before.ssh || host.command !== before.command) {
    throw failure('changed', 'This server changed or was removed while Deck was checking it. Try again.');
  }
  let valid;
  try { valid = validHost(fields ?? {}, state.hosts.filter((h) => h.id !== hostId).map((h) => h.name)); }
  catch (e) { throw failure('invalid', e.message); }
  let daemonHostId = host.daemonHostId;
  if (valid.ssh !== host.ssh || valid.command !== host.command) {
    if (!probed) throw failure('unreachable', 'Nothing is saved until Deck can check that it is the same machine.');
    const probedId = checkWelcome(undefined, { protocol: 1, ...probed });
    const other = state.hosts.find((h) => h.id !== hostId && h.daemonHostId === probedId);
    if (other) throw failure('known', `${valid.ssh} is ${other.name}, which Deck already has. ${host.name} keeps its own address.`);
    if (host.daemonHostId && host.daemonHostId !== probedId) {
      throw failure('different', `${valid.ssh} is a different machine: its apex-daemon reports another host ID. This address isn't saved.`);
    }
    daemonHostId = probedId;
  }
  const next = { ...host, ...valid };
  if (daemonHostId) next.daemonHostId = daemonHostId;
  return { ...state, hosts: state.hosts.map((h) => (h.id === hostId ? next : h)) };
}
