import type { Backend } from "./backend";
import type { Mode } from "./generated/protocol";
import type { GitOutcome, ThreadWorkflow } from "./gitChanges";

export type SuggestionsMode = Mode;
export function suggestionsMode(raw: unknown): SuggestionsMode {
  const mode = (raw as { replySuggestions?: unknown } | null)?.replySuggestions;
  return mode === "off" || mode === "next_steps" ? mode : "decision_card";
}

export interface ReplyDecision {
  key: string;
  kind: "question" | "merge" | "fix_checks" | "fix_failed" | "merging";
  context: string;
  question: string;
  primary?: string;
  turns: number;
  dismissible: boolean;
  cancellable: boolean;
  detail?: string;
  head?: string;
  pr?: number;
  to?: string;
  prompt?: string;
  /** Why the main button is off: what GitHub would refuse, found before asking. */
  blocked?: string;
  /** A pull request's checks, conflicts and review, one row each. */
  status?: PullStatusLine[];
}
export interface PullStatusLine { label: string; text: string; state: "ok" | "wait" | "bad" | "unknown" }

/** A pull request's card under an assistant's reply that mentions it. */
export interface ShipOffer {
  pr: number;
  messageId: string;
  state: "ready" | "waiting" | "blocked" | "merging" | "merged";
  room?: string;
  checkout?: Pick<ThreadWorkflow, "generation" | "root" | "branch" | "repo">;
  card?: ReplyDecision | null;
  /** A merged pull request: what Deck knows about how it ended. */
  message?: string;
}
/** Whether a conversation's recent replies name a pull request at all, so nothing is asked when none do. */
export function mentionsPullRequest(texts: string[]): boolean {
  return texts.some(text => /\bPR\s*#?\d|\/pull\/\d|\bpull request\s*#?\d/i.test(text));
}
export interface ReplyOffer {
  mode: SuggestionsMode;
  replySeq: number | null;
  checkout: Pick<ThreadWorkflow, "generation" | "root" | "branch" | "repo"> | null;
  decision: ReplyDecision | null;
}

export async function actOnDecision(backend: Backend, id: string, shown: ReplyOffer, dismiss: boolean) {
  const card = shown.decision;
  if (!card) throw new Error("This decision is no longer available.");
  if (dismiss) {
    await backend.call("room_reply_decision_dismiss", { id, key: card.key });
    return "";
  }
  // Cancel addresses the original workflow generation even if the latest reply or mode changed.
  // Host reconciles it with GitHub and returns the actual outcome if the merge already landed.
  if (card.kind !== "merging") {
    const fresh = await backend.call<ReplyOffer>("room_reply_decision", { id });
    if (fresh.decision?.key !== card.key || fresh.decision.pr !== card.pr)
      throw new Error("This decision changed. Review the updated reply.");
  }
  if (card.kind === "question" && card.to && card.prompt) {
    await backend.call("room_post_to", { id, targets: [card.to], text: card.prompt, decisionKey: card.key });
    return "Sent to the agent.";
  }
  if (card.kind === "question") throw new Error("There is no executable action.");
  const kind = ({ merge: "merge_ready", fix_checks: "fix_checks", fix_failed: "ask_fix", merging: "cancel_merge" } as const)[card.kind];
  if (!kind || (kind === "cancel_merge" && !card.cancellable))
    throw new Error("This action is no longer available.");
  // The card names the merge request it showed, which may be in an agent's task
  // folder; the Mac checks that folder's HEAD itself.
  const checkout = shown.checkout;
  if (!checkout || !card.head) throw new Error("The checkout or merge request changed. Refresh the decision.");
  const expected = { root: checkout.root, branch: checkout.branch, repo: checkout.repo, generation: checkout.generation, head: card.head };
  const result = await backend.call<GitOutcome>("room_thread_git_action", { id, action: { kind, expected } });
  return result.message;
}

// Hide the protocol line from completed reply prose, keeping a trailing Git receipt.
export function visibleReply(text: string): string {
  if (!text.includes("Deck asks: ")) return text;
  return text.replace(/(?:^|\n)Deck asks: [^\n|`]{7,159}\? \| [^\n|`]{2,40}(?=\s*(?:\nDeck (?:built|ship|review passed) [0-9a-f]{40}\s*)?$)/u, "").trimEnd();
}
