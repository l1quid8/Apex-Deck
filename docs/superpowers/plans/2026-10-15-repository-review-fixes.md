# Repository review fixes implementation plan

Goal: Fix all 12 findings in the 2026-10-15 repository review.

Scope: Existing behavior only; no merges, pushes, releases, new features, or changes to the shared checkout. User approved the review recommendations and explicitly requested implementation in a new branch/worktree.

Architecture: Repair security checks at the host/adapters boundary and preserve ordinary read flows; enforce artifact CSP before untrusted input; preserve failed messages and reconcile canceled queue work. Keep every change covered by a targeted regression.

Task A — host safety (separate worktree):
- [ ] #1 Narrow command read grammars; mutating flags/execution hooks ask.
- [ ] #2 Canonicalize operands relative to operation.cwd; outside/symlink paths ask or are refused on remote machines.
- [ ] #3 Confine checkpoint deletion to the project without following ancestor symlinks.
- [ ] #10 Integrate file-to-directory and directory-to-file transitions safely while preserving the primary index.
Tests: cargo test -p apex-host --lib, focused scratch boundary regressions.

Task B — adapter safety (separate worktree):
- [ ] #4 Use host-provided authorized attachment roots; arbitrary transcript references cannot read outside attachment roots.
- [ ] #6 Apply upstream high-risk metadata before automatic approval.
- [ ] #7 Positively identify ordinary read-only MCP tools; unknown/mutating names ask.
- [ ] #11 Treat explicit SSE error objects as failed replies.
Tests: cargo test -p apex-adapters --lib, fake-provider and outside-image fixtures.

Task C — frontend (separate worktree):
- [ ] #5 Place enforceable artifact CSP before all untrusted parser input; runtime network-bypass regression.
- [ ] #8 Retain failed dispatched messages, attachments and quoted context without automatically duplicating uncertain posts.
- [ ] #9 Reconcile recipients canceled before TurnStarted when room reports Idle; subsequent queued work resumes correctly.
Tests: focused node tests, npm test and npx tsc --noEmit.

Task D — integration (task worktree):
- [x] #12 Regenerate standalone mobile Cargo.lock; verify locked metadata and mobile tests.
- [x] Update the stale E2E expectation to current explicitly concurrent ordinary-chat semantics while retaining task review, revision, index and receipt checks.
- [ ] Review/cherry-pick each domain commit into fix/repository-review-2026-10-15.
- [ ] Verify npx tsc --noEmit, npm test, cargo test --workspace --all-features and protocol E2E. Run locked mobile checks.
- [ ] Independently review the combined changes and address regressions before reporting completion.

Baseline at 8dc6f0: tsc passed; JS 1433 passed; all-feature Rust 988 passed/4 ignored; E2E 16 passed/1 stale expectation; mobile locked resolution failed.

Shared interfaces: Adapter attachment roots must be supplied by BuildContext from host data and propagated through all adapter constructors. No frontend changes depend on host gateway APIs. Domain changes use disjoint files except adapter BuildContext plumbing into host; root reviews that integration explicitly.

Integration progress: mobile locked tests RED (out-of-date lockfile) → GREEN (18 passed); mobile lock delta only updates five local workspace package versions. Added a macOS CI step using the standalone locked test command. Delegation E2E baseline failed on changed checkout; adjusted it to exercise concurrent ordinary chat without mutating the pending task checkout, then write after acceptance; targeted test GREEN. Initial task-worktree TypeScript check passed.
