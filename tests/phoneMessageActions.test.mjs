import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// The phone keeps the desktop's buttons, labels, order and classes, with only Quote/Reply
// and Copy exposed until the chevron opens. tests/message-actions-narrow.test.mjs covers desktop.

register(new URL("./helpers/tsx-loader.mjs", import.meta.url), { parentURL: import.meta.url });
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MessageActions, GoBackAsk } = await import("../src/phone/MessageActions.tsx");

const at = new Date(2026, 9, 21, 15, 4).getTime();
const bot = { seq: 4, speaker: { kind: "bot", id: "null" }, text: "Done. Tests pass.", at };
const mine = { seq: 3, speaker: { kind: "human" }, text: "Run the tests", at };
const noop = () => {};
const row = (message, over = {}) => renderToStaticMarkup(React.createElement(MessageActions, {
  message, who: "Null", shown: message.text, expanded: false, onToggle: noop, copied: false, onCopy: noop, onQuote: noop,
  pinned: false, pinning: false, onPin: noop, busy: false, onGoBack: noop, onFork: noop, asking: false, ...over,
}));
/** Each control in the row, in order, by its distinguishing class. */
const order = (html) => [...html.replace(/<span class="message-action-items" hidden="">[\s\S]*?<\/span>/g, "").matchAll(/<(?:button|time)[^>]*class="([^"]+)"/g)].map((m) => m[1].replace("msg-action ", ""));

test("a bot's collapsed row exposes only Quote and Copy beside the chevron and time", () => {
  assert.deepEqual(order(row(bot)), ["quote", "copy", "action-disclosure", "message-time"]);
});

test("a bot's chevron opens Read aloud, Pin, Retry and Fork before itself", () => {
  assert.deepEqual(order(row(bot, { expanded: true })), ["quote", "copy", "read-aloud", "pin-action", "retry", "fork", "action-disclosure", "message-time"]);
});

test("your collapsed row mirrors it with only Copy and Reply, even for a pinned message", () => {
  assert.deepEqual(order(row(mine, { pinned: true })), ["message-time", "action-disclosure", "copy", "quote"]);
  assert.deepEqual(order(row(mine, { expanded: true })), ["message-time", "action-disclosure", "fork", "revert", "pin-action", "copy", "quote"]);
});

test("labels match the desktop's", () => {
  const theirs = row(bot, { expanded: true });
  assert.match(theirs, /aria-label="Quote response from Null"/);
  assert.match(theirs, /aria-label="Copy message"/);
  assert.match(theirs, /aria-label="Read aloud"/);
  assert.match(theirs, /aria-label="Pin response"/);
  assert.match(theirs, /aria-label="Retry"/);
  assert.match(theirs, /aria-label="Fork from here"/);
  assert.match(theirs, /aria-label="Hide message actions"/);
  const yours = row(mine, { expanded: true, pinned: true });
  assert.match(yours, /aria-label="Quote your message"/);
  assert.match(yours, /aria-label="Unpin your message"/);
  assert.match(yours, /aria-pressed="true"/);
  assert.match(yours, /aria-label="Revert to here"/);
  assert.match(row(mine), /aria-label="Show message actions"/);
});

test("Copy reads Copied for a moment after it copies", () => {
  const html = row(bot, { copied: true });
  assert.match(html, /aria-label="Copied"/);
  assert.match(html, /<span class="copied">Copied<\/span>/);
});

test("Retry and Revert wait while a bot works", () => {
  assert.match(row(bot, { expanded: true, busy: true }), /<button[^>]*class="msg-action retry"[^>]*disabled=""[^>]*title="Stop the bots first"/);
  assert.match(row(mine, { expanded: true, busy: true }), /<button[^>]*class="msg-action revert"[^>]*disabled=""/);
});

test("no Fork where a thread can't be forked", () => {
  assert.deepEqual(order(row(bot, { expanded: true, onFork: undefined })), ["quote", "copy", "read-aloud", "pin-action", "retry", "action-disclosure", "message-time"]);
});

test("an older message without a time has no time", () => {
  const { at: _, ...old } = bot;
  assert.deepEqual(order(row(old)), ["quote", "copy", "action-disclosure"]);
});

