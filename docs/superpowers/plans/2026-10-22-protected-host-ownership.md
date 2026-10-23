# Protected host ownership implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** A same-UID attacker who unlinks `owner.lock` must not create two hosts serving the same protected authority, revive revoked permissions, or keep using stale executable grants after a second host changes them.

**Architecture:** The root broker prepares stable, root-owned lock inodes keyed by kernel UID and canonical ledger folder. Before opening authority, a host exclusively locks both its primary data directory scope and its saved-chats scope, retaining the read-only, close-on-exec descriptors for its lifetime. Private process-local weak guards make all protected document/claim/outcome calls refuse scopes the live host does not own. Kernel locks survive broker restart and disappear when the owning host dies; the user cannot unlink or replace their root-owned inodes.

**Tech stack:** Rust, existing signed broker IPC and Unix file locks on the macOS-only protected path; no new dependencies or process-liveness native API.

**Spec:** `docs/security/provenance-boundary.md`, especially the same-UID threat boundary and Direct writes and restart guarantee. This corrects the false assumption that the editable `owner.lock` is an adversarial singleton.

## Global constraints

- Existing test-support seams remain opt-in, isolated, and unreachable through production commands or environment variables.
- Keep G1 startup degradation when the broker is missing, unpinned or unavailable. Such a host owns no authority and cannot recover authority later without restarting.
- Contention with another live host fails construction immediately, before protected ledger reads, worker recovery or serving clients; it must not enter the empty-ledger fallback.
- Acquire both canonical folder scopes before publishing either process-local ownership guard; failure drops both. Deduplicate identical canonical scopes.
- Root lock inodes are created once and never truncated, renamed, unlinked or replaced. Opening an existing inode must validate regular-file type, root ownership, non-writable mode and root-owned non-writable ancestry without following a final symlink.
- A same-UID attacker can contend for a readable lock as denial of service; this grants no authority and is outside the authenticity guarantee, as are SIGSTOP/SIGKILL.
- Do not install, re-pin, run the app, merge main, or build a release. Keep primary checkout changes untouched. Current isolated integration branch continues existing authorized work.
- `npx tsc --noEmit` must pass before reporting integration; production-off checks run separately.

## Review focus

- Replacing `owner.lock`, including while clients remain connected, cannot start a second authority-serving host.
- Broker death/restart cannot transfer ownership while the first host still lives.
- A failed second-scope acquisition cannot leave a first-scope guard published or an inode locked by a discarded acquisition.
- Canonical-folder aliases and later user-controlled symlink changes cannot redirect authority calls into an unowned scope.
- Missing/untrusted broker fallback never acquires authority opportunistically on a later RPC.

### Task 1: Establish protected host ownership before authority admission

**Files:**
- Create a focused ownership module under `crates/apex-provenance/src/` and export its production acquisition interface from `lib.rs`.
- Modify `crates/apex-provenance/src/main.rs`: authenticated lock preparation and signed challenge response.
- Modify `crates/apex-provenance/src/io.rs`: response verification and ownership checks after final canonicalization in `document`, `consume` and `finish`.
- Modify `crates/apex-host/src/host.rs`: acquire both scopes before opening ledgers; retain the strong guard in `Host`.
- Add focused unit/process tests next to the ownership module and integration/feature-off tests only where needed to prove actual admission behavior.
- Update the security boundary and acceptance harness only where the new ownership prerequisite changes their executable behavior.

**Interfaces:**
- `HostOwnership::acquire(data_dir: &Path) -> Result<HostOwnership, HostOwnershipError>` acquires both primary and saved-chats canonical folders. `HostOwnershipError` distinguishes `Held` from `Unavailable`; `Host` may degrade only for `Unavailable`.
- A private registry stores only `Weak` references to live descriptor guards, not booleans or permanently held global descriptors. Authority calls require a strong live guard for their final canonical folder.
- Broker opcode `host_lock` accepts only a bounded absolute canonical folder and a 32-character hexadecimal challenge from the pinned daemon. Its signed `hostLock` response binds kernel UID, folder and challenge. The path is derived locally from those values, never accepted from the response.
- Lock files live only beneath `ROOT/host-locks/`, named by SHA256 of the kernel UID and canonical folder. Existing locks remain usable at capacity; creating a new lock beyond 4,096 entries fails closed. Files are empty, root-owned and mode 0444, directory mode 0755.
- Do not reuse the editable user lock or accept caller-supplied process identity, environment-selected root path or code bypass.

- [ ] **Step 1: Write failing tests for ownership and admission.** Prove separately opened read-only descriptors conflict; different scopes coexist; host exit releases ownership; broker-side preparation reuses an inode; untrusted preparation refuses; failure on the second scope drops the first; a dropped guard no longer authorizes calls; canonical aliases share ownership; unowned document/claim/finish scopes refuse; capacity rejects only new scopes. Include a child-process lock holder so the regression tests kernel lifetime rather than just a mocked registry.
- [ ] **Step 2: Run focused tests and record the observed RED failures.** Tests must fail for the missing ownership boundary, not for malformed fixtures or unrelated startup errors.
- [ ] **Step 3: Implement the interfaces above.** Use `File::try_lock` or explicit nonblocking `flock`, validated on this macOS with read-only descriptors and CLOEXEC. Publish guards only after dual acquisition succeeds. Keep root file creation durable before acknowledgement and never replace an existing inode.
- [ ] **Step 4: Verify GREEN and production separation.** Run `TMPDIR=/tmp cargo test -p apex-provenance`, applicable host/daemon construction tests, the complete default Rust suite with `--test-threads=2`, then `cargo test -p apex-host-production-check` separately; run TypeScript and relevant JS acceptance/startup tests. Report every failure/ignored check. Actual signed installed duplicate-daemon acceptance stays pending until the reviewed candidate is installed.
- [ ] **Step 5: Independent security review and scoped commit.** Return the exact diff, tests, known limits and no installed claim. Review against all five focus cases before task integration.
