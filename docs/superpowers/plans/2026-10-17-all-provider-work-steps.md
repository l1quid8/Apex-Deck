# Work Steps for Every Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every bot that does work (Gemini/Antigravity, Grok, Muse, media bots, custom CLIs), not just Claude and Codex, sends clickable work steps that are saved on the reply.

**Architecture:** The window, phone, saving and folding already work for any `RoomEvent::WorkStep` (shipped in e8cfb1e). This plan only adds producers. Each rich feed (agy, Grok, Muse) gets a converter in `apex-adapters` modelled on `work_feed::claude_step` / `codex_step`. Everything else gets a floor in `apex-core`: a participant that does not report native steps has its `Progress::Activity` lines turned into simple steps (label only, no output), so every provider shows the same list.

**Tech Stack:** Rust (apex-core, apex-adapters), serde_json. No window or phone code changes.

**Spec:** The Human's "ALL PROVIDERS" (2026-10-17), answering the offer to extend work steps beyond Claude and Codex. Real feeds recorded 2026-10-17: `crates/apex-adapters/tests/fixtures/work_steps/{gemini,grok,muse}_turn.jsonl`, described in `probe-notes-all-providers.md` in the same folder. Read those notes before any task; this plan cites them as "notes".

## Global Constraints

- Use `apex_core::work_steps::WorkStep` exactly as it is. No new fields, no wire change, so old phones and the Hetzner daemon keep working.
- Output goes through `work_feed::with_output` (which applies `cut_output`); detail through `cut_detail`; at most `STEPS_PER_REPLY_MAX` steps per reply (the `EventReader::work_step` gate already does this for readers; the floor and Muse must apply it too).
- Keep sending today's `Progress::Activity` lines unchanged. The window still falls back to them for old daemons.
- Fixtures stay scrubbed: no `/Users/<name>` paths, keys or emails in anything committed (the repo is public).
- Tests run with `TMPDIR=/tmp` (`codex_hook` socket tests fail on long paths otherwise).
- Gates for every task: `TMPDIR=/tmp cargo test -p apex-core -p apex-adapters -p apex-host` and `npx tsc --noEmit` pass.
- Bot commands in this repo start with the plain command, not `cd <long path> &&`.

## Review Focus

1. **A Gemini bot that cannot see the chat.** agy 1.4.0 ignores stdin in `-p` mode (notes, contradiction 1; re-checked by Jigga 2026-10-17: "The secret word is PELICAN" on stdin got "your message didn't include the conversation text"). Steps are worthless if the bot answers blind. Task 1 pins it with a command-line test and a live check.
2. **A Grok helper's words streamed as the bot's reply.** Helper events arrive with `parent_tool_use_id: null` (notes, contradiction 2). Task 4 pins that a foreground helper's text never reaches `Step::Text`.
3. **A failed command shown as done.** Grok's `is_error` is always false; Muse's exit code is inside `visibleOutput`. Tasks 4 and 5 pin `cat missing.txt` → `Failed`, `exit_code: Some(1)`. Gemini has no failure signal at all; that is a stated limit, not a bug.
4. **A step left spinning after the turn ends** (a floor step, a Gemini helper, a Muse call when the session dies). Tasks 2, 3 and 5 each pin "turn over → no step still `Running`".
5. **Two step lists for one turn.** A provider that gets a native converter must stop getting floor steps, or the bubble shows each action twice. Task 2's `reports_work_steps` flag and each converter task's test pin this.

---

## File Structure

- Create `crates/apex-core/src/activity_steps.rs`: the floor. Turns activity lines into steps for participants without native steps.
- Modify `crates/apex-core/src/participant.rs`: `Participant::reports_work_steps`.
- Modify `crates/apex-core/src/room.rs` (the three `progress_event` call sites, ~615/903/934): wrap the sink with the floor.
- Modify `crates/apex-adapters/src/presets.rs`, `cli.rs`: Gemini prompt delivery (Task 1), `OutputFormat::GrokStream` choice (Task 4).
- Modify `crates/apex-adapters/src/work_feed.rs`: `gemini_step`, `muse_step`, `muse_todos`.
- Create `crates/apex-adapters/src/grok_feed.rs`: Grok tool names and result decoding (it is big enough to stand alone).
- Modify `crates/apex-adapters/src/events.rs`: Antigravity steps, Grok branch of the Claude reader.
- Modify `crates/apex-adapters/src/muse_server.rs`: Muse steps and to-do list.

