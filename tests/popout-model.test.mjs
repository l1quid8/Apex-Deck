import test from "node:test";
import assert from "node:assert/strict";
import { renamedAgents } from "../src/agentRenames.ts";
import { addLeaf, leafIds, moveLeaf, resize } from "../src/layout.ts";
import { changedProfiles, createForkChannel, orphanedPopouts, popoutRefusal, restorePane, restoreTab, retargetPoppedTab, takePaneOut, takeTabOut, upsertProfiles } from "../src/popoutModel.ts";
import { defaultPanel, openTab } from "../src/rightPanelModel.ts";

test("task threads are refused a pop-out; ordinary panes are not", () => {
  // A task thread lives in the assistant's list, not Deck's panes, so popping one
  // out opened a window the gone-thread check closed again at once.
  assert.equal(popoutRefusal({ assistantTaskId: "task-1" }), "Task threads stay in Deck for now.");
  assert.equal(popoutRefusal({}), null);
  assert.equal(popoutRefusal({ assistantTaskId: undefined }), null);
  assert.equal(popoutRefusal({ assistantTaskId: "" }), null);
});

test("taking a pane out remembers a neighbour and restores beside it", () => {
  let tree = addLeaf(null, "a");
  tree = addLeaf(tree, "b", 1.6);
  tree = addLeaf(tree, "c", 1.6);
  const out = takePaneOut(tree, "w1", "b");
  assert.deepEqual(leafIds(out.layout).sort(), ["a", "c"]);
  // b and c share a column, so c is the neighbour, not a.
  assert.deepEqual(out.spot.neighborIds, ["c"]);
  const back = restorePane(out.layout, "b", out.spot);
  assert.deepEqual(leafIds(back).sort(), ["a", "b", "c"]);
});

test("restoring falls back when the neighbour is gone", () => {
  let tree = addLeaf(null, "a");
  tree = addLeaf(tree, "b", 1.6);
  const out = takePaneOut(tree, "w1", "a");
  assert.deepEqual(out.spot.neighborIds, ["b"]);
  // Neighbour closed meanwhile: only c remains.
  let current = addLeaf(null, "c");
  const back = restorePane(current, "a", out.spot);
  assert.deepEqual(leafIds(back).sort(), ["a", "c"]);
});

test("restoring into an empty layout makes a lone leaf", () => {
  const out = takePaneOut(addLeaf(null, "a"), "w1", "a");
  assert.equal(out.layout, null);
  assert.deepEqual(out.spot.neighborIds, []);
  assert.deepEqual(restorePane(out.layout, "a", out.spot), { kind: "leaf", id: "a" });
});

