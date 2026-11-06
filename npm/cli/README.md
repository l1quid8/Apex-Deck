# @apex-deck/cli

Launcher for the Apex Deck standalone CLI. Shares agents and threads with Apex Deck desktop app.

## Install

```sh
npm i -g @apex-deck/cli
apex
```

First run prints one admin command:

```sh
sudo "/path/to/apex" setup
```

Type your password once. That copies the signed binaries to `/Library/Application Support/Apex Deck Provenance/Standalone/` and pins their identities.

After that `apex` just starts the trusted CLI.

## Update

```sh
npm i -g @apex-deck/cli@latest
apex
# if update message appears:
sudo "/path/to/apex" setup
```

Every new version has new CDHashes, so each upgrade asks for your password once. Same version is a no-op. Downgrades are refused.

## Uninstall

```sh
sudo apex uninstall
npm rm -g @apex-deck/cli
```

Removes Standalone and standalone pins, keeps your chats/agents and authority keys/journal.

## Security

The `apex` binary you run is always the root-owned copy under `/Library/.../Standalone/apex`. The npm package never runs its copy directly. The installer verifies Developer ID signatures, hardened runtime, and exact CDHashes before pinning.

## Platform

Currently macOS Apple Silicon only (`darwin-arm64`). The platform package `@apex-deck/cli-darwin-arm64` contains the signed `apex`, `apex-daemon`, `apex-provenance`, `manifest.json`, and `install-cli-provenance.sh`.

## License

SEE LICENSE IN LICENSE
