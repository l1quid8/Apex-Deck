import test from "node:test";
import assert from "node:assert/strict";
import { closeNeedsConfirm, closeQuestion, loadedPanes, openPanes, paneSection, restoredLayouts, savedLayouts, quitQuestion, removeCounts, removeQuestion, savedPanes, stillRunning } from "../src/closing.ts";

const chat = (id, extra = {}) => ({ id, workspaceId: "w", kind: "chat", title: id, ...extra });
const term = (id, extra = {}) => ({ id, workspaceId: "w", kind: "terminal", title: id, ...extra });
const leaf = (id) => ({ kind: "leaf", id });
const row = (children, sizes) => ({ kind: "split", dir: "row", children, sizes });

test("only a busy or waiting terminal asks before closing", () => {
  assert.equal(closeNeedsConfirm("terminal", "working"), true);
  assert.equal(closeNeedsConfirm("terminal", "needs_input"), true);
  for (const status of ["idle", "exited", "done", "failed"]) assert.equal(closeNeedsConfirm("terminal", status), false, status);
  for (const status of ["working", "needs_input", "idle"]) assert.equal(closeNeedsConfirm("chat", status), false, status);
});

test("the question says whether the terminal is working or waiting", () => {
  assert.equal(closeQuestion("Codex", "working").title, "Codex is still working.");
  assert.equal(closeQuestion("Codex", "needs_input").title, "Codex is waiting for you.");
  assert.equal(closeQuestion("Codex", "working").action, "End and close");
});

test("closed threads and threads being deleted are off the deck", () => {
  const panes = [chat("a"), chat("b", { closed: true }), chat("c"), term("t")];
  assert.deepEqual(openPanes(panes, new Set(["c"])).map((p) => p.id), ["a", "t"]);
});

test("a thread waiting out its undo time is still saved, so quitting keeps it", () => {
  const panes = [chat("a"), chat("gone-soon"), term("t")];
  // The deck hides "gone-soon", but the session file must still hold it.
  assert.deepEqual(savedPanes(panes).filter((p) => p.kind === "chat").map((p) => p.id), ["a", "gone-soon"]);
});

test("a closed thread stays saved", () => {
  assert.deepEqual(savedPanes([chat("a", { closed: true })]).map((p) => p.closed), [true]);
});

test("terminals are saved as descriptors: id, workspace, name and tool only", () => {
  const saved = savedPanes([term("t1", { title: "Codex 2", agent: "codex", closed: true, extra: "x" }), term("t2", { title: "Terminal" })]);
  assert.deepEqual(saved, [
    { id: "t1", workspaceId: "w", kind: "terminal", title: "Codex 2", agent: "codex" },
    { id: "t2", workspaceId: "w", kind: "terminal", title: "Terminal" },
  ]);
  // Written as JSON, a plain shell has no agent field at all.
  assert.equal(JSON.stringify(saved[1]), '{"id":"t2","workspaceId":"w","kind":"terminal","title":"Terminal"}');
});

test("an older session file without the closed field opens every thread", () => {
  const saved = [chat("a"), chat("b"), chat("other", { workspaceId: "gone" }), null];
  const loaded = loadedPanes(saved, ["w"]);
  assert.deepEqual(loaded.map((p) => p.id), ["a", "b"]);
  assert.ok(loaded.every((p) => p.closed === false));
  assert.deepEqual(openPanes(loaded, new Set()).map((p) => p.id), ["a", "b"]);
});

test("a thread saved as closed stays closed", () => {
  assert.equal(loadedPanes([chat("a", { closed: true })], ["w"])[0].closed, true);
});

test("terminals load back as descriptors, in saved order beside threads", () => {
  const saved = [chat("a"), term("t1", { title: "Codex", agent: "codex" }), term("t2", { title: "Terminal" })];
  assert.deepEqual(loadedPanes(saved, ["w"]), [
    { ...chat("a"), closed: false },
    { id: "t1", workspaceId: "w", kind: "terminal", title: "Codex", agent: "codex" },
    { id: "t2", workspaceId: "w", kind: "terminal", title: "Terminal" },
  ]);
});

test("malformed or repeated panes in a session file are left out and the rest load", () => {
  const saved = [
    term("ok", { title: "Codex", agent: "codex" }),
    term("no-title", { title: "" }),
    term("bad-title", { title: 7 }),
    term("bad-agent", { agent: 3 }),
    term("gone", { workspaceId: "removed" }),
    { kind: "terminal", workspaceId: "w", title: "No id" },
    { id: "odd", workspaceId: "w", kind: "browser", title: "Odd" },
    term("ok", { title: "Duplicate" }),
    term("null-agent", { agent: null, closed: true, running: true }),
    "junk",
    42,
  ];
  assert.deepEqual(loadedPanes(saved, ["w"]), [
    { id: "ok", workspaceId: "w", kind: "terminal", title: "Codex", agent: "codex" },
    { id: "null-agent", workspaceId: "w", kind: "terminal", title: "null-agent" },
  ]);
});

