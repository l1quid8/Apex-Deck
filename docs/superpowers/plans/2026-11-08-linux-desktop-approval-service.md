# Linux desktop approval service implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task after review. Do not enable Linux trust by accepting a UID or executable path alone.

**Goal:** Install a protected Linux approval authority and user-run engine, then prove protected chat submission and approval in the Omarchy ARM64 VM.

**Architecture:** Reuse the bounded provenance protocol, signing, journal and host admission. Add Linux peer authentication, an explicitly installed immutable application tree, a root systemd broker, and a system daemon instance per registered user. The portable AppImage remains an evaluation client and never elevates automatically.

**Tech stack:** Rust, Electron, systemd/logind, Linux process descriptors, Ed25519, native x64/ARM64 CI.

**Spec:** `docs/superpowers/specs/2026-11-08-linux-desktop-approval-service-design.md`.

**State:** Approved by the user on 2026-11-08. Implementation in progress on the existing isolated `feat/linux-appimage` branch from `fcfe71fd`. Preserve the shared checkout and the existing VM desktop workarounds. No protected-service installation or protected-action acceptance has been completed in the guest.

## Global constraints

- Root broker; daemon runs as the registered desktop UID, never root.
- No trust promotion of legacy authority files, no key reset for repair, no receipt bypass or weaker Linux jail policy.
- No changes to Mac/Windows attestation or Linux SSH/phone authorization policy.
- No automatic elevation, updater, logout lingering or publisher-key enrollment.
- Explicitly disclose that unrestricted programs under the same account can potentially inject into or automate the trusted UI. This cannot provide macOS dynamic code-signature guarantees.
- Omarchy ARM64 acceptance does not establish Ubuntu or x64 desktop acceptance.
- Preserve the Chromium sandbox; do not use `--no-sandbox` to pass acceptance.

## Concrete decisions for review

### 1. Registration and login lifecycle

Use `/var/lib/apex-deck-provenance/` for authority, `/run/apex-deck/provenance.sock` for the socket, and `/opt/apex-deck/<version>-<commit>-<arch>/` for verified payloads. Ancestors are root-owned and not writable by desktop accounts. A root-owned active-install descriptor selects one immutable tree; callers cannot override these paths with environment variables.

Administrator installation registers an ordinary account through a bounded local enrollment request: the installer reads the requester's UID from kernel socket credentials, resolves it through NSS, and requires administrator authorization for that exact UID. A username or UID in JSON, `SUDO_UID`, or the environment is not identity. Do not register root. Store the account's home, primary group and canonical data directory in root-owned registration; resolve and compare the canonical directory again on each operation. Existing journal keys already separate UID and canonical data directory. Two registered users must never share an authority scope.

Install `apex-deck-provenance.service` as a root system service. Install `apex-deck-daemon@.service` as a system template with `User=%i`, root-generated fixed per-user arguments, clean environment, `Restart=on-failure`, and `Requires=`/`After=` the broker. A root-owned dependency under `user@<uid>.service.wants/` activates the corresponding daemon; `BindsTo=user@<uid>.service` and `After=user@<uid>.service` stop it with that user manager. Quitting the UI leaves the engine running. Logout follows logind's normal user-manager stop delay. Never call `loginctl enable-linger`. Refuse silent enrollment of an already lingering account and explain that continuing would keep the engine alive after logout; require an explicit installer option for that case. Test enrollment during an existing session as well as a fresh login.

The launcher's executable and arguments are root-owned. It launches the installed UI as the desktop user in the existing graphical session, using a narrowly enumerated display/session environment. The daemon remains non-graphical. User launchers and user units are convenience entry points, never evidence for issuing a receipt.

### 2. Publisher trust and bootstrap

There is currently no Linux publisher-signing bootstrap in the AppImage workflow; its `.sha256` file authenticates nothing by itself. Add a dedicated Linux Ed25519 release key, distinct from each host's broker key. The public trust root must be embedded in an independently obtained installer/verifier and confirmed through a separate authenticated channel. Never accept a key supplied by the downloaded payload or manifest. No production private key is created or uploaded without the user's key-provisioning decision.

For this VM milestone, use a separately generated **evaluation** signing identity and an explicitly provisioned evaluation verifier, with its fingerprint read back on the host and guest. Keep the private key outside Git and artifacts. Mark evaluation installation and artifacts visibly; it is not a publisher-authenticated public release. Evaluation key selection must be a separate build-time verifier configuration, with no runtime unsigned/install-any-key bypass in the production verifier. Production packaging remains disabled until a publisher public key is provisioned.

