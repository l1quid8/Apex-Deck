import test from "node:test";
import assert from "node:assert/strict";
import { applyNowFirst, canApplyAccessNow } from "../src/accessChange.ts";

test("Apply now leads when access goes down, and waits when it goes up", () => {
  assert.equal(applyNowFirst("full", "read"), true);
  assert.equal(applyNowFirst("edits", "ask"), true);
  assert.equal(applyNowFirst("read", "full"), false);
  assert.equal(applyNowFirst("ask", "edits"), false);
});

test("Antigravity is not offered a restart it couldn't honour", () => {
  assert.equal(canApplyAccessNow({ backend: { kind: "agent", tool: "gemini" } }), false);
  assert.equal(canApplyAccessNow({ backend: { kind: "agent", tool: "claude_code" } }), true);
  assert.equal(canApplyAccessNow({ backend: { kind: "open_ai_compatible" } }), true);
});
