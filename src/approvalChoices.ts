export type Answer = "once" | "always" | "deny";

/** The buttons every approval card shows, in order. */
export const APPROVAL_CHOICES: Answer[] = ["once", "always", "deny"];

export const ANSWER_LABEL: Record<Answer, { ask: string; done: string }> = {
  once: { ask: "Allow once", done: "Allowed once" },
  always: { ask: "Always allow", done: "Always allowed" },
  deny: { ask: "Deny", done: "Denied" },
};

/** What the backend is told: whether to go ahead, and whether to stop asking. */
export function decisionFor(answer: Answer): { approve: boolean; always: boolean } {
  return { approve: answer !== "deny", always: answer === "always" };
}
