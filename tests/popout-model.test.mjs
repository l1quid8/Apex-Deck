import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "sucrase";
import { renamedAgents } from "../src/agentRenames.ts";
import { validArrangement } from "../src/paneArrangement.ts";
import { changedProfiles, createForkChannel, orphanedPopouts, popoutRefusal, restoreOrder, restoreTab, retargetPoppedTab, takeTabOut, upsertProfiles } from "../src/popoutModel.ts";
import { defaultPanel, openTab } from "../src/rightPanelModel.ts";

test("popped panes return to their order position without replacing other panes", async () => {
  const { restoreOrder } = await import("../src/popoutModel.ts");
  assert.equal(typeof restoreOrder, "function");
  const order = ["b", "c"], before = ["a", "b", "c"];
  assert.deepEqual(restoreOrder(order, "a", {workspaceId:"w",index:0,before}), ["a","b","c"]);
  assert.deepEqual(restoreOrder(order, "a", {workspaceId:"w",index:5,before:[]}), ["b","c","a"]);
  assert.deepEqual(restoreOrder(["c","b"], "a", {workspaceId:"w",index:1,before}), ["c","a","b"]);
  assert.deepEqual(restoreOrder(["a","b"], "a", {workspaceId:"w",index:1,before}), ["a","b"]);
  assert.deepEqual(order, ["b","c"]);
});

test("panes return beside old neighbours even after multiple pop-outs and a new first pane", () => {
  const original = ["a", "b", "c", "d"];
  const bSpot = { workspaceId: "w", index: 1, before: original };
  const cSpot = { workspaceId: "w", index: 2, before: original };
  let order = restoreOrder(["a", "d"], "b", bSpot);
  order = restoreOrder(order, "c", cSpot);
  assert.deepEqual(order, original);
  const returnC = { workspaceId: "w", index: 2, before: order };
  assert.deepEqual(restoreOrder(["n", "a", "b", "d"], "c", returnC), ["n", "a", "b", "c", "d"]);
  // Returning in the other order uses c as b's following neighbour.
  order = restoreOrder(["a", "d"], "c", cSpot);
  assert.deepEqual(restoreOrder(order, "b", bSpot), original);
});

test("a returning pane uses nearest surviving neighbours before its saved numeric index", () => {
  const spot = { workspaceId: "w", index: 2, before: ["a", "b", "c", "d", "e"] };
  assert.deepEqual(restoreOrder(["n", "b", "a", "d", "e"], "c", spot), ["n", "b", "c", "a", "d", "e"]);
  assert.deepEqual(restoreOrder(["n", "d", "e"], "c", spot), ["n", "c", "d", "e"]);
  assert.deepEqual(restoreOrder(["n", "e"], "c", spot), ["n", "c", "e"]);
  assert.deepEqual(restoreOrder(["n"], "c", spot), ["n", "c"]);
});

test("App remembers already-external neighbours when another pane pops out", async () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const remember = source.match(/^function withPoppedOut\([\s\S]*?^\}/m)[0];
  const open = source.match(/^  const popOutPane = [\s\S]*?^  \};/m)[0];
  const code = transform(remember + "\n" + open, { transforms: ["typescript"] }).code;
  const original = ["a", "b", "c", "d"];
  const listed = original.map(id => ({ id, workspaceId: "w", kind: "terminal", title: id }));
  let arrangements = { ":code": validArrangement({ order: original }, original) }, poppedOut = [];
  const popOut = async id => {
    // App re-creates this callback at each render; native opening is the only
    // external boundary replaced here. All return snapshots use App's code.
    const scope = {
      window: { apexDeck: { popout: { open: async snapshot => ({ token: snapshot.id }) } } },
      listed, poppedOut, poppedIds: new Set(poppedOut.map(item => item.id)),
      hostOfPane: () => ({ workspace: { path: "/fixture" }, hostId: "local" }),
      runs: {}, appearanceSettings: {}, chatFolder: () => "/fixture", popoutRefusal,
      layoutKey: () => ":code", paneSection: () => "code", dashboardArrangement: () => arrangements[":code"],
      validArrangement, restoreOrder,
      setArrangements: update => { arrangements = update(arrangements); },
      setPoppedOut: update => { poppedOut = update(poppedOut); },
      toast: message => assert.fail(message),
    };
    await new Function(...Object.keys(scope), code + ";return popOutPane;")(...Object.values(scope))(id);
  };
  await popOut("b");
  await popOut("c");
  assert.deepEqual(arrangements[":code"].order, ["a", "d"]);
  assert.deepEqual(poppedOut[1].spot.before, original, "c remembers b even while b is external");
  for (const returning of [poppedOut, [...poppedOut].reverse()]) {
    let order = arrangements[":code"].order;
    for (const item of returning) order = restoreOrder(order, item.id, item.spot);
    assert.deepEqual(order, original);
  }
});

