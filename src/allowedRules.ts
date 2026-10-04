import { RISKY_NOTE } from "./approvalChoices.ts";
import type { AllowedRule, ProposedAction } from "./types";

/** How long "Removed. Null asks again next time." stays after Remove. */
export const REMOVED_NOTE_MS = 8000;

/** The rule an "Always allow" makes. Mirrors `AllowedRule::new` in apex-core:
 *  a tool or an edit is matched by its title, a command or permission question
 *  by its detail, so allowing one app or command doesn't allow another. */
export function ruleFor(by: string, action: ProposedAction, nowSeconds = Math.floor(Date.now() / 1000)): AllowedRule {
  const what = action.kind === "tool" || action.kind === "edit" ? action.title : action.detail;
  return { by, kind: action.kind, title: action.title, what, allowed_at: nowSeconds, risky: action.risky === true };
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The row's second line: "Allowed Oct 4", with the year when it isn't this
 *  year, plus " · can spend money or publish" for a risky rule. Rules saved
 *  before dates were kept read "Allowed earlier". */
export function allowedLine(rule: AllowedRule, now: Date): string {
  let when = "Allowed earlier";
  if (rule.allowed_at) {
    const at = new Date(rule.allowed_at * 1000);
    when = `Allowed ${MONTHS[at.getMonth()]} ${at.getDate()}${at.getFullYear() === now.getFullYear() ? "" : `, ${at.getFullYear()}`}`;
  }
  return rule.risky ? when + RISKY_NOTE : when;
}

/** Said under the list after Remove. */
export function removedLine(name: string): string {
  return `Removed. ${name} asks again next time.`;
}
