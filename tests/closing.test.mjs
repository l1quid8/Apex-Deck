import test from "node:test";
import assert from "node:assert/strict";
import { closeNeedsConfirm, closeQuestion, loadedThreads, openPanes, quitQuestion, removeCounts, removeQuestion, savedThreads, stillRunning } from "../src/closing.ts";

const chat = (id, extra = {}) => ({ id, workspaceId: "w", kind: "chat", title: id, ...extra });
const term = (id, extra = {}) => ({ id, workspaceId: "w", kind: "terminal", title: id, ...extra });

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
  assert.deepEqual(savedThreads(panes).map((p) => p.id), ["a", "gone-soon"]);
});

test("a closed thread stays saved", () => {
  assert.deepEqual(savedThreads([chat("a", { closed: true })]).map((p) => p.closed), [true]);
});

test("an older session file without the closed field opens every thread", () => {
  const saved = [chat("a"), chat("b"), chat("other", { workspaceId: "gone" }), term("t"), null];
  const loaded = loadedThreads(saved, ["w"]);
  assert.deepEqual(loaded.map((p) => p.id), ["a", "b"]);
  assert.ok(loaded.every((p) => p.closed === false));
  assert.deepEqual(openPanes(loaded, new Set()).map((p) => p.id), ["a", "b"]);
});

test("a thread saved as closed stays closed", () => {
  assert.equal(loadedThreads([chat("a", { closed: true })], ["w"])[0].closed, true);
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
  assert.equal(savedThreads([chat("a", { lastSeenSeq: 7 })])[0].lastSeenSeq, 7);
  assert.equal(loadedThreads([chat("a", { lastSeenSeq: 7 })], ["w"])[0].lastSeenSeq, 7);
  assert.equal(loadedThreads([chat("a")], ["w"])[0].lastSeenSeq, undefined);
});
