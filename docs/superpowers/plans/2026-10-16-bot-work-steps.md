# Bot Work Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the person see everything a bot did in a turn: the full step list, each step's command and output, steps saved on the finished reply, clean labels, helpers in their own boxes (Codex helpers too), and Codex's to-do list.

**Architecture:** The adapters already receive full step data from Claude (stream-json `tool_use` / `tool_result` / `parent_tool_use_id`) and Codex (app-server `item/started` / `item/completed` / `turn/plan/updated` / helper threads) and throw most of it away. `EventReader` (`crates/apex-adapters/src/events.rs`) starts emitting a structured `WorkStep` (upserted by key: once when it starts, again when it ends) and a `Todo` list, next to the existing `Activity` line, which stays exactly as it is for older clients, the phone's working line and `snapshots.note_command`. The host buffers each bot's steps during a turn and, when that bot's reply lands, appends them to a per-thread sidecar file beside the room file, the way card settings (`answers`) are kept. The window renders live steps from the new events and loads a finished reply's steps on demand through a new read-only `room_steps` command.

**Tech Stack:** Rust (apex-core, apex-adapters, apex-host, apex-daemon), TypeScript/React (Electron window + Capacitor phone), `node --test` for TS, `cargo test` for Rust.

**Spec:** the Human's five asks, agreed in chat on 2026-10-16 (Jigga's second reply): (1) "N earlier steps" opens the whole list, click a step for its full command and what came back; (2) steps stay on the finished reply as a folded "83 steps" line, saved with the chat; (3) clearer labels: Codex-style "Read events.rs", and the `cd folder &&` part removed from Claude's; (4) each helper gets its own folded box under the step that started it, titled with its task, "Done" when it finishes, Codex helpers included; (5) Codex's to-do list shows in the bubble as it ticks off. Background facts: memory `bot-step-history`.

## Global Constraints

- Branch: `git switch -c feat/work-steps` from `main` in `~/Downloads/apex-deck` only, no worktree folders. Run `git status` first; the folder currently holds another bot's uncommitted work on `feat/local-qwen-project-tools` (several files this plan also touches: `apex-core/src/room.rs`, `apex-core/src/types.rs`, `apex-core/tests/wire_format.rs`, `apex-host/src/host.rs`, `src/types.ts`). Do not switch branches or start until that work is committed or the Human says how to proceed. Stage only your own hunks.
- How bots run does not change: no new CLI flags, Codex `thread/start` keeps `"ephemeral": true`.
- `RoomEvent::Activity { id, text }` keeps its exact text (`Running: <command>`, `Editing <path>`, …). Labels change only in the new `WorkStep`.
- Wire names (serde `snake_case`): events `work_step` and `todo`; command `room_steps`. TS types mirror them in `src/types.ts`.
- Size limits (constants in `crates/apex-core/src/work_steps.rs`): `STEP_DETAIL_MAX = 4_096` bytes; `STEP_OUTPUT_HEAD = 6_144` and `STEP_OUTPUT_TAIL = 6_144` bytes (middle replaced by `\n… <n> lines cut …\n`); `STEPS_PER_REPLY_MAX = 2_000` (later steps counted in `dropped`, not kept); `REPLY_STEPS_BYTES_MAX = 1_048_576` (over it, outputs are removed oldest-first and `output_cut = true` set on each). Cuts happen on UTF-8 char boundaries.
- Older daemons (Hetzner, a not-yet-updated Mac daemon) send no `work_step` events and reject `room_steps`. The window must fall back to today's `Activity` list and hide the "N steps" line, matching how `answerStore.ts:139` treats an unknown `answers_load`.
- Copy: "79 earlier steps" (button), "Show fewer", "83 steps" / "1 step" (folded line on a finished reply), helper box title = helper task, status words "Working" / "Done" / "Failed" / "Stopped". Folder note reads `in ios-sim-upgrade`. Never print a bot @handle in any of this text.
- Never touch the real clipboard in tests (no copy button in this plan).
- `npx tsc --noEmit`, `npm test`, and `cargo test -p apex-core -p apex-adapters -p apex-host -p apex-daemon` pass before review. Run Rust tests with `TMPDIR=/tmp` inside Deck panes.

