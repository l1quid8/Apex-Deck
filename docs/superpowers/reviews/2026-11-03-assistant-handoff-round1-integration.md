# Conversational handoff v11.1 — Round 1 integration review

Review target: `feat/assistant-handoff-round1`, baseline `47f77248ad90b0f77e206b6ae6e1b04a8ce10bd0` through product integration `626cd884`. Jigga's plan approval is separate from implementation approval; integration review is pending.

## Scope and behavior

Implements Round 1 Tasks 1, 2, 3, 4a, 6 and 7 from the [approved plan](../plans/2026-11-03-conversational-handoff-v11-1.md), following the [coordination contract](../plans/2026-11-03-conversational-handoff-round1-coordination.md).

- Alfred privately saves his normalized completion and frozen delegation descriptors on the source event before admitting children. Task admission persists the reference-only announcement gate in the first task save. Publication, personal effects and permanent publication receipts share one personal save; only the matching durable publication releases the gate. Recovery consumes the saved reply instead of invoking the model again, including a crash before the first child or midway through a batch.
- Routing drafts preserve the original request and ordered team. Live project/thread/new-thread/worker options come from the host, and structured selections bind the assistant, draft revision, missing slot and request id. Current grants, profiles, project identity, spend limits and authority remain checked at admission and launch. Frozen Ask authority cannot become Full merely because settings changed during recovery.
- When outside reports are present, a fresh verified human work request can still proceed through explicit routing. The host retains the exact human request as the draft brief and clears every model-selected project, destination, worker, mode and action payload. Project, thread and workers must be selected before admission. This preserves report taint without leaving subsequent conversation unable to hand off work.
- New-thread admission uses saved worker profiles in the selected order, creates one execution room across replay, preserves the frozen coordinator identity/revision and reuses watchdog supervision. It does not enable paid monitor checks.
- Stop uses the existing task cancellation/settlement path. A timeout remains “stopping”; it does not claim the worker stopped. Continue requires the live question, run, room and task binding. Host whole-message controls share 57 fixtures with the client; unclear/negated/quoted replies do not stop or resume work. Model-proposed controls require a stored explicit confirmation. Continue cannot approve a proposed job.
- Actual lead-worker events supply optional checklist progress and bounded lifecycle history. Old attempts and peers cannot overwrite the current lead's checklist; totals are not added together. Missing totals remain missing, cancelled items remain cancelled, and ready-for-review is distinct from accepted/done.
- The saved handoff sentence carries a compact progress pill and quiet hover/focus Stop. The popover only inspects reported state; it cannot branch, rewind or invent file counts. Escape dismisses it and restores focus. Clarifications support ordered multi-agent selection, lead preview and explicit Start. Offline/older-host states withhold unsupported controls. Round 1 leaves the composer auxiliary line empty.
- Result synthesis is tool-free and consumes saved outcomes, with a bounded factual fallback. Report content remains tagged as outside evidence at every age. Before publishing after a model await, the host rechecks the task, lineage, deletion state and current settled run under the personal lock. Purge/delete/retry cannot resurrect obsolete report content; actual model cost is still recorded once. Result messages retain their original source-event/task attribution.

Round 2 handover, follow-up delivery, queue/composer mode controls and any claim of interruption-free steering are excluded. There is no release merge, installer or installation in this integration.

## Integration corrections

The initial slice reports described components more completely than their live wiring supported. Integration replaced placeholder Stop/Retry callbacks and fabricated control outcomes with actual host operations, added command registrations in the desktop provenance broker and daemon authority classifier, made gated admission atomic, and applied private-view filtering to the real response/event paths.

Further review corrected unobserved/offline “working” labels, raw worker ids, duplicate/missing lifecycle projection, failed-start versus failed-run wording, saved-completion scheduling priority, report taint/cleanup races and popover focus/state labels. Regressions were observed failing before their respective fixes.

## Storage, privacy and authority

- `PersonalEvent.saved_reply` is private protected-store state. `PersonalAssistantView`/`PersonalEventView` omit it from list/get/create/react, mutation responses and Changed notifications. Project task records contain only announcement references and the execution metadata needed for admission, never the private reply envelope, memory proposals, helper assignments or personal costs.
- Optional fields use serde defaults for existing records. Existing tasks without a gate retain their prior behavior; new personal delegations are born held. Durable announcement receipts survive transcript pruning. Execution-profile snapshots and frozen preparation revision support deterministic new-thread replay.
- Lock ordering for cross-store publication/control is personal → task ledger. Gate enforcement is in the task-ledger claim, and claim rechecks the source cancellation before execution setup. No task lock is held across a model/provider await.
- `personal_handoff_select` and `personal_handoff_control` require verified UI provenance, payload-bound request ids and Full host authority. The broker's protected verb list, command key, daemon classifier, capability lists and client routing agree. Read-only options/question commands remain scoped to their owning assistant.
- `assistant_conversation_handoff_v1` gates the client controls; per-task available actions reflect host state. The renderer's classifier and labels are presentation helpers, not execution authority.

## Verification