const status = (replying, waiting = []) => ({ text: "", replying, waiting });

test("removing a workspace asks only while something in it is running", () => {
  assert.equal(removeQuestion("apex-deck", removeCounts(["idle", "exited", "done", "failed"], [status([]), undefined])), null);
  assert.notEqual(removeQuestion("apex-deck", removeCounts(["working"], [])), null);
  assert.notEqual(removeQuestion("apex-deck", removeCounts(["needs_input"], [])), null);
  assert.notEqual(removeQuestion("apex-deck", removeCounts([], [status(["Jigga"])])), null);
  assert.notEqual(removeQuestion("apex-deck", removeCounts([], [status([], ["Null"])])), null);
});

test("the remove question says what ends and that the threads stay saved", () => {
  const asked = removeQuestion("apex-deck", { working: 2, waiting: 1, replying: 0, asking: 0, threads: 4 });
  assert.equal(asked.title, "Remove apex-deck from the list?");
  assert.equal(asked.body, "2 terminals are working and 1 is waiting for you. They end now. Its 4 threads stay saved and come back if you add the folder again.");
  assert.equal(asked.action, "Remove from list");
});

test("clauses whose count is 0 are left out", () => {
  assert.equal(removeQuestion("w", { working: 1, waiting: 0, replying: 0, asking: 0, threads: 0 }).body, "1 terminal is working. It ends now.");
  assert.equal(removeQuestion("w", { working: 0, waiting: 1, replying: 0, asking: 0, threads: 1 }).body, "1 terminal is waiting for you. It ends now. Its thread stays saved and comes back if you add the folder again.");
  assert.equal(removeQuestion("w", { working: 0, waiting: 0, replying: 1, asking: 1, threads: 3 }).body, "1 thread is replying and 1 is waiting for you. They stop now. Its 3 threads stay saved and come back if you add the folder again.");
  assert.equal(removeQuestion("w", { working: 0, waiting: 0, replying: 2, asking: 0, threads: 2 }).body, "2 threads are replying. They stop now. Its 2 threads stay saved and come back if you add the folder again.");
});

test("a thread with a bot on a card counts as waiting, even while another bot replies", () => {
  assert.deepEqual(
    removeCounts(["working", "needs_input", "idle"], [status(["Jigga"], ["Null"]), status(["Ada"]), status([]), undefined]),
    { working: 1, waiting: 1, replying: 1, asking: 1, threads: 4 },
  );
});

const terminal = (title, agent, status, exited = false) => ({ title, workspace: "apex-deck", agent, exited, status });
const thread = (title, replying, waiting = []) => ({ title, workspace: "apex-deck", status: { text: "", replying, waiting } });
const QUIT_BODY = "Quitting ends them and anything they're running. Threads and their messages are saved; replies in progress are not.";

test("nothing running quits at once", () => {
  assert.equal(quitQuestion(stillRunning([terminal("Terminal", false, "idle")], [thread("Fix login", []), { title: "New", workspace: "w", status: undefined }])), null);
});

test("the quit question names what is still running, most urgent first", () => {
  const asked = quitQuestion(stillRunning([terminal("Codex", true, "working")], [thread("Fix login", ["Jigga"], ["Null"])]));
  assert.equal(asked.title, "3 agents are still running.");
  assert.equal(asked.body, QUIT_BODY);
  assert.deepEqual(asked.rows, ["Null in Fix login · apex-deck · Waiting for you", "Codex · apex-deck · Working", "Jigga in Fix login · apex-deck · Replying"]);
  assert.equal(asked.action, "Quit and end them");
});

test("one thing running: named when it waits, counted when it works", () => {
  assert.equal(quitQuestion(stillRunning([], [thread("Fix login", [], ["Null"])])).title, "Null is waiting for you.");
  assert.equal(quitQuestion(stillRunning([terminal("Codex", true, "needs_input")], [])).title, "Codex is waiting for you.");
  assert.equal(quitQuestion(stillRunning([terminal("Codex", true, "working")], [])).title, "1 agent is still running.");
});

test("at most five rows, then how many more", () => {
  const codex = (n) => terminal(`Codex ${n}`, true, "working");
  assert.equal(quitQuestion(stillRunning([1, 2, 3, 4, 5].map(codex), [])).rows.length, 5);
  const rows = quitQuestion(stillRunning([1, 2, 3, 4, 5, 6, 7].map(codex), [])).rows;
  assert.equal(rows.length, 6);
  assert.equal(rows[5], "and 2 more");
});

