import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  afterClose, openKeyParts, openStrip, pruneOpenThreads, readOpenThreads, withOpenThread,
  withoutOpenThread, writeOpenThreads,
} from "../src/phone/openThreads.ts";

// Threads are named by machine and id, as chatRoutes.ts names them.
const key = (hostId, id) => JSON.stringify([hostId, id]);
const mac = (id) => key("local", id);

test("a thread key names its machine and its id, and nothing else parses", () => {
  assert.deepEqual(openKeyParts(key("studio", "pane-1")), { hostId: "studio", id: "pane-1" });
  assert.deepEqual(openKeyParts(mac("draft-3")), { hostId: "local", id: "draft-3" });
  assert.equal(openKeyParts("local:pane-1"), null, "a key this phone didn't write is not a thread");
  assert.equal(openKeyParts('["local"]'), null);
  assert.equal(openKeyParts('["local",""]'), null);
  assert.equal(openKeyParts("null"), null);
  assert.equal(openKeyParts('{"hostId":"local"}'), null);
});

test("the open set survives the app being shut down, and unreadable text is dropped not guessed at", () => {
  const open = [mac("a"), key("studio", "b")];
  assert.deepEqual(readOpenThreads(writeOpenThreads(open)), open);
  assert.deepEqual(readOpenThreads(null), []);
  assert.deepEqual(readOpenThreads(""), []);
  assert.deepEqual(readOpenThreads("not json"), []);
  assert.deepEqual(readOpenThreads('{"threads":[]}'), []);
  // A half-written list: the good keys are kept and the junk goes, so the app still opens something.
  assert.deepEqual(readOpenThreads(JSON.stringify([mac("a"), "junk", "junk", mac("a"), 7, null])), [mac("a")]);
});

test("opening a thread puts it at the end, and opening it again leaves it where it was", () => {
  assert.deepEqual(withOpenThread([], mac("a")), [mac("a")]);
  assert.deepEqual(withOpenThread([mac("a")], mac("b")), [mac("a"), mac("b")]);
  // Reached again from a notification or a search: it focuses without jumping away from its neighbours.
  assert.deepEqual(withOpenThread([mac("a"), mac("b"), mac("c")], mac("a")), [mac("a"), mac("b"), mac("c")]);
});

test("the same thread on two machines is two open threads", () => {
  const both = withOpenThread(withOpenThread([], key("local", "shared")), key("studio", "shared"));
  assert.deepEqual(both, [key("local", "shared"), key("studio", "shared")]);
});

test("a key that isn't a thread never gets into the open set", () => {
  assert.deepEqual(withOpenThread([], "draft-7"), []);
});

test("opening a thread never closes another one, however many are open", () => {
  let open = [];
  for (let n = 0; n < 40; n++) open = withOpenThread(open, mac(`t${n}`));
  assert.equal(open.length, 40, "nothing is evicted to make room");
  assert.equal(open[0], mac("t0"));
  assert.equal(open[39], mac("t39"));
  // And a long saved list comes back whole when the app opens again.
  assert.equal(readOpenThreads(writeOpenThreads(open)).length, 40);
});

test("closing a thread takes it out of the set and leaves the conversation where it was", () => {
  assert.deepEqual(withoutOpenThread([mac("a"), mac("b")], mac("a")), [mac("b")]);
  assert.deepEqual(withoutOpenThread([mac("a")], mac("z")), [mac("a")]);
});

test("closing the thread on screen shows the one that took its place, else the one before it", () => {
  const open = [mac("a"), mac("b"), mac("c")];
  assert.equal(afterClose(open, mac("b")), mac("c"), "the next one moves up into the closed thread's place");
  assert.equal(afterClose(open, mac("c")), mac("b"), "the last one has no next, so the one before it shows");
  assert.equal(afterClose(open, mac("a")), mac("b"));
  assert.equal(afterClose([mac("a")], mac("a")), null, "the last one closed goes back to the Threads list");
  assert.equal(afterClose([], mac("a")), null);
});

test("a thread that is gone leaves the set, and one we can't check yet stays", () => {
  const open = [mac("kept"), mac("deleted"), key("studio", "away"), key("newbox", "unknown")];
  const alive = (k) => {
    const { hostId, id } = openKeyParts(k);
    if (hostId === "newbox") return null;      // a machine whose list hasn't loaded
    if (hostId === "studio") return null;      // paired, but away: its threads come back
    return id !== "deleted";
  };
  assert.deepEqual(pruneOpenThreads(open, alive), [mac("kept"), key("studio", "away"), key("newbox", "unknown")]);
  assert.deepEqual(pruneOpenThreads(open, () => false), []);
  assert.deepEqual(pruneOpenThreads(open, () => null), open);
});

