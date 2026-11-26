# Linux Nightly

The default build channel is Stable. Set `APEX_CHANNEL=nightly` at build time for Nightly. An installed binary or AppImage uses its built-in channel, even when launched with a different `APEX_CHANNEL` value.

## Desktop builds

Build from a clean checkout on native Linux with Node 24, Rust and the project dependencies installed. The scheduled `nightly-linux` workflow sets `APEX_BUILD_NUMBER` from the Linux feed. Build numbers count per platform.

```sh
APEX_CHANNEL=nightly APEX_BUILD_NUMBER=<build-number> npm run desktop:linux
```

`release/nightly` contains `Apex-Deck-Nightly_<YYYYMMDD>_<sha7>_<arch>.AppImage` and its `.sha256` and `.json` companions. The date is the planner's `APEX_NIGHTLY_DATE`, or the source commit's UTC committer date when building by hand. Metadata records the full commit, immutable release tag, build number, architecture, size and checksum. The AppImage runs portably and uses the Nightly desktop profile and daemon data directory.

Protected desktop installation is separate. Its tree is under `/opt/apex-deck-nightly`, its private authority is under `/var/lib/apex-deck-nightly-provenance`, and its sockets are under `/run/apex-deck-nightly`. Each Linux Nightly release includes `Apex-Deck-Nightly_<YYYYMMDD>_<sha7>_<arch>.linux-installer.tar`, with `.sha256` and `.json` companions.

### Install the protected Nightly

The installer needs systemd, logind, and `bubblewrap` for agents below Full access. An administrator runs it once for one desktop account:

```sh
sha256sum --check Apex-Deck-Nightly_<YYYYMMDD>_<sha7>_<arch>.linux-installer.tar.sha256
tar -xf Apex-Deck-Nightly_<YYYYMMDD>_<sha7>_<arch>.linux-installer.tar
sudo ./Apex-Deck-Nightly_<YYYYMMDD>_<sha7>_<arch>.linux-installer/apex-deck-install install --user <account>
```

The installer asks the administrator to type a confirmation, then installs the root-owned broker, the engine service and the launcher. Later commands are `sudo apex-deck-nightly-install status | repair | uninstall [--purge]`.

### Publisher key

Releases are signed with the Linux Nightly publisher key. The broker trusts only the keys in [`crates/apex-provenance/linux-publisher-keys.json`](../crates/apex-provenance/linux-publisher-keys.json), compiled in at build time; a release, its payload or the environment cannot choose another. On a first install the bundle's own broker checks the bundle, so a first install trusts the download as much as any installer: check the `.sha256` against the release, and compare the release's `publisherKey` in the `.json` with the key in that file on `main`. The key protects every later release an installed broker stages.

Signing runs in its own `sign` job in the `linux-nightly-signing` GitHub environment, which only `main` can use. The job holds the key and runs no npm or cargo code. It takes the build's identity from the plan and signs only a manifest that names this commit, build number and payload. It guards who can use the key; it doesn't prove what the build job put in the payload. A `verify` job then runs each bundle's own production broker against it, on that architecture, before anything is published.

To rotate the key, add the new public key to the list, ship a release signed with the old key so installs pick up a broker that trusts both, switch the secret, and remove the old key once installs have moved. A leaked key means a new key and a reinstall: there is no revocation list.

Stable has no publisher key yet, so a Stable broker refuses every protected install.

For evaluation, CI's `linux-installed` workflow builds a separate evaluation broker with a throwaway key (`--features linux-evaluation-verifier`) and signs evaluation manifests, which a production broker refuses.

## Release

Linux Nightly publishes on its own. It needs no macOS or Windows build, secret or feed, and they don't need Linux.

The scheduled `nightly-linux` workflow picks the newest `daemon.yml` push on `main` whose Linux and platform-neutral jobs all passed (skipped counts as passed), and skips when the Linux feed already has that commit. macOS and Windows jobs in that run are ignored, so their failures or cancellations never hold Linux back. It builds the x86_64 and arm64 Nightly AppImages. Each AppImage carries the daemon built with it, and that same binary is published for the VPS and phone installers.

`scripts/nightly-linux-release.mjs` checks every AppImage, installer, checksum, metadata file and daemon, and that each installer is signed by a committed publisher key for this build. It uploads them to the Linux-only draft prerelease `nightly-linux-YYYYMMDD-<sha7>`, downloads everything back and checks it again, and then publishes that release. It makes sure the shared git tag `nightly-YYYYMMDD-<sha7>` points at the commit, creating it if no platform has yet. Only then does it advance `apex-deck-nightly-update-linux.json` on the rolling `nightly` prerelease. Any failure leaves the feed where it was.

- **Feed.** `apex-deck-nightly-update-linux.json` carries `channel`, `platform: "linux"`, `version`, `buildNumber`, the full `commit`, the immutable source `tag`, the `assetTag` of the Linux-only release that holds the files, plus `daemons`, `appImages` and, from the first build that publishes them, `installers` entries with sizes and SHA-256 hashes. A pinned copy also lives on the Linux release.
- **Build numbers.** They count up per platform. Linux's next build is the Linux feed's build number plus one, including when the version is unchanged. Linux readers only compare against the Linux feed. If the Linux feed is missing while a published `nightly-linux-*` release exists, for example because a feed upload failed after `--clobber` removed the old copy, the planner and publisher stop instead of restarting at build 1. Restore the feed from the newest Linux release's pinned `apex-deck-nightly-update-linux.json`; the error message gives the commands.
- **No shared release.** Platforms share only the source tag, which is immutable and names one commit. Each platform keeps its assets on its own release, so Linux never views, uploads to, or publishes another platform's draft or release, and no other platform's publish or retry depends on Linux. Linux holds if the source tag or its own release points at a different commit. Until the Linux feed points at the Linux release, a retry replaces its files. After that they are immutable, so a forced rebuild of the same commit on the same day is refused; rebuild on a later commit or date.

- **Readers.** The VPS updater reads the identity fields and builds from the tag's source. The phone SSH installer downloads the listed daemon from the `assetTag` release. Linux desktop has no automatic updates; install the AppImage or the protected installer from the `nightly-linux-YYYYMMDD-<sha7>` release.

`linux-appimage.yml` still builds AppImages on demand for CI and evaluation. It never publishes.
