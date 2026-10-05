# Phase 2: apex-daemon

Goal: a headless `apex-daemon` binary that wraps `apex_host::Host` and speaks
the remote protocol over stdio (SSH, Electron sidecar), a local socket, and a
localhost WebSocket. It runs on macOS and on Ubuntu Server (no GUI) under
systemd. The Tauri app is unchanged. Builds on phase 1 (`Host::call`, `Bus`
with `seq`, `Host::subscribe`).

## Protocol (v1)
Newline-delimited JSON frames, same on every transport.
- Client → daemon: `{"id": n, "cmd": "...", "args": {...}}` — `cmd`/`args`
  are exactly `apex_host::Command`.
- Reply: `{"id": n, "ok": value}` or `{"id": n, "err": "message"}`.
- Event: `{"seq": n, "event": name, "payload": {...}}` — `name`/`payload`
  are `HostEvent::name()` / `payload()`, i.e. what the desktop window gets.
- First frame must be `hello {protocol: 1, token?, since?: {boot_id, seq}}`.
  Reply: `{host_id, boot_id, protocol, last_seq, resumed: bool}`.
  - `host_id` is stable for a data dir (stored in `<data-dir>/host-id`).
  - `boot_id` is 16 random bytes (hex), new on every daemon start. `seq`
    restarts at 0 with it, so a `seq` only means something next to its
    `boot_id`.
  - `resumed: true` only when `since.boot_id` equals the current `boot_id`
    and `since.seq` is still in the replay buffer; the events after it
    follow. Otherwise `resumed: false` and the client must reload state
    (rooms list, session, settings) before trusting events.

## Steps
0. **Linux baseline.** Before any daemon code, prove the phase-1 crates
   build and pass on Ubuntu. `scripts/linux-test.sh` runs
   `cargo test -p apex-core -p apex-adapters -p apex-host` in an
   `ubuntu:24.04` Docker container (rustup installed in the image; cargo
   registry and `target/` in named volumes so reruns are fast). Fix any
   failure as its own commit, so Linux breakage from phase 1 is never
   mistaken for a phase-2 bug. `src-tauri` is excluded: it needs
   webkit2gtk and goes away in phase 3.
1. **Crate + CLI.** `crates/apex-daemon` (bin `apex-daemon`), workspace
   member. Subcommands: `serve [--port N] [--bind 127.0.0.1]`, `--stdio`,
   `--data-dir PATH`. The default data dir is the one Tauri's
   `app_data_dir()` gives the desktop for `dev.apexdeck.app`: macOS
   `~/Library/Application Support/dev.apexdeck.app`, Linux
   `$XDG_DATA_HOME/dev.apexdeck.app` (falling back to
   `~/.local/share/dev.apexdeck.app`). `downloads` is the XDG/macOS
   Downloads folder if it exists, else `None` (headless servers usually
   have none; exports then fail with the existing message). Builds
   `HostPaths`, a tokio runtime and a `Host`. Also handle the Codex hook
   argument like `src-tauri/src/main.rs` does.
2. **Protocol module.** `protocol.rs`: frame types, parsing, and a
   transport-agnostic `Session` that reads frames from an `AsyncBufRead`,
   dispatches commands through `Host::call` concurrently (replies can come
   out of order, matched by `id`), and writes replies and events to one
   writer task so frames never interleave. Unknown `cmd` → `err`, never a
   dropped connection. Oversized frames (> 32 MB) → close.
3. **Replay ring buffer + boot id.** In `apex-host`: keep the last N
   envelopes (default 10 000, or 64 MB, whichever first) behind the bus.
   `Bus::since(seq) -> Option<Vec<Envelope>>` returns `None` when `seq` has
   fallen out of the buffer. Subscribe-then-read so no event is lost or
   doubled between replay and live. A lagged broadcast receiver closes the
   connection with a `resync` error instead of silently skipping. The
   daemon makes the `boot_id` at start and checks it in `hello` before
   calling `Bus::since`.
4. **stdio transport.** `--stdio`: one `Session` on stdin/stdout, logs to
   stderr only. No token: whoever can run the process (local user, SSH
   key) is already authorized. Which host it talks to is decided in step 6.
5. **WebSocket transport.** `serve`: `tokio-tungstenite`, one text message =
   one frame, many concurrent clients each with their own `Session`. Bind
   `127.0.0.1` by default. On start write a random 32-byte token to
   `<data-dir>/daemon-token` (mode 0600) plus `daemon.json` with port,
   socket path and pid; `hello` without the right token → close.
   Non-localhost bind is refused until phase 4 pairing exists, unless
   `--insecure-bind` is passed.
6. **Single owner, local socket, `--stdio` attach.** This is the main SSH
   case: a server where the daemon already runs, and the phone runs
   `ssh vps apex-daemon --stdio`.
   - A lock file in the data dir (`flock`, released by the kernel if the
     process dies) so the daemon and the Tauri app can't both own the same
     storage.
   - `serve` also listens on `<data-dir>/daemon.sock`: data dir 0700,
     socket 0600, and every connection's peer uid (tokio
     `UnixStream::peer_cred()`, works on Linux and macOS) must equal the
     daemon's uid. Same protocol, no token, same trust as stdio. A socket
     file left by a crash is removed only after taking the lock. A path
     over 100 bytes (`sun_path` is 104 on macOS, 108 on Linux) fails at
     start with a message that names `--data-dir`.
   - `--stdio` takes the lock if it's free and runs the host in-process,
     printing to stderr that work stops when the connection closes. If a
     daemon holds the lock, it connects to `daemon.sock` and copies bytes
     both ways until either side closes; the daemon's `Session` does all
     the protocol work, so agents keep running when SSH drops. If the
     desktop app holds the lock (no socket), it exits non-zero with a
     message saying so. `--attach` makes it attach-or-fail instead of
     falling back to in-process.
