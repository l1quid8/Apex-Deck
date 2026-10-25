# Windows M1: daemon implementation and review

Status: M1 implementation is ready for Jigga's final review. All eight IPC
callers have migrated, and native Windows run `40195474923` at `eda9c79`
passed the full Windows job: 1,399 tests passed, seven ignored, zero failed.
The independent Windows IPC/privacy/lock harness passed all 27 tests. macOS,
both Linux jobs, and Linux release builds passed in the same run.

The three conditions from Jigga's IPC review were met before the remaining
callers moved. Windows `continue-on-error` is now removed; subsequent runs
therefore enforce Windows success in the workflow. No merge into main is authorized or performed.
This establishes the daemon's build/test milestone, not a native Windows app
release or real-PC bot/provider validation. The fail-closed limitations below
remain explicit follow-up work.

## Interface

`apex_daemon::ipc` provides:

- `endpoint(data: &Path) -> io::Result<PathBuf>`
- `listen(path: &Path) -> io::Result<Listener>`; call inside an I/O-enabled Tokio runtime
- `Listener::accept(&mut self) -> io::Result<Stream>` (async)
- `connect(path: &Path) -> io::Result<Stream>` (async)
- `connect_blocking(path: &Path) -> io::Result<BlockingStream>`
- `split(Stream) -> (ReadHalf, WriteHalf)`

`Stream` implements async read/write. `BlockingStream` supports `try_clone`
and synchronous read/write. `stdio` and `local_call` consume these types now.

Unix retains `daemon.sock`, the existing 100-byte pathname limit, mode 0600,
and a current-UID peer check. The caller owns private-directory setup and
stale-socket cleanup. In-process `--stdio` still works with a data path too
long for a socket.

Windows uses a pipe name containing the current user's SID and SHA-256 of
the canonical UTF-16 data path, after creating the directory. This collapses
case differences and junction aliases. If canonicalization is unavailable,
it falls back to the absolute, lexically normalized path. The initial listener
requires the first pipe instance. Each instance has a protected, explicit
current-user-only DACL and owner, rejects remote clients, and is not
inheritable. Clients verify the opened pipe's owner before returning it and
use identification-level QoS. A busy pipe gets a bounded two-second retry.
Accept preserves its pending instance across cancellation and creates the
next instance before returning an accepted stream.

## EOF and stdio

Unix relays keep their existing write-half shutdown. Windows pipes need a
local protocol marker: `{"id":0,"cmd":"input_closed"}`. After hello, it
stops further input and drains replies under the existing grace deadline;
it produces no reply of its own. Token and paired-device connections receive
a refusal and remain usable. The relay completes a final unterminated JSON
line before appending the marker. Original Windows protocol handles have
inheritance cleared as well as being duplicated into noninheritable handles.

## Settings and CI prerequisites

- Windows data defaults to `%APPDATA%/Apex Deck`, falling back to the home
  directory's `AppData/Roaming/Apex Deck` (HOME, then USERPROFILE).
- Windows shutdown listens for Ctrl-C, console close, and system shutdown.
- Unix file modes and libc dependency are platform-gated; usage readers fall
  back to USERPROFILE.
- Newly merged provenance code gets an explicit unsupported-platform boundary.
  Protected authority operations refuse access on Windows. Existing host
  startup can degrade without authority; this does not implement Windows
  protected ledgers or the assistant worker's authority service.
- Platform test expectations and a gateway listener-close race from CI run
  `40186059583` are repaired. The existing browser terminal shortcut forwarding
  mismatch is saved separately from the Windows changes.

## Verification

- `npx tsc --noEmit`: passed.
- `npm test`: 2,524 passed, three skipped, zero failed.
- `TMPDIR=/tmp cargo test --locked -p apex-core -p apex-adapters -p apex-host -p apex-daemon --features apex-daemon/remote`:
  1,535 passed, 13 ignored, zero failed. The default long macOS TMPDIR first
  exposed three existing pairing-fixture socket-path failures; `/tmp` avoids
  that fixture constraint without changing production paths.
- `cargo test --locked -p apex-provenance --lib -p apex-pairing`:
  63 passed, zero failed.