test("task threads are refused a pop-out; ordinary panes are not", () => {
  // A task thread lives in the assistant's list, not Deck's panes, so popping one
  // out opened a window the gone-thread check closed again at once.
  assert.equal(popoutRefusal({ assistantTaskId: "task-1" }), "Task threads stay in Deck for now.");
  assert.equal(popoutRefusal({}), null);
  assert.equal(popoutRefusal({ assistantTaskId: undefined }), null);
  assert.equal(popoutRefusal({ assistantTaskId: "" }), null);
});

test("tabs remember their strip index and come back there", () => {
  let panel = defaultPanel();
  panel = openTab(panel, "files", 1);
  panel = openTab(panel, "worktrees", 2);
  const out = takeTabOut(panel, "files");
  assert.ok(out);
  assert.ok(!out.panel.tabs.some((t) => t.id === "files"));
  const back = restoreTab(out.panel, out.tab, out.spot);
  assert.deepEqual(back.tabs.map((t) => t.id), panel.tabs.map((t) => t.id));
});

test("a tab restored after its slot moved is clamped, not lost", () => {
  let panel = defaultPanel();
  panel = openTab(panel, "files", 1);
  const out = takeTabOut(panel, "files");
  assert.ok(out);
  // Meanwhile every closable tab closed: only fixed remain.
  const stripped = { ...out.panel, tabs: out.panel.tabs.filter((t) => ["dashboard", "tasks"].includes(t.kind)) };
  const back = restoreTab(stripped, out.tab, { index: 99, active: "missing" });
  assert.ok(back.tabs.some((t) => t.id === "files"));
  assert.equal(back.active, "files");
});

test("taking out a missing tab returns null", () => {
  assert.equal(takeTabOut(defaultPanel(), "nope"), null);
});

test("a fixed tab pops out and comes back to its slot", () => {
  const panel = defaultPanel();
  const out = takeTabOut(panel, "details");
  assert.ok(out);
  assert.ok(!out.panel.tabs.some((t) => t.id === "details"));
  const back = restoreTab(out.panel, out.tab, out.spot);
  assert.deepEqual(back.tabs.map((t) => t.id), panel.tabs.map((t) => t.id));
});

test("a tab recreated while popped out stays; the popped copy is dropped", () => {
  const panel = defaultPanel();
  const opened = openTab(panel, "files", 1);
  const out = takeTabOut(opened, "files");
  assert.ok(out);
  // Meanwhile the same Files tab was opened again in the main window.
  const recreated = openTab(out.panel, "files", 2);
  assert.ok(recreated.tabs.some((t) => t.id === "files"));
  const back = restoreTab(recreated, out.tab, out.spot);
  assert.equal(back.tabs.filter((t) => t.id === "files").length, 1);
});

