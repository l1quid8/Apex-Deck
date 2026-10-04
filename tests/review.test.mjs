import test from "node:test";
import assert from "node:assert/strict";
import {
  LARGE_REVIEW_LINES, filesLine, nextReviewNumber, offersSplit, patchLines, reviewDraft, reviewFileNames,
  reviewPatch, reviewPatches, reviewScope, reviewerRows, sizeLine,
} from "../src/review.ts";

const file = (path, patch, added = 1, removed = 0) => ({ path, added, removed, patch, by: [] });
const bot = (id, backend, access = "read") => ({ id, display_name: id[0].toUpperCase() + id.slice(1), backend, persona: "", access, effort: null });

test("the scope line counts what Changes lists", () => {
  const files = [file("a.ts", "x", 31, 5), file("b.ts", "y", 42, 11)];
  assert.equal(reviewScope(files), "Since this thread started · 2 files · +73 −16");
  assert.equal(filesLine([file("a.ts", "x")]), "1 file · +1 −0");
  assert.equal(filesLine([]), "0 files · +0 −0");
});

test("patches join into one file in the order Changes lists them, each ending its last line", () => {
  const files = [file("a.ts", "diff --git a/a.ts b/a.ts\n+a\n"), file("b.ts", "diff --git a/b.ts b/b.ts\n+b")];
  assert.equal(reviewPatch(files), "diff --git a/a.ts b/a.ts\n+a\ndiff --git a/b.ts b/b.ts\n+b\n");
  assert.deepEqual(reviewPatches(files), ["diff --git a/a.ts b/a.ts\n+a\n", "diff --git a/b.ts b/b.ts\n+b\n"]);
  assert.equal(patchLines("one\ntwo\n"), 2);
  assert.equal(patchLines("one\ntwo"), 2);
  assert.equal(patchLines(""), 0);
});

// Review Focus 3
test("changes with no patch text never make an empty patch file", () => {
  const reportedOnly = [file("a.ts", ""), file("b.ts", "  \n")];
  assert.equal(reviewPatch(reportedOnly), null);
  assert.deepEqual(reviewPatches(reportedOnly), []);
  assert.equal(reviewPatch([file("a.ts", ""), file("c.ts", "+c\n")]), "+c\n", "files without a patch are left out");
});

test("one file per patch is offered only over 2,000 lines", () => {
  assert.equal(LARGE_REVIEW_LINES, 2000);
  assert.equal(offersSplit(2000), false);
  assert.equal(offersSplit(2001), true);
  assert.equal(sizeLine(3412), "3,412 lines in one file");
});

test("review files are numbered after the highest number the thread already used", () => {
  assert.equal(nextReviewNumber([]), 1);
  assert.equal(nextReviewNumber(["@ada Review this change.\n\nAttached file: /x/review-since-start-2.patch", "review-since-start-1.patch"]), 3);
  assert.deepEqual(reviewFileNames(3, 1), ["review-since-start-3.patch"]);
  assert.deepEqual(reviewFileNames(3, 2), ["review-since-start-3-1.patch", "review-since-start-3-2.patch"]);
});

// Review Focus 4
test("picking a reviewer keeps a draft you already typed", () => {
  assert.equal(reviewDraft("ada", ""), "@ada Review this change.");
  assert.equal(reviewDraft("ada", "  "), "@ada Review this change.");
  assert.equal(reviewDraft("ada", "Focus on the token refresh."), "@ada Review this change.\n\nFocus on the token refresh.");
});

test("read-only bots come first, and each row says what the bot can do", () => {
  const rows = reviewerRows([
    bot("jigga", { kind: "agent", tool: "claude_code", model: "opus" }, "ask"),
    bot("ada", { kind: "agent", tool: "gemini", model: null }),
    bot("null", { kind: "agent", tool: "codex", model: null }, "full"),
    bot("opus", { kind: "open_ai_compatible", base_url: "http://localhost:11434/v1", model: "llama3", api_key_env: null }),
    bot("tool", { kind: "cli", program: "mytool", args: [] }),
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.label, r.note]), [
    ["Ada", "Gemini CLI · Read only", ""],
    ["Opus", "API · Read only", "Can't read attachments"],
    ["Tool", "Command · Read only", ""],
    ["Jigga", "Claude Code", "Can edit files"],
    ["Null", "Codex", "Can edit files"],
  ]);
});