test("the strip is the open set, minus any thread that can't be drawn yet", () => {
  const open = [mac("a"), key("studio", "b"), mac("c")];
  const drawable = (k) => openKeyParts(k).hostId !== "studio";  // that machine's list hasn't loaded
  assert.deepEqual(openStrip(open, drawable), [mac("a"), mac("c")]);
  assert.deepEqual(openStrip(open, () => true), open);
  assert.deepEqual(openStrip([], () => true), []);
});

// The rules above only matter if the screens use them. These read the phone's own source.
const source = fs.readFileSync(new URL("../src/phone/PhoneApp.tsx", import.meta.url), "utf8");
const between = (from, to) => {
  const at = source.indexOf(from);
  const end = source.indexOf(to, at);
  assert.ok(at >= 0 && end > at, `no ${from} in PhoneApp.tsx`);
  return source.slice(at, end);
};

test("the phone swipes through its open threads, and saves them for the next launch", () => {
  assert.match(source, /openStrip\(openThreads,/, "the strip is built from the open set, not the whole list");
  assert.match(source, /setOpenThreads\(\(list\) => withOpenThread\(list, openPaneKey\)\)/, "opening a thread adds it");
  assert.match(source, /localStorage\.setItem\(OPEN_KEY, writeOpenThreads\(openThreads\)\)/, "the open set is saved");
  assert.match(source, /pruneOpenThreads\(list, alive\)/, "a thread that is gone leaves the open set");
  // Before the Mac's saved list has loaded there is no way to tell a Mac thread from one that was
  // deleted while the app was closed, so nothing from it is dropped in the meantime.
  assert.match(source, /if \(session === null\) return null;/, "nothing is pruned before the Mac's list lands");
  assert.doesNotMatch(source, /swipeStrip|holdStrip/, "the Threads-list order is not what a swipe moves through");
});

test("Close thread and Delete thread sit in the same menu, Close first and Delete last", () => {
  const menu = between('{menu?.kind === "thread" && menuPane &&', '{menu?.kind === "bots" && menuPane &&');
  const close = menu.indexOf('label="Close thread"');
  const remove = menu.indexOf('label="Delete thread…"');
  assert.ok(close >= 0, "the thread's ⋯ menu has Close thread");
  assert.ok(remove > close, "Delete comes after Close");
  const lastRow = [...menu.matchAll(/<MenuRow label="([^"]+)"/g)].pop();
  assert.equal(lastRow?.[1], "Delete thread…", "Delete is the last row, past the rows you reach for every day");
});

test("no count and no picker: the dots over the title are the only thing that says where you are", () => {
  const css = fs.readFileSync(new URL("../src/phone/phone.css", import.meta.url), "utf8");
  assert.match(source, /place: stripPlace\(swipeKeys, openKey \?\? null\)/, "the dots are fed by the open set");
  assert.match(source, /className="ph-nav-dots" aria-hidden="true"/, "the dots say nothing to a screen reader, and take no tap");
  assert.doesNotMatch(source, /kind: "open"|<Sheet title="Open threads"|label="Open threads"/, "the quick picker is gone");
  assert.doesNotMatch(source, /stripPosition|ph-context-pos/, "the \"3 of 5\" line is gone");
  assert.doesNotMatch(css, /ph-open-|ph-context-pos/, "and its styles with it");
  assert.match(css, /\.ph-nav-dots i\.on \{[^}]*background: var\(--mint\)/, "the active dot is lit");
});

test("closing keeps the conversation, and a chat can be closed as well as a thread", () => {
  const close = between("const closeThread = (key: OpenKey) => {", "};");
  assert.match(close, /withoutOpenThread/, "closing takes it out of the open set");
  assert.match(close, /setOpenId\(null\)/, "closing the last one goes back to the Threads list");
  assert.doesNotMatch(close, /roomDelete|sessionSave/, "closing is not deleting");
  assert.match(between('{chatSheet?.kind === "menu" && sheetChat &&', '{chatSheet?.kind === "rename"'), /label="Close chat"/);
  assert.match(between('{chatSheet?.kind === "work-menu" && sheetChat &&', '{chatSheet?.kind === "rename"'), /label="Close thread"/);
});

test("deleting a thread also takes it out of the open set", () => {
  const remove = between("async function deleteThread(pane: Pane) {", "/** Take a project and its threads out of the list on the Mac.");
  assert.match(remove, /withoutOpenThread\(list, threadKey\(\{ id: pane\.id, hostId \}, hostId\)\)/);
});

