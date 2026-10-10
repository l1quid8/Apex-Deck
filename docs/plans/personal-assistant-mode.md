# Personal assistant mode: architecture audit and phased plan

**Date:** 2026-10-09 · **Author:** Jigga · **Status:** draft for the Human's approval. No application code, services, data or deployments were changed to write this. Two read-only SSH commands were run against the VPS to check its daemon binary.

**Audited state:** `main` at `782529b` (one commit ahead of `origin/main` at `2d6724f`). Untracked `apexagent-mockup/` belongs to someone else and was not touched.

**Goal:** one assistant you can message from the iPhone or the Mac. It lives on the always-on VPS, remembers useful context, keeps working on authorized tasks while both apps are closed, and brings you results and decisions. **The target is ApexAgent working like OpenAI's Dot** (`https://learn.chatgpt.com/docs/dots`): the same experience for the user, built on the ApexAgent code we already have. We can't see OpenAI's source code, so the internals are our own design. Section 0.5 maps every Dot feature to where it lands in this plan.

---

## 0. How to read the labels

Every capability below carries one of three labels:

- **[S] implemented in source.** The code exists on `main`.
- **[T] covered by tests.** Automated tests exist and passed in the most recent recorded run. Linux CI is currently failing (section 1.8), so [T] means "passed on the Mac". It does not mean "passed in CI".
- **[O] observed working in the installed app.** Someone watched it work in `/Applications/Apex Deck.app`. Every [O] in this document comes from an earlier written report, cited by path, unless it says *observed today*. None of them were observed on the iPhone or against the VPS.

Plans and mockups are not features, so they get no label.

---

## 0.5 Dot feature map

Taken from Dot's public help page (read 2026-10-09). "Have" means something ApexAgent already does on the Mac today. Nothing here has been seen working on the VPS or the iPhone yet.

