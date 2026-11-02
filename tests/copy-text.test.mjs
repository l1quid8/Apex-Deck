import test from "node:test";
import assert from "node:assert/strict";
import { copyText, plainCopy } from "../src/copyText.ts";

const taken = () => { const seen = []; return { seen, route: async (text) => { seen.push(text); } }; };
const refused = async () => { const error = new Error("Write permission denied."); error.name = "NotAllowedError"; throw error; };

test("the shell's clipboard comes first, and a page permission never decides it", async () => {
  const native = taken(), page = taken();
  assert.equal(await copyText("x", { native: native.route, clipboard: { writeText: page.route } }), true);
  assert.deepEqual([native.seen, page.seen], [["x"], []]);
});

test("each route falls through to the next", async () => {
  const page = taken(), legacy = [];
  assert.equal(await copyText("x", { native: refused, clipboard: { writeText: page.route } }), true);
  assert.deepEqual(page.seen, ["x"]);
  assert.equal(await copyText("y", { clipboard: { writeText: refused }, legacy: (text) => { legacy.push(text); return true; } }), true);
  assert.deepEqual(legacy, ["y"]);
});

test("nothing took it means nothing was copied", async () => {
  assert.equal(await copyText("x", { native: refused, clipboard: { writeText: refused }, legacy: () => false }), false);
  assert.equal(await copyText("x", {}), false);
});

test("without a shell the Clipboard API is called inside the click", () => {
  let called = false;
  void copyText("x", { clipboard: { writeText: async () => { called = true; } } });
  assert.equal(called, true);
});

test("a quoted prompt copies without its markers, keeping lines and list dashes", () => {
  assert.equal(plainCopy("Send Null:\n\n> Fix the issue\n> - first\n>   - nested\n>\n> done"), "Send Null:\n\nFix the issue\n- first\n  - nested\n\ndone");
  assert.equal(plainCopy("> > twice"), "twice");
});

test("code keeps its own angle brackets", () => {
  const code = "```sh\n> not a quote\n```\n> quote";
  assert.equal(plainCopy(code), "```sh\n> not a quote\n```\nquote");
  assert.equal(plainCopy("> ```\n> > kept once\n> ```"), "```\n> kept once\n```");
});
