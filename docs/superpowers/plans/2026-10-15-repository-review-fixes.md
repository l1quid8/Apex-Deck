# Repository review fixes implementation plan

Goal: Fix all 12 findings in the 2026-10-15 repository review.

Scope: Existing behavior only; no merges, pushes, releases, new features, or changes to the shared checkout. User approved the review recommendations and explicitly requested implementation in a new branch/worktree.

Architecture: Repair security checks at the host/adapters boundary and preserve ordinary read flows; enforce artifact CSP before untrusted input; preserve failed messages and reconcile canceled queue work. Keep every change covered by a targeted regression.

Task A — host safety (separate worktree):
- [x] #1 Narrow command read grammars; mutating flags/execution hooks ask.
- [x] #2 Canonicalize operands relative to operation.cwd; outside/symlink paths ask or are refused on remote machines.
- [x] #3 Confine checkpoint deletion to the project without following ancestor symlinks.
- [x] #10 Integrate file-to-directory and directory-to-file transitions safely while preserving the primary index.
Tests: cargo test -p apex-host --lib, focused scratch boundary regressions.

Task B — adapter safety (separate worktree):
- [x] #4 Use host-provided authorized attachment roots; arbitrary transcript references cannot read outside attachment roots.
- [x] #6 Apply upstream high-risk metadata before automatic approval.
- [x] #7 Positively identify ordinary read-only MCP tools; unknown/mutating names ask.
- [x] #11 Treat explicit SSE error objects as failed replies.
Tests: cargo test -p apex-adapters --lib, fake-provider and outside-image fixtures.

Task C — frontend (separate worktree):
- [x] #5 Place enforceable artifact CSP before all untrusted parser input; runtime network-bypass regression.
- [x] #8 Retain failed dispatched messages, attachments and quoted context without automatically duplicating uncertain posts.
- [x] #9 Emit recipient-specific ParticipantIdle for every pre-start cancellation; ignore stale global Idle for reservations so subsequent queued work resumes without overlapping turns.
Tests: focused node tests, npm test and npx tsc --noEmit.

Task D — integration (task worktree):
- [x] #12 Regenerate standalone mobile Cargo.lock; verify locked metadata and mobile tests.
- [x] Update the stale E2E expectation to current explicitly concurrent ordinary-chat semantics while retaining task review, revision, index and receipt checks.
- [x] Review/cherry-pick each domain commit into fix/repository-review-2026-10-15.
- [x] Verify npx tsc --noEmit, npm test, cargo test --workspace --all-features and protocol E2E. Run locked mobile checks.
- [x] Independently review the combined changes and address regressions before reporting completion.

Baseline at 8dc6f0: tsc passed; JS 1433 passed; all-feature Rust 988 passed/4 ignored; E2E 16 passed/1 stale expectation; mobile locked resolution failed.

Shared interfaces: Adapter attachment roots must be supplied by BuildContext from host data and propagated through all adapter constructors. No frontend changes depend on host gateway APIs. Domain changes use disjoint files except adapter BuildContext plumbing into host; root reviews that integration explicitly.

Integration progress: mobile locked tests RED (out-of-date lockfile) → GREEN (18 passed); mobile lock delta only updates five local workspace package versions. Added a macOS CI step using the standalone locked test command. Delegation E2E baseline failed on changed checkout; adjusted it to exercise concurrent ordinary chat without mutating the pending task checkout, then write after acceptance; targeted test GREEN. Initial task-worktree TypeScript check passed.

Final review follow-ups: narrowed Git diff/log external-helper flags, blocked recursive grep symlink dereference and uniq output operands, covered nested file/directory transitions, disabled configured Git helpers for automatic reads, and removed invisible failed transient-turn queue blockers. Replaced global Idle reservation cleanup with explicit ParticipantIdle events and tested delayed acknowledgements/stale event ordering. Artifact self-navigation was reproduced in Chromium, then blocked with a trusted parent CSP and a separate opaque inner sandbox. Electron runtime validates six interactive HTML parser fixtures, SVG, HTTP/data/blob navigation rejection, and denied parent access, with zero network requests.

Final combined verification at 0ea1a4f: npx tsc --noEmit passed; full JavaScript suite 1,443 passed, no skipped; cargo test --workspace --all-features 1,010 passed, 4 ignored; daemon build --all-features passed; protocol E2E 17 passed. The GNU/BSD grep proof fixture was made platform-aware after the first run exposed that assertion difference; the conservative approval policy is unchanged. E2E uses the verified task-source daemon binary through the shared build cache, linked at the task worktree target path for the multi-host harness. Standalone cargo test --manifest-path crates/iroh-mobile/Cargo.toml --locked passed all 18 tests. No development app or DMG build was started.
