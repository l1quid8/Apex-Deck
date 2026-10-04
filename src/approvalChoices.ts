import type { ProposedAction } from "./types";

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

/** Said after the kind of action when it can cost money or go public. */
export const RISKY_NOTE = " · can spend money or publish";

/** The card's small label: what kind of thing the bot wants, and whether it is risky. */
export function kindLabel(action: ProposedAction): string {
  const kind = action.kind === "edit" ? "Wants to change a file" : action.kind === "command" ? "Wants to run a command" : action.kind === "tool" ? "Wants to call an MCP tool" : "Wants permission";
  return action.risky ? kind + RISKY_NOTE : kind;
}

/**
 * What Always allow would let `name` do from now on in this thread, in the
 * terms the saved rule really matches (`AllowedRule::new` in apex-core): a
 * tool by its name with any arguments, a command or permission question by
 * its exact text, an edit by its title.
 */
export function scopeLine(name: string, action: ProposedAction): string {
  const lets = `Always allow lets ${name}`;
  const here = "in this thread without asking.";
  switch (action.kind) {
    case "tool":
      return `${lets} call ${action.title} in this thread with any arguments, without asking.`;
    case "command":
      return `${lets} run this exact command ${here}`;
    case "other":
      return `${lets} have this exact permission ${here}`;
  }
  if (action.title === "Edit files") return `${lets} make edits it doesn't describe ${here}`;
  const several = /^Edit (\d+) files$/.exec(action.title);
  if (several) return `${lets} make any ${several[1]}-file edit ${here}`;
  const one = /^(Edit|Write) (.+)$/.exec(action.title);
  if (one) return `${lets} ${one[1].toLowerCase()} ${one[2]} ${here}`;
  return `${lets} make any edit titled “${action.title}” ${here}`;
}