Final verification (no product edits after these checks):

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | Exit 0 on the integrated sources. |
| `npm test` | 3,329 passed, 0 failed, 3 skipped. Final affected checks below cover subsequent integration corrections. |
| `node --experimental-strip-types --test tests/assistant-handoff-progress.test.mjs tests/assistant-handoff-replies.test.mjs tests/assistant-conversation.test.mjs tests/apex-agent-all-component.test.mjs tests/personal-assistants.test.mjs tests/desktop-provenance.test.mjs` | 161 passed, 0 failed. |
| `node --experimental-strip-types --test tests/assistant-conversation-browser.test.mjs` | 3 passed, 0 failed, including final focus-return and cancelled/no-total detail checks. |
| `cargo test -p apex-host --lib -- --test-threads=8` | 1,112 passed, 0 failed, 17 ignored. |
| `cargo test -p apex-provenance handoff_controls_bind_request_and_exact_scope` | The selected payload-bound handoff regression passed (1 test). |
| `cargo build -p apex-daemon --features test-support --bin apex-daemon-fixture` | Exit 0; built from the integrated source, for isolated tests only. |
| `TMPDIR=/tmp APEX_DAEMON_BIN="$PWD/target/debug/apex-daemon-fixture" node --experimental-strip-types --test tests/e2e/assistant-delegation.e2e.mjs` | 8 passed, 0 failed, 0 skipped. Includes two owners/three projects, one/two-host recovery and the new conversational scenario. |
| `cargo test -p apex-host-production-check` | 6 passed, 0 failed, feature-off production-storage/provenance checks. The Linux-only target has 0 tests on this Mac. |
| `git diff --cached --check` | Passed for the scoped product changes. |

Retained regressions cover:

- Saved reply recovery before any child, partial admission, publication-before-release, pruning, source Stop while held and no private payload in on-disk task records/outgoing views.
- New-thread replay, atomic gate refusal before room setup, profile revocation, frozen monitor revision, Ask-to-Full changes, budgets and unchanged paid-check policy.
- Bound confirmations, whole-message classification, multiple-task ambiguity, actual paused worker questions, stale controls, cancellation settlement and unavailable Retry until settled Stop.
- Lead/attempt progress, replay deduplication, cancelled lists, unknown totals and ready-for-review.
- Browser interaction for slim pills, hover/focus Stop without layout movement, view-only future steps, Escape/outside dismissal, focus return, team order/filter/keyboard selection, paused answers, no-total/stopped details and fallback states.
- Real fixture-daemon IPC with disposable local provider/CLI endpoints: announcement visible before the worker starts; one newly created room/task/attempt; unclear replies keep the actual worker waiting; explicit Continue reaches its question; Stop settles; cold restart/request replay does not run the worker again. This exercises the daemon and worker protocol, not an installed production app.
- Notify-gated report-await races: deletion, purge and a new attempt suppress stale summaries, while unchanged tasks publish; costs and event settlement remain durable.

A fresh independent static review found no additional high-severity blocker after the sanitized-routing correction. This was a code review, not Jigga's integration approval or native UI acceptance. Compiler dead-code/unused-variable warnings remain, and the browser run prints an existing React list-key warning in `ApexAgentMessageActions`; neither was reported as a failed test.

## Acceptance limits and reviewer focus

No installed-app acceptance is claimed. The running app was the installed trusted UI at `/Library/Application Support/Apex Deck Provenance/TrustedUI/Apex Deck.app`; no development Electron window from this branch was running. It was not replaced or restarted. The UI was exercised through the repository's Electron browser harness, and the backend through a freshly built isolated fixture daemon.

Recovery tests reconstruct real durable checkpoints and prove no model replay. They do not inject an OS crash at every instruction, and there is no deterministic two-thread test for every Stop-versus-release lock interleaving. Real wall-clock 20-minute watchdog acceptance, installed app/helper provenance and phone UI interaction remain acceptance work before release. Rust tests marked ignored by the repository stay reported separately from passing tests.

Jigga should prioritize the durable save/admit/publish/release ordering, private outbound surfaces, current-authority checks after recovery, task/question/confirmation identity, report lifecycle cleanup, and the distinction between observed worker progress and inferred scheduling state. The complete baseline-to-integration diff includes the earlier UI/control commits, not only the final integration commit.

## Commit and final check read-back

Product commit chain:

- `13a271d6`: approved plan/reference and coordination.
- `9ed82979`: initial browser fixtures.
- `444de60d`: slim UI/view model and shared classifier mirror.
- `340a2e42`: initial host drafts/controls and durable gate scaffolding.
- `626cd884`: completed host/UI integration, atomic admission/recovery, real controls, new threads, progress, provenance and regressions described above.

Review the final product with `git diff 47f77248..626cd884` and `git show --stat 626cd884`. This review document and the coordination status update are a following documentation-only commit. TypeScript and the final host/daemon/production checks all exited 0 before the product commit; no product changes followed verification.

Git read-back confirmed `feat/assistant-handoff-round1` at `626cd884`. Original unrelated browser-work, phone-history, generated build and older mockup changes are excluded and preserved in the shared checkout. Nothing was merged, installed or packaged. Send this package to Jigga for implementation review, with the installed-app acceptance limit retained.
