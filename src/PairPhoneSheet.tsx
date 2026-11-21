import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Backend } from "./backend";
import type { PairedDevice } from "./pairedDevices";
import {
  RENEW_FOR_MS, canApprove, copyLink, ensureRemoteAccess, pairingApi, pairingSession, qrSvgPath, revokedWarning,
  spacedCode, timerText, type PairState,
} from "./pairing";
import { deckClipboard } from "./copyText";
import { LOCAL_HOST_REFERENCE } from "./hostFacts.ts";

// Phones → Pair phone: a big QR the phone scans, and a Copy link button.
// The link text itself is never shown, so nobody copies a cut-off one. Codes
// renew on their own for 30 minutes from when the sheet opened. When a phone
// claims one, its name and code show with Approve and Deny. Closing the
// sheet cancels the invitation. Phone connections are turned on first when
// they're off, since a phone can't pair without them. That is live in the
// daemon; nothing restarts.

export function PairPhoneSheet({ backend, onClose, onPaired }: { backend: Backend; onClose: () => void; onPaired: (device: PairedDevice) => void }) {
  const api = useMemo(() => pairingApi(backend), [backend]);
  const [state, setState] = useState<PairState>({ kind: "idle" });
  const [round, setRound] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [turningOn, setTurningOn] = useState(false);
  // Pairing turned connections on (say so), or couldn't (offer Try again).
  const [turnedOn, setTurnedOn] = useState(false);
  const [accessFailed, setAccessFailed] = useState(false);
  // Renewals stop 30 minutes after the sheet opened (or Start again).
  const openedAt = useRef(Date.now());
  const session = useRef<ReturnType<typeof pairingSession> | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const paired = useRef(onPaired);
  paired.current = onPaired;

  useEffect(() => {
    let current: ReturnType<typeof pairingSession> | null = null;
    let stopped = false;
    setState({ kind: "starting" });
    setAccessFailed(false);
    // Connections first: a code made while they're off is refused.
    let flipped = false;
    void ensureRemoteAccess(backend.remoteAccess, () => { flipped = true; setTurningOn(true); }).then((problem) => {
      if (stopped) return;
      setTurningOn(false);
      if (problem !== null) { setAccessFailed(true); setState({ kind: "ended", reason: null, words: problem }); return; }
      if (flipped) setTurnedOn(true);
      current = pairingSession(api, (next) => {
        setState(next);
        if (next.kind === "paired") paired.current(next.device);
      }, undefined, openedAt.current + RENEW_FOR_MS);
      session.current = current;
      current.start();
    });
    return () => {
      stopped = true;
      current?.close();
      if (session.current === current) session.current = null;
    };
  }, [api, backend.remoteAccess, round]);

  useEffect(() => {
    if (state.kind !== "waiting" && state.kind !== "claimed") return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => clearInterval(tick);
  }, [state.kind]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const invite = state.kind === "waiting" || state.kind === "claimed" || state.kind === "approving" ? state.invite : null;
  const qr = useMemo(() => (invite ? qrSvgPath(invite.link) : null), [invite?.link]);
  const claim = state.kind === "claimed" || state.kind === "approving" ? state.claim : null;
  const showCode = !claim && state.kind !== "paired" && state.kind !== "ended";

  const copy = async () => {
    if (!invite) return;
    if (await copyLink(invite.link, deckClipboard)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  const startAgain = () => {
    openedAt.current = Date.now();
    setRound((n) => n + 1);
  };

  return createPortal(
    <div className="confirm-backdrop">
      <div className="confirm pair-sheet" role="dialog" aria-modal="true" aria-labelledby="pair-title">
        <strong id="pair-title">Pair a phone</strong>

        {turningOn && <p className="pair-note" role="status">Turning on phone connections…</p>}
        {turnedOn && showCode && <p className="pair-note" role="status">Turned on phone connections so your phone can reach {LOCAL_HOST_REFERENCE}. Nothing was restarted.</p>}

        {showCode && <>
          <div className="pair-qr" aria-busy={!qr}>
            {qr
              ? <svg viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="Pairing QR code" shapeRendering="crispEdges"><rect width={qr.size} height={qr.size} fill="#fff" /><path d={qr.d} fill="#000" /></svg>
              : <span className="muted">Making a code…</span>}
          </div>
          <div className="pair-under-qr">
            <p>Scan with the iPhone camera or the Apex Deck app.</p>
            <span className="pair-timer" role="status">{invite ? timerText(invite.expires_at, openedAt.current + RENEW_FOR_MS, now) : "\u00a0"}</span>
          </div>
        </>}

        {claim && <div className="pair-claim">
          <span className="pair-claim-phone"><strong>{claim.label}</strong> wants to pair</span>
          <span className="pair-claim-code mono" aria-label={`Pairing code ${claim.code.split("").join(" ")}`}>{spacedCode(claim.code)}</span>
          <p className="muted">Approve if your phone shows the same code.</p>
          <p className="muted">Let {claim.label} use {LOCAL_HOST_REFERENCE}?</p>
        </div>}
        {claim && revokedWarning(claim.previously_revoked_at) && <p className="pair-note warn" role="alert">{revokedWarning(claim.previously_revoked_at)}</p>}

        {state.kind === "paired" && <div className="pair-claim">
          <span className="pair-done" aria-hidden="true">✓</span>
          <span className="pair-claim-phone"><strong>{state.device.label}</strong> is paired</span>
          <p className="muted">Manage it any time in Settings → Phones.</p>
        </div>}

        {state.kind === "ended" && <p className="pair-note bad" role="alert">{state.words}</p>}

        <div className="confirm-actions pair-actions">
          <span>{showCode && <button className="ghost" disabled={!invite} onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button>}</span>
          <div className="pair-actions-right">
            {claim && <>
              <button onClick={() => session.current?.deny()} disabled={state.kind !== "claimed"}>Deny</button>
              <button className="primary" onClick={() => session.current?.approve()} disabled={!canApprove(state)}>{state.kind === "approving" ? "Approving…" : "Approve"}</button>
            </>}
            {state.kind === "ended" && <>
              <button onClick={onClose}>Close</button>
              <button className="primary" onClick={startAgain}>{accessFailed ? "Try again" : "Start again"}</button>
            </>}
            {showCode && <button onClick={onClose}>Cancel</button>}
            {state.kind === "paired" && <button className="primary" onClick={onClose}>Done</button>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
