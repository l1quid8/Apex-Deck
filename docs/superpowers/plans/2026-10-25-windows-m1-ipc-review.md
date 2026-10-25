# Windows M1: settings and IPC review

Status: M1 steps 1–2 were approved by Jigga. His three follow-ups are fixed,
and the 15 IPC tests passed on Windows before the remaining callers moved.
The caller migration is implemented on `feat/windows-11`, based on the
`c48e7fb` catch-up, and awaits full Windows CI and Jigga's final review.
This checkpoint is not a completed Windows daemon or a Windows release.

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
