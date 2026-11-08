# SSH and Linux jail merge review, 2026-11-03

**Decision: hold the merge into main and the release.** The implementation has
security and functionality gaps in requirements previously marked complete.
Passing headless tests does not establish confinement or release readiness.

## Candidate and re-sync

- Feature before re-sync: `db69c6f2` (`feat/add-machine-ssh`).
- Main being integrated: `646722ba`.
- Resolved `command.rs` using the actual merged registry: 229 commands (main's
  226 plus `folder_accept`, `folder_withdraw`, and `trust_status`).
- Resolved `host.rs` preserving stop/reap/MCP invalidation before saving an
  access change, and main's `AccessChanged` notification. Capture whether the
  room was busy before stopping it.
- The new exhaustive `access_effect` match exposed eight commands added on
  main. Classify each explicitly. Watch settings carry a provider profile and
  are conservatively classified as raising; quota refresh, restart using saved
  access, coordinator connection/stop, proposal-only entry, settled-task purge,
  and nonexecutable to-dos are non-raising. Extend the existing proof table.
- Leave the shared checkout's unrelated edits untouched.

## Blocking findings

### 1. Project operations do not implement the confinement boundary

`crates/apex-host/src/project_process.rs` returns ordinary `Command` objects.
Neither `command_in` nor `tokio_command_in` checks taint or constructs a jail.
`git_command` also omits the hardening flags described in its own comment.
`bot_copies.rs::get_ignored_new_in_work` calls that wrapper with `git status`
against project-controlled repository config. Project and runner checks use
the unconfined generic wrappers.

Local reproduction: `git status --ignored --porcelain -z` with the wrapper's
environment settings against a temporary repository containing a planted
`core.fsmonitor` script exited 0 and wrote a marker outside that repository.
This reproduction exercises the Git arguments/environment, not the complete
bot-copy host API; that API regression is still required.

Required regression: invoke the actual bot-copy path with a planted fsmonitor
script that writes outside a tainted project, and run a project check that
tries to read a protected data-folder marker. The operations must run in a
jail or be refused. Adding Git flags alone does not confine project scripts.

### 2. Trust reset does not reliably terminate the old authority

`crates/apex-daemon/src/trust_host.rs::stop_daemon` compares 12-byte windows
with the 11-byte string `apex-daemon`, so that kill condition never matches.
Removing `daemon.sock` does not terminate an established iroh connection.
`remote.rs` checks the epoch when admitting a connection; the non-raising
command path in `protocol.rs` does not recheck it for an existing session.

Required regression: keep an authenticated old device connected, reset trust,
and attempt `pty_spawn` over that connection. Verify daemon/process shutdown
and rejection of the old device. Scope shutdown to the intended daemon and
wait for termination; correcting the substring length alone is insufficient.

### 3. Trust can complete without the required reboot

The boot-ID comparison in `trust_host.rs::run` is conditional on the previous
record already being trusted. The initial pending record has `trusted:false`,
so a second invocation on the same boot proceeds to trust.

Required regression: two invocations with the same boot ID must remain
pending/refused; a changed boot ID may complete trust. Explicit `--no-reboot`
must retain its separate, accurately described behavior.

### 4. Folder acceptance is broader than the folder accepted

`crates/apex-core/src/folder_trust.rs::check_full_allowed` uses symmetric path
overlap for acceptance. Accepting `/repo/safe` can therefore authorize a Full
launch in `/repo`, including separately tainted `/repo/evil`.

Required regression: taint `/repo/evil`, accept `/repo/safe`, and require Full
execution in `/repo` to remain refused. Acceptance must cover the entire
requested execution folder.

### 5. The required trusted-device access-raise path is incomplete

The comment in `protocol.rs` claims old-level and folder checks occur under
the host's room lock, but the participant-update request/handler does not
require that binding. `command.rs::call_from_device` also retains the old
Linux protected-receipt path rather than the specified trusted-device route.
The raising-command trust check in `protocol.rs` is also unconditional across
platforms: a normal Mac/Windows host without the Linux trust record refuses
previously supported device commands. This violates the plan's platform scope.

Required regressions must exercise the real device command route: a stale old
level, a mismatched Full folder, and failed confinement must be refused
without modifying saved access; a current, authorized Linux raise must work.
Keep the local socket and SSH/CLI refusal intact.
Verify Mac/Windows device behavior remains supported without a Linux trust
record as well.

### 6. The phone's claimed biometric protection is absent