---

### Task 1: Gemini bots see the chat again

**Files:**
- Modify: `crates/apex-adapters/src/presets.rs` (Gemini arm, ~218-258)
- Modify: `crates/apex-adapters/src/cli.rs` (prompt write, ~273-281)
- Test: `presets.rs` tests module; `cli.rs` tests module

**Interfaces:**
- Produces: `pub(crate) fn agy_stdin_line(prompt: &str) -> String` in `presets.rs`, used by `cli.rs` when the program is `agy`/`antigravity`.

- [ ] **Step 1: Find the stdin message shape.** In `/tmp/probe-all`, run `agy --input-format stream-json --output-format stream-json -p ""` (and without `-p`) and feed one line on stdin, trying the Claude shape `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"The secret word is PELICAN. Reply with only the secret word."}]}}`, then `agy --help` for the documented shape. Done when the `result.response` says PELICAN. Write the working line and flags into `probe-notes-all-providers.md` under "Gemini". If no stdin form works, use the fallback in Step 3 and say so in the notes.
- [ ] **Step 2: Write failing tests.** `agy_reads_the_chat_from_stdin_as_a_message`: for program `agy`, args contain `["--input-format","stream-json"]` and the `-p` value is not `STDIN_INSTRUCTION`; `agy_stdin_line("hi")` parses as JSON with the Step 1 shape. Keep the existing `gemini` (legacy program) assertions unchanged. Run `TMPDIR=/tmp cargo test -p apex-adapters agy_` → FAIL.
- [ ] **Step 3: Implement.** Gemini arm pushes the Step 1 flags for `agy`/`antigravity`. `cli.rs` writes `agy_stdin_line(&prompt)` instead of the raw prompt for those programs. Fallback if Step 1 failed: pass the prompt as the `-p` value when it is at most 256 KB, otherwise write it to the staged temp folder (`attachments::Staged`) and pass `-p "Read the group chat in <file> and reply to it. Follow the instructions at its top."` with `--add-dir` for that folder.
- [ ] **Step 4: Run tests** → PASS, then the gates.
- [ ] **Step 5: Live check.** Run the built line by hand (as in Step 1) with a rendered two-message prompt; the reply must quote the secret word.
- [ ] **Step 6: Commit** `fix(gemini): deliver the chat to agy 1.4, which ignores stdin in -p mode`.

### Task 2: The floor: activity lines become steps

**Files:**
- Create: `crates/apex-core/src/activity_steps.rs` (+ `mod` in `lib.rs`)
- Modify: `crates/apex-core/src/participant.rs`, `crates/apex-core/src/room.rs`
- Modify: `crates/apex-adapters/src/cli.rs` (impl of the flag)
- Test: `activity_steps.rs` tests; `room.rs` tests using `testing.rs`

**Interfaces:**
- Produces: `fn reports_work_steps(&self) -> bool { false }` on `Participant`.
- Produces: `pub struct ActivitySteps` with `pub fn new() -> Self`, `pub fn activity(&mut self, text: &str) -> Vec<WorkStep>` (closes the previous running step as `Done`, opens a new one), `pub fn finish(&mut self, status: StepStatus) -> Vec<WorkStep>` (closes the running step with `status`).
- `CliParticipant::reports_work_steps` returns true exactly when the output format is `ClaudeStream` for `AgentTool::ClaudeCode`, or Codex. Tasks 3-5 each add their provider. `OpenAiCompatParticipant` and media bots keep `false`.

