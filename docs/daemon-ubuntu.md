# Running apex-daemon on Ubuntu Server

`apex-daemon` is Apex Deck without a window. On a server it runs your agents
and terminals, and you drive it over SSH. These steps set it up for one user
on Ubuntu 22.04 or 24.04 (no desktop needed) and start it at boot.

## 1. Get the binary

Check the server's CPU first: `uname -m` prints `x86_64` (most VPSs) or
`aarch64` (ARM: Hetzner CAX, Oracle Ampere).

- **From CI:** open the repository's Actions tab, pick the latest `daemon`
  run, and download `apex-daemon-linux-x86_64` or `apex-daemon-linux-arm64`.
- **Built on your Mac with Docker:**
  ```sh
  scripts/linux-build.sh amd64   # for x86_64; use arm64 for aarch64
  ```
  This writes `target/linux-amd64/apex-daemon`. It builds on Ubuntu 22.04, so
  the binary runs on 22.04 and 24.04. On an Apple-silicon Mac the amd64 build
  runs under emulation and takes a while.

## 2. Install it

```sh
scp target/linux-amd64/apex-daemon vps:/tmp/
ssh vps 'sudo install -m 0755 /tmp/apex-daemon /usr/local/bin/apex-daemon && rm /tmp/apex-daemon'
```

Use `/usr/local/bin`: a non-interactive `ssh vps apex-daemon …` only searches
the system PATH, so `~/.cargo/bin` and `~/.local/bin` aren't found there.

## 3. Install and sign in to your agents

Log in as the user the daemon will run as, install the agent CLIs you use
(`claude`, `codex`, `gemini`, …) and sign in to each once, for example by
running `claude` or `codex login`. The daemon finds them on the same PATH
your login shell sets up, so check with:

```sh
bash -lc 'command -v claude codex'
```

## 4. Start it at boot

```sh
scp packaging/systemd/apex-daemon@.service vps:/tmp/
ssh vps
sudo install -m 0644 /tmp/apex-daemon@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now apex-daemon@$USER
```

It runs as that user, starts at boot without anyone logged in, and restarts
if it crashes.

- Status: `systemctl status apex-daemon@$USER`
- Logs: `journalctl -u apex-daemon@$USER -f`
- Stop: `sudo systemctl stop apex-daemon@$USER`. Running turns are stopped
  and chats are kept.

Without systemd, run `apex-daemon serve` in tmux, or as
`nohup apex-daemon serve >> ~/apex-daemon.log 2>&1 &`. Started plainly from
an SSH session, it stops when that session closes.

## 5. Connect from your Mac

```sh
ssh vps apex-daemon --stdio --attach
```

That connects to the running daemon through its socket, speaking the
protocol on stdin/stdout. Type a hello to see it answer:

```json
{"id":0,"cmd":"hello","args":{"protocol":1}}
```

Commands run at the same time and their replies can come back in any order,
matched by `id`. Wait for a reply before sending a command that depends on
it, such as posting to a chat you've just opened with `room_create`.

Or run one command with the dev tool in this repository:

```sh
node scripts/daemon-cli.mjs --ssh vps agents_detect
node scripts/daemon-cli.mjs --ssh vps --watch          # print events as they happen
```

If the SSH connection drops, the daemon keeps working. Reconnect and say
hello with `since: {boot_id, seq}` to get the events you missed.

Without `--attach`, `apex-daemon --stdio` starts the host in the SSH session
itself when no daemon is running. That host stops when the connection
closes.

## Where things live

`~/.local/share/dev.apexdeck.app` (or `$XDG_DATA_HOME/dev.apexdeck.app`),
readable only by you:

| File | What it is |
|---|---|
| `saved-chats-v1/`, `snapshots/`, `attachments/` | chats, file snapshots, pictures |
| `owner.lock` | held by whichever process owns the folder |
| `daemon.sock` | the local socket `--stdio` attaches through |
| `daemon.json` | the running daemon's pid, port, socket and ids |
| `daemon-token` | the WebSocket token |
| `host-id` | this host's id, kept across restarts |

Pass `--data-dir PATH` to use another folder. Its socket path has to stay
under 100 bytes.

## Security

- Anyone who can SSH in as this user can drive the daemon, just as they
  could run a shell.
- The WebSocket listens on `127.0.0.1` only and needs the token. To reach it
  from another machine before device pairing exists, tunnel it:
  `ssh -L 7400:127.0.0.1:<port> vps`, with the port from `daemon.json`, or
  start the daemon with a fixed `--port`.
- Don't use `--insecure-bind` on a public server.

## Updating

```sh
scp target/linux-amd64/apex-daemon vps:/tmp/
ssh vps 'sudo install -m 0755 /tmp/apex-daemon /usr/local/bin/apex-daemon && sudo systemctl restart apex-daemon@$USER'
```

A client that reconnects after a restart gets `resumed: false` and reloads.

## Troubleshooting

| Message | Meaning |
|---|---|
| `no apex-daemon is running for …` | The service isn't running: `systemctl status apex-daemon@$USER`. |
| `… is in use by apex-daemon --stdio (pid N)` | Someone has a `--stdio` session running the host in-process. Close it, or use the service. |
| `the socket path … is longer than 100 bytes` | Pick a shorter `--data-dir`. |
| An agent "was not found" | It isn't on your login shell's PATH. Check with `bash -lc 'command -v <agent>'`. |