| Dot does this | ApexAgent today | Where it lands |
|---|---|---|
| Lives in the cloud and keeps working with your computer off | Runs on the Mac only | M1 (VPS host) |
| One conversation, continued from phone or desktop | One conversation, Mac only | M1 |
| Name, handle and a custom look (shape, colour, eyes, accessories) | Glowing avatar; look saved on the Mac only | M1 identity on the host; look picker in M5 |
| Introduces itself and suggests ways to help | No | M5 (needs memory) |
| Decides when to pause and resume follow-ups, no fixed schedule needed | Have: adaptive checks for projects | M6 widens it beyond projects |
| Set-time schedules you confirm, listed under **Scheduled** and cancellable | No | **Added to M6** |
| Saved notes on your preferences, decisions and ongoing work, shared across conversations | Per-project decisions only | M5 |
| Every action is allowed, needs your approval, or is handed to you | Have: approvals per project | M1 (one action), M3 (all actions) |
| Standing rules ("show me drafts before sending") | No | **Added to M3** (rules stored on the host; they can tighten limits, never loosen them) |
| Asks before sending requests or spending | Spend limit with a gap (1.6 #1) | M3 |
| Background agents run while you keep chatting; an **Activity** list shows progress, results and requests for input | Have: handoff cards inside the conversation | M7, plus **an Activity list added to M7** |
| Pause stops the main work; stopping a task doesn't undo finished actions | Have: Pause for monitoring | M2 (pause and cancel for all tasks) |
| Uses one connected personal computer, only while it's online | Have: Mac-only, nothing on the VPS | M4 (Mac jobs wait for the Mac) |
| Reaches out with results, decisions and at-risk deadlines | In-app attention only | M6 + D4 (push) |
| Checks with you before sharing private information with others | No | **Added to M3** (counts as a write to someone else) |
| Voice call, keeps working after the call ends | No | After M8, third (D6) |
| Slack / Teams messages, with updates routed by type | No | Out of scope (D6) |
| Connected apps (Gmail, Drive, GitHub) with their own permissions | No | After M8, first: GitHub, Gmail, Drive, read-only first (D6) |
| Its own cloud browser, with a "Take over" button so you can sign in yourself | No | After M8, second (D6) |

The last four rows are the biggest gaps from Dot. Three are planned (Slack/Teams is out of scope) and come after M8 because each one needs the gateway (M3) and the privacy controls (M8) first: otherwise a Slack message or an email could tell the assistant what to do.

## 0.6 Five Dot behaviors we adopt

Taken from Dot's Tasks and memory, Controls and Admin guide pages (read 2026-10-09). Each one is a rule the host enforces in code, not a line in the prompt.

1. **Four rule choices per kind of action.** Every action class (`Read`, `Write`, `Send`, `Spend`, and later each connected app) has one of four modes: **Do it without asking** (`Auto`), **Do it when I say so** (`OnRequest`: runs only if the Human's own message asked for that action), **Ask first** (`Ask`: a decision card every time) and **Hand it to me** (`HandOff`: the assistant prepares the step and the Human does it). Stored on the assistant record as `action_modes` (3.1) and checked by the gateway (3.4). Defaults: `Read` = Auto, `Write` and `Send` = Ask, `Spend` = Ask. `Spend` can never be set to `Auto` without a bounded `ScopeGrant`, and an unknown price always asks. Standing rules (0.5) can only move a mode toward `Ask` or `HandOff`. **Lands:** M1 stores the field and uses `Ask` for the slice tool; M3 adds the other modes and the settings control.
2. **Helpers only see their own job.** A helper (a parallel worker, or a project bot receiving a handoff) gets its assignment text, the files or evidence named in it, and its allowed tools. It does not get the main conversation, the memory store or other tasks. Its results come back as evidence and are quoted in the conversation, never as instructions. **Lands:** M7, built on the existing handoff code; the context assembler (3.6) gets a `helper` mode that emits only the assignment section.
3. **Research only reads.** A research job's tools are fixed to the `Read` class. It can't send, write, spend or contact anyone, whatever its instructions or findings say, and it can't ask for those permissions. If a finding suggests an action, the main assistant proposes it to the Human as a new decision. **Lands:** M3 (gateway rejects non-`Read` operations from a research job), tested in M7.
4. **Three separate stops.** **Pause** stops the assistant starting new work (it finishes or checkpoints the current step, keeps answering messages and keeps every task and schedule). **Stop task** cancels one task or helper and its subtasks without undoing finished actions. **Cancel schedule** removes one scheduled job and leaves running tasks alone. Three separate commands (`assistant_pause`, `assistant_cancel`, `assistant_schedule_cancel`) and three separate controls; none of them implies another. **Lands:** cancel in M1, pause in M2, schedule cancel in M6.
5. **Only you can direct it.** Only an event with `source = Human` from an authenticated Full-tier device (3.2) can start a task, change a rule or answer a decision. Messages from other people, bots, emails, Slack, web pages and documents are stored as evidence. They can be summarized and can trigger a notification to the Human, but they never create a task or an approval. **Lands:** M1 for app messages; each connector in D6 must pass the same test before it ships.

---

## 1. Current-state map

### 1.1 Where things run

| Piece | Where | Label | Notes |
|---|---|---|---|
| Mac service | `/Applications/Apex Deck.app/Contents/Resources/bin/apex-daemon serve --remote`, PID 38730, started 2026-10-09 21:04 | observed today | Its binary contains the `assistant_overview` and `assistant_handoff_prepare` command names. |
| Mac → VPS link | Mac service spawns `ssh … l1quid8@apex-terminal.xyz /usr/local/bin/apex-daemon --stdio --attach` | observed today | The Mac reaches the VPS over SSH stdio. |
| VPS service | `/usr/local/bin/apex-daemon serve --remote` under `apex-daemon@l1quid8` systemd, PID 265591, binary dated 2026-10-09 21:33 | observed today | **Binary has no `assistant_overview` or `assistant_handoff_prepare` strings, so it predates `21e3e1a`.** Its version string is `0.5.1`, the same as the Mac's, so the version string can't tell builds apart. |
| Phone → machines | `src/phoneBackend.ts`: one client per machine, WebSocket or iroh (`src/daemon/irohLink`), relay at `relay.apex-terminal.xyz` | [S][T] | The phone talks to each machine directly. A sleeping Mac doesn't cut the phone off from the VPS. |
| Push to iPhone | none | — | No APNs code anywhere. The phone only learns about things while the app is open. |

### 1.2 Host storage (`crates/apex-host/src/storage.rs`, atomic JSON documents in the data folder)

| Document | Owner module | Label | What it holds |
|---|---|---|---|
| `session.json`, rooms, artifacts | `storage.rs` `Store` | [S][T][O] | Threads, transcripts, pins. Written atomically. A failed read is reported, never treated as empty. |
| `monitor.json` | `monitor.rs` `MonitorDocument` / `ProjectMonitor` | [S][T][O] | One assistant per **project**: responsibility, decisions, preferences, selected files/threads, messages (capped at 200, `monitor.rs:4`), findings with evidence, check claims, persisted counters. |
| assistant tasks ledger | `assistant_tasks.rs` `AssistantTasks` | [S][T] | Durable tasks with status, attempts, run ids, usage, execution-thread registry, request-id dedupe, handoff receipts. Compare-and-set on `(owner, revision)`. |
| assistant conversation ledger | `assistant_conversation.rs` `ConversationStore` | [S][T] | Request-id dedupe for `assistant_message`. Stores Pending → Completed with the saved response. |
| devices / authority | `crates/apex-daemon/src/devices.rs`, `authority.rs` | [S][T] | Paired phones, tiers (ReadOnly / Chat / Full), per-thread scope. |
| API keys | Keychain or 0600 file (`crates/apex-adapters/src/keys.rs`) | [S][T][O] | Kept out of prompts. |

### 1.3 ApexAgent today (project-scoped)

| Capability | Files | Label | Evidence |
|---|---|---|---|
| Assign to a project, read-only monitoring with adaptive checks, restart recovery, two-check limit | `monitor.rs`, `monitor_commands.rs`, `monitor_check.rs`, `monitor_clock.rs`, `monitor_evidence.rs` | [S][T][O] | `docs/apexagent-validation-2026-10-09.md` (isolated data dir, installed app) |
| Findings owned by the host: Resolve/Dismiss/Snooze survive restart, no reopening on unchanged evidence | `monitor_check.rs` | [S][T] | Tests incl. `paraphrased_resolved_blocker_on_same_evidence_stays_settled` (`782529b`) |
| Evidence citations verified word for word against the exact snapshot | `monitor_check.rs`, `monitor_evidence.rs` | [S][T] | |
| Tool-free model call (OpenAI-compatible, or Claude Code with tools denied at the protocol boundary) | `monitor_check.rs:36` `reason`, `crates/apex-adapters` | [S][T] | 4 boundary tests in `crates/apex-adapters/tests/adapters.rs` |
| Restricted phones can't read monitors/tasks they lack access to | `authority.rs` | [S][T] | Every `assistant_*` write needs `full(Global)`. `assistant_tasks_list` and `monitor_get` need `read(Global)`. |
| Human request → task → approval → running → review → done, in saved project chats | `assistant_service.rs`, `assistant_tasks.rs` | [S][T] | `docs/apexagent-delegation.md`; isolated E2E in `/tmp/null-handoff-visual-20261009/results.md` (fixture, not production bots) |
| Isolated git worktrees, verified integration, journalled apply with crash reconcile | `assistant_git.rs`, `assistant_isolation.rs` | [S][T] | `interrupted_isolated_apply_reconciles_after_host_restart` |
| Spend limit per task, pause and resume at the limit | `assistant_service.rs` (`budget_exceeded`, `resume_budget`) | [S][T] | Unknown cost is **not** handled (section 1.6) |
| Cross-project reasoning (`assistant_overview`) | `assistant_overview.rs`, `src/apexAgentOverview.ts` | [S][T] | Read-only |
| Floating avatar + one combined conversation, `⌘K`, `⋯` menu, Retry/Discard | `src/ApexAgentAll.tsx`, `ApexAgentWidget.tsx`, `apex-agent-dock.css`, `apexAgentDockModel.ts` | [S][T][O] | `tests/apex-agent-all-component.test.mjs`; v3/v4 install reports |
| Per-project assistant on the phone | `src/phone/PhoneApp.tsx:460-533` (calls `monitor_get`, `assistant_tasks_list`) | [S] | Never observed on a physical iPhone (`docs/apexagent-v3-validation-2026-10-09.md`, "Limits") |
| Host event for task changes | `events.rs` `AssistantTasksChanged` | [S] | |
| Daemon announces capabilities | `crates/apex-daemon/src/protocol.rs:303-306` (`version`, `capabilities`) | [S] | `version` is only `CARGO_PKG_VERSION`. It has no commit id. |

### 1.4 Generic runtime we'll reuse

| Capability | Files | Label |
|---|---|---|
| Approval desk: proposals, questions, Always allow, `Spend` and `Plan` never auto-allowed | `crates/apex-core/src/approval.rs` | [S][T][O] |
| Concurrent rooms, per-bot slots, stop | `crates/apex-core/src/concurrent.rs` | [S][T][O] |
| FIFO write lease per checkout (serializes conflicting writes) | `crates/apex-core/src/write_gate.rs` | [S][T] |
| Mentions and routing | `crates/apex-core/src/mention.rs`, `decision.rs` | [S][T][O] |
| Pins (per-thread facts) | `crates/apex-core/src/room.rs:531-560` | [S][T][O] |
| Media bots ask before every paid job and report cost from the quote | `crates/apex-adapters/src/media.rs:425, 540` | [S][T][O] |
| Linux daemon built with the remote feature in CI | `.github/workflows/daemon.yml` (`--features remote`) | [S] (CI red, see 1.8) |

### 1.5 Client-owned state that should be host-owned

| State | Where it lives now | Problem |
|---|---|---|
| Combined cross-project conversation history | Mac `localStorage` key `apex-agent-overview-history` (`src/apexAgentOverview.ts:34`) | Invisible to the phone. Lost if Mac storage is cleared. |
| Handoff batches | Mac `localStorage` (`src/apexAgentOverview.ts:75-83`) | Same. |
| Assistant name, colour, shape | Mac `localStorage` (`src/ApexAgentWidget.tsx:56-57`) | Identity isn't host-owned. |
| Quiet hours | Mac `localStorage` (`src/ApexAgentWidget.tsx:60-61`) | Host-side proactivity can't respect them. |

### 1.6 Concrete defects found during the audit (fix in place, no replacement needed)

1. **Unknown cost becomes $0.** `TokenTotals::add` does `cost_micros.unwrap_or(0)` (`crates/apex-core/src/types.rs:227`), so room totals can't tell "free" from "unknown".
2. **Unknown cost slips past the spend limit.** `budget_exceeded` (`assistant_service.rs:2200-2202`) only compares a *reported* cost. A task whose worker never reports cost never pauses.
3. **Estimates are recorded as costs.** Video jobs store the pre-job *quote* as `cost_micros` (`media.rs:540`), with no estimate-vs-reported marker.
4. **Restart turns waiting work into Interrupted.** `AssistantTasks::recover_interrupted` (`assistant_tasks.rs:978`) marks every Queued/Running/Applying task, and every NeedsYou task with an open attempt, as `Interrupted`. `ConversationStore::open` marks Pending requests `Interrupted`, and `assistant_message` then refuses them ("Retry with a new request ID"). Root cause: approvals and questions are in-memory oneshot channels (`approval.rs:239-266`), so they die with the process.
5. **The assistant only exists per project.** `assistant_message` requires a `ProjectMonitor` assignment (`assistant_service.rs:183-185`). There is no assistant without a project folder.
6. **The VPS service is behind the Mac.** The binaries differ (1.1), and nothing in the welcome lets the UI detect it, because both say `0.5.1`.

### 1.7 Not present at all

A durable event inbox; durable approvals bound to parameters; a long-term memory store with supersession and expiry; a host-side notification policy; push notifications; per-assistant endpoint and source allowlists; a local-only mode; a "Mac-only, wait for the Mac" execution rule.

### 1.8 Linux CI

The `daemon` workflow has failed on the last three pushes to `main` (runs `37977055634`, `38003553739`, `38019835425`). The last green run was `37934247249`, 2026-10-09 13:04. Run `38019835425` fails 3 `apex-host` tests on both Linux runners (258 or 259 passed, 3 or 2 failed):

- `assistant_git::tests::integration_preserves_rename_binary_executable_mode_symlink_add_and_delete` panics at `assistant_git.rs:1151` with `Author identity unknown`. **Test-only:** one test commit lacked the fixture identity. (Correction: production commits already pass `-c user.name=ApexAgent`, `assistant_git.rs:280,466`, so the VPS is not affected.)
- `assistant_isolation::tests::bounded_setup_runner_kills_the_owned_process_group_on_timeout` fails at `assistant_isolation.rs:668`. **Test-only:** the test put its process registry directly in Linux's shared `/tmp`, which the registry correctly refuses (macOS's temp folder is private, so it passed there).
- `assistant_service::tests::unsupported_isolated_worker_stays_needs_you_and_can_be_retried` fails at `assistant_service.rs:3434` with "Wait for the active task operation to stop before recovering its processes." **Real race:** the task is saved as NeedsYou just before its startup run marks itself finished, so an instant Retry was refused. Fixed by letting Retry wait up to 5 s for that run.

**M0 progress (2026-10-09):** all three fixed in `0754cb8` on `fix/m0-linux-ci`. Local macOS run of the CI command: 799 passed, 0 failed, 1 ignored, exit 0 (with `TMPDIR=/tmp` for the known socket-path issue). One unrelated flake seen locally: `queued_zero_attempt_task_after_restart_waits_for_explicit_retry` failed once in 4 full `apex-host` runs; to investigate in M0.

Media-cost accounting and remote-build configuration are therefore **implemented, not validated**.

---

## 2. Gap analysis for the assistant mode

| Requirement | Exists | Gap |
|---|---|---|
| Distinct assistant, configurable identity/style | Project ApexAgent; look stored in Mac localStorage | Host-owned `AssistantRecord` that isn't tied to a project |
| Durable host = VPS | Hosts own monitors and tasks | Pointer from clients to `{assistantId, hostId}`; VPS must run current build |
| Phone + Mac reconcile, not own | Per-project data already on hosts | Move overview history, batches, identity and quiet hours to the host (1.5) |
| Task record fields | Status, attempts, run ids, usage, review criteria, destination | Completion criteria, target environment, scope grant, dependencies, wait reason, deadlines, stop conditions, checkpoints, operation receipts, retry/time limits, last user-visible update |
| Statuses | Proposed, NeedsClarification, Queued, Running, NeedsYou, ReadyForReview, Applying, Done, Failed, Cancelled, Interrupted | Distinguish waiting for input / approval / external event / a machine; add Blocked |
| Survive restart | Ledgers survive; live work becomes Interrupted (1.6 #4) | Durable approvals and questions; resume from the event log instead of marking Interrupted |
| Event-driven | Monitor clock wakes on writes and deadlines | One persisted, deduplicated event inbox for messages, decisions, timers, tool results and machine connect/disconnect |
| Tool gateway | Approval desk (in-process), write lease, read-only enforcement | Backend gateway with tool classes, parameter-bound approvals, re-check right before execution, receipts |
| Uncertain outcomes | Isolated-apply journal and reconcile (git only) | Generalize to Attempted → Accepted → Verified/Uncertain receipts for every side effect |
| Memory | Monitor decisions/preferences (strings), pins | Fact store with source, time, confidence, explicit/inferred, supersession, expiry, deletion; context assembler with a budget |
| Proactivity | Quiet monitor checks, findings, snooze | Host-side relevance/duplicate/quiet-hours policy, grouping, delivery to the phone |
| Parallel workers | Handoffs to saved chats, isolation, two-check limit | Per-worker context/tools/budget contract, loop guard across assistant tasks |
| Privacy/cost | Keys out of prompts, spend limit (reported cost only) | Endpoint/source allowlists, local-only mode, estimate vs reported, unknown-cost policy (1.6 #1-3) |
| Release integrity | `capabilities` list in welcome | Commit-level build id; blocking UI on mismatch; scripted VPS deploy + verify |

---

## 3. Proposed design (changes to existing structures)

### 3.1 Assistant record: new `crates/apex-host/src/assistants.rs`, document `assistants.json`

Built the same way as `monitor.rs`: one locked read → change → atomic save, with persisted counters.

```rust
pub struct AssistantRecord {
    pub id: String,                       // "asst-<n>"
    pub name: String,                     // replaces localStorage look.name
    pub style: String,                    // free text, goes into the prompt only
    pub look: Value,                      // colour/shape, display only
    pub profile: ParticipantConfig,       // reasoning profile, copied like monitor.profile
    pub timezone: String,
    pub quiet_hours: Option<QuietHours>,  // moved from localStorage
    pub allowed_endpoints: Vec<String>,   // model hosts it may call (M8 enforces)
    pub allowed_folders: Vec<String>,     // folders on THIS host its tools may touch
    pub action_modes: BTreeMap<ToolClass, ActionMode>, // 0.6 #1: Auto | OnRequest | Ask | HandOff
    pub paused: bool,                     // 0.6 #4: no new work starts while true
    pub revision: u64,
    pub message_id_counter: u64,
    pub event_counter: u64,
}
```

- The conversation lives in `assistant-<id>-conversation.json` as `Vec<AssistantMessage>`. Each message has `{id, role: human|assistant|system, author: {device_id?} , text, at, task_id?, kind: reply|question|approval|update|receipt, evidence}`. A human line is only ever written from an authenticated client command. Bot and tool output is always `assistant` or `system`, and external content is quoted inside `evidence`, never as a human line.
- `TaskOwner` stays unchanged. Assistant tasks use `workspaceId = "assistant:<id>"`, `cwd` = the folder the task runs in, `hostId` = the durable host, `conversationId` = the assistant id. All existing compare-and-set and owner checks in `assistant_tasks.rs` keep working without edits. (Rejected alternative: a new owner enum, which touches every call site for no safety gain in the slice.)

### 3.2 Event inbox: new `crates/apex-host/src/assistant_events.rs`, document `assistant-events.json`

```rust
pub struct AssistantEvent {
    pub id: String,            // dedupe key: client requestId, decision id, timer id, op id
    pub assistant_id: String,
    pub source: EventSource,   // Human{device_id, trust} | Decision{device_id} | Timer | Tool{op_id} | Machine{host_id, up}
    pub body: Value,
    pub received_at: u64,
    pub state: EventState,     // Received → Processing{claim} → Done{result_ref} | Failed{reason}
}
```

- **Persist first.** A command handler only validates and appends the event (or returns the existing one if the id is already known), then wakes the worker. The client gets an acknowledgement immediately, so the UI stays responsive.
- **One worker per host**, modelled on `monitor_clock.rs`. It wakes on new events, timer deadlines and every 60 s. It claims events one assistant at a time, in order. Claims are persisted, so after a restart a `Processing` claim goes back to `Received`.
- **Deterministic first.** A decision event, a cancel, or a timer for a task with no pending reasoning is applied in code with no model call. The model is called only for human text that needs interpreting, and only with the context the assembler picks (3.6).
- **Exactly one reply per event.** The reply message, any task change and `state = Done` are saved in one ledger mutation (one document write, or a journal entry if two documents change). Re-processing a `Received` event after a crash re-runs the tool-free model call, which has no side effects, and commits once. The test in 6 kills the host between the model call and the commit.

### 3.3 Task record changes (`assistant_tasks.rs`, all new fields `#[serde(default)]` so the existing ledger loads unchanged)

```rust
pub struct AssistantTask {
    // ... existing fields ...
    pub completion_criteria: Vec<String>,   // reuse review_criteria for project tasks
    pub target_host: Option<String>,        // where its operations must run
    pub grant: Option<ScopeGrant>,          // what the human authorized (3.4)
    pub depends_on: Vec<String>,
    pub wait: Option<TaskWait>,             // why it is not running
    pub deadline_at: Option<u64>,
    pub stop_conditions: Vec<String>,
    pub limits: TaskLimits,                 // max_attempts, max_runtime_ms, spend_limit_micros (moved out of result_data)
    pub operations: Vec<OperationReceipt>,  // 3.5
    pub last_update: Option<UserUpdate>,    // {at, text} last thing shown to the human
}
pub enum TaskWait { Input{decision_id}, Approval{decision_id}, External{what, until?}, Machine{host_id}, Dependency{task_id} }
```

Two new statuses: `Waiting` (external event, machine or dependency) and `Blocked` (can't continue without a change only the human can make). `NeedsYou` plus `wait` covers "waiting for input" and "waiting for approval". `recover_interrupted` changes for assistant-owned tasks: a task with a persisted `wait` keeps its status, and a `Running` task whose receipts are all settled goes back to `Queued` for the worker. Project tasks driven by CLI bots keep today's Interrupted behaviour until M2, because a dead CLI process can't be resumed.

### 3.4 Durable decisions and the tool gateway: new `crates/apex-host/src/assistant_gateway.rs`

```rust
pub struct OperationSpec { pub tool: String, pub host: String, pub cwd: String, pub params: Value }
pub struct PendingDecision {
    pub id: String, pub task_id: String, pub kind: DecisionKind,      // Approve{op} | Question{prompt, options}
    pub params_hash: String,      // sha256 of canonical JSON of OperationSpec
    pub task_revision: u64, pub status: DecisionStatus,               // Open | Approved | Denied | Superseded | Expired
    pub decided_by: Option<String>, pub decided_at: Option<u64>,
}
pub struct ToolDef { pub name: &'static str, pub class: ToolClass, pub idempotent: bool, pub host_only: bool }
pub enum ToolClass { Read, Write, Send, Spend }
```

- Decisions are stored in the task ledger, not the in-memory approval desk, so they survive restarts.
- `assistant_decide { decisionId, paramsHash, approve, answer? }` becomes an event. The worker applies it only if the decision is `Open`, the hash equals the task's current `OperationSpec`, and the deciding device holds Full tier (`authority.rs`). Any change to the spec supersedes the open decision and creates a new one.
- **Right before execution**, the gateway re-checks in one locked read: the task isn't cancelled, the decision is approved and matches the hash, `spec.host` equals this host, `spec.cwd` is inside `allowed_folders`, and the attempt count is under the limit. Only then does it save the receipt as `Attempted` and run the tool.
- The gateway reads the class's `action_mode` (0.6 #1) before anything else: `Ask` opens a decision, `HandOff` posts the prepared step for the Human and runs nothing, `OnRequest` runs only if the task came from a Human message that asked for this action, and `Auto` runs within the task's limits. A task started by a research job or helper is capped at `Read` whatever the modes say (0.6 #2–3).
- A permission can only come from a human decision event. Model output, bot mentions, documents, web pages and repo content can propose an `OperationSpec`. Nothing in that text is parsed as an approval. Subtasks get a `ScopeGrant` that is a subset of the parent's.
- Spending: a `Spend` tool needs either an approved decision or a `ScopeGrant { spend_limit_micros, expires_at }` that covers its **quoted** price. An unknown price always needs a decision.
- Slice tool: `host.command` (class `Read`, `idempotent: true`, `host_only: true`). It takes `argv` with no shell, a `cwd` inside `allowed_folders`, a 60 s timeout and a 64 KB output cap. It runs only after an approved decision, and its receipt saves the exit code, an output excerpt and the output hash.

### 3.5 Receipts and uncertain outcomes

```rust
pub struct OperationReceipt { pub op_id: String, pub params_hash: String, pub phase: OpPhase,
    pub provider_ref: Option<String>, pub started_at: u64, pub finished_at: Option<u64>, pub evidence: Value }
pub enum OpPhase { Attempted, Accepted, Verified, Failed, Uncertain }
```

- `op_id = <task>-<step>-<attempt>` is passed as the idempotency key when a provider supports one.
- On restart, an `Attempted` receipt with no outcome becomes `Uncertain`. For an `idempotent` tool, the worker may run it again and records that it did. For any other tool, it reconciles with the provider (for example, looks the job up by `provider_ref`). If it still can't tell, it opens a Question decision explaining the risk of duplicating the action. It never repeats a non-idempotent action on its own.
- Receipts keep observable evidence only: commands, exit codes, provider ids, output hashes. They never keep reasoning transcripts.

### 3.6 Memory and context (M5)

- `assistant-<id>-memory.json`: `Fact { id, text, kind: preference|fact|decision|commitment, source: {message_id|task_id|evidence_ref}, explicit: bool, confidence, created_at, expires_at?, superseded_by?, deleted_at? }`. A one-time choice is saved as a `decision` on its task, not as a `preference`. Correcting a fact writes a new fact and sets `superseded_by` on the old one. Deleting tombstones the fact and removes its text.
- Context assembler: a deterministic function `(assistant, task?, budget_tokens) → prompt sections`. Fixed order: identity/style, the open task and its pending decision, current facts filtered by relevance, the last N conversation messages, then cited evidence. Each section has its own share of the budget. Summaries keep links to their source messages. The assembler never emits an authorization: grants come from the ledger only, and the prompt says so.
- Search: start with the existing JSON documents and substring/keyword matching. Embeddings or a database are deferred until a measured recall problem shows up.

### 3.7 Execution location (M4)

- Every operation has `spec.host`. The gateway only runs operations whose `spec.host` is the local host.
- A task on the VPS that needs the Mac gets `wait = Machine{mac}`. When the Mac's service connects (it already attaches to the VPS over SSH), the Mac's worker pulls operations for its host id, runs them through **its own** gateway with the same decision check, and posts the receipt back as a `Tool` event. If the Mac stays offline, only those tasks wait. Nothing fails over to another machine.

### 3.8 Proactivity (M6)

A host-side `notify(assistant, candidate)` gate checks, in order: relevance to an open task or goal; whether it's new (fingerprint, like `evidence_fingerprint`); whether it's a duplicate of what was last delivered; whether it needs an action or decision; then quiet hours and timezone. Non-urgent items go into one digest. Unchanged results stay quiet. Permission to notify never gives permission to contact anyone else, buy anything or change anything.

### 3.9 Release integrity (M0)

- `crates/apex-daemon/build.rs` bakes `GIT_COMMIT` and a `dirty` flag into the binary, the welcome payload and `apex-daemon --version`. Vite does the same for the UI bundle.
- The Mac UI and the phone compare the UI build with each connected service's build and capabilities. A mismatch shows a blocking banner on assistant surfaces ("VPS service is build `abc1234`, this app is `def5678`; update the VPS") instead of failing deep inside a call.

---

## 4. First vertical slice (Milestone 1)

**One task, start to finish, from the iPhone and the Mac.**

1. On the iPhone, I open the Assistant and type: "Check how much disk space is free on the server." The phone sends `assistant_send` to the **VPS** service. The VPS stores the event and replies "Got it" at once.
2. The worker interprets it with the tool-free reasoning call. It creates one task with completion criteria "report free space on /" and target host = VPS. It proposes `host.command ["df","-h","/"]` in the assistant's allowed folder. It saves a `PendingDecision` and posts an approval line in the conversation.
3. On the Mac, the same conversation shows the approval card with the exact command, folder and machine. I press Approve. The Mac sends `assistant_decide` with the decision id and parameter hash.
4. I close both apps. The VPS service is restarted (`systemctl restart apex-daemon@l1quid8`) **twice**: once while the decision is still open (variant A, approve after the restart), and once after approval but before the result is posted (variant B, using a test hook in the fake-tool run, and a timed restart in the live run).
5. I reopen either app. The task shows Done with one receipt: the command, exit code 0, and an output excerpt. The conversation has exactly one request line, one approval line, one result reply and no duplicates. The receipt shows whether the command was re-run after the restart.

**Out of scope for the slice:** memory, proactivity, notifications, parallel workers, spending, Mac-only operations, project tasks, endpoint controls.

**Files:**

- *New:* `crates/apex-host/src/assistants.rs`, `assistant_events.rs`, `assistant_gateway.rs` (one tool), `assistant_worker.rs`.
- *Changed:* `assistant_tasks.rs` (new fields, `wait`, slice-only recovery rule), `host.rs` + `command.rs` (`assistant_create`, `assistant_get`, `assistant_send`, `assistant_decide`, `assistant_cancel`), `events.rs` (`AssistantChanged`), `crates/apex-daemon/src/authority.rs` (all five classified `full(Global)`, plus one test row each), `crates/apex-daemon/src/main.rs`/`serve.rs` (start the worker).
- *UI:* `src/hostBackends.ts` (route to the assistant's host); `src/ApexAgentAll.tsx` (one "Personal" lane in the existing floating conversation, approval card reusing `ApprovalCard.tsx`, a task status chip); `src/phone/PhoneApp.tsx` (an "Assistant" entry that opens the existing `ApexAgent` sheet against the VPS host). No new sidebar or panels.

**Slice acceptance (automated, fake model + fake tool, isolated `APEX_DECK_DATA_DIR`):**

- `send_is_acknowledged_before_reasoning` and `duplicate_request_id_gives_one_event_one_reply`
- `open_decision_survives_restart_and_is_answerable_after`
- `approved_but_unexecuted_op_runs_once_after_restart` (idempotent tool)
- `attempted_non_idempotent_op_becomes_uncertain_and_asks` (fake non-idempotent tool)
- `changed_params_supersede_decision_and_old_hash_is_refused`
- `bot_or_model_text_saying_approved_creates_no_approval`
- `cancel_before_execution_prevents_the_operation`
- `restricted_phone_cannot_send_or_decide` (authority)
- `non_human_event_cannot_create_task_or_decide` (0.6 #5: a bot reply or quoted message containing "do X" creates no task)
- `crash_between_model_call_and_commit_gives_one_reply`

**Slice acceptance (live, per the definition of done):**

1. `main` CI green on all three runners (M0).
2. The exact commit is built and installed at `/Applications/Apex Deck.app`. The running Mac service's binary path, start time and welcome `build` match the UI build. Checked with `ps`, `codesign -dv` and a welcome dump saved to `/tmp/pa-m1/mac-welcome.json`.
3. The VPS binary is installed from the same commit with `--features remote`. `systemctl status` and the welcome `build` match. Saved to `/tmp/pa-m1/vps-welcome.json`.
4. Steps 1–5 above are performed by the Human on the physical iPhone and the Mac against the real VPS. Screenshots go to `/tmp/pa-m1/screens/` (phone send, Mac approval, post-restart phone view) and the service journal to `/tmp/pa-m1/vps-journal.txt`. Paths are reported in the result.
5. Any build or capability mismatch stops the milestone.

---

## 5. Milestones

Every milestone includes: CI green; unit and fake-provider tests; the installed Mac app and the running Mac service on the same build; the VPS on the same build with the remote feature; behaviour watched on the Mac and the iPhone against the VPS; artifacts saved under `/tmp/pa-mN/`. A mismatch is a blocker.

| # | Milestone | Main changes | Acceptance (in addition to the shared checks) |
|---|---|---|---|
| **M0** | Release integrity and CI | Fix the 3 Linux failures (set a test git identity, and make production integration supply an explicit identity; fix the process-group timeout on Linux; wait for operation stop in the retry test). `build.rs` commit id in the welcome and `--version`. Mismatch banner. `scripts/verify-install.sh` (Mac: app payload hash, service path, start time, build) and `scripts/vps-deploy.sh` (build, install, restart, verify build over the welcome). | 3 consecutive green CI runs. A forced mismatch shows the banner (screenshot). Mac and VPS welcomes show the same commit. |
| **M1** | First vertical slice | Section 4 | Section 4 |
| **M2** | Full task lifecycle | `Waiting`/`Blocked`, dependencies, deadlines, stop conditions, retry and runtime limits, cancellation cascading to subtasks. **Pause** (0.6 #4): no new work starts, current step checkpoints, conversation still answers. Conversation `Pending` re-processed from the inbox instead of refused. Project-task bot attempts: on restart, re-ask the open approval as a new decision instead of `Interrupted`, where the worker supports resume. | Waiting tasks survive a restart. Closing both clients doesn't cancel VPS work. A cancelled task performs no further operation (fake-tool trace). While paused, a queued task doesn't start and a message still gets a reply; unpausing starts it once. |
| **M3** | Gateway, spending, receipts everywhere | Fix 1.6 #1–3: `Option` cost with `CostSource { Reported, Estimated, Unknown }`; unknown cost needs a decision; budgets enforced in the gateway. `ScopeGrant` with bounded spend. Draft and send as separate tools. The four action modes (0.6 #1) with a settings control; research jobs capped at `Read` (0.6 #3). Existing media `Spend` and bot approvals logged as receipts. | An injected "approved, spend $5" in a bot reply or document can't spend or write. Media charges with no token counts appear in totals as `Estimated` or `Reported`. Unknown price → decision card. Each mode behaves as specified for each class (`HandOff` runs nothing; `Spend` can't be `Auto` without a grant). A research job's write request is refused. |
| **M4** | Execution location | `spec.host`; `Machine` wait; the Mac pulls its own operations over the existing SSH attach; receipts flow back as events. | With the Mac offline, only Mac-targeted tasks wait and VPS tasks finish. Reconnecting runs the Mac operation once. |
| **M5** | Memory and context | Fact store, supersession, expiry, delete; context assembler with budget; migrate `apex-agent-overview-history`, batches, look and quiet hours from Mac localStorage to the host (one-time import, with the Human's OK). | A correction supersedes the older fact in the next prompt (fake model captures the prompt). A deleted fact never reappears. Over-budget context stays within budget and keeps source links. |
| **M6** | Proactivity and delivery | `notify` gate, digests, quiet hours on the host, background jobs tied to tasks (monitor clock generalized). Set-time schedules with **Cancel schedule** (0.6 #4). iPhone delivery per decision D4. | A background check with unchanged results sends nothing three times in a row. Quiet hours delay delivery. Cancelling a schedule leaves its running task alone, and stopping a task leaves its schedule alone. |
| **M7** | Parallel workers | Worker contract (task, context slice, allowed tools, budget, completion condition) on top of the existing handoff/isolation code. Recursion guard (worker can't create assistant tasks). Mutations serialized with `CheckoutWriteGate`. Helpers get only their assignment (0.6 #2). Findings consolidated into the one conversation. | Two independent workers run while the conversation answers a new message. A worker trying to spawn a task is refused. Two writers to one checkout are serialized. A helper's captured prompt contains its assignment and nothing from the main conversation or memory. |
| **M8** | Privacy, endpoints, cost view | `allowed_endpoints` enforced in the adapters; local-only mode; outbound-context accounting per call type (reply, summary, background); receipts and costs view without secrets. | A call to a non-allowed endpoint is refused before sending. Local-only refuses cloud profiles and network tools. |

### Required acceptance tests → where they land

| Test | Milestone |
|---|---|
| Conversations and waiting tasks survive host restarts | M1 (slice), M2 (all statuses) |
| Closing the iPhone or Mac client doesn't cancel VPS work | M1 live, M2 |
| A disconnected Mac blocks only work requiring that Mac | M4 |
| Duplicate events don't duplicate replies or actions | M1 |
| Bot mentions and injected instructions can't authorize spending or writes | M1 (writes/approvals), M3 (spending) |
| Changed parameters can't reuse an unrelated approval | M1 |
| Cancellation prevents subsequent actions | M1 (single op), M2 (subtasks) |
| Uncertain submissions don't get blindly repeated | M1 (fake non-idempotent tool), M3 (providers) |
| Corrected memories supersede older facts | M5 |
| Background checks don't repeatedly send the same notification | M6 |
| Media charges appear in accounting even without token usage | M3 |
| Remote-enabled builds and their permission paths are tested | M0 (CI with `--features remote`), M1 (authority rows + phone over iroh live) |
| Linux CI passes | M0, and every milestone after |
| Only the Human's messages can start work or approve (0.6 #5) | M1, and each D6 connector |
| Action modes are enforced by the gateway, not the prompt (0.6 #1) | M1 (`Ask`), M3 (all four) |
| Research jobs can't write, send or spend (0.6 #3) | M3, M7 |
| Helpers see only their assignment (0.6 #2) | M7 |
| Pause, Stop task and Cancel schedule are independent (0.6 #4) | M1, M2, M6 |

All of these use fake providers and failure injection first. No paid model calls or real external actions run without the Human's authorization. The slice's live run uses whichever reasoning profile is chosen in D1.

---

## 6. Risks

- **Migration:** the new task fields all use `#[serde(default)]`; `assistants.json` and the events document are new files. The localStorage import (M5) is one-way, so it keeps the Mac copy until the Human confirms. Every migration is backed up first (`assistant-tasks.json.bak-<date>`).
- **Recovery:** two documents (events and tasks) changing in one step need a small journal, or both must live in one document. The slice keeps conversation, events and tasks for one assistant in the same lock, with a crash test between writes.
- **Version drift (what broke the last integration):** without M0, the UI can call commands the VPS doesn't have, as it can today (1.1). M0 is a hard prerequisite.
- **Privacy:** storage on the VPS doesn't keep model requests local. Each reasoning call sends the assembled context to the profile's provider (Anthropic via Claude Code, or the API provider). The VPS also holds the conversation, so its disk and SSH access become sensitive.
- **Cost:** the event worker calls the model once per human message, never while a task is just waiting. Background work (M6) is capped per assistant per day. Subscription CLIs report no money cost, so they're tracked as `Unknown` and need a decision under M3 rules if a money limit is set.
- **Concurrent work:** other bots edit this folder. Each milestone stages only its own files and checks `git status` before committing.

---

## 7. Decisions (answered by the Human, 2026-10-09)

1. **D1 – Reasoning profile on the VPS: (a).** Claude Code CLI signed in on the VPS (subscription, tool-free path already enforced).
2. **D2 – The slice's one tool: yes.** An approval-gated read-only `df -h /` on the VPS. Folder: a new empty `~/apex-assistant-slice` on the VPS unless the Human names another before M1.
3. **D3 – Phone access: yes.** Every personal-assistant command, including reading the conversation, needs a Full-tier device.
4. **D4 – iPhone delivery: yes, APNs push in M6.** In-app only until then. M6 needs an Apple push key saved on the VPS.
5. **D5 – Release first: yes.** M0 is approved, including pushing `782529b`. No assistant code before M0 is done.
6. **D6 – The rest of Dot: everything except Slack/Teams**, after M8, in this order unless the Human reorders: (1) connected apps, read-only first: GitHub, then Gmail, then Drive; (2) its own browser with Take over; (3) voice calls. Slack/Teams is out of scope.

## 8. Next step

**M0 is approved and in progress.** M1 starts after M0 meets its acceptance checks (section 5), and the Human confirms.
