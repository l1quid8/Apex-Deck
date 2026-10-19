import test from "node:test";
import assert from "node:assert/strict";
import * as renames from "../src/agentRenames.ts";

test("only agents whose name changed count as renamed", () => {
  const before = [{ id: "jigga", display_name: "Jigga" }, { id: "null", display_name: "Null" }];
  const after = [{ id: "jigga", display_name: "Atlas" }, { id: "null", display_name: "Null" }, { id: "new", display_name: "New" }];
  assert.deepEqual(renames.renamedAgents(before, after), [{ id: "jigga", from: "Jigga", name: "Atlas" }]);
  assert.deepEqual(renames.renamedAgents(after, after), []);
  assert.deepEqual(renames.renamedAgents(before, before.slice(1)), [], "a deleted agent is not a rename");
});

test("a chat renames only its own copy, keeps the rest of its settings, and skips one already named that", () => {
  const copy = { id: "jigga", display_name: "Jigga", persona: "kept", access: "read" };
  const chat = [copy, { id: "null", display_name: "Null" }];
  assert.deepEqual(renames.renamedCopy(chat, { id: "jigga", name: "Atlas" }), { base: copy, next: { ...copy, display_name: "Atlas" } });
  assert.equal(renames.renamedCopy(chat, { id: "jigga", name: "Jigga" }), null);
  assert.equal(renames.renamedCopy(chat, { id: "gronk", name: "Atlas" }), null);
});

test("a chat where another bot already has the name says so in plain words", () => {
  assert.equal(renames.keptNameWhy({ kind: "taken", mention: "atlas", by: { id: "atlas", display_name: "Atlas" } }), "Atlas there already answers to @atlas.");
  assert.equal(renames.keptNameWhy({ kind: "everyone", mention: "all" }), "@all already means everyone.");
});

test("the note counts the chats renamed and names any that kept the old name", () => {
  const ok = (chat) => ({ chat, from: "Jigga", error: null });
  assert.equal(renames.renameSummary("Jigga", "Atlas", []), null);
  assert.equal(renames.renameSummary("Jigga", "Atlas", [ok("Plan")]), "Renamed Jigga to Atlas in 1 chat.");
  assert.equal(renames.renameSummary("Jigga", "Atlas", [ok("Plan"), ok("Ops")]), "Renamed Jigga to Atlas in 2 chats.");
  assert.equal(renames.renameSummary("Jigga", "Atlas", [ok("Plan"), { chat: "Research", from: "Jigga", error: "Atlas there already answers to @atlas." }]),
    'Renamed Jigga to Atlas in 1 chat. "Research" still says Jigga: Atlas there already answers to @atlas.');
  assert.equal(renames.renameSummary("Jigga", "Atlas", [{ chat: "Research", from: "Jigga", error: "the machine is offline" }]), '"Research" still says Jigga: the machine is offline.');
});

test("a chat saves its renamed copy against the copy it had, and reports what happened", async () => {
  const copy = { id: "jigga", display_name: "Jigga", persona: "kept" };
  const chat = [copy, { id: "null", display_name: "Null" }];
  const saves = [];
  const outcome = await renames.renameCopy(chat, { id: "jigga", name: "Atlas" }, "Plan", async (next, base) => { saves.push([next, base]); });
  assert.deepEqual(outcome, { chat: "Plan", from: "Jigga", error: null });
  assert.deepEqual(saves, [[{ ...copy, display_name: "Atlas" }, copy]]);
  assert.equal(await renames.renameCopy(chat, { id: "gronk", name: "Atlas" }, "Plan", async () => { throw new Error("no save expected"); }), null, "no copy here");
});

test("a chat keeps the old name when another bot there has the new one, or the save fails", async () => {
  const chat = [{ id: "jigga", display_name: "Jigga" }, { id: "nul", display_name: "Null" }];
  const never = async () => { throw new Error("no save expected"); };
  assert.deepEqual(await renames.renameCopy(chat, { id: "jigga", name: "NULL" }, "Plan", never), { chat: "Plan", from: "Jigga", error: "Null there already answers to @null." });
  const offline = async () => { throw new Error("Hetzner is offline"); };
  assert.deepEqual(await renames.renameCopy(chat, { id: "jigga", name: "Atlas" }, "Ops", offline), { chat: "Ops", from: "Jigga", error: "Hetzner is offline" });
});

