# ApexAgent: project assistant with tracked, isolated delegation

Approved implementation plan, reconciled with Tyler on 2026-10-09.
The decisions below supersede conflicting additions in the earlier Claude draft.

## Summary

Keep **ApexAgent**, described as **"Your project assistant."** It remembers
the project goal, assigns work to thread agents, tracks progress, and brings
results back for your acceptance.

It ships in two releases:

- **v0.6, delegation (milestones 1 to 3):** tasks run one at a time per
  project, in a linked execution thread on the project's own checkout.
- **v0.7, isolation (milestone 4):** parallel tasks in separate Git
  worktrees, with verified integration on accept.

**(added) Why split:** worktrees and three-way integration are the riskiest
part. Splitting gets delegation into daily use sooner, and the task records,
run ownership and recovery logic get proven before isolation builds on them.
Both releases support **desktop and phone**, and local and remote projects.

Your chosen behavior:

- Clear requests from you dispatch directly. ApexAgent's own suggestions
  require approval.
- An unclear destination triggers clarification before dispatch.
- Within the chosen thread, named bots take precedence; otherwise use its
  last-addressed eligible bot(s), then its first eligible bot.
- ApexAgent can create a thread. If no bot is named, it asks you to choose one.
- Worktrees (v0.7) include current tracked edits and non-ignored new files,
  minus likely secrets (see milestone 4).
- Results become **Ready for review**. v0.6 shows "In place — edits are already in your checkout"; Accept verifies and marks Done without applying again. v0.7 stages, verifies and applies isolated changes on Accept. Cancel retains in-place edits and releases ownership.

## Before starting (added)