test("a popped browser tab keeps navigating and comes back with the new address", () => {
  const opened = openTab(defaultPanel(), "browser", 1, "https://first.example");
  const tab = opened.tabs.find((t) => t.kind === "browser");
  assert.ok(tab?.url);
  const out = takeTabOut(opened, tab.id);
  assert.ok(out);
  // The owner hears tab-url from the pop-out: the strip no longer has the tab,
  // so the saved copy must move too or the return loses the navigation.
  const recs = retargetPoppedTab([{ token: "t1", tab: out.tab, spot: out.spot }], "t1", "https://second.example");
  assert.equal(recs[0].tab.url, "https://second.example");
  const back = restoreTab(out.panel, recs[0].tab, recs[0].spot);
  assert.equal(back.tabs.find((t) => t.id === tab.id)?.url, "https://second.example");
});

const agent = (id, extra = {}) => ({ id, display_name: id, persona: "", access: "read", effort: null, backend: { kind: "ollama", model: "m" }, ...extra });

test("two bots saved to Agents from a pop-out are both kept", () => {
  // The pop-out held the list from when it opened; saving twice used to drop the first save.
  const atOpen = [agent("one")];
  let owner = [...atOpen];
  owner = upsertProfiles(owner, changedProfiles(atOpen, [...atOpen, agent("two")]));
  owner = upsertProfiles(owner, changedProfiles(atOpen, [...atOpen, agent("three")]));
  assert.deepEqual(owner.map((p) => p.id), ["one", "two", "three"]);
});

test("a Deck-side edit to another agent survives a pop-out save", () => {
  const atOpen = [agent("one"), agent("two")];
  const ownerNow = [agent("one", { persona: "edited in Deck" }), agent("two")];
  const fromPopout = upsertProfiles(ownerNow, changedProfiles(atOpen, [agent("one"), agent("two", { persona: "edited in pop-out" })]));
  assert.equal(fromPopout.find((p) => p.id === "one").persona, "edited in Deck");
  assert.equal(fromPopout.find((p) => p.id === "two").persona, "edited in pop-out");
  assert.deepEqual(changedProfiles(atOpen, atOpen), []);
  assert.equal(upsertProfiles(ownerNow, []), ownerNow);
});

test("a pop-out's changed agents are enough to find a rename", () => {
  // Save to Agents from a pop-out sends only what changed; the owner finds renames in
  // that list, so the agent's copies in chats are renamed as they are from Deck.
  const atOpen = [agent("one"), agent("two")];
  const changed = changedProfiles(atOpen, [agent("one"), agent("two", { display_name: "Twain" })]);
  assert.deepEqual(renamedAgents(atOpen, changed), [{ id: "two", from: "two", name: "Twain" }]);
  assert.deepEqual(renamedAgents(atOpen, changedProfiles(atOpen, [...atOpen, agent("three")])), []);
});

test("pop-outs whose thread is gone are orphans; live threads are not", () => {
  const pane = (id, extra = {}) => ({ id, workspaceId: "w1", kind: "chat", title: id, ...extra });
  const panes = [pane("live"), pane("shut", { closed: true }), pane("away", { archived: true }), pane("moved")];
  const listed = [pane("live"), pane("shut"), pane("away")]; // "moved" left the list with its project; "gone" was deleted.
  const popped = ["live", "shut", "away", "moved", "gone"].map((id) => ({ token: `t-${id}`, id }));
  assert.deepEqual(orphanedPopouts(popped, panes, listed).map((o) => o.id), ["shut", "away", "moved", "gone"]);
});

test("a fork settles only with the owner's result, and its error rejects", async () => {
  const channel = createForkChannel();
  const ok = channel.request();
  assert.equal(channel.pendingCount(), 1);
  assert.equal(channel.settle({ requestId: "fork-999", title: "Nope" }), false);
  assert.equal(channel.settle({ requestId: ok.requestId, title: "Thread (fork)" }), true);
  assert.equal(await ok.result, "Thread (fork)");
  const failed = channel.request();
  const check = assert.rejects(failed.result, /no group chat with id/);
  assert.equal(channel.settle({ requestId: failed.requestId, error: "no group chat with id r1" }), true);
  await check;
  assert.equal(channel.pendingCount(), 0);
});