7. **Shutdown.** SIGTERM/SIGINT: stop accepting, kill PTYs and agent
   processes through the existing host paths, flush storage, remove
   `daemon.sock` and `daemon.json`, exit 0.
8. **Ubuntu Server packaging.**
   - **CI.** `.github/workflows/daemon.yml`, on push and pull request:
     `cargo test` for apex-core, apex-adapters, apex-host and apex-daemon
     on `ubuntu-22.04`, `ubuntu-22.04-arm` and `macos-latest`, then
     `cargo build --release -p apex-daemon` on both Ubuntu runners and
     upload the binaries as artifacts. Building on 22.04 keeps the glibc
     requirement low enough for 22.04 and 24.04 servers; the arm build
     covers ARM VPSs (Hetzner CAX, Oracle Ampere). No Tauri job.
   - **systemd.** `packaging/systemd/apex-daemon@.service`, a template
     system unit, started with
     `sudo systemctl enable --now apex-daemon@<user>`. It runs as that user
     so agent logins and the login-shell PATH lookup
     (`apex_host::agents::login_path`) behave as they do in an SSH
     session, and it starts at boot without anyone logged in.
     ```ini
     [Unit]
     Description=Apex Deck daemon for %i
     After=network-online.target
     Wants=network-online.target

     [Service]
     Type=simple
     User=%i
     ExecStart=/usr/local/bin/apex-daemon serve
     Restart=on-failure
     RestartSec=2
     # SIGTERM goes to the daemon only, so step 7 shuts agents down in
     # order; anything left after the timeout is killed.
     KillMode=mixed
     TimeoutStopSec=30

     [Install]
     WantedBy=multi-user.target
     ```
     No `ProtectHome` or `NoNewPrivileges`: agents edit files in the
     user's home and may run `sudo`.
   - **Docs.** `docs/daemon-ubuntu.md`: copy the binary to
     `/usr/local/bin` (on the PATH that a non-interactive
     `ssh vps apex-daemon --stdio` gets, unlike `~/.cargo/bin`), install
     the agent CLIs and log in as that user, enable the unit, read logs
     with `journalctl -u apex-daemon@<user> -f`, and test with
     `ssh vps apex-daemon --stdio --attach`.
9. **Tests.**
   - Protocol unit tests: framing, out-of-order replies, unknown command,
     bad hello, oversized frame.
   - Replay: resume inside the buffer gets exactly the missed events;
     resume outside it gets `resumed: false`; restart the daemon on the
     same data dir and resume with the old `boot_id` and a `seq` that is
     in range for the new boot → `resumed: false`.
   - Data dir: `XDG_DATA_HOME` is honored on Linux; `--data-dir` wins.
   - End-to-end: spawn the built binary with `--stdio` and a temp data dir,
     run the phase-1 JSON scenario (chat with a fake agent, terminal, an
     approval answer, restart restores the chat). Same scenario over
     WebSocket, including token rejection and a reconnect with `since`.
   - Attach: start `serve`, then `--stdio` attaches; a room created over
     the WebSocket shows up for the stdio client and its events arrive on
     both. Close the stdio client mid-reply from the fake agent; the
     WebSocket client still sees the reply finish. `--attach` with no
     daemon fails; `--stdio` with the lock held and no socket exits
     non-zero. Socket mode is 0600. `kill -9` the daemon, start it again:
     the stale socket is replaced and attach works.
   - CI runs all of the above on Linux and macOS.
10. **Verify.** `cargo test --workspace`, `npm test`,
    `scripts/linux-test.sh` (now including apex-daemon), then by hand:
    `ssh localhost apex-daemon --stdio` and drive one command with a tiny
    script (`scripts/daemon-cli.mjs`, kept as a dev tool). On a real
    Ubuntu VPS (needs the user): install per `docs/daemon-ubuntu.md`,
    reboot, `ssh vps apex-daemon --stdio --attach` from the Mac.

## Review focus
- SSH drops mid-reply (phone on cellular): with a daemon running, the agent
  must keep working and the reconnect must resume. Covered by the attach
  test.
- Daemon restarted by systemd while a client is away: an old `seq` must
  never resume against new events. Covered by the `boot_id` test.
- Crash leaves `daemon.sock` behind: the next start must not fail or
  attach clients to nothing. Covered by the `kill -9` test.
- Agents not found under systemd because PATH is minimal: the daemon must
  find what the user's login shell finds. Checked by hand on the VPS.
- Another local user on a shared server connecting to the socket: refused
  by mode 0600 and the peer-uid check.

## Decisions taken here
- JSON lines, not length-prefixed binary; attachments stay base64 (phase 1).
- One protocol version number; breaking changes bump it and `hello` refuses
  mismatches.
- Daemon and desktop never share a data dir at the same time (lock file);
  phase 3's Electron app runs the daemon as its own sidecar instead.
- `--stdio` attaches to a running daemon when there is one and falls back
  to in-process otherwise. On servers the systemd unit is the expected
  setup, so SSH always attaches.
- systemd template system unit (`apex-daemon@<user>`) rather than a user
  unit, so it starts at boot without `loginctl enable-linger`.
- Linux release builds on Ubuntu 22.04, for x86_64 and arm64.

## Out of scope
mDNS, iroh, QR pairing and device permissions (phase 4), Electron (phase 3),
`--stdio` starting a background daemon itself, a `.deb`/apt package,
Windows service install.
