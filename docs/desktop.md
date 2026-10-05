# The Electron app

Apex Deck's desktop app moved from Tauri to Electron in 0.5.0, so a real
Chromium browser can be docked in the Preview pane. The Electron app does no work of
its own: every thread, terminal and saved file lives in `apex-daemon`, on
this Mac or on another machine you reach over SSH. The window is a client of
the daemon, like the phone app will be.

The Tauri build still works but is no longer what ships.

## Run it while developing

```sh
npm install
npx install-electron        # Electron 44 fetches its binary on first use; this does it now
npm run desktop:dev         # Vite with hot reload, and Electron pointed at it
```

`npm run desktop` builds the UI first and runs it the way the packaged app
does, from `app://deck/`.

Both start `target/debug/apex-daemon serve --exit-on-stdin-close` on this
Mac's data folder (`~/Library/Application Support/dev.apexdeck.app`, the
same one the Tauri app uses) unless a daemon is already running there, in
which case they use that one and leave it running when you quit.

The Tauri app and the Electron app can't be open at the same time: the first
one to open the data folder holds it, and the other says so. Tauri builds up
to 0.4.0 hold no lock, so the Electron app looks for one that's open and asks
for it to be quit before it starts. On its first launch it also copies over
what 0.4.0's window kept in its own storage (installed mods, model names typed
before, sidebar widths), reading a copy of WebKit's database and leaving the
original alone.

Set `APEX_DECK_DATA_DIR=/some/folder` to run on another data folder; the
Electron app then keeps its own files (the browser profile, `hosts.json`) in
`/some/folder-desktop` instead of `~/Library/Application Support/dev.apexdeck.desktop`.

## Build the app

```sh
npm run desktop:package    # the app alone
npm run desktop:dmg        # the app in a disk image, for a release
```

This builds `apex-daemon` in release mode and the UI, then writes
`release/mac-arm64/Apex Deck.app` (or `mac-x64` on Intel), and with
`desktop:dmg` also `release/Apex-Deck_<version>_<arch>.dmg`. The daemon is
inside it at `Contents/Resources/bin/apex-daemon`, and Codex's approval hook
runs that same copy. The app is signed ad hoc, not notarized: the first time,
open it with right-click → Open.

## Run on another machine over SSH

1. Install and start the daemon there: [daemon-ubuntu.md](daemon-ubuntu.md).
2. Make sure `ssh vps` works from Terminal on this Mac without a password
   prompt: with a key in `ssh-agent`, or one named in `~/.ssh/config`. Run it
   once by hand first so the server's host key is known. Deck runs `ssh`
   with `BatchMode=yes`; it never asks for or keeps a password.
3. In Deck, open **Settings → Hosts** (or **Host → Manage Hosts…** in the
   menu bar) and add the host: a name, the SSH destination (`me@vps.example.com`,
   or a `Host` from `~/.ssh/config`), and the daemon's command if it isn't
   `apex-daemon` on the default `PATH`.
4. Click **Connect**. The window reloads on that host and its title says so
   ("Apex Deck — vps"). The Host menu switches between hosts the same way.

Deck runs `ssh -T -o BatchMode=yes -o ServerAliveInterval=15 … -- DEST
apex-daemon --stdio --attach`, which joins the daemon already running there.
If the connection drops (Wi-Fi changes, the laptop sleeps), a banner says
so and Deck reconnects, picking up every message it missed; a command that
was under way when it dropped says it may not have finished. If the daemon
there isn't running, the banner shows its own words about starting it.

### What's different on another machine

- Quitting Deck doesn't stop anything there; agents and terminals go on.
- Folders are typed, not picked: "Folder on vps" asks for a full path and
  checks it exists there.
- Files there can't be opened on this Mac; web links still open here.
- Files you drop on a thread are copied there (up to 20 MB each; not folders).
- Exports, saved artifacts and downloads land on this Mac.
- The docked browser loads pages here, so `localhost` means this Mac, not
  the server. Forwarding the server's ports comes later.

## The docked browser

In the Electron app a Preview pane is a real Chromium page. Sign-ins last
across restarts (the profile is `persist:deck-browser` in Deck's own folder),
popups for sign-in flows open in their own window, and downloads go to
Downloads. Deck's own shortcuts (⌘1–3, ⌘T, ⌘N, ⌘J, ⌘[ ⌘], ⌘⇧↩, ⌘,) work while
the page has focus; copy, paste, find and the rest stay with the page. Pages
can't reach the Deck window, and only web addresses load in a pane.

Agents can't drive this browser yet; that's phase 3b.

## Checks

```sh
npm test                    # unit tests, including desktop/*.mjs
npm run test:e2e            # the protocol client against a real apex-daemon
npm run desktop:smoke       # the real app, hidden, on a temporary data folder
node desktop/run-smoke.mjs --packaged   # the same against the built .app
```

The smoke run drives the app through the backend it exposes with
`APEX_DECK_SMOKE=1`: a chat, a reload while an agent works, a terminal, the
docked browser (placement, a menu over it, a page trying to break out, a
cookie surviving a restart), and quitting. Its window is on screen but
invisible and ignores the mouse, so pages can be captured.

Against a server, the same script checks a chat there and, when given the
commands for them, a connection that goes quiet for a minute mid-reply and a
daemon that stops:

```sh
node desktop/run-smoke.mjs --ssh vps \
  --stop "ssh vps sudo systemctl stop apex-daemon@\$USER" \
  --start "ssh vps sudo systemctl start apex-daemon@\$USER"
```

`--pause` and `--resume` take commands that freeze the whole server and let
it go again, network included; the phase-3 run used `docker pause` on a
stand-in Ubuntu server in Docker. `--ssh-config FILE` makes `ssh` read FILE
instead of `~/.ssh/config`.
