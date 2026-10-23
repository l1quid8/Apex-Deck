import { useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import { liveWindows, windowLabel } from "./battery";
import { availableCount, clockCountdown, exactDeadline, liveCredits, outcomeLine, type ResetOutcome } from "./resetCredits.ts";
import type { PlanWindow, ResetCredit, ResetCredits } from "./types";

/** Under this much time left, a credit shows in amber. */
const SOON = 48 * 3600;
/** Under this much used, spending a credit gains little. */
const BARELY_USED = 25;
/** About how tall the deadline card is, to choose above or below. */
const TIP_HEIGHT = 96;

/** The time in Unix seconds, read again every second. */
function useSeconds(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const Chevron = () => <svg className="model-select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/** A card under an expiry while the pointer rests on it: the exact deadline and when the credit was granted. */
function DeadlineCard({ credit, at }: { credit: ResetCredit; at: DOMRect }) {
  const left = Math.min(window.innerWidth - 248, Math.max(8, at.left));
  // Opens above when it wouldn't fit below.
  const place = at.bottom + 6 + TIP_HEIGHT <= window.innerHeight ? { top: at.bottom + 6 } : { bottom: window.innerHeight - at.top + 6 };
  return createPortal(
    <div className="reset-tip" role="tooltip" style={{ left, ...place }}>
      <div className="reset-tip-key">{credit.title ?? "Usage reset"} · expires</div>
      <div className="reset-tip-value">{credit.expires_at != null ? exactDeadline(credit.expires_at) : "Never"}</div>
      {credit.granted_at > 0 && <>
        <div className="reset-tip-key">Granted</div>
        <div className="reset-tip-value">{exactDeadline(credit.granted_at)}</div>
      </>}
    </div>,
    document.body,
  );
}

interface Props {
  credits: ResetCredits;
  /** The provider's plan windows, to say what a reset would give back. */
  windows: PlanWindow[];
  /** The provider's name, such as "Codex". */
  provider: string;
  /** Spend `credit`, or the provider's pick when null. */
  use(credit: ResetCredit | null): Promise<ResetOutcome>;
}

/** The Resets row of a bot's quick menu: a count and the next expiry, opening
 *  like the Model picker into one card per credit, each counting down to the
 *  second. Use asks in place before it spends anything. */
export function QuickResets({ credits, windows, provider, use }: Props) {
  const now = useSeconds();
  const [open, setOpen] = useState(false);
  /** The credit being asked about; null for the provider's pick, undefined when not asking. */
  const [asking, setAsking] = useState<ResetCredit | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; good: boolean } | null>(null);
  const [tip, setTip] = useState<{ credit: ResetCredit; at: DOMRect } | null>(null);
  const live = liveCredits(credits, now);
  const count = availableCount(credits, now);
  const first = live[0];
  if (count === 0 && !status) return null;

  const hover = (credit: ResetCredit) => ({
    onMouseEnter: (event: MouseEvent<HTMLElement>) => setTip({ credit, at: event.currentTarget.getBoundingClientRect() }),
    onMouseLeave: () => setTip(null),
  });
  // The window that binds hardest says how much a reset would give back.
  const binding = liveWindows(windows, now).reduce<PlanWindow | undefined>((worst, w) => (!worst || w.used_percent > worst.used_percent ? w : worst), undefined);
  const used = binding ? Math.min(100, binding.used_percent) : null;
  const name = binding ? windowLabel(binding) : "";

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
  const ask = (credit: ResetCredit | null) => { setTip(null); setStatus(null); setAsking(credit); };

  const card = (credit: ResetCredit) => {
    const soon = credit.expires_at != null && credit.expires_at - now < SOON;
    return (
      <div key={credit.id} className={soon ? "reset-credit soon" : "reset-credit"}>
        <span className="reset-credit-title">{credit.title ?? "Usage reset"}</span>
        <span className="reset-credit-expiry" {...hover(credit)}>
          {credit.expires_at != null ? <>Expires in <time dateTime={new Date(credit.expires_at * 1000).toISOString()}>{clockCountdown(credit.expires_at, now)}</time></> : "Never expires"}
        </span>
        <button type="button" className="reset-credit-use" onClick={() => ask(credit)}>Use</button>
      </div>
    );
  };

  return (
    <div className="quick-resets">
      <div className="model-select">
        <span className="model-select-label">Resets</span>
        <button type="button" className="model-select-trigger quick-resets-trigger" aria-expanded={open || asking !== undefined} disabled={count === 0}
          onClick={() => { setOpen((was) => !(was || asking !== undefined)); setAsking(undefined); setStatus(null); }}>
          <span className="reset-pill">{count}</span>
          {first?.expires_at != null
            ? <span className="quick-resets-next" {...hover(first)}>next expires <time dateTime={new Date(first.expires_at * 1000).toISOString()}>{clockCountdown(first.expires_at, now)}</time></span>
            : <span className="quick-resets-next">{count ? "expiry not given" : "none left"}</span>}
          <Chevron />
        </button>
      </div>
      {asking !== undefined ? (
        <div className="reset-confirm" role="alertdialog" aria-label={`Reset ${provider} usage`}>
          <p><b>Reset {provider} usage now?</b></p>
          {used != null && <p>
            {name.charAt(0).toUpperCase()}{name.slice(1)} is <b>{used}% used</b>
            {used >= 100 ? ", so you're blocked until it resets." : binding?.resets_at != null ? `, refills on its own in ${clockCountdown(binding.resets_at, now)}.` : "."}
          </p>}
          {used != null && used < BARELY_USED && <p className="reset-warn">Barely used — this would spend a credit for little gain.</p>}
          <p>{asking?.expires_at != null ? `Spends the credit that expires in ${clockCountdown(asking.expires_at, now)}.` : `${provider} picks which credit to spend.`} Can't be undone.</p>
          <div className="reset-confirm-actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => setAsking(undefined)}>Cancel</button>
            <button type="button" className="reset-go" disabled={busy} onClick={() => confirm(asking)}>{busy ? "Resetting…" : "Use reset"}</button>
          </div>
        </div>
      ) : open && (
        <div className="reset-credits">
          {live.map(card)}
          {live.length === 0 && count > 0 && (
            // The provider gave only a count, so Use spends whichever it picks.
            <div className="reset-credit">
              <span className="reset-credit-title">{count === 1 ? "1 reset" : `${count} resets`}</span>
              <span className="reset-credit-expiry">Expiry not given</span>
              <button type="button" className="reset-credit-use" onClick={() => ask(null)}>Use</button>
            </div>
          )}
          {live.length > 0 && count > live.length && <p className="muted reset-more">+{count - live.length} more</p>}
        </div>
      )}
      {status && <p className={status.good ? "reset-status good" : "reset-status meh"} role="status">{status.text}</p>}
      {tip && <DeadlineCard credit={tip.credit} at={tip.at} />}
    </div>
  );
}
