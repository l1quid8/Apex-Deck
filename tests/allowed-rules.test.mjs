import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRule, ruleFor, sameRule } from "../src/allowedRules.ts";

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
