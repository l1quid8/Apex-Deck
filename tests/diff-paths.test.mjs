import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDiffPath, sameDiffPath } from "../src/diffPaths.ts";

// Prod shape: adapters report absolute paths, room_diff returns git-relative
// ones. Exact string matching made turn scope and auto-expand miss.
const CWD = "/Users/tylercaldwell/Downloads/apex-deck";

test("absolute change paths match git-relative diff paths", () => {
  assert.equal(sameDiffPath(CWD, `${CWD}/src/App.tsx`, "src/App.tsx"), true);
  assert.equal(normalizeDiffPath(CWD, `${CWD}/src/App.tsx`), "src/App.tsx");
});

test("leading ./ and dot segments match the same file", () => {
  assert.equal(sameDiffPath(CWD, "./src/App.tsx", "src/App.tsx"), true);
  assert.equal(sameDiffPath(CWD, "src/../src/App.tsx", "src/App.tsx"), true);
});

test("different files never match, even with the same basename", () => {
  assert.equal(sameDiffPath(CWD, "src/App.tsx", "other/App.tsx"), false);
  assert.equal(sameDiffPath(CWD, `${CWD}/src/App.tsx`, "src/App.tsx~"), false);
});

test("identical absolutes outside the workspace still match each other", () => {
  assert.equal(sameDiffPath(CWD, "/tmp/x.ts", "/tmp/x.ts"), true);
  assert.equal(sameDiffPath(CWD, "/tmp/x.ts", "src/x.ts"), false);
});

test("relative paths match without a workspace folder", () => {
  assert.equal(sameDiffPath(null, "./src/a.ts", "src/a.ts"), true);
  assert.equal(sameDiffPath(null, "/a/b.ts", "a/b.ts"), false);
});
