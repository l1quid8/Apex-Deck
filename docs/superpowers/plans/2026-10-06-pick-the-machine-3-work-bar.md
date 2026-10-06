# Pick the Machine — Stage 3: Work Bar, Destinations and Cross-machine Forks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Jigga implements inline in this checkout (the human asked for all stages without stopping); Null reviews the plan and the finished stage. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex's Work bar above every thread's message box — the project, Files, Tools and where it runs — with a searchable project picker, a Work in menu that lists every machine and folder, a New thread / Fork prompt instead of ever moving a started thread, forks that carry their history to another machine, and pane headers that give up words in steps.

**Architecture:** Pure modules decide destinations (`destinations.ts`: who is started, which rows Work in shows, what the picker lists and finds, what a choice does) and recent files (`recentFiles.ts`). A new apex-host command, `room_import`, creates a room from a snapshot on any machine, so moving an unstarted thread and forking to another machine are the same operation: read the snapshot, import it where it should run, delete the old copy. ChatPane draws the Work bar (`WorkBar.tsx`) from a `work` prop App builds, and reloads its room when its machine or folder changes, so the typed message survives a destination change.

**Tech Stack:** React 19 / TypeScript, Electron 44, Node's test runner, Rust apex-core / apex-host. No new dependencies.

**Spec:** [v8 mockup](../../mockups/pick-the-machine-v8.html) captions 5–12 and 15–18 (Stage 3 rows of the acceptance matrix in [Stage 1's plan](2026-10-06-pick-the-machine-1-multi-host.md)); the human's decision that Work in lists every machine; Null's v8 notes (the current destination's ✓ stays visible when its server is offline; long server labels shorten with full-name tooltips).

## Global Constraints

- Work only in `~/Downloads/apex-deck`, on `feat/pick-the-machine-stage-1`. No new checkout or `apex-deck-*` folder.
- `TMPDIR=/tmp npm test`; stub the clipboard in every check.
- No push, merge or installer unless the human asks. Leave `mockups/ios/` → `ios/` and `docs/mockups/` out of commits.
- A started thread never changes machine or folder. Picking another project or machine for it asks: New thread or Fork. Claude keeps working where it is either way.
- A thread that hasn't started (no message since it was made or forked) goes wherever it is pointed; what was typed stays.
- Work in lists every machine (This Mac and every saved server), one row per folder; servers with no copy offer the folder picker; offline servers are disabled but the current destination keeps its ✓. Add server… sets one up there. Cloud is left out.
- A fork keeps the history and opens with a line saying where it came from; nothing runs until Send.
- Attachments in a fork's history stay on the machine they were sent to; the fork line says so when history crosses machines (no byte transfer of old attachments).
- Menus above the composer open above it.
- Keep Deck's look: `.pane-menu`/`.deck-menu`, `.confirm`, Deck tokens; port the mockup's `.tray`, `.proj-picker`, `.work-menu`, `.move-ask`, `.empty-ask` rules.

## Review Focus

1. **A destination change racing a send** — once Send is pressed the thread is started; a picker choice made in that window asks New thread / Fork instead of moving it.
2. **Moving an unstarted thread to an offline or unreachable machine** — refused with words before anything is deleted; the thread stays where it was with its text.
3. **Fork to another machine with attachments in history** — history text is copied, attachment files are not; the fork line says they stay on the source machine.
4. **Two copies of a project on one machine in Work in** — both rows listed with their paths; choosing one never picks the other.
5. **A Work in or picker choice for a project on the same machine** — a different folder on the same host still moves (unstarted) or asks (started); the room's folder changes with it.

Each line has a test in its owning task (Tasks 3, 3, 1/3, 2, 3) plus native checks in Task 5.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `crates/apex-host/src/{command.rs,host.rs,storage.rs}`, `crates/apex-host/tests/host.rs` | `room_import { id, snapshot, cwd }` |
| `src/commandBackend.ts`, `src/backend.ts`, `src/hostBackends.ts` | `Backend.roomImport`; guarded while offline |
| `src/destinations.ts` (new) | started, choice outcome, Work in rows, picker rows/search, short names |
| `src/recentFiles.ts` (new) | Files' recent list: remember, search, kind, storage |
| `src/WorkBar.tsx` (new) | Project chip, Files, Tools, Work in; their popovers; the New thread / Fork prompt |
| `src/ChatPane.tsx` | `work` prop; Work bar placement; room reload on machine/folder change; started/fork reporting; fork line; empty-ask heading; recent files on drop |
| `src/App.tsx` | `choose`, `moveDraft`, `forkTo`, `newThreadIn`; Project ›; ⌥⇧⌘O; header labels |
| `src/types.ts`, `src/shortcuts.ts`, `src/paneMenu.ts`, `src/NewMenu.tsx`, `src/styles.css` | `Pane.fork`, shortcut, submenu, New menu words, styles |
| `desktop/multi-host-smoke.mjs` | native checks |

## Shared interfaces

```ts
// types.ts
interface Pane { /* … */ fork?: { from: string; title: string; host: string; at: number; crossed?: true } }
interface ThreadStatus { /* … */ started?: boolean }

// backend.ts
roomImport(id: string, snapshot: RoomSnapshot, cwd: string): Promise<void>;

// destinations.ts
export function threadStarted(messages: number, forkAt: number, sending: boolean): boolean;
export type ChoiceOutcome = "same" | "move" | "ask";
export function chooseOutcome(current: string, target: string, started: boolean): ChoiceOutcome;
export interface WorkRow { hostId: string; workspaceId: string | null; path: string; first: boolean; offline: boolean; current: boolean }
export function workInRows(workspaces: Workspace[], hostIds: string[], current: Workspace, offline: (hostId: string) => boolean): WorkRow[];
export interface PickerRow { workspace: Workspace; hostId: string; current: boolean; offline: boolean }
export function pickerRows(workspaces: Workspace[], panes: Pane[], current: string, offline: (hostId: string) => boolean): PickerRow[];
export function pickerMatches(row: PickerRow, hostName: string, query: string): boolean;
export function shortName(name: string, room?: number): string;

// recentFiles.ts
export interface RecentFile { path: string; name: string; at: number }
export function rememberFile(list: RecentFile[], path: string, at: number): RecentFile[];
export function fileKind(name: string): "img" | "doc";
export function findFiles(list: RecentFile[], query: string): RecentFile[];
export function loadRecentFiles(): RecentFile[]; export function saveRecentFiles(list: RecentFile[]): void;

// ChatPane props
work?: WorkContext; // defined in WorkBar.tsx
```

---

### Task 1: `room_import` on every host

**Files:** `crates/apex-host/src/command.rs`, `crates/apex-host/src/host.rs`, `crates/apex-host/src/storage.rs`, `crates/apex-host/tests/host.rs`, `src/commandBackend.ts`, `src/backend.ts`, `src/hostBackends.ts`, `tests/command-backend.test.mjs`, the command-names test.

- [ ] **Step 1: failing Rust tests**

```rust
#[tokio::test]
async fn importing_a_snapshot_makes_a_fresh_room_without_usage_rules_or_changes() {
    let (host, _dir) = host();
    let mut snapshot: RoomSnapshot = /* two messages, one participant, a pin, usage, an allowed rule, a change */;
    host.call(json!({"cmd":"room_import","args":{"id":"f","snapshot":snapshot,"cwd":"/tmp/x"}})).await.unwrap();
    let opened = host.room_create("f".into(), vec![], RoomOptions::default(), None).unwrap();
    assert_eq!(opened.transcript, snapshot.transcript);
    assert_eq!(opened.pins, snapshot.pins);
    assert!(opened.usage.is_empty() && opened.allowed.is_empty() && opened.changes.is_empty() && opened.baseline.is_none());
    assert!(host.call(json!({"cmd":"room_import","args":{"id":"f","snapshot":snapshot,"cwd":null}})).await.is_err());
}
```

Also: importing over an open room's id fails; the command-names test counts 64.

- [ ] **Step 2: run** — `TMPDIR=/tmp cargo test -p apex-host import` → FAIL (unknown variant `room_import`).
- [ ] **Step 3: implement** — `RoomImport { id, snapshot: RoomSnapshot, cwd: Option<String> }`; `Host::room_import` refuses an open id, then `store.import_room(&id, &SavedRoom { cwd, snapshot: clean })` where `clean = snapshot.fork(len)` with `changes`/`baseline` cleared (another folder); `Storage::import_room` writes with `create_new` like `fork_room`. TS: `roomImport: (id, snapshot, cwd) => call("room_import", { id, snapshot, cwd: cwd || null })`; add `roomImport` to `hostBackends`' guarded writes.
- [ ] **Step 4: run** — Rust tests plus `tests/command-backend.test.mjs` (a `roomImport` call sends `room_import` with those args) → PASS.
- [ ] **Step 5: commit** — `feat: import a thread snapshot as a new room on any host`.

### Task 2: Destination and recent-file rules

**Files:** create `src/destinations.ts`, `src/recentFiles.ts`, `tests/destinations.test.mjs`, `tests/recent-files.test.mjs`.

- [ ] **Step 1: failing tests**

```js
import { threadStarted, chooseOutcome, workInRows, pickerRows, pickerMatches, shortName } from "../src/destinations.ts";
const ws = [
  { id: "deck", name: "apex-deck", path: "/Users/t/apex-deck", family: "apex-deck" },
  { id: "at1", name: "apex-deck", path: "/home/l/apex-deck", hostId: "at", family: "apex-deck" },
  { id: "at2", name: "apex-deck", path: "/home/l/code/apex-deck", hostId: "at", family: "apex-deck" },
  { id: "api", name: "staging-api", path: "/srv/api", hostId: "st", family: "staging-api" },
];
test("a thread starts with its first message after it was made or forked, or as Send is pressed", () => {
  assert.equal(threadStarted(0, 0, false), false);
  assert.equal(threadStarted(1, 0, false), true);
  assert.equal(threadStarted(4, 4, false), false);
  assert.equal(threadStarted(5, 4, false), true);
  assert.equal(threadStarted(0, 0, true), true);
});
test("a choice moves an unstarted thread and asks for a started one", () => {
  assert.equal(chooseOutcome("deck", "deck", true), "same");
  assert.equal(chooseOutcome("deck", "at1", false), "move");
  assert.equal(chooseOutcome("deck", "at1", true), "ask");
});
test("Work in lists every machine, one row per folder, and keeps the current ✓ when offline", () => {
  const rows = workInRows(ws, ["local", "at", "hz", "st"], ws[1], (h) => h === "at");
  assert.deepEqual(rows.map((r) => [r.hostId, r.workspaceId, r.first, r.offline, r.current]), [
    ["local", "deck", true, false, false],
    ["at", "at1", true, true, true], ["at", "at2", false, true, false],
    ["hz", null, true, false, false],
    ["st", null, true, false, false]]);
});
test("the picker lists recent projects first and finds by name, server or folder", () => {
  const panes = [{ id: "p", workspaceId: "api", kind: "chat", title: "t", activeAt: 9 }];
  const rows = pickerRows(ws, panes, "deck", () => false);
  assert.equal(rows[0].workspace.id, "api");
  assert.equal(rows.find((r) => r.workspace.id === "deck").current, true);
  assert.equal(pickerMatches(rows[0], "Staging", "stag"), true);
  assert.equal(pickerMatches(rows[0], "Staging", "/srv"), true);
  assert.equal(pickerMatches(rows[0], "Staging", "hetzner"), false);
});
test("long project names shorten in the middle", () => {
  assert.equal(shortName("apex-smoke-test"), "apex…test");
  assert.equal(shortName("apex-deck"), "apex-deck");
});
```

```js
import { rememberFile, fileKind, findFiles } from "../src/recentFiles.ts";
test("recent files keep the newest first, once each, and at most 30", () => {
  let list = [];
  for (let i = 0; i < 35; i++) list = rememberFile(list, `/f/${i}.txt`, i);
  list = rememberFile(list, "/f/34.txt", 99);
  assert.equal(list.length, 30);
  assert.equal(list[0].path, "/f/34.txt");
  assert.equal(list.filter((f) => f.path === "/f/34.txt").length, 1);
  assert.equal(fileKind("shot.PNG"), "img");
  assert.equal(fileKind("notes.md"), "doc");
  assert.deepEqual(findFiles(list, "33").map((f) => f.name), ["33.txt"]);
});
```

- [ ] **Step 2: run** → FAIL (modules missing). **Step 3: implement** the functions. **Step 4: run** → PASS. **Step 5: commit** — `feat: rules for destinations, Work in rows, the project picker and recent files`.

### Task 3: Moving unstarted threads, forking anywhere, and the prompt

**Files:** `src/types.ts`, `src/ChatPane.tsx`, `src/App.tsx`, `src/paneMenu.ts` (Project ›), `desktop/multi-host-smoke.mjs`.

- [ ] **Step 1: failing native checks** — a new Mac thread with `Bot` added and `@bot hello there` typed is pointed at the server project: its `[data-host-id]` becomes `at`, the textarea still reads `@bot hello there`, `Bot` is still in it, and Send posts on the server (`server-native-reply`). Pointing the started Mac thread at the server shows `.move-ask` with New thread / Fork this thread; Fork opens a new pane on the server whose transcript holds the Mac history, with `.fork-line` naming “Mac thread” and This Mac; the source thread stays on This Mac. An unstarted move to an offline server is refused with words and nothing moves.
- [ ] **Step 2: run** — `npm run desktop:smoke:multi-host` → FAIL.
- [ ] **Step 3: implement**
  - ChatPane's room effect depends on `[pane.id, profileMode, backend, cwd]`; when the machine or folder changed it reloads the room that App has already imported there, clears attachments with a notice (their files are on the old machine), and keeps text and quotes.
  - ChatPane reports `started` (`threadStarted(messages, pane.fork?.at ?? 0, sendingRef.current)`), sets `sendingRef` before the first post, and renders `.fork-line` after `pane.fork.at` messages: “Forked from “title” on host. The history is copied; nothing runs until you send.” (+ “Attachments in it stay on host.” when `crossed`).
  - App `choose(pane, workspaceId)`: `chooseOutcome` → `moveDraft` | `setAsk` | nothing. `moveDraft`: refuse when the target host isn't connected; read the snapshot (`roomState` → snapshot, else `roomCreate`); same host: `roomDelete` then `roomImport(id, snapshot, path)`; other host: `roomImport` then `roomDelete` (best effort); then set `workspaceId`. `forkTo(source, workspaceId)`: snapshot → new id → `roomImport` on the target → new pane with `fork`. The prompt (`.move-ask`, inside the source pane above the Work bar): New thread (empty draft there, focused) / Fork this thread / Cancel. Same-project Fork keeps `roomFork` and gains `fork`.
  - Thread menu: Project › lists `pickerRows` and calls `choose`; its note says the thread stays where it is.
- [ ] **Step 4: run** — unit suite, tsc, `npm run desktop:smoke:multi-host` → PASS.
- [ ] **Step 5: commit** — `feat: move unstarted threads, fork to any machine, and ask before relocating`.

### Task 4: The Work bar

**Files:** create `src/WorkBar.tsx`; modify `src/ChatPane.tsx`, `src/App.tsx`, `src/shortcuts.ts`, `tests/shortcuts.test.mjs`, `src/styles.css`, `desktop/multi-host-smoke.mjs`.

- [ ] **Step 1: failing tests** — `shortcutFor({code:"KeyO", metaKey, altKey, shiftKey}, true)` is `{ kind: "thread", action: "project" }`. Native: `.tray` shows the project chip (`.tray-chip.proj` with the project name), Files, Tools and `.tray-chip.work`; the project picker filters by typed text and marks the current row ✓; Work in lists `This Mac`, the server rows with paths, a disabled offline row whose ✓ stays when current, and Add server…; a Files row attaches its file (recent list seeded through a drop); Tools inserts `!token`; a started thread's work chip shows `.lock`.
- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3: implement** `WorkBar` from the mockup's `tray`, `picker`, `workMenu`, `filesPop`, `toolsPop`: popovers open above the bar, close on Escape/outside, search with arrow keys and Enter; ⌥⇧⌘O opens the picker on the focused thread. New project → Mac folder picker; New server project → choose a server, then its folder picker; Don't work in a project → a folderless This Mac project; a Work in row with no copy → that machine's folder picker (with the separate-copy note), then a new project in the same family; Add server… → ConnectionDialog in add mode. Files: recent files (dropped or browsed on this Mac), search, Browse all (the Mac's file picker), Copy a folder in… (This Mac only), and the “copied to <server> with your message” note. Tools: the bots' servers, apps and plugins from `listToolServers`, `!token` inserted at the end of the text.
- [ ] **Step 4: run** → PASS. **Step 5: commit** — `feat: Codex Work bar with project picker, Work in, Files and Tools`.