Sign the exact manifest bytes (bounded JSON, strict schema). Include architecture, version, source commit, protocol version, payload archive digest/size, and the complete relative file list with type, size, mode and SHA-256. Verify signature and archive digest **before** privileged extraction, from a root-owned staged copy. Bound extraction sizes/counts; reject absolute/traversal paths, duplicates, links, devices, FIFOs, setuid/setgid payloads and unlisted entries. Extract only regular files/directories into a new root-owned staging tree. Do not run an AppImage as root to extract it. Validate the complete tree and directory ancestry again before activation.

Require safe Electron fuses, packaged ASAR/preloads, pinned native libraries and a working supported sandbox. Refuse debug switches, external-code loading and environment overrides. Install a sandbox helper only if a separately reviewed supported sandbox configuration requires it; never import arbitrary privileged mode bits from an archive. A protected launcher must clear injection variables before Electron starts, because a JavaScript check runs too late for loader injection. Its launch attestation must bind the target process generation and active installation. Linux cannot close all same-account injection avenues; disclose this residual limit rather than relaxing the checks.

Production key rotation requires a new trust bundle signed by the currently enrolled publisher key and an increasing trust-bundle revision. Removing a compromised root requires administrator provisioning through the independent bootstrap channel. Evaluation trust must never become production trust through an ordinary payload update.

### 3. Crash-safe activation and rollback

Use one root-held installation lock, a durable transaction record and one atomic active-install descriptor; do not select UI and broker versions through separate mutable pointers. The descriptor names the immutable tree, manifest digest, protocol version and increasing installation epoch. Stage and validate the whole new tree before stopping service clients. Stop registered daemons and disable new admissions, drain or reject in-flight work, close old broker connections, then durably advance the epoch and descriptor before starting the new broker and daemons. Check active-version health before reopening admissions. Old UI processes fail new peer checks and show a relaunch instruction.

Add an optional installation-epoch binding to Linux receipts and persisted journal entries; require it for Linux issue/claim. Mac/Windows wire behavior remains unchanged. Keep signing keys, consumed receipts, revocations, host lock records and protected documents across activation. A rollback is a new transaction to a previously verified tree with a **new higher epoch**, never restoration of an old journal or transaction counter. Linux schema/protocol compatibility is explicit; refuse rollback to a version that cannot read the current journal. Linux activation epochs and journal compaction generations are different concepts.

On startup, incomplete transactions keep admissions closed. Recover to one fully verified compatible descriptor using the transaction record, retaining the higher epoch. Never silently choose old pins or discard a journal to get a service running. Fault-injection tests kill the installer after every fsync/rename/service boundary. Repair preserves authority; uninstall removes units and executable trees while retaining authority unless deletion is separately requested.

## Review focus

1. PID reuse, exit, exec and inherited socket races must not transfer a trusted connection to a different process generation.
2. A real pinned Electron executable loading unpinned ASAR/preload/library/environment content must be refused.
3. Mixed versions, old live UI processes and replayed pre-update receipts must remain refused after crash and rollback.
4. Concurrent desktop accounts, symlinked data directories and lingering user managers must preserve scope and declared lifecycle.
5. Existing Mac/Windows and Linux remote authorization behavior must stay unchanged.

## Implementation tasks and test gates

### Task 1: Signed payload and explicit installer

**Create:** `crates/apex-provenance/src/linux_install.rs`, `scripts/package-linux-protected.mjs`, `scripts/install-linux-provenance.sh`, `tests/linux-protected-package.test.mjs`.
**Modify:** `.github/workflows/linux-appimage.yml`, `crates/apex-provenance/src/main.rs`, and package scripts only as required.
**Interface:** a bounded signed `LinuxReleaseManifest` and root-controlled `LinuxActiveInstall`/`LinuxRegistration`; no caller-selected verification key or authority root in production.

- [ ] Write and run failing tests for a forged signature, wrong architecture, self-supplied key, archive escape/link/duplicate, hash mismatch, unsigned extra file and writable ancestor. Assert no active installation changes.
- [ ] Implement signature verification, bounded extraction from root staging, explicit kernel-UID enrollment and separate evaluation build configuration.
- [ ] Run negative tests to green; test a signed valid fixture and fingerprint read-back. Verify private keys never enter Git, logs or artifacts.
- [ ] Commit scoped changes and test results.

### Task 2: Linux peer attestation and protocol paths

**Create:** `crates/apex-provenance/src/linux.rs`, `crates/apex-provenance/tests/linux_peer.rs`.
**Modify:** `crates/apex-provenance/src/{main_unix,lib,io,ownership}.rs`, `desktop/provenance.mjs`, `tests/desktop-provenance.test.mjs`.
**Interface:** authenticate one accepted stream to a held process identity, real UID, role and active epoch; pass that single identity to the existing bounded broker dispatch. Linux CLI issuance stays disabled in this milestone.

