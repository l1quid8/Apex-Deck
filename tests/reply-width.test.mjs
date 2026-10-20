import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const rule = (selector) => {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `missing rule for ${selector}`);
  return css.slice(at + 1, css.indexOf("}", at) + 1);
};

test("a finished message stays inside its row when a line can't wrap", () => {
  // Message rows are grids with a start- or end-aligned bubble, which grows to
  // its longest unbroken line. Step rows never wrap, so opening "N steps" on a
  // reply with a long command pushed it past the column and the thread
  // scrolled sideways, in every skin. Capped at the row, the step's ellipsis
  // takes the rest, and a wide table scrolls inside its own box.
  assert.equal(rule(".message-row > .bubble"), ".message-row > .bubble { min-width: 0; max-width: 100%; }");
});