## Review Focus

1. **Huge output** (a `cargo build` printing 40 MB, or `cat` of a big file): the bubble stays responsive, the saved record stays under 1 MB, and the step shows the head, a "lines cut" note and the tail. Test: `huge_output_is_cut_to_head_and_tail` (Task 2) and `reply_record_over_limit_drops_oldest_outputs` (Task 4).
2. **A turn that fails, passes, or is stopped** has no reply message, so its steps are not saved; the live list disappears as today. Known limit, called out for Null to accept or reject. Test pins it: `steps_without_a_reply_are_not_saved` (Task 4).
3. **Editing or deleting earlier messages** (transcript shrinks) and **fork**: saved steps for removed messages go away; a fork keeps steps only for the messages it keeps. Test: `truncate_and_fork_prune_steps` (Task 4).
4. **Two bots working at once** in one thread: steps never cross between bots and each reply gets only its own. Test: `two_bots_keep_separate_steps` (Task 4).
5. **Secrets in output** (a command printing an API key): output is now saved to disk in Deck's data folder. The sidecar is written with the same writer and permissions as the room file and is deleted with the thread. Test: `steps_file_removed_with_room` (Task 4). Moving a thread to another machine (`threadMove.ts`) and export do not carry steps: stated limit, not a bug.

---

## File Structure

- Create `crates/apex-core/src/work_steps.rs`: `WorkStep`, `StepKind`, `StepStatus`, `TodoItem`, `TodoStatus`, `ReplySteps`, the size constants, `cut_output()`, `cut_detail()`, `ReplySteps::fit()`. Pure data + limits.
- Modify `crates/apex-core/src/{lib.rs, participant.rs, room.rs}`: export the module, add `Progress::Work` / `Progress::Todo`, add `RoomEvent::WorkStep` / `RoomEvent::Todo` and map them in `progress_event`.
- Create `crates/apex-adapters/src/step_labels.rs`: `split_cd()`, `unwrap_shell()`, `codex_label()`, `claude_label()`. Pure label logic.
- Modify `crates/apex-adapters/src/events.rs`: `Step::Work`, `Step::Todo`; build steps from Claude and Codex events; stop dropping Codex helper-thread steps. `lib.rs` `report()` passes them on.
- Modify `crates/apex-host/src/storage.rs`: `<hex>.steps.jsonl` + `<hex>.steps.index.json`, save/load/prune/fork/delete/import guard.
- Modify `crates/apex-host/src/host.rs`, `command.rs`; `crates/apex-daemon/src/authority.rs`: per-turn buffer in `turn_sink`, `room_steps` command, read-only thread scope.
- Create `src/workSteps.ts`: pure TS model (apply events, build the helper tree, counts). Test `tests/work-steps.test.mjs`.
- Create `src/WorkSteps.tsx`: the step list, expander, step detail, helper boxes, to-do list. Test `tests/work-steps-component.test.mjs`.
- Modify `src/ChatPane.tsx`, `src/types.ts`, `src/backend.ts`, `src/commandBackend.ts`, `src/styles.css`, `src/glass-theme.css`; phone: `src/phoneWorking.ts`, `src/phone/PhoneApp.tsx`.

---

### Task 1: Probe the real feeds and save fixtures

Facts the later tasks rely on, taken from the installed Claude Code 2.1.302 and codex-cli 0.162.1, saved as test fixtures so no later test guesses a shape.

**Files:**
- Create: `crates/apex-adapters/tests/fixtures/work_steps/claude_turn.jsonl`, `codex_turn.jsonl`, `probe-notes.md`

