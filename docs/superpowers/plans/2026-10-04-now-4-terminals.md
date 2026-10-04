# Now tier, Stage 4: terminals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminal panes get names, numbering and the program's own title, a ⋯ menu like threads have, a way to start the program again after it ends, and a place in the saved session, so after a restart they come back Stopped (never started) in the same layout.

**Architecture:** Three new pure modules carry the rules and copy, each with node:test tests: `src/terminalRun.ts` (a terminal's program over the life of its pane: stopped, running or exited, with one PTY id per start, `<pane id>:<generation>`), `src/terminalTitle.ts` (numbering, cleaning and throttling program titles) and `src/paneMenu.ts` (the ⋯ menu's items). `src/closing.ts` generalises `savedThreads`/`loadedThreads` to `savedPanes`/`loadedPanes` (terminal descriptors `{ id, workspaceId, kind: "terminal", title, agent }`) and gains `savedLayouts`/`restoredLayouts` so Code layouts are saved too. `TerminalPane` owns the xterm and the program, reports each start and exit to `App` through `onRun`, and draws the exit bar and the Stopped notice. Nothing here changes Rust: the session file is opaque JSON to the native side (`src-tauri/src/storage.rs:63-69`), and fresh PTY ids avoid the one native hazard (the exit thread in `src-tauri/src/pty.rs:122-128` removes its session by id, so a reused id would let an old program's exit remove the new session and route its `pty-exit` to the new run).

**Tech Stack:** Tauri 2, React 19, TypeScript, @xterm/xterm 6 (`onTitleChange`), node:test with `--experimental-strip-types`, Vite.

**Spec:** docs/superpowers/specs/2026-10-04-now-tier.md

## Global Constraints

- Preserve everything in "Must keep working" of `2026-10-03-ui-review-fixes.md`: approval cards, the turn queue and steering, `/compact` `/clear` `/pin` `/diff` `/fork` `/export`, attention counts, dragging panes without remounting terminals, and the browser preview behaving like the native app.
- The browser preview backend (`src/backend.ts`, preview half) gets every new command and event the native backend gets.
- Restoring or applying anything never silently raises access or starts an agent. Keys stay out of saved state.
- Standing decisions (`2026-10-03-open-work.md`): slash commands only create something or take text you'd type; no coloured left bars on strips or rows; pins stay a collapsible row above the chat; agent colours are chosen once and saved.
- Copy: second person, plain, sentence case, verb-first buttons, "e.g." placeholders, " · " joins facts, no emoji. Attention colours always come with words. Red (`--danger`) means Failed and destructive actions only.
- No new dependencies.
- New files differ from every existing file name by more than case.
- Commit on the stage's feature branch. Don't push and don't merge to `main` unless Tyler asks.
- Checks: `npm test`, `npm run build`, and when Rust changes `cargo test --workspace -- --test-threads=1` (the suite only passes serially). This plan changes no Rust, so its checks are `npm test` and `npm run build`.
- Shared interface names are fixed: `savedPanes` / `loadedPanes` in `src/closing.ts`, keeping terminal descriptors `{ id, workspaceId, kind: "terminal", title, agent }`.

## Review Focus

1. **A late exit after Start again.** A `pty-exit` from an earlier start (a quick Start again, or an exit reported twice) must never end, flag or relabel the new run. Test: Task 1, "a late exit from an earlier start never ends the new one".
2. **Stopped terminals are not running.** Right after a restart, closing a Stopped terminal must close at once, and stage 1's quit question must not count it as running. Test: Task 1, "a stopped terminal is not running, reads exited, and closes without asking" (and Task 2 routes stage 1's quit check through `isRunning`).
3. **Old and damaged session files.** A session saved before this stage (threads only), or one with a malformed, repeated or orphaned pane entry, must load everything valid, drop the rest, and start nothing. Tests: Task 3, "an older session file without the closed field opens every thread" and "malformed or repeated panes in a session file are left out and the rest load".
4. **Odd program titles.** Escape codes, control characters, spinner-only titles, emoji, titles over 60 characters, and titles that repeat the tool's own name must show as short plain text or not at all, never "Codex · Codex". Tests: Task 6, "a program title is plain text on one line", "a title with nothing readable is empty", "a long title is cut to 60 characters with an ellipsis", "a program title that only repeats the pane's or tool's name is not shown".
5. **Title floods.** A spinner retitling every 30 ms must show at most four titles a second and always end on the last one. Test: Task 6, "a spinner retitling every 30 ms shows at most four titles a second and ends on the last".

---

## Before you start: line numbers and earlier stages

