import test from "node:test";
import assert from "node:assert/strict";
import { TITLE_INTERVAL_MS, TitleThrottle, cleanTitle, nextTitle, programTitle } from "../src/terminalTitle.ts";

test("the first terminal of a tool keeps its name and the next is numbered", () => {
  assert.equal(nextTitle("Codex", []), "Codex");
  assert.equal(nextTitle("Codex", ["Claude Code"]), "Codex");
  assert.equal(nextTitle("Codex", ["Codex"]), "Codex 2");
  assert.equal(nextTitle("Codex", ["Codex", "Codex 2"]), "Codex 3");
});

test("numbering reuses a free name and ignores case and spaces", () => {
  assert.equal(nextTitle("Codex", ["Codex 2"]), "Codex");
  assert.equal(nextTitle("Codex", ["Codex", "Codex 3"]), "Codex 2");
  assert.equal(nextTitle("Codex", [" codex ", "CODEX 2"]), "Codex 3");
  assert.equal(nextTitle("Terminal", ["Terminal"]), "Terminal 2");
});

test("a program title keeps its words and loses the spinner in front", () => {
  assert.equal(cleanTitle("✳ Writing tests for auth"), "Writing tests for auth");
  assert.equal(cleanTitle("⠋ Writing tests for auth"), "Writing tests for auth");
  assert.equal(cleanTitle("Writing tests ⠙"), "Writing tests");
  assert.equal(cleanTitle("  · 3 · Reading src/App.tsx  "), "Reading src/App.tsx");
});

test("a program title is plain text on one line", () => {
  assert.equal(cleanTitle("Build\u0007ing\tnow\r\nplease"), "Build ing now please");
  assert.equal(cleanTitle("\u001b[31mRed\u001b[0m title"), "Red title");
  // Markup stays text (React never parses it); only the leading "<" goes, as a non-letter.
  assert.equal(cleanTitle("<b>bold</b> & co"), "b>bold</b> & co");
});

test("a title with nothing readable is empty", () => {
  assert.equal(cleanTitle(""), "");
  assert.equal(cleanTitle("⠋"), "");
  assert.equal(cleanTitle("✳ ✶ ✻"), "");
  assert.equal(cleanTitle("🚀🚀"), "");
  assert.equal(cleanTitle("12:04:55"), "");
});

test("a long title is cut to 60 characters with an ellipsis", () => {
  const long = `Refactoring ${"the session store ".repeat(30)}`;
  const shown = cleanTitle(long);
  assert.equal([...shown].length, 60);
  assert.ok(shown.endsWith("…"));
  assert.ok(shown.startsWith("Refactoring the session store"));
  const exactly60 = "a".repeat(60);
  assert.equal(cleanTitle(exactly60), exactly60);
  assert.equal([...cleanTitle(`${"é".repeat(70)}`)].length, 60);
});

test("a program title that only repeats the pane's or tool's name is not shown", () => {
  assert.equal(programTitle("Codex", ["Codex 2", "Codex", "codex"]), "");
  assert.equal(programTitle("claude code", ["Claude Code", "Claude Code", "claude"]), "");
  assert.equal(programTitle("Writing tests for auth", ["Codex", "Codex", "codex"]), "Writing tests for auth");
  assert.equal(programTitle("", ["Codex"]), "");
  assert.equal(programTitle("Reviewer", ["", "Terminal"]), "Reviewer");
});

/** Feeds titles in at the given times the way TerminalPane does: each new title
 *  cancels the pending timer, and a held title is shown when its timer fires. */
function play(arrivals) {
  const throttle = new TitleThrottle();
  const shown = [];
  let timer = null;
  const fireBefore = (limit) => {
    if (timer !== null && timer < limit) {
      const held = throttle.flush(timer);
      if (held !== null) shown.push([timer, held]);
      timer = null;
    }
  };
  for (const [at, title] of arrivals) {
    fireBefore(at);
    timer = null;
    const now = throttle.offer(title, at);
    if (now !== null) shown.push([at, now]);
    else timer = at + throttle.wait(at);
  }
  fireBefore(Infinity);
  return shown;
}

test("a spinner retitling every 30 ms shows at most four titles a second and ends on the last", () => {
  const arrivals = Array.from({ length: 34 }, (_, i) => [1000 + i * 30, `step ${i}`]);
  const shown = play(arrivals);
  assert.deepEqual(shown, [[1000, "step 0"], [1250, "step 8"], [1500, "step 16"], [1750, "step 25"], [2000, "step 33"]]);
  for (let i = 1; i < shown.length; i++) assert.ok(shown[i][0] - shown[i - 1][0] >= TITLE_INTERVAL_MS);
});

test("a held title waits for its turn and is shown only once", () => {
  const throttle = new TitleThrottle();
  assert.equal(throttle.offer("one", 0), "one");
  assert.equal(throttle.offer("two", 100), null);
  assert.equal(throttle.wait(100), 150);
  assert.equal(throttle.flush(200), null);
  assert.equal(throttle.flush(250), "two");
  assert.equal(throttle.flush(600), null);
  assert.equal(throttle.offer("three", 600), "three");
});