- [ ] **Step 1: Record a Claude turn.** In a throwaway folder under `/tmp`, run `claude -p --output-format stream-json --verbose --include-partial-messages` with a prompt that: runs `cd <that folder> && ls`, reads a file, greps, writes a to-do list, and starts one helper agent (foreground) that reads a file. Save stdout. Then repeat with a background helper (`run_in_background`).
- [ ] **Step 2: Record a Codex turn** through `codex app-server` (same handshake as `codex_server.rs`, `"ephemeral": true`) with a prompt that reads two files, runs a search, lists a folder, runs `git status`, keeps a plan, and spawns one helper.
- [ ] **Step 3: Write `probe-notes.md`** answering, with the exact JSON paths: Claude `tool_result.content` shapes (string / array of `{type:"text"}`), whether `is_error` is set on a failed Bash, whether Claude 2.1.302 still uses `TodoWrite {todos:[{content,status,activeForm}]}` or another tool name; whether a background helper's `background_tasks_changed` task carries the starting `tool_use_id`; Codex `commandExecution.command` form (`/bin/zsh -lc '…'`?), `commandActions` variants and fields, `aggregatedOutput` / `exitCode` / `durationMs` on `item/completed`, `turn/plan/updated` params (`plan:[{step,status}]`), and which item (`collabAgentToolCall` with `prompt` / `receiverThreadIds`, or `subAgentActivity` with `agentPath`) names a helper's task. Replace `/Users/<name>/` with `/work/` in the fixtures.
- [ ] **Step 4: Commit** the fixtures and notes: `git commit -m "test: record Claude and Codex step feeds for work steps"`.

If a probe answer contradicts this plan (for example the to-do tool has another name), stop and post the difference to the reviewer before Task 3.

---

### Task 2: Step data types and limits (apex-core)

**Files:**
- Create: `crates/apex-core/src/work_steps.rs`
- Modify: `crates/apex-core/src/lib.rs`, `participant.rs:73-86`, `room.rs:60-160`
- Test: `crates/apex-core/tests/wire_format.rs`, unit tests in `work_steps.rs`

**Interfaces:**
- Produces:
  ```rust
  pub enum StepKind { Command, Read, Search, List, Edit, Web, Tool, Helper, Thinking, Other }
  pub enum StepStatus { Running, Done, Failed, Stopped }
  pub struct WorkStep {
      pub key: String,              // tool_use id / Codex item id; unique within a turn
      pub parent: Option<String>,   // key of the Helper step this step ran under
      pub kind: StepKind,
      pub label: String,            // short, ≤120 chars: "git status", "Read events.rs"
      pub folder: Option<String>,   // last path part when the command ran outside the room folder
      pub detail: String,           // full command / pattern / input JSON, cut to STEP_DETAIL_MAX
      pub output: Option<String>,   // what came back, cut by cut_output
      pub status: StepStatus,
      pub exit_code: Option<i32>,
      pub duration_ms: Option<u64>,
      #[serde(default, skip_serializing_if = "is_false")] pub output_cut: bool,
  }
  pub enum TodoStatus { Pending, InProgress, Completed }
  pub struct TodoItem { pub text: String, pub status: TodoStatus }
  pub struct ReplySteps { pub by: ParticipantId, pub seq: usize, pub steps: Vec<WorkStep>, pub todo: Vec<TodoItem>, pub dropped: usize }
  pub fn cut_output(text: &str) -> String;
  pub fn cut_detail(text: &str) -> String;
  impl ReplySteps { pub fn push(&mut self, step: WorkStep); pub fn fit(&mut self); }
  // Progress::Work(&'a WorkStep), Progress::Todo(&'a [TodoItem])
  // RoomEvent::WorkStep { id: ParticipantId, step: WorkStep }   -> {"type":"work_step",...}
  // RoomEvent::Todo { id: ParticipantId, items: Vec<TodoItem> } -> {"type":"todo",...}
  ```
  All serde `rename_all = "snake_case"`.