`src/phone/biometric.ts` imports an absent dependency and falls back to
`window.confirm`, including after authentication failure. Its exports have no
callers. `src/phoneBackend.ts` installs the command transport without a
biometric guard. Native `ApexSsh` authenticates saved-secret retrieval only.

Local reproduction in this review: with no native biometric plugin and a
confirmation stub returning true, the real `requireFaceId` returned true.
This is not biometric authentication.

Required regression: native biometric success must precede transmission of
a raising command; cancellation, unavailability, or failure must transmit no
command. A phone transport wrapper before `commandBackend` can cover typed
methods and raw calls. Do not retrieve an unrelated saved SSH secret to
authenticate an access change. Native-device acceptance remains required.

## Validation and limits

- `npx tsc --noEmit`: passed on the resolved tree.
- `TMPDIR=/tmp cargo check --locked -p apex-daemon --features remote`: initially
  failed on the eight unclassified merged commands; passed after explicit
  classification, with warnings.
- `npm test`: 3,343 passed, 1 failed, 3 skipped. The failure was
  `native external windows reopen after process exit with fresh snapshots and
  saved placement` in `tests/popout-window-restart.test.mjs`, where the save
  subprocess timed out. The isolated rerun passed (1/1). The original full
  run remains a failed run.
- `TMPDIR=/tmp cargo test --locked -p apex-core -p apex-adapters -p apex-host
  -p apex-daemon --features apex-daemon/remote --lib -- --test-threads=2`:
  passed, 1,878 tests and 18 ignored. Adapters 474 passed / 3 ignored; core
  97 passed; daemon 243 passed / 1 ignored; host 1,064 passed / 14 ignored.
  This is library coverage, not Linux kernel or installed-app acceptance.
- Fresh-context review identified the blocking findings above. The complete
  jail/proxy, snapshot implementation, every provider launch, and native SSH
  behavior have not received complete acceptance in this review.
- Docker arm64/x86_64, Ubuntu/AppArmor, X11, Git-version/Windows coverage,
  native iPhone checks, updater recipe preparation, and release approval
  remain open. No installer was built or release approved.

## Follow-up verification, 2026-11-07

The security-fix working tree is still on `fix/ssh-jail-security`; this
checkpoint does not lift the merge/release hold above.

- Reproduced Rust error E0308 in `git_changes::commit`: `root` resolved to the
  function because its local path binding was declared after its first use.
  Moved the binding before private-index construction.
- `npx tsc --noEmit`: passed.
- `npm test`: passed, 3,380 passed and 3 skipped, no failures.
  Log: `/tmp/apex-ssh-security-frontend-tests.log`.
- `TMPDIR=/tmp cargo test --locked -p apex-host --lib project_process`:
  passed, 5 tests, including construction-before-taint execution refusal.
- The resulting host test binary, invoked with `tainted_ --test-threads=2`:
  passed, 3 tests covering actual bot-copy fsmonitor, protected-marker project
  check, and configured runner-check paths. These are macOS refusal checks.
- The same host binary with `git_changes::tests --test-threads=2`: passed,
  11 tests, including selected commits and preservation of unrelated staging.
- `TMPDIR=/tmp cargo test --locked -p apex-daemon --features remote --lib
  trust_host`: passed, 9 tests covering boot-ID transitions and trust records.
  Log: `/tmp/apex-ssh-security-trust-tests.log`.
- Docker was initially unavailable; starting Docker restored the daemon.
  This checkpoint supplies no new Linux kernel or native-phone acceptance.
- The combined Rust library run (`cargo test --locked -p apex-core -p
  apex-adapters -p apex-host -p apex-daemon --features apex-daemon/remote --lib
  -- --test-threads=2`, with `TMPDIR=/tmp`) exited 143 while compiling, before
  any test result. The queued `cargo test --locked -p apex-daemon --features
  remote --test trust_reset` attempt also exited 143. The logs do not establish
  the cause; neither attempt counts as a pass or a test assertion failure.
  Logs: `/tmp/apex-ssh-security-rust-libs.log` and
  `/tmp/apex-ssh-security-trust-reset.log`.
  Combined Rust suites, live trust-reset checks, final review and merge remain
  required before closing the implementation.

## Resumed verification, 2026-11-07

No implementation files were changed during this verification pass. The
branch remains uncommitted; the merge hold remains in effect.

- `npx tsc --noEmit`: passed (exit 0).
- `node --experimental-strip-types --test tests/phone-biometric-transport.test.mjs`:
  35 passed, zero failures. Native biometric UI/command-transmission acceptance
  remains open. The shared phone was started and released, without installing
  or pairing an app; this supplies no native acceptance evidence.
