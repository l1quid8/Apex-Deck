import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

// Add to chat / More details over text picked inside one message: one component, drawn by the
// desktop over the text and by the phone on the side iPhone's own Copy menu leaves free.

register(new URL("./helpers/tsx-loader.mjs", import.meta.url), { parentURL: import.meta.url });
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SelectionActions } = await import("../src/SelectionActions.tsx");

const noop = () => {};
const bubble = (over = {}) => renderToStaticMarkup(React.createElement(SelectionActions, { x: 10, y: 20, canExplain: true, onAdd: noop, onExplain: noop, ...over }));

test("the desktop's bubble: a toolbar with Add to chat, then More details", () => {
  assert.equal(bubble(), '<span class="selection-actions" role="toolbar" aria-label="Selected text" style="left:10px;top:20px"><button type="button">Add to chat</button><button type="button">More details</button></span>');
});

test("More details waits until a bot can answer", () => {
  assert.match(bubble({ canExplain: false }), /<button type="button">Add to chat<\/button><button type="button" disabled="">More details<\/button>/);
});

test("the phone's names its side", () => {
  assert.match(bubble({ side: "below" }), /^<span class="selection-actions below" role="toolbar" aria-label="Selected text"/);
  assert.match(bubble({ side: "above" }), /^<span class="selection-actions above" role="toolbar" aria-label="Selected text"/);
});

test("the desktop and the phone both draw this one", () => {
  const desktop = readFileSync(new URL("../src/ChatPane.tsx", import.meta.url), "utf8");
  const phone = readFileSync(new URL("../src/phone/PickedText.tsx", import.meta.url), "utf8");
  assert.match(desktop, /<SelectionActions /);
  assert.doesNotMatch(desktop, /className="selection-actions"/);
  assert.match(phone, /<SelectionActions [^>]*side=\{picked\.side\}/);
});

test("a queued message taken back, or one that couldn't be sent, returns to the box with its quotes", () => {
  const source = readFileSync(new URL("../src/phone/PhoneApp.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("const entry: QueuedDraft = { draft, quotes: sentQuotes, inBox: true };"), "Send keeps the quotes with what it was typed as");
  assert.ok(/if \(sent\?\.quotes\.length\) setQuotes\(.*quotesBack\(/.test(source), "taking one back puts its quotes back");
});
