import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "sucrase";
import { cardKey, fingerprint } from "../src/interactiveAnswers/contract.ts";
import { evaluate, formatValue, inputText, resolveInputs, resultLine } from "../src/interactiveAnswers/comparison.ts";
import { readCard } from "../src/interactiveAnswers/schema.ts";
import { snapshotText } from "../src/interactiveAnswers/share.ts";
import { source, variant } from "./interactive-answers-fixture.mjs";

// The components run with a stand-in React that returns plain objects, as in
// attached-media-component.test.mjs: imports are stripped and what they gave is passed in.
const React = { Fragment: "Fragment", createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
function load(file, names, deps) {
  const code = fs.readFileSync(new URL(`../src/interactiveAnswers/${file}`, import.meta.url), "utf8");
  const compiled = transform(code.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), { transforms: ["typescript", "jsx"], jsxRuntime: "classic" }).code;
  return new Function("React", ...Object.keys(deps), `${compiled}\nreturn { ${names.join(", ")} };`)(React, ...Object.values(deps));
}
const { AnswerCard, PreparingCard, CardFallback } = load("AnswerCard.tsx", ["AnswerCard", "PreparingCard", "CardFallback"], {
  Fragment: "Fragment", useId: () => "g1", evaluate, formatValue, inputText, resolveInputs, resultLine, snapshotText,
});
class Component { constructor(props) { this.props = props; } }
const { ThreadCard, CardBoundary } = load("ThreadCard.tsx", ["ThreadCard", "CardBoundary"], {
  Component, useEffect: () => {}, useMemo: (make) => make(), useState: (start) => [start, () => {}], AnswerCard, CardFallback, cardKey, fingerprint, readCard,
});

const find = (node, match) => findAll(node, match)[0] ?? null;
function findAll(node, match, found = []) {
  if (Array.isArray(node)) node.forEach((child) => findAll(child, match, found));
  else if (node && typeof node === "object") {
    if (match(node)) found.push(node);
    findAll(node.children, match, found);
  }
  return found;
}
const text = (node) => (node == null || typeof node === "boolean" ? "" : typeof node !== "object" ? String(node) : Array.isArray(node) ? node.map(text).join("") : text(node.children));
const card = readCard(source).card;
const range = (tree) => find(tree, (n) => n.type === "input" && n.props.type === "range");

test("the example card shows its settings, the options side by side, the best fit and the result", () => {
  const tree = AnswerCard({ card, version: 2, author: "Null", values: null, onChange() {}, onDiscuss() {}, onOpen() {} });
  const slider = range(tree).props;
  assert.deepEqual([slider.min, slider.max, slider.step, slider.value, slider.disabled], [50, 500, 25, 250, false]);
  assert.equal(find(tree, (n) => n.type === "input" && n.props.type === "radio" && n.props.checked).props.value, "ease");
  assert.deepEqual(findAll(tree, (n) => n.type === "article").map((n) => n.props.className), ["answer-option", "answer-option best", "answer-option"]);
  assert.equal(text(find(tree, (n) => n.props.className === "answer-eyebrow")), "Interactive comparison · v2 · Null");
  assert.equal(text(find(tree, (n) => n.props.className === "answer-result")), "Best fit: Managed (priority: Simplicity).");
});