- [ ] **Step 1: Write failing tests** in `work_steps.rs`:
  - `huge_output_is_cut_to_head_and_tail`: 40 000 lines of `line N` → result ≤ `STEP_OUTPUT_HEAD + STEP_OUTPUT_TAIL + 64` bytes, starts with `line 0`, ends with `line 39999`, contains `lines cut`.
  - `cut_respects_utf8`: 20 000 × `"é"` cuts without panicking and is valid UTF-8.
  - `push_upserts_by_key`: push key `a` Running, then key `a` Done with output → one step, Done, output kept.
  - `push_past_limit_counts_dropped`: 2 001 distinct keys → `steps.len() == 2000`, `dropped == 1`.
  - `fit_drops_oldest_outputs_first`: 200 steps with 12 KB output each → after `fit()`, serialized size ≤ `REPLY_STEPS_BYTES_MAX`, the last step still has output, the first has `output == None` and `output_cut == true`.
  In `tests/wire_format.rs`: `work_step_and_todo_events_round_trip` asserting the JSON `type` is `"work_step"` / `"todo"` and status serializes as `"in_progress"`.
- [ ] **Step 2:** `TMPDIR=/tmp cargo test -p apex-core work_step` → FAIL (types missing).
- [ ] **Step 3: Implement** the module, the two `Progress` variants, the two `RoomEvent` variants and their `progress_event` arms. `ReplySteps::push` on an existing key replaces the step but keeps a non-empty `output` if the new one has none.
- [ ] **Step 4:** `TMPDIR=/tmp cargo test -p apex-core` → PASS; `cargo build --workspace` compiles (fix any exhaustive `match` on `Progress` / `RoomEvent`).
- [ ] **Step 5: Commit** `feat(core): structured work steps and to-do events`.

---

### Task 3: Labels without the folder, Codex-style

**Files:**
- Create: `crates/apex-adapters/src/step_labels.rs` (unit tests inline)

**Interfaces:**
- Consumes: `StepKind` (Task 2).
- Produces:
  ```rust
  /// "cd /x/y && git status" -> (Some("/x/y"), "git status"). Handles `cd "<p>" &&`, `cd '<p>' &&`, `cd <p>;`. Only a leading cd.
  pub(crate) fn split_cd(command: &str) -> (Option<&str>, &str);
  /// "/bin/zsh -lc 'git status'" -> "git status"; same for bash/sh, -c/-lc, single or double quotes. Anything else unchanged.
  pub(crate) fn unwrap_shell(command: &str) -> String;
  /// The folder note: None when `dir` is the room folder (or inside it is the same path); else its last path part.
  pub(crate) fn folder_note(dir: &str, cwd: Option<&str>) -> Option<String>;
  /// Codex: label and kind from `commandActions` (fields per probe-notes.md), falling back to the unwrapped command.
  pub(crate) fn codex_label(command: &str, actions: &serde_json::Value, short: &dyn Fn(&str) -> String) -> (StepKind, String);
  ```
  Codex label rules: all `read` → `Read a.rs, b.rs` (names, max 3 then `+N more`); `search` → `Search <query> in <path>` (`in` part only when a path is given); `listFiles` → `List <path or .>`; mixed reads/searches/lists → `Explored <n> files` with kind `Read`; `unknown` or none → the unwrapped command, kind `Command`.

- [ ] **Step 1: Write failing tests:** `split_cd_plain`, `split_cd_quoted_path_with_spaces`, `split_cd_semicolon`, `split_cd_leaves_mid_command_cd_alone` (`git status && cd x` unchanged), `unwrap_zsh_lc_single_quotes`, `unwrap_leaves_plain_command`, `folder_note_none_for_room_folder` (`/work/project` vs cwd `/work/project/`), `folder_note_last_part` (`/Users/x/Downloads/apex-deck-worktrees/ios-sim-upgrade` → `ios-sim-upgrade`), `codex_reads_list_names`, `codex_search_with_path`, `codex_unknown_falls_back`. Use `commandActions` shapes copied from `codex_turn.jsonl`.
- [ ] **Step 2:** `TMPDIR=/tmp cargo test -p apex-adapters step_labels` → FAIL.
- [ ] **Step 3: Implement.** No regex crate if it isn't already a dependency of apex-adapters; plain string scanning is enough.
- [ ] **Step 4:** tests PASS.
- [ ] **Step 5: Commit** `feat(adapters): clean step labels and folder notes`.

---