- `TMPDIR=/tmp CARGO_BUILD_JOBS=2 cargo test --locked -p apex-daemon --features
  remote --test trust_reset`: passed, 1 test. The real temporary daemon, bot,
  and terminal stopped; the second daemon stayed available.
  Log: `/tmp/apex-ssh-security-trust-reset-retry.log`.
- `TMPDIR=/tmp cargo check --locked -p apex-daemon --features remote`: passed.
  Log: `/tmp/apex-ssh-security-check-current.log`.
- Ubuntu 24.04 arm64 Docker: `cargo check --locked -p apex-daemon --features
  remote`, with `CARGO_BUILD_JOBS=1`: passed. Log:
  `/tmp/apex-ssh-security-linux-check.log`. Compilation is not jail acceptance.
- Existing test binaries were invoked directly with `TMPDIR=/tmp` and
  `--test-threads=2`: core `apex_core-25196520490592dc` passed 101 tests;
  adapters `apex_adapters-3dd07bbae729b888` passed 474 with 3 ignored;
  daemon `apex_daemon-891ab2d048217b71` passed 262 with 1 ignored.
  These are direct-binary results, not a successful fresh combined Cargo run.
- Host `apex_host-733d93d8c7f1770a project_process --test-threads=2`:
  5 passed, including construction-before-taint execution refusal.
- **Host verification has an unresolved failure:** the broader direct-binary
  host run reported five standing-delegation failures before being killed
  (exit 137). An isolated `--exact --nocapture` rerun of
  `assistant_delegation::standing_tests::full_delegation_queues_and_runs_isolated_without_a_human_approval_card`
  failed with exit 101: the task remained Queued, with no attempts or execution
  thread, beyond the ten-second deadline at `standing_tests.rs:53`.
  Cause is not yet established; do not classify it as an unrelated flake.
  Log: `/tmp/apex-ssh-security-host-failure-retry.log`.
- Combined Cargo attempts still did not pass: the initial host run exited 143;
  the two-job retry reported `rustc` killed by SIGKILL compiling host tests.
  Linux test attempts exited 137 or lost their Docker client during compilation.
  The orphaned container from this pass was stopped before the retry.
- Kernel acceptance remains open: ordinary Docker bubblewrap execution refused
  namespace creation. A temporary container with SYS_ADMIN and unconfined
  seccomp still refused mounting `/proc`. Neither attempt ran the application
  confinement acceptance flow. No host kernel or Docker configuration changed.
- `git diff --check`: passed before this evidence-only update.

Next: diagnose the isolated standing-delegation timeout, rerun the integrated
host suites, and complete Linux/native-phone acceptance before final review,
commit, or merge.

## Delegation and Linux follow-up, 2026-11-07

- The isolated standing-delegation test passed unchanged in 5.97 seconds.
  Both direct-binary and fresh Cargo standing-delegation suites passed all
  16 tests (45.56 and 45.39 seconds). These reruns alone did not explain the
  previous timeout.
- Broader host verification reproduced two snapshot-save failures. In
  isolation, `a_stopped_job_still_saves_when_git_is_healthy` failed after
  2.40 seconds because the test's two-second stop grace expired. Owned-process
  cleanup scanned the complete macOS process table even for already-empty
  groups. Added an ESRCH-only fast path; all other outcomes retain conservative
  inspection. The unchanged regression then passed in 0.33 seconds. This
  removes demonstrated cleanup overhead without extending deadlines.
- A subsequent full host run exposed
  `pausing_during_a_hung_review_diff_leaves_the_job_paused_not_failed`:
  Failed rather than Interrupted, also reproduced alone. The Git wrapper
  prefixed cancellation errors, preventing the review-diff caller from
  recognizing them. Preserve the canonical limit reason when the limit ends.
  The unchanged regression passed after correction (4.25 seconds).
- The first full host attempt was deliberately terminated after the two
  snapshot failures. The next completed run, before the cancellation fix,
  reported 1,068 passed, one failed, 14 ignored. Neither counts as a pass.
- Final `TMPDIR=/tmp CARGO_BUILD_JOBS=1 cargo test --locked -p apex-host
  --lib -- --test-threads=2`: passed, 1,069 passed, zero failed, 14 ignored.
  Log: `/tmp/apex-ssh-host-final-current.log`.
- `TMPDIR=/tmp CARGO_BUILD_JOBS=1 cargo test --locked -p apex-adapters
  --lib owned_process -- --test-threads=1`: four passed.
  Log: `/tmp/apex-ssh-owned-process-current.log`.