test("a lower budget puts an option out and moves the best fit", () => {
  const changes = [];
  range(AnswerCard({ card, version: 1, author: "Null", values: null, onChange: (v) => changes.push(v), onOpen() {} })).props.onChange({ target: { value: "100" } });
  assert.deepEqual(changes, [{ budget: 100, priority: "ease" }]);
  const [vps, managed, serverless] = findAll(AnswerCard({ card, version: 1, author: "Null", values: changes[0], onChange() {}, onOpen() {} }), (n) => n.type === "article");
  assert.equal(managed.props.className, "answer-option out");
  assert.match(text(managed), /Above monthly budget/);
  assert.equal(serverless.props.className, "answer-option best");
  assert.match(text(vps), /Ranked #2/);
});

test("Reset goes back to the defaults and Discuss hands over the snapshot", () => {
  const changes = [];
  const shared = [];
  const tree = AnswerCard({ card, version: 1, author: "Null", values: { budget: 100, priority: "cost" }, onChange: (v) => changes.push(v), onDiscuss: (s) => shared.push(s), onOpen() {} });
  const button = (label) => find(tree, (n) => n.type === "button" && text(n) === label);
  button("Reset").props.onClick();
  button("Discuss these settings").props.onClick();
  assert.deepEqual(changes, [{ budget: 250, priority: "ease" }]);
  assert.deepEqual(shared, [snapshotText(card, { budget: 100, priority: "cost" }, 1, "Null")]);
});

test("without onChange the card is read-only: controls off and no buttons", () => {
  const tree = AnswerCard({ card, version: 1, author: "Null", values: null, onOpen() {} });
  assert.equal(range(tree).props.disabled, true);
  assert.equal(find(tree, (n) => n.type === "fieldset").props.disabled, true);
  assert.equal(find(tree, (n) => n.type === "button"), null);
});

test("a source link opens through the chat's own link handler", () => {
  const opened = [];
  let prevented = false;
  const tree = AnswerCard({ card, version: 1, author: "Null", values: null, onOpen: (target) => opened.push(target) });
  find(tree, (n) => n.type === "a").props.onClick({ preventDefault: () => { prevented = true; } });
  assert.deepEqual([opened, prevented], [["https://example.com/pricing"], true]);
});

test("while a reply is being written the card is a placeholder with no controls", () => {
  const tree = PreparingCard({ author: "Null" });
  assert.match(text(tree), /Preparing interactive answer…/);
  assert.equal(find(tree, (n) => n.type === "input" || n.type === "button"), null);
});

test("a block that isn't a card shows the fallback with its reason", () => {
  const tree = ThreadCard({ source: "{oops", seq: 4, author: "Null", versions: new Map(), answers: null, onOpen() {} });
  assert.equal(tree.type, CardFallback);
  assert.equal(tree.props.reason, "The card isn't valid JSON.");
});

function fakeStore(saved) {
  const calls = [];
  return {
    calls,
    values: (key, print) => (saved[key]?.fingerprint === print ? saved[key].inputs : null),
    set: (...args) => calls.push(args),
    status: () => "Saved just now",
    subscribe: () => () => {},
  };
}

test("saved settings reach the card only when they were set on this exact card", () => {
  const answers = fakeStore({ "4:hosting": { fingerprint: fingerprint(source), inputs: { budget: 100, priority: "ease" } } });
  const drawn = (text) => ThreadCard({ source: text, seq: 4, author: "Null", versions: new Map([["4:hosting", 3]]), answers, onDiscuss() {}, onOpen() {} }).children[0];
  const shown = drawn(source);
  assert.equal(shown.type, AnswerCard);
  assert.deepEqual([shown.props.values, shown.props.version, shown.props.status], [{ budget: 100, priority: "ease" }, 3, "Saved just now"]);
  assert.equal(drawn(variant((c) => { c.title = "Changed"; })).props.values, null);
  shown.props.onChange({ budget: 150, priority: "ease" });
  assert.deepEqual(answers.calls, [["4:hosting", fingerprint(source), { budget: 150, priority: "ease" }]]);
});

test("read-only cards show saved settings but can't change them or be discussed", () => {
  const shown = ThreadCard({ source, seq: 4, author: "Null", versions: new Map(), answers: fakeStore({}), readOnly: true, onDiscuss() {}, onOpen() {} }).children[0];
  assert.deepEqual([shown.props.onChange, shown.props.onDiscuss, shown.props.status], [undefined, undefined, undefined]);
});

test("a card that throws while it is drawn falls back instead of breaking the chat", () => {
  const boundary = new CardBoundary({ source: "{}", children: "card" });
  assert.equal(boundary.render(), "card");
  boundary.state = CardBoundary.getDerivedStateFromError();
  const fallback = boundary.render();
  assert.equal(fallback.type, CardFallback);
  assert.match(fallback.props.reason, /couldn't be drawn/);
});
