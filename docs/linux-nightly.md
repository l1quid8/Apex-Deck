# Linux Nightly

The default build channel is Stable. Set `APEX_CHANNEL=nightly` at build time for Nightly. An installed binary or AppImage uses its built-in channel, even when launched with a different `APEX_CHANNEL` value.

## Desktop builds

Build from a clean checkout on native Linux with Node 24, Rust and the project dependencies installed. The release owner allocates `APEX_BUILD_NUMBER` across all platforms.

```sh
APEX_CHANNEL=nightly APEX_BUILD_NUMBER=<build-number> npm run desktop:linux
```

`release/nightly` contains `Apex-Deck-Nightly_<YYYYMMDD>_<sha7>_<arch>.AppImage` and its `.sha256` and `.json` companions. The date is the source commit's UTC committer date. Metadata records the full commit, immutable release tag, build number, architecture, size and checksum. The AppImage runs portably and uses the Nightly desktop profile and daemon data directory.

Protected desktop installation is separate. Its tree is under `/opt/apex-deck-nightly`, its private authority is under `/var/lib/apex-deck-nightly-provenance`, and its sockets are under `/run/apex-deck-nightly`. For evaluation, add the matching Linux `apex-provenance` build to `resources/bin` in a copy of the unpacked AppImage payload, then use `scripts/package-linux-protected.mjs` with the same channel, build number and full commit. The signed manifest binds the channel and Nightly build number. A Stable verifier can also read legacy signed manifests with no channel field. Linux's existing production publisher trust provisioning is tracked in [Linux provenance acceptance](security/linux-provenance-acceptance.md).

## Release handoff

The `linux-appimage` workflow takes the channel and the release owner's build number. It uploads Linux artifacts to the workflow run. The release owner verifies that the Linux, macOS and Windows outputs all agree on the full source commit, version, build number and immutable release tag.

1. Upload the verified Linux AppImages and their companions alongside the other platform assets on the immutable release named in the metadata. Verify the release tag resolves to the full source commit before promoting it.
2. The feed owner advances the rolling `nightly` prerelease after the immutable release is ready. The shared `apex-deck-nightly-update.json` keeps its macOS `packages` array. The VPS updater reads `channel`, `version`, `buildNumber`, `commit` and `tag` from that same manifest and builds from the pinned Git source.
3. Use a higher build number for the next promoted source, including if its semantic version is unchanged. The Linux workflow supplies independent per-architecture sidecars for the handoff.
