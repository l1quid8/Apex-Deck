# Task Manager Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Ship the agreed task manager in mockups/assistant-task-manager-v2.html on desktop and iPhone, including exact permanent deletion.
**Architecture:** Reuse the workspace task feed and existing project task detail implementation so revision checks, questions, approvals and recovery remain authoritative. Extend host lifecycle with exact-ID purge and a project-owned path for older tasks. Share list and deletion orchestration between desktop and phone.
**Tech Stack:** React/TypeScript, Rust host, node:test.
**Spec:** mockups/assistant-task-manager-v2.html and the human's build request.

## Global Constraints
- Preserve unrelated checkout work; task branch feat/assistant-task-manager.
- Permanent deletion preserves worker conversations, accepted changes, notebook content and worktrees; retain source events and replay/ownership receipts.
- Refuse running/unsettled tasks and pending integration; do not purge unconfirmed IDs.
- Retain every existing project task action, revision-specific inspection and review checks, multiple questions and written answers.
- Dismissed tasks must remain reachable for explicit cleanup.
- Do not operate on the user's real tasks for testing.
- Run tests and npx tsc --noEmit. No release build, merge or installation requested.

## Review Focus
- Same task IDs on different owners must never mutate the wrong task.
- Revisions changing after delete confirmation must fail safely.
- Offline and limited phone connections must not expose unauthorized mutations.
- Hidden dismissed/deleted tasks must be explicitly counted in cleanup.
- Pending integration and outstanding receipts must block purge.

### Task 1: Host permanent deletion
Files: personal_task_lifecycle.rs, assistant_tasks.rs, command.rs and Rust tests.
- [x] Add failing tests for exact personal/delegated purge, older project tasks, stale revisions, unsettled receipts, pending integration, retained conversations/worktrees and replay receipts.
- [x] Add personal action `purge` with `tasks: TaskRef[]` and expectedRevision. TaskRef uses source personal/delegated, taskId and delegated revision. It permanently deletes exactly the confirmed settled tasks, whether soft-deleted or not.
- [x] Add command `project_task_lifecycle` with taskId, revision, owner, action `purge` for linked and unlinked tasks. Preserve replay tombstones without requiring assistant lineage.
- [x] Run covering Rust tests and report evidence/API.

### Task 2: Shared desktop manager and mutation orchestration
Files: WorkspaceTasksScreen.tsx, workspaceTasks.ts, workspace-tasks.css, WorkspaceTaskDetails.tsx, PersonalWorkspaceTaskDetail.tsx, App.tsx; new shared deletion helper if needed; JS tests.
- [x] Add failing model/UI tests for grouping, compact list, deletion selection/confirmation, dismissed cleanup, stale/offline refusal.
- [x] Implement agreed compact groups Needs you/In progress/Scheduled/Done (collapsed default), compact search/filter/select, accurate timestamps and deletion single/multi/clear with Cancel focused.
- [x] Shared helper `purgeWorkspaceTasks(rows, backendForRow)` fetches current personal revision and verifies task identity/revision before exact purge; project command uses owner/revision. Never purge unrelated hidden rows. Export for phone.
- [x] Keep complete project details via existing ApexAgentTasks. Improve narrow/personal detail result hierarchy without weakening existing actions.
- [x] Wire desktop and popout where applicable. Run covering JS tests and TypeScript.

### Task 3: iPhone integration
Files: src/phone/PhoneApp.tsx, phone CSS, new PhoneTasks component and tests.
- [x] Add failing phone tests for Tasks navigation, Full access/offline restrictions and shared rows.
- [x] Add Tasks tab and attention dot; collect personal and project sources using existing phone connections/registry. Reuse WorkspaceTasks/WorkspaceTaskDetails and shared purge helper from Task 2. Preserve exact host ownership and Full access gates.
- [x] Add mobile detail/action styling, selection and deletion accessible by touch. Preserve project question/review/recovery behavior by reusing full detail component.
- [x] Run phone tests and TypeScript; report any native-verification limits.

### Task 4: Integrated validation and review
- [x] Run npm test, npx tsc --noEmit and Rust covering tests.
- [x] Review full diff for deletion preservation, revision gates, project action reachability, phone access gates and scope.
- [x] Fix material findings and rerun affected checks. Report built behavior, evidence and limitations without claiming installation.


## Final validation (2026-11-02)
- JavaScript full suite: 3,203 passed, 3 skipped, 0 failed; latest added regressions also passed separately.
- Host full suite with four test threads: 1,008 passed, 14 ignored, 0 failed.
- Daemon authority: 7 passed. Provenance library: 70 passed; phone admission: 8 passed.
- TypeScript: `npx tsc --noEmit` passed; `git diff --check` passed.
- Real component fixtures verified 332px desktop and 390px phone widths, exact deletion scopes, confirmation focus, dismissed cleanup, reminders and external deletion retirement.
- Independent review findings addressed: stable phone backend identity; reject concurrent revision carry during batch purge; linked integration recovery/archive, worker notes and budget continuation; notebook and popout callbacks; proposal-only worker quick add; optimistic row retirement.
- Tests used temporary fixtures. No real tasks were deleted. No merge, installer or installed-device acceptance was performed.
- Shared checkout was switched externally from feat/assistant-task-manager to fix/ucu-targeted-click-focus during validation; both pointed to the same base commit 2bcfef0ac4f96a58d41fce8a1855f5df0408e581. Task changes remain uncommitted alongside unrelated work.
