# ApexAgent V3 implementation

Approved by Tyler from the interactive V3 mockup on 2026-10-09.
Design source: `/Users/tylercaldwell/.codex/visualizations/2026/10/09/01a12141-6d3c-7613-a80d-ec5edd852147/apexagent-v3.html`.
Baseline: ba97376. Work in the existing managed delegation worktree.

## Global constraints

- Use real host-owned tasks and existing request deduplication, ownership, revision and cancellation guards. Do not copy simulated timers or fictional data from the mockup.
- Keep shared multi-model chats available beside the assistant dock. Preserve the separately controlled floating avatar, green while expanded, with click to collapse.
- Human requests authorize delegation; assistant suggestions need approval. Preserve original request, assistant brief, history, worker, destination, mode and reported spend.
- Honor named workers. Show routing clarification when a name is missing or incompatible. Never silently substitute another worker or treat a model-selected ID as human authorization.
- Only detail review can accept a current task result. A revised result invalidates earlier review acknowledgement. Cards and quick views only open details.
- Task questions and approvals must reach the human. Closing the panel does not stop tasks. Stop remains stopped. Unknown cost stays unknown.
- All implementation is local until checks/review finish. Helpers own disjoint files; the controller integrates shared contracts. Do not spawn child helpers or commit other workers' files.

### Task 1: Assistant interior and task workspace

Own `src/ApexAgent.tsx`, `src/ApexAgentTasks.tsx`, `src/apex-agent-panel.css`, `src/assistant-tasks.css`, new interior-only components/models, and `tests/assistant-tasks-component.test.mjs`. Do not edit App, Widget, shared assistantTaskModel, Rust, or shell CSS.

Use the approved mockup as layout reference. Replace the vertically split transcript/form/task stack with Chat / Tasks / Activity tabs, Settings via header button, a Thinking with profile dropdown in the header, compact Needs you queue (max 3 with View all), grouped task overview, and a focused task-detail view. Task details show actual result/diff/checks, collapsible original request/brief/history, linked chats, spend and mode. Pin the current decision actions below the scroll area. Do not show Accept outside detail; require current task revision to have been opened for review, clear acknowledgement on revision changes, and retain human review criteria checks.

Keep one composer across Chat and Tasks. Use task context for inline answers, revisions and notes, with New message to exit context. Use real backend.roomAnswer(executionThreadId, request, answers) and backend.roomDecide(executionThreadId, request, approve, false) for questions/approvals, preserving every question in a multi-question request and options. Require explicit human answer or approval. Existing malformed/legacy wait metadata gets an Open worker chat fallback. Verify task owner and current request; reload after answers. Requests use existing assistant_message receipts; uncertain retries retain exact original payload.

The controller extends task mode to `read_only`, adds optional task resultData fields `spendLimitMicros`, `budgetPaused`, `taskHistory` ({atMs,kind,text}), and action payload `spendLimitMicros?: number|null`. Actions include `note`, `set_budget`, `resume_budget`. Display cap controls only in details and composer advanced controls, clearly state enforcement uses reported provider cost. Resume from budget pause is explicit and keeps task ID/history. Normal Stop uses cancel. Read-only results use Mark reviewed; in-project results use Accept and mark done; separate-copy results use Accept changes.

Composer destination/worker/mode/checks remain optional advanced controls, not mandatory syntax. Render saved profile missing state. Continue existing setup/source editing, monitor ownership guards, findings controls and activity. Task Activity can use durable attempt/history data plus monitor activity. Connect task view through optional ApexAgentTasks props (`view`, `messages`, `focused`, and view-change callback), coordinating signatures with the controller. Preserve default standalone props for phone reuse (inspect usages).

Validate with meaningful component tests for detail-only acceptance, revision invalidation, request retry ownership, inline multi-question answer, and task-context sends. Run scoped tests and TypeScript check once shared contracts arrive. Leave no simulated behavior. Report file: `.superpowers/sdd/2026-10-09-apexagent-v3/task-1-report.md`.

### Task 2: Resizable dock and focused shell

Own `src/App.tsx`, `src/ApexAgentWidget.tsx`, `src/apex-agent-widget.css`, new `src/apex-agent-dock.css`/dock model as needed, and shell-specific tests plus widget smoke harness if necessary. Do not edit assistant interior files or Rust.