test("the phone shows a compact clock with the complete date available to assistive tools", () => {
  for (const message of [bot, mine, { ...bot, at: new Date(2026, 8, 30, 15, 4).getTime() }]) {
    for (const expanded of [false, true]) {
      assert.match(row(message, { expanded }), /<time[^>]*aria-label="[^"]+"[^>]*>3:04 PM<\/time>/);
    }
  }
});

test("the row stays in view while its chevron or question is open", () => {
  assert.match(row(bot), /class="message-actions collapsed-actions"/);
  assert.match(row(bot, { expanded: true }), /class="message-actions collapsed-actions held"/);
  assert.match(row(bot, { asking: true }), /class="message-actions collapsed-actions held"/);
});

const plan = (over = {}) => ({ available: true, note: null, files: [{ path: "src/a.ts" }, { path: "src/b.ts", conflict: true }], skipped: [], effects: [], ...over });
const ask = (kind, message, over = {}, going = {}) => renderToStaticMarkup(React.createElement(GoBackAsk, {
  going: { paneId: "pane-a", kind, message, plan: plan(over), scope: "both", ticked: ["src/a.ts", "src/b.ts"], ...going },
  who: "Null", nameOf: (id) => (id === "null" ? "Null" : id), onScope: noop, onTick: noop, onAnswer: noop, onCancel: noop,
}));

test("Retry asks with the desktop's words and buttons", () => {
  const html = ask("retry", bot);
  assert.match(html, /aria-label="Retry\?"/);
  assert.match(html, /Retry deletes this reply and everything after it, and puts back the files changed since Null started\./);
  assert.doesNotMatch(html, /goback-scope/);
  assert.match(html, /<code>src\/a\.ts<\/code>/);
  assert.match(html, /also changed elsewhere/);
  assert.match(html, />Allow once</);
  assert.match(html, />Allow always</);
  assert.match(html, />Cancel</);
  assert.doesNotMatch(html, /goes back in the box/);
});

test("Revert offers what goes back, and your message returns to the box", () => {
  const html = ask("revert", mine);
  assert.match(html, /Revert deletes everything after your message and puts back the files this thread changed since\./);
  assert.match(html, /Files and chat/);
  assert.match(html, /Chat only/);
  assert.match(html, /Files only/);
  assert.match(html, /Your message goes back in the box, unsent\./);
  // Chat only hides the files; Files only keeps your message where it is.
  assert.doesNotMatch(ask("revert", mine, {}, { scope: "chat" }), /goback-files/);
  assert.doesNotMatch(ask("revert", mine, {}, { scope: "files" }), /goes back in the box/);
});

test("it names what can't be undone, and files too big to save", () => {
  const html = ask("retry", bot, { skipped: ["big.bin"], effects: [{ command: "npm publish", by: "null" }] });
  assert.match(html, /Too big to save, so left as they are: big\.bin/);
  assert.match(html, /Can&#x27;t be undone: <span><code>npm publish<\/code> \(Null\)<\/span>/);
});

test("with no files to put back it only deletes the chat", () => {
  const html = ask("retry", bot, { available: false, note: "No saved files for this thread.", files: [] });
  assert.match(html, /Retry deletes this reply and everything after it\./);
  assert.match(html, /No saved files for this thread\./);
  assert.doesNotMatch(html, /goback-files/);
});

test("the phone keeps the desktop's buttons: a change to ChatPane's row must reach the phone too", async () => {
  const { readFileSync } = await import("node:fs");
  const keys = (source) => [...source.matchAll(/key="([a-z-]+)"/g)].map((m) => m[1]);
  const desktop = readFileSync(new URL("../src/ChatPane.tsx", import.meta.url), "utf8").match(/const messageActions = \(message: Message\) => \{([\s\S]*?)\n  const threadExport/);
  assert.ok(desktop, "ChatPane's message row exists");
  const phone = readFileSync(new URL("../src/phone/MessageActions.tsx", import.meta.url), "utf8").match(/export function MessageActions\(([\s\S]*?)\n\}\n/);
  assert.ok(phone, "the phone's message row exists");
  assert.deepEqual(keys(desktop[1]), ["quote", "copy", "read-aloud", "pin", "goback", "fork"]);
  assert.deepEqual(keys(phone[1]).filter((key) => key !== "more" && key !== "time"), keys(desktop[1]));
});
