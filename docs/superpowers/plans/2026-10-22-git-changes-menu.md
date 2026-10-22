# Git changes menu implementation plan

**Goal:** Implement the approved Jigga V2 popover in the top bar; turn chips open it with matching current files checked.
**Spec:** Jigga V2 mockup approved in the conversation.
**Architecture:** A dedicated host Git API supplies live repository state and performs guarded operations. A compact React popover owns selection and transient interaction state; the existing thread diff remains available for review.
**Tech stack:** React/TypeScript, existing CSS theme tokens, Rust host RPC, Git and GitHub CLI.

## Constraints
- Work on `feat/git-changes-menu` in this checkout. Preserve existing dirty files.
- Use a separate component stylesheet to avoid unrelated styles.css edits.
- Commit selection means whole current files; historical turn patches never become commit inputs.
- Checks mean `npx --no-install tsc --noEmit`, enforced by the host for the exact clean HEAD and target. PR creation publishes the branch with Git/gh. Local merge uses fast-forward only and deletes the task branch only on success.
- No app build/restart or release packaging without need. Run TypeScript and relevant Rust/JS checks.

## Review focus
- Unrelated staged files remain excluded and staged after a selected-file commit.
- Stale selections/HEADs fail rather than committing unseen changes.
- Absolute and relative turn paths match repository paths, including nested workspaces.
- New commits/dirty trees invalidate merge eligibility; moved targets invalidate check results.
- Empty/non-Git/disconnected states, long file lists, keyboard close/focus and viewport clamping remain usable.

## Tasks
1. Write failing real-repository tests; implement live status and guarded commit/checks/PR/merge host RPC. Verify with `cargo test -p apex-host git_changes` and daemon authority checks.
2. Write selection/gating tests; implement compact popover and turn-chip opener. Verify selection tests and TypeScript.
3. Review the patch; run JS suite, TypeScript and scoped Rust tests. Exercise the existing dev app if available; report exactly what was verified.

## Verified outcome
- Implemented live host Git RPC, compact theme-aware popover, file patch previews, selected-file commit, TypeScript checks, GitHub PR publication, and guarded local fast-forward merge/deletion.
- Turn chips open the top-bar popover with matching current files selected. Historical thread diff remains available, including Git-error states.
- Independent review found index-flag stale-content bypass and slow-refresh starvation. Both were reproduced with failing tests and corrected; prepared commits use reviewed snapshot blobs and pending refreshes coalesce.
- Interaction tests additionally cover changed-HEAD confirmation cancellation, disconnection gates, explicit commit scope, failure fallback and Escape.
- Isolated DOM test verified portal placement inside a small viewport, turn selection, patch rendering, commit/check/merge sequence and focus return. Screenshot: `/tmp/apex-git-menu-ui.png`.
- `npx tsc --noEmit`: passed.
- JS suite with concurrency 4: 1,972 passed, zero failed. An initial unrelated phone-panel gesture flake passed alone and on the final full run.
- `cargo test -p apex-host --lib`: 491 passed, four existing ignored, zero failed.
- Daemon authority suite: five passed, zero failed.
- `git diff --check`: passed. Original phone/styles/test edits and untracked mockups/images preserved.
- Work remains uncommitted on `feat/git-changes-menu`. No merge, app replacement, or release build performed.


## Approved placement revision: Option B (2026-10-22)
- The human selected the card inside the clicked bot reply in `mockups/git-changes-card-placement-v1.html`; this supersedes the original floating-popover placement.
- One persistent controller renders its card into the selected reply's inline slot. Same chip closes it; another chip moves it. Outside clicks leave it open. The header shows the live file count, branch/target, `live now`, refresh and close.
- Top-bar always reveals the latest eligible reply with global current-file selection and clears turn dots. `/diff` follows that route, falling back to Thread diff if no reply has a chip.
- Git action RPCs, state expectations, selected-file commits, checks, and confirmation gates are unchanged by this revision. `Thread diff` remains in the card.
- Regression evidence: the new inline-region test failed against the old popover; 12 focused tests now pass, including Electron DOM placement, singleton moves, toggling, top-bar reset from an open earlier turn, narrow width, commit/check/merge confirmation and focus restoration. TypeScript passes.
- Fresh review identified `/diff` without an inline target and top-bar toggling closed instead of navigating/resetting; both are fixed with regression coverage. The minor close-button focus issue is also fixed and covered. No known Critical/Important findings remain in the reviewed frontend.
- Review limits: unchanged backend internals retain the earlier review and were rechecked by scoped host/authority tests; installed-app behavior awaits the human's DMG trial. The DOM fixture verifies the card in replies, not every real pane layout.
- Build starts from a preserved source snapshot under `release/.build-git-card-20261022-093302`; no merge, source commit, or installed-app replacement is performed.
- Final verification: 1,975 JavaScript tests passed; TypeScript passed; seven Git host tests and four daemon authority tests passed. Signed DMG integrity, mounted app signature, packaged UI (153 files), and native daemon content verified. Artifact: `release/Apex-Deck_0.8.2_arm64-inline-git-card.dmg`. Source remains uncommitted on `feat/git-changes-menu`.