- [ ] **Step 1: Failing tests in `activity_steps.rs`.**
  - `each_activity_opens_a_step_and_closes_the_last`: `activity("Running: ls")` → 1 step, key `"a1"`, kind `Command`, label `"ls"`, `Running`; `activity("Reading a.txt")` → 2 steps: `a1` `Done`, `a2` kind `Read` `Running`.
  - `repeat_of_the_same_line_is_not_a_new_step`: same text twice → second call returns empty.
  - `finish_closes_the_open_step`: after one activity, `finish(StepStatus::Failed)` → `a1` `Failed`; `finish` again → empty.
  - `stops_at_the_reply_cap`: `STEPS_PER_REPLY_MAX + 5` distinct lines → at most `STEPS_PER_REPLY_MAX` distinct keys.
  - Kind map (label prefix → kind, prefix kept in label except `Running: `/`Running `, which is stripped): `Running`→Command, `Reading`/`Fetching`→Read, `Searching`/`Looking for files`→Search, `Editing`/`Writing`→Edit, `Making`/`Editing picture`→Tool, else Other. `Waiting for approval…`/`Waiting for your OK` lines are not steps.
- [ ] **Step 2: Failing room test** `room_turns_activity_into_steps_only_for_participants_without_their_own`: a test participant with `reports_work_steps() == false` that sends two activities then replies → the room emits two `RoomEvent::WorkStep` plus both `RoomEvent::Activity`, and the last step is `Done` after the reply; the same participant with the flag true → zero `WorkStep` events. A failed reply ends the open step `Failed`; a stopped turn ends it `Stopped`.
- [ ] **Step 3: Implement.** At each `progress_event` call site, when `!participant.reports_work_steps()`, hold an `ActivitySteps` in a `Mutex` beside the sink, emit its steps as `RoomEvent::WorkStep` after the `Activity` event, and call `finish` where the turn's result is known.
- [ ] **Step 4: Run tests** → PASS, gates.
- [ ] **Step 5: Commit** `feat(steps): give every provider a step list from its activity lines`.

### Task 3: Gemini (Antigravity) steps

**Files:**
- Modify: `crates/apex-adapters/src/work_feed.rs`, `crates/apex-adapters/src/events.rs` (`antigravity`, ~1189), `cli.rs` (flag)
- Test: `events.rs` tests, reading `tests/fixtures/work_steps/gemini_turn.jsonl` the way `claude_steps` does (~2290)

**Interfaces:**
- Produces: `pub(crate) fn gemini_step(key: &str, tool: &str, params: &Value, cwd: Option<&str>) -> WorkStep`. Kinds and labels follow `antigravity_activity`'s table (`run_command`→Command with `split_cd` folder note, `view_file`→Read, edit tools→Edit, `grep_search`→Search, `find_by_name`/`list_dir`→List, `search_web`/`read_url_content`→Web, `invoke_subagent`→Helper, else Tool). Detail is the full `CommandLine`/path/query.
- Step key: `"g" + step_index`. Helper key: `"gh" + step_index` of the launch.

- [ ] **Step 1: Failing test** `gemini_feed_makes_steps` over the fixture:
  - the `ls sub` command step ends `Done` with output `"b.txt\n"` (CRLF turned to LF) and `duration_ms` = `duration_seconds * 1000` rounded;
  - `cat missing.txt` ends `Done` (no failure signal exists; see Limits) with its error text as output;
  - `view_file a.txt` ends with output `"4 lines, 37 bytes"`; `write_to_file` ends with `output: None`;
  - the helper is one `Helper` step labelled with `subagent_info.subagents[0].role` ("Line Counter"), `Running` after the launch line and `Done` after the empty `system_message` DONE line;
  - after `result`, no step is `Running`; `Step::Activity` lines are unchanged from today.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** in `antigravity()`: ACTIVE tool → `gemini_step` running; DONE tool → `with_output(tool_info.output, Done)` plus duration; `step_type:"subagent"` (either state) → helper running; `system_message` DONE → close the oldest running helper `Done`; `result` → `end_step` every running step (`Done` on SUCCESS, `Failed` otherwise). `reports_work_steps` true for `AntigravityStream`.
- [ ] **Step 4: Run** → PASS, gates.
- [ ] **Step 5: Commit** `feat(steps): Gemini work steps`.

### Task 4: Grok steps, and its helpers kept out of the reply