- `bash tests/linux-jail/run.sh`: passed both before and after the cleanup
  correction, 32 reported passes each. The prescribed privileged container
  works; SYS_ADMIN plus unconfined seccomp alone was insufficient earlier.
  Final log: `/tmp/apex-ssh-kernel-cleanup-fixed.log`. Signed-in provider tests
  return early without APEX_JAIL_SIGNED_IN, which was not set: no signed-in
  login/refresh acceptance is claimed. This is arm64 Docker coverage only.
- Built current host tests in the Linux build image, then ran `project_process
  --test-threads=1 --nocapture` in the privileged spike image with
  APEX_JAIL_INIT pointing to the built daemon: five passed. This includes
  successful Git execution and construction-before-taint protection. The
  source-scan test cannot inspect the source tree in this runtime image;
  its non-vacuous scan is covered by the macOS suite. Logs:
  `/tmp/apex-ssh-linux-host-build.log`, `/tmp/apex-ssh-linux-host-current.log`.
- Fresh `npx tsc --noEmit` and `git diff --check`: passed.

The demonstrated host failures are corrected and the full host suite passes.
The earlier queued timeout is consistent with the removed cleanup overhead,
but was not independently reproduced after the correction. Native-phone
biometric command-transmission acceptance, final combined review and merge
remain open. No commit, merge, installer, or release was performed here.

## Native biometric boundary acceptance, 2026-11-07

Built an isolated copy of the current native phone wrapper, using the actual
`ApexSshPlugin` and production `guardPhoneCommands`, with a counting transport
instead of a paired machine. Bundle: `dev.apexdeck.biometricacceptance`.
No real daemon was paired or modified. This proves the native authentication
and command-release boundary; it is not full paired-phone settings UI or
physical-iPhone acceptance.

- Simulator: Deck-owned `0B6A0F54-12D8-4A02-8122-F330DD6613F5`.
- Native build passed with `xcodebuild -scheme App -destination id=<UDID>`;
  installed and launched successfully. Initial capture was blank while the
  webview loaded; subsequent captures displayed the fixture.
- Enrollment off: protected `folder_accept` was blocked, send count zero.
- Enrollment on: observed native Face ID prompt while send count stayed zero.
  A failed match showed native retry/cancel, with no passcode fallback.
  Cancelling returned BLOCKED with zero sends.
- A fresh attempt followed by biometric match returned AUTHENTICATED and
  incremented the send count exactly once.
- Another attempt required a fresh native prompt, with sends still one.
  Failure and cancellation did not reuse the previous success: BLOCKED, one send.
- Disabling enrollment after success also returned BLOCKED with one send.
  Restored original unenrolled state and released the phone.
- Captures: `/tmp/apex-native-biometric-evidence/` (eight named JPEG files).
  Initial build log: `/tmp/apex-native-biometric-build.log`.
- Added a reproducible fixture under `tests/native-phone-biometric/` with
  build instructions and the same production guard/native-plugin boundary.
  Its standalone TypeScript check passed. The fixture build script was rerun
  successfully; `/tmp/apex-native-biometric-repro.log` names its output/log.

Fresh combined verification on this branch:

- `npx tsc --noEmit`: passed.
- `npm test`: 3,380 passed, three skipped, zero failed.
  Log: `/tmp/apex-ssh-frontend-final.log`.
- `TMPDIR=/tmp CARGO_BUILD_JOBS=1 cargo test --locked -p apex-core
  -p apex-adapters -p apex-daemon --features apex-daemon/remote --lib
  -- --test-threads=2`: passed. Core 101; adapters 474 with three ignored;
  daemon 262 with one ignored. Log: `/tmp/apex-ssh-combined-final.log`.
- Fresh trust-reset integration: one passed; the target daemon and children
  stopped while the second daemon remained available.
  Log: `/tmp/apex-ssh-trust-reset-final.log`.

**Integration remains open:** main is now `5bd8772b`, 79 commits ahead of this
worktree's `7dc89342` base. The final combined review, reconciliation against
current main, post-integration checks, commit and merge are still required.
These passes must not be presented as validation of the newer main tree.

## Current-main integration review, 2026-11-07

Committed the scoped security changes as `59598e4f`, excluding the local
`node_modules` symlink. Integrated main `5bd8772b` on the task branch without
textual conflicts. The shared main checkout's untracked mockups remain intact.
The integration review is a Null self-review, not another model's sign-off.

The review and fresh combined checks identified these additional corrections:

- Two new handoff recovery calls and one new test on main needed the protected
  data-folder argument added to `WorkerTools::real`. The initial macOS/Linux
  builds failed with E0061; those callers now pass the host's data folder.
