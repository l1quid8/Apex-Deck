# Simplified turn progress implementation

Approved in chat: desktop, iOS, and CLI use ordered, expandable activity summaries and a visible live checklist. Completed turns fold to a progress line; final text remains readable. Supported tool-capable agents maintain their native checklist for multistep work. Missing plans are not fabricated. No extra model calls.

## Implementation
- Extend ReplySteps and live room snapshots with ordered text/activity references. Preserve tool key identity and nested helpers.
- Extend saved index with checklist counts and retain checklist-only records, interrupted outcomes, truncation indicators, and older-record compatibility.
- Share web model and WorkSteps rendering between desktop and iOS; recover progress from host checkpoints.
- Add CLI structured progress, narrow-terminal rendering, and read-only /progress keyboard controls.
- Instruct supported agents to maintain native structured checklists.

## Verification
Use real reducer, rendering, host persistence, and CLI tests for interleaving, repeated updates, missing plans, helpers, terminal outcomes, saved records, and reconnects. Run affected Rust tests, npm test, and npx tsc --noEmit. Do not merge, publish, install, or package a release.

## Work log
- Created feat/turn-progress preserving pre-existing dirty checkout.
- User requested five parallel Luna agents. Runtime permits three subagent chats; three Luna workers execute five assignments by reuse, with root integrating.
- Shared web model/component tests and phone recovery tests passing after integration corrections.
- Baseline npm test: 4012 tests; 4002 passed, 8 skipped, 2 failed (all 8 Liquid presets are reachable at every width; every host command requiring provenance enters desktop attestation).
- Saved-text reconciliation: keep the full answer before lazy loading; when a saved timeline exactly matches the concatenated response, expanded progress shows earlier commentary and the final segment once. Mismatched text falls back to the full answer with activity details.
- Browser fixture passed at 1100px and 390px: checklist visible, activity/output expand, saved summary opens, no duplicate answer or horizontal overflow.
- Review fixes: suppress replayed snapshot-covered deltas; retain inactive interrupted progress; display truncation and no-reply outcomes accurately.

## Final verification
- `npx tsc --noEmit`: pass.
- `git diff --check`: pass.
- `cargo test -p apex-core -p apex-adapters -p apex-host -p apex-cli`: exit 0; 2338 passed, 31 ignored.
- Final CLI rerun after reconnect/late-helper fixes: `cargo test -p apex-cli`, exit 0; 167 passed, 2 ignored.
- JavaScript full suite: 4,026 passed, 8 skipped, 1 pre-existing failure in `tests/desktop-provenance.test.mjs` (“extract the protected host variants”). This failure was present before implementation.
- Shared browser fixture at desktop 1100px and phone 390px: activity/output expansion, checklist, saved turn, no duplicate answer, no horizontal overflow all pass. Screenshots are in the task visualization folder.
- Reviewed by Luna workers across subsystem ownership; root resolved reconnect duplication, terminal truncation visibility, CLI request races/scrolling, and late helper events.
- Physical iPhone validation, packaging, installation, merge, and publishing were not performed. Changes remain on `feat/turn-progress`; pre-existing checkout work was retained.
