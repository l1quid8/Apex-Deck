import type { AllowedRule, ProposedAction } from "./types";

/** The rule an "Always allow" makes. Mirrors `AllowedRule::new` in apex-core:
 *  a tool or an edit is matched by its title, a command or permission question
 *  by its detail, so allowing one app or command doesn't allow another. */
export function ruleFor(by: string, action: ProposedAction): AllowedRule {
  const what = action.kind === "tool" || action.kind === "edit" ? action.title : action.detail;
  return { by, kind: action.kind, title: action.title, what };
}

export function sameRule(a: AllowedRule, b: AllowedRule): boolean {
  return a.by === b.by && a.kind === b.kind && a.what === b.what;
}

/** One line for the list in thread details: what was allowed, without repeating the title. */
export function describeRule(rule: AllowedRule): string {
  if (rule.kind === "command") return rule.what;
  if (rule.kind === "other") return rule.what.split("\n")[0];
  return rule.title;
}
