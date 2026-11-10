import { useCallback, useEffect, useRef, useState } from 'react';
import { discardFailed, giveUpBatch, retryFailed, sendAgain, startBatch, stopBatch, type BatchSlice, type SendApis } from './multiSend.ts';

/** Lives in App: changing composers must not drop an in-flight batch. */
export function useMultiBatches(apis: SendApis) {
  const live = useRef<BatchSlice[][]>([]);
  const [, render] = useState(0);
  const publish = useCallback(() => {
    live.current = live.current.filter(batch => {
      if (!batch.every(slice => slice.state === 'sent')) return true;
      stopBatch(batch); return false;
    });
    render(n => n + 1);
  }, []);
  useEffect(() => apis.subscribe(publish), [apis, publish]);
  useEffect(() => () => { live.current.forEach(stopBatch); }, []);
  const start = useCallback((batch: BatchSlice[]) => {
    live.current = [...live.current, batch];
    startBatch(batch, apis, publish); publish();
  }, [apis, publish]);
  const retry = useCallback(async () => {
    for (const batch of [...live.current]) await retryFailed(batch, apis);
    publish();
  }, [apis, publish]);
  const discard = useCallback(() => { for (const batch of live.current) discardFailed(batch, apis); publish(); }, [apis, publish]);
  const giveUp = useCallback(() => { live.current.forEach(giveUpBatch); publish(); }, [publish]);
  const again = useCallback(async (paneId: string) => {
    for (const batch of [...live.current]) await sendAgain(batch, paneId, apis);
    publish();
  }, [apis, publish]);
  // Getters deliberately read the ref in same-task click handlers.
  return {
    get batches() { return live.current; }, start, retry, discard, giveUp, sendAgain: again,
    get sending() { return live.current.flat().filter(s => s.state === 'sending'); },
    get failed() { return live.current.flat().filter(s => s.state === 'failed'); },
  };
}