- `cargo test --locked -p apex-host-production-check` run separately:
  three passed, zero failed.
- An isolated temporary crate imported this repository's IPC, signals, files,
  and Windows `take_stdio` code. `cargo check --tests --target x86_64-pc-windows-msvc`
  passed with Tokio 1.53.1 and windows-sys 0.61.2. This is a source compilation
  check, not a linked full-daemon build or Windows runtime test.
- Unix IPC, local EOF, and relay framing tests were observed failing before
  their implementations and passing afterward. A fresh read-only code review
  found no critical or important issue in this checkpoint.

## After Jigga's review

1. Migrate `serve.rs`, `pair_cli.rs`, `pair_commands.rs`, `gateway_cli.rs`,
   `devices_cli.rs`, and `phone_cli.rs`; use COMPUTERNAME on Windows.
2. Establish a private Windows data-directory ACL before publishing tokens,
   including custom `--data-dir` locations. APPDATA inheritance alone does
   not secure a shared custom parent.
3. Port or gate Unix-dependent fixtures, permissions, symlinks, and shell
   commands; run actual pipe ACL, owner, cancellation, retry, and EOF tests
   on the Windows runner.
4. Endpoint spelling now uses the canonical Windows directory; keep endpoint
   derivation in the daemon rather than duplicating it in JavaScript.
5. Keep Windows `continue-on-error` until its full job passes. Linux and Mac
   CI must also pass. Implement/review secure Windows protected authority
   before claiming feature parity for protected assistant functionality.

Never push or merge main from this checkpoint.

## Jigga review fixes

- Added a required independent `test-windows-ipc` CI job using `apex-ipc-check`,
  which imports the production IPC module directly rather than a copy.
- Documented that Windows `BlockingStream` clones cannot read and write
  concurrently. Pairing continues to require async `Client`.
- Run `40188870576` executed 15 tests on Windows: the 12 pre-existing transport
  and security tests passed; three new regressions failed as expected on the
  old endpoint implementation (directory creation, case, junction aliases).
  Canonicalization is now implemented; the next Windows run is the gate
  before migrating callers.

- Run `40189074617`, job `121156001494`, passed all 15 IPC tests on Windows.
  This cleared the review gate before the caller migration started.

## Remaining caller migration

- `serve`, `pair`, `remote`, `devices`, `keys`, and `phone` now use IPC.
  Pairing and test connections retain independent async reads and writes.
- Windows skips Unix socket-file cleanup, names pipe collisions clearly,
  uses `COMPUTERNAME`, and redirects closed stderr to NUL during shutdown.
- Windows data roots receive a verified, protected current-user-only
  inheritable DACL before the data lock or daemon token is published. Newly
  written private files receive an explicit owner-only ACL at creation,
  verified before contents are written, including in public custom parents.
  Root preparation preserves existing child ACLs; it does not repair an
  arbitrary existing tree or certify all storage against hostile ancestor
  mutation. Protected-authority support remains unavailable on Windows.
- POSIX-only shell, signal, FIFO, mode, and symlink fixtures are gated
  narrowly. Portable lifecycle, attach, token, import, and protocol checks
  remain enabled. Added a real Windows broken-stderr shutdown regression.
- The independent Windows harness now covers 24 tests, including private-root
  inheritance, junction aliases, existing-child ACL preservation, explicit
  private-file creation, and private-file replacement. Runtime results for
  these additional tests passed on Windows in run `40190007394`, job
  `121158783308` (24 passed, zero failed).
- Local checks passed: TypeScript; 2,524 app tests (3 skipped); the CI Rust
  suite with TMPDIR=/tmp (1,535 passed, 13 ignored); pairing/provenance
  (63 passed); standalone production checks (3 passed); Unix IPC harness
  (8 passed); and Windows harness cross-compilation.
- A fresh read-only review found no critical or important migration issue.
  Windows runtime verification and final Jigga review remain required.
- Linux CI exposed a noisy whole-process FD-count test. It now runs its
  original 50-fold check in an isolated test process with the same threshold;
  the isolated test passed locally and both Linux CI jobs passed at `2d6beae`.