**Files:**
- Create: `crates/apex-adapters/src/grok_feed.rs`
- Modify: `events.rs` (new `OutputFormat::GrokStream`, routed to `claude()` with Grok branches), `presets.rs:31` (Grok → `GrokStream`), `cli.rs` (flag)
- Test: `grok_feed.rs` unit tests; `events.rs` fixture test over `grok_turn.jsonl` (two runs; split at each `system/init`)

**Interfaces:**
- Produces in `grok_feed.rs`:
  - `pub(crate) fn grok_step(id: &str, parent: Option<&str>, tool: &str, input: &Value, cwd: Option<&str>) -> WorkStep`: `run_terminal_command`→Command (`command`, `split_cd`), `read_file`→Read (`target_file`), `grep`→Search (`pattern`, `path`), `list_dir`→List, `search_replace`/`write`→Edit, `web_search`/`web_fetch`→Web, `spawn_subagent`→Helper (`description`, detail `prompt`), else Tool.
  - `pub(crate) struct GrokResult { pub text: String, pub exit_code: Option<i32>, pub todos: Option<Vec<TodoItem>>, pub helper_done: bool }` and `pub(crate) fn grok_result(content: &str) -> GrokResult`. Text: Bash `output_for_prompt` minus its first `exit: N` line; ReadFile `FileContent.raw_output` (else `content`); GrepSearch `stdout` bytes as UTF-8 (lossy); Text `text`; TaskOutput `Result.output`; SubagentCompleted `output`. Content that is not JSON → used as text as is. `todos` from `TodosUpdated.todos` (status `pending`/`in_progress`/`completed`). `helper_done` for `SubagentCompleted` and for `TaskOutput` with `Result.status == "completed"`.
- Status of a result: `Failed` when `exit_code` is `Some(n)` with `n != 0` or `is_error` is true, else `Done`.

