// Usage resets a provider granted (only Codex, for now). Each one puts the
// plan's windows back to empty when used, and most expire, so the list
// counts down to each deadline by the second.

import type { ResetCredit, ResetCredits } from "./types";

/** The credits still usable at `nowSeconds`, soonest to expire first. */
export function liveCredits(credits: ResetCredits | undefined, nowSeconds: number): ResetCredit[] {
  return (credits?.credits ?? [])
    .filter((c) => c.expires_at == null || c.expires_at > nowSeconds)
    .sort((a, b) => (a.expires_at ?? Infinity) - (b.expires_at ?? Infinity));
}

/** How many are available, less any listed ones that have since expired. */
export function availableCount(credits: ResetCredits | undefined, nowSeconds: number): number {
  if (!credits) return 0;
  const expired = credits.credits.length - liveCredits(credits, nowSeconds).length;
  return Math.max(0, credits.available - expired);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Time left to a deadline, to the second: "6d 16:15:42", or "04:05:09" under a day. */
export function clockCountdown(deadline: number, nowSeconds: number): string {
  const left = Math.max(0, Math.floor(deadline - nowSeconds));
  const d = Math.floor(left / 86_400), h = Math.floor((left % 86_400) / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}

/** The exact deadline in the viewer's time zone: "Wed, Oct 28, 2026, 4:06:55 PM PDT". */
export function exactDeadline(deadline: number, timeZone?: string): string {
  return new Date(deadline * 1000).toLocaleString([], {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short", timeZone,
  });
}

/** What the provider said after a reset was asked for. */
export type ResetOutcome = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

export function outcomeLine(outcome: ResetOutcome, provider: string): { text: string; tone: "info" | "error" } {
  switch (outcome) {
    case "reset": return { text: `${provider} usage was reset. One reset credit was used.`, tone: "info" };
    case "already_redeemed": return { text: `That ${provider} reset had already gone through.`, tone: "info" };
    case "nothing_to_reset": return { text: `${provider} had nothing to reset yet, so the credit was kept.`, tone: "info" };
    case "no_credit": return { text: `${provider} has no reset credits left.`, tone: "error" };
  }
}
