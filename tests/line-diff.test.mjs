import test from "node:test";
import assert from "node:assert/strict";
import { compact, diffCounts, lineDiff } from "../src/lineDiff.ts";

const signs = (lines) => lines.map((l) => `${l.sign}${l.text}`);

test("unchanged text is all context", () => {
  assert.deepEqual(signs(lineDiff("a\nb", "a\nb")), [" a", " b"]);
});

test("changed lines show removals before additions, between unchanged ones", () => {
  const before = '<p class="brand">\n<h1>Welcome</h1>\n<p>Thanks</p>\n<a>Open</a>';
  const after = '<p class="brand">\n<h1>Your next idea.</h1>\n<p>Add a workspace</p>\n<a>Open</a>';
  assert.deepEqual(signs(lineDiff(before, after)), [' <p class="brand">', "-<h1>Welcome</h1>", "-<p>Thanks</p>", "+<h1>Your next idea.</h1>", "+<p>Add a workspace</p>", " <a>Open</a>"]);
  assert.deepEqual(diffCounts(lineDiff(before, after)), { added: 2, removed: 2 });
});

test("lines added in the middle keep everything around them", () => {
  assert.deepEqual(signs(lineDiff("a\nd", "a\nb\nc\nd")), [" a", "+b", "+c", " d"]);
});

test("a diff too big to compare shows all removed then all added", () => {
  const before = Array.from({ length: 2100 }, (_, i) => `a${i}`).join("\n");
  const after = Array.from({ length: 2100 }, (_, i) => `b${i}`).join("\n");
  const lines = lineDiff(before, after);
  assert.equal(lines.length, 4200);
  assert.equal(lines[0].sign, "-");
  assert.equal(lines[4199].sign, "+");
});

test("long unchanged stretches fold to a count, keeping three lines each side", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
  const rows = compact(lineDiff(before, before.replace("f", "F")));
  assert.deepEqual(rows.map((r) => ("skipped" in r ? `…${r.skipped}` : `${r.sign}${r.text}`)), ["…2", " c", " d", " e", "-f", "+F", " g", " h", " i", "…1"]);
});