### Task 4: Build steps from the Claude and Codex feeds

**Files:**
- Modify: `crates/apex-adapters/src/events.rs` (`Step` enum at :43, `claude()` at :311-431, `claude_activity` at :488, `codex_server()` at :714-860), `crates/apex-adapters/src/lib.rs:47-62`
- Test: unit tests in `events.rs` using the Task 1 fixtures (`include_str!`)

**Interfaces:**
- Consumes: Task 2 types, Task 3 label functions.
- Produces: `Step::Work(WorkStep)`, `Step::Todo(Vec<TodoItem>)`; `report()` sends `Progress::Work` / `Progress::Todo`.

Rules:
- **Claude:** each `tool_use` → `Work` Running, key = tool_use `id`, `parent` = event `parent_tool_use_id` (non-null), label from `claude_label` (Bash: `split_cd` + `folder_note`, label = rest; Read/Edit/Write: `Read <short path>` etc.; `Task`/`Agent`: kind `Helper`, label = `description`). Each `tool_result` → same key, `output = cut_output(text)`, status `Failed` if `is_error` else `Done`. A `Helper` step started in the background stays `Running` until `background_tasks_changed` no longer lists its task (match by the field found in Task 1; if no id link exists, mark every Running background helper `Done` when the agent-task count reaches 0). `TodoWrite` (or the name from Task 1) → `Step::Todo`, and no `Work` step.
- **Codex:** `item/started` commandExecution → `Work` Running with `codex_label`; `item/completed` → same key with `aggregatedOutput`, `exitCode`, `durationMs`, status `Done` / `Failed` (non-zero exit or status `failed`) / `Stopped` (`declined`/interrupted). fileChange, webSearch, mcpToolCall also become steps (kinds Edit / Web / Tool). `reasoning` is not a step. `turn/plan/updated` → `Step::Todo` (`pending`/`inProgress`/`completed`).
- **Codex helpers:** stop returning early for other threads. A thread in `helper_threads` (or announced by `subAgentActivity` started) produces `Work` steps with `parent = Some(<helper thread id>)` and never reply text, usage or context. The helper's own box is a `Work` step with key = helper thread id, kind `Helper`, label = the helper's task (collab `prompt` first line cut to 80 chars, else `agentPath` last part), Running on start, Done on `subAgentActivity` completed, Stopped on interrupted, Failed on that thread's failed `turn/completed`.
- Activity lines are unchanged: `doing()` still runs for the same events with the same text.

- [ ] **Step 1: Write failing tests:**
  - `claude_fixture_steps_have_output_and_clean_labels`: over `claude_turn.jsonl`, the `ls` step's label is `ls` with `folder == None` (cd'd into the room folder), its output is non-empty, every step ends Done or Failed.
  - `claude_helper_steps_hang_under_their_helper`: steps from the helper have `parent == Some(<Agent tool_use id>)`, and that Agent step is kind `Helper`, Done.
  - `claude_todo_becomes_todo_not_a_step`.
  - `codex_fixture_reads_are_labelled_read`: a `sed -n` / `cat` read shows `Read <name>`.
  - `codex_command_output_exit_and_duration`: `git status` step has output, `exit_code == Some(0)`, a duration.
  - `codex_helper_steps_are_kept_and_parented`: steps from the helper thread exist with `parent == Some(helper thread id)`, and the reply text has no helper text (existing PINEAPPLE test at :1546 still passes).
  - `codex_plan_updates_todo`.
  - `activity_lines_unchanged`: the existing `activity()` assertions at :1380, :1433, :1496 are untouched and pass.
- [ ] **Step 2:** `TMPDIR=/tmp cargo test -p apex-adapters events` → new tests FAIL.
- [ ] **Step 3: Implement.** Keep the per-key start data in a `HashMap<String, WorkStep>` on `EventReader` so a completion only fills in output/status.
- [ ] **Step 4:** `TMPDIR=/tmp cargo test -p apex-adapters` → PASS.
- [ ] **Step 5: Commit** `feat(adapters): full steps from Claude and Codex, Codex helpers included`.

