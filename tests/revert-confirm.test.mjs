import test from "node:test";
import assert from "node:assert/strict";
import { goBackAsks, goBackRequest, goBackTitle, initialFiles, failedLine } from "../src/revertConfirm.ts";

const plan = (files, available = true) => ({ available, note: null, files, skipped: [], effects: [] });
const a = { path: "a.txt", delete: false, conflict: false };
const shared = { path: "shared.txt", delete: true, conflict: true };

test("Allow always skips the question unless someone else changed the same file", () => {
  assert.equal(goBackAsks(false, plan([a])), true);
  assert.equal(goBackAsks(true, plan([a])), false);
  assert.equal(goBackAsks(true, plan([a, shared])), true);
});

test("every file starts ticked, conflicts included", () => {
  assert.deepEqual(initialFiles(plan([a, shared])), ["a.txt", "shared.txt"]);
  assert.deepEqual(initialFiles(plan([], false)), []);
});

test("each scope sends the chat, the ticked files, or both", () => {
  const p = plan([a, shared]);
  assert.deepEqual(goBackRequest("both", p, ["a.txt"]), { chat: true, files: ["a.txt"] });
  assert.deepEqual(goBackRequest("chat", p, ["a.txt"]), { chat: true, files: [] });
  assert.deepEqual(goBackRequest("files", p, ["a.txt", "shared.txt"]), { chat: false, files: ["a.txt", "shared.txt"] });
  assert.deepEqual(goBackRequest("both", plan([a], false), ["a.txt"]), { chat: true, files: [] });
});

test("the title says whether files go back", () => {
  assert.match(goBackTitle("retry", plan([a]), "Jigga"), /since Jigga started/);
  assert.doesNotMatch(goBackTitle("revert", plan([]), "you"), /files/);
  assert.equal(failedLine([]), null);
  assert.match(failedLine(["x", "y"]), /2 files/);
});
