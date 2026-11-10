import type { Slice } from './slicePlan.ts';
import type { PendingFile, QueueRef, SlicePayload, ThreadSendApi } from './threadSendApi.ts';
import type { ItemState } from './turnQueue.ts';

export interface BatchSlice {
  paneId: string; hostId: string; title: string;
  command: Slice['command']; payload: SlicePayload | null;
  state: 'sending' | 'queued' | 'sent' | 'failed';
  ref?: QueueRef; reason?: string; sendAgain?: boolean;
}
export interface SendApis {
  get(paneId: string): ThreadSendApi | undefined;
  subscribe(cb: () => void): () => void;
}
interface Observation { api: ThreadSendApi; stop: () => void }
const observations = new WeakMap<BatchSlice, Observation>();
const changedCallbacks = new WeakMap<BatchSlice, () => void>();

export function freezeBatch(slices: Slice[], files: Map<string, PendingFile>, tldr: boolean): BatchSlice[] {
  return slices.map(slice => ({
    paneId: slice.paneId, hostId: slice.hostId, title: slice.paneId,
    command: slice.command, state: 'sending',
    payload: slice.command ? null : {
      text: slice.text, routing: slice.routing, tldr, to: slice.to ? [...slice.to] : null,
      files: slice.files.map(id => {
        const file = files.get(id);
        if (!file?.bytes) throw new Error(`Still reading ${file?.name ?? id}.`);
        // A batch owns its bytes; subsequent draft edits cannot change a retry.
        return { ...file, bytes: file.bytes.slice(), previewUrl: null };
      }),
    },
  }));
}

function reflect(slice: BatchSlice, state: ItemState, error?: unknown) {
  slice.sendAgain = false; delete slice.reason;
  switch (state) {
    case 'preparing': slice.state = 'sending'; break;
    case 'waiting': case 'posting': slice.state = 'queued'; break;
    case 'posted': slice.state = 'sent'; break;
    case 'failed':
      slice.state = 'failed'; slice.reason = error instanceof Error ? error.message : String(error ?? 'Not sent.'); break;
    case 'closed':
      slice.state = 'failed'; slice.reason = `${slice.title} closed before this was sent. Retry sends it.`; break;
    case 'removed':
      slice.state = 'failed'; slice.sendAgain = true;
      slice.reason = `Removed from ${slice.title}'s queue. Send again sends it once more.`; break;
    case 'unknown':
      slice.state = 'failed'; slice.sendAgain = true;
      slice.reason = `Check ${slice.title}: it may have arrived. Send again sends it once more.`; break;
  }
}

function observe(slice: BatchSlice, api: ThreadSendApi, changed: () => void) {
  observations.get(slice)?.stop();
  let active=true;let unwatch:(()=>void)|undefined;
  const observation: Observation = { api, stop: () => {active=false;unwatch?.();} };
  observations.set(slice, observation);
  unwatch = api.watch(slice.ref!, (state, error) => { if(active){reflect(slice, state, error); changed();} });
  if(!active)unwatch();
}
function submit(slice: BatchSlice, api: ThreadSendApi, changed: () => void) {
  try {
    const ref = slice.command ? api.command(slice.command) : api.submit(slice.payload!);
    // Keep provenance paired even when the pane moved since the first send.
    slice.ref = ref; slice.hostId = api.hostId;
    observe(slice, api, changed);
  } catch (error) {
    reflect(slice, 'failed', error); changed();
  }
}
export function startBatch(batch: BatchSlice[], apis: SendApis, changed: (batch: BatchSlice[]) => void): void {
  for (const slice of batch) {
    const publish = () => changed(batch);
    changedCallbacks.set(slice, publish);
    const api = apis.get(slice.paneId);
    if (api) submit(slice, api, publish);
    else { reflect(slice, 'failed', `Open ${slice.title} in this window to retry.`); publish(); }
  }
}

export async function retryFailed(batch: BatchSlice[], apis: SendApis): Promise<BatchSlice[]> {
  for (const slice of batch) {
    if (slice.state !== 'failed') continue;
    const old = observations.get(slice);
    const api = apis.get(slice.paneId);
    const changed = changedCallbacks.get(slice) ?? (() => {});
    if (!api) { slice.reason = `Open ${slice.title} in this window to retry.`; changed(); continue; }
    if (!slice.ref) { submit(slice, api, changed); continue; }
    if (slice.ref.queue === api.queue) {
      const state = api.status(slice.ref);
      if (state === 'failed') api.retry(slice.ref);
      else reflect(slice, state);
    } else {
      const state = old?.api.status(slice.ref) ?? 'unknown';
      if (state === 'closed') submit(slice, api, changed);
      else {
        reflect(slice, state === 'posted' ? 'posted' : 'unknown');
        if (state !== 'posted' && api.hostId !== slice.hostId) slice.reason = `${slice.title} moved to another machine. Check it there before sending again.`;
      }
    }
    changed();
  }
  return batch;
}

export async function sendAgain(batch: BatchSlice[], paneId: string, apis: SendApis): Promise<BatchSlice[]> {
  for (const slice of batch) {
    if (slice.paneId !== paneId || slice.state !== 'failed' || !slice.sendAgain) continue;
    const api = apis.get(paneId); const changed = changedCallbacks.get(slice) ?? (() => {});
    if (!api) { slice.reason = `Open ${slice.title} in this window to retry.`; changed(); continue; }
    submit(slice, api, changed);
  }
  return batch;
}

export function stopBatch(batch: BatchSlice[]): void {
  for (const slice of batch) { observations.get(slice)?.stop(); observations.delete(slice); changedCallbacks.delete(slice); }
}
export function discardFailed(batch: BatchSlice[], apis: SendApis): void {
  for (const slice of batch) {
    if (slice.state !== 'failed') continue;
    const old = observations.get(slice); old?.stop(); observations.delete(slice); changedCallbacks.delete(slice);
    const api = apis.get(slice.paneId);
    if (slice.ref && api?.queue === slice.ref.queue) api.remove(slice.ref);
    slice.state = 'sent'; delete slice.reason; slice.sendAgain = false;
  }
}

export function giveUpBatch(batch: BatchSlice[]): void {
  for (const slice of batch) if (slice.state === 'sending' && slice.ref) observations.get(slice)?.api.giveUp(slice.ref);
}