- Main added `AgentProfileSave` to the raising-command classification. The
  phone wire-boundary drift regression failed because it was not authenticated.
  Added `agent_profile_save` to the same native biometric guard. Focused phone
  transport tests passed all 35 tests; the full frontend rerun passed 3,460,
  with five skipped and zero failures. Logs:
  `/tmp/apex-ssh-current-main-phone.log` and
  `/tmp/apex-ssh-current-main-frontend-final.log`.
- A forged `old_level: full` classified a local Read-to-Full mutation as a
  non-raise, bypassing the Linux paired-device gate. A real protocol regression
  reproduced a successful saved raise. Local/token participant updates now
  retain their conservative refusal; only the device mutation route can use
  the downgrade exemption, with saved-level validation under its room lock.
  The unchanged regression passed after correction. Red/green logs:
  `/tmp/apex-ssh-forged-old-red.log` and
  `/tmp/apex-ssh-forged-old-green.log`.
- Linux Git menu snapshots kept their index in private `/tmp`, so each jailed
  invocation lost the previous command's index. A real jailed regression
  reproduced an empty tree and false deletions instead of a modified file.
  Keep that private index in the repository's actual Git directory, preserving
  the real staging index and respecting linked worktrees. Red log:
  `/tmp/apex-ssh-linux-index-red.log`; post-fix verification is pending below.

Fresh `npx tsc --noEmit` and `git diff --check` passed. The current-main Linux
kernel suite reported 32 passes (arm64 privileged Docker); signed-in provider
tests were not enabled. Log: `/tmp/apex-ssh-current-main-linux.log`.
Combined Rust suites, fresh trust-reset integration, post-fix Linux Git-menu
verification and the final integration commit remain pending at this checkpoint.
No merge to main, installer or release is claimed by this checkpoint.

### Integration verification results

- Combined current-main Cargo library run passed: core 113; adapters 475
  with three ignored; daemon (remote enabled) 283 with four ignored; host
  1,158 with 14 ignored. Zero failures. This run compiled before the final
  private-index correction, whose focused Linux checks are recorded next.
  Command: `TMPDIR=/tmp CARGO_BUILD_JOBS=1 cargo test --locked -p apex-core
  -p apex-adapters -p apex-host -p apex-daemon --features apex-daemon/remote
  --lib -- --test-threads=2`.
  Log: `/tmp/apex-ssh-current-main-rust-final.log`.
- Fresh subprocess trust-reset integration passed one test.
  Command: `TMPDIR=/tmp CARGO_BUILD_JOBS=1 cargo test --locked -p apex-daemon
  --features remote --test trust_reset -- --test-threads=1`.
  Log: `/tmp/apex-ssh-current-main-trust-reset.log`.
- `cargo check --locked -p apex-daemon --features remote` passed natively
  and in Ubuntu arm64 Docker (one build job). Logs:
  `/tmp/apex-ssh-current-main-check.log` and
  `/tmp/apex-ssh-current-main-linux-remote-check.log`.
- Rebuilt Linux host tests after the private-index correction and ran them
  in the privileged jail image with `APEX_JAIL_INIT=/tmp/apex-daemon`.
  Git-menu regression: one passed; project-process regressions: five passed;
  protected-data marker project check: one passed. The unchanged Git-menu
  regression now sees `+changed`, and the real staging index stays identical.
  Log: `/tmp/apex-ssh-linux-index-green.log`; build log:
  `/tmp/apex-ssh-current-main-linux-host-build-final.log`.
  The source scanner cannot inspect source in the runtime image; its real
  source scan is covered by the native host suite.

Validation limits remain: privileged arm64 Docker is not an AppArmor-enabled
Ubuntu VM, x86_64/x32, Windows CI, Git-version matrix, or signed-in provider
acceptance. Native biometric acceptance above used a counting transport,
not a fully paired settings UI or a physical iPhone. No installer was built,
installed or released. The original plan's release/recipe gates remain open.

The final native host rerun, rebuilt after the Git-index correction, passed
1,158 tests with 14 ignored and zero failures (189.55 seconds):
`TMPDIR=/tmp CARGO_BUILD_JOBS=1 cargo test --locked -p apex-host --lib
-- --test-threads=2`. Log: `/tmp/apex-ssh-current-main-host-final.log`.
A final production remote daemon check also passed, log:
`/tmp/apex-ssh-post-review-check.log`. All six reviewed implementation findings
are resolved at this scope; the earlier security implementation merge hold is
lifted. The authorized local main merge is the next repository operation.