test("an exited terminal never counts, even with a Failed flag", () => {
  // An idle agent still counts; an idle or finished shell doesn't.
  const running = stillRunning([
    terminal("Codex", true, "failed", true),
    terminal("Claude Code", true, "idle"),
    terminal("Gemini CLI", true, "done"),
    terminal("Terminal", false, "done"),
    terminal("Terminal", false, "idle"),
    terminal("Terminal", false, "needs_input"),
    terminal("Terminal", false, "working"),
  ], []);
  assert.deepEqual(running.map((r) => [r.name, r.state]), [["Claude Code", "idle"], ["Gemini CLI", "idle"], ["Terminal", "waiting"], ["Terminal", "working"]]);
});

test("a thread keeps where you stopped reading; older files load without it", () => {
  assert.equal(savedPanes([chat("a", { lastSeenSeq: 7 })])[0].lastSeenSeq, 7);
  assert.equal(loadedPanes([chat("a", { lastSeenSeq: 7 })], ["w"])[0].lastSeenSeq, 7);
  assert.equal(loadedPanes([chat("a")], ["w"])[0].lastSeenSeq, undefined);
});

test("Threads and Code layouts are saved for workspaces still listed", () => {
  const layouts = { "w:threads": leaf("a"), "w:code": leaf("t"), "gone:code": leaf("x"), ":code": leaf("y"), "w:agents": leaf("z") };
  assert.deepEqual(savedLayouts(layouts, ["w"]), { "w:threads": leaf("a"), "w:code": leaf("t") });
});

test("a saved layout drops panes that didn't load and gives their space to the rest", () => {
  const panes = [term("t1"), term("t2"), chat("a")];
  const saved = { "w:code": row([leaf("t1"), leaf("t2"), leaf("gone")], [0.25, 0.25, 0.5]) };
  assert.deepEqual(restoredLayouts(saved, panes), { "w:code": row([leaf("t1"), leaf("t2")], [0.5, 0.5]) });
});

test("a layout left with no panes, or one that can't be read, is dropped", () => {
  const panes = [term("t1"), chat("a")];
  const saved = {
    "w:code": row([leaf("gone"), leaf("a")], [0.5, 0.5]),
    "w:threads": { kind: "split", dir: "diagonal", children: [], sizes: [] },
    "other:threads": leaf("a"),
    "w:agents": leaf("t1"),
    nocolon: leaf("t1"),
  };
  assert.deepEqual(restoredLayouts(saved, panes), {});
  assert.deepEqual(restoredLayouts(null, panes), {});
  assert.deepEqual(restoredLayouts("junk", panes), {});
  assert.deepEqual(restoredLayouts([leaf("t1")], panes), {});
});

test("a layout that only holds panes that loaded comes back unchanged", () => {
  const panes = [term("t1"), term("t2"), chat("a"), chat("b")];
  const saved = { "w:code": row([leaf("t1"), leaf("t2")], [0.7, 0.3]), "w:threads": leaf("a") };
  assert.deepEqual(restoredLayouts(saved, panes), saved);
});

const preview = (id, extra = {}) => ({ id, workspaceId: "w", kind: "preview", title: id, url: "http://localhost:5173/", ...extra });

test("a preview is saved and read back with its address and source terminal", () => {
  const saved = savedPanes([preview("p", { servedBy: "t", stray: 1 })]);
  assert.deepEqual(saved, [{ id: "p", workspaceId: "w", kind: "preview", title: "p", url: "http://localhost:5173/", servedBy: "t" }]);
  assert.deepEqual(loadedPanes(saved, ["w"]), saved);
});

test("a preview with an address that isn't a web address loads empty, and a nameless one is left out", () => {
  const [loaded] = loadedPanes([preview("p", { url: "javascript:alert(1)" })], ["w"]);
  assert.equal(loaded.url, "");
  assert.deepEqual(loadedPanes([preview("q", { title: " " })], ["w"]), []);
});

test("previews keep their place in the Code layout", () => {
  const tree = row([leaf("t"), leaf("p")], [0.5, 0.5]);
  assert.deepEqual(restoredLayouts({ "w:code": tree }, [term("t"), preview("p")])["w:code"], tree);
});

test("a preview remembers which deck it is on, and one without a deck is on Code", () => {
  const saved = savedPanes([preview("p", { deck: "threads" })]);
  assert.equal(saved[0].deck, "threads");
  assert.equal(loadedPanes(saved, ["w"])[0].deck, "threads");
  assert.equal(loadedPanes([preview("q", { deck: "elsewhere" })], ["w"])[0].deck, undefined);
  assert.equal(paneSection(preview("q")), "code");
  assert.equal(paneSection(preview("r", { deck: "threads" })), "threads");
  assert.equal(paneSection(chat("c")), "threads");
  assert.equal(paneSection(term("t")), "code");
});

test("a preview on the Threads deck keeps its place beside threads, not terminals", () => {
  const tree = row([leaf("c"), leaf("p")], [0.5, 0.5]);
  const panes = [chat("c"), preview("p", { deck: "threads" })];
  assert.deepEqual(restoredLayouts({ "w:threads": tree }, panes)["w:threads"], tree);
  assert.equal(restoredLayouts({ "w:code": tree }, panes)["w:code"], undefined);
});
