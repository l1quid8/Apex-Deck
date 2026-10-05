// Retry (on a bot's reply) and Revert (on your message) delete the chat from
// that point and put this thread's files back. Both ask first unless you
// chose "Allow always"; they still ask when another change touched the same
// files, because which version to keep is your call.

import type { RevertPlan } from "./types";

/** Retry: that bot answers again. Revert: your text goes back in the composer. */
export type GoBack = "retry" | "revert";

/** What a Revert puts back. Retry always does both. */
export type RevertScope = "both" | "chat" | "files";

const key = (kind: GoBack) => `apex-deck.${kind}.always`;

export function goBackAlways(kind: GoBack): boolean {
  try { return localStorage.getItem(key(kind)) === "1"; } catch { return false; }
}

export function saveGoBackAlways(kind: GoBack, always: boolean) {
  try { if (always) localStorage.setItem(key(kind), "1"); else localStorage.removeItem(key(kind)); } catch { /* private mode */ }
}

/** True when the confirmation should show. */
export function goBackAsks(always: boolean, plan: RevertPlan): boolean {
  return !always || plan.files.some((file) => file.conflict);
}

/** Files ticked to go back: all of them, including ones someone else also changed. */
export function initialFiles(plan: RevertPlan): string[] {
  return plan.available ? plan.files.map((file) => file.path) : [];
}

/** What to send the backend for a choice. */
export function goBackRequest(scope: RevertScope, plan: RevertPlan, ticked: readonly string[]): { chat: boolean; files: string[] } {
  const files = plan.available && scope !== "chat" ? plan.files.map((f) => f.path).filter((p) => ticked.includes(p)) : [];
  return { chat: scope !== "files", files };
}

/** The confirmation's first line. */
export function goBackTitle(kind: GoBack, plan: RevertPlan, who: string): string {
  const files = plan.available && plan.files.length > 0;
  if (kind === "retry") return files ? `Retry deletes this reply and everything after it, and puts back the files changed since ${who} started.` : "Retry deletes this reply and everything after it.";
  return files ? "Revert deletes everything after your message and puts back the files this thread changed since." : "Revert deletes everything after your message.";
}

/** A short line under a failed or partial file restore. */
export function failedLine(failed: readonly string[]): string | null {
  if (failed.length === 0) return null;
  return `Couldn't put back ${failed.length === 1 ? failed[0] : `${failed.length} files`}; ${failed.length === 1 ? "it was" : "they were"} left as they are.`;
}