- Line numbers below are from `main@95d753d` plus Tyler's uncommitted composer edits in `src/ChatPane.tsx` (the file as it is in the working tree on 2026-10-04). This stage runs after stage 1 (required: both change `src/closing.ts` and the saved session) and, in the order of work, after stages 2 and 3. Those stages move lines in `src/App.tsx`, `src/ChatPane.tsx`, `src/AttentionMenu.tsx`, `src/TerminalPane.tsx` and `src/closing.ts`. Find every edit by the quoted code, not the number. Where an earlier stage changed the quoted code, the task says how to merge.
- Pure modules load under `node --experimental-strip-types`: type-only imports may omit the extension (`import type { Pane } from "./types";`), value imports between pure modules use `.ts` (as `src/composerMenu.ts:2` does), no enums, no parameter properties, no React.
- React components have no test harness. Logic goes in pure functions with tests; UI tasks end with a browser-preview check (`npm run dev`, stand-in backend, http://localhost:1420).

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/terminalRun.ts` | Create (Task 1) | Run states, PTY ids, transitions, status for close and quit, exit bar, Stopped notice and scrollback copy, tool lookup |
| `tests/terminal-run.test.mjs` | Create (Task 1) | Tests for the above |
| `src/TerminalPane.tsx` | Rewrite (Task 2), modify (Tasks 3, 6) | xterm, one PTY per start, exit bar, Stopped notice, program title |
| `src/App.tsx` | Modify (Tasks 2–7) | Run state per terminal, saving and restoring, numbering, program titles, ⋯ menus |
| `src/backend.ts` | Modify (Tasks 2, 6) | Preview terminals can exit (`exit`, `fail`) and set titles (`title`) |
| `src/styles.css` | Append (Tasks 2, 3, 6) | Exit bar, Stopped notice, program title |
| `src/closing.ts` | Modify (Tasks 3, 4) | `savedPanes`, `loadedPanes`, `savedLayouts`, `restoredLayouts` |
| `tests/closing.test.mjs` | Modify (Tasks 3, 4) | Tests for the above |
| `src/types.ts` | Modify (Tasks 3, 4) | Comments on `AppSession.panes` and `AppSession.layouts` |
| `src/terminalTitle.ts` | Create (Task 5), extend (Task 6) | `nextTitle`, `cleanTitle`, `programTitle`, `TitleThrottle` |
| `tests/terminal-title.test.mjs` | Create (Task 5), extend (Task 6) | Tests for the above |
| `src/ThreadName.tsx` | Modify (Task 5) | `label` prop for the text field's accessible name |
| `src/AttentionMenu.tsx` | Modify (Task 6) | Program title after the name in a row |
| `src/paneMenu.ts` | Create (Task 7) | ⋯ menu items for terminals and threads |
| `tests/pane-menu.test.mjs` | Create (Task 7) | Tests for the above |
| `src/ChatPane.tsx` | Modify (Task 7) | Fork and Export from the pane's ⋯ menu |
| `README.md`, `SPEC.md` | Modify (Task 8) | Describe the new behaviour |

---

### Task 0: Preflight

**Files:** none changed.

**Interfaces:**
- Consumes: stage 1 merged to `main`, or its branch (or a later stage branch built on it).
- Produces: branch `feat/now-4-terminals`, and the baseline test count `B` used in later expected outputs.

- [ ] **Step 1: Check the working tree**

Run: `git status`
Expected on 2026-10-04: `modified: src/ChatPane.tsx` and `modified: src/styles.css` (Tyler's composer auto-grow change), plus untracked `docs/superpowers/`. If those two files (or anything else under `src/`) still show as modified: **stop and ask Tyler whether to commit them first.** Never stash, reset, checkout or discard them. They are not part of this plan. If Tyler wants them left uncommitted, stop again and ask how to proceed: Tasks 2, 3, 6 and 7 commit `src/styles.css` and `src/ChatPane.tsx`, and those commits would carry his edits with them.

- [ ] **Step 2: Find the base for the stage branch**

Run: `git fetch origin && git branch -a --list '*now-*' && git log --oneline -5 main origin/main`
Run: `git grep -n "quitQuestion" main -- src/closing.ts; git grep -n "quitQuestion" origin/main -- src/closing.ts`
Expected: a match on `main` means stage 1 is merged; base the branch on `main`. If only `origin/main` matches, local `main` is behind GitHub: run `git switch main && git merge --ff-only origin/main` (this only catches local `main` up; it merges none of this stage's work), then base on `main`. If there is no match, stage 1 is not merged: base the branch on the newest unmerged stage branch that contains it (stage 3's if it exists and is unmerged, else stage 2's, else stage 1's), check it with `git grep -n "quitQuestion" <that-branch> -- src/closing.ts`, and say in your report which branch you used and why. If no branch has stage 1, stop and tell Tyler: the spec says stage 4 must follow stage 1.

- [ ] **Step 3: Create the stage branch**

Run: `git switch -c feat/now-4-terminals <base>` (with `<base>` from Step 2, e.g. `main`)
Expected: `Switched to a new branch 'feat/now-4-terminals'`

- [ ] **Step 4: See what earlier stages changed in the files this plan touches**

Run: `git diff --stat 95d753d -- src/App.tsx src/TerminalPane.tsx src/closing.ts tests/closing.test.mjs src/AttentionMenu.tsx src/ChatPane.tsx src/backend.ts src/types.ts src/ThreadName.tsx src/styles.css`
Run: `grep -n "exited\|onExit\|quitQuestion" src/App.tsx`
Expected: a list of changed files; and the lines that read the `exited` set (`src/App.tsx:154`, `:230-232`, `:236` on main) plus stage 1's quit check. Note the quit-check line numbers: Task 2 Step 5 changes them.

- [ ] **Step 5: Record baselines**

Run: `npm test 2>&1 | tail -9`
Expected: `ℹ fail 0`. Write down `ℹ tests <B>` (113 on `main@95d753d`; more once stages 1–3 are in).
Run: `npm run build 2>&1 | tail -4`
Expected: `✓ built in …` (the existing "Some chunks are larger than 500 kB" warning is normal).
This plan changes no Rust, so no `cargo test` baseline is needed.

- [ ] **Step 6: Commit**

Nothing to commit. Run `git status --short` and confirm it prints nothing.

---

### Task 1: The run model and its words (`src/terminalRun.ts`)

**Files:**
- Create: `src/terminalRun.ts`
- Test: `tests/terminal-run.test.mjs`

**Interfaces:**
- Consumes: `closeNeedsConfirm(kind, status)` from `src/closing.ts:18` (test only); types `Attention` (`src/attention.ts:11`), `AgentInfo`, `PaneStatus` (`src/types.ts:174`, `:206`).
- Produces (used by Tasks 2, 3, 7):
  - `type RunState = "stopped" | "running" | "exited"`
  - `interface TerminalRun { state: RunState; generation: number; code: number | null; at: number }`
  - `const STOPPED: TerminalRun`
  - `ptyIdFor(paneId: string, generation: number): string`
  - `isRunning(run: TerminalRun | undefined): boolean`
  - `canStart(run: TerminalRun): boolean`
  - `started(run: TerminalRun, at: number): TerminalRun`
  - `exited(run: TerminalRun, generation: number, code: number | null, at: number): TerminalRun`
  - `terminalStatus(run: TerminalRun | undefined, flag: Attention | null, working: boolean): PaneStatus`
  - `stateWord(run: TerminalRun | undefined, working: boolean): string`
  - `clock(at: number): string`
  - `exitBar(run: TerminalRun, name: string): { text: string; start: string }`
  - `exitLine(code: number | null, at: number): string`
  - `startedAgainLine(at: number): string`
  - `exitSignal(code: number | null): { kind: "failed"; note: string } | null`
  - `stoppedNotice(name: string, tool: string, installed: boolean): { text: string; start: string }`
  - `toolInstalled(agent: string | undefined, agents: AgentInfo[]): boolean`
  - `toolName(agent: string | undefined, agents: AgentInfo[]): string`

- [ ] **Step 1: Write the failing test**

Create `tests/terminal-run.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/terminal-run.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` ("Cannot find module '…/src/terminalRun.ts'").

- [ ] **Step 3: Write the implementation**

Create `src/terminalRun.ts`:

```ts
// The program in a terminal pane, over the life of the pane.
//
// A pane outlives its program. When the program ends, the pane stays with
// its scrollback and offers to start it again; a pane restored from the
// last session comes back stopped and waits for you to start it. Each start
// gets its own PTY id, so a late event from an earlier start can never reach
// a later one. These rules and their words are plain functions so they can
// be tested on their own.

import type { Attention } from "./attention";
import type { AgentInfo, PaneStatus } from "./types";

/** Never started since the app opened, running, or ended. */
export type RunState = "stopped" | "running" | "exited";

export interface TerminalRun {
  state: RunState;
  /** How many times the program has been started since the app opened; 0 if never. */
  generation: number;
  /** The exit code once it has exited, when the system reported one. */
  code: number | null;
  /** When it last started or exited, in milliseconds since the epoch; 0 if never. */
  at: number;
}

/** A terminal restored from the last session, before you start it. */
export const STOPPED: TerminalRun = { state: "stopped", generation: 0, code: null, at: 0 };

/** The PTY id of one start of a pane: "<pane id>:<generation>". Never reused. */
export function ptyIdFor(paneId: string, generation: number): string {
  return `${paneId}:${generation}`;
}

export function isRunning(run: TerminalRun | undefined): boolean {
  return run?.state === "running";
}

/** Start and Start again are offered whenever the program isn't running. */
export function canStart(run: TerminalRun): boolean {
  return run.state !== "running";
}

/** The program was started, or started again, at `at`. */
export function started(run: TerminalRun, at: number): TerminalRun {
  return { state: "running", generation: run.generation + 1, code: null, at };
}

/**
 * The program of start number `generation` exited. An exit from an earlier
 * start, or one that arrives twice, changes nothing.
 */
export function exited(run: TerminalRun, generation: number, code: number | null, at: number): TerminalRun {
  if (run.state !== "running" || run.generation !== generation) return run;
  return { state: "exited", generation, code, at };
}

/**
 * What a terminal's dot, the close question and the quit question see. A
 * program that is stopped or has exited reads "exited", so closing the pane
 * never asks and quitting never counts it as running.
 */
export function terminalStatus(run: TerminalRun | undefined, flag: Attention | null, working: boolean): PaneStatus {
  if (flag) return flag;
  if (run && run.state !== "running") return "exited";
  return working ? "working" : "idle";
}

/** The word in a terminal's pane head when no flag shows. */
export function stateWord(run: TerminalRun | undefined, working: boolean): string {
  if (run?.state === "stopped") return "Stopped";
  if (run?.state === "exited") return "Exited";
  return working ? "Working" : "Idle";
}

/** "14:02", in local time. */
export function clock(at: number): string {
  const time = new Date(at);
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

/** The bar at the foot of a terminal whose program ended. `name` is the pane's name. */
export function exitBar(run: TerminalRun, name: string): { text: string; start: string } {
  const how = run.code === null ? "Exited" : `Exited with code ${run.code}`;
  return { text: `${how} · ${clock(run.at)}`, start: `Start ${name} again` };
}

/** The dim line left in the scrollback where the program ended. */
export function exitLine(code: number | null, at: number): string {
  const how = code === null ? "exited" : `exited with code ${code}`;
  return `\r\n\x1b[2m— ${how} · ${clock(at)} —\x1b[0m\r\n`;
}

/** The dim line written before the program's output when it is started again. */
export function startedAgainLine(at: number): string {
  return `\r\n\x1b[2m— started again ${clock(at)} —\x1b[0m\r\n`;
}

/** A program that ended with an error flags the pane as Failed; a clean exit raises no flag. */
export function exitSignal(code: number | null): { kind: "failed"; note: string } | null {
  return code !== null && code !== 0 ? { kind: "failed", note: `Failed · exited with code ${code}` } : null;
}

/**
 * What a terminal restored from the last session says until you start it.
 * `name` is the pane's name and `tool` the tool's, such as "Codex".
 */
export function stoppedNotice(name: string, tool: string, installed: boolean): { text: string; start: string } {
  return {
    text: installed ? `${name} stopped when Apex Deck quit. Earlier output isn't kept.` : `${tool} isn't installed.`,
    start: `Start ${name}`,
  };
}

/**
 * Whether a pane's tool can be started. A plain shell always can. When the
 * list of tools could not be read at all, starting is allowed and the shell
 * reports a missing program itself.
 */
export function toolInstalled(agent: string | undefined, agents: AgentInfo[]): boolean {
  return !agent || agents.length === 0 || agents.some((a) => a.key === agent && a.found);
}

/** The tool's own name, such as "Codex"; "Terminal" for a plain shell. */
export function toolName(agent: string | undefined, agents: AgentInfo[]): string {
  if (!agent) return "Terminal";
  return agents.find((a) => a.key === agent)?.label ?? agent;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/terminal-run.test.mjs`
Expected: PASS, `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0`.
Run: `npm test 2>&1 | tail -9 && npx tsc --noEmit`
Expected: `ℹ tests <B+14>`, `ℹ fail 0`; tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/terminalRun.ts tests/terminal-run.test.mjs
git commit -m "feat: model a terminal's program as stopped, running or exited, one PTY id per start"
```

---

### Task 2: Start again after the program ends

**Files:**
- Rewrite: `src/TerminalPane.tsx:1-141`
- Modify: `src/App.tsx:15` (import), `:154` (`exited` state), `:230-239` (`onExit`, `statusOf`), `:432-436` (`closePane` `end`), `:686` (head word), `:712` (`TerminalPane` props), and stage 1's quit check (found in Task 0 Step 4)
- Modify: `src/backend.ts:151` (listeners), `:343` (banner), `:345-356` (`ptyWrite`), `:358` (`ptyKill`), `:363` (`onPtyExit`)
- Modify: `src/styles.css` (append)

**Interfaces:**
- Consumes: from Task 1 `STOPPED`, `canStart`, `exitBar`, `exitLine`, `exitSignal`, `exited`, `ptyIdFor`, `started`, `startedAgainLine`, `stateWord`, `terminalStatus`, `isRunning`, `TerminalRun`.
- Produces (used by Tasks 3, 6, 7):
  - `TerminalPane` props: `startRequest?: number` (bump to start again), `onRun: (paneId: string, run: TerminalRun) => void`, `onClose: (paneId: string) => void`.
  - In `App`: `runs: Record<string, TerminalRun>` state and `onRun` callback; `statusOf` reads stopped and exited terminals as `"exited"`.
  - Preview backend: typing `exit` then Enter ends the pretend program with code 0 after 100 ms, `fail` ends it with code 1 after 2 s; `onPtyExit` delivers exits; writes to an ended PTY reject.

- [ ] **Step 1: Merge check for earlier stages**

Run: `git diff 95d753d -- src/TerminalPane.tsx`
If stages 2 or 3 changed this file (stage 2.5 has `TerminalPane` report when a run of work starts, for "Working 4m"), carry every line they added into the new file in Step 2: their props go in `Props` and in the destructuring, their calls stay in the same handlers (`onData`, `onExit`, `settle`, typing) and read callbacks through `latest.current` instead of `callbacks.current`. Keep their names exactly.

- [ ] **Step 2: Replace `src/TerminalPane.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { Burst, QUIET_MS, waitingFor, type Attention } from "./attention";
import type { Backend } from "./backend";
import { registerPty } from "./hub";
import { STOPPED, canStart, exitBar, exitLine, exitSignal, exited, ptyIdFor, started, startedAgainLine, type TerminalRun } from "./terminalRun";
import type { Pane } from "./types";

interface Props {
  pane: Pane;
  cwd: string;
  backend: Backend;
  focused: boolean;
  /** Bumped by the ⋯ menu's Start again. */
  startRequest?: number;
  onActivity: (paneId: string) => void;
  /** Told each time the program starts or ends. */
  onRun: (paneId: string, run: TerminalRun) => void;
  /** Raise or clear (with `null`) this pane's request for attention. */
  onSignal: (paneId: string, kind: Attention | null, note?: string) => void;
  /** Close the pane, from the bar shown once the program has ended. */
  onClose: (paneId: string) => void;
}

/** The text on the terminal's screen, for judging whether it is waiting. */
function screenText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < term.rows; row++) {
    lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

const THEME = {
  background: "#0b1016",
  foreground: "#d5dde6",
  cursor: "#2dd4bf",
  selectionBackground: "#1f3a44",
  black: "#0b1016",
  brightBlack: "#5b6875",
};

export function TerminalPane({ pane, cwd, backend, focused, startRequest, onActivity, onRun, onSignal, onClose }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  /** Where the program is, for the bar at the foot of the pane. */
  const [run, setRun] = useState<TerminalRun>(STOPPED);
  // Keep the latest callbacks and folder without restarting the terminal when they change.
  const latest = useRef({ onActivity, onRun, onSignal, cwd });
  latest.current = { onActivity, onRun, onSignal, cwd };
  /** Starts the program, or starts it again once it has ended. Set up with the terminal below. */
  const start = useRef<() => void>(() => {});

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;

    const hasSize = () => element.clientWidth > 0 && element.clientHeight > 0;
    if (hasSize()) fit.fit();

    // Once the terminal has been silent for a moment, look at what is on
    // its screen and how the output arrived, and say whether it is waiting
    // for the person or has finished a piece of work. See attention.ts.
    const burst = new Burst();
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let waiting = false;
    const settle = () => {
      const reason = waitingFor(screenText(term));
      if (reason) {
        waiting = true;
        latest.current.onSignal(pane.id, "needs_input", reason);
      } else {
        // Whatever it was waiting for has been answered.
        if (waiting) latest.current.onSignal(pane.id, null);
        waiting = false;
        if (burst.finishedWork()) latest.current.onSignal(pane.id, "done", "Finished working");
      }
    };

    // Each start runs under its own PTY id, "<pane id>:<generation>". The
    // desktop side forgets a PTY by id when its program exits
    // (src-tauri/src/pty.rs), so reusing an id would let the old program's
    // exit end the new one. See terminalRun.ts.
    let current: TerminalRun = STOPPED;
    let unregister = () => {};
    const report = (next: TerminalRun) => {
      current = next;
      setRun(next);
      latest.current.onRun(pane.id, next);
    };
    const ptyId = () => ptyIdFor(pane.id, current.generation);

    start.current = () => {
      if (!canStart(current)) return;
      const again = current.generation > 0;
      const next = started(current, Date.now());
      const id = ptyIdFor(pane.id, next.generation);
      unregister();
      unregister = registerPty(id, {
        onData: (data) => {
          term.write(data);
          latest.current.onActivity(pane.id);
          burst.output(Date.now(), data.length);
          clearTimeout(quiet);
          quiet = setTimeout(settle, QUIET_MS);
        },
        onExit: (code) => {
          const ended = exited(current, next.generation, code, Date.now());
          if (ended === current) return;
          clearTimeout(quiet);
          term.write(exitLine(code, ended.at));
          report(ended);
          const failed = exitSignal(code);
          if (failed) latest.current.onSignal(pane.id, failed.kind, failed.note);
          else if (waiting) latest.current.onSignal(pane.id, null);
          waiting = false;
        },
      });
      // Starting again deals with whatever the last run was flagged for.
      latest.current.onSignal(pane.id, null);
      waiting = false;
      if (again) term.write(startedAgainLine(next.at));
      report(next);
      if (hasSize()) fit.fit();
      backend
        .ptySpawn({ id, agent: pane.agent, cwd: latest.current.cwd || undefined, cols: term.cols, rows: term.rows })
        .catch((error) => {
          term.write(`\x1b[31mCould not start: ${String(error)}\x1b[0m\r\n`);
          report(exited(current, next.generation, null, Date.now()));
        });
    };

    const typed = term.onData((data) => {
      if (current.state !== "running") return;
      backend.ptyWrite(ptyId(), data).catch(() => {});
      // Typing here means the person is dealing with it.
      burst.typed(Date.now());
      waiting = false;
      latest.current.onSignal(pane.id, null);
    });

    // A pane that is hidden has no size; skip fitting until it is shown.
    const observer = new ResizeObserver(() => {
      if (!hasSize()) return;
      fit.fit();
      if (current.state === "running") backend.ptyResize(ptyId(), term.cols, term.rows).catch(() => {});
    });
    observer.observe(element);

    start.current();

    return () => {
      observer.disconnect();
      clearTimeout(quiet);
      typed.dispose();
      unregister();
      if (current.state === "running") backend.ptyKill(ptyId()).catch(() => {});
      start.current = () => {};
      term.dispose();
      terminal.current = null;
    };
    // The terminal lives as long as the pane; its inputs do not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  // The ⋯ menu's Start again. Ignored while the program runs.
  useEffect(() => {
    if (startRequest) start.current();
  }, [startRequest]);

  useEffect(() => {
    if (focused) terminal.current?.focus();
  }, [focused]);

  const bar = run.state === "exited" ? exitBar(run, pane.title) : null;
  return (
    <div className="terminal">
      <div className="terminal-host" ref={host} />
      {bar && (
        <div className="terminal-bar" role="status">
          <span className="terminal-bar-text">{bar.text}</span>
          <button className="primary" onClick={() => start.current()}>{bar.start}</button>
          <button onClick={() => onClose(pane.id)}>Close</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Keep run state in `App` instead of the `exited` set**

In `src/App.tsx`, after the `TerminalPane` import (line 15 on main), add:

```tsx
import { stateWord, terminalStatus, type TerminalRun } from "./terminalRun";
```

Replace line 154:

```tsx
  const [exited, setExited] = useState<Set<string>>(new Set());
```

with:

```tsx
  /** Where each terminal's program is: stopped, running or exited. TerminalPane reports it. */
  const [runs, setRuns] = useState<Record<string, TerminalRun>>({});
```

Replace lines 230–239:

```tsx
  const onExit = useCallback((paneId: string) => {
    setExited((set) => new Set(set).add(paneId));
  }, []);

  const statusOf = (pane: Pane): PaneStatus => {
    if (attention[pane.id]) return attention[pane.id].kind;
    if (exited.has(pane.id)) return "exited";
    const last = lastOutput.current.get(pane.id) ?? 0;
    return Date.now() - last < WORKING_WINDOW_MS ? "working" : "idle";
  };
```

with:

```tsx
  const onRun = useCallback((paneId: string, run: TerminalRun) => {
    setRuns((all) => (all[paneId] === run ? all : { ...all, [paneId]: run }));
  }, []);

  const statusOf = (pane: Pane): PaneStatus => {
    const working = Date.now() - (lastOutput.current.get(pane.id) ?? 0) < WORKING_WINDOW_MS;
    // A stopped or exited terminal reads "exited": it never asks before closing.
    if (pane.kind === "terminal") return terminalStatus(runs[pane.id], attention[pane.id]?.kind ?? null, working);
    if (attention[pane.id]) return attention[pane.id].kind;
    return working ? "working" : "idle";
  };
```

In `closePane` (lines 432–436), replace:

```tsx
    const end = () => {
      setPanes((list) => list.filter((p) => p.id !== id));
      lastOutput.current.delete(id);
      takeOff(id);
    };
```

with:

```tsx
    const end = () => {
      setPanes((list) => list.filter((p) => p.id !== id));
      lastOutput.current.delete(id);
      setRuns(({ [id]: _ended, ...rest }) => rest);
      takeOff(id);
    };
```

- [ ] **Step 4: Show Stopped and Exited in the head, and wire the new props**

In the pane head (line 686 on main), the terminal branch of the state word is:

```tsx
status === "working" ? "Working" : status === "exited" ? "Exited" : "Idle"
```

Replace just that expression with:

```tsx
stateWord(runs[pane.id], status === "working")
```

Leave the thread branch (`threadStatus[pane.id] …`, which stage 1 made `threadStatus[pane.id]?.text`) as it is. If stage 2 already replaced the terminal branch with a timed working text (e.g. "Working 4m"), keep that text for the working case and use `stateWord` for the rest: `status === "working" ? <stage 2's working text> : stateWord(runs[pane.id], false)`. A stopped or exited terminal never has `status === "working"`, because `statusOf` reads it as `"exited"`.

In the `TerminalPane` element (line 712 on main), replace:

```tsx
onActivity={onActivity} onExit={onExit} onSignal={onSignal} />
```

with:

```tsx
onActivity={onActivity} onRun={onRun} onSignal={onSignal} onClose={closePane} />
```

- [ ] **Step 5: Route stage 1's quit check through `isRunning`**

Run: `grep -n "exited\|onExit" src/App.tsx`
Expected: on main only the two comments this task added (the `runs` doc comment and "A stopped or exited terminal reads…" in `statusOf`); with stage 1 in, also its quit check, if it read the removed `exited` set to decide whether an agent terminal has exited (tsc reports it as `Cannot find name 'exited'`). Wherever stage 1 decides whether a terminal's program is still running (whether it used `exited.has(p.id)` or `statusOf(p) !== "exited"`), make it `isRunning(runs[p.id])` (and `!isRunning(runs[p.id])` for "has exited"), and add `isRunning` to the `./terminalRun` import from Step 3. A Stopped or exited terminal must never be counted. Its "plain shell is working or waiting" test keeps using `statusOf`, which already reads stopped and exited shells as `"exited"`.

Run: `npx tsc --noEmit`
Expected: prints nothing.

- [ ] **Step 6: Let preview terminals end, so the bar can be seen**

In `src/backend.ts`, after line 151:

```ts
  const dataListeners = new Set<(id: string, data: string) => void>();
```

add:

```ts
  const exitListeners = new Set<(id: string, code: number | null) => void>();
  /** Preview terminals whose pretend program has ended or been killed. */
  const endedPtys = new Set<string>();
  const emitExit = (id: string, code: number | null) => {
    endedPtys.add(id);
    exitListeners.forEach((cb) => cb(id, code));
  };
```

Replace the banner at line 343:

```ts
      setTimeout(() => emitData(id, `\x1b[2m${what}: keys are echoed, nothing runs.\x1b[0m\r\n$ `), 30);
```

with:

```ts
      setTimeout(() => emitData(id, `\x1b[2m${what}: keys are echoed, nothing runs. Try ask, work, exit or fail.\x1b[0m\r\n$ `), 30);
```

At the top of `ptyWrite` (line 345), replace:

```ts
    ptyWrite: async (id, data) => {
      emitData(id,
```

with:

```ts
    ptyWrite: async (id, data) => {
      if (endedPtys.has(id)) throw new Error(`no terminal with id ${id}`);
      emitData(id,
```

At the end of `ptyWrite`, after the `work` block (line 355 on main), replace:

```ts
        setTimeout(() => emitData(id, "\r\nFinished.\r\n$ "), 6200);
      }
```

with:

```ts
        setTimeout(() => emitData(id, "\r\nFinished.\r\n$ "), 6200);
      }
      // "exit" ends the pretend program cleanly. "fail" ends it with code 1
      // two seconds later, so you can look away and see the Failed flag.
      if (line.endsWith("exit\r")) setTimeout(() => emitExit(id, 0), 100);
      if (line.endsWith("fail\r")) setTimeout(() => emitExit(id, 1), 2000);
```

Replace lines 358–363:

```ts
    ptyKill: async () => {},
    onPtyData: async (cb) => {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onPtyExit: async () => () => {},
```

with:

```ts
    ptyKill: async (id) => {
      endedPtys.add(id);
    },
    onPtyData: async (cb) => {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onPtyExit: async (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
```

- [ ] **Step 7: Style the bar**

Append to `src/styles.css`:

```css

/* Now tier, stage 4: terminals. A terminal pane is its screen plus, once
   its program has ended, a bar at the foot. Neutral panel, hairline border. */
.terminal { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; }
.terminal > .terminal-host { min-height: 0; }
.terminal-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 8px 12px; border-top: 1px solid var(--line); background: var(--panel-2); font-size: 12px; }
/* In a narrow pane the buttons drop below the words rather than squeezing them. */
.terminal-bar-text { flex: 1 1 26ch; min-width: 0; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.terminal-bar button { padding: 4px 10px; font-size: 12px; white-space: nowrap; }
```

- [ ] **Step 8: Run the checks**

Run: `npm test 2>&1 | tail -9 && npm run build 2>&1 | tail -4`
Expected: `ℹ tests <B+14>`, `ℹ fail 0`; `✓ built in …`.

- [ ] **Step 9: Check it in the browser preview**

Run: `npm run dev` and open http://localhost:1420 at about 1440×900. If the preview has no workspace, choose **Add a workspace** (it adds `workspace-1`). Go to **Code** and open **Codex**.
- The terminal shows "codex (browser demo): keys are echoed, nothing runs. Try ask, work, exit or fail." The head reads "Codex · Working", then "Idle".
- Click in the terminal, type `exit`, press Enter. Within a moment: the scrollback ends with a dim "— exited with code 0 · HH:MM —" line (current time), the head reads "Exited", there is no flag, and a bar at the foot reads "Exited with code 0 · HH:MM" with **Start Codex again** (mint, primary) and **Close**.
- Choose **Start Codex again**. The old output stays, a dim "— started again HH:MM —" line follows, then the banner again; the bar disappears; the head goes back to Working/Idle. Typing echoes again.
- Type `fail`, press Enter, then within two seconds click **Threads**. The Code tab gets a red count and the title-bar attention button reads "1 failed"; opening it shows "Codex — Failed · exited with code 1". Go back to Code: the bar reads "Exited with code 1 · HH:MM". Choose **Start Codex again**: the Failed flag clears.
- Type `exit`, Enter, then choose **Close** in the bar: the pane closes at once, with no question.
- Open a Codex terminal, type `work`, Enter, and press × while it prints: it still asks "Codex is still working." (unchanged).
- Drag a terminal by an empty part of its head onto another pane: it moves and keeps its scrollback (not restarted).

- [ ] **Step 10: Commit**

```bash
git add src/TerminalPane.tsx src/App.tsx src/backend.ts src/styles.css
git commit -m "feat: a terminal keeps its output when its program ends and offers Start again"
```

---

### Task 3: Restore terminals Stopped after a restart

**Files:**
- Modify: `src/closing.ts:36-50` (replace `savedThreads` and `loadedThreads`)
- Modify: `tests/closing.test.mjs:3`, `:26-46`
- Modify: `src/types.ts:108-109`
- Modify: `src/App.tsx:15` (import), `:22` (import), `:158` (after `lastOutput`), `:171` (load), `:210` (save), `:712` (`TerminalPane` props)
- Modify: `src/TerminalPane.tsx` (props, start guard, mount, Stopped notice)
- Modify: `src/styles.css` (append)

**Interfaces:**
- Consumes: from Task 1 `STOPPED`, `stoppedNotice`, `toolInstalled`, `toolName`; from Task 2 `TerminalPane`'s `start` ref, `report`, `onClose`.
- Produces (used by Task 4 and the shared interface):
  - `savedPanes(panes: Pane[]): Pane[]` — every thread as is, every terminal as `{ id, workspaceId, kind: "terminal", title, agent? }`.
  - `loadedPanes(saved: unknown[], workspaceIds: string[]): Pane[]` — threads (with `closed` defaulting to `false`) and terminal descriptors, in saved order; malformed, repeated, or orphaned entries dropped.
  - `TerminalPane` props: `startOnMount: boolean`, `installed: boolean`, `toolLabel: string`.
  - In `App`: `restored` ref (`Set<string>` of terminal ids read from the session file).

- [ ] **Step 1: Write the failing tests**

In `tests/closing.test.mjs`, in the import on line 3, replace `loadedThreads` with `loadedPanes` and `savedThreads` with `savedPanes`, keeping every other name (including any stage 1 added, such as `quitQuestion`). On main the line becomes:

```js
import { closeNeedsConfirm, closeQuestion, loadedPanes, openPanes, savedPanes } from "../src/closing.ts";
```

Replace the four tests that used the old names (lines 26–46 on main: "a thread waiting out its undo time…", "a closed thread stays saved", "an older session file without the closed field…", "a thread saved as closed stays closed") with these, and add the three new tests after them. Leave every other test (including stage 1's) as it is.

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/closing.test.mjs`
Expected: FAIL with `SyntaxError: The requested module '../src/closing.ts' does not provide an export named 'loadedPanes'`.

- [ ] **Step 3: Generalise the saved session in `src/closing.ts`**

Replace lines 36–50 (the `savedThreads` and `loadedThreads` functions and their comments) with:

```ts
/**
 * What is written to the session file: every thread, and each terminal as a
 * descriptor (its id, workspace, name and tool; never its output or its
 * process). A thread waiting out its undo time is still written, so quitting
 * before the time is up keeps it: the delete only happens when the time runs out.
 */
export function savedPanes(panes: Pane[]): Pane[] {
  return panes.map((p) => {
    if (p.kind === "chat") return p;
    const terminal: Pane = { id: p.id, workspaceId: p.workspaceId, kind: "terminal", title: p.title };
    if (p.agent) terminal.agent = p.agent;
    return terminal;
  });
}

/**
 * Panes read back from a session file. Older files have no `closed` field,
 * and their threads open as before; they have no terminals either. A
 * terminal comes back as its descriptor only, and the deck shows it Stopped
 * until you start it. Anything malformed, repeated, or in a workspace that
 * is gone is left out.
 */
export function loadedPanes(saved: unknown[], workspaceIds: string[]): Pane[] {
  const seen = new Set<string>();
  return saved.flatMap((value): Pane[] => {
    if (!value || typeof value !== "object") return [];
    const p = value as Partial<Pane>;
    if (typeof p.id !== "string" || !p.id || seen.has(p.id)) return [];
    if (typeof p.workspaceId !== "string" || !workspaceIds.includes(p.workspaceId)) return [];
    if (p.kind === "chat") {
      seen.add(p.id);
      return [p.closed ? (p as Pane) : { ...(p as Pane), closed: false }];
    }
    if (p.kind !== "terminal" || typeof p.title !== "string" || !p.title.trim()) return [];
    if (p.agent != null && typeof p.agent !== "string") return [];
    seen.add(p.id);
    const terminal: Pane = { id: p.id, workspaceId: p.workspaceId, kind: "terminal", title: p.title };
    if (p.agent) terminal.agent = p.agent;
    return [terminal];
  });
}
```

If stage 1 changed `loadedThreads` (for example to treat hidden workspaces specially), keep that behaviour inside `loadedPanes` for threads.

In `src/types.ts`, replace lines 108–109:

```ts
  /** Saved chats only; processes are started explicitly in Code. */
  panes: Pane[];
```

with:

```ts
  /** Saved threads, and each terminal as a descriptor (id, workspace, name,
   *  tool). Terminals come back Stopped: nothing is started on launch. */
  panes: Pane[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/closing.test.mjs`
Expected: PASS, `ℹ fail 0` (the 10 tests on main's file, plus any stage 1 added).

- [ ] **Step 5: Save and load panes in `App`**

In `src/App.tsx`, change the closing import (line 22 on main) so it names `loadedPanes` and `savedPanes` instead of `loadedThreads` and `savedThreads`, keeping the other names:

```tsx
import { UNDO_MS, closeNeedsConfirm, closeQuestion, loadedPanes, openPanes, savedPanes } from "./closing";
```

Change the `./terminalRun` import added in Task 2 to also bring in `toolInstalled` and `toolName`:

```tsx
import { stateWord, terminalStatus, toolInstalled, toolName, type TerminalRun } from "./terminalRun";
```

(keep `isRunning` in it if Task 2 Step 5 added it).

After line 158:

```tsx
  const lastOutput = useRef(new Map<string, number>());
```

add:

```tsx
  /** Terminals read back from the session file. They wait, Stopped, until started. */
  const restored = useRef(new Set<string>());
```

Replace line 171:

```tsx
      setPanes(loadedThreads(saved?.panes ?? [], known.map((w) => w.id)));
```

with:

```tsx
      const loaded = loadedPanes(saved?.panes ?? [], known.map((w) => w.id));
      restored.current = new Set(loaded.filter((p) => p.kind === "terminal").map((p) => p.id));
      setPanes(loaded);
```

In the save effect (line 210), replace `panes: savedThreads(panes),` with `panes: savedPanes(panes),`.

In the `TerminalPane` element (line 712 on main), replace:

```tsx
<TerminalPane pane={pane} cwd={workspace?.path ?? ""} backend={backend}
```

with:

```tsx
<TerminalPane pane={pane} cwd={workspace?.path ?? ""} backend={backend} startOnMount={!restored.current.has(pane.id)} installed={toolInstalled(pane.agent, agents)} toolLabel={toolName(pane.agent, agents)}
```

- [ ] **Step 6: Show the Stopped notice in `TerminalPane`**

In `src/TerminalPane.tsx`, add `stoppedNotice` to the `./terminalRun` import:

```tsx
import { STOPPED, canStart, exitBar, exitLine, exitSignal, exited, ptyIdFor, started, startedAgainLine, stoppedNotice, type TerminalRun } from "./terminalRun";
```

In `Props`, after `focused: boolean;`, add:

```tsx
  /** False for a terminal restored from the last session: it waits, Stopped, for you to start it. */
  startOnMount: boolean;
  /** False when the pane's tool is no longer on this computer; Start is then turned off. */
  installed: boolean;
  /** The tool's own name, such as "Codex", for "Codex isn't installed." */
  toolLabel: string;
```

Add `startOnMount, installed, toolLabel` to the destructuring:

```tsx
export function TerminalPane({ pane, cwd, backend, focused, startOnMount, installed, toolLabel, startRequest, onActivity, onRun, onSignal, onClose }: Props) {
```

Replace:

```tsx
  const latest = useRef({ onActivity, onRun, onSignal, cwd });
  latest.current = { onActivity, onRun, onSignal, cwd };
```

with:

```tsx
  const latest = useRef({ onActivity, onRun, onSignal, cwd, installed });
  latest.current = { onActivity, onRun, onSignal, cwd, installed };
```

Replace the first line of `start.current`:

```tsx
      if (!canStart(current)) return;
```

with:

```tsx
      if (!canStart(current) || !latest.current.installed) return;
```

Replace the unconditional start near the end of the effect:

```tsx
    start.current();

    return () => {
```

with:

```tsx
    // A terminal restored from the last session never starts by itself.
    if (startOnMount) start.current();
    else report(STOPPED);

    return () => {
```

Replace the render (from `const bar = …` to the end of the `return`):

```tsx
  const bar = run.state === "exited" ? exitBar(run, pane.title) : null;
  const notice = run.state === "stopped" ? stoppedNotice(pane.title, toolLabel, installed) : null;
  return (
    <div className="terminal">
      <div className="terminal-host" ref={host} />
      {notice && (
        <div className="terminal-stopped" role="status">
          <p>{notice.text}</p>
          <div className="terminal-stopped-actions">
            <button className="primary" disabled={!installed} onClick={() => start.current()}>{notice.start}</button>
            <button onClick={() => onClose(pane.id)}>Close</button>
          </div>
        </div>
      )}
      {bar && (
        <div className="terminal-bar" role="status">
          <span className="terminal-bar-text">{bar.text}</span>
          <button className="primary" disabled={!installed} onClick={() => start.current()}>{bar.start}</button>
          <button onClick={() => onClose(pane.id)}>Close</button>
        </div>
      )}
    </div>
  );
```

Append to `src/styles.css`:

```css
/* A terminal restored from the last session, before it is started. */
.terminal-stopped { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; text-align: center; background: var(--panel); }
.terminal-stopped p { margin: 0; max-width: 42ch; color: var(--muted); font-size: 13px; line-height: 1.6; }
.terminal-stopped-actions { display: flex; gap: 8px; }
```

- [ ] **Step 7: Run the checks**

Run: `npm test 2>&1 | tail -9 && npm run build 2>&1 | tail -4`
Expected: `ℹ tests <B+17>`, `ℹ fail 0`; `✓ built in …`.

- [ ] **Step 8: Check it in the browser preview**

With `npm run dev` at about 1440×900, in **Code**:
- Open **Codex** and **Terminal** (the plain shell). Reload the page.
- Both come back with no output and no process: Codex's pane shows "Codex stopped when Apex Deck quit. Earlier output isn't kept." with **Start Codex** (primary) and **Close**; the shell's shows "Terminal stopped when Apex Deck quit. …" with **Start Terminal**. Heads read "Stopped"; rail dots are hollow; nothing is flagged.
- Choose **Start Codex**: the notice goes, the banner appears, the head reads Working then Idle. No "started again" line (it is the first start since launch).
- Choose **Close** on the Stopped shell: it closes at once, no question. Reload: it stays gone; Codex comes back Stopped again.
- In the browser devtools console, run:
  `const s = JSON.parse(localStorage.getItem("apex-deck.demo.session.v1")); s.panes.push({ id: "pane-gemini", workspaceId: s.workspaces[0].id, kind: "terminal", title: "Gemini CLI", agent: "gemini" }); localStorage.setItem("apex-deck.demo.session.v1", JSON.stringify(s));`
  then reload. A "Gemini CLI" pane shows "Gemini CLI isn't installed." and **Start Gemini CLI** is turned off; **Close** works.
- In devtools, `JSON.parse(localStorage.getItem("apex-deck.demo.session.v1")).panes` lists terminals as `{ id, workspaceId, kind: "terminal", title, agent }` only.

- [ ] **Step 9: Commit**

```bash
git add src/closing.ts tests/closing.test.mjs src/types.ts src/App.tsx src/TerminalPane.tsx src/styles.css
git commit -m "feat: save terminals with the session and bring them back Stopped, never started"
```

---

### Task 4: Save Code layouts, dropping panes that didn't load

**Files:**
- Modify: `src/closing.ts:8` (imports), after `loadedPanes` (new functions)
- Modify: `tests/closing.test.mjs` (import, helpers, four tests)
- Modify: `src/App.tsx:16` (layout import), `:22` (closing import), `:178-184` (load), `:208-210` (save)
- Modify: `src/types.ts:117-119`

**Interfaces:**
- Consumes: `leafIds`, `removeLeaf`, `validate`, `LayoutNode` from `src/layout.ts:42`, `:77`, `:315`, `:15`; `loadedPanes` from Task 3.
- Produces:
  - `savedLayouts(layouts: Record<string, LayoutNode>, workspaceIds: string[]): Record<string, LayoutNode>` — keeps `"<id>:threads"` and `"<id>:code"` for listed workspaces.
  - `restoredLayouts(saved: unknown, panes: Pane[]): Record<string, LayoutNode>` — validated layouts with leaves for panes that didn't load (or belong to the other section) removed; empty ones dropped.

- [ ] **Step 1: Write the failing tests**

In `tests/closing.test.mjs`, add `restoredLayouts` and `savedLayouts` to the import from `../src/closing.ts` (on main: `import { closeNeedsConfirm, closeQuestion, loadedPanes, openPanes, restoredLayouts, savedLayouts, savedPanes } from "../src/closing.ts";`). After the existing `term` helper, add:

```js
const leaf = (id) => ({ kind: "leaf", id });
const row = (children, sizes) => ({ kind: "split", dir: "row", children, sizes });
```

Append these tests:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/closing.test.mjs`
Expected: FAIL with `SyntaxError: The requested module '../src/closing.ts' does not provide an export named 'restoredLayouts'`.

- [ ] **Step 3: Write the layout functions**

In `src/closing.ts`, replace the import on line 8:

```ts
import type { Pane, PaneStatus } from "./types";
```

with:

```ts
import type { LayoutNode } from "./layout";
import { leafIds, removeLeaf, validate } from "./layout.ts";
import type { Pane, PaneStatus } from "./types";
```

(keep any import stage 1 added). After `loadedPanes`, add:

```ts
/** Layouts are kept by "<workspace id>:<section>". Threads and Code are both saved, for workspaces still listed. */
export function savedLayouts(layouts: Record<string, LayoutNode>, workspaceIds: string[]): Record<string, LayoutNode> {
  const keep = new Set(workspaceIds.flatMap((id) => [`${id}:threads`, `${id}:code`]));
  return Object.fromEntries(Object.entries(layouts).filter(([key]) => keep.has(key)));
}

/**
 * Layouts read back from a session file, for the panes that loaded. A layout
 * that can't be read is dropped; a pane that didn't load, or that belongs to
 * the other section, is taken out and its space goes to its neighbours; and
 * a layout with no panes left is dropped.
 */
export function restoredLayouts(saved: unknown, panes: Pane[]): Record<string, LayoutNode> {
  const out: Record<string, LayoutNode> = {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return out;
  for (const [key, value] of Object.entries(saved)) {
    const cut = key.lastIndexOf(":");
    const section = key.slice(cut + 1);
    if (cut < 1 || (section !== "threads" && section !== "code")) continue;
    const workspace = key.slice(0, cut);
    const kind = section === "code" ? "terminal" : "chat";
    const loaded = new Set(panes.filter((p) => p.workspaceId === workspace && p.kind === kind).map((p) => p.id));
    let tree = validate(value);
    for (const id of leafIds(tree)) if (!loaded.has(id)) tree = removeLeaf(tree, id);
    if (tree) out[key] = tree;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/closing.test.mjs`
Expected: PASS, `ℹ fail 0` (14 tests on main's file, plus any stage 1 added).

- [ ] **Step 5: Use them in `App`**

In `src/App.tsx`, add `restoredLayouts` and `savedLayouts` to the closing import:

```tsx
import { UNDO_MS, closeNeedsConfirm, closeQuestion, loadedPanes, openPanes, restoredLayouts, savedLayouts, savedPanes } from "./closing";
```

Remove `validate` from the layout import (line 16), which App no longer uses:

```tsx
import { grid, leafIds, mainAndStack, rects, sync, type LayoutNode, type Rect } from "./layout";
```

Replace lines 178–184:

```tsx
      // A layout that cannot be read is dropped and rebuilt from the panes.
      const arranged: Record<string, LayoutNode> = {};
      for (const [key, value] of Object.entries(saved?.layouts ?? {})) {
        const tree = validate(value);
        if (tree) arranged[key] = tree;
      }
      setLayouts(arranged);
```

with:

```tsx
      // A layout that cannot be read is dropped and rebuilt from the panes,
      // and panes that didn't load are taken out of the rest.
      setLayouts(restoredLayouts(saved?.layouts, loaded));
```

In the save effect, delete lines 208–209:

```tsx
    // Terminals are not restored, so only the arrangement of threads is kept.
    const kept = Object.fromEntries(Object.entries(layouts).filter(([key]) => key.endsWith(":threads") && workspaces.some((w) => key === layoutKey(w.id, "threads"))));
```

and in the `session` object on the next line replace `layouts: kept,` with `layouts: savedLayouts(layouts, workspaces.map((w) => w.id)),`. (`layoutKey` stays: line 253 still uses it.)

In `src/types.ts`, replace lines 117–119:

```ts
  /** How the threads of each workspace are arranged, by "workspace:section".
   *  Each value is a tree from layout.ts and is checked when it is read. */
  layouts?: Record<string, unknown>;
```

with:

```ts
  /** How the panes of each workspace are arranged in Threads and in Code, by
   *  "workspace:section". Each value is a tree from layout.ts and is checked
   *  when it is read; panes that didn't load are taken out. */
  layouts?: Record<string, unknown>;
```

- [ ] **Step 6: Run the checks**

Run: `npm test 2>&1 | tail -9 && npm run build 2>&1 | tail -4`
Expected: `ℹ tests <B+21>`, `ℹ fail 0`; `✓ built in …`.

- [ ] **Step 7: Check it in the browser preview**

With `npm run dev` at about 1440×900, in **Code** with two terminals open:
- Choose the "large pane on the left" layout button, then drag the divider to make the left pane about two-thirds wide. Reload: both terminals come back Stopped in the same arrangement and widths.
- In devtools, `JSON.parse(localStorage.getItem("apex-deck.demo.session.v1")).layouts` has a `"<workspace id>:code"` key beside `":threads"`.
- In devtools, add a leaf that doesn't exist to the saved Code layout:
  `const s = JSON.parse(localStorage.getItem("apex-deck.demo.session.v1")); const k = Object.keys(s.layouts).find((x) => x.endsWith(":code")); s.layouts[k] = { kind: "split", dir: "row", children: [s.layouts[k], { kind: "leaf", id: "pane-missing" }], sizes: [0.5, 0.5] }; localStorage.setItem("apex-deck.demo.session.v1", JSON.stringify(s));`
  Reload: the deck shows only the real terminals, filling the space, with no empty slot. Read the saved layout again in devtools: it no longer mentions `pane-missing` (the cleaned layout is saved as soon as the app loads).
- Threads layouts still come back as before.

- [ ] **Step 8: Commit**

```bash
git add src/closing.ts tests/closing.test.mjs src/App.tsx src/types.ts
git commit -m "feat: save Code layouts beside threads and drop panes that didn't load"
```

---

### Task 5: Name and number terminals, renamed in place

**Files:**
- Create: `src/terminalTitle.ts`
- Test: `tests/terminal-title.test.mjs`
- Modify: `src/ThreadName.tsx:2-4`, `:9`
- Modify: `src/App.tsx` (import), `:328-330` (`addPane`), `:640` (rail row), `:685` (pane head)

**Interfaces:**
- Consumes: `ThreadName` (`src/ThreadName.tsx:4`), `renameRequests` (`src/App.tsx:104`), `renamePane` (`src/App.tsx:326`).
- Produces:
  - `nextTitle(base: string, taken: string[]): string`
  - `ThreadName` prop `label?: string` (accessible name of the text field; default `"Thread name"`).

- [ ] **Step 1: Write the failing test**

Create `tests/terminal-title.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { nextTitle } from "../src/terminalTitle.ts";

test("the first terminal of a tool keeps its name and the next is numbered", () => {
  assert.equal(nextTitle("Codex", []), "Codex");
  assert.equal(nextTitle("Codex", ["Claude Code"]), "Codex");
  assert.equal(nextTitle("Codex", ["Codex"]), "Codex 2");
  assert.equal(nextTitle("Codex", ["Codex", "Codex 2"]), "Codex 3");
});

test("numbering reuses a free name and ignores case and spaces", () => {
  assert.equal(nextTitle("Codex", ["Codex 2"]), "Codex");
  assert.equal(nextTitle("Codex", ["Codex", "Codex 3"]), "Codex 2");
  assert.equal(nextTitle("Codex", [" codex ", "CODEX 2"]), "Codex 3");
  assert.equal(nextTitle("Terminal", ["Terminal"]), "Terminal 2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/terminal-title.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` ("Cannot find module '…/src/terminalTitle.ts'").

- [ ] **Step 3: Write the implementation**

Create `src/terminalTitle.ts`:

```ts
// What a terminal pane is called.
//
// A terminal has the name you give it, numbered when its workspace already
// has a terminal by that name ("Codex 2"). The program inside may also set a
// title for itself (the OSC 0 and OSC 2 escape codes), such as Claude Code's
// "✳ Writing tests"; that title is cleaned up here and shown muted after the
// name, as plain text.

/** A new terminal's name: `base`, or `base 2`, `base 3`… when that name is taken in the workspace. */
export function nextTitle(base: string, taken: string[]): string {
  const used = new Set(taken.map((title) => title.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/terminal-title.test.mjs`
Expected: PASS, `ℹ tests 2`, `ℹ pass 2`, `ℹ fail 0`.

- [ ] **Step 5: Give `ThreadName` a field label**

If stage 1 already gave `ThreadName` a prop that names its text field (for renaming workspaces), use that prop below instead of adding `label`. Otherwise, in `src/ThreadName.tsx`, replace lines 2–4:

```tsx
/** Inline naming works with the keyboard and saves through the existing session.
 *  `renameRequest` starts editing each time it changes, for a Rename menu item. */
export function ThreadName({title, onRename, className, renameRequest}: {title: string; onRename: (name: string) => void; className?: string; renameRequest?: number}) {
```

with:

```tsx
/** Inline naming works with the keyboard and saves through the existing session.
 *  `renameRequest` starts editing each time it changes, for a Rename menu item.
 *  `label` names the text field for screen readers: a thread's or a terminal's name. */
export function ThreadName({title, onRename, className, renameRequest, label = "Thread name"}: {title: string; onRename: (name: string) => void; className?: string; renameRequest?: number; label?: string}) {
```

and on line 9 replace `aria-label="Thread name"` with `aria-label={label}`.

- [ ] **Step 6: Number new terminals and rename them in place**

In `src/App.tsx`, after the `./terminalRun` import, add:

```tsx
import { nextTitle } from "./terminalTitle";
```

In `addPane` (lines 328–330), replace:

```tsx
  const addPane = (kind: Pane["kind"], title: string, agent?: string) => {
    if (!activeWorkspace) return;
    const pane: Pane = { id: newId("pane"), workspaceId: activeWorkspace, kind, title, agent };
```

with:

```tsx
  const addPane = (kind: Pane["kind"], title: string, agent?: string) => {
    if (!activeWorkspace) return;
    // A second terminal of the same name in a workspace is numbered: "Codex 2".
    const name = kind === "terminal" ? nextTitle(title, panes.filter((p) => p.workspaceId === activeWorkspace && p.kind === "terminal").map((p) => p.title)) : title;
    const pane: Pane = { id: newId("pane"), workspaceId: activeWorkspace, kind, title: name, agent };
```

In the pane head (line 685), replace:

```tsx
{pane.kind === "chat" ? <ThreadName className="pane-title" title={pane.title} onRename={title => renamePane(pane.id, title)} renameRequest={renameRequests[pane.id]} /> : <span className="pane-title">{pane.title}</span>}
```

with:

```tsx
<ThreadName className="pane-title" title={pane.title} onRename={title => renamePane(pane.id, title)} renameRequest={renameRequests[pane.id]} label={pane.kind === "chat" ? "Thread name" : "Terminal name"} />
```

In the rail row (line 640), replace:

```tsx
<ThreadName className="pane-row-title" title={pane.title} onRename={title => renamePane(pane.id, title)} />
```

with:

```tsx
<ThreadName className="pane-row-title" title={pane.title} onRename={title => renamePane(pane.id, title)} label={pane.kind === "chat" ? "Thread name" : "Terminal name"} />
```

- [ ] **Step 7: Run the checks**

Run: `npm test 2>&1 | tail -9 && npm run build 2>&1 | tail -4`
Expected: `ℹ tests <B+23>`, `ℹ fail 0`; `✓ built in …`.

- [ ] **Step 8: Check it in the browser preview**

With `npm run dev` at about 1440×900, in **Code**:
- Open Codex, then **+ New terminal** → Codex again: the panes are "Codex" and "Codex 2". A third is "Codex 3". Close "Codex 2" and open another Codex: it is "Codex 2" again. Two plain shells are "Terminal" and "Terminal 2".
- Double-click "Codex 2" in its pane head: a text field labelled "Terminal name" opens; type `Reviewer`, press Enter: the head and the rail row read "Reviewer". Focus the name with Tab and press F2: it opens again; Escape cancels.
- Reload: the renamed terminal comes back Stopped as "Reviewer" (the name is in its saved descriptor), and its notice reads "Reviewer stopped when Apex Deck quit. …" with **Start Reviewer**.
- Thread names still rename the same way.

- [ ] **Step 9: Commit**

```bash
git add src/terminalTitle.ts tests/terminal-title.test.mjs src/ThreadName.tsx src/App.tsx
git commit -m "feat: number a second terminal of the same tool and rename terminals in place"
```

---

### Task 6: Show the program's own title after the name

**Files:**
- Modify: `src/terminalTitle.ts` (append)
- Modify: `tests/terminal-title.test.mjs` (import, seven tests)
- Modify: `src/TerminalPane.tsx` (import, `onTitle` prop, title subscription, exit, cleanup)
- Modify: `src/App.tsx` (import, state near `:154`, callbacks near `:230`, `:407-410` attention items, `:432-436` `closePane`, `:640` rail row, `:685` head, `:712` `TerminalPane` props)
- Modify: `src/AttentionMenu.tsx:10-11`, `:76`
- Modify: `src/backend.ts:341-344` (`ptySpawn`), `ptyWrite` (the `exit` line added in Task 2)
- Modify: `src/styles.css` (append)

**Interfaces:**
- Consumes: `nextTitle` file from Task 5; `TerminalPane`'s `current` run and `latest` ref from Tasks 2–3.
- Produces:
  - `TITLE_MAX = 60`, `TITLE_INTERVAL_MS = 250`
  - `cleanTitle(raw: string): string`
  - `programTitle(title: string, names: string[]): string`
  - `class TitleThrottle { offer(title: string, now: number): string | null; wait(now: number): number; flush(now: number): string | null }`
  - `TerminalPane` prop `onTitle: (paneId: string, title: string) => void` (`""` when the program has none or has ended)
  - `AttentionItem.program?: string`
  - In `App`: `programTitles` state, `onTitle`, `programOf(pane: Pane): string`.

- [ ] **Step 1: Write the failing tests**

In `tests/terminal-title.test.mjs`, replace the import with:

```js
import { TITLE_INTERVAL_MS, TitleThrottle, cleanTitle, nextTitle, programTitle } from "../src/terminalTitle.ts";
```

Append:

```js
test("a program title keeps its words and loses the spinner in front", () => {
  assert.equal(cleanTitle("✳ Writing tests for auth"), "Writing tests for auth");
  assert.equal(cleanTitle("⠋ Writing tests for auth"), "Writing tests for auth");
  assert.equal(cleanTitle("Writing tests ⠙"), "Writing tests");
  assert.equal(cleanTitle("  · 3 · Reading src/App.tsx  "), "Reading src/App.tsx");
});

test("a program title is plain text on one line", () => {
  assert.equal(cleanTitle("Build\u0007ing\tnow\r\nplease"), "Build ing now please");
  assert.equal(cleanTitle("\u001b[31mRed\u001b[0m title"), "Red title");
  // Markup stays text (React never parses it); only the leading "<" goes, as a non-letter.
  assert.equal(cleanTitle("<b>bold</b> & co"), "b>bold</b> & co");
});

test("a title with nothing readable is empty", () => {
  assert.equal(cleanTitle(""), "");
  assert.equal(cleanTitle("⠋"), "");
  assert.equal(cleanTitle("✳ ✶ ✻"), "");
  assert.equal(cleanTitle("🚀🚀"), "");
  assert.equal(cleanTitle("12:04:55"), "");
});

test("a long title is cut to 60 characters with an ellipsis", () => {
  const long = `Refactoring ${"the session store ".repeat(30)}`;
  const shown = cleanTitle(long);
  assert.equal([...shown].length, 60);
  assert.ok(shown.endsWith("…"));
  assert.ok(shown.startsWith("Refactoring the session store"));
  const exactly60 = "a".repeat(60);
  assert.equal(cleanTitle(exactly60), exactly60);
  assert.equal([...cleanTitle(`${"é".repeat(70)}`)].length, 60);
});

test("a program title that only repeats the pane's or tool's name is not shown", () => {
  assert.equal(programTitle("Codex", ["Codex 2", "Codex", "codex"]), "");
  assert.equal(programTitle("claude code", ["Claude Code", "Claude Code", "claude"]), "");
  assert.equal(programTitle("Writing tests for auth", ["Codex", "Codex", "codex"]), "Writing tests for auth");
  assert.equal(programTitle("", ["Codex"]), "");
  assert.equal(programTitle("Reviewer", ["", "Terminal"]), "Reviewer");
});

/** Feeds titles in at the given times the way TerminalPane does: each new title
 *  cancels the pending timer, and a held title is shown when its timer fires. */
function play(arrivals) {
  const throttle = new TitleThrottle();
  const shown = [];
  let timer = null;
  const fireBefore = (limit) => {
    if (timer !== null && timer < limit) {
      const held = throttle.flush(timer);
      if (held !== null) shown.push([timer, held]);
      timer = null;
    }
  };
  for (const [at, title] of arrivals) {
    fireBefore(at);
    timer = null;
    const now = throttle.offer(title, at);
    if (now !== null) shown.push([at, now]);
    else timer = at + throttle.wait(at);
  }
  fireBefore(Infinity);
  return shown;
}

test("a spinner retitling every 30 ms shows at most four titles a second and ends on the last", () => {
  const arrivals = Array.from({ length: 34 }, (_, i) => [1000 + i * 30, `step ${i}`]);
  const shown = play(arrivals);
  assert.deepEqual(shown, [[1000, "step 0"], [1250, "step 8"], [1500, "step 16"], [1750, "step 25"], [2000, "step 33"]]);
  for (let i = 1; i < shown.length; i++) assert.ok(shown[i][0] - shown[i - 1][0] >= TITLE_INTERVAL_MS);
});

test("a held title waits for its turn and is shown only once", () => {
  const throttle = new TitleThrottle();
  assert.equal(throttle.offer("one", 0), "one");
  assert.equal(throttle.offer("two", 100), null);
  assert.equal(throttle.wait(100), 150);
  assert.equal(throttle.flush(200), null);
  assert.equal(throttle.flush(250), "two");
  assert.equal(throttle.flush(600), null);
  assert.equal(throttle.offer("three", 600), "three");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/terminal-title.test.mjs`
Expected: FAIL with `SyntaxError: The requested module '../src/terminalTitle.ts' does not provide an export named 'TITLE_INTERVAL_MS'`.

- [ ] **Step 3: Write the implementation**

Append to `src/terminalTitle.ts`:

```ts

/** The longest program title shown, in characters. */
export const TITLE_MAX = 60;
/** Program titles change at most four times a second. */
export const TITLE_INTERVAL_MS = 250;

// Escape sequences, then any other control character.
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/gu;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;
// Braille cells are what most spinners are drawn with (⠋ ⠙ ⠹ …).
const SPINNER_FRAMES = /[\u2800-\u28ff]/gu;
const LEADING_NON_LETTERS = /^[^\p{L}]+/u;

/**
 * A program's title as plain text: no escape codes, control characters or
 * spinner frames, nothing before its first letter, single spaces, and at
 * most `TITLE_MAX` characters. "" when nothing readable is left.
 */
export function cleanTitle(raw: string): string {
  const text = raw
    .replace(ESCAPES, "")
    .replace(CONTROLS, " ")
    .replace(SPINNER_FRAMES, "")
    .replace(LEADING_NON_LETTERS, "")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = [...text];
  return chars.length <= TITLE_MAX ? text : `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…`;
}

/** The program title shown after a pane's name, or "" when it would only repeat one of `names`. */
export function programTitle(title: string, names: string[]): string {
  const same = names.some((name) => name.trim() !== "" && name.trim().toLowerCase() === title.toLowerCase());
  return same ? "" : title;
}

/**
 * Lets a title through at most once every `TITLE_INTERVAL_MS`. A title that
 * arrives sooner is held, and only the latest held one is shown when its
 * time comes, so a spinner retitling many times a second shows at most four
 * titles a second and always ends on the last.
 */
export class TitleThrottle {
  private lastAt = Number.NEGATIVE_INFINITY;
  private held: string | null = null;

  /** A title arrived. Returns it if it may be shown now; otherwise holds it and returns null. */
  offer(title: string, now: number): string | null {
    if (now - this.lastAt >= TITLE_INTERVAL_MS) {
      this.lastAt = now;
      this.held = null;
      return title;
    }
    this.held = title;
    return null;
  }

  /** Milliseconds until a held title may be shown. */
  wait(now: number): number {
    return Math.max(0, this.lastAt + TITLE_INTERVAL_MS - now);
  }

  /** The held title, if there is one and its time has come. */
  flush(now: number): string | null {
    if (this.held === null || now - this.lastAt < TITLE_INTERVAL_MS) return null;
    const title = this.held;
    this.held = null;
    this.lastAt = now;
    return title;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/terminal-title.test.mjs`
Expected: PASS, `ℹ tests 9`, `ℹ pass 9`, `ℹ fail 0`.

- [ ] **Step 5: Report the title from `TerminalPane`**

In `src/TerminalPane.tsx`, after the `./terminalRun` import, add:

```tsx
import { TitleThrottle, cleanTitle } from "./terminalTitle";
```

In `Props`, after the `onRun` prop, add:

```tsx
  /** The title the program gives itself, cleaned; "" when it has none or has ended. */
  onTitle: (paneId: string, title: string) => void;
```

Add `onTitle` to the destructuring after `onRun`:

```tsx
export function TerminalPane({ pane, cwd, backend, focused, startOnMount, installed, toolLabel, startRequest, onActivity, onRun, onTitle, onSignal, onClose }: Props) {
```

Replace:

```tsx
  const latest = useRef({ onActivity, onRun, onSignal, cwd, installed });
  latest.current = { onActivity, onRun, onSignal, cwd, installed };
```

with:

```tsx
  const latest = useRef({ onActivity, onRun, onTitle, onSignal, cwd, installed });
  latest.current = { onActivity, onRun, onTitle, onSignal, cwd, installed };
```

Right after:

```tsx
    let current: TerminalRun = STOPPED;
    let unregister = () => {};
```

add:

```tsx

    // The title the program gives itself (OSC 0 or 2), cleaned, at most four
    // times a second, and only while it runs. See terminalTitle.ts.
    const throttle = new TitleThrottle();
    let titleTimer: ReturnType<typeof setTimeout> | undefined;
    const titled = term.onTitleChange((raw) => {
      if (current.state !== "running") return;
      clearTimeout(titleTimer);
      const now = Date.now();
      const shown = throttle.offer(cleanTitle(raw), now);
      if (shown !== null) latest.current.onTitle(pane.id, shown);
      else titleTimer = setTimeout(() => {
        const held = throttle.flush(Date.now());
        if (held !== null && current.state === "running") latest.current.onTitle(pane.id, held);
      }, throttle.wait(now));
    });
```

In the PTY's `onExit` handler, replace:

```tsx
          if (ended === current) return;
          clearTimeout(quiet);
```

with:

```tsx
          if (ended === current) return;
          clearTimeout(quiet);
          // The title belonged to the program that just ended.
          clearTimeout(titleTimer);
          latest.current.onTitle(pane.id, "");
```

In the effect's cleanup, replace:

```tsx
      observer.disconnect();
      clearTimeout(quiet);
      typed.dispose();
```

with:

```tsx
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(titleTimer);
      titled.dispose();
      typed.dispose();
```

- [ ] **Step 6: Show it in the head, the rail and the attention list**

In `src/App.tsx`, change the Task 5 import to:

```tsx
import { nextTitle, programTitle } from "./terminalTitle";
```

After the `runs` state (added in Task 2 where `exited` was, line 154 on main), add:

```tsx
  /** The title each terminal's program gives itself, cleaned. TerminalPane reports it. */
  const [programTitles, setProgramTitles] = useState<Record<string, string>>({});
```

After the `onRun` callback, add:

```tsx
  const onTitle = useCallback((paneId: string, title: string) => {
    setProgramTitles((all) => ((all[paneId] ?? "") === title ? all : { ...all, [paneId]: title }));
  }, []);
  /** What a terminal's program says it is doing, shown muted after its name; "" for threads and when it only repeats a name. */
  const programOf = (pane: Pane): string => {
    if (pane.kind !== "terminal") return "";
    const tool = agents.find((a) => a.key === pane.agent);
    return programTitle(programTitles[pane.id] ?? "", [pane.title, tool?.label ?? "", tool?.program ?? ""]);
  };
```

In `attentionItems` (lines 407–410), replace:

```tsx
      where: pane.kind === "chat" ? "Threads" : "Code",
      signal: attention[pane.id],
```

with:

```tsx
      where: pane.kind === "chat" ? "Threads" : "Code",
      program: programOf(pane),
      signal: attention[pane.id],
```

In `closePane`'s `end`, after the `setRuns(…)` line from Task 2, add:

```tsx
      setProgramTitles(({ [id]: _gone, ...rest }) => rest);
```

In the rail row, right after the `ThreadName` line edited in Task 5, add:

```tsx
                      {programOf(pane) && <span className="program-title">· {programOf(pane)}</span>}
```

In the pane head, right after the `ThreadName` element edited in Task 5, add:

```tsx
                    {programOf(pane) && <span className="program-title">· {programOf(pane)}</span>}
```

In the `TerminalPane` element, replace `onRun={onRun}` with `onRun={onRun} onTitle={onTitle}`.

In `src/AttentionMenu.tsx`, after lines 10–11:

```tsx
  /** "Code" or "Threads". */
  where: string;
```

add:

```tsx
  /** What a terminal's program says it is doing, shown muted after the name; "" when nothing. */
  program?: string;
```

and replace line 76:

```tsx
                <strong>{item.title}</strong>
```

with:

```tsx
                <strong>{item.title}{item.program && <span className="program-title"> · {item.program}</span>}</strong>
```

If stage 2 restructured the rows (2.2 adds an answer strip for thread rows), put the same `{item.program && …}` right after the title text in the row's title line; terminal rows otherwise behave as before.

- [ ] **Step 7: Let preview agents set titles**

In `src/backend.ts`, in `ptySpawn` (lines 341–344 on main), replace the banner line from Task 2:

```ts
      setTimeout(() => emitData(id, `\x1b[2m${what}: keys are echoed, nothing runs. Try ask, work, exit or fail.\x1b[0m\r\n$ `), 30);
```

with:

```ts
      // Agents name what they are doing in the terminal's title, as Claude Code does.
      const title = agent ? "\x1b]0;\u2733 Reading the project\x07" : "";
      setTimeout(() => emitData(id, `${title}\x1b[2m${what}: keys are echoed, nothing runs. Try ask, work, title, exit or fail.\x1b[0m\r\n$ `), 30);
```

In `ptyWrite`, insert the `title` command before the comment added in Task 2. Replace:

```ts
      // "exit" ends the pretend program cleanly. "fail" ends it with code 1
```

with:

```ts
      // "title" retitles the terminal 20 times a second, as a spinner does, so
      // the four-a-second limit can be seen; it settles on the last title.
      if (line.endsWith("title\r")) {
        const frames = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f";
        for (let i = 0; i < 20; i++) setTimeout(() => emitData(id, `\x1b]0;${frames[i % frames.length]} Writing tests for auth (${i + 1} of 20)\x07`), i * 50);
        setTimeout(() => emitData(id, "\x1b]0;\u2733 Writing tests for auth\x07"), 1100);
      }
      // "exit" ends the pretend program cleanly. "fail" ends it with code 1
```

- [ ] **Step 8: Style the program title**

Append to `src/styles.css`:

```css
/* What a terminal's program says it is doing, after its name. Muted, and the first thing to shrink. */
.program-title { min-width: 0; color: var(--muted); font-weight: 400; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pane-head .pane-title { flex: 0 1 auto; min-width: 4ch; }
.pane-head .program-title { flex: 0 100 auto; font-size: 12px; }
.pane-row-title:has(+ .program-title) { flex: 0 1 auto; }
.pane-row .program-title { flex: 1 1 0; font-size: 12px; }
```

- [ ] **Step 9: Run the checks**

Run: `npm test 2>&1 | tail -9 && npm run build 2>&1 | tail -4`
Expected: `ℹ tests <B+30>`, `ℹ fail 0`; `✓ built in …`.

- [ ] **Step 10: Check it in the browser preview**

With `npm run dev` at about 1440×900, in **Code**:
- Open Codex: the head reads "Codex · Reading the project" with the second part muted, and the rail row reads the same, truncated with an ellipsis if the rail is narrow. A plain Terminal shows no program title.
- In Codex type `title`, Enter: the muted part counts "Writing tests for auth (1 of 20)", "(5 of 20)", … changing about four times a second (not twenty), then settles on "Writing tests for auth". To measure it, run in devtools before typing: `window.__t = []; new MutationObserver(() => window.__t.push([Math.round(performance.now()), document.querySelector(".pane-head .program-title")?.textContent])).observe(document.querySelector(".pane-head"), { subtree: true, childList: true, characterData: true });` and afterwards `window.__t`: consecutive entries are at least 250 ms apart and the last is "· Writing tests for auth".
- Type `exit`, Enter: the program title disappears from the head and rail. **Start Codex again**: "· Reading the project" returns.
- Type `ask`, Enter, wait two seconds, then switch to **Threads** and open the attention list: the row reads "Codex · Reading the project" (title line, program muted) over "Waiting for a choice".
- Rename the pane to `Reading the project` (double-click the name): the program title is hidden, because it would only repeat the name.

- [ ] **Step 11: Commit**

```bash
git add src/terminalTitle.ts tests/terminal-title.test.mjs src/TerminalPane.tsx src/App.tsx src/AttentionMenu.tsx src/backend.ts src/styles.css
git commit -m "feat: show the title a terminal's program sets, muted after its name"
```

---

### Task 7: ⋯ menus on terminals and threads

**Files:**
- Create: `src/paneMenu.ts`
- Test: `tests/pane-menu.test.mjs`
- Modify: `src/App.tsx:1` (React import), imports, `:104` (request state), `:475-483` (menu close effect), before `:485` (`runPaneMenu`), `:692-705` (the ⋯ menu), `:712` and `:714` (pane props)
- Modify: `src/ChatPane.tsx:69` (prop), `:322` (destructuring), `:774-809` (`exportAs`, `export` case, menu effect)

**Interfaces:**
- Consumes: `isRunning`, `toolInstalled`, `toolName` (Task 1); `TerminalPane` `startRequest` (Task 2); `renameRequests`, `closePane`, `deleteThread` in `App`; `forkAt` and `notify` in `ChatPane` (`src/ChatPane.tsx:765`, `:470`).
- Produces:
  - `type PaneMenuAction = "rename" | "start" | "copy_path" | "close" | "fork" | "export" | "delete"`
  - `interface PaneMenuItem { action: PaneMenuAction; label: string; disabled: boolean; reason: string; danger: boolean; separated: boolean }`
  - `interface TerminalMenuState { running: boolean; installed: boolean; tool: string; folder: string }`
  - `paneMenuItems(kind: PaneKind, terminal: TerminalMenuState): PaneMenuItem[]`
  - `ChatPane` prop `menuRequest?: { action: "fork" | "export"; n: number }`
  - In `App`: `startRequests`, `threadRequests`, `runPaneMenu(pane: Pane, action: PaneMenuAction)`.

- [ ] **Step 1: Write the failing test**

Create `tests/pane-menu.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { paneMenuItems } from "../src/paneMenu.ts";

const idle = { running: false, installed: true, tool: "Codex", folder: "/Users/tyler/apex-deck" };
const summary = (items) => items.map((i) => `${i.separated ? "| " : ""}${i.label}${i.disabled ? " (off)" : ""}${i.danger ? " (danger)" : ""}`);

test("a thread's menu offers Rename, Fork, Export, then Delete thread… in danger text", () => {
  assert.deepEqual(summary(paneMenuItems("chat", idle)), ["Rename", "Fork", "Export", "| Delete thread… (danger)"]);
  assert.deepEqual(paneMenuItems("chat", idle).map((i) => i.action), ["rename", "fork", "export", "delete"]);
});

test("a terminal's menu offers Rename, Start again, Copy folder path, then Close", () => {
  assert.deepEqual(summary(paneMenuItems("terminal", idle)), ["Rename", "Start again", "Copy folder path", "| Close"]);
  assert.deepEqual(paneMenuItems("terminal", idle).map((i) => i.action), ["rename", "start", "copy_path", "close"]);
});

test("Start again is off while the program runs, and says why", () => {
  const start = paneMenuItems("terminal", { ...idle, running: true }).find((i) => i.action === "start");
  assert.equal(start.disabled, true);
  assert.equal(start.reason, "It's still running.");
});

test("Start again is off when the tool is no longer installed", () => {
  const start = paneMenuItems("terminal", { ...idle, installed: false }).find((i) => i.action === "start");
  assert.equal(start.disabled, true);
  assert.equal(start.reason, "Codex isn't installed.");
});

test("Copy folder path is off for a workspace with no folder", () => {
  const copy = paneMenuItems("terminal", { ...idle, folder: "" }).find((i) => i.action === "copy_path");
  assert.equal(copy.disabled, true);
  assert.equal(copy.reason, "This workspace has no folder.");
});

test("Close is never turned off, so a busy terminal can always be closed (it asks first)", () => {
  const close = paneMenuItems("terminal", { ...idle, running: true, installed: false, folder: "" }).find((i) => i.action === "close");
  assert.equal(close.disabled, false);
  assert.equal(close.danger, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/pane-menu.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` ("Cannot find module '…/src/paneMenu.ts'").

- [ ] **Step 3: Write the implementation**

Create `src/paneMenu.ts`:

```ts
// The ⋯ menu on a pane head: which items it has, in what order, and when
// each one is turned off. App draws it and runs the chosen action.

import type { PaneKind } from "./types";

export type PaneMenuAction = "rename" | "start" | "copy_path" | "close" | "fork" | "export" | "delete";

export interface PaneMenuItem {
  action: PaneMenuAction;
  label: string;
  disabled: boolean;
  /** Why it is turned off, for its tooltip. "" when it isn't. */
  reason: string;
  /** Drawn in danger text: it removes something. */
  danger: boolean;
  /** A separator line comes before it. */
  separated: boolean;
}

/** What the menu needs to know about a terminal. Threads need none of it. */
export interface TerminalMenuState {
  running: boolean;
  installed: boolean;
  /** The tool's name, such as "Codex", for "Codex isn't installed". */
  tool: string;
  /** The workspace folder; "" when it has none, as in the browser preview. */
  folder: string;
}

const item = (action: PaneMenuAction, label: string, extra: Partial<PaneMenuItem> = {}): PaneMenuItem => ({
  action, label, disabled: false, reason: "", danger: false, separated: false, ...extra,
});

export function paneMenuItems(kind: PaneKind, terminal: TerminalMenuState): PaneMenuItem[] {
  if (kind === "chat") {
    return [item("rename", "Rename"), item("fork", "Fork"), item("export", "Export"), item("delete", "Delete thread…", { danger: true, separated: true })];
  }
  const startReason = terminal.running ? "It's still running." : terminal.installed ? "" : `${terminal.tool} isn't installed.`;
  return [
    item("rename", "Rename"),
    item("start", "Start again", { disabled: startReason !== "", reason: startReason }),
    item("copy_path", "Copy folder path", { disabled: !terminal.folder, reason: terminal.folder ? "" : "This workspace has no folder." }),
    item("close", "Close", { separated: true }),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/pane-menu.test.mjs`
Expected: PASS, `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 5: Fork and Export from the menu in `ChatPane`**

In `src/ChatPane.tsx`, after line 69:

```tsx
  onFork?: (title: string, upto: number | null) => Promise<string>;
```

add:

```tsx
  /** Fork or Export chosen in the pane's ⋯ menu; `n` goes up on each choice. */
  menuRequest?: { action: "fork" | "export"; n: number };
```

In the destructuring on line 322, add `menuRequest` right after `onFork`:

```tsx
… onActivity, onSignal, onFork, menuRequest, profiles, onProfilesChange, disabledProviders, profileMode = false, details }: Props) {
```

(keep any props stages 2 and 3 added). Before `/** Commands run locally and never reach the models. */` (line 774), add:

```tsx
  /** Save the thread to Downloads as Markdown or JSON, then show the file. */
  const exportAs = (format: "markdown" | "json") => {
    const at = new Date();
    const thread: ThreadExport = { title: pane.title, participants, transcript: messagesOf(entries), pins, compaction: compactionOf(entries) };
    const contents = format === "json" ? exportJson(thread, at) : exportMarkdown(thread, at);
    backend.exportThread(exportFileName(pane.title, format, at), contents)
      .then((path) => { if (path) { notify(`Exported to ${path}`); openTarget(path, true); } })
      .catch((error) => notify(`Could not export: ${String(error)}`, "error"));
  };
```

Replace the `export` case (lines 793–801):

```tsx
      case "export": {
        setText("");
        const at = new Date();
        const thread: ThreadExport = { title: pane.title, participants, transcript: messagesOf(entries), pins, compaction: compactionOf(entries) };
        const contents = command.format === "json" ? exportJson(thread, at) : exportMarkdown(thread, at);
        return void backend.exportThread(exportFileName(pane.title, command.format, at), contents)
          .then((path) => { if (path) { notify(`Exported to ${path}`); openTarget(path, true); } })
          .catch((error) => notify(`Could not export: ${String(error)}`, "error"));
      }
```

with:

```tsx
      case "export":
        setText(""); return exportAs(command.format);
```

If stage 3 changed the export body, move its version into `exportAs` unchanged. Right after the end of `runCommand` (the `};` after `case "unknown":`, line 809 on main), add:

```tsx
  // Fork and Export from the pane's ⋯ menu leave what you are typing alone.
  const menuHandled = useRef(menuRequest?.n ?? 0);
  useEffect(() => {
    if (!menuRequest || menuRequest.n === menuHandled.current) return;
    menuHandled.current = menuRequest.n;
    if (menuRequest.action === "fork") void forkAt(`${pane.title} (fork)`, null);
    else exportAs("markdown");
  }, [menuRequest]);
```

- [ ] **Step 6: Draw the menu for every pane in `App`**

In `src/App.tsx`, change line 1:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
```

to:

```tsx
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
```

After the `./terminalTitle` import, add:

```tsx
import { paneMenuItems, type PaneMenuAction } from "./paneMenu";
```

and make sure the `./terminalRun` import includes `isRunning` (add it if Task 2 Step 5 did not):

```tsx
import { isRunning, stateWord, terminalStatus, toolInstalled, toolName, type TerminalRun } from "./terminalRun";
```

After line 104:

```tsx
  const [renameRequests, setRenameRequests] = useState<Record<string, number>>({});
```

add:

```tsx
  /** Bumped to start a terminal again from its ⋯ menu. */
  const [startRequests, setStartRequests] = useState<Record<string, number>>({});
  /** Fork or Export chosen in a thread's ⋯ menu; `n` goes up on each choice. */
  const [threadRequests, setThreadRequests] = useState<Record<string, { action: "fork" | "export"; n: number }>>({});
```

In the menu-closing effect (lines 475–483), replace:

```tsx
  // The ⋯ menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!paneMenu) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".pane-menu-wrap")) setPaneMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setPaneMenu(null); };
```

with:

```tsx
  // The ⋯ menu closes on a click elsewhere, or on Escape, which puts focus back on its button.
  useEffect(() => {
    if (!paneMenu) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".pane-menu-wrap")) setPaneMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPaneMenu(null);
      document.querySelector<HTMLElement>(`[data-pane-menu="${CSS.escape(paneMenu)}"]`)?.focus();
    };
```

(If stage 1 extended this effect for the workspace ⋯ menu, keep its additions.) Before `const focusPane = (pane: Pane) => {` (line 485), add:

```tsx
  /** Run what was chosen in a pane's ⋯ menu. */
  const runPaneMenu = (pane: Pane, action: PaneMenuAction) => {
    const bump = (all: Record<string, number>) => ({ ...all, [pane.id]: (all[pane.id] ?? 0) + 1 });
    if (action === "rename") setRenameRequests(bump);
    else if (action === "start") setStartRequests(bump);
    else if (action === "copy_path") {
      const path = workspaces.find((w) => w.id === pane.workspaceId)?.path;
      if (path) navigator.clipboard?.writeText(path).catch(() => {});
    } else if (action === "close") closePane(pane.id);
    else if (action === "fork" || action === "export") setThreadRequests((all) => ({ ...all, [pane.id]: { action, n: (all[pane.id]?.n ?? 0) + 1 } }));
    else if (action === "delete") deleteThread(pane);
  };
```

Replace the thread-only ⋯ menu in the pane head (lines 692–705):

```tsx
                    {pane.kind === "chat" && (
                      <span className="pane-menu-wrap" onPointerDown={(event) => event.stopPropagation()}>
                        <button className="icon small" onClick={() => setPaneMenu((open) => (open === pane.id ? null : pane.id))} aria-label={`More actions for ${pane.title}`} aria-haspopup="menu" aria-expanded={paneMenu === pane.id} title="More">
                          ⋯
                        </button>
                        {paneMenu === pane.id && (
                          <span className="pane-menu" role="menu">
                            <button role="menuitem" onClick={() => { setPaneMenu(null); setRenameRequests((all) => ({ ...all, [pane.id]: (all[pane.id] ?? 0) + 1 })); }}>Rename</button>
                            <span className="pane-menu-sep" role="separator" />
                            <button role="menuitem" className="danger-text" onClick={() => { setPaneMenu(null); deleteThread(pane); }}>Delete thread…</button>
                          </span>
                        )}
                      </span>
                    )}
```

with:

```tsx
                    <span className="pane-menu-wrap" onPointerDown={(event) => event.stopPropagation()}>
                      <button className="icon small" data-pane-menu={pane.id} onClick={() => setPaneMenu((open) => (open === pane.id ? null : pane.id))} aria-label={`More actions for ${pane.title}`} aria-haspopup="menu" aria-expanded={paneMenu === pane.id} title="More">
                        ⋯
                      </button>
                      {paneMenu === pane.id && (
                        <span className="pane-menu" role="menu">
                          {paneMenuItems(pane.kind, { running: isRunning(runs[pane.id]), installed: toolInstalled(pane.agent, agents), tool: toolName(pane.agent, agents), folder: workspace?.path ?? "" }).map((item) => (
                            <Fragment key={item.action}>
                              {item.separated && <span className="pane-menu-sep" role="separator" />}
                              <button role="menuitem" className={item.danger ? "danger-text" : undefined} disabled={item.disabled} title={item.reason || undefined} onClick={() => { setPaneMenu(null); runPaneMenu(pane, item.action); }}>{item.label}</button>
                            </Fragment>
                          ))}
                        </span>
                      )}
                    </span>
```

In the `TerminalPane` element, add `startRequest={startRequests[pane.id]}` after `backend={backend}`. In the `ChatPane` element (line 714), add `menuRequest={threadRequests[pane.id]}` after `onStatus={onThreadStatus}`.

- [ ] **Step 7: Run the checks**

Run: `npm test 2>&1 | tail -9 && npm run build 2>&1 | tail -4`
Expected: `ℹ tests <B+36>` (149 on `main@95d753d` plus stages 1–3's tests), `ℹ fail 0`; `✓ built in …`.

- [ ] **Step 8: Check it in the browser preview**

With `npm run dev` at about 1440×900:
- In **Code**, a running Codex pane's ⋯ (labelled "More actions for Codex") opens: **Rename**, **Start again** (turned off; tooltip "It's still running."), **Copy folder path** (turned off in the preview; tooltip "This workspace has no folder."), a separator line, **Close**.
- **Rename** opens the name field in the head. Escape closes the menu and puts focus back on ⋯ (check with Tab/Shift-Tab or `document.activeElement` in devtools).
- Type `exit`, Enter, then ⋯ → **Start again** (now on): it starts again with the "— started again HH:MM —" line.
- Type `work`, Enter, then ⋯ → **Close** while it prints: it asks "Codex is still working." first. Cancel keeps it.
- After a reload, a Stopped terminal's ⋯ → **Start again** starts it (the same as the notice's Start button).
- In **Threads**, a thread's ⋯ opens **Rename**, **Fork**, **Export**, a separator, **Delete thread…** in red text. Type `draft text` in the composer first, then choose **Fork**: a "<name> (fork)" thread opens and the original shows "Forked into “<name> (fork)”. …"; going back, `draft text` is still in the composer. **Export** downloads a Markdown file named after the thread and leaves the composer alone. **Delete thread…** asks as before and Undo still works.

- [ ] **Step 9: Commit**

```bash
git add src/paneMenu.ts tests/pane-menu.test.mjs src/App.tsx src/ChatPane.tsx
git commit -m "feat: ⋯ menus on terminals (Start again, Copy folder path) and threads (Fork, Export)"
```

---

### Task 8: Docs, checks and the walkthrough

**Files:**
- Modify: `README.md:16-18`, `:24-30`, `:201`
- Modify: `SPEC.md:19-20`, `:22`, `:24`

**Interfaces:**
- Consumes: everything above.
- Produces: README and SPEC that describe this stage.

- [ ] **Step 1: Update `README.md`**

Replace the "Terminal panes" bullet (lines 16–18):

```markdown
- **Terminal panes.** Real terminals in the workspace folder. Launch a plain
  shell, or any coding agent Apex Deck finds installed (the list is in
  `src-tauri/src/agents.rs`).
```

with:

```markdown
- **Terminal panes.** Real terminals in the workspace folder. Launch a plain
  shell, or any coding agent Apex Deck finds installed (the list is in
  `src-tauri/src/agents.rs`). A second terminal of the same tool in a
  workspace is numbered ("Codex 2"); double-click a name, or focus it and
  press F2, to rename it. When the program sets its own title, such as
  Claude Code's "Writing tests for auth", it shows muted after the name in
  the pane head, the rail and the attention list. When the program ends, the
  pane keeps its output and a bar at the foot says how and when it ended,
  with **Start Codex again** and **Close**; a program that ends with an
  error is flagged Failed. A terminal's ⋯ menu has **Rename**, **Start
  again**, **Copy folder path** and **Close**.
- **Terminals after a restart.** Terminals and their arrangement in Code are
  saved with your threads, as a name and a tool only. After a restart they
  come back **Stopped**, never started: choose **Start Codex** to run it
  again. Earlier output isn't kept, and a tool that is no longer installed
  can't be started.
```

In the "Layout" bullet (lines 24–30), replace `Working, Idle or Exited for a terminal` with `Working, Idle, Exited or Stopped for a terminal`, and replace:

```markdown
in the rail, and clicking it opens it again. To delete a thread, use
  **Delete thread…** in its ⋯ menu; it asks once, and **Undo** brings it back
  for 8 seconds.
```

with:

```markdown
in the rail, and clicking it opens it again. A thread's ⋯ menu has
  **Rename**, **Fork**, **Export** and **Delete thread…**; deleting asks
  once, and **Undo** brings it back for 8 seconds.
```

(If an earlier stage rewrapped these lines, make the same change to the same sentences.)

In "Saved data" (line 201), replace:

```markdown
Running model turns and terminal processes are not restarted automatically.
```

with:

```markdown
Running model turns and terminal processes are not restarted automatically:
terminals and their Code layout are saved as names and tools only, and come
back Stopped until you start them.
```

- [ ] **Step 2: Update `SPEC.md`**

Replace line 19:

```markdown
| Status dot per pane: working (recent output), idle, exited | done |
```

with:

```markdown
| Status dot per pane: working (recent output), idle, exited (or stopped, for a terminal restored after a restart) | done |
```

Replace line 20:

```markdown
| Drag the line between panes to resize; drag a pane by its title bar to move or swap it | done (thread layouts are saved; terminals are not restored, so neither is their layout) |
```

with:

```markdown
| Drag the line between panes to resize; drag a pane by its title bar to move or swap it | done (thread and terminal layouts are saved; panes that didn't load are dropped from them) |
```

After line 22 (`| Close a thread without deleting it; …`), add:

```markdown
| Terminal names: a second pane of a tool is numbered ("Codex 2"), renamed in place, with the program's own title muted after the name | done |
| A terminal whose program ended keeps its output and offers Start again; a non-zero exit is flagged Failed | done |
| ⋯ menus on every pane: terminals (Rename, Start again, Copy folder path, Close) and threads (Rename, Fork, Export, Delete thread…) | done |
```

Replace line 24:

```markdown
| Restore open panes after restart | later |
```

with:

```markdown
| Restore open panes after restart | done (terminals come back Stopped and are never started on launch; earlier output isn't kept. Start all and resume flags such as `--continue` are later) |
```

- [ ] **Step 3: Run all checks**

Run: `npm test 2>&1 | tail -9`
Expected: `ℹ tests <B+36>`, `ℹ fail 0`.
Run: `npm run build 2>&1 | tail -4`
Expected: `✓ built in …` (only the existing chunk-size warning).
Run: `git diff --check main...HEAD` (or against the base branch from Task 0)
Expected: prints nothing.
No Rust changed, so `cargo test` is not run; say so in the report.

- [ ] **Step 4: Walk through every change in the preview at 1440×900**

Run `npm run dev`, open http://localhost:1420 with the window at 1440×900, start from a clean preview (in devtools: `localStorage.clear()`, reload) and **Add a workspace**:
1. Code → open Codex twice and Terminal once: "Codex", "Codex 2", "Terminal". Codex panes read "Codex · Reading the project"; the rail matches.
2. Rename "Codex 2" to `Reviewer` by double-click, and back with F2.
3. In Codex, `title` → the muted title changes at most four times a second and ends on "Writing tests for auth".
4. In Codex, `exit` → exit bar "Exited with code 0 · HH:MM", **Start Codex again**, **Close**; head "Exited"; no flag. **Start Codex again** → "— started again HH:MM —".
5. In Codex, `fail` then switch to Threads within 2 s → "1 failed" with "Codex — Failed · exited with code 1"; **Start Codex again** clears it.
6. ⋯ on a running terminal: Start again off ("It's still running."), Copy folder path off ("This workspace has no folder."), separator, Close; Escape returns focus to ⋯. `work` + ⋯ → Close asks.
7. Arrange "large pane on the left", reload: all terminals Stopped with their notices, same arrangement; Start works; Close on a Stopped pane closes at once. Add the Gemini descriptor from Task 3 Step 8 and reload: "Gemini CLI isn't installed.", Start off.
8. Threads → new thread: ⋯ shows Rename, Fork, Export, separator, Delete thread…; Fork and Export leave a composer draft alone; Delete asks and Undo works.
9. Must keep working: ⌘J goes to a flagged pane; dragging a terminal by its head moves it without restarting; `/pin`, `/diff`, `/fork`, `/export` still work in a thread with a Scripted bot; the attention counts on the Code and Threads tabs match the list.

- [ ] **Step 5: Walk through again at about 820×1400**

Set the window (or devtools device toolbar) to about 820×1400 and repeat items 1, 4, 6, 7 and 8. Also check:
- In a narrow pane (three terminals side by side), the exit bar puts its buttons on a second line under "Exited with code … · HH:MM" instead of squeezing the words; the Stopped notice wraps and stays centred.
- The pane head truncates the program title first (ellipsis), then the name; the ⋯, maximise and × buttons stay visible.
- The rail rows truncate "· Reading the project" with an ellipsis and keep any flag at the right.

- [ ] **Step 6: Note what the preview can't show**

In the report, list as untested unless checked in `npm run tauri dev` with real tools: real program titles from Claude Code and Codex, a real non-zero exit code, Start again of a real agent under a new PTY id, Copy folder path in the native webview, restoring after quitting the native app, and stage 1's quit question with only Stopped terminals (it should quit without asking).

- [ ] **Step 7: Commit**

```bash
git add README.md SPEC.md
git commit -m "docs: terminal names, Start again and restoring terminals Stopped"
```