test("one note follows each rename, once the chats stop answering", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown = [];
  const notes = renames.renameNotes((text) => shown.push(text), 800);
  notes.started({ seq: 1, id: "jigga", from: "Jigga", name: "Atlas" });
  notes.heard(1, { chat: "Plan", from: "Jigga", error: null });
  t.mock.timers.tick(500);
  notes.heard(1, { chat: "Ops", from: "Jigga", error: null });
  t.mock.timers.tick(799);
  assert.deepEqual(shown, []);
  t.mock.timers.tick(1);
  assert.deepEqual(shown, ["Renamed Jigga to Atlas in 2 chats."]);
  notes.heard(1, { chat: "Late", from: "Jigga", error: "Hetzner is offline" });
  t.mock.timers.tick(800);
  assert.deepEqual(shown.at(-1), '"Late" still says Jigga: Hetzner is offline.', "a chat that answers late gets its own note");
  notes.heard(9, { chat: "Stray", from: "Stray", error: null });
  t.mock.timers.tick(800);
  assert.equal(shown.length, 2, "an outcome for a rename never started is ignored");
});

test("renames that reach a chat together are applied in order, each seeing the names before it", async () => {
  const chat = [{ id: "a", display_name: "Ada" }, { id: "b", display_name: "Bob" }];
  const saves = [], heard = [];
  const renamesDue = [{ seq: 1, id: "a", from: "Ada", name: "Cy" }, { seq: 2, id: "b", from: "Bob", name: "Ada" }];
  await renames.renameCopies(chat, renamesDue, "Plan", async (next) => { saves.push(`${next.id}:${next.display_name}`); }, (seq, outcome) => heard.push([seq, outcome]));
  assert.deepEqual(saves, ["a:Cy", "b:Ada"], "Bob may take Ada once Ada is Cy");
  assert.deepEqual(heard, [[1, { chat: "Plan", from: "Ada", error: null }], [2, { chat: "Plan", from: "Bob", error: null }]]);
});

test("a copy with a name of its own is called by that name when it keeps it", async () => {
  // The agent was Jigga, but this chat renamed its copy Zed, and a bot here is already Atlas.
  const chat = [{ id: "jigga", display_name: "Zed" }, { id: "atlas", display_name: "Atlas" }];
  const outcome = await renames.renameCopy(chat, { id: "jigga", name: "Atlas" }, "Research", async () => { throw new Error("no save expected"); });
  assert.deepEqual(outcome, { chat: "Research", from: "Zed", error: "Atlas there already answers to @atlas." });
  assert.equal(renames.renameSummary("Jigga", "Atlas", [outcome]), '"Research" still says Zed: Atlas there already answers to @atlas.');
});

