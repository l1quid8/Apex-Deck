import type { ProposedAction } from "./types";

export type Answer = "once" | "always" | "deny";

/** The buttons an approval card shows, in order. "Always allow" only when
 *  the tool offered to remember the answer; Deck never offers it for risky tools. */
export function approvalChoices(action: ProposedAction): Answer[] {
  return action.always ? ["once", "always", "deny"] : ["once", "deny"];
}

export const ANSWER_LABEL: Record<Answer, { ask: string; done: string }> = {
  once: { ask: "Allow once", done: "Allowed once" },
  always: { ask: "Always allow", done: "Always allowed" },
  deny: { ask: "Deny", done: "Denied" },
};

/** What the backend is told: whether to go ahead, and whether to remember it. */
export function decisionFor(answer: Answer, action: ProposedAction): { approve: boolean; always: boolean } {
  return { approve: answer !== "deny", always: answer === "always" && action.always === true };
}
