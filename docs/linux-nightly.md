# Linux Nightly

The default build channel is Stable. Set `APEX_CHANNEL=nightly` at build time for Nightly. An installed binary or AppImage uses its built-in channel, even when launched with a different `APEX_CHANNEL` value.

## Desktop builds

Build from a clean checkout on native Linux with Node 24, Rust and the project dependencies installed. The scheduled `nightly-linux` workflow sets `APEX_BUILD_NUMBER` from the Linux feed. Build numbers count per platform.

```sh
APEX_CHANNEL=nightly APEX_BUILD_NUMBER=<build-number> npm run desktop:linux
```

`release/nightly` contains `Apex-Deck-Nightly_<YYYYMMDD>_<sha7>_<arch>.AppImage` and its `.sha256` and `.json` companions. The date is the planner's `APEX_NIGHTLY_DATE`, or the source commit's UTC committer date when building by hand. Metadata records the full commit, immutable release tag, build number, architecture, size and checksum. The AppImage runs portably and uses the Nightly desktop profile and daemon data directory.

Protected desktop installation is separate. Its tree is under `/opt/apex-deck-nightly`, its private authority is under `/var/lib/apex-deck-nightly-provenance`, and its sockets are under `/run/apex-deck-nightly`. For evaluation, add the matching Linux `apex-provenance` build to `resources/bin` in a copy of the unpacked AppImage payload, then use `scripts/package-linux-protected.mjs` with the same channel, build number and full commit. The signed manifest binds the channel and Nightly build number. A Stable verifier can also read legacy signed manifests with no channel field. Linux's existing production publisher trust provisioning is tracked in [Linux provenance acceptance](security/linux-provenance-acceptance.md).

## Release

Linux Nightly publishes on its own. It needs no macOS or Windows build, secret or feed, and they don't need Linux.

The scheduled `nightly-linux` workflow picks the newest green `daemon.yml` push on `main` and skips when the Linux feed already has that commit. It builds the x86_64 and arm64 Nightly AppImages. Each AppImage carries the daemon built with it, and that same binary is published for the VPS and phone installers.

`scripts/nightly-linux-release.mjs` checks every AppImage, checksum, metadata file and daemon. It then attaches them to the immutable `nightly-YYYYMMDD-<sha7>` prerelease, creating it if no other platform has. It downloads everything back and checks it again. Only then does it advance `apex-deck-nightly-update-linux.json` on the rolling `nightly` prerelease. Any failure leaves the feed where it was.

- **Feed.** `apex-deck-nightly-update-linux.json` carries `channel`, `platform: "linux"`, `version`, `buildNumber`, the full `commit`, the immutable `tag`, plus `daemons` and `appImages` entries with sizes and SHA-256 hashes. A pinned copy also lives on the immutable release.
- **Build numbers.** They count up per platform. Linux's next build is the Linux feed's build number plus one, including when the version is unchanged. Linux readers only compare against the Linux feed.
- **Sharing a release.** Another platform may publish the same commit's immutable release first. Linux then adds only its own assets. It never replaces an asset on a published release, and it refuses a release that points at a different commit. A retry that finds its own files already published keeps them only if they are byte-identical. That covers re-running the failed publish job. A fresh rebuild of the same commit on the same day produces different AppImage bytes and is refused, so wait for the next date.
- **First build.** Linux starts at build 1. No shared-feed Nightly was ever published, so no installed VPS daemon has a higher number to stay above.
- **Readers.** The VPS updater reads the identity fields and builds from the tag's source. The phone SSH installer downloads the listed daemon. Linux desktop has no automatic updates; install the AppImage from the immutable release.

`linux-appimage.yml` still builds AppImages on demand for CI and evaluation. It never publishes.
