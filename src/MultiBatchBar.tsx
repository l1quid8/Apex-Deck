import { useEffect, useState } from 'react';
import type { useMultiBatches } from './useMultiBatches';

export function MultiBatchBar({ batches, onReveal }: { batches: ReturnType<typeof useMultiBatches>; onReveal(id: string): void }) {
  const [elapsed, setElapsed] = useState(0);
  const sending = batches.sending.length;
  useEffect(() => {
    setElapsed(0);
    if (!sending) return;
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - start), 250);
    return () => clearInterval(timer);
  }, [!!sending]);
  const failed = batches.failed;
  if (!failed.length && (!sending || elapsed < 500)) return null;
  return <div className="multi-batch-bar" role="status">
    {failed.length > 0 && <><span>{failed.length} of {batches.batches.flat().length} didn't send: {failed.map(slice => slice.title).join(', ')}</span>
      <button type="button" onClick={() => { void batches.retry(); }}>Retry</button><button type="button" onClick={batches.discard}>Discard</button>
      {failed.map(slice => <span key={slice.paneId}><button type="button" onClick={() => onReveal(slice.paneId)}>Show {slice.title}</button> {slice.reason}
        {slice.sendAgain && <button type="button" onClick={() => { void batches.sendAgain(slice.paneId); }}>Send again</button>}</span>)}
    </>}
    {sending > 0 && elapsed >= 500 && <><span>Sending to {sending === 1 ? batches.sending[0].title : `${sending} threads`}…</span>{elapsed >= 10000 && <button type="button" onClick={batches.giveUp}>Stop waiting</button>}</>}
  </div>;
}
