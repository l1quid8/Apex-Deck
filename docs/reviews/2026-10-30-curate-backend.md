# `/curate` backend handoff

Initial scope: Tasks 1–5 of `docs/superpowers/plans/2026-10-30-curate.md`, on `feat/curate` from `55a73439` through `8d409968`. The initial implementation changed no frontend source or frontend tests. Review follow-up is below. Task 6 remains Ds4's work; Tasks 7–9 remain separate.

## Implemented

- Shared, persisted curation ranges; original transcript text stays intact. Model views get gap markers, and hidden messages also stay out of attachment/media `unseen` inputs.
- A bounded, tool-free curator turn using the existing talk-only participant builder. Newest 20 messages, response pins, existing hidden ranges, pre-summary history and oversized Human messages are excluded from candidates. Scan progression advances even when a run hides nothing, wraps at the end and resets appropriately.
- Undo restores every live curation; `/compact` reads visible messages and seals earlier curations. Rewind/fork remove out-of-bounds curations; removing a summary can make retained curations live again.
- Versioned, atomically replaced journals under `attachments/deck-journals/<room>/chat.md` after review, with 0600 file permissions. JSON chunks preserve exact text, including CRLF, literal markers, trailing newlines and Unicode. Search-only overlap records cover short ordinary search terms crossing splits. The API reader regression reaches text beyond character 3,000.
- Journal synchronization on full checkpoints and open; replacement import invalidation; deletion cleanup; current-or-gone failure handling. Stale-removal warnings are surfaced, including alongside model errors.
- `room_curate { id }` and `room_curate_undo { id }`, both authorized as `full(thread(id))`. Success means the final checkpoint succeeded. Curation events update recovery state before the final snapshot. Events and saves stay bound to the original handle across replacement/deletion.

The curate reply is `{ by, status: "hidden", count, unchecked }`, `{ by, status: "nothing", unchecked }`, or `{ by, status: "stopped" }`. Undo returns `{ restored, sealed }`. `curations_changed` carries the replacement list, not an incremental addition.

## Four requested revisions

1. Replacement imports remove the prior journal even for closed threads, under lifecycle/checkpoint serialization.
2. Failed snapshot saves invalidate old journal text and its live hint. Removal returns a result; stale failures on open and simultaneous curator/save failures reach the caller.
3. JSON chunk encoding replaces ambiguous sentinel removal. Tests cover exact reconstruction and search at wrap boundaries.
4. Pins, instructions, digest framing and output allowance share the complete request budget. Protected overflow refuses before calling a model.

## Decisions made during implementation

- Kept the shared checkout and created `feat/curate` at its current HEAD, as AGENTS requires. This preserves neighboring work; writers still need to respect task ownership.
- Chose JSON chunks and search overlaps instead of a sentinel escape format. Exact reconstruction requires decoding the chunks; quotes/control characters must be searched in their encoded form.
- The request cap is 64,000 characters with a 4,000-character output allowance, not a provider token-window guarantee. Provider fit remains acceptance work.
- Made the unsaved journal hint shared so synchronous replacement imports can clear it without taking the async transcript lock. This adds a small mutex read to curated prompts.
- Budgeted recent context newest first, then rendered it chronologically. This preserves the latest ask; older recent context may be clipped first.
- Bound curation events and final saves to the original handle. A retired run fails instead of modifying a replacement room; this adds a scoped event/save helper.
- Kept the approved mutation-invalidation behavior on final-save failure. Live visibility can already have changed, so Task 7 must refresh the snapshot and say “Couldn’t finish /curate,” rather than promise nothing was hidden.

## Verification

Final Rust verification passed: 1,684 tests passed, 18 ignored, 0 failed across the four crates and their integration/doc-test targets.

- `TMPDIR=/tmp cargo test -p apex-core -p apex-adapters -p apex-host -p apex-daemon`
- `npx tsc --noEmit`: passed.
- `npm test`: 2,805 passed, 3 skipped, 0 failed.
- `git diff --check`: passed.

New regressions were observed failing before implementation. Author review also reproduced and fixed latest-request crowd-out, and verified that a retired curation cannot alter a reopened room. The existing command inventory test caught the expected count change from 192 to 194 and now explicitly checks both new command names.

## Remaining validation

No native-app or live-provider acceptance was performed. Journal reads by each provider/access level, actual tool-free execution, chat-note rendering and the `/compact` comparison are Tasks 7–9. Tiny-model retrieval quality and cost savings remain unmeasured. The accepted head/tail excerpt risk remains: a requirement in the middle of a long bot reply can be hidden.

Jigga's first review identified five follow-up fixes below. No merge, push, release build or installation was performed.

## Review follow-up: `fix/curate-review`

The branch starts at `8d409968` and addresses all five requested fixes:

1. `Room::turn_system` now builds both normal and concurrent read-only system prompts. Both retain journal paths or the explicit unavailable-text instruction. A two-writer regression covers both states and verifies hidden gap markers still appear.
2. A successful room save remains successful when journal synchronization fails. The hint is cleared, and a separate `journal_warning` event tells the Human when retrieval is unavailable or stale text may remain. Warnings are emitted after transcript/recovery/checkpoint locks are released. Open, accepted posts and terminal Idle continue; actual snapshot-save failures still return errors and invalidate old journal text. Explicit import/deletion cleanup failures still fail those operations.
3. Journal files now use `attachments/deck-journals/<room>/chat.md`, outside the room's user-attachment folder. Creation and removal preserve a user attachment named `deck-journal`. The file format and 9 MiB limit are unchanged. This unmerged feature has no deployed-format migration.
4. A per-bot Stop sets the shared cancellation flag when no normal turn is reserved, interrupting both curation and compaction. Waiting-provider regressions exercise cancellation while the transcript lock is held; a normal-turn control keeps cancellation scoped to that bot.
5. Reply parsing ignores `think`, `thinking` and `analysis` blocks, including unfinished blocks; skips stray braces; and chooses the last valid JSON object containing a `hide` array. Parsed objects are consumed whole so nested objects and quoted braces cannot override the answer. Offered-ID intersection remains enforced.

Small frontend additions are necessary for fix 2: the warning variant in `src/types.ts`, a `ChatPane.tsx` branch that displays it through the existing error notice, and a matching phone notice for an already-curated Work thread. None invokes turn-queue failure handling. Phone `/curate` command support remains out of scope. Task 6's composer, queue, backend and recovery implementation is untouched. Both design documents reflect the reviewed behavior.

Regression failures were reproduced before the corresponding fixes. Live-provider and native-app validation remain outstanding; the notification branch is type-checked and covered at the emitted host-event boundary, not visually validated.

Follow-up verification:

- `TMPDIR=/tmp cargo test`: 1,779 passed, 19 ignored, 0 failed across all default workspace members and doc tests.
- Final `TMPDIR=/tmp cargo test -p apex-core`: passed after the parser formatting cleanup.
- `npm test`: 2,806 passed, 3 skipped, 0 failed, including a phone warning regression that runs the real event handler and replays an open-time warning without ending an active turn.
- `npx tsc --noEmit` and `git diff --check`: passed.
- An independent code review found the missing phone warning delivery; that was fixed and its regression observed failing and passing. No remaining actionable findings were reported. Jigga's requested re-check is still pending.

No merge, push, release build, installation or live-provider call was performed in this follow-up.