- [ ] **Step 1: Failing unit tests** for `grok_result` on each `type` above using strings copied from the fixture (`"exit: 1\ncat: ..."` → exit 1, text without the `exit:` line; GrepSearch bytes → `"a.txt:1:alpha one"`-style text; Todo → full list).
- [ ] **Step 2: Failing fixture test** `grok_feed_makes_steps`:
  - run 2's bare `cat missing.txt` → `Failed`, `exit_code: Some(1)`;
  - `read_file a.txt` → `Read` step labelled `Read a.txt`, output the file text (not JSON);
  - `todo_write` calls are not steps; a `Step::Todo` with the merged list follows each one;
  - run 2's foreground `spawn_subagent` is a `Helper` step; the helper's `run_terminal_command` (`ls sub`) has `parent` = the spawn's id; the helper ends `Done` with the `SubagentCompleted.output`;
  - **no `Step::Text` in run 2 contains the helper's report text**; the outcome text of each run equals `result.result`;
  - run 1's background spawn stays `Running` after its `Text` launch result and ends `Done` at the `TaskOutput` result; the helper's own command (id counter restarts at `-0`) gets the helper as `parent`;
  - no step is `Running` after either `result`.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.** In `claude()`, when `format == GrokStream`: use `grok_step` / `grok_result` instead of the Claude helpers; skip `Step::Change` from `claude_changes` unless mapped (`search_replace {file_path?, old_string?, new_string?}`: read the real field names from the fixture's init tool list or a quick probe; if unknown, no change card). Helper ownership (the stream has no link; notes, Grok "Helpers"): ids end in `-<n>`, a counter per agent. Track the main bot's next counter. While at least one helper is running, a `tool_use` whose counter is not the main's next belongs to the newest running helper. While a foreground helper is running (spawn seen, its result not yet), text deltas and `assistant` text are helper text: not `say()`d. `reports_work_steps` true for `GrokStream`.
- [ ] **Step 5: Run** → PASS, gates (the existing Claude fixture tests must be untouched and passing).
- [ ] **Step 6: Commit** `feat(steps): Grok work steps; keep helper text out of the reply`.

### Task 5: Muse steps and to-do list

**Files:**
- Modify: `crates/apex-adapters/src/muse_server.rs` (`run`, ~342-470), `work_feed.rs`, `cli.rs` (flag)
- Test: `muse_server.rs` tests over `muse_turn.jsonl` (two sessions)

**Interfaces:**
- Produces: `pub(crate) struct MuseSteps` with `pub(crate) fn notice(&mut self, method: &str, params: &Value) -> Vec<WorkStep>`, `pub(crate) fn todos(params: &Value) -> Option<Vec<TodoItem>>` (from `session/todoListChanged.items`), `pub(crate) fn finish(&mut self, status: StepStatus) -> Vec<WorkStep>`. `run()` feeds every notification through it and sends `Progress::Work` / `Progress::Todo` next to today's `Progress::Activity`.
- Produces: `pub(crate) fn muse_step(item: &Value, cwd: Option<&str>) -> WorkStep` in `work_feed.rs`: key `item.itemId`; `bash`/`shell`→Command, `read_file`→Read, `search`→Search, `edit_file`/`write_file`→Edit, `web_search`/`web_fetch`→Web, `workflow`→Helper, `write_todos`→ not a step, else Tool. `args` is a JSON string; parse it.

- [ ] **Step 1: Failing test** `muse_feed_makes_steps`:
  - `cat missing.txt` (bash) → `Failed`, `exit_code: Some(1)`, output is the `output` field inside `visibleOutput` (not the JSON);
  - `read_file a.txt` → `Done`, output starts `"Read text file"`; `edit_file` → `Done`, output is the diff;
  - the failed `workflow` call → `Helper` step `Failed` with the `failureReason` as output;
  - `write_todos` makes no step; `session/todoListChanged` yields a list where `inProgress` → `InProgress`, `completed` → `Completed`, `pending` → `Pending`, and `cancelled` items are dropped;
  - overlapping `read_file`/`bash` (two `item/started` before either completes) both end with their own outputs;
  - `item/updated` and `item/delta {field:"output"}` change nothing visible (the final output comes from `item/completed`);
  - `finish(Stopped)` after a start with no completion → that step `Stopped`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** No duration (`recordedAt` would need a date parser the crate does not have; leave `duration_ms: None`). Apply the `STEPS_PER_REPLY_MAX` gate. Call `finish` on every exit from `run()` (completed → `Done`, error → `Failed`). `reports_work_steps` true for Muse.
- [ ] **Step 4: Run** → PASS, gates.
- [ ] **Step 5: Commit** `feat(steps): Muse work steps and to-do list`.

### Task 6: Check every provider in the dev build

**Files:** none (results go in the PR/merge message and the Human report).

- [ ] **Step 1:** Start the dev build from `~/Downloads/apex-deck` with `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`.
- [ ] **Step 2:** In a new room on a scratch folder, give one Claude, Codex, Gemini, Grok and Muse bot the probe prompt from the notes. For each, check: steps are clickable and show output; the failed `cat` shows as failed (except Gemini); a folded "N steps" line appears on the reply and opens after a dev-build restart; the Grok reply contains no helper report text; the Gemini reply shows it read the chat.
- [ ] **Step 3:** For the floor, use a custom CLI bot (`Backend::Cli`, e.g. `cat`) and confirm it shows no steps and no errors; media bots are checked by test only (each picture costs money).
- [ ] **Step 4:** Report results in plain words. Merge, push, DMG and the Hetzner daemon update wait for the Human's go.

## Limits (written down for review)

- **Gemini:** no failure signal in the stream, so a failed command shows as done; `view_file` output is only a size summary; a helper is one step with no inner steps (its steps are only in agy's own transcript file, which this plan does not read).
- **Grok:** helper ownership is guessed from id counters and order. Two helpers running at once can mix their steps; a background helper's text can still stream into the live bubble (the saved reply is right, it comes from `result.result`).
- **Muse:** no durations; helpers (`workflow`) cannot start under Deck today, so they show only as a failed step.
- **API chat bots (Venice, OpenRouter, local Qwen):** they run no tools, so they have no steps. Media bots get floor steps ("Making picture"). A custom CLI bot gets steps only if it reports activity, which today it doesn't.
- The Hetzner daemon and old phones keep working but show steps only once their daemon is updated.
