import { useEffect, useState } from "react";

import { availableCount, exactDeadline, liveCredits, secondsCountdown } from "./resetCredits.ts";
import type { ResetCredit, ResetCredits } from "./types";

/** The time in Unix seconds, read again every second while shown. */
function useSeconds(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** A usage-card row listing a provider's granted resets: each counts down to
 *  its expiry by the second, with the exact deadline on hover, and Apply
 *  asks to use it. */
export function PlanResets({ credits, applying, onApply }: { credits: ResetCredits; applying: string | null; onApply(credit: ResetCredit | null): void }) {
  const now = useSeconds();
  const live = liveCredits(credits, now);
  const count = availableCount(credits, now);
  if (count === 0) return null;
  return (
    <div className="usage-row">
      <span className="usage-label">Resets</span>
      <div className="plan-resets">
        {live.map((credit) => {
          const deadline = credit.expires_at != null ? exactDeadline(credit.expires_at) : null;
          const tip = [deadline ? `Expires ${deadline}` : "Never expires", credit.description].filter(Boolean).join("\n");
          return (
            <div key={credit.id} className="plan-reset" title={tip}>
              <span className="plan-reset-name">{credit.title ?? "Usage reset"}</span>
              {credit.expires_at != null
                ? <time className={credit.expires_at - now < 86_400 ? "plan-reset-left soon" : "plan-reset-left"} dateTime={new Date(credit.expires_at * 1000).toISOString()} aria-label={`Expires ${deadline}`}>{secondsCountdown(credit.expires_at, now)}</time>
                : <span className="plan-reset-left">no expiry</span>}
              <button type="button" className="ghost plan-reset-apply" disabled={applying !== null} onClick={() => onApply(credit)}>
                {applying === credit.id ? "Applying…" : "Apply"}
              </button>
            </div>
          );
        })}
        {live.length === 0 && (
          // The provider gave only a count, so Apply uses whichever it picks.
          <div className="plan-reset">
            <span className="plan-reset-name">{count === 1 ? "1 reset" : `${count} resets`}</span>
            <span className="plan-reset-left">expiry not given</span>
            <button type="button" className="ghost plan-reset-apply" disabled={applying !== null} onClick={() => onApply(null)}>
              {applying === "" ? "Applying…" : "Apply"}
            </button>
          </div>
        )}
        {live.length > 0 && count > live.length && <span className="usage-note">+{count - live.length} more</span>}
      </div>
    </div>
  );
}
