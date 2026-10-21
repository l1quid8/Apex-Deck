// Client-local voice lifecycle. Never starts as a consequence of loading Deck.
export function voiceRequestAllowed(url, origin) {
  try { return ['http:', 'ws:'].includes(new URL(url).protocol) && new URL(url).origin.replace(/^ws:/, 'http:') === origin; }
  catch { return false; }
}

export function createMoshi({ supported, installed, setup, launch }) {
  let state = { phase: 'off', message: '' }, pending = null, controller = null, running = null, stopping = null;
  const report = (phase, message) => { state = { phase, message: String(message).replace(/\x1b\[[0-9;]*m/g, '').slice(-1000) }; };
  return {
    status: () => ({ ...state }),
    start(consent = false) {
      if (!supported) return Promise.reject(new Error('Local Moshi requires an Apple Silicon Mac.'));
      if (stopping) return stopping.then(() => this.start(consent));
      if (pending) return pending;
      if (running) return Promise.resolve(running);
      const abort = new AbortController(); controller = abort;
      pending = (async () => {
        if (!await installed()) {
          if (consent !== true) throw new Error('Download the local voice runtime and approximately 5.2 GB model first.');
          report('installing', 'Preparing local voice…');
          await setup(abort.signal, message => report('installing', message));
        }
        abort.signal.throwIfAborted();
        report('starting', 'Loading Moshi…');
        const result = await launch(abort.signal, message => { if (state.phase === 'starting') report('starting', message); }, error => {
          running = null; report('error', error);
        });
        if (abort.signal.aborted) { await result.stop(); abort.signal.throwIfAborted(); }
        running = result;
        report('ready', 'Local voice is ready.');
        return result;
      })().catch(error => { if (!abort.signal.aborted) report('error', error.message); throw error; })
        .finally(() => { pending = null; });
      return pending;
    },
    stop() {
      if (stopping) return stopping;
      controller?.abort();
      const process = running; running = null;
      stopping = (async () => {
        await pending?.catch(() => {});
        await process?.stop();
        report('off', '');
      })().finally(() => { stopping = null; });
      return stopping;
    },
  };
}
