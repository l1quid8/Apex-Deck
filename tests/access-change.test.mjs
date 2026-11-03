import test from "node:test";
import assert from "node:assert/strict";
import { applyNowFirst } from "../src/accessChange.ts";

test("Apply now leads when access goes down, and waits when it goes up", () => {
  assert.equal(applyNowFirst("full", "read"), true);
  assert.equal(applyNowFirst("edits", "ask"), true);
  assert.equal(applyNowFirst("read", "full"), false);
  assert.equal(applyNowFirst("ask", "edits"), false);
});