---

### Task 5: Save steps with the reply and load them back (host)

**Files:**
- Modify: `crates/apex-host/src/storage.rs` (paths beside `answers_path` :64; `save_room` :158 prune; `fork_room_with_snapshot_transform`; `import_room` guard; `delete_room` :266), `crates/apex-host/src/host.rs` (`turn_sink` :647; new `steps_load` beside `answers_load` :1214), `crates/apex-host/src/command.rs` (:30, :211), `crates/apex-daemon/src/authority.rs` (`command_needs`, table at :292)
- Test: `crates/apex-host/tests/host.rs`, unit tests in `storage.rs`, authority table

**Interfaces:**
- Consumes: `ReplySteps`, `RoomEvent::WorkStep`, `RoomEvent::Todo`.
- Produces:
  ```rust
  // storage.rs
  fn steps_path(&self, id) -> PathBuf;       // "<hex>.steps.jsonl", one ReplySteps per line
  fn steps_index_path(&self, id) -> PathBuf; // "<hex>.steps.index.json": { "version":1, "replies": { "<seq>": { "by", "count", "helpers", "offset", "len" } } }
  pub fn save_steps(&self, id: &str, record: &ReplySteps) -> Result<(), String>; // append line, then rewrite index
  pub fn steps_index(&self, id: &str) -> Result<Option<StepsIndex>, String>;
  pub fn steps(&self, id: &str, seq: usize) -> Result<Option<ReplySteps>, String>; // seek offset, read len
  // command: RoomSteps { room: String, seq: Option<usize> }
  //   seq None -> the index (counts only); seq Some -> that reply's ReplySteps (or null)
  // authority: "room_steps" => read(thread(room))
  ```
  Host: `turn_sink` keeps `Mutex<HashMap<(room, ParticipantId), ReplySteps>>`. `WorkStep` → `push`; `Todo` → replace `todo`; `MessageAdded` whose speaker is a bot with a buffer → set `seq`, `fit()`, `save_steps`, remove buffer; `Failed` / `Passed` / `ParticipantIdle` / `Stopped` for that bot (Stopped: all bots in the room) → remove buffer unsaved. A save error is logged and does not fail the turn (steps are extra; the reply must not be lost over them). `persist_event` stays as is: these events are still not written into the room file.

- [ ] **Step 1: Write failing tests** (storage unit + `tests/host.rs` with a scripted participant that emits Work progress):
  - `steps_saved_under_the_reply_seq`: a bot turn with 3 steps → `room_steps {room, seq:None}` lists that reply's seq with `count: 3`; `{seq}` returns the 3 steps in order.
  - `steps_without_a_reply_are_not_saved`: a turn that fails → index has no entry.
  - `two_bots_keep_separate_steps`: two scripted bots in one post → each reply's record holds only its own keys.
  - `truncate_and_fork_prune_steps`: save steps for seq 1 and 3, shrink the transcript to 2 → only seq 1 remains; fork at 2 → the fork's index lists only seq 1.
  - `steps_file_removed_with_room`: delete room → both files gone; `import_room` refuses an id whose steps file exists.
  - `room_steps_on_unknown_room_is_null`.
  - Authority table: `("room_steps", Some((ReadOnly, "thread")), json!({"room":"mine"}))`.
- [ ] **Step 2:** `TMPDIR=/tmp cargo test -p apex-host -p apex-daemon steps` → FAIL.
- [ ] **Step 3: Implement.** Write through the same writer as other room files (`write_held`-style, temp + rename for the index; append with `O_APPEND` for the jsonl). Prune rewrites both files keeping lines with `seq < upto`.
- [ ] **Step 4:** `TMPDIR=/tmp cargo test -p apex-host -p apex-daemon` → PASS.
- [ ] **Step 5: Commit** `feat(host): save each reply's steps beside the thread`.

---

### Task 6: The TS step model