- [ ] Write failing native tests for raw socket issuance, copied binaries, daemon-as-UI, changed ASAR/preload, debug launches, loader injection and process-generation changes. Reject operations without modifying the journal.
- [ ] Implement Linux-only fixed roots/socket/public-key validation, `SO_PEERCRED`, held process reference and generation/liveness checks before and after inspection and at each request. Prefer kernel-supplied socket PID descriptors where supported; an older-kernel path must prove generation binding or fail closed, never rely on a pathname alone. Verify immutable manifest pins, process image/resources/maps, command line, environment and launcher attestation. Namespace or `/proc` inspection failure is rejection.
- [ ] Add Linux installation-epoch validation with durable journal storage; test exact command, UID/data directory, one-use claim, revocation and restart replay rejection. Inherited sockets and exec transitions must fail.
- [ ] Run broker tests, production-storage tests and platform regression tests; commit.

### Task 3: Root-controlled lifecycle and installed UI

**Create:** `desktop/linuxService.mjs`, root systemd unit templates under `resources/linux/`, `tests/linux-service.test.mjs`.
**Modify:** `desktop/main.mjs`, installed-app selection module, `src/SettingsPage.tsx`, installer registration/lifecycle code.
**Interface:** validated installed UI/daemon selection; root-generated registration selects canonical data folder and stable daemon binary. Portable UI returns a repair/install explanation.

- [ ] Write failing tests for forged user units, arbitrary UID registration, wrong installed version, user daemon replacing protected daemon, duplicate hosts and missing/stopped broker.
- [ ] Implement root-owned activation tied to `user@<uid>.service`, user-run daemon, fixed launch environment and fail-closed installed UI routing. Show the Linux same-account safety disclosure before first protected submission; persist its acceptance in protected scope without letting that acknowledgment grant command authority.
- [ ] Verify quit leaves the daemon running, logout/login lifecycle, crash restart, two users and explicit linger behavior in disposable Linux sessions. Preserve the VM's graphics environment only through the launcher's reviewed display allowlist.
- [ ] Commit; do not infer native lifecycle success from text-template tests alone.

### Task 4: Durable updates, rollback and uninstall

**Modify:** Linux installation code and Linux receipt/journal integration.
**Create:** `crates/apex-provenance/tests/linux_install_recovery.rs`.

- [ ] Write failing crash/fault tests for every transaction boundary, concurrent installs, old UI connections, old receipts, protocol incompatibility and rollback after receipt consumption/revocation.
- [ ] Implement the locked, staged activation transaction and startup recovery above. Add explicit administrator update, repair, rollback and uninstall commands; no automatic updater.
- [ ] Prove rollback retains higher epochs and monotonic authority. Uninstall preserves authority by default. Commit.

### Task 5: Build, independent review and Omarchy acceptance

**Create:** `scripts/acceptance-linux-provenance.sh`, `docs/security/linux-provenance-acceptance.md`.

- [ ] Run `npx tsc --noEmit`, `npm test`, broker/daemon/host production-storage suites and committed-lockfile bridge tests. Record failures by name; do not claim green from targeted checks alone.
- [ ] Build and inspect native x64 and ARM64 protected artifacts in Linux CI. Retain commit stamps, manifest/signature, file inventory and test output. Do not build a macOS DMG for this task.
- [ ] Perform a fresh whole-change security review before guest installation; resolve important findings with regression tests. Review specifically all five focus items above.
- [ ] Confirm VM architecture, current session and available administrator authorization without requesting/storing a password. Provision only the evaluation verifier after independently comparing fingerprints. Preserve current user data and desktop configuration.
- [ ] Install the ARM64 evaluation payload. Observe installed UI creating a test chat, posting to it, displaying a real pending protected operation, approving it, observing the result, rejecting another operation and confirming no effect. A receipt or approval card alone is not execution proof. Use a harmless temporary test file; never let an automated script manufacture the UI receipt.
- [ ] Restart broker/daemon/UI and repeat fresh protected submission. Test forged/raw requests, wrong data directory, modified resources, replay after restart, missing broker and revoked grants; record no unexpected state changes.
- [ ] Test a new desktop login, crash recovery, evaluation upgrade and rollback; cold launch and read back exact installed commit/epoch. Run Linux remote-policy and Mac/Windows regression checks.
- [ ] Record observed results and remaining x64/Ubuntu desktop acceptance separately. Update the design status only to the level supported by evidence. Leave the PR unmerged unless merging is authorized.

## Reference checks

Kernel credential and process-descriptor semantics: https://man7.org/linux/man-pages/man7/unix.7.html and https://man7.org/linux/man-pages/man2/pidfd_open.2.html . A PID descriptor opened later from an integer PID is not, by itself, proof of the socket peer's original process generation; tests and fail-closed handling must cover that race.
