/** Byte pipes are independent for every window and saved host. */
export function createHostLinks({ open, emit }) {
  const windows = new Map();
  function slot(windowId, hostId) { return windows.get(windowId)?.get(hostId); }
  function stop(state) { if (!state) return; state.live = false; state.link?.close(); state.link = null; }
  return {
    async connect(windowId, hostId) {
      let hosts = windows.get(windowId);
      if (!hosts) windows.set(windowId, hosts = new Map());
      const old = hosts.get(hostId); stop(old);
      const state = { gen: (old?.gen ?? 0) + 1, live: true, link: null };
      hosts.set(hostId, state);
      const publish = (channel, value) => {
        if (state.live && slot(windowId, hostId) === state) emit(windowId, hostId, state.gen, channel, value);
      };
      try {
        const link = await open(hostId, {
          onLine: line => publish('daemon:line', line),
          onClose: reason => { publish('daemon:close', reason); state.live = false; state.link = null; },
        });
        if (!state.live || slot(windowId, hostId) !== state) { link.close(); throw new Error('Connection closed or replaced.'); }
        state.link = link;
        return state.gen;
      } catch (error) { stop(state); throw error; }
    },
    send(windowId, hostId, gen, line) { const s = slot(windowId, hostId); if (s?.live && s.gen === gen) s.link?.send(line); },
    close(windowId, hostId, gen) { const s = slot(windowId, hostId); if (s?.gen === gen) s.link?.close(); },
    destroy(windowId) { const hosts = windows.get(windowId); windows.delete(windowId); hosts?.forEach(stop); },
    removeHost(hostId) { windows.forEach(hosts => { const s = hosts.get(hostId); hosts.delete(hostId); stop(s); }); },
  };
}
