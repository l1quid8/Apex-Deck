# Windows M1: settings and IPC review

Status: M1 steps 1–2 are implemented on `feat/windows-11`, based on the
`c48e7fb` catch-up. Jigga reviews this interface before the remaining callers
move. This checkpoint is not a completed Windows daemon or a Windows release.

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
the absolute, lexically normalized UTF-16 data path. The initial listener
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
4. Confirm endpoint spelling rules before Electron integration: lexical
   normalization does not collapse case differences or junction aliases.
5. Keep Windows `continue-on-error` until its full job passes. Linux and Mac
   CI must also pass. Implement/review secure Windows protected authority
   before claiming feature parity for protected assistant functionality.

Never push or merge main from this checkpoint.
