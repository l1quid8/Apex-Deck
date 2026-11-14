# @apex-deck/cli

Launcher for the Apex Deck standalone CLI. Shares agents and threads with the Apex Deck desktop app.

Supported: macOS on Apple Silicon (`darwin-arm64`) and Linux x64 (`linux-x64`, Ubuntu 22.04 or newer, or another distribution with glibc 2.35+). npm installs only the platform package that matches your machine.

## Install

```sh
npm i -g @apex-deck/cli
apex
```

### macOS

First run prints one admin command:

```sh
sudo "/path/to/apex" setup
```

Type your password once. That copies the signed binaries to `/Library/Application Support/Apex Deck Provenance/Standalone/` and pins their identities. After that `apex` just starts the trusted CLI.

### Linux

No setup step. `apex` runs straight from the npm folder. You need bubblewrap, which keeps agents in a jail:

```sh
sudo apt install bubblewrap      # Debian/Ubuntu
sudo dnf install bubblewrap      # Fedora
```

When the backend starts, it checks that the jail actually works on this machine. Until that check has passed, the CLI can read threads but can't post, approve, answer, add agents or change settings. It tells you why.

## Update

```sh
npm i -g @apex-deck/cli@latest
apex
```

On macOS, if an update message appears, run `sudo "/path/to/apex" setup` again. Every new build has new fingerprints, so each upgrade asks for your password once. The same build is a no-op, and downgrades are refused. Linux needs nothing more.

## Uninstall

macOS:

```sh
sudo "$(npm root -g)/@apex-deck/cli/bin/apex" uninstall
npm rm -g @apex-deck/cli
```

That removes the trusted copy and its pins. Your chats, agents, authority keys and journal are kept.

Linux:

```sh
npm rm -g @apex-deck/cli
```

Your chats and agents in `~/.apex` are kept.

## Security

**macOS:** the `apex` you run is always the root-owned copy under `/Library/.../Standalone/apex`. The npm package never runs its own copy. The installer checks Developer ID signatures, hardened runtime and exact fingerprints (CDHashes) before pinning them, and the root helper accepts only those pinned copies.

**Linux works differently.** There's no root helper, and Deck's records are ordinary files owned by your account. Deck trusts any program running as you that connects over its private local socket. What protects you is the agent jail: every agent below Full access runs in its own session with no link to your terminal, a private `/tmp`, no way to attach to other programs, no local socket connections, and none of Deck's sockets or sign-in variables. So a jailed agent can't reach Deck or type into your `apex`.

**Full access agents on Linux run outside the jail as you.** They could approve their own requests or change Deck's records. The CLI asks you to confirm before you give an agent Full access.

The launcher never runs an `apex` from your current folder, so a downloaded project can't swap in its own copy.

## Platform packages

- `@apex-deck/cli-darwin-arm64`: signed `apex`, `apex-daemon`, `apex-provenance`, `manifest.json` and `install-cli-provenance.sh`.
- `@apex-deck/cli-linux-x64`: `apex` and `apex-daemon`.

## License

SEE LICENSE IN LICENSE
