# Windows CLI implementation plan

Goal: ship a standalone Windows x64 `apex` npm package that shares desktop
agents and threads and uses the existing protected authority service.

The user authorized starting this work after Linux publication and VPS
verification. The earlier chat selected MSVC builds on GitHub, a
`@apex-deck/cli-win32-x64` package, and admin enrollment of exact executable
paths and hashes. This worktree must not switch branches, commit, push, or
build installers; Deck incorporates its changes after the turn.

## First deliverable: Windows compile and test coverage

- [x] Remove unconditional Unix imports from the provider executable fixture.
  Keep platform-independent provider protocol tests enabled on Windows.
- [x] Use native absolute temporary paths in startup, authority and profile
  import fixtures; retain short Unix socket paths in transport fixtures.
- [x] Add `.github/workflows/cli-windows.yml`: explicit x64 MSVC toolchain,
  all-target CLI check, CLI tests, debug executable builds/version smoke tests,
  raw development artifacts, no npm publication or installer creation.
- [ ] Observe the workflow on a Windows runner after authorized integration.

## Protected commands and installation

- [ ] Add a distinct CLI pin and standalone daemon pin to the Windows broker;
  retain desktop pins and established keys/journals during either upgrade.
  Absent optional CLI pins must keep existing desktop installations working.
- [ ] Require exact protected path, SHA-256 and intact process for CLI peers.
  Keep the interactive typed-command allowlist; do not give the CLI generic
  UI authority, device pairing, or assistant-room permissions.
- [ ] Implement the Windows CLI receipt exchange with authenticated service
  identity, current SID scope, exact command binding and no automatic retry
  after an uncertain submission. Existing protected commands stay refused
  until this path is complete and reviewed.
- [ ] Add explicit admin setup/uninstall. Install only into protected system
  paths, reject reparse points and user-writable ancestry, refuse downgrade
  and active-process replacement, preserve desktop/service coexistence.
- [ ] If CLI setup ever registers a `schtasks` task, explicitly set
  `<Priority>5</Priority>` (Normal) in its task XML on install and upgrade;
  do not rely on Task Scheduler defaults, which can throttle CPU and I/O
  and delay approvals under load. Match the daemon's
  [`taskXml`](../../../desktop/winLogonTask.mjs) and add an assertion against
  the CLI-generated XML like the existing Priority 5 regression in
  [`desktop-win-logon-task.test.mjs`](../../../tests/desktop-win-logon-task.test.mjs).
- [ ] Test missing pins, changed bytes, copied binaries, wrong SID, fake pipe
  server, scope/command mismatch, uncertain outcomes and upgrade preservation.

## npm package and release build

- [ ] Add a Node launcher entry point compatible with npm's Windows shims;
  preserve existing Unix launcher behavior. Resolve only installed platform
  dependencies, never the current project or PATH for trusted executables.
- [ ] Add `npm/cli-win32-x64/package.json` and a Windows packager validating
  AMD64 PE binaries, version, complete file list and checksums. Include setup
  instructions and a clear statement that Windows agents lack OS isolation.
- [ ] Enable win32/x64 in the shared launcher only when setup/authority work.
  Select a fresh unpublished shared version at release time; 0.9.10 already
  exists and must not be overwritten.
- [ ] Review source before generating npm release artifacts. Extend the
  Windows workflow with release packaging only after that review.

## Acceptance before publication

- [ ] Clean standard-user npm install, explicit elevated setup, normal-user
  launch, shared desktop/CLI launch in both orders, updates and persistence.
- [ ] Official Claude/Codex login, live replies, settings, human approvals,
  cancellation, backend lifecycle, uninstall/reinstall and retained data.
- [ ] Reject uninstalled/tampered CLI approval attempts; verify the protected
  service still serves the installed desktop after CLI upgrades/uninstall.
- [ ] Run `npx tsc --noEmit` and relevant Rust/npm checks on final source.
- [ ] Verify signing status from actual artifacts. Existing Azure signing
  workflows authorize specific branches; do not assume this branch can sign.

Windows currently has process lifetime management, not Linux-style agent
isolation. A successful provenance check does not prove that a same-user
agent cannot operate a terminal or the desktop. Do not describe restricted
Windows agents as sandboxed or claim Linux's SSH-key protection there.

Current boundary: the first deliverable adds coverage and portability fixes.
No Windows workflow run, protected CLI submission, installer, npm tarball,
signature or live Windows reply has been verified by this change.

Local validation on macOS: `npx tsc --noEmit` passed; after building the
documented `apex-daemon-fixture` prerequisite, `cargo test --locked -p
apex-cli --lib --tests` passed 99 tests with 2 ignored and no failures.
The workflow YAML parsed successfully with Ruby YAML; `git diff --check`
passed. These checks do not establish a Windows compiler or runtime pass.
