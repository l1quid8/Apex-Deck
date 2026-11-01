import assert from "node:assert/strict";
import { test } from "node:test";
import { browserCaller, browserHostFor, chosenTab, coalesce, dialogChoices, holderName, inputQueue, keyAction, modifierBits, pagePoint, tabForAddress, tabName } from "../src/browserTabs.ts";

const key = (key, more = {}) => ({ key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...more });
const tab = (id, more = {}) => ({ id, url: "", title: "", control: { kind: "free" }, rooms: [], assistant: false, popup: false, dialogOpen: false, fileChooser: false, width: 1280, height: 800, ...more });

test("a point on the letterbox is not a point on the page", () => {
  const box = { left: 10, top: 10, width: 800, height: 800 };
  assert.deepEqual(pagePoint(410, 410, box, 1600, 1000), { x: 800, y: 500 });
  assert.equal(pagePoint(410, 15, box, 1600, 1000), null);
});

test("only pointer movement collapses, so a click is never lost", () => {
  const move = (x) => ({ kind: "mouse", action: "move", x, y: 0, button: "none", buttons: 0, clicks: 0, modifiers: 0 });
  const down = { ...move(1), action: "down" };
  assert.deepEqual(coalesce(coalesce([], move(1)), move(2)), [move(2)]);
  assert.deepEqual(coalesce(coalesce([move(1)], down), move(2)), [move(1), down, move(2)]);
});

test("typing carries text and editing shortcuts become editing commands", () => {
  const typed = keyAction(key("a"), true);
  assert.equal(typed.events[0].text, "a");
  assert.deepEqual(keyAction(key("a", { metaKey: true }), true).events[0].commands, ["selectAll"]);
  assert.deepEqual(keyAction(key("z", { metaKey: true, shiftKey: true }), true).events[0].commands, ["redo"]);
  assert.equal(keyAction(key("Enter", { code: "Enter", keyCode: 13 }), true).events[0].text, "\r");
  assert.equal(keyAction(key("c", { metaKey: true }), true).events[0].kind, "copy");
  assert.equal(keyAction(key("v", { metaKey: true }), true).type, "paste");
});

test("Deck keeps its own shortcuts while a page has the keyboard", () => {
  assert.equal(keyAction(key("k", { metaKey: true }), true).type, "deck");
  assert.equal(keyAction(key("c", { ctrlKey: true }), true).events[0].text, "");
  assert.equal(modifierBits({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }), 15);
});

test("a tab says who has it and where they're working", () => {
  const bot = tab("t", { control: { kind: "bot", thread: "r", participant: "p", label: "Jigga" } });
  assert.equal(holderName(bot, (id) => id === "r" ? "Apex Computer" : undefined, "Alfred"), "Jigga · Apex Computer");
  assert.equal(holderName(bot, () => undefined, "Alfred"), "Jigga");
  assert.equal(holderName(tab("t", { control: { kind: "assistant" } }), () => undefined, "Alfred"), "Alfred");
  assert.equal(holderName(tab("t", { control: { kind: "human" } }), () => undefined, "Alfred"), "You");
  assert.equal(holderName(tab("t"), () => undefined, "Alfred"), "");
});

test("tabs are named from their page, and a vanished tab falls back", () => {
  assert.equal(tabName(tab("t", { title: "Docs" })), "Docs");
  assert.equal(tabName(tab("t", { url: "http://localhost:3000/x" })), "localhost:3000");
  assert.equal(tabName(tab("t")), "New tab");
  const tabs = [tab("a"), tab("b", { assistant: true })];
  assert.equal(chosenTab(tabs, "a", true), "a");
  assert.equal(chosenTab(tabs, "gone", true), "b");
  assert.equal(chosenTab(tabs, "gone", false), "a");
  assert.equal(chosenTab([], null, false), null);
});

test("every call carries a session, and a forgotten one is replaced once", async () => {
  let issued = 0, valid = "";
  const sent = [];
  const call = async (cmd, args = {}) => {
    sent.push(cmd);
    if (cmd === "personal_browser_session") { valid = `s${++issued}`; return { session: valid }; }
    if (args.session !== valid) throw new Error("browser_session_required");
    return { ok: args.session };
  };
  const browser = browserCaller("session-test", call);
  assert.deepEqual(await browser("browser_tabs"), { ok: "s1" });
  assert.deepEqual(await browser("browser_tabs"), { ok: "s1" });
  assert.equal(sent.filter((cmd) => cmd === "personal_browser_session").length, 1);
  valid = "after-restart";
  assert.deepEqual(await browser("browser_tabs"), { ok: "s2" });
  await assert.rejects(browserCaller("session-test-2", async (cmd) => { if (cmd === "personal_browser_session") throw new Error("refused"); return {}; })("browser_tabs"), /refused/);
});

