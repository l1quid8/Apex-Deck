# Assistant provider integration and cleanup

User authorized commit, merge, push to origin, and safe removal of the old assistant worktree.

The provider branch merged without conflicts into main at 9dd57eb, retaining main's 0.9.0 release/CI changes. Remaining Work v8 checkpoint notes were committed as 63e6afb. Unrelated root mockups/images are excluded from these commits.

## Integration checks
The first broader Rust run found a legacy integration assertion that Codex/Grok must always reject text-only mode. Updated it to enforce failure on hosts lacking the supported macOS process isolation and added an all-known-agents planning-refusal regression. Existing private-config, tool-removal and access-boundary tests remain in place.

The production-storage crate deliberately refuses workspace feature unification. Ran it in its own Cargo invocation, matching CI; all three tests passed with fixture support absent.

A voice helper fixture failed because a 100 ms deadline killed the child before it recorded its PID, also reproduced in a serial daemon run. Only the test deadline was increased to two seconds; the never-ready timeout and process-death assertions remain. Its focused regression passed. No application behavior changed in these integration corrections.

Full frontend on merged source: 2470/2470; npx tsc --noEmit passed. Final Rust workspace with remote enabled: 1485 passed, zero failed, 13 ignored (`/tmp/apex-provider-rust-green.log`). Separate feature-off production-storage check: 3/3. Scoped tool-boundary regression4/4 and voice timeout regression1/1. git diff --check passed.

## Worktree preservation
Old checkout: /Users/tylercaldwell/Downloads/apex-deck-worktrees/assistant-workspace-plan, clean HEAD3f8d6f1. Two commits are outside main's ancestry; their branch is retained and a Git bundle was verified. Saved all source, mockups, local records and packaged output, excluding .git metadata and reproducible target/node_modules/dist caches. Verified 1869 regular files against the archive, plus symlinks. No process had its working directory in the old checkout.

Recovery directory: /Users/tylercaldwell/Downloads/apex-deck-worktree-backups/assistant-workspace-plan-ovivkefj

Archive SHA256: f76df0be6df49c8a0ceb842b842904938cf9d13a90e3e1469ee5a103c1b040af

Original browsable mockup: /Users/tylercaldwell/Downloads/apex-deck-worktree-backups/assistant-workspace-plan-ovivkefj/mockups/apex-dot/index.html

Cleanup is gated on these green checks and a normal push. Final removal and remote read-back are recorded in the recovery manifest; the old unmerged branch is retained for recovery.
