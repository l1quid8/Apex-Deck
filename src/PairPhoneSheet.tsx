import { useEffect, useMemo, useRef, useState } from "react";

import type { Backend } from "./backend";
import { TIERS, threadsText, type PairedDevice, type Tier } from "./pairedDevices";
import {
  PAIR_DEFAULT_TIER, canApprove, copyLink, countdownText, pairableThreads, pairingApi, pairingSession, qrSvgPath, revokedWarning,
  type PairState,
} from "./pairing";

// Paired devices → Pair phone: a QR the phone scans, the same link to copy,
// and a 5-minute countdown. When a phone claims it, its name and code show
// with Approve and Deny. Closing the sheet cancels the invitation.
// Changing what the phone may do starts a new invitation, so the code
// always carries the access shown.

export function PairPhoneSheet({ backend, onClose, onPaired }: { backend: Backend; onClose: () => void; onPaired: (device: PairedDevice) => void }) {
  const api = useMemo(() => pairingApi(backend), [backend]);
  const [tier, setTier] = useState<Tier>(PAIR_DEFAULT_TIER);
  const [pick, setPick] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [threads, setThreads] = useState<{ id: string; title: string; workspace: string }[] | null>(null);
  const [state, setState] = useState<PairState>({ kind: "idle" });
  const [round, setRound] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const session = useRef<ReturnType<typeof pairingSession> | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const paired = useRef(onPaired);
  paired.current = onPaired;

  useEffect(() => { backend.sessionLoad().then((s) => setThreads(pairableThreads(s)), () => setThreads([])); }, [backend]);

  const scope: "all" | string[] | null = pick ? (picked.length ? picked : null) : "all";
  const scopeKey = `${tier}|${scope === null ? "-" : scope === "all" ? "all" : scope.join(",")}|${round}`;
  useEffect(() => {
    if (scope === null) { setState({ kind: "idle" }); return; }
    // A short wait, so ticking several threads starts one invitation, not one each.
    let current: ReturnType<typeof pairingSession> | null = null;
    const timer = setTimeout(() => {
      current = pairingSession(api, (next) => {
        setState(next);
        if (next.kind === "paired") paired.current(next.device);
      });
      session.current = current;
      current.start(tier, scope);
    }, round === 0 && scope === "all" ? 0 : 300);
    setState({ kind: "starting" });
    return () => {
      clearTimeout(timer);
      current?.close();
      if (session.current === current) session.current = null;
    };
  }, [api, scopeKey]);

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
  const scopeLocked = claim !== null || state.kind === "paired";
  const countdown = invite ? countdownText(invite.expires_at, now) : "";
  const tierLabel = TIERS.find((t) => t.id === tier)?.label ?? tier;

  const copy = async () => {
    if (!invite) return;
    if (await copyLink(invite.link, navigator.clipboard)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="confirm-backdrop">
      <div className="confirm pair-sheet" role="dialog" aria-modal="true" aria-labelledby="pair-title">
        <strong id="pair-title">Pair a phone</strong>

        {!claim && state.kind !== "paired" && state.kind !== "ended" && <>
          <p className="muted">Open Apex Deck on the phone and scan this code, or paste the link there.</p>
          <div className="pair-code-area">
            <div className="pair-qr" aria-busy={!qr}>
              {qr
                ? <svg viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="Pairing QR code" shapeRendering="crispEdges"><rect width={qr.size} height={qr.size} fill="#fff" /><path d={qr.d} fill="#000" /></svg>
                : <span className="muted">{scope === null ? "Pick at least one thread." : "Making a code…"}</span>}
            </div>
            <div className="pair-code-side">
              <span className="pair-countdown mono" aria-label="Time left">{invite ? (countdown === "Expired" ? "Expired" : countdown) : "5:00"}</span>
              <small className="muted">{invite ? (countdown === "Expired" ? "Start again for a new code." : "until this code expires") : ""}</small>
              <span className="pair-link mono" title="The pairing link">{invite?.link ?? ""}</span>
              <button disabled={!invite || countdown === "Expired"} onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button>
            </div>
          </div>
        </>}

        {claim && <div className="pair-claim">
          <p><strong>{claim.label}</strong> wants to pair.</p>
          <p className="muted">Check that the phone shows the same code:</p>
          <span className="pair-claim-code mono" aria-label="Pairing code">{claim.code}</span>
          {revokedWarning(claim.previously_revoked_at) && <p className="pair-warning" role="alert">{revokedWarning(claim.previously_revoked_at)}</p>}
          <p className="muted">It gets {tierLabel} on {threadsText(scope ?? "all").toLowerCase()}.</p>
        </div>}

        {state.kind === "paired" && <div className="pair-claim">
          <p><strong>{state.device.label}</strong> is paired.</p>
          <p className="muted">It can connect from anywhere while Remote access is on. Change its access or revoke it in Paired devices.</p>
        </div>}

        {state.kind === "ended" && <div className="pair-claim">
          <p role="alert">{state.words}</p>
        </div>}

        <fieldset className="pair-scope" disabled={scopeLocked}>
          <label>
            <span>Access</span>
            <select aria-label="Access for the new phone" value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
              {TIERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          <small className="muted">{TIERS.find((t) => t.id === tier)?.note}</small>
          <div className="pair-thread-choice" role="radiogroup" aria-label="Threads">
            <label><input type="radio" name="pair-threads" checked={!pick} onChange={() => setPick(false)} /> All threads</label>
            <label><input type="radio" name="pair-threads" checked={pick} onChange={() => setPick(true)} /> Only these threads</label>
          </div>
          {pick && <div className="pair-thread-list">
            {threads === null && <small className="muted">…</small>}
            {threads?.length === 0 && <small className="muted">No threads on this Mac yet.</small>}
            {threads?.map((t) => <label key={t.id}>
              <input type="checkbox" checked={picked.includes(t.id)} onChange={(e) => setPicked((old) => e.target.checked ? [...old, t.id] : old.filter((id) => id !== t.id))} />
              <span>{t.title}</span><small className="muted">{t.workspace}</small>
            </label>)}
          </div>}
        </fieldset>

        <div className="confirm-actions">
          {claim && <>
            <button onClick={() => session.current?.deny()} disabled={state.kind !== "claimed"}>Deny</button>
            <button className="primary" onClick={() => session.current?.approve()} disabled={!canApprove(state)}>{state.kind === "approving" ? "Approving…" : "Approve"}</button>
          </>}
          {(state.kind === "ended" || (invite && countdown === "Expired" && !claim)) && <button onClick={() => setRound((n) => n + 1)}>Start again</button>}
          {!claim && <button onClick={onClose}>{state.kind === "paired" ? "Done" : "Cancel"}</button>}
        </div>
      </div>
    </div>
  );
}