**Files:**
- Create: `src/workSteps.ts`
- Modify: `src/types.ts` (RoomEvent union at :267; `WorkStep`, `TodoItem`, `ReplySteps`, `StepsIndex` mirrors), `src/backend.ts` (`roomSteps` on `Backend` beside `answersLoad` :52, demo backend returns null), `src/commandBackend.ts:41` (`roomSteps: (room, seq) => call("room_steps", { room, seq })`)
- Test: `tests/work-steps.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface TurnSteps { steps: WorkStep[]; todo: TodoItem[]; structured: boolean }
  export const emptyTurnSteps: TurnSteps;
  /** Upsert by key; `todo` replaces. `structured` turns true on the first work_step. Same object back when nothing changes. */
  export function applyStepEvent(turn: TurnSteps, event: RoomEvent): TurnSteps;
  export interface StepNode { step: WorkStep; children: StepNode[] }   // children = steps whose parent is this step's key
  /** Top-level steps in order, each Helper step holding its own steps. A step whose parent is unknown stays top-level. */
  export function stepTree(steps: readonly WorkStep[]): StepNode[];
  /** "83 steps" / "1 step"; counts every step including helpers' */
  export function stepsCountLabel(count: number): string;
  /** Read what room_steps returned; null for a missing/damaged/unknown-command reply (older daemon). */
  export function readStepsIndex(value: unknown): StepsIndex | null;
  export function readReplySteps(value: unknown): ReplySteps | null;
  ```
- [ ] **Step 1: Write failing tests:** upsert keeps one entry per key and keeps output when the done event has none; unknown parent stays top-level; a Helper's children keep their order; `todo` replaces wholesale; `stepsCountLabel(1) === "1 step"`, `(83) === "83 steps"`; `readStepsIndex` returns null for `null`, for `{}` and for a string.
- [ ] **Step 2:** `npm test -- tests/work-steps.test.mjs` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm test` and `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit** `feat(ui): step model for live and saved work steps`.

---

### Task 7: Live bubble: full list, step detail, helper boxes, to-do (items 1, 3, 4, 5)