test("restoring a pane that is already back changes nothing", () => {
  const tree = addLeaf(addLeaf(null, "a"), "b", 1.6);
  const out = takePaneOut(tree, "w1", "missing");
  assert.deepEqual(out.layout, tree);
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

test("an unchanged layout comes back exactly: same order, same sizes", () => {
  // Null's repro: [a, b] at 30/70 must not return as [b, a] at 50/50.
  const tree = { kind: "split", dir: "row", children: [{ kind: "leaf", id: "a" }, { kind: "leaf", id: "b" }], sizes: [0.3, 0.7] };
  const out = takePaneOut(tree, "w1", "b");
  assert.equal(out.spot.side, "right");
  assert.equal(out.spot.share, 0.7);
  const back = restorePane(out.layout, "b", out.spot);
  assert.deepEqual(back, tree);
});

test("popping the first pane remembers the left side", () => {
  const tree = { kind: "split", dir: "row", children: [{ kind: "leaf", id: "a" }, { kind: "leaf", id: "b" }], sizes: [0.3, 0.7] };
  const out = takePaneOut(tree, "w1", "a");
  assert.equal(out.spot.side, "left");
  assert.equal(out.spot.share, 0.3);
  assert.deepEqual(restorePane(out.layout, "a", out.spot), tree);
});

test("a changed layout returns the pane to its remembered side at its remembered size", () => {
  const tree = { kind: "split", dir: "row", children: [{ kind: "leaf", id: "a" }, { kind: "leaf", id: "b" }], sizes: [0.3, 0.7] };
  const out = takePaneOut(tree, "w1", "b");
  // Meanwhile another pane opened: b must land right of a again, near 70% of its split.
  const changed = addLeaf(out.layout, "c");
  assert.ok(leafIds(changed).includes("c"));
  const back = restorePane(changed, "b", out.spot);
  assert.deepEqual(leafIds(back), ["a", "b", "c"]);
  assert.equal(back.kind, "split");
  assert.ok(Math.abs(back.sizes[1] - 0.7) < 1e-9);
});

test("a column pop-out remembers top and bottom", () => {
  const tree = { kind: "split", dir: "column", children: [{ kind: "leaf", id: "a" }, { kind: "leaf", id: "b" }], sizes: [0.5, 0.5] };
  assert.equal(takePaneOut(tree, "w1", "a").spot.side, "top");
  assert.equal(takePaneOut(tree, "w1", "b").spot.side, "bottom");
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

// A layout's shape without sizes, e.g. "row(column(a,b),c)", so nested placement reads at a glance.
const shape = (n) => (n.kind === "leaf" ? n.id : `${n.dir}(${n.children.map(shape).join(",")})`);
const L = (id) => ({ kind: "leaf", id });
const S = (dir, children, sizes) => ({ kind: "split", dir, children, sizes: sizes ?? children.map(() => 1 / children.length) });

test("a nested pane returns into its own split after the remaining divider moves", () => {
  // Null's repro: a above b, with c alongside. b belongs below a, not above c.
  const tree = S("row", [S("column", [L("a"), L("b")], [0.4, 0.6]), L("c")]);
  const out = takePaneOut(tree, "w1", "b");
  const moved = resize(out.layout, { path: [], index: 0 }, 0.7);
  const back = restorePane(moved, "b", out.spot);
  assert.equal(shape(back), "row(column(a,b),c)");
  // The divider the person moved stays moved; b gets its old share of its own split.
  assert.ok(Math.abs(back.sizes[0] - 0.7) < 1e-9);
  assert.ok(Math.abs(back.children[0].sizes[1] - 0.6) < 1e-9);
});

test("a pane returns beside its whole neighbouring group, which keeps its own sizes", () => {
  // b sat right of the a-over-d stack: going back beside a or d alone would cut the stack in two.
  const tree = S("row", [S("column", [L("a"), L("d")]), L("b")], [0.6, 0.4]);
  const out = takePaneOut(tree, "w1", "b");
  const moved = resize(out.layout, { path: [], index: 0 }, 0.3);
  const back = restorePane(moved, "b", out.spot);
  assert.equal(shape(back), "row(column(a,d),b)");
  assert.ok(Math.abs(back.sizes[1] - 0.4) < 1e-9);
  assert.deepEqual(back.children[0].sizes.map((s) => Math.round(s * 100)), [30, 70]);
});

test("a group folded into the outer split by the pop-out is regrouped on return", () => {
  // b sat above the c|e row. Taking b out folds c and e into the outer row, beside the a-over-d stack.
  const tree = S("row", [S("column", [L("a"), L("d")]), S("column", [L("b"), S("row", [L("c"), L("e")])], [0.4, 0.6])]);
  const out = takePaneOut(tree, "w1", "b");
  assert.equal(shape(out.layout), "row(column(a,d),c,e)");
  const moved = resize(out.layout, { path: [], index: 0 }, 0.6);
  const back = restorePane(moved, "b", out.spot);
  assert.equal(shape(back), "row(column(a,d),column(b,row(c,e)))");
  assert.ok(Math.abs(back.children[1].sizes[0] - 0.4) < 1e-9);
});

test("a neighbouring group broken up meanwhile falls back to its nearest pane", () => {
  const tree = S("row", [S("column", [L("a"), L("d")]), S("column", [L("b"), S("row", [L("c"), L("e")])])]);
  const out = takePaneOut(tree, "w1", "b");
  // e was dragged into the a-over-d stack, so no subtree or run holds just c and e any more.
  const moved = moveLeaf(out.layout, "e", "d", "bottom");
  const back = restorePane(moved, "b", out.spot);
  assert.equal(shape(back), "row(column(a,d,e),column(b,c))");
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