- A deterministic same-size Git edit regression was then observed failing
  on Linux in run `40190253331` (the snapshot returned old contents).
  Temporary snapshots now preserve the source index timestamp so Git keeps
  its racy-clean detection. Source index bytes and timestamp remain unchanged.
- Native Windows compilation exposed the Mac phone-bridge example and a
  chmod-based failure fixture. Those now compile only on supported platforms.
  The full local Rust CI suite passed again after these fixes (1,536 passed,
  13 ignored). The standalone mobile lockfile now includes the two Windows
  dependency entries; its 18 tests passed with `--locked` locally.

## Native Windows runtime follow-up

Run `40190900867` passed the macOS and both Linux CI jobs. Its required
independent Windows IPC job passed all 24 transport, private-root, and private-file
tests. The full Windows job compiled every selected crate and target, but its
runtime tests failed. Compilation and the independent IPC result do not establish
full Windows runtime support.

The runtime failures identified these shared causes:

- Storage writers attempted the Unix directory-open/fsync pattern on Windows,
  producing `Could not save data: Access is denied. (os error 5)`. Avatar jobs
  and generated assets also reopened temporary files read-only before flushing,
  which Windows refuses. These failures caused many downstream poisoned-lock
  errors. Shared helpers now write and flush through the same writable handle,
  close it before atomic replacement, and retain parent-directory fsync on Unix.
  Windows skips that directory operation; this does not promise equivalent
  Windows directory-entry durability.
- Windows whole-file locks prevented other handles from reading the owner
  description in `owner.lock`. Windows now uses an exclusive, nonblocking
  `LockFileEx` lock on one shared byte at offset `0x7fff_ffff_ffff_fffe`, beyond
  the owner text. The description stays readable, the held handle retains
  ownership, and closing it releases the lock. Only `ERROR_LOCK_VIOLATION`
  maps to contention; other native errors remain failures. Unix locking is
  unchanged. [Microsoft documents beyond-EOF byte-range locks](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex).
- Git for Windows rejected Rust's verbatim canonical worktree paths. Ordinary
  disk and UNC spellings are now supplied at external command and Git environment
  boundaries; native paths remain internal. Test comparisons also account for
  Git's slash spelling and Windows path components.
- Platform fixtures assumed POSIX shell output, path separators, symlink
  privileges, file modes, and deletion or recovery support. Portable behavior
  remains tested; platform-specific expectations now match the implemented
  boundary rather than bypassing it.

Windows Git link materialization also remains unsupported: mode `120000` cannot
reliably distinguish file targets from directory targets. Bot-copy merge and apply
now refuse such entries before any destination writes. New Windows regressions
check that an existing destination, an earlier ordinary-file change, and directory
contents survive the refusal. A portable fixture constructs the Git link mode
without requiring OS symlink privileges. Both Windows merge/apply refusal regressions passed in run `40193165652`.

The remaining Windows limits are explicit and fail closed: protected-authority
operations are unavailable; secure Codex/ChatGPT-generated avatar file reads
require the Unix no-follow implementation; safe checkpoint deletion is unavailable;
and orphan worker process-tree recovery requires manual cleanup. The orphan registry
entry is preserved, and Windows startup refuses to claim recovery succeeded.
These changes do not implement those missing capabilities.

Current verification:

- The full selected local Rust CI command passed after the runtime fixes:
  1,536 passed, 13 ignored, zero failed. After the link-mode guard, the full
  command passed again with 1,537 passed, 13 ignored, zero failed. TypeScript
  also passed; the separate production-check target passed all three tests.
- After adding the link-mode guard and regression fixtures, the focused bot-copy
  suite passed 42 tests locally. This is separate from the preceding full-suite
  count and does not execute the Windows-only cases on macOS.
- Storage passed 18 focused macOS tests; avatar handling passed 13. The lock
  filter passed 21 matches, including all three data-lock tests.
- `cargo check --locked -p apex-ipc-check --tests --target x86_64-pc-windows-msvc`
  passed with the real host lock source imported. The independent Windows harness
  includes those three lock tests. Run `40193165652`, job `121168314462`,
  executed all 27 tests successfully on Windows (zero failures).
