import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("the title bar wraps instead of running past the window edge", () => {
  assert.match(css, /\n\.titlebar \{ flex-wrap: wrap; row-gap: 8px; \}/);
});

test("below 880px the tabs take their own row and the brand name stays", () => {
  assert.match(css, /@media \(max-width: 880px\) \{\s*\.titlebar > \.section-navigation \{ order: 5; width: 100%;/);
  assert.match(css, /@media \(max-width: 960px\) and \(min-width: 881px\) \{\s*\.titlebar-start > \.brand \{ font-size: 0;/);
});
