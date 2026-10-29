# Goal and loop implementation verification

Branch: `feat/goal-loop`. UI reference: `mockups/goal-mode-v4.html`.

The previous implementation supplied isolated runner helpers but did not route starts or dispatch work. The changes now connect desktop and phone slash commands and composer start modes to protected host mutations, and a host-owned worker actually runs captured participants, reads final reports, schedules finish-plus-interval loops, and enforces bounded continuation.

## Delivered

- Shared composer drawer, mutually exclusive start modes, interval/limit editing, worker selection, optional read-only checker, configured argv checks, Pause/Resume, inline End confirmation, clear/dismiss and visible changes review on desktop and phone.
- Host-owned protected persistence, revision-checked and idempotent actions, durable invocation reservation, unknown-cost accounting, checkpoints, folded automatic replies, unique terminal summaries and attributed file review.
- Human text/voice messages reserve priority and yield automation; Stop pauses during work/countdown. Pending approvals are retained as needs and re-presented on Resume when the original provider request was retired. End, configuration changes, deletion, import replacement and restart invalidate old attempts.
- Command checks reuse room approval rules, canonical cwd and owned process groups, with bounded output/time and startup recovery of orphan check processes. Stale checks, receipts, reports, approval events and cancellation callbacks cannot operate on replacement work.
- Starts/actions require existing desktop provenance or paired-phone admission. The earlier runner provenance exemption was removed.
- The unrelated tool-inventory change was removed from this branch's final state and preserved separately on `fix/passive-tool-inventory-review`, commit `9eca46b`.

## Automated evidence

- `npx tsc --noEmit`: passed.
- `npm test`: 2,655 passed, 3 skipped, zero failures. An additional routing/configuration regression passed afterward (14 focused runner client tests).
- `TMPDIR=/tmp cargo test`: passed, 1,637 tests across 38 reported groups; 14 ignored. The final host runner selection passed 32 tests; the storage/API integration selection passed 6.
- `cargo test -p apex-host-production-check`, invoked separately: 6 passed.
- `TMPDIR=/tmp npm run test:e2e`: 23 passed, 3 failed. All four runner scenarios passed, including a real one-minute interval firing twice with peak concurrency 1, human interruption continuing without Resume, approval cancellation, configuration/replay/limit regressions and owned-check cleanup after SIGKILL/restart.
- The same three failing assistant-delegation cases reproduce against a fixture daemon built from pre-feature commit `dd7d513`. Baseline command: `TMPDIR=/tmp APEX_DAEMON_BIN=/tmp/goal-loop-baseline-fixture node --experimental-strip-types --test --test-name-pattern='two assistant owners coordinate|cross-project proposals route' tests/e2e/assistant-delegation.e2e.mjs`. Failures: timeout waiting for an attributable once-only result; and both one-/two-host cross-project cases observing `run\nrun\n` instead of `run\n`. They remain release blockers and were not masked or changed.
- An isolated check test initially used the temporary root itself as its process namespace, violating the owned-process registry's private-parent rule with `TMPDIR=/tmp`. The fixture now uses a dedicated `processes` child, matching production; focused and full reruns passed.
- Baseline delegation testing produced an untracked `result.txt` containing `project 1 result`; it was moved into the task's ignored evidence folder, preserving it while restoring the shared checkout.

Detailed logs and the independent review are retained under `.superpowers/sdd/2026-10-29-goal-loop/`. No pre-existing untracked plans or mockups were staged.

## Native acceptance and release gate

The development app was launched with the repository-required command and data directory. The installed daemon hosting the human conversation was preserved. Desktop CUA exposed only the outer Electron window, and screenshot retrieval timed out; no desktop visual sign-off is claimed.

`npm run iphone:sync` and the simulator-targeted Xcode build passed. The final phone renderer was installed on the Deck-owned simulator, and the phone connected to an isolated temporary fixture daemon, never the person's real daemon. Native goal/loop controls, keyboard geometry, screenshots, real CLI/API provider runs and notification delivery still need final acceptance. Fixture and source evidence do not establish installed production behavior.

No production build, merge, push or GitHub release was performed. `main` was not changed. The implementation is handed back for review with the remaining native/release gate explicit.