- A fresh read-only source review reported no remaining critical or important
  findings after the link-materialization preflight fix. Final Jigga acceptance
  remains pending.

At this checkpoint, full Windows runtime and final Jigga review remained the
acceptance gates. Later native results are recorded below.

## Second native runtime pass

At `37bda05`, run `40193165652` passed macOS, Linux x64, Linux ARM, and
the expanded 27-test Windows IPC/privacy/lock harness. All adapter tests passed.
The Windows host library reached 632 passed, two failed, and four ignored; its
new Git-path, directory-link refusal, storage, and locking cases passed. The run
was cancelled after a host integration fixture stopped making progress, to
retrieve diagnostics. The daemon test step had not started.

The remaining source fixes are deliberately scoped:

- Windows verification commands now use raw `cmd /D /S /C` shell source inside
  an outer quote pair; ordinary process-argument escaping corrupted quoted
  paths. The existing quoted counter-path regression stays enabled.
- The failed-verification fixture creates the directory whose emptiness it
  checks. Windows does not persist a process-recovery manifest there.
- Headless PTY fixtures answer the initial ConPTY cursor-position query, as a
  real terminal renderer does, and accumulate output across event boundaries.
  [Microsoft documents this response requirement](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole).
- The failed room-replacement fixture uses sibling project and data folders,
  avoiding snapshots of the host's own changing snapshot repositories. Its
  failed-save injection and original-folder/history assertions remain intact.
  Two integration fixtures now have external 90-second deadlines covering
  synchronous calls and runtime teardown. Native execution must establish
  whether these changes resolve the stall.
- The 50-fold descriptor-count test runs only on Unix, where it measures real
  descriptors; its previous Windows counter was a constant zero. Unix retains
  the original 50 iterations and five-descriptor allowance.
- The avatar RPC fixture's pending loop and the Windows CI job now have
  deadlines. The avatar fixture had passed natively; its timeout is diagnostic
  hardening, not an explanation of the integration stall.

Focused local host integration tests passed 20/20; the quoted-command and
failed-verification tests each passed, and Windows command construction compiled.
At this checkpoint, a follow-up native Windows run remained required before
removing `continue-on-error` or declaring M1 complete.

## Final Windows test correction

Run `40194548255` at `85d6c04` passed the complete Windows core/adapters/host
step (including 633 host unit tests and both host integration targets), all
daemon integration targets, and the 35-test provenance target. Daemon tests
verified private-pipe attachment, CLI device management, chat/terminal/restart
over stdio and WebSocket, token handling, stdin-close shutdown, and broken-stderr
shutdown. macOS and both Linux jobs also passed.

Only `gateway_admin::tests::listener_controls_persist_and_failed_rebind_keeps_the_old_listener`
failed: its 500 ms timeout elapsed while awaiting a post-disable TCP connection
result. The log did not establish that a connection succeeded after disable.
The test retains the actual negative connection check, gives Windows five seconds
to report refusal (Unix stays at 500 ms), now requires `ConnectionRefused`, and
reports completed successful connections if the timeout expires. Timeout remains
a failure. Production listener behavior is unchanged. Native verification of
this correction passed in run `40195474923`: all 221 daemon unit tests, every
daemon integration target, and the complete Windows job were green.

## M1 acceptance evidence

[Run `40195474923`](https://github.com/l1quid8/Apex-Deck/actions/runs/40195474923)
at `eda9c7900aa3512af8672f6f3ebf17256e7255ea` passed every job. Full Windows
job `121175265229` executed 1,399 tests with zero failures and seven ignored;
independent Windows harness job `121175265129` passed 27/27. Native checks
include the full caller migration, privacy/ownership, path aliases, lock owner
reporting, symlink refusal, shell quoting, PTY cursor handshake, and lifecycle
regressions described above. Mac and both Linux jobs remained green.

The workflow now treats Windows failures as CI failures. Final Jigga review
remains required before integration.
No Windows installer, app UI, provider sign-in, Job Object behavior, or Windows 11
PC acceptance is claimed by this M1 evidence.
