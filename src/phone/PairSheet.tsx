// Pairing with a machine by QR code, and the phone's remote-access settings.

import { useEffect, useRef, useState } from "react";

import { writeClipboard } from "../threadCopy";
import { startPairing, type Paired, type PairState } from "./pairing";
import type { RemoteMode, RemotePlugin } from "./remotePlugin";

/**
 * One pairing attempt, from dialing to the machine's Approve. The phone works
 * out the 6-digit code itself; the person checks it matches the machine's.
 * Closing the sheet cancels the attempt.
 */
export function PairSheet({ plugin, link, label, onPaired, onClose }: {
  plugin: RemotePlugin;
  link: string;
  label: string;
  onPaired(paired: Paired): void;
  onClose(): void;
}) {
  const [state, setState] = useState<PairState>({ kind: "dialing" });
  const paired = useRef(onPaired);
  paired.current = onPaired;
  useEffect(() => {
    const attempt = startPairing(plugin, link, label, (next) => {
      setState(next);
      if (next.kind === "done") paired.current(next.paired);
    });
    return () => attempt.cancel();
  }, [plugin, link, label]);

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

/** Automatic or Direct only, and this phone's ID for the relay's list. */
export function RemoteSettings({ plugin, mode, onMode, onError }: {
  plugin: RemotePlugin;
  mode: RemoteMode;
  onMode(mode: RemoteMode): void;
  onError(message: string): void;
}) {
  const [id, setId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    plugin.identity().then((value) => { if (live) setId(value); }, (error: unknown) => { if (live) onError(String(error).replace(/^Error: /, "")); });
    return () => { live = false; };
  }, [plugin, onError]);
  return (
    <div className="ph-group ph-padded">
      <h3>Remote access</h3>
      <div className="ph-segment" role="radiogroup" aria-label="Connection">
        <button type="button" role="radio" aria-checked={mode === "automatic"} onClick={() => onMode("automatic")}>Automatic</button>
        <button type="button" role="radio" aria-checked={mode === "direct"} onClick={() => onMode("direct")}>Direct only</button>
      </div>
      <p className="ph-muted">{mode === "automatic"
        ? "Connects straight to each machine when it can, and through the Apex Deck relay when a network blocks that. The relay only passes along encrypted data."
        : "Never uses the relay. A server with its port open works anywhere; a Mac at home needs a forwarded port on its router, or it's only reachable on the same Wi-Fi."}</p>
      <p className="ph-label">This phone's ID</p>
      <p className="ph-path">{id ?? "…"}</p>
      <button type="button" className="ph-wide" disabled={!id} onClick={() => {
        if (!id) return;
        void writeClipboard(id).then((ok) => { setCopied(ok); if (!ok) onError("Couldn't copy. Select the ID and copy it by hand."); });
      }}>{copied ? "Copied" : "Copy ID"}</button>
      <small className="ph-muted">During the beta, pairing over cellular needs this ID on the relay's list. On the same Wi-Fi it doesn't.</small>
    </div>
  );
}
