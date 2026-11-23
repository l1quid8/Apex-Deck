# Running apex-daemon on Ubuntu Server

`apex-daemon` is Apex Deck without a window. On a server it runs your agents
and terminals, and you drive it over SSH. These steps set it up for one user
on Ubuntu 22.04 or 24.04 (no desktop needed) and start it at boot.

## 1. Get the binary

Check the server's CPU first: `uname -m` prints `x86_64` (most VPSs) or
`aarch64` (ARM: Hetzner CAX, Oracle Ampere).

- **From a release:** check its actual assets on the
  [releases page](https://github.com/l1quid8/Apex-Deck/releases). Published
  v0.9.4 has Mac installers only; Linux binaries are currently CI artifacts.
  The automatic updater below builds the exact published source tag instead.
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

### Automatic published-release updates

The VPS updater checks every 30 minutes (plus up to two minutes of jitter),
builds only newer stable published release tags, and waits for maintenance
admission before restarting. Git, Cargo and binary probes run as the daemon
account; configuration, candidates, backups and the transaction journal belong
to root. HTTPS GitHub release metadata and Git fetch identify the release; this
is a source-build updater, not a signed Linux binary download mechanism.

For releases with native maintenance, the updater verifies the Linux terminal
and device admission code, then runs focused tests for jail enforcement, phone
grants, browser access, OAuth renewal and maintenance. Linux CI runs the same
candidate checks. Historical releases with recognized routing retain their
reviewed Allow workaround and regression test. Unknown routing defers the
update for review.

The daemon must support `maintenance_v1`. The root updater creates a short-lived,
boot-bound request under `/run/apex-deck-update/`; the local-only maintenance API
atomically seals admission only after work is idle. Active turns, schedulers,
assistant work, cleanup holds, terminals, voice, or an enabled model gateway
defer updates. Unknown remaining service child processes also defer. The seal
has a monotonic expiry so a crashed updater cannot block work permanently.

Installation keeps the prior executable, replaces atomically, then checks the
live protocol version/commit/boot, systemd PID, executable SHA-256, session and
chat-list readability. Failed health checks reacquire idle admission before
rollback. If the candidate has already accepted work, rollback waits too.
The updater checks a monotonic lease deadline again after identity/process
probes; recovery of a stopped unit also requires an empty service cgroup.
An interrupted install is recovered from its journal before another update;
unrelated manual deployments are never overwritten by recovery. The highest
successfully installed numeric version is retained across rollbacks.

Install these files from the reviewed checkout as root:

```sh
sudo install -d -m 0755 /usr/local/lib/apex-deck-update /etc/apex-deck-update
sudo install -m 0644 scripts/vps_update.py scripts/vps_update_compat.py \
  scripts/vps-update-allow-test.rs scripts/vps-update-maintenance.patch \
  desktop/channels.json \
  /usr/local/lib/apex-deck-update/
sudo install -m 0644 packaging/systemd/apex-deck-update@.service \
  packaging/systemd/apex-deck-update@.timer /etc/systemd/system/
# Use the actual service account and absolute daemon data directory.
printf '%s\n' '{"user":"l1quid8","data_dir":"/home/l1quid8/.local/share/dev.apexdeck.app"}' \
  | sudo tee /etc/apex-deck-update/l1quid8.json >/dev/null
sudo chmod 0644 /etc/apex-deck-update/l1quid8.json
sudo systemctl daemon-reload
sudo systemctl enable --now apex-deck-update@l1quid8.timer
sudo systemctl start apex-deck-update@l1quid8.service
```

The service user needs Git, Python 3.10+, and Cargo on `~/.cargo/bin` or the
system PATH. Builds use a separate `~/.cache/apex-deck-update/` checkout and
target directory. The published source tag and carry patches are recorded in
the candidate receipt; patched binaries truthfully report `-dirty`.

Configuration may include `"unit":"apex-daemon-managed@l1quid8.service"` when
the daemon runs under a different Apex daemon template for the same account.
The default is `apex-daemon@<user>.service`; unrelated service names and other
accounts are rejected. All process, maintenance, restart and rollback checks
use the configured unit.
Use that same unit for manual service commands and troubleshooting. The
[2026-10-29 VPS deployment record](reviews/2026-10-29-vps-auto-update.md)
records the existing VPS's replacement unit and retained rollback build.

For an old daemon without `maintenance_v1`, `--prepare-only` builds/tests without
restarting it. The first retrofit requires an operator-controlled idle restart;
there is no automatic heuristic fallback that can interrupt bots. The deployed
VPS retrofit records its observed idle state separately from subsequent atomic
maintenance admission.

```sh
systemctl list-timers apex-deck-update@l1quid8.timer
journalctl -u apex-deck-update@l1quid8.service -n 30
cat /var/lib/apex-deck-update/l1quid8/status.json
sudo systemctl disable --now apex-deck-update@l1quid8.timer  # disable checks
```

`/var/lib/apex-deck-update/<user>/` holds `state.json` (version floor and latest
backup), `status.json`, root-owned `candidates/` with test/build logs, retained
`backups/`, and `transaction.json` while an install needs recovery. Never delete
a pending journal or backup without inspecting it. A failed release is
quarantined until a newer release appears or an operator clears it after fixing
the cause. Existing manually saved `apex-daemon.bak-*` files are untouched.

### Manual update

```sh
scp target/linux-amd64/apex-daemon vps:/tmp/
ssh vps 'sudo install -m 0755 /tmp/apex-daemon /usr/local/bin/apex-daemon && sudo systemctl restart apex-daemon@$USER'
```

A client that reconnects after a restart gets `resumed: false` and reloads.

## Run Nightly alongside Stable

Use a Linux daemon from the immutable Nightly release, or check out that
release's tag and build it with the `buildNumber` from `apex-deck-nightly-update.json`.
For example, with `BUILD_NUMBER` set to that published number:

```sh
APEX_CHANNEL=nightly APEX_BUILD_NUMBER="$BUILD_NUMBER" scripts/linux-build.sh amd64
scp target/linux-amd64-nightly/apex-daemon vps:/tmp/apex-daemon-nightly
ssh vps 'sudo install -m 0755 /tmp/apex-daemon-nightly /usr/local/bin/apex-daemon-nightly && rm /tmp/apex-daemon-nightly'
```

On the VPS, install the Nightly daemon, updater and timer units from the
reviewed checkout. Replace the service account in the example with yours.

```sh
sudo install -m 0644 packaging/systemd/apex-daemon-nightly@.service \
  packaging/systemd/apex-deck-nightly-update@.service \
  packaging/systemd/apex-deck-nightly-update@.timer /etc/systemd/system/
sudo install -d -m 0755 /usr/local/lib/apex-deck-nightly-update /etc/apex-deck-nightly-update
sudo install -m 0644 scripts/vps_update.py scripts/vps_update_compat.py \
  desktop/channels.json /usr/local/lib/apex-deck-nightly-update/
printf '%s\n' '{"user":"l1quid8"}' \
  | sudo tee /etc/apex-deck-nightly-update/l1quid8.json >/dev/null
sudo chmod 0644 /etc/apex-deck-nightly-update/l1quid8.json
sudo systemctl daemon-reload
sudo systemctl enable --now apex-daemon-nightly@l1quid8.service
sudo systemctl enable --now apex-deck-nightly-update@l1quid8.timer
```

Use `ssh vps apex-daemon-nightly --stdio --attach` to connect. The Nightly
template uses `~/.local/share/dev.apexdeck.app.nightly` for chats, daemon
identity, tokens, `owner.lock` and `daemon.sock`. Check the endpoint with
`apex-daemon-nightly endpoint` as the service account. Both channels use
kernel-assigned loopback WebSocket ports by default. If you set fixed ports
through a unit drop-in, give each channel a distinct WebSocket port and, if
enabled, a distinct HTTP gateway port. For example, a Stable gateway on 8787
can run beside a Nightly gateway on 8788. Set distinct UDP ports if you pin
both phone listeners. For a home path that makes `daemon.sock` longer than
100 bytes, use a shorter private Nightly `--data-dir` in the unit drop-in and
set the same absolute `data_dir` in the Nightly updater configuration and
attach command.

The timer checks the rolling [Nightly manifest](https://github.com/l1quid8/apex-deck/releases/download/nightly/apex-deck-nightly-update.json).
It orders updates by build number, so two builds can have the same version.
If an installation rolls back, the failed build stays quarantined and only
a higher build number is eligible for installation.
It checks the manifest's full source commit against the immutable tag before
building and runs the native Linux candidate tests on that source. It uses
the same idle admission, health checks and rollback sequence as Stable.
The build cache lives in `~/.cache/apex-deck-nightly-update/`, and pending
maintenance requests live in `/run/apex-deck-nightly-update/`. The updater
lock lives in `/var/lib/apex-deck-nightly-update/`, with status, candidates,
backups and journal under `/var/lib/apex-deck-nightly-update/<user>/`.

```sh
systemctl status apex-daemon-nightly@l1quid8.service
journalctl -u apex-deck-nightly-update@l1quid8.service -n 30
cat /var/lib/apex-deck-nightly-update/l1quid8/status.json
```

For a manual Nightly update from the matching tagged checkout, run
`APEX_CHANNEL=nightly APEX_BUILD_NUMBER="$BUILD_NUMBER" scripts/vps-deploy.sh vps`.
It takes a backup of `/usr/local/bin/apex-daemon-nightly` and restarts
`apex-daemon-nightly@<user>.service`. Use the timer for updates that wait for
idle admission automatically.

## Troubleshooting

| Message | Meaning |
|---|---|
| `no apex-daemon is running for …` | The service isn't running: `systemctl status apex-daemon@$USER`. |
| `… is in use by apex-daemon --stdio (pid N)` | Someone has a `--stdio` session running the host in-process. Close it, or use the service. |
| `the socket path … is longer than 100 bytes` | Pick a shorter `--data-dir`. |
| An agent "was not found" | It isn't on your login shell's PATH. Check with `bash -lc 'command -v <agent>'`. |

## Voice calls from the phone

Voice setup starts from the phone in a server thread and requires Full access.
It downloads about 0.8 GB once and needs three times the download size free
while installing. Python, speech engines and models stay in
`~/.local/share/dev.apexdeck.app/voice-server/`; `--data-dir` puts the same
`voice-server/` folder under that data directory. No system Python is changed.

Calls listen and speak on the Linux x86-64 server, so the Mac can be off.
The helper unloads after ten idle minutes and stops with the daemon.
Metadata and timings go to `voice-server/calls.log`; audio and transcripts
are never written there. To remove voice, delete `voice-server/` while no
call or setup is running.

Each call has bounded queues. If a queue fills, the daemon closes that voice
channel with a clear connection error; it keeps the chat connection available.
