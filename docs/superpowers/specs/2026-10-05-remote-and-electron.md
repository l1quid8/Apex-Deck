# Remote control and the Electron shell

Status: agreed 2026-10-05. Replaces the Tauri desktop shell with Electron and
splits the Rust core into a host that local and remote clients share.

## Why
- An embedded browser that agents can drive needs Chromium inside the Deck
  window. Tauri on macOS is WKWebView with no CDP, so the shell becomes Electron
  (`WebContentsView` + `webContents.debugger`). The spike proved docking, CDP
  click/type, persistent logins and resizing; computer-use testing found a blank
  pane and missing accessibility content until the first resize.
- A phone, an SSH session and a headless machine all need the Rust core without
  a UI, so the core runs as a daemon and every UI is a client of it.

## Architecture
```
 Electron desktop ─┐
 phone app ────────┼── protocol ──▶ apex-daemon ──▶ apex-host (rooms, PTYs,
 another desktop ──┘  (ws / ssh stdio / iroh)       storage, approvals, mods)
```
- **apex-host** (crate): owns all state. `Host::call(Command) -> Result<Value>`
  and `Host::subscribe() -> broadcast::Receiver<(seq, Event)>`. Events are the
  current `room-event`, `pty-data`, `pty-exit`, `quit-requested` plus
  `session-changed` and `settings-changed`.
- **Session and settings move into Rust.** Today `session_save` and
  `settings_save` store JSON built by the UI. The host becomes the owner; clients
  send edits as commands and receive change events.
- **apex-daemon** (binary): `apex-daemon serve` (WebSocket, localhost by default,
  plus a local socket), `apex-daemon --stdio` (protocol over stdin/stdout, used
  through SSH and as the Electron sidecar; attaches to a running daemon through
  the local socket when there is one), `apex-daemon pair` (prints a QR code,
  phase 3). Runs on macOS and Ubuntu Server, with a systemd unit for servers.
- **Protocol**: newline-delimited JSON. Request `{id, cmd, args}`, reply
  `{id, ok|err}`, event `{seq, event}`. `hello {since?: {boot_id, seq}}` returns
  a snapshot or the events after `seq` from a bounded ring buffer; it only
  resumes when `boot_id` matches the running daemon, since `seq` restarts with
  each boot.
- **Electron** (built in phase 3, `docs/desktop.md`): main starts (or finds)
  `apex-daemon serve --exit-on-stdin-close` on this Mac and relays protocol
  lines between the window and its socket, or an `ssh HOST apex-daemon
  --stdio --attach` child for a saved host. The protocol client is in the
  renderer (`src/daemon/client.ts`), so the phone app can reuse it.
  `src/backend.ts` is commands over a `Transport` plus a `Shell`
  (`commandBackend.ts`), with Tauri and Electron versions of each. The docked
  browser is one `WebContentsView` per Preview pane, bounds set before it's
  added (the spike's blank pane), hidden under menus and dialogs.

## Security
- Localhost WebSocket requires a token from a 0600 file in the app data dir.
- Remote devices (phase 3): ed25519 device keys, one-time 5-minute pairing
  token in the QR code, `authorized_devices` with revoke; permissions
  read-only / chat+approvals / full (PTY and files).
- SSH relies on the user's existing SSH keys; no listener needed.

## Decisions taken
- The local host is an `apex-daemon serve` that Electron starts with
  `--exit-on-stdin-close`, not an in-process `--stdio`: reloading the window
  must not stop agents, and a crashed Electron must not leave them running. A
  daemon already running on the data folder is used and left running.
- Commands made while disconnected fail at once rather than queue; one in
  flight when the connection drops fails with words saying it may not have
  finished.
- Files the person saves or opens land on the machine with the screen. On a
  remote host, folders and files are picked by looking through that host's
  folders (`folder_list`); a daemon too old for that gets a typed path,
  checked there.
- The docked browser loads pages on this Mac; a remote host's `localhost`
  isn't reachable from it yet.
- Agents driving the docked browser is phase 3b.
- Concurrent control: host is the source of truth, last write wins, every
  client sees live updates.
- Phone app framework: decided in phase 5 (Tauri mobile or Capacitor; both
  reuse `src/`).
- Open: raw SSH terminal on the phone in addition to the tunnel; how much
  remote parity v1 needs (default: chat, approvals, terminals, diffs).

## Phases
1. `apex-host` extraction; Tauri becomes a shim; all tests green, no behaviour change.
2. `apex-daemon` with stdio + WebSocket, protocol, replay.
3. Electron shell on the daemon: the whole UI, hosts over SSH, the docked browser (built).
   3b. Agents drive the docked browser over CDP, with approvals.
4. Device keys, QR pairing, Settings → Devices, permissions.
5. Phone app: SSH and iroh transports, mobile layout.
6. Push notifications, multiple hosts.
