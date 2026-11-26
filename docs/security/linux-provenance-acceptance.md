# Linux protected approvals: implementation evidence

Status: **incomplete; protected desktop approvals are not supported yet**.

## 2026-11-26 production publisher trust for Nightly

The production broker now trusts the Ed25519 keys listed per channel in
`crates/apex-provenance/linux-publisher-keys.json`, compiled in by build.rs, and
only production (`evaluation: false`) manifests. An empty list keeps protected
installation disabled with the same refusal as before; Stable is still empty.
Linux Nightly signs each installer in a separate `sign` job in the main-only
`linux-nightly-signing` environment. That job runs no npm or cargo code, takes
identity from the plan, and refuses a manifest that doesn't name the planned
commit, build number and payload. A `verify` job runs each bundle's own
production broker against it on that architecture before publishing. This is a
custody boundary for the key, not an attestation of the build job's payload. See
[Linux Nightly](../linux-nightly.md#publisher-key). Earlier sections that call
production trust unprovisioned describe the state before this change.

## 2026-11-14 graphical evaluation acceptance

A disposable native ARM64 Ubuntu 24.04 systemd/logind session with Xvfb and
Openbox ran the real packaged Electron 44.5.1 UI under the broker's exec guard.
The signed evaluation payload contained the real remote-enabled daemon and
broker, with safe fuses and Chromium sandboxing retained. A deterministic local
Codex protocol fixture supplied requests; no provider account was used. This
is graphical evaluation acceptance, not production publisher trust or physical
desktop/login acceptance.

The visible **Allow once** control delivered an accept and created the requested
test marker. **Deny** delivered a decline and its marker stayed absent. A raw
socket approval failed for missing installed-UI provenance. Broker restart killed
the supervised UI, replaced the engine, retained its authority key and restored
the saved transcript. The relaunched UI then approved a fresh request and created
a second marker; the rejected marker remained absent.

Testing reproduced a startup race: a supervised UI launched immediately after
restart treated the engine's temporary failed readiness probe as permanent repair.
Installed UI discovery now retries only the two explicit readiness errors, at
most twelve times, yielding between read-only attempts. Signature/identity
failures still stop immediately; no submission is retried and portable fallback
remains forbidden. The regression failed before the change and passed afterward;
the fixed signed ASAR passed immediate-restart graphical acceptance.

The oversized unstripped debug daemon first exceeded activation readiness;
stripping native debug symbols resolved that evaluation packaging failure without
changing verification or timeouts. The focused desktop suite passed 29 tests;
the broader desktop suite passed 176 with one skip; native exec-guard/fuse/health/
endpoint checks passed nine tests with one privileged test skipped. TypeScript
passed. Evidence, screenshots and harness scripts are retained in the sibling
cleanup-notes/linux-electron-20261114 directory. Production signing/bootstrap,
x64 installed acceptance, graphical login/logout and release update/rollback
acceptance remain required. Earlier checkpoints below describe their own scope.

## 2026-11-14 backend completion continuation

The broker now owns trusted launches and binds roles to the original supervised
process generation. Ptrace tracks thread/fork/exec transitions, dispatch leases
serialize revocation with journal commits, and inherited seccomp restrictions
refuse untraced clones and unsupported clone3 requests. Descendants receive no
approval role. Safe Electron fuse policy and the signed immutable payload are
checked before launching the app. These checks do not eliminate unrestricted
same-account injection, runtime library loading or UI automation.

An explicit administrator-terminal enrollment ceremony derives identity from a
live kernel socket peer, shows the canonical scope and security disclosure, and
requires exact confirmation. Service activation/recovery installs root-controlled
systemd units, uses readiness notification, checks signed nonce-bound epoch and
real daemon protocol/process identity, and opens admission only after health.
Failed installation remains closed; recovery advances the epoch and retains
established authority. Public-key mode repair retains the existing key bytes.
Desktop routing now verifies signed discovery and hands off to the broker's
installed launcher; failed discovery never selects a portable engine.

Enrolled Linux host storage also requires lifetime protected ownership. A
root-owned per-account public scope marker is an availability restriction only:
it is published before private enrollment persistence and prevents an enrolled
folder from falling back to plain ledgers when the broker is absent. It neither
grants a role nor exposes private activation/journal state. Unrelated unenrolled
Linux and SSH data folders retain their existing plain-file policy; legacy user
JSON is never imported into the protected journal automatically.

Current branch checks: 148 ordinary native provenance tests and all eight
explicit privileged/ignored fixtures pass; TypeScript, workspace/test-target
compilation, remote-daemon compilation, 1,153 host tests, and 3,439 JavaScript
tests with bounded concurrency pass. A prior default-concurrency run exposed the unchanged
desktop-sidecar simultaneous-start race; it passed alone and on the full bounded
rerun. The detailed continuation report retains both results.

Disposable ARM64 Ubuntu with real systemd/logind completed signed evaluation
activation recovery to epoch 6 with verified health and retained key material.
Its app-role client is an explicitly synthetic native protocol fixture, not
Electron or a human UI. Supervised receipt execution created two persisted test
rooms; raw issuance, raw execution, signature forgery and replay before/after
broker restart were refused. User-manager stop/start stopped and restored the
engine; missing-broker startup refused the enrolled scope while an unrelated
relative Linux data folder remained usable. Full verification was retained;
the evaluation broker used compiler optimization to match release performance.
Real graphical approval/rejection acceptance, user login
acceptance and x64 desktop acceptance must not be inferred from this fixture.
Production publisher trust is still unprovisioned. Kernel identity currently
requires SO_PEERPIDFD; older kernels fail closed. This is not a support claim for
stock Ubuntu 22.04 or every Ubuntu 24.04 kernel.

## Earlier 2026-11-14 implementation checkpoint (superseded above)

Enrollment now has root-owned bounded persistence, explicit exact-UID/disclosure/
linger consent inputs, transaction locks and failure/restart poisoning. Admission
guards hold the shared installation lock until callers finish a transaction.
Signed candidates revalidate the installed tree. Service unit generation remains
configuration only; activation refuses without changing installation or services.

Linux broker/key paths are separate from macOS. Process inspection checks immutable
resources and launch inputs but grants no trusted role. A native regression proves
that same-binary exec retains the existing kernel process identity and executable
inode. Broker startup therefore stops before authority initialization until a
trusted launcher can attest exec transitions. Desktop notices disclose this limit;
a detected protected installation cannot fall back to a portable engine or guessed
data folder. The private activation record is not read by the desktop user.

The administrator enrollment ceremony, trusted launcher, authenticated installed
scope routing, actual unit lifecycle, health handshake, activation orchestration,
and installed approve/reject/restart acceptance remain unfinished. The native
storage, staging and rejection fixtures are not installed approval acceptance.
Production publisher trust remains disabled.

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

Before claiming support, complete real graphical installed-client acceptance,
fresh desktop login/logout and service-boundary crash/update/rollback acceptance,
plus native x64 coverage. Uninstall orchestration and production publisher trust
provisioning are separate outstanding release work. Backend launch, enrollment,
activation/recovery and routing implementation is described in the continuation
above; the whole-change code review found no outstanding Important/Critical
issue in that scope. This does not replace installed acceptance.

The activation module has local tests for interruption at each write/fsync/rename
boundary, malformed records, recovery/rollback epochs, stale temporary symlinks,
and durability-failure poisoning. Abrupt subprocess-death tests cover all
persistence boundaries while updating an already healthy installation. Any
pending write blocks normal reopen; explicit recovery retains its higher epoch.
Native CI additionally runs a privileged,
isolated `/var/lib` fixture for locking, restart recovery and preserving authority
bytes. These are module-level tests; service-boundary fault injection and
power-loss acceptance remain outstanding.

After those gates, provision only the independently checked evaluation verifier
in Omarchy, install the verified payload, and observe real protected chat
creation/submission, approval execution, rejection with no effect, fresh restart
operations, forged/raw requests, wrong scopes, modified resources, revoked
grants, replay, missing broker, login lifecycle, crash recovery, upgrade and
rollback. No such installed acceptance is claimed by the foundational tests.

The Linux same-account injection/automation limitation remains part of the
approved design. Omarchy ARM64 acceptance will not establish x64 or Ubuntu
desktop acceptance.
