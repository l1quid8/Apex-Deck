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
