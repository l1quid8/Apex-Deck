# Windows M2 implementation handoff

This is an uncommitted Deck bot-copy change for Jigga's review and integration
onto `feat/win-m2-daemon`. No branch switch, commit, push, installer build, or
release was performed here. All deliverable edits are under `crates/`.
M2 remains open until Windows CI and the real-PC acceptance checks pass.

## Integration dependency

`apex-adapters` now uses the already-locked `windows-sys 0.61.2` package.
The root lockfile is outside Null's assigned scope, so the generated lockfile
change was excluded from this handoff. Add this single dependency entry to
`Cargo.lock`'s `apex-adapters` package before running checks with `--locked`:

```diff
  "serde_json",
  "tokio",
+ "windows-sys 0.61.2",
```

No package version upgrade is needed. Native Cargo validation used that generated
one-line lockfile update. Root `Cargo.lock` is restored to the incoming version
for fold-back.

## Forge's endpoint interface

`apex-daemon endpoint [--data-dir PATH]` prints one local address and exits.
`--data-dir` works before or after the command, using `data-dir`'s existing
resolution. Unix prints the socket path; Windows delegates to `ipc::endpoint`
for the user-scoped named pipe. No JavaScript hashing is needed. Conflicting
serve/stdio options fail with no stdout. The command does not start a daemon.

## Implementation and review focus

- `windows_job.rs` creates non-inheritable kill-on-close Jobs. A lifetime Job
  owns the daemon and automatically covers worker creation; each worker enters
  its own nested Job while suspended, then resumes. Stop terminates that worker
  Job and checks for zero active processes for up to 1.25 seconds. Assignment
  and resume failures kill the suspended child and return an error.
- `owned_process.rs` shares this ownership with CLI/API workers. Windows leaves
  no Unix PID manifests; imported manifests refuse safely. Unix process-group,
  birth-identity, and manifest behavior remains intact.
- Personal-assistant command futures use the same registry on Windows. Recovery
  checks FILETIME identity, never signals an unowned numeric PID, and refuses
  ambiguous live records.
- Executable lookup searches PATH in order and prefers `.exe`, then `.cmd`, then
  `.bat` in each directory. CLI/Codex launches and adjacent provider/MCP probes
  share it. Batch arguments remain separate for Rust's escaping. Gemini variant
  discovery recognizes Windows npm shims.
- API shell selection uses Git Bash from explicit/standard/custom Git locations,
  falling back to noninteractive PowerShell. The bot instructions name the
  selected shell. No `sh -c` fixtures run on Windows in `codex_server.rs`.
- Step labels unwrap Windows shell command wrappers. Browser lookup includes
  Chrome/Edge in per-user and both Program Files locations, plus Windows
  Playwright Chromium.

Please review nested Job admission, initial-thread resume identity checks,
cancellation and owner-death cleanup, batch-file quoting, and recovery's
fail-closed behavior before integrating.

## Windows checks still required

The full cross-target check cannot run on this Mac: the AWS-LC C dependency
requires the Windows SDK (`windows.h`). A temporary minimal crate compiling the
actual process/job/executable/shell/agent modules passed Windows type checking;
this is scoped compilation, not full Windows compilation or runtime evidence.
The personal command's Windows smoke test still requires the real host build.

New Windows runtime coverage is included for registry Stop, a leader exiting
before its descendants, owner death both before and after worker assignment,
spaced-path `.cmd` arguments, shell output/status/timeout, Gemini shim discovery,
process-identity recovery, and cancellation of a personal command with a child.
Ignored Rust subprocess fixtures are helpers invoked by those tests.

After integrating, push only `feat/win-m2-daemon`, run the full daemon workflow,
and review the Windows results. Do not mark M2 complete until Claude, Codex and
Gemini each reply on a real Windows 11 PC and Stop leaves no bot descendants.

## App-suite workspace issue

The initial `npm test` in this bot copy had 22 failures (2,517 passed, 3 skipped).
Errors include URL `.pathname` values retaining `%20` for this workspace's
`Application Support` path, shell exit 127, and Vite fixture import/mount failures.
The same application source passes from a temporary checkout without spaces:
2,539 passed, 3 skipped. No app/config files were edited to get that result.

Initial failures, all passing in the space-free snapshot:

- Artifacts follows the selected thread, preserves each view, and stays out of the transcript
- the assistant Details tab fits the side panel at its narrow widths
- the session strip stays inside a docked canvas and the capsule stays centred
- a problem banner does not turn the floating strip into a solid band
- authority comparison refuses a vanished lock directory even when it was empty
- an unreadable lock listing cannot prove there were no existing locks
- authority comparison rejects changed lock device, permissions, or a replaced authority directory
- new locks are allowed while preserved authority remains verifiable
- all chip styles preserve the live composer and bot actions in wide, narrow and folded layouts
- Model switching and supported speed selections persist when the quick selector reopens
- a popped-out chat waits for Deck, approves for both windows, and never closes the room
- composer access switches immediately, persists, and marks a busy change until idle
- desktop calls wait for an explicit singleton thread choice
- Inline Git card toggles and moves between replies, clears top-bar scope, and preserves guarded actions
- Library controls stay outside media and navigation resets the active preview
- Pair phone shows the QR without the link, renews an expired code, and approves in one card
- phone send retains text and selected file after oversized upload, then retries on the same link
- phone mic controls survive thread switches and never submit the composer
- Settings → Phones shows connections, turns them off and on, and asks after the last revoke
- projects group by host; saved drag, keyboard and menu order respects hosts and pinned areas
- add-project menu escapes sidebar clipping and worktree actions copy the full pathname
- folder switches dismiss Revert confirmations and discard plans from the previous folder

## Source fingerprints

- `crates/apex-adapters/src/windows_job.rs`: `8032d383a7940218322e8c2a9e8fe1341c28e3c7c03035fb05993e2c28d22f27`
- `crates/apex-adapters/src/executable.rs`: `b1f6be439ec37b4029756ea9ce69616504df88552bbb08ea360b20cce8a783d4`

## Native validation

- `npx tsc --noEmit`: passed in the bot copy.
- `TMPDIR=/tmp cargo test --locked -p apex-core -p apex-adapters -p apex-host -p apex-daemon --features apex-daemon/remote`: 1552 passed, 13 ignored, zero failures on macOS.
- `cargo test --locked -p apex-host-production-check` (separate invocation): 6 passed.
- `npm test` from the space-free verification snapshot: 2,539 passed, 3 skipped.
- `apex-daemon` endpoint integration tests: 2 passed, also included in the full Rust run.
- Scoped Windows process module and subprocess-test type checks: passed for `x86_64-pc-windows-msvc`, using Tokio 1.53.1 and windows-sys 0.61.2.
- `git diff --check`: passed.

No Windows runtime, real-PC bot exchange, installer or GitHub workflow was executed from this bot copy. Jigga's independent code review and CI are pending.
