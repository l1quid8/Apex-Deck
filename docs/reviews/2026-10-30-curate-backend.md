# `/curate` backend handoff

Scope: Tasks 1–5 of `docs/superpowers/plans/2026-10-30-curate.md`, on `feat/curate` from `55a73439`. No frontend source or frontend test files changed. Task 6 remains Ds4's work; Tasks 7–9 remain separate.

## Implemented

- Shared, persisted curation ranges; original transcript text stays intact. Model views get gap markers, and hidden messages also stay out of attachment/media `unseen` inputs.
- A bounded, tool-free curator turn using the existing talk-only participant builder. Newest 20 messages, response pins, existing hidden ranges, pre-summary history and oversized Human messages are excluded from candidates. Scan progression advances even when a run hides nothing, wraps at the end and resets appropriately.
- Undo restores every live curation; `/compact` reads visible messages and seals earlier curations. Rewind/fork remove out-of-bounds curations; removing a summary can make retained curations live again.
- Versioned, atomically replaced journals under `attachments/<room>/deck-journal/chat.md`, with 0600 file permissions. JSON chunks preserve exact text, including CRLF, literal markers, trailing newlines and Unicode. Search-only overlap records cover short ordinary search terms crossing splits. The API reader regression reaches text beyond character 3,000.
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

Fresh review by Jigga is pending. No merge, push, release build or installation was performed.
