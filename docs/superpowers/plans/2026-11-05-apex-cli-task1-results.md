# Apex CLI Task 1 implementation and review

Branch: `feat/apex-terminal-cli`. The user asked Null to take over Cast's interrupted Task 1 and obtain assistance. This report covers authoritative responder state only; the terminal client in Tasks 2–7 is not implemented or accepted.

## Delivered

- One read-only `Room::untagged_responders()` projection shared with untagged routing. Mention, Everyone, RoundRobin, membership and named-only eligibility retain existing behavior.
- Snapshot projection is recomputed from the live roster on snapshot creation and after restoration. Old snapshots without the field still deserialize. Empty effective selections serialize as `[]`.
- `room_state` exposes `untagged_responders` at the top level and in its snapshot from the same checkpoint, without taking the async room lock. TypeScript fields are optional for older-daemon compatibility.
- Work-room roster/settings mutations commit a complete snapshot before publishing their existing events. Full checkpoint completion emits additive `state_changed` invalidation; CLI consumers must refresh authoritative state when receiving it. Existing desktop/phone handlers have not been changed to consume this event.
- Legacy human-message admission commits its snapshot and publishes the message under one room lock, preventing running replies from overtaking admission. Commit failure restores transcript, sticky targets, origin sequencing and reply correlation. Already-committed messages are published without another acceptance save; journal-refresh errors cannot discard an accepted batch.
- Updated two assistant-conversation snapshot test fixtures for the additive field. Preserved unrelated dirty files, mockups and real application data.

## Verification

- Reproduced Cast's compiler error before repair.
- Observed the host regression fail with a removed member still selected, then pass after authoritative checkpoint updates.
- Observed the admission-failure regression fail before rollback, then pass in the full core suite.
- `cargo test -p apex-core`: passed, 265 tests across unit/integration targets, zero failures.
- `npx tsc --noEmit`: passed.
- `git diff --check`: passed.
- Final `cargo test -p apex-host --lib`: passed, 1,125 passed, zero failures, 17 ignored; 98.03 seconds. Ignored tests were not executed.
- Independent read-only review found the stale-membership, event-ordering, concurrent-publication and failed-admission issues; final review reported no remaining blockers after fixes. Review is separate from executable test evidence.

No merge, installation, production build, real-thread mutation, live CLI acceptance, or release was performed.

Task 1 is complete and reviewed. Task 2 (connected transport, replay and delivery) is the next bounded implementation task.
