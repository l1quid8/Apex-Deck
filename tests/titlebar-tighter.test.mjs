import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const plain = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const glass = readFileSync(new URL("../src/glass-theme.css", import.meta.url), "utf8");
const block = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} block missing`);
  return css.slice(start, css.indexOf("}", start));
};

test("title bar paints nothing in the plain theme", () => {
  const b = block(plain, "\n.titlebar");
  assert.match(b, /background:\s*transparent/);
  assert.doesNotMatch(b, /border-bottom:\s*1px solid/);
});

test("title bar paints nothing in the glass theme", () => {
  const b = block(glass, ':root[data-deck-theme="glass"] .titlebar');
  assert.match(b, /background(-color)?:\s*transparent/);
  assert.match(b, /box-shadow:\s*none/);
  assert.doesNotMatch(b, /backdrop-filter:\s*blur/);
});
