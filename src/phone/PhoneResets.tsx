import { useEffect, useState } from "react";

import { availableCount, clockCountdown, exactDeadline, liveCredits, outcomeLine, resetAsk, SOON_SECONDS, type ResetOutcome } from "../resetCredits.ts";
import type { PlanWindow, ResetCredit, ResetCredits } from "../types";
import { ChevronDown, ChevronUp } from "./icons";

/** The time in Unix seconds, read again every second. */
function useSeconds(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The bot sheet's Resets group: the count and the next expiry, opening in
 *  place into one row per credit, each counting down to the second with its
 *  exact deadline under it (a phone has no hover). Use asks in place first. */
export function PhoneResets({ credits, windows, provider, offline, use }: {
  credits: ResetCredits;
  windows: PlanWindow[];
  /** The provider's name, such as "Codex". */
  provider: string;
  /** Why the machine can't take it right now; empty while it's online. */
  offline: string;
  /** Spend `credit`, or the provider's pick when null. */
  use(credit: ResetCredit | null): Promise<ResetOutcome>;
}) {
  const now = useSeconds();
  const [open, setOpen] = useState(false);
  /** The credit being asked about; null for the provider's pick, undefined when not asking. */
  const [asking, setAsking] = useState<ResetCredit | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; good: boolean } | null>(null);
  const live = liveCredits(credits, now);
  const count = availableCount(credits, now);
  if (count === 0 && !status) return null;
  const first = live[0];

  const confirm = (credit: ResetCredit | null) => {
    setBusy(true);
    use(credit)
      .then((outcome) => {
        setStatus({ text: outcomeLine(outcome, provider).text, good: outcome === "reset" || outcome === "already_redeemed" });
        setAsking(undefined);
      })
      .catch((error) => setStatus({ text: `Couldn't use the ${provider} reset: ${error instanceof Error ? error.message : String(error)}`, good: false }))
      .finally(() => setBusy(false));
  };
  const ask = (credit: ResetCredit | null) => { setStatus(null); setAsking(credit); };

  const row = (credit: ResetCredit | null) => {
    const soon = credit?.expires_at != null && credit.expires_at - now < SOON_SECONDS;
    return (
      <div key={credit?.id ?? "pick"} className={`ph-reset${soon ? " soon" : ""}`}>
        <span className="ph-grow">
          <strong>{credit ? credit.title ?? "Usage reset" : count === 1 ? "1 reset" : `${count} resets`}</strong>
          {credit?.expires_at != null ? <>
            <small className="ph-reset-left">Expires in <time dateTime={new Date(credit.expires_at * 1000).toISOString()}>{clockCountdown(credit.expires_at, now)}</time></small>
            <small>{exactDeadline(credit.expires_at)}</small>
          </> : <small>{credit ? "Never expires" : "Expiry not given"}</small>}
        </span>
        <button type="button" disabled={Boolean(offline)} onClick={() => ask(credit)}>Use</button>
      </div>
    );
  };

  return <>
    <div className="ph-section">Usage resets</div>
    <div className="ph-group ph-resets">
      <button type="button" className="ph-srow" aria-expanded={open || asking !== undefined} disabled={count === 0} onClick={() => { setOpen((was) => !(was || asking !== undefined)); setAsking(undefined); setStatus(null); }}>
        <span className="ph-grow"><strong>Resets</strong>
          {first?.expires_at != null && <small className="ph-reset-next">Next expires <time dateTime={new Date(first.expires_at * 1000).toISOString()}>{clockCountdown(first.expires_at, now)}</time></small>}
        </span>
        <span className="ph-reset-pill">{count}</span>
        <span className="ph-srow-icon ph-muted-icon">{open || asking !== undefined ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span>
      </button>
      {asking !== undefined ? (() => { const words = resetAsk(windows, asking, provider, now); return (
        <div className="ph-reset-confirm" role="alertdialog" aria-label={`Reset ${provider} usage`}>
          <p><strong>Reset {provider} usage now?</strong></p>
          {words.usage && <p>{words.usage.name} is <b>{words.usage.used}% used</b>{words.usage.after}</p>}
          {words.barely && <p className="ph-amber">Barely used — this would spend a credit for little gain.</p>}
          <p>{words.spends}</p>
          <div className="ph-reset-actions">
            <button type="button" disabled={busy} onClick={() => setAsking(undefined)}>Cancel</button>
            <button type="button" className="primary" disabled={busy || Boolean(offline)} onClick={() => confirm(asking)}>{busy ? "Resetting…" : "Use reset"}</button>
          </div>
        </div>
      ); })() : open && <>
        {live.map(row)}
        {live.length === 0 && count > 0 && row(null)}
        {live.length > 0 && count > live.length && <p className="ph-reset-more">+{count - live.length} more</p>}
      </>}
    </div>
    {(status || (offline && open)) && <p className={`ph-sheet-text ph-turn-note ${status?.good ? "ph-mint" : "ph-amber"}`} role="status">
      {status ? status.text : `${offline}. Resets can be used once it's back.`}
    </p>}
  </>;
}
