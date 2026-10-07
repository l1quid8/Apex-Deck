import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_CHOICES, decisionFor, kindLabel, scopeLine } from "../src/approvalChoices.ts";

test("every card offers Allow once, Always allow and Deny", () => {
  assert.deepEqual(APPROVAL_CHOICES, ["once", "always", "deny"]);
});

test("each answer maps to the backend's decision", () => {
  assert.deepEqual(decisionFor("once"), { approve: true, always: false });
  assert.deepEqual(decisionFor("always"), { approve: true, always: true });
  assert.deepEqual(decisionFor("deny"), { approve: false, always: false });
});

const tweet = { kind: "tool", title: "x-mcp: post_tweet", detail: "{}", risky: true };

test("a risky card says it can spend money or publish", () => {
  assert.equal(kindLabel(tweet), "Wants to call an MCP tool · can spend money or publish");
  assert.equal(kindLabel({ kind: "command", title: "Run a command", detail: "ls" }), "Wants to run a command");
  assert.equal(kindLabel({ kind: "edit", title: "Edit a.ts", detail: "", risky: false }), "Wants to change a file");
  assert.equal(kindLabel({ kind: "other", title: "node_repl asks permission", detail: "x", risky: true }), "Wants permission · can spend money or publish");
});

// Review Focus 5
test("scope lines say what the rule really matches for every kind of card", () => {
  assert.equal(scopeLine("Null", tweet), "Always allow lets Null call x-mcp: post_tweet in this thread with any arguments, without asking.");
  assert.equal(scopeLine("Jigga", { kind: "command", title: "Run a command · needs network", detail: "npm test" }), "Always allow lets Jigga run this exact command in this thread without asking.");
  assert.equal(scopeLine("Jigga", { kind: "edit", title: "Edit src/auth/session.ts", detail: "" }), "Always allow lets Jigga edit src/auth/session.ts in this thread without asking.");
  assert.equal(scopeLine("Jigga", { kind: "edit", title: "Write notes.txt", detail: "" }), "Always allow lets Jigga write notes.txt in this thread without asking.");
  assert.equal(scopeLine("Null", { kind: "edit", title: "Edit 3 files", detail: "" }), "Always allow lets Null make any 3-file edit in this thread without asking.");
  assert.equal(scopeLine("Null", { kind: "edit", title: "Edit files", detail: "" }), "Always allow lets Null make edits it doesn't describe in this thread without asking.");
  assert.equal(scopeLine("Null", { kind: "other", title: "node_repl asks permission", detail: "Allow Computer Use to use \"Apex Deck\"?" }), "Always allow lets Null have this exact permission in this thread without asking.");
});

test("a start-the-work card offers Start the work and Keep planning, never Always allow", async () => {
  const { choicesFor, answerLabel } = await import("../src/approvalChoices.ts");
  const start = { kind: "plan", title: "Start the work?", detail: "1. Do it" };
  assert.deepEqual(choicesFor(start), ["once", "deny"]);
  assert.deepEqual(choicesFor(tweet), ["once", "always", "deny"]);
  assert.deepEqual(answerLabel(start, "once"), { ask: "Start the work", done: "Started" });
  assert.deepEqual(answerLabel(start, "deny"), { ask: "Keep planning", done: "Kept planning" });
  assert.deepEqual(answerLabel(tweet, "once"), { ask: "Allow once", done: "Allowed once" });
  assert.equal(kindLabel(start), "Has a plan");
});