test("a link lands in the tab already showing it, not a new one", () => {
  const same = (a, b) => new URL(a).host === new URL(b).host;
  const tabs = [tab("a", { url: "http://localhost:3000/x" }), tab("b", { url: "https://example.com/" })];
  assert.equal(tabForAddress(tabs, "https://example.com/", same, false).id, "b");
  assert.equal(tabForAddress(tabs, "http://localhost:3000/y", same, false), undefined);
  assert.equal(tabForAddress(tabs, "http://localhost:3000/y", same, true).id, "a");
});

test("input made on one tab never lands on the tab switched to", async () => {
  const sent = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const queue = inputQueue((deliver, events) => deliver(events), () => {}, () => {});
  const to = (name, wait) => (events) => { sent.push([name, ...events.map((event) => event.text)]); return wait ?? Promise.resolve(); };
  const text = (value) => ({ kind: "text", text: value });
  queue.add("mac\0A", to("A", held), text("1"));
  queue.add("mac\0A", to("A"), text("2"));
  queue.add("mac\0A", to("A"), text("3"));
  queue.add("mac\0B", to("B"), text("b"));
  queue.add("vps\0A", to("vps"), text("v"));
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent.filter(([name]) => name === "A"), [["A", "1"], ["A", "2", "3"]]);
  assert.deepEqual(sent.filter(([name]) => name !== "A"), [["B", "b"], ["vps", "v"]]);
  assert.ok(sent.findIndex(([name]) => name === "B") < sent.findIndex(([, text]) => text === "2"), "a slow tab holds up no other");
});

test("nothing shares a batch with a clipboard reply", async () => {
  const sent = [];
  const queue = inputQueue((deliver, events) => deliver(events), () => {}, () => {});
  queue.add("A", async (events) => { sent.push(events.map((event) => event.kind)); }, { kind: "reload" }, { kind: "cut" }, { kind: "back" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent, [["reload", "cut"], ["back"]]);
});

test("a refused event drops what followed it on that tab only", async () => {
  const sent = [], failed = [];
  let release;
  const held = new Promise((_, reject) => { release = () => reject(new Error("tab_closed")); });
  const queue = inputQueue((deliver, events) => deliver(events), () => {}, (cause) => failed.push(cause.message));
  const to = (name) => async (events) => { sent.push([name, events.length]); };
  queue.add("A", () => held, { kind: "reload" });
  queue.add("A", to("A"), { kind: "reload" });
  queue.add("B", to("B"), { kind: "reload" });
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(failed, ["tab_closed"]);
  assert.deepEqual(sent, [["B", 1]]);
});

test("a link stays on the thread's machine, whatever is in front", () => {
  const pin = { hostId: "vps", focus: "threads:local-chat" };
  assert.equal(browserHostFor("local", { hostId: "vps" }, null, "threads:local-chat"), "vps");
  assert.equal(browserHostFor("local", { hostId: "vps" }, pin, "threads:elsewhere"), "vps", "still on its way");
  assert.equal(browserHostFor("local", null, pin, "threads:local-chat"), "vps", "shown once opened");
  assert.equal(browserHostFor("local", null, pin, "threads:elsewhere"), "local", "moving on returns to the machine in front");
  assert.equal(browserHostFor("local", {}, null, "x"), "local");
});

test("a dialog offers what the page asked for", () => {
  assert.deepEqual(dialogChoices({ type: "alert", message: "m" }), { answer: false, ok: "OK", cancel: null });
  assert.deepEqual(dialogChoices({ type: "confirm", message: "m" }), { answer: false, ok: "OK", cancel: "Cancel" });
  assert.deepEqual(dialogChoices({ type: "prompt", message: "m" }), { answer: true, ok: "OK", cancel: "Cancel" });
  assert.deepEqual(dialogChoices({ type: "beforeunload", message: "" }), { answer: false, ok: "Leave", cancel: "Stay" });
});
