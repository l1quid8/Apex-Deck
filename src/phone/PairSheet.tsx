// Pairing with a machine by QR code.

import { useEffect, useRef, useState } from "react";

import { startPairing, type Paired, type PairState } from "./pairing";
import type { RemotePlugin } from "./remotePlugin";

/**
 * One pairing attempt, from dialing to the machine's Approve. The phone works
 * out the 6-digit code itself; the person checks it matches the machine's.
 * Closing the sheet cancels the attempt.
 */
export function PairSheet({ plugin, link, label, ready, onPaired, onFailed, onClose }: {
  plugin: RemotePlugin;
  link: string;
  label: string;
  /** Settles once Automatic mode is set. Pairing waits, and shows the reason if it failed. */
  ready: Promise<void>;
  onPaired(paired: Paired): void;
  /** The attempt failed. The error stays on screen; OK only dismisses it. */
  onFailed(): void;
  /** "done" is the success button. "failed" is the error button. Anything else is a cancel. */
  onClose(why: "cancelled" | "failed" | "done"): void;
}) {
  const [state, setState] = useState<PairState>({ kind: "dialing" });
  const paired = useRef(onPaired);
  paired.current = onPaired;
  const failed = useRef(onFailed);
  failed.current = onFailed;
  useEffect(() => {
    let attempt: { cancel(): void } | null = null;
    let live = true;
    let reported = false;
    const failedOnce = () => {
      if (reported) return;
      reported = true;
      failed.current();
    };
    ready.then(() => {
      if (!live) return;
      attempt = startPairing(plugin, link, label, (next) => {
        setState(next);
        if (next.kind === "done") paired.current(next.paired);
        if (next.kind === "failed") failedOnce();
      });
    }, (error: unknown) => {
      if (!live) return;
      setState({ kind: "failed", message: String(error).replace(/^Error: /, "") });
      failedOnce();
    });
    return () => { live = false; attempt?.cancel(); };
  }, [plugin, link, label, ready]);

  if (state.kind === "dialing") return (
    <>
      <p className="ph-sheet-text">Reaching the machine…</p>
      <button type="button" className="ph-plain ph-wide" onClick={() => onClose("cancelled")}>Cancel</button>
    </>
  );
  if (state.kind === "code") return (
    <>
      <p className="ph-sheet-text">Check that {state.hostName} shows this code, then press Approve there.</p>
      <p className="ph-pair-code" aria-label={`Code ${state.code.split("").join(" ")}`}>{state.code}</p>
      <p className="ph-muted">If the codes don't match, press Deny on the machine.</p>
      <button type="button" className="ph-plain ph-wide" onClick={() => onClose("cancelled")}>Cancel</button>
    </>
  );
  if (state.kind === "done") return (
    <>
      <p className="ph-sheet-text">Paired with {state.paired.name}.{state.paired.tier === "full" ? "" : state.paired.tier === "chat" ? " This phone can chat in existing threads but not start new ones." : " This phone can read threads but not send."}</p>
      <button type="button" className="primary ph-wide" onClick={() => onClose("done")}>Done</button>
    </>
  );
  return (
    <>
      <p className="ph-sheet-text ph-red">{state.message}</p>
      <button type="button" className="primary ph-wide" onClick={() => onClose("failed")}>OK</button>
    </>
  );
}