test("the app keeps every rename, in order, however many there are", () => {
  const r = (seq) => ({ seq, id: seq % 2 ? "jigga" : "null", from: `N${seq - 1}`, name: `N${seq}` });
  let kept = [];
  for (let seq = 1; seq <= 40; seq++) kept = renames.addRenames(kept, [r(seq)]);
  assert.deepEqual(kept.map((x) => x.seq), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.deepEqual(renames.addRenames([r(1)], [r(2), r(3)]).map((x) => x.seq), [1, 2, 3], "a save that renames several agents adds them all");
});

/** A chat's renamer whose save does what ChatPane's does: once saved, the chat's list shows the new name. */
function chatRenamer(start, { slowFirst } = {}) {
  const state = { chat: start, saves: [], heard: [] };
  state.rename = renames.copyRenamer(() => state.chat, async (next, base) => {
    state.saves.push([base.display_name, next.display_name, next.persona]);
    if (state.saves.length === 1 && slowFirst) await slowFirst;
    state.chat = state.chat.map((p) => (p.id === next.id ? next : p));
  }, (seq, outcome) => state.heard.push([seq, outcome]));
  return state;
}

test("a chat that was away while two agents swapped names replays each step, so they swap there too", async () => {
  // Ada → Cy, Bob → Ada, then Cy → Bob, all while this chat's machine was offline.
  let kept = [];
  for (const step of [{ seq: 1, id: "a", from: "Ada", name: "Cy" }, { seq: 2, id: "b", from: "Bob", name: "Ada" }, { seq: 3, id: "a", from: "Cy", name: "Bob" }]) kept = renames.addRenames(kept, [step]);
  const room = chatRenamer([{ id: "a", display_name: "Ada" }, { id: "b", display_name: "Bob" }]);
  await room.rename(kept, "Ops");
  assert.deepEqual(room.saves.map(([from, to]) => `${from}→${to}`), ["Ada→Cy", "Bob→Ada", "Cy→Bob"], "Bob takes Ada only once Ada is Cy, and Cy takes Bob only once Bob is Ada");
  assert.deepEqual(room.heard.map(([seq, o]) => [seq, o.error]), [[1, null], [2, null], [3, null]]);
  assert.deepEqual(room.chat.map((p) => p.display_name), ["Bob", "Ada"]);
});

test("a copy renamed inside the chat afterwards no longer holds the name it was given", async () => {
  const room = chatRenamer([{ id: "q", display_name: "Quinn" }, { id: "r", display_name: "Rae" }]);
  await room.rename([{ seq: 1, id: "q", from: "Quinn", name: "Atlas" }], "Plan");
  room.chat = room.chat.map((p) => (p.id === "q" ? { ...p, display_name: "Zed" } : p)); // renamed in this chat only
  await room.rename([{ seq: 2, id: "r", from: "Rae", name: "Atlas" }], "Plan");
  assert.deepEqual(room.saves.map(([from, to]) => `${from}→${to}`), ["Quinn→Atlas", "Rae→Atlas"], "nobody here is Atlas any more, so Rae may be");
  assert.deepEqual(room.heard.map(([seq, o]) => [seq, o.error]), [[1, null], [2, null]]);
});

test("a rename made while an earlier one is still saving starts from the name that one saved", async () => {
  let release;
  const room = chatRenamer([{ id: "jigga", display_name: "Jigga", persona: "kept" }, { id: "null", display_name: "Null" }], { slowFirst: new Promise((resolve) => { release = resolve; }) });
  const one = room.rename([{ seq: 1, id: "jigga", from: "Jigga", name: "Atlas" }], "Plan");
  const two = room.rename([{ seq: 2, id: "jigga", from: "Atlas", name: "Jigga" }], "Plan");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(room.saves, [["Jigga", "Atlas", "kept"]], "the second waits for the first");
  release();
  await Promise.all([one, two]);
  assert.deepEqual(room.saves, [["Jigga", "Atlas", "kept"], ["Atlas", "Jigga", "kept"]], "so the chat ends as Jigga, like the agent");
  assert.deepEqual(room.heard, [[1, { chat: "Plan", from: "Jigga", error: null }], [2, { chat: "Plan", from: "Atlas", error: null }]]);
});

test("a rename that can't be saved doesn't hold up the next one", async () => {
  const chat = [{ id: "jigga", display_name: "Jigga" }];
  const heard = [];
  const rename = renames.copyRenamer(() => chat, async (next) => { if (next.display_name === "Atlas") throw new Error("Hetzner is offline"); }, (seq, outcome) => heard.push([seq, outcome.error]));
  await rename([{ seq: 1, id: "jigga", from: "Jigga", name: "Atlas" }], "Ops");
  await rename([{ seq: 2, id: "jigga", from: "Atlas", name: "Zed" }], "Ops");
  assert.deepEqual(heard, [[1, "Hetzner is offline"], [2, null]]);
});

test("saving a chat's bot to Agents replaces the agent with its id, unless another agent has its name", () => {
  const jigga = { id: "jigga", display_name: "Jigga" };
  const copy = { id: "jigga", display_name: "Atlas", persona: "from the chat" };
  assert.deepEqual(renames.savedToAgents([jigga], copy), { profiles: [copy] });
  const atlas = { id: "atlas", display_name: "Atlas" };
  assert.deepEqual(renames.savedToAgents([atlas, jigga], copy), { error: "Your agent Atlas already answers to @atlas. Pick a different name." });
});
