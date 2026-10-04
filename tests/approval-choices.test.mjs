import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalChoices, decisionFor } from "../src/approvalChoices.ts";

const plain = { kind: "other", title: "node_repl asks permission", detail: "Allow Computer Use to use \"Apex Deck\"?" };
const rememberable = { ...plain, always: true };

test("Always allow appears only when the tool offers to remember", () => {
  assert.deepEqual(approvalChoices(rememberable), ["once", "always", "deny"]);
  assert.deepEqual(approvalChoices(plain), ["once", "deny"]);
  assert.deepEqual(approvalChoices({ ...plain, always: false }), ["once", "deny"]);
});

test("each answer maps to the backend's decision", () => {
  assert.deepEqual(decisionFor("once", rememberable), { approve: true, always: false });
  assert.deepEqual(decisionFor("always", rememberable), { approve: true, always: true });
  assert.deepEqual(decisionFor("deny", rememberable), { approve: false, always: false });
});

test("always never reaches the backend for an action that can't be remembered", () => {
  assert.deepEqual(decisionFor("always", plain), { approve: true, always: false });
});