test('Artifacts popout follows its visible thread and workspace while another tool has focus', async () => {
  const { followedTabPane } = await import('../src/popoutModel.ts');
  const thread = {id:'thread',kind:'chat',workspaceId:'remote-project'};
  const terminal = {id:'terminal',kind:'terminal',workspaceId:'local-project'};
  assert.equal(followedTabPane('artifacts',[thread,terminal],'terminal','thread'),thread);
  assert.equal(followedTabPane('artifacts',[thread,terminal],'thread',null),null,'no hidden thread leaks into the tab');
  assert.equal(followedTabPane('files',[thread,terminal],'terminal','thread'),terminal,'other tools still follow focus');
});


test("the floating assistant window is a view: it shows one conversation and can only ask", async () => {
  const { assistantFloatState, validFloatAction, assistantCallCandidate } = await import("../src/assistantFloat.ts");
  const ref = { hostId: "h", assistantId: "a" };
  const lane = { name: "Alfred", offline: false, assistant: { conversationFrom: 10, messages: [
    { id: "old", role: "human", kind: "chat", text: "old", at: 5 },
    { id: "new", role: "assistant", kind: "chat", text: "hi", at: 20 },
    { id: "ask", role: "system", kind: "approval", text: "private detail", at: 21 },
    { id: "note", role: "system", kind: "notice", text: "n", at: 22 },
  ] } };
  const voice = { status: "listening", muted: true, startedAt: 7, scope: { hostId: "h", roomId: "assistant:a" } };
  const state = assistantFloatState({ lane, ref, draft: "typed", error: "", alwaysOnTop: false, voice });
  assert.deepEqual(state.lines.map(line => line.id), ["new", "ask"], "a new conversation hides older lines, which stay saved");
  assert.equal(state.lines[1].approval, true);
  assert.deepEqual(state.call, { muted: true, startedAt: 7 });
  assert.equal(state.draft, "typed");
  assert.equal(assistantFloatState({ lane, ref, draft: "", error: "", alwaysOnTop: false, voice: { ...voice, scope: { hostId: "other", roomId: "assistant:a" } } }).call, null, "the same id on another host is another call");
  assert.equal(assistantFloatState({ lane, ref, draft: "", error: "", alwaysOnTop: false, voice: { ...voice, status: "off" } }).call, null);
  assert.equal(assistantCallCandidate(lane, ref).roomId, "assistant:a");
  assert.ok(validFloatAction({ type: "assistant-send", text: "hi", requestId: "r-1" }));
  for (const bad of [null, { type: "close-pane" }, { type: "assistant-send", text: " ", requestId: "r" }, { type: "assistant-send", text: "hi", requestId: "../x" }, { type: "assistant-mute", muted: "yes" }]) assert.equal(validFloatAction(bad), false);
});

test("an assistant window keeps its place and pin, and survives the restore of panes", async () => {
  const { PopoutLayoutStore, fitPopoutBounds } = await import("../desktop/popoutLayout.mjs");
  const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "float-layout-"));
  const store = new PopoutLayoutStore(dir + "/layout.json");
  store.set({ kind: "assistant", id: "[h,a]", bounds: { x: 3000, y: 10, width: 380, height: 560 }, maximized: false, alwaysOnTop: true });
  store.set({ kind: "pane", id: "gone", bounds: { x: 0, y: 0, width: 400, height: 300 }, maximized: false });
  assert.deepEqual(store.restore({ panes: [], tabs: [] }), [], "an assistant window reopens only by choice");
  const saved = new PopoutLayoutStore(dir + "/layout.json").get("assistant", "[h,a]");
  assert.equal(saved.alwaysOnTop, true);
  const fitted = fitPopoutBounds(saved.bounds, [{ x: 0, y: 0, width: 1440, height: 900 }]);
  assert.ok(fitted.x + fitted.width <= 1440, "a removed screen pulls the window back");
});
