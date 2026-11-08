# Linux protected approvals: implementation evidence

Status: **incomplete; protected desktop approvals are not supported yet**.

The user approved the implementation plan on 2026-11-08. Work is isolated on
`feat/linux-appimage`. The shared checkout and the Omarchy VM's desktop fixes
have been preserved. Nothing from this work has been merged or installed as a
protected service in the VM.

## Verified foundations

- Signed, bounded evaluation manifests and exact archive/file inventory checks.
  Signature, architecture, contents, mode, path, link, duplicate and extra-entry
  validation precedes privileged extraction. Production trust remains disabled.
- An independently configured evaluation verifier, with no runtime key-choice
  option. Test identities remain outside Git and artifact uploads.
- Root-owned staging, root-owned non-writable ancestors, complete extracted-tree
  verification and directory/file durability. Staging never activates a release
  or touches authority records, user data, systemd units or an active descriptor.
- Linux kernel socket/process references using `SO_PEERPIDFD`; liveness,
  generation, namespace, UID/GID and per-message sender checks. Inherited socket
  senders and exited peers are rejected. These are identity primitives, **not
  sufficient attestation to grant human authority**.
- Enrollment record primitives derive UID from a kernel peer, resolve NSS and
  recheck canonical data-folder ownership and device/inode identity. Root,
  another account, directory substitution and symlink substitution are refused.
  These primitives do not implement administrator-approved enrollment.
- Optional installation epochs in receipts and persisted journal entries.
  Linux-specific issue/claim methods refuse legacy, stale, retagged and replayed
  receipts. Mac/Windows default issuance omits the optional field. A monotonic
  installation transaction must supply the epoch before these methods are wired
  into Linux admission.
- A durable installation state machine now keeps descriptor selection and the
  epoch high-water mark in one atomic record. Prepared/switched states close
  admissions; explicit recovery and rollback burn a higher epoch. Disk-write
  failures poison the open store until recovery. Initialization refuses existing
  authority material; missing state is never silently initialized. This module
  is not yet connected to service activation or peer admission.

## Evidence

- [Native x64/ARM64 CI at f2059b60](https://github.com/l1quid8/Apex-Deck/actions/runs/42510008379):
  provenance tests, real privileged staging with tamper refusal, kernel-peer
  tests, portable AppImage builds and extracted-window startup passed on both
  architectures. These AppImages do not install an approval service.
- [Follow-on CI at 90f02445](https://github.com/l1quid8/Apex-Deck/actions/runs/42510741526):
  adds registration and receipt-epoch regressions. Read the run's current result
  before claiming a final artifact/build verdict.
- Local provenance checkpoint: 89 library tests, 4 CLI tests, 2 epoch tests,
  1 staging CLI test and 8 storage tests passed; one existing storage test was
  ignored. TypeScript passed. The app suite passed 3,428 tests, skipping five.
  The standalone mobile bridge's committed-lockfile suite passed 19 tests.
- A broad Rust run failed seven `attach` tests because the host-injected
  temporary path exceeded macOS socket limits. The whole-suite rerun with
  `TMPDIR=/tmp` and four test threads passed 2,472 tests across 58 test binaries
  and documentation suites, with zero failures and 32 ignored tests.

Disposable CI runners required hardening `/opt` before the valid staging
fixture. The production verifier's ancestor checks were retained. CI does not
establish installed systemd lifecycle or desktop protected-action acceptance.

## Required work before installation and support claims

Finish immutable executable/resource/environment and trusted-launch attestation,
including exec-transition handling; administrator-confirmed enrollment and linger
policy; root broker and user-run daemon units tied to login/logout; installed UI
routing and the protected same-account safety disclosure; atomic activation,
monotonic epochs, crash recovery, repair, rollback and uninstall. Then perform the
whole-change security review required by the approved plan.

The activation module has local tests for interruption at each write/fsync/rename
boundary, malformed records, recovery/rollback epochs, stale temporary symlinks,
and durability-failure poisoning. Native CI additionally runs a privileged,
isolated `/var/lib` fixture for locking, restart recovery and preserving authority
bytes. These are module-level tests; service-boundary fault injection and actual
process-kill/power-loss acceptance remain outstanding.

After those gates, provision only the independently checked evaluation verifier
in Omarchy, install the verified payload, and observe real protected chat
creation/submission, approval execution, rejection with no effect, fresh restart
operations, forged/raw requests, wrong scopes, modified resources, revoked
grants, replay, missing broker, login lifecycle, crash recovery, upgrade and
rollback. No such installed acceptance is claimed by the foundational tests.

The Linux same-account injection/automation limitation remains part of the
approved design. Omarchy ARM64 acceptance will not establish x64 or Ubuntu
desktop acceptance.