### Task 5: Headers, New menu words, verification

**Files:** `src/App.tsx`, `src/styles.css`, `src/NewMenu.tsx`, `desktop/multi-host-smoke.mjs`, `README.md`, this plan.

- [ ] **Step 1: failing native checks** — with three panes and the server named `Production-Frankfurt-Primary-01`: every head keeps `.pane-ws` (project) and `.pane-host .hn` (server, `title` = full name) visible inside the head; maximize, ⋯ and × stay inside the pane; at `data-fit="min"` the project shows its short name. The empty thread asks “What should we work on in <project>?”; + New's Group chat line names the project and machine.
- [ ] **Step 2–4:** implement the head pill and host label with the existing fit steps (`full` → `compact` → `tight` → `min`), then run every gate:

```sh
TMPDIR=/tmp npm test
npm run build
TMPDIR=/tmp cargo test --workspace
TMPDIR=/tmp npm run test:e2e
npm run desktop:smoke
npm run desktop:smoke:multi-host
APEX_DECK_SMOKE_OLD_HELPER=1 npm run desktop:smoke:multi-host
git diff --check
```

- [ ] **Step 5: commit** — `test: verify the Work bar, destinations and headers natively`; hand to Null.

## Stage 3 completion contract

- [ ] Captions 5–12 and 15–18 behave as in v8 (Cloud and Chat/Work deliberately absent).
- [ ] No started thread changes machine or folder; unstarted ones move with their text.
- [ ] Forks keep history anywhere; old attachments stay where they were and the fork says so.
- [ ] Unit, Rust, e2e, both native smokes, build and diff checks pass; Null has reviewed.