Move the assistant panel into a right-hand resizable dock in the app body, default width 480px, with Expand / Return to dock control and focused width around 700px (responsive). The open dock reduces chat layout width and does not cover the chat. Use pointer and keyboard resizing with a labelled separator; clamp for viewport and persist user width. At narrow viewport use the available width and keep actions accessible. Existing browser-pane layout relies on DOM observation; inspect those integration points.

Keep floating avatar independently visible/customizable and green while panel open, and click to close the dock. Avoid rendering a second dialog/header around the interior: add a widget `panelMode` or equivalent to keep its overlays/avatar but let App render panel in dock. Make header project selection available without losing selection behavior. Interior ApexAgent will accept `focused`, `onToggleFocus`, and a project selector ReactNode prop; coordinate with controller/UI helper. Selecting a linked chat should show the chat while leaving dock open, returning from focused mode. Escape closes with correct focus return. Closing/opening does not destroy host tasks. Maintain unavailable-host instructions, project switching, drag/drop source, quiet hours and appearance.

Keep compatibility for standalone widget users/tests by defaulting to existing floating panel. Add dock mode behavior tests and meaningful smoke coverage for open/resize/expand/shared chat/avatar/close. Run scoped checks; report file `.superpowers/sdd/2026-10-09-apexagent-v3/task-2-report.md`.

### Task 3: Natural requests and explicit routing

Own only `crates/apex-host/src/assistant_conversation.rs` and new routing-only test fixtures inside that module. Do not edit assistant_service/tasks/host/shared TS model.

Current authorize requires a saved-chat name even for clear human imperatives. Improve natural routing within the human-authorized current project: resolve named chat when unique; otherwise select the only eligible saved chat when exactly one remains. Multiple candidates require clarification. Preserve most-recently addressed eligible worker fallback then first eligible. Never use model returned thread IDs/workers for authority.

Extend ConversationRequest with a serde-default saved worker catalogue (controller passes library workers via assistant_service); accept `workerProfiles` from the trusted client as available candidates only, not automatic work authorization. A clear human imperative that uniquely names an available worker can create a new task chat without special @ syntax when no compatible saved chat was explicitly selected; honor named worker instead of substituting. If named chat and named worker conflict, return clarification containing the named worker and chat and allow explicit destination selection to resolve it. An explicit selected worker may override original natural names only after actual human destination choice. Reject unknown or ambiguous worker names. Add help/clean up/check prefixes for real human requests while preserving non-request discussion as Answer/Proposal/Clarify.

Add tests: one eligible chat plain request; multiple chats clarify; unique named worker new chat; named worker incompatible saved chat clarifies; duplicate/unknown name; sticky eligible fallback; model IDs never authorize; evidence does not authorize. Update necessary local request fixtures for new default field. Report file `.superpowers/sdd/2026-10-09-apexagent-v3/task-3-report.md`.

### Task 4: Integration, real read-only work, budgets and history

Controller owns shared `src/assistantTaskModel.ts`, Rust `assistant_service.rs`, `assistant_tasks.rs`, `host.rs`, daemon authority/protocol changes if needed, docs, and integration/e2e tests. Add real read-only task execution with enforced read access and no editing checkout lease; skip write/apply checks for review-only acceptance. Preserve Git safety for editing modes. Pass actual available worker profiles to routing, bound and stored with the request for safe retry.

Add durable per-task spend limit from request/action, pause on reported estimated cost reaching cap, retain current task/edits/lease/history, and explicit resume only after limit permits it. Do not call the pause Cancelled or silently retry after reconnect. If provider reports no cost show Unknown and enforcement limitation. Scope asynchronous pause/completion to current attempt and do not revive Cancelled. Record user notes/revision history durably and supply queued notes to worker continuations. Use existing question/approval room APIs from UI, preserving ownership.

Review all helper diffs against approved V3 and existing daemon/revision protections. Run npm tests/build, Rust remote-feature tests, real-daemon e2e and desktop/widget smoke as appropriate. Exercise installed native panel with isolated data before claiming native UX works. Integrate the reviewed result locally and package/install only after passing verification, preserving user data. Record exact validation and unresolved limits in docs.