**Files:**
- Create: `src/WorkSteps.tsx`
- Modify: `src/ChatPane.tsx` (`TurnProgress` :350 gains `work: TurnSteps`; event handling :879-888 calls `applyStepEvent` for `work_step` / `todo`; the steps block :3004-3025 renders `<WorkSteps>` when `turn.work.structured`, else today's list), `src/styles.css` (near `.steps` :1042), `src/glass-theme.css:245`
- Test: `tests/work-steps-component.test.mjs` (render with the repo's existing component-test approach, as in `tests/attached-media-component.test.mjs`)

**Interfaces:**
- Consumes: Task 6.
- Produces:
  ```tsx
  export function WorkSteps(props: { turn: TurnSteps; live: boolean; initiallyOpen?: boolean }): JSX.Element
  ```
  Behaviour:
  - Folded (default while live): the last 4 top-level rows (`MAX_STEPS_SHOWN`), above them a `<button>` "79 earlier steps"; open: every row, and a "Show fewer" button. Open/closed survives new events in the same turn.
  - A row shows an icon by kind, the label, a muted `in <folder>` when set, and status (spinner while Running, ✕ for Failed with the exit code). Rows are `<button aria-expanded>`; clicking opens a detail block under the row: the full `detail` in a monospace `<pre>`, then the `output` in a scrollable `<pre>` (max-height 240px), then exit code and duration when known, and "Output was cut to fit" when `output_cut` or the output contains the cut note. All text set as text, never as HTML.
  - A Helper step renders as a box: title = label, status word ("Working" / "Done" / "Failed" / "Stopped") and child count, folded by default; its latest child label shows under the title while it is Running. Opening it shows its children with the same rows.
  - When `todo` is non-empty, a compact checklist sits above the steps: ✔ completed, ▸ in progress (bold), □ pending.
  - Keyboard: every button reachable by Tab, visible focus ring, Enter/Space toggle.
- [ ] **Step 1: Write failing tests:** 10 steps render 4 rows plus a "6 earlier steps" button; clicking it shows 10 and "Show fewer"; clicking a row shows its `detail` and `output` text; a Helper with 3 children renders folded with "Done" and opens to 3 rows; a `<b>` in output renders as literal text; todo renders 3 items with the in-progress one marked.
- [ ] **Step 2:** `npm test -- tests/work-steps-component.test.mjs` → FAIL.
- [ ] **Step 3: Implement**, then wire into `ChatPane.tsx`.
- [ ] **Step 4:** `npm test`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Look before installing:** render the bubble with a seeded turn (20 steps, one helper with 5 children, a failed command, a todo list, a 2 000-line output) offscreen in both the default and Glass themes, save PNGs, view them, fix anything stretched or clipped.
- [ ] **Step 6: Commit** `feat(ui): full step list, step detail, helper boxes and to-do in the working bubble`.

---

### Task 8: Folded steps on the finished reply (item 2)

**Files:**
- Modify: `src/ChatPane.tsx` (completed bubble around :2981-2993, beside `ChangedFilesStrip`; load the index with the room state and again after each bot `message_added`), `src/styles.css`
- Test: extend `tests/work-steps-component.test.mjs`

**Interfaces:**
- Consumes: `roomSteps` (Task 6), `WorkSteps` (Task 7).
- Behaviour: when the index has the reply's seq, the reply shows a quiet `<button>` "83 steps" (count from the index, helpers' steps included). Clicking loads `roomSteps(room, seq)` once, then shows `<WorkSteps live={false} initiallyOpen>` under it; clicking again folds it. While loading: "Loading steps…"; on error or null: "Steps aren't available for this reply." When the index call fails as an unknown command, no line shows on any reply, and nothing is retried in that pane.
- [ ] **Step 1: Write failing tests:** a reply with index count 83 shows "83 steps" and makes no `roomSteps(room, seq)` call until clicked; one click calls it once and shows the steps; a second click hides them without another call; an index of null shows no line.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npm test`, `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Dev-build check.** Start only the dev build: `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev` from `~/Downloads/apex-deck`. In a scratch thread, have one Claude bot and one Codex bot each run a few commands and one helper. Confirm: live list opens; a step shows its output; labels have no `cd …&&`; both helpers show in boxes; Codex to-do shows; after the reply, "N steps" appears, survives a window reload and a dev daemon restart. Screenshot each.
- [ ] **Step 6: Commit** `feat(ui): saved steps on finished replies`.

---

### Task 9: Phone

**Files:**
- Modify: `src/phoneWorking.ts` (`PhoneTurn` gains `work: TurnSteps`, `applyTurnEvent` handles `work_step` / `todo`), `src/phone/PhoneApp.tsx` (:2217-2240 working bubble; finished replies), phone CSS
- Test: `tests/phoneWorking.test.mjs` (existing) gains cases

**Interfaces:** reuses `WorkSteps` and `roomSteps` unchanged; the phone keeps its own `MAX_STEPS_SHOWN = 6` folded count.

- [ ] **Step 1: Failing tests:** `applyTurnEvent` with `work_step` upserts into `work`, and `MAX_STEPS = 50` still caps the old `steps` line list.
- [ ] **Step 2–4:** fail, implement, `npm test` + `npx tsc --noEmit` pass.
- [ ] **Step 5:** check on the iOS simulator against a throwaway seeded daemon (memory `phone-test-daemon-check`), no real data in screenshots. Plain rows, no boxed cards (memory `phone-list-no-boxed-rows`): helper boxes on the phone are an indented group with a thin left rule, not a bordered card.
- [ ] **Step 6: Commit** `feat(phone): work steps in the phone bubble and on finished replies`.

---

## Not in this build (follow-ups)

- Streaming a running command's output live (Codex `outputDelta`) into an open step; output appears when the step ends.
- Saving steps for failed or stopped turns (Review Focus 2).
- Carrying steps when a thread is moved to another machine or exported.
- Updating the Hetzner daemon and TestFlight: separate go from the Human after merge.
- Conflict with the Live Bot Sessions plan (2026-10-14, Decision 6 turns off Claude session files): once this ships, Deck keeps its own record, so that decision no longer costs the person their history.
