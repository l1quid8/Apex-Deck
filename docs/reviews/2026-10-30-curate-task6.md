# `/curate` Task 6 handoff

Task 6 is implemented on `feat/curate-task6`, based directly on `e172d6b9`. This covers the composer, queue, types, backend commands and browser preview. It does not implement Task 7's ChatPane dispatch or notes. No Rust files, dependencies, release artifacts or unrelated files changed.

## Behavior

- `/curate` and `/curate undo` parse, including case-insensitive `undo`; extra arguments are rejected. Both menu entries follow `/compact` and use the mockup's wording. Talk-only menus exclude both commands.
- `wholeRoom` identifies `compact`, `curate` and `curate_undo`. Both new jobs wait for every active bot, block later turns, release reservations when their command resolves, and retain failed jobs for explicit retry.
- `Backend.roomCurate` and `Backend.roomCurateUndo` send `room_curate` and `room_curate_undo` with `{ id }`. Types match the Rust curation records, undo counts and flattened reply status. Both methods and raw commands obey disconnected-host write guards and chat move/history fences.
- Recovery suppresses `curations_changed` events already represented by the snapshot and replays newer events.
- The preview deterministically hides the oldest half of eligible messages after a 400 ms delay. Its reason explicitly labels the picks as preview behavior. It protects the newest 20 messages, compacted history, pinned responses, long Human messages and messages already hidden. It preserves originals, emits working/curation/idle events, supports Stop, persists records across reopen/import, reports sealed undo counts, and discards records past fork/rewind/revert/clear boundaries. The preview is not evidence of model curation quality.

## Original Task 6 verification

- Baseline: `TMPDIR=/tmp npm test` — 2,806 passed, 3 skipped, 0 failed.
- Initial failing run: the full suite failed exactly 16 new or updated assertions for missing Task 6 behavior. Focused run: 201 passed, 16 failed.
- Preview lifecycle regressions: fork, rewind, revert and clear each failed before their fixes.
- Final: `TMPDIR=/tmp npm test` — 2,824 passed, 3 skipped, 0 failed.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.

The scoped diff was reviewed by the author against Task 6 and its downstream Task 7 interfaces. Fresh named review remains Jigga's handoff gate; the plan forbids private helper agents. No native app or live-provider acceptance testing was performed, and the Rust suite was not rerun for this TypeScript-only change.

## Implementation decisions

1. Used a task branch in the shared checkout, as AGENTS.md requires, preserving all pre-existing untracked work. No separate worktree or private helper was created.
2. Included optional `unchecked` on `CurateReply` now, matching Task 5's existing wire response. Task 7 can consume it without another type change; the preview reports zero because it examines every eligible message.
3. Preserved curation records on preview import/reopen and reset them across history boundaries. This extends the preview plumbing so Task 7 cannot display stale notes; it changes no production Rust behavior.

No deferred minor findings. No merge, push, install or app launch was performed. Task 7 still needs to connect these commands to ChatPane and render the notes; Task 8 must verify actual providers and the journal folder in the native app.

## Task 6 review fixes

The follow-up to Jigga's review of `e172d6b9..8684313a` stays on `feat/curate-task6`:

- `ParticipantQueues.drain()` takes a snapshot of item IDs, then looks each item up immediately before considering dispatch. Items removed during an awaited job are skipped; edits use the latest text, kind and recipients.
- A failed whole-room job ends the current pass. The retained failed command remains a barrier to later queued messages until explicit retry, including when its dispatch emits an idle callback before rejecting. Ordinary participant failures still let unrelated bots continue.
- Preview `roomCurateUndo` emits `curations_changed` only when it restores messages. Empty history, already-undone records and records sealed by compaction return their counts without emitting a change; a successful undo still emits the updated records.

Regression proof: six queue cases (removed, edited and queued-before-failure, each for `compact` and `curate`) and three preview no-change cases failed before their fixes. The focused run changed from **35 passed, 9 failed** to **44 passed, 0 failed**. The edit cases also verify recipient changes; the failure cases verify Resume does not retry the command and explicit Retry releases the waiting message.

Verification after the fixes:

- `TMPDIR=/tmp npm test` — **2,833 passed, 3 skipped, 0 failed**. The run emitted Node's `localStorage` experimental warning; no test failed.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.

Named re-check by Jigga remains the review gate before Task 7; no private helper was created. Rust and native-app/provider checks were not rerun for this TypeScript-only follow-up. No merge, push, install or app launch was performed.
