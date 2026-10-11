# ApexAgent workspace mockup review checklist

Use this checklist to review the Mac and phone mockups against the installed-app UX findings in `/tmp/null-apex-agent-ux-20261010/review.md`. These are design acceptance checks for the prototype; they do not claim runtime, backend, or device verification.

## Core model

- [ ] Keep one conversation surface and the existing floating assistant entry point.
- [ ] Ordinary greetings, questions, answers, and proposals remain chat messages. A task link is brief and opens the canonical record in Tasks.
- [ ] Tasks has its own destination and one list spanning personal work and delegated project work. Show owner/host and work type so different ledgers remain understandable.
- [ ] Task proposals may link to a draft record without implying approval or execution. Ongoing state, approvals, and results belong to that record.
- [ ] Worker history is available inside task details as history. The source conversation gets at most one concise task/result link; it does not become a second worker conversation.
- [ ] Existing conversations, task records, receipts, and logs remain preserved. A mockup Clear action hides chat history only and does not clear work.

## Findings to resolve

- [ ] **U01 — Unified Tasks:** From chat, open a task link and arrive at that same record in Tasks. Personal and delegated records are browsable in a coherent list. Empty states describe the current filter/scope, not all assistant work.
- [ ] **U02 — Brief-only worker history:** The depicted worker receives a bounded brief and selected references. Do not show copied parent transcript by default. Existing linked rooms remain reachable as historical evidence; do not imply silent deletion or migration.
- [ ] **U03 — Useful result:** Task row/detail exposes a short result, worker, host, completion time, and verification/availability state, plus a direct artifact action. If the artifact cannot open, show why. Raw logs/protocol markup are not the result summary.
- [ ] **U04 — Safe inspection:** Opening, closing, or browsing a task never retargets the ordinary composer. “Request changes” is an explicit task action with named task, worker, host, and scope; only that action depicts a new attempt.
- [ ] **U05 — Separate scopes:** A view filter controls which items are shown. “Send to” independently and persistently names the message destination. Switching filters or receiving an update does not change that destination. Project actions name their project; global actions say they apply to all projects.
- [ ] **U06 — Honest Sources:** Show project, host, selected sources, saved/unsaved state, last read, and coverage/partial or missing-source status. Explain bounded recent excerpts without suggesting full history. Exclude generated worker logs by default or label them clearly as optional. A save/check effect is stated plainly.
- [ ] **U07 — Legible actions:** Primary and disabled buttons have readable labels and visible focus states on Mac and phone. Especially inspect Save, sign-in, and browser handoff actions.
- [ ] **U08 — Navigation and focus:** Opening a task/detail/artifact visibly brings that destination forward; focus moves to its title. Back returns to the prior list position. Detail content is not appended below the chat fold or covered by the composer. Escape closes one layer and keyboard focus does not fall through to an underlying composer.

## Manual walkthrough

1. In chat, inspect a proposal and a completed result. Confirm each has at most one concise link and that neither starts execution by being opened.
2. Open Tasks. Find personal and delegated work, filter by scope, and open a result. Confirm the owner and host remain visible and Back restores the previous list position.
3. Open and close a review task, change the visible project filter, then type a normal question. Confirm the composer still displays its original explicit destination and the question remains ordinary chat.
4. Invoke Request changes from the task itself. Confirm the task, worker, host, scope, and continuation intent are explicit before the mock action.
5. Inspect Sources with a selected human chat and a worker log. Confirm the default selection, saved state, read time, and partial/missing coverage are understandable.
6. At narrow phone width and Mac width, inspect the primary actions, focus indicators, back navigation, and composer overlap. Use Tab, Enter, and Escape where the prototype supports keyboard interaction.
7. Use Clear, if present, and confirm its copy says it hides conversation history while Tasks and unresolved work remain accessible.

## Evidence boundary

These checks review visual structure and simulated navigation only. They do not verify task aggregation, authorization, delivery receipts, worker prompts, artifact access on an owning host, persistence, or a real iPhone build. Keep proposed backend behavior annotated as a proposal and do not present a simulated control as evidence that it executes.
