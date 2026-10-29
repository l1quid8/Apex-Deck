# Automatic updates (Mac)

Deck checks for a newer version shortly after it opens and every six hours,
downloads it in the background, and offers **Restart to update**. Restarting
installs it and reopens Deck by itself. After a one-time administrator install,
no password or Installer window is needed again.

## How one update goes

```
Deck (you)                      broker (root, already running)     update job (root, on demand)
──────────                      ──────────────────────────────     ────────────────────────────
read apex-deck-update.json
download Apex-Deck-X-arm64.pkg
  check size + SHA-256
  unpack, check the app is
  signed by this app's team
  and is version X
"X is ready"  [Restart] [Later]
Restart ─► update_install ────► only the pinned trusted UI may ask
                                writes one request file into
                                Apex Deck Upgrade/queue ──────────► launchd starts the job
quit                                                               copy + hash the package
                                                                   unpack (no package scripts run)
                                                                   app signed by the installed
                                                                     copy's team, newer, this CPU
                                                                   wait for Deck to close
                                                                   the same transaction a .pkg runs
                                                                   write last-update.json
reopened ◄───────────────────────────────────────────────────────── reopen Deck as you
"Updated to X" (or why not)
```

- **Feed**: `https://github.com/l1quid8/apex-deck/releases/latest/download/apex-deck-update.json`.
  It only decides what to download; the URL of the package is always this
  repository's `releases/download/v<version>/<name>`.
- **Trust**: root installs only an app signed by the Developer ID team that
  signed the protected copy already installed, with Apex Deck's identifier, a
  higher version, the right CPU and a supported macOS. The CDHashes it pins are
  read from that app, not from the feed or the package.
- **One transaction**: `scripts/upgrade.py` is both the `.pkg` postinstall and
  the update job, so backups, authority preservation, broker restart and
  rollback are the same code either way.
- **The broker runs nothing**: it checks the request's shape and the caller's
  pinned signature, then moves one file into a root-only queue. launchd's
  `QueueDirectories` starts `dev.apexdeck.update`. The request stays queued
  until the job finishes, which is how the broker refuses a second one.

Updates are off in development builds, smoke runs, a separate data folder
(`APEX_DECK_DATA_DIR`), ad hoc builds, and any copy other than the protected one.

## Where things are

| What | Where |
| --- | --- |
| Downloads | `~/Library/Caches/dev.apexdeck.desktop/updates/downloads/<version>/` |
| Last request | `~/Library/Application Support/dev.apexdeck.desktop/updates.json` |
| Queue, jobs, backups (root only) | `/Library/Application Support/Apex Deck Upgrade/{queue,jobs,backup-<id>}` |
| Result (readable by you) | `/Library/Application Support/Apex Deck Updates/last-update.json` |
| Job log | `/var/log/apex-deck-update.log` |
| Service | `/Library/LaunchDaemons/dev.apexdeck.update.plist` |

The job keeps the two newest backups it made and the five newest job folders.
Backups from administrator-run packages are never removed by it.

## When something goes wrong

- Refused before installing (wrong team, not newer, checksum, Deck didn't close
  within two minutes, Deck still open in another signed-in account): nothing
  changes, Deck reopens and says why. Another account's copy is not waited on,
  since it isn't quitting for this update.
- Other signed-in accounts with Deck closed: their background service is
  stopped for the install like yours, then started again on whichever copy is
  in place afterwards, since nobody there will reopen Deck to start it. Agents
  left running in that account stop. Each account's service is started on its
  own; one that won't start is named in the notice after reopening, which says
  it stays off until Deck is opened in that account. A background service that
  isn't one of these, such as a development build's, can't be stopped by the
  update, so it refuses until that is quit. An account that signs out while
  the update starts is skipped; one whose service won't stop refuses the
  update and is named.
- Failed during the transaction: it rolls back as a `.pkg` would, Deck reopens
  and says so.
- Rollback itself failed, or the Mac lost power mid-install:
  `install.lock` stays, Deck says the update "needs checking", and no further
  update installs until the retained evidence in `backup-<id>` is inspected.
  Other accounts' background services stay off too, and the notice names them.

## Turning it on: the one manual install

Copies from before this change can't update themselves: their broker doesn't
know the request and nothing set up the queue. Install the first version that
has this code once with its package (`release/Apex-Deck-upgrade.pkg`, admin
password in Installer). Its transaction installs the update service. Every
later version can then arrive through **Restart to update**.

## Publishing a version

1. Bump the version, refresh the phone bridge's own lockfile with
   `cargo metadata --format-version 1 --manifest-path crates/iroh-mobile/Cargo.toml > /dev/null`
   (it pins the workspace crates too, and CI tests it with `--locked`), commit,
   wait for the `daemon` workflow to pass, and build in the main folder:
   `npm run desktop:dmg` (Developer ID signed; the script refuses ad hoc).
2. `node scripts/release-update-manifest.mjs --notes "One line on what changed"`
   writes `release/v<version>-assets/Apex-Deck-<version>-arm64.pkg` and
   `apex-deck-update.json`, after checking the app inside matches the package.
3. Run the steps it prints, in order: create a **draft** release, upload both
   files, download them back and compare the checksums, then publish. Installed
   copies only see the feed once the release is published as latest.

## Not covered yet

- Windows and Linux.
- Automatic resume after a power cut mid-install (it stops and asks for a
  look instead).
- `/usr/bin/python3` must be present, as it already must for the `.pkg`.
