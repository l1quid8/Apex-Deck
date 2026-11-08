# SSH and jail security fixes Implementation Plan

> **For agentic workers:** Use the debugging and test-driven-development skills; independent project, trust, and phone fixes may run in parallel with disjoint file ownership. Integrate and review the complete branch before merge.

**Goal:** Close the six findings in `docs/reviews/linux-jail/2026-11-03-null-merge-review.md` without changing unrelated work or claiming release acceptance from unit tests.

**Architecture:** Enforce project execution at the central process boundary, validate folder coverage directionally, and invalidate Linux device authority throughout each session. Pass authenticated device context to the host so participant compare-and-set and folder checks happen under the same room lock as mutation. Guard phone command transmission with a native biometric operation that fails closed.

**Tech Stack:** Existing Rust host/daemon/adapters, TypeScript phone transport, Capacitor and Swift LocalAuthentication. No new dependency is required.

**Spec:** `docs/superpowers/specs/2026-10-30-linux-bot-confinement-design.md`, especially Lower-writable folders, Trust, paired-device raises, and Must be proven; the six-finding review above supplies the regression requirements.

## Global Constraints

- Every project-folder operation on tainted data must be jailed at Edits or refused; acceptance never exempts automatic operations.
- Full folder acceptance must cover the entire requested folder; taint remains symmetric for parents and children.
- Linux device commands require current trust, confinement, and epoch. Mac/Windows do not require a Linux trust record.
- Linux raises require an authenticated Full/all-threads device, atomic saved old-level comparison, and the exact room folder for Full. Local socket, CLI, and SSH retain their refusal.
- Phone cancellation, unavailable biometrics, or authentication failure must transmit no raising command; no confirmation or SSH-secret fallback.
- Use `TMPDIR=/tmp` for Rust tests. Run `npx tsc --noEmit` before merge. Never launch development or production builds from this worktree.
- Preserve the shared checkout and its unrelated work. Only root coordinates commits and branch operations.

## Review Focus

- A nested accepted folder must not authorize its parent or tainted sibling, including canonical aliases.
- Changing trust while an authenticated device session stays connected must prevent its next shell command.
- Missing, unchanged, or unreadable boot IDs must not finish normal trust; explicit no-reboot remains separate.
- Concurrent access edits, missing old-level binding, wrong Full folder, and a confinement failure must leave saved access unchanged.
- Raising commands sent through typed phone methods and raw transport calls must both authenticate; errors and cancellation cannot reuse another authentication attempt.

### Task 1: Project operations

**Files:** `crates/apex-host/src/project_process.rs` and its callers (`bot_copies.rs`, `git_changes.rs`, `project_check.rs`, `runner/checks.rs`, and other existing callers as needed).
**Interface:** All project command construction receives the data and folder context needed to check taint. Return a refusal rather than an ordinary command when confinement cannot be established. Snapshots retain their separate isolated-Git implementation.

- [ ] Add actual bot-copy fsmonitor and protected-marker project-check regressions; show failures before fixing.
- [ ] Enforce taint/jail-or-refuse at every wrapper and migrate callers; apply the documented Git hardening in the wrapper itself.
- [ ] Run the covering host tests, including untainted project operations, and report exact commands/results.

### Task 2: Trust reset and reboot

**Files:** `crates/apex-daemon/src/trust_host.rs`, `remote.rs`, and the `Guard`/session code and relevant tests in `protocol.rs` only. The host-command access-effect block in protocol belongs to Task 4.
**Interface:** Existing `is_trusted`/`epoch` callers remain supported. Device session validity rechecks current Linux epoch and trust before every command/frame. Trust shutdown targets only the daemon for this data folder and returns an error unless it has stopped.

- [ ] Add unchanged/changed/missing boot-ID, scoped shutdown, and already-connected old-device `pty_spawn` regressions; capture red results.
- [ ] Implement durable pending state, strict reboot transition, scoped waited shutdown, and active-session invalidation.
- [ ] Run covering daemon tests with remote support and report native/Linux-specific validation limits.

### Task 3: Phone biometric transport

**Files:** `src/phone/biometric.ts`, `src/phoneBackend.ts`, a focused phone command guard module if useful, `iphone/ApexRemote/Sources/ApexRemote/ApexSshPlugin.swift` and focused tests. Do not edit `commandBackend.ts` or the backend participant API; Task 4 owns those.
**Interface:** Expose a dedicated native biometric authentication operation without retrieving a secret. Wrap `Transport` before `commandBackend`, covering raw calls and typed methods. Mirror the daemon's conservative access-effect classification and test it for drift.

- [ ] Add transport tests demonstrating success waits for biometrics and cancel/failure/unavailable send nothing, including typed and raw raising routes; capture red.
- [ ] Implement the native operation and fail-closed guard with no confirmation fallback.
- [ ] Run focused frontend tests and available native compile checks; state any remaining device acceptance.

### Task 4: Folder coverage and atomic device raises

**Files:** `crates/apex-core/src/folder_trust.rs`, `crates/apex-host/src/command.rs`, `host.rs`, `crates/apex-daemon/src/authority.rs`, the Host-command dispatch/gate in `protocol.rs`, and participant call sites in `src/backend.ts`/`commandBackend.ts` and related UI as necessary.
**Interface:** Extend participant update requests with optional `old_level` and `folder`; device updates that change access on Linux require those bindings. Keep existing local APIs compatible. Use verified device context from the daemon, never an intent-supplied authentication flag.

- [ ] Add parent/sibling/alias folder acceptance regressions and run red, then implement directional coverage.
- [ ] Exercise actual device protocol commands for missing/stale old level, wrong Full folder, confinement failure, and current authorized Linux raise; ensure no unauthorized saved mutation.
- [ ] Keep local/SSH refusal and Mac/Windows supported device behavior; preserve stop/reap/MCP invalidation before saving access.
- [ ] Update phone/typed request payloads and run covering Rust and TypeScript tests.

### Task 5: Integration and record

- [ ] Read all diffs and run `npx tsc --noEmit`, `npm test`, `TMPDIR=/tmp cargo check --locked -p apex-daemon --features remote`, and the core/adapters/host/daemon Rust library suites with remote support.
- [ ] Run a fresh review of the six fixes and resolve material findings with focused regressions.
- [ ] Update the six-finding review with exact evidence and residual Linux/native acceptance limits; retain outstanding release/infra items in the original plan.
- [ ] Commit scoped fixes and merge to main under the existing merge authorization only after passing TypeScript and relevant checks; delete the merged task branch.
