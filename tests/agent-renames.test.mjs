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
  const ok = (chat) => ({ chat, error: null });
  assert.equal(renames.renameSummary("Jigga", "Atlas", []), null);
  assert.equal(renames.renameSummary("Jigga", "Atlas", [ok("Plan")]), "Renamed Jigga to Atlas in 1 chat.");
  assert.equal(renames.renameSummary("Jigga", "Atlas", [ok("Plan"), ok("Ops")]), "Renamed Jigga to Atlas in 2 chats.");
  assert.equal(renames.renameSummary("Jigga", "Atlas", [ok("Plan"), { chat: "Research", error: "Atlas there already answers to @atlas." }]),
    'Renamed Jigga to Atlas in 1 chat. "Research" still says Jigga: Atlas there already answers to @atlas.');
  assert.equal(renames.renameSummary("Jigga", "Atlas", [{ chat: "Research", error: "the machine is offline" }]), '"Research" still says Jigga: the machine is offline.');
});

test("a chat saves its renamed copy against the copy it had, and reports what happened", async () => {
  const copy = { id: "jigga", display_name: "Jigga", persona: "kept" };
  const chat = [copy, { id: "null", display_name: "Null" }];
  const saves = [];
  const outcome = await renames.renameCopy(chat, { id: "jigga", name: "Atlas" }, "Plan", async (next, base) => { saves.push([next, base]); });
  assert.deepEqual(outcome, { chat: "Plan", error: null });
  assert.deepEqual(saves, [[{ ...copy, display_name: "Atlas" }, copy]]);
  assert.equal(await renames.renameCopy(chat, { id: "gronk", name: "Atlas" }, "Plan", async () => { throw new Error("no save expected"); }), null, "no copy here");
});

test("a chat keeps the old name when another bot there has the new one, or the save fails", async () => {
  const chat = [{ id: "jigga", display_name: "Jigga" }, { id: "nul", display_name: "Null" }];
  const never = async () => { throw new Error("no save expected"); };
  assert.deepEqual(await renames.renameCopy(chat, { id: "jigga", name: "NULL" }, "Plan", never), { chat: "Plan", error: "Null there already answers to @null." });
  const offline = async () => { throw new Error("Hetzner is offline"); };
  assert.deepEqual(await renames.renameCopy(chat, { id: "jigga", name: "Atlas" }, "Ops", offline), { chat: "Ops", error: "Hetzner is offline" });
});

test("one note follows each rename, once the chats stop answering", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown = [];
  const notes = renames.renameNotes((text) => shown.push(text), 800);
  notes.started({ seq: 1, id: "jigga", from: "Jigga", name: "Atlas" });
  notes.heard(1, { chat: "Plan", error: null });
  t.mock.timers.tick(500);
  notes.heard(1, { chat: "Ops", error: null });
  t.mock.timers.tick(799);
  assert.deepEqual(shown, []);
  t.mock.timers.tick(1);
  assert.deepEqual(shown, ["Renamed Jigga to Atlas in 2 chats."]);
  notes.heard(1, { chat: "Late", error: "Hetzner is offline" });
  t.mock.timers.tick(800);
  assert.deepEqual(shown.at(-1), '"Late" still says Jigga: Hetzner is offline.', "a chat that answers late gets its own note");
  notes.heard(9, { chat: "Stray", error: null });
  t.mock.timers.tick(800);
  assert.equal(shown.length, 2, "an outcome for a rename never started is ignored");
});

test("renames that reach a chat together are applied in order, each seeing the names before it", async () => {
  const chat = [{ id: "a", display_name: "Ada" }, { id: "b", display_name: "Bob" }];
  const saves = [], heard = [];
  const renamesDue = [{ seq: 1, id: "a", from: "Ada", name: "Cy" }, { seq: 2, id: "b", from: "Bob", name: "Ada" }];
  await renames.renameCopies(chat, renamesDue, "Plan", async (next) => { saves.push(`${next.id}:${next.display_name}`); }, (seq, outcome) => heard.push([seq, outcome]));
  assert.deepEqual(saves, ["a:Cy", "b:Ada"], "Bob may take Ada once Ada is Cy");
  assert.deepEqual(heard, [[1, { chat: "Plan", error: null }], [2, { chat: "Plan", error: null }]]);
});

test("the app keeps one rename per agent, the latest, so a chat that was offline for many renames still gets its own", () => {
  const r = (seq, id, from, name) => ({ seq, id, from, name });
  const first = renames.latestRenames([], [r(1, "jigga", "Jigga", "Atlas"), r(2, "null", "Null", "Nova")]);
  assert.deepEqual(renames.latestRenames(first, [r(3, "jigga", "Atlas", "Zed")]), [r(2, "null", "Null", "Nova"), r(3, "jigga", "Atlas", "Zed")]);
  let many = renames.latestRenames(first, [r(3, "jigga", "Atlas", "Zed")]);
  for (let seq = 4; seq < 40; seq++) many = renames.latestRenames(many, [r(seq, "null", `N${seq - 1}`, `N${seq}`)]);
  assert.deepEqual(many, [r(3, "jigga", "Atlas", "Zed"), r(39, "null", "N38", "N39")], "36 renames of Null never push out Jigga's");
});

test("a rename made while an earlier one is still saving starts from the name that one saved", async () => {
  // The chat's own list hasn't heard about the first save yet, as when a save is slow.
  const stale = [{ id: "jigga", display_name: "Jigga", persona: "kept" }, { id: "null", display_name: "Null" }];
  const saves = [], heard = [];
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const rename = renames.copyRenamer(() => stale, async (next, base) => { saves.push([base.display_name, next.display_name, next.persona]); if (saves.length === 1) await slow; }, (seq, outcome) => heard.push([seq, outcome]));
  const one = rename([{ seq: 1, id: "jigga", from: "Jigga", name: "Atlas" }], "Plan");
  const two = rename([{ seq: 2, id: "jigga", from: "Atlas", name: "Jigga" }], "Plan");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saves, [["Jigga", "Atlas", "kept"]], "the second waits for the first");
  release();
  await Promise.all([one, two]);
  assert.deepEqual(saves, [["Jigga", "Atlas", "kept"], ["Atlas", "Jigga", "kept"]], "so the chat ends as Jigga, like the agent");
  assert.deepEqual(heard, [[1, { chat: "Plan", error: null }], [2, { chat: "Plan", error: null }]]);
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