## Plan self-review

- Spec coverage: 5 → Tasks 4/5 (+ New words, Work bar); 6 → Task 4; 7 → Tasks 2/4; 8 → Task 4; 9 → Task 3; 10 → Tasks 2/4; 11 → Task 4; 12 → Tasks 3/4 (lock); 15 → Task 3; 16 → Tasks 1/3; 17 → Stage 1 (kept, re-checked natively); 18 → Task 5.
- Placeholders: UI tasks are pinned by DOM contracts and native checks; pure rules and Rust carry full tests.
- Types: `RoomSnapshot`, `Pane.fork`, `ThreadStatus.started`, `WorkRow`, `PickerRow`, `RecentFile` are used with the same names throughout.

## Execution record (Jigga, October 6)

Built inline after Stage 2 (`112e364`), without the plan-review pause (the human asked for all stages without stopping); Null reviews the plan and both stages.

Rulings made while building:
- `room_import` gained `replace`, so a move to another folder on the same machine swaps the room in one host call.
- Older helpers without `room_import` still take a thread that hasn't started (a fresh room with the same bots and options); a fork's history needs a newer helper and says so. Apex-Terminal runs the older helper today.
- App subscribes to every saved server's connection and redraws when one connects or drops, so Work in, the picker and Project › never show a stale state.
- Work bar popovers render on the page (a portal) just above the bar; panes clip their children.
- An offline current destination's Work in row is disabled and keeps its ✓.
- ChatPane's turn queue reaches the backend through a ref: a thread moved before it started posts where it runs now.
- Pane heads: project pill and server label first, both shrinking with full-name tooltips; at the tightest step a long project name shortens in the middle and empty slots take no gap. With six panes on a 1400-pixel window the narrowest heads show only a few letters of each.
- The native fixture's projects live in small folders (`mac-copy/project`, `server-copy/project`, `work`): the old fixture folder held the daemons' own data, so threads there snapshotted an ever-growing tree.
- Order slip: the App/ChatPane wiring in Tasks 3–4 was written before its native checks; the checks then found and fixed a stale send backend, stale path/image callbacks and stale Work bar states.

