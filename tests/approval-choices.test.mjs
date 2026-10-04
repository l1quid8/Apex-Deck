import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_CHOICES, decisionFor } from "../src/approvalChoices.ts";

test("every card offers Allow once, Always allow and Deny", () => {
  assert.deepEqual(APPROVAL_CHOICES, ["once", "always", "deny"]);
});

test("each answer maps to the backend's decision", () => {
  assert.deepEqual(decisionFor("once"), { approve: true, always: false });
  assert.deepEqual(decisionFor("always"), { approve: true, always: true });
  assert.deepEqual(decisionFor("deny"), { approve: false, always: false });
});
