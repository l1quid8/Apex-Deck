// One signal, two jobs: after an import, every view that shows imported records
// must re-read them from the host, and every place offering the import must drop
// its cached preview. Both are the same event, so both listen here.
//
// Deliberately tiny: a set of listeners, no state, no polling, no storage. Views
// subscribe while mounted and unsubscribe on cleanup; nothing is retained.

export type ImportListener = () => void;

const listeners = new Set<ImportListener>();
let revision = 0;
/** Lets all panels share one fresh preview after the same completed import. */
export const importRevision = () => revision;

/** Called while mounted. Returns the unsubscribe the effect cleanup needs. */
export function subscribeToImports(listener: ImportListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * An import finished. Listeners re-read from the host; nothing is refreshed from a
 * local copy, because the host is the only thing that knows what it accepted.
 */
export function announceImport(): void {
  revision++;
  // Copy first: a listener that unsubscribes while being notified (a view unmounting
  // as a result of the import) must not disturb the iteration.
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* One view failing to re-read must not stop the others. */ }
  }
}

/** Test seam: forget every listener, so one test cannot leak into the next. */
export function forgetImportListeners(): void {
  listeners.clear();
}
