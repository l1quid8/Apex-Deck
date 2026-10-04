import test from "node:test";
import assert from "node:assert/strict";
import { closeNeedsConfirm } from "../src/closing.ts";
import {
  STOPPED, canStart, clock, exitBar, exitLine, exitSignal, exited, isRunning, ptyIdFor, started, startedAgainLine,
  stateWord, stoppedNotice, terminalStatus, toolInstalled, toolName,
} from "../src/terminalRun.ts";

// 4 October 2026, 14:02 and 14:05 local time.
const at1402 = new Date(2026, 9, 4, 14, 2, 30).getTime();
const at1405 = new Date(2026, 9, 4, 14, 5, 0).getTime();
const agents = [
  { key: "codex", label: "Codex", program: "codex", found: true },
  { key: "gemini", label: "Gemini CLI", program: "gemini", found: false },
];

test("each start gets a new PTY id from the pane id and its generation", () => {
  const first = started(STOPPED, at1402);
  const second = started(exited(first, 1, 0, at1402), at1405);
  assert.equal(ptyIdFor("pane-a", first.generation), "pane-a:1");
  assert.equal(ptyIdFor("pane-a", second.generation), "pane-a:2");
  assert.deepEqual(second, { state: "running", generation: 2, code: null, at: at1405 });
});

test("an exit is recorded with its code and time", () => {
  const run = exited(started(STOPPED, at1402), 1, 1, at1405);
  assert.deepEqual(run, { state: "exited", generation: 1, code: 1, at: at1405 });
  assert.equal(isRunning(run), false);
  assert.equal(canStart(run), true);
});

test("a late exit from an earlier start never ends the new one", () => {
  const first = started(STOPPED, at1402);
  const again = started(exited(first, 1, 1, at1402), at1405);
  // The first program's exit arrives a second time, after Start again.
  assert.equal(exited(again, 1, 1, at1405 + 1000), again);
  assert.equal(isRunning(again), true);
  // An exit that arrives twice for the same start changes nothing the second time.
  const ended = exited(again, 2, 0, at1405 + 2000);
  assert.equal(exited(ended, 2, 0, at1405 + 3000), ended);
});

test("start is offered only when the program isn't running", () => {
  assert.equal(canStart(STOPPED), true);
  assert.equal(canStart(started(STOPPED, at1402)), false);
});

test("a stopped terminal is not running, reads exited, and closes without asking", () => {
  assert.equal(isRunning(STOPPED), false);
  assert.equal(isRunning(undefined), false);
  assert.equal(terminalStatus(STOPPED, null, true), "exited");
  assert.equal(closeNeedsConfirm("terminal", terminalStatus(STOPPED, null, true)), false);
  const ended = exited(started(STOPPED, at1402), 1, 0, at1405);
  assert.equal(closeNeedsConfirm("terminal", terminalStatus(ended, null, true)), false);
});

test("a running terminal reads working or idle from its output, and a flag wins", () => {
  const running = started(STOPPED, at1402);
  assert.equal(terminalStatus(running, null, true), "working");
  assert.equal(terminalStatus(running, null, false), "idle");
  assert.equal(terminalStatus(running, "needs_input", false), "needs_input");
  assert.equal(terminalStatus(undefined, null, false), "idle");
  assert.equal(terminalStatus(exited(running, 1, 1, at1405), "failed", false), "failed");
});

test("the pane head says Stopped, Exited, Working or Idle", () => {
  const running = started(STOPPED, at1402);
  assert.equal(stateWord(STOPPED, false), "Stopped");
  assert.equal(stateWord(exited(running, 1, 0, at1405), true), "Exited");
  assert.equal(stateWord(running, true), "Working");
  assert.equal(stateWord(running, false), "Idle");
  assert.equal(stateWord(undefined, false), "Idle");
});

test("times read as 24-hour hours and minutes", () => {
  assert.equal(clock(at1402), "14:02");
  assert.equal(clock(new Date(2026, 9, 4, 9, 7).getTime()), "09:07");
});

test("the exit bar gives the code, the time and Start <name> again", () => {
  const failed = exited(started(STOPPED, at1402), 1, 1, at1402);
  assert.deepEqual(exitBar(failed, "Codex"), { text: "Exited with code 1 · 14:02", start: "Start Codex again" });
  const unknown = exited(started(STOPPED, at1402), 1, null, at1405);
  assert.deepEqual(exitBar(unknown, "Codex 2"), { text: "Exited · 14:05", start: "Start Codex 2 again" });
});

test("the scrollback marks where a program ended and started again", () => {
  assert.equal(exitLine(1, at1402), "\r\n\x1b[2m— exited with code 1 · 14:02 —\x1b[0m\r\n");
  assert.equal(exitLine(null, at1402), "\r\n\x1b[2m— exited · 14:02 —\x1b[0m\r\n");
  assert.equal(startedAgainLine(at1405), "\r\n\x1b[2m— started again 14:05 —\x1b[0m\r\n");
});

test("only an exit with an error flags Failed", () => {
  assert.deepEqual(exitSignal(1), { kind: "failed", note: "Failed · exited with code 1" });
  assert.deepEqual(exitSignal(127), { kind: "failed", note: "Failed · exited with code 127" });
  assert.equal(exitSignal(0), null);
  assert.equal(exitSignal(null), null);
});

test("a restored terminal says it stopped, or that its tool is gone", () => {
  assert.deepEqual(stoppedNotice("Codex", "Codex", true), { text: "Codex stopped when Apex Deck quit. Earlier output isn't kept.", start: "Start Codex" });
  assert.deepEqual(stoppedNotice("Codex 2", "Codex", false), { text: "Codex isn't installed.", start: "Start Codex 2" });
});

test("a tool counts as installed when found, when it is a shell, or when the list couldn't be read", () => {
  assert.equal(toolInstalled("codex", agents), true);
  assert.equal(toolInstalled("gemini", agents), false);
  assert.equal(toolInstalled("aider", agents), false);
  assert.equal(toolInstalled(undefined, agents), true);
  assert.equal(toolInstalled("codex", []), true);
});

test("a tool's name comes from the list, falling back to its key", () => {
  assert.equal(toolName("codex", agents), "Codex");
  assert.equal(toolName("aider", agents), "aider");
  assert.equal(toolName(undefined, agents), "Terminal");
});
