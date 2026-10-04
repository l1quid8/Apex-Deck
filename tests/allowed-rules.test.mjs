import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedLine, describeRule, removedLine, ruleFor, sameRule } from "../src/allowedRules.ts";

const app = (name) => ({ kind: "other", title: "cua_repl asks permission", detail: `Allow Computer Use to use "${name}"?\n\nApp: com.example\nRequested by: cua_repl` });
const order = (qty) => ({ kind: "tool", title: "robinhood: place_order", detail: `{"qty":${qty}}` });

test("a rule covers the same tool with any arguments, but not another app", () => {
  assert.ok(sameRule(ruleFor("codex", order(1)), ruleFor("codex", order(5))));
  assert.ok(!sameRule(ruleFor("codex", app("Brave Browser")), ruleFor("codex", app("Calculator"))));
  assert.ok(!sameRule(ruleFor("codex", order(1)), ruleFor("claude", order(1))), "another bot");
});

test("the list shows what was allowed in one line", () => {
  assert.equal(describeRule(ruleFor("codex", app("Brave Browser"))), 'Allow Computer Use to use "Brave Browser"?');
  assert.equal(describeRule(ruleFor("codex", order(1))), "robinhood: place_order");
  assert.equal(describeRule(ruleFor("codex", { kind: "command", title: "Run a command", detail: "npm test" })), "npm test");
});

const oct4 = new Date(2026, 9, 4, 12, 0, 0);
const at = (date) => Math.floor(date.getTime() / 1000);

test("a new rule records when it was allowed and whether it was risky", () => {
  const rule = ruleFor("null", { ...order(1), risky: true }, at(oct4));
  assert.equal(rule.allowed_at, at(oct4));
  assert.equal(rule.risky, true);
  assert.equal(ruleFor("null", order(1)).risky, false);
  assert.ok(sameRule(rule, ruleFor("null", order(5), 0)), "the date and the risk are labels, not part of the match");
});

test("rows say when a rule was allowed, with the year only when it isn't this year", () => {
  const rule = ruleFor("null", { kind: "command", title: "Run a command", detail: "npm test" }, at(new Date(2026, 9, 3, 9)));
  assert.equal(allowedLine(rule, oct4), "Allowed Oct 3");
  assert.equal(allowedLine({ ...rule, allowed_at: at(new Date(2025, 11, 31, 9)) }, oct4), "Allowed Dec 31, 2025");
  assert.equal(allowedLine({ ...rule, risky: true }, oct4), "Allowed Oct 3 · can spend money or publish");
});

// Review Focus 1
test("rules saved before dates were kept read Allowed earlier", () => {
  const old = { by: "null", kind: "tool", title: "x-mcp: post_tweet", what: "x-mcp: post_tweet" };
  assert.equal(allowedLine(old, oct4), "Allowed earlier");
  // What the desktop app sends for that rule: Rust reads it as allowed_at 0, risky true.
  assert.equal(allowedLine({ ...old, allowed_at: 0, risky: true }, oct4), "Allowed earlier · can spend money or publish");
});

test("after Remove the list says the bot asks again", () => {
  assert.equal(removedLine("Null"), "Removed. Null asks again next time.");
});