Verification:
- `TMPDIR=/tmp npm test`: 580 passed. `npm run build`, `TMPDIR=/tmp cargo test --workspace` (410 passed), `TMPDIR=/tmp npm run test:e2e` (4 passed), `git diff --check`: exit 0.
- `npm run desktop:smoke`, `npm run desktop:smoke:multi-host` and `APEX_DECK_SMOKE_OLD_HELPER=1 npm run desktop:smoke:multi-host`: exit 0. New native checks: an unstarted thread moved from This Mac to the server keeps its text and bot, is gone from the Mac and answers on the server; a started thread asks New thread / Fork; a fork to the server carries history and its line; offline projects can't be picked; the Work bar's chips, lock, opening question, picker search and ✓, ⌥⇧⌘O, Work in rows (offline row disabled with its ✓), Files attaching a recent Mac file, Tools' empty state; + New naming project and machine; six narrow headers keeping project, server and buttons in view.
- Not natively exercised: Tools with a bot that has tool servers (the fixture's bots are shell commands; the insertion is unit-tested), Add server… from Work in, and the older-helper fallback for `room_import` (unit-tested in `placeThread`).

Review fixes (Null's whole-branch review and re-checks, October 6):
- `58a148c`: `room_import` with `replace` writes the new room over the saved one under the old room's checkpoint lock, then closes it, so a failed write leaves the thread whole and open. A same-machine move keeps its artifacts.
- `be97e43`: an older helper can't change a room's folder without deleting it (its `room_create` keeps the saved folder), so a same-machine move there is refused before anything changes, and the thread's prompt offers New thread only. A move to another machine saves the artifacts there before the old copy goes, and undoes the new copy if that fails. The older-helper fallback refuses pins as well as history.
- Leftover ids: a machine that still keeps a thread under the moving thread's id, from an earlier move whose delete never arrived, keeps it. The current helper's `room_import` already refuses; the older-helper fallback now looks for `rooms/<hex id>.json` and its artifacts in the daemon's data folder (`data_folder`, `paths_exist`, both on every apex-daemon since the wire protocol) before `room_create`, which would otherwise open the leftover as it is. Both show the New thread prompt (`MoveRefused`).
- Pane heads: a flag ("New reply") is the last thing on the top line to give way, only when the buttons would otherwise leave it. The status dot keeps its colour and its tooltip names the flag. The multi-host smoke now makes that flag itself, because the hidden window's focus decides whether replies flag.
