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

test("title bar buttons scale to 0.75 without affecting other controls", () => {
  assert.match(plain, /\.titlebar\s*{[^}]*--tb-scale:\s*0\.75/);
  assert.match(plain, /\.titlebar button\s*{[^}]*padding:\s*calc\(7px \* var\(--tb-scale\)\)/);
  assert.match(plain, /\.titlebar button\.icon\s*{[^}]*font-size:\s*calc\(15px \* var\(--tb-scale\)\)/);
  assert.match(plain, /\.titlebar svg\s*{[^}]*width:\s*calc\(16px \* var\(--tb-scale\)\)/);
  assert.doesNotMatch(glass, /\.titlebar button\.icon\s*{[^}]*min-width:\s*34px/);
  assert.match(glass, /min-width:\s*calc\(34px \* var\(--tb-scale\)\)/);
  assert.match(glass, /min-height:\s*calc\(34px \* var\(--tb-scale\)\)/);
});
