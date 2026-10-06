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
