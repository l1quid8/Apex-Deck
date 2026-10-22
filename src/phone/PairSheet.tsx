// Pairing with a machine by QR code.

import { useEffect, useRef, useState } from "react";

import { startPairing, type Paired, type PairState } from "./pairing";
import type { RemotePlugin } from "./remotePlugin";

/**
 * One pairing attempt, from dialing to the machine's Approve. The phone works
 * out the 6-digit code itself; the person checks it matches the machine's.
 * Closing the sheet cancels the attempt.
 */
export function PairSheet({ plugin, link, label, ready, onPaired, onClose }: {
  plugin: RemotePlugin;
  link: string;
  label: string;
  /** Settles once Automatic mode is set. Pairing waits, and shows the reason if it failed. */
  ready: Promise<void>;
  onPaired(paired: Paired): void;
  onClose(): void;
}) {
  const [state, setState] = useState<PairState>({ kind: "dialing" });
  const paired = useRef(onPaired);
  paired.current = onPaired;
  useEffect(() => {
    let attempt: { cancel(): void } | null = null;
    let live = true;
    ready.then(() => {
      if (!live) return;
      attempt = startPairing(plugin, link, label, (next) => {
        setState(next);
        if (next.kind === "done") paired.current(next.paired);
      });
    }, (error: unknown) => {
      if (!live) return;
      setState({ kind: "failed", message: String(error).replace(/^Error: /, "") });
    });
    return () => { live = false; attempt?.cancel(); };
  }, [plugin, link, label, ready]);

  if (state.kind === "dialing") return (
    <>
      <p className="ph-sheet-text">Reaching the machine…</p>
      <button type="button" className="ph-plain ph-wide" onClick={onClose}>Cancel</button>
    </>
  );
  if (state.kind === "code") return (
    <>
      <p className="ph-sheet-text">Check that {state.hostName} shows this code, then press Approve there.</p>
      <p className="ph-pair-code" aria-label={`Code ${state.code.split("").join(" ")}`}>{state.code}</p>
      <p className="ph-muted">If the codes don't match, press Deny on the machine.</p>
      <button type="button" className="ph-plain ph-wide" onClick={onClose}>Cancel</button>
    </>
  );
  if (state.kind === "done") return (
    <>
      <p className="ph-sheet-text">Paired with {state.paired.name}.{state.paired.tier === "full" ? "" : state.paired.tier === "chat" ? " This phone can chat in existing threads but not start new ones." : " This phone can read threads but not send."}</p>
      <button type="button" className="primary ph-wide" onClick={onClose}>Done</button>
    </>
  );
  return (
    <>
      <p className="ph-sheet-text ph-red">{state.message}</p>
      <button type="button" className="primary ph-wide" onClick={onClose}>OK</button>
    </>
  );
}