- Implementation uses a managed isolated checkout created from a recoverable snapshot of the dirty primary checkout. Helpers own disjoint files, with shared interfaces integrated by the controller. No remote push is authorized.
- **Git housekeeping:**
  - `feat/glass-themes-v4` is fully merged into `main`, two commits behind it,
    with nothing uncommitted. Remove its worktree
    (`~/Downloads/apex-deck-glass-v4`) once Tyler agrees.
  - The Oct 8 stash ("Preserve main App work during authorized glass-v4
    merge") is superseded by the ApexAgent wiring in the current `App.tsx`.
    Drop it once Tyler agrees.
  - Preserve unrelated housekeeping artifacts until explicit cleanup.
  - Confirm `/private/tmp/apex-agent-review-fixes` has no uncommitted edits
    before relying on `97c5e50` as that branch's final state.
- `docs/superpowers/plans/2026-10-09-cleanup-pass.md` task 1 ("land the work
  in progress") is replaced by milestone 1 here. Its tasks 2 to 4 stay in
  the maintenance backlog.

## Implementation milestones

### 1. Consolidate and stabilize the foundation (v0.6)

- Preserve recoverable snapshots of both code copies (a branch or tagged
  commit each, not a stash). Use current `main` as the integration baseline
  and port the fixes from `feat/apex-agent` at `97c5e50` individually.
  Compare actual file contents, including untracked monitor files, and
  preserve newer adapter, client, and widget changes.
  - **(added) Known divergence as of 2026-10-09:**
    - Only on `main` (uncommitted): `codex_server.rs`, `events.rs`,
      `claude_session.rs`, `src/daemon/client.ts`,
      `tests/daemon-client.test.mjs`.
    - Only on the branch: `crates/apex-adapters/src/cli.rs` and
      `crates/apex-adapters/tests/adapters.rs`.
    - Changed on both sides: `monitor.rs`, `monitor_check.rs`,
      `monitor_commands.rs`, `apex-daemon/src/authority.rs`,
      `src/apexAgentModel.ts`, `tests/apex-agent.test.mjs`.
    - Already identical: `App.tsx`, `styles.css`, `Sidebar.tsx`,
      `ApexAgent.tsx`, `ApexAgentWidget.tsx`.
- Address the relevant findings in the
  [code review](../../code-review-2026-10-09.md): monitoring permissions
  (#1), tool-free checks (#2), descendant-process cancellation (#3), stale
  monitor filtering (#4), overlapping reconnects (#5), phone recovery (#6),
  Plan-mode editing ownership (#7), time-based checks (#8), durable IDs
  (#9), and source-save races (#12).
- Initially allow ApexAgent's own reasoning through HTTP text profiles or
  Claude's enforced tools-disabled path. Worker profiles retain their normal
  permissions.
- Isolate development and smoke-test data from the installed app. Add daemon
  capability negotiation so unsupported helpers produce an actionable error
  before delegation controls become available.
  - **(added)** `desktop/sidecar.mjs` currently reuses any daemon answering
    on the data folder's socket. Dev and smoke scripts must set their own
    `APEX_DECK_DATA_DIR`. Version differences are informational. Missing required capabilities produce an actionable feature error; compatible builds may connect.
- **(added)** Small fixes: the unused `Backend` import in
  `monitor_commands.rs`, and the `apex-host` test
  `a_replace_that_cannot_be_saved_...`, which relies on a read-only folder
  and so fails when tests run as root. Use a deterministic persistence-failure fixture that remains effective under root and verifies the original live and saved thread survive.
- **(added)** CI: run the Rust tests and daemon build with
  `--features remote`, as review recommendation 6 asks.

**Deliverable:** one coherent, tested ApexAgent implementation in reviewable local commits. Preserve the original checkout and both existing code copies during integration.

### 2. Make profiles and handoff decisions explicit (v0.6)

- Show **ApexAgent profile** as a dropdown on the setup screen, next to
  Assign. Today it is chosen silently and the only selector is hidden in
  Settings. Allow changing it afterward from a dropdown, not a read-only
  field, on desktop and phone.
- Preserve responsibility, sources, history, findings, and tasks when
  changing profiles; invalidate responses from checks using the old
  configuration.
- Distinguish the assistant's reasoning profile from the worker profiles
  inside threads. Display a deleted library entry as
  **"Saved profile — no longer in Agents."** Missing credentials are a
  separate, clearly worded error.
- Add immediate conversational handling for user requests, separate from
  periodic monitoring. Its structured output can answer, request
  clarification, or prepare a handoff.
- Resolve destinations against actual project threads and participant IDs.
  Ambiguous names, missing participants, and unavailable machines produce a
  clarification or actionable error.
- Background monitoring may create a proposed task card but cannot authorize
  its dispatch.
- **(added) Authority comes from your message, not the model.** The
  "clear request, dispatch directly" rule applies only when the task
  traces to a specific human `assistant_message` ID. The brief ApexAgent
  writes is shown in the parent thread directly beside your original words,
  so any drift is visible. Text inside evidence, files or bot replies can
  never mark a task as user-requested.

**Deliverable:** "Ask Null to fix this in the Cancellation thread" produces a
concrete, traceable assignment without a redundant confirmation.

### 3. Build durable task execution (v0.6)

- Store tasks on the owning host, independently of bounded chat history.
  Record the originating request, brief, evidence, review criteria, parent
  thread, worker roster, execution thread, attempts, status, result, and
  **(added)** token and cost usage per attempt.
- Create a **linked execution thread** for each task. Copy the selected
  thread's participant configuration and relevant context; post a linked
  assignment and result into the parent thread.
- Maintain a host-owned registry of execution threads. Desktop and phone
  merge these descriptors into their thread lists, so stale whole-session
  saves cannot erase newly created threads. Explicit deletion records a
  tombstone.
- Add run ownership through the complete worker batch, including bot-to-bot
  hops and approval requests. Cancel, failure, and completion affect only
  the matching attempt.
- Closing an assistant panel or switching threads detaches the UI without
  cancelling delegated work. Stop and Delete remain explicit actions.
- Use durable request IDs to deduplicate retries. After a daemon restart,
  reconcile dispatch records with saved messages; uncertain or interrupted
  runs require an explicit retry.
- Manual follow-up in an execution thread creates a tracked continuation and
  invalidates an earlier Ready-for-review result.
- **(added) v0.6 runs in place:** without worktrees, a task edits the
  project's own checkout, so one task runs at a time per project and the
  checkout-wide Deck editing lease remains held through human review. Other Deck writers queue until Accept and checks succeed or explicit Cancel; Request changes retains ownership. Reads continue. External editors are outside this lease, so Accept revalidates the review snapshot. Ready for review shows the files the
  task changed; Accept marks Done after the agreed checks pass. Request
  changes continues the same task.
- Show actual token/cost usage per attempt; unavailable usage is Unknown. Spend caps are deferred until adapters support a verified pause contract.
- **(added) Worker questions go to you.** A worker's approval request or
  question surfaces as **Needs you** on the task card. ApexAgent never
  answers approvals on your behalf.

**Deliverable (v0.6 release):** tasks survive client disconnects and
restarts without duplicate assignments or incorrect completion reports.

### 4. Add isolated worktrees and verified integration (v0.7)

- Capture the project's current files using a temporary Git index and
  private baseline commit, preserving its checkout, branch, and staged
  changes.
  - **(added) Secrets:** untracked files that are not ignored would be
    stored in Git objects. Skip likely secrets (`.env*`, `*.pem`, `*.key`,
    `id_*`, files over a size limit) by default, list what was skipped on
    the task card, and let the project add patterns. Keep baseline and
    result refs under a private namespace (`refs/apex/...`) so the app does not push them. The namespace is not a security boundary. Distinguish secret templates/examples, never silently omit tracked files, and list exclusions.
- Create a task-owned worktree anchored by private snapshot refs on the project's machine. Give
  workers distinct provider sessions and show their execution directory
  clearly.
  - Use only verified per-adapter trust mechanisms while preserving approval policies. Unsupported startup becomes Needs you; do not silently broaden global trust.
  - Install dependencies independently using locked commands by default. No writable shared node_modules symlink. Use separate Rust targets; download caches may be shared.
- Run independent tasks concurrently. Default limits are **two per project
  and four per host**.
- Capture an immutable result snapshot and show the task-only diff against
  its baseline, alongside reported checks and artifacts.
- **Accept** shows the exact diff and verification commands. Stage a
  three-way integration against the project's latest files and run the
  agreed checks before applying.
  - **(added) How to apply without touching your staging:** build the
    merged result in a scratch worktree from the latest files, performing a whole-tree three-way merge (base = task baseline, ours = current snapshot, theirs = immutable task result), including adds, deletes, renames, binaries, modes and symlinks. Run the checks there. Then
    write only the working files of the primary checkout. Never run
    `git apply --3way`, `git stash`, `checkout` or `reset` on the primary
    checkout, since each of those rewrites its index or files.
- Serialize integrations into the primary checkout. Revalidate its branch
  and file state before applying; preserve unrelated edits and existing
  staging.
- Conflicts or failed checks leave the result available for correction and
  prevent Done. Journal application steps so interrupted integration can be
  reconciled safely.
- Applied changes remain uncommitted. Retain task worktrees and result
  references until explicitly archived.
  - **(added) Disk cleanup:** show worktree disk use per project. Archiving
    a task removes its worktree and target folder but keeps its record and
    result ref. Offer to archive tasks that have been Done for 14 days.
- For non-Git folders, support observation and tool-free analysis; explain
  that isolated editing requires Git.

**Deliverable (v0.7 release):** two tasks can work in parallel, and
accepting either integrates only its changes into the latest project state.

## Interfaces and shared UI

Add host commands for:

- `monitor_profile_update`: guarded profile replacement (v0.6).
- `assistant_message`: durable user request with idempotency and optional
  explicit destination (v0.6).
- `assistant_tasks_list`: authoritative tasks and execution-thread
  descriptors (v0.6).
- `assistant_task_action`: clarify, approve, dismiss, cancel, retry, request
  changes, or accept a particular task revision (v0.6; accept gains the
  integration path in v0.7). Its `archive` action removes a task's worktree
  and keeps its record (v0.7); `reconcile` recovers an interrupted integration.

Add task-change events, optional task/run metadata on messages and recovery
snapshots, and a delegation capability in the daemon handshake (v0.6) plus
an isolation capability (v0.7): `assistant_delegation` and `assistant_isolation`.
Existing saved conversations load with
backward-compatible defaults.

Use shared task-state and recovery logic across desktop and phone. Cards show
**Proposed, Needs clarification, Queued, Running, Needs you, Ready for
review, Applying, Done, Failed, Cancelled, or Interrupted**, with links to
the parent and execution threads. Approval waits come from actual
outstanding requests. **(added)** Each card also shows its spend so far and,
in v0.7, its execution folder.

All commands validate project, host, assignment, task revision, and caller
access on the backend. Restricted devices cannot obtain project-wide
assistant data or expand their permissions through delegation.

## Validation and release criteria

- **Routing:** clear requests dispatch once; unclear destinations ask; sticky
  recipients and first-bot fallback work; new threads require a selected bot.
- **Autonomy:** proactive proposals remain unstarted until approved;
  instructions inside evidence cannot authorize work; **(added)** a task is
  "user-requested" only with a human message ID behind it.
- **Recovery:** disconnects, duplicate submissions, stale snapshots, daemon
  restarts, and simultaneous desktop/phone actions preserve one
  authoritative task history.
- **Ownership:** cancellation stops descendants and task-owned approvals
  while unrelated human turns continue; closing panels preserves execution.
- **Usage:** cost-only reports are retained; unavailable metrics render Unknown.
- **Isolation (v0.7):** parallel tasks use distinct worktrees, sessions and
  target folders; dirty starting files are captured without changing the
  original index; likely secrets are skipped and listed; new worktrees start
  without a trust prompt.
- **Integration (v0.7):** task-only changes survive intervening edits and
  earlier accepted tasks; staged files in the primary checkout are unchanged
  after accept; conflicts, failed verification, stale acceptance, and
  interrupted application never falsely produce Done.
- **UI:** exercise setup (including the profile dropdown), profile changes,
  clarification, proposal approval, progress, review, acceptance, and
  request-changes flows on desktop and a physical phone. Say which flows
  were checked in the real app and which only in the browser preview.
- Run the JavaScript suite, production build, freshly built Rust workspace
  tests with remote support, daemon end-to-end tests, and
  desktop/widget/multi-host smoke checks, each with its own
  `APEX_DECK_DATA_DIR`.

**Release acceptance:**

- **v0.6:** request a task by name → it runs in a linked thread → review on
  the phone → accept → verified Done → correct state after quitting and
  reopening both apps.
- **v0.7:** request two tasks → isolated execution → review on phone →
  accept results → verified application → correct state after reopening.

## Defaults and boundaries

- One coordinating ApexAgent assignment per project.
- You decide when work is accepted; worker claims alone never mark Done.
- Worker permissions and existing tool approvals remain in force.
- Parallel isolation and integration require Git.
- Automatic dependency chains, autonomous acceptance, and non-Git editing
  are later additions.
- Unrelated audit findings remain a separate maintenance backlog.

## Maintenance backlog, not in this plan (added)

- Code review findings #13, #15 and #16. Findings #10 (usage), #11 (phone session recovery), and #14 (private host data) are prerequisites in this implementation.
- Cleanup pass tasks 2 to 4: the flaky parallel Rust test, docs catch-up,
  and one bot editor in place of the three in `ChatPane.tsx`.
- A Permissions section in Settings listing every "Always allow" rule across
  threads, with remove.
