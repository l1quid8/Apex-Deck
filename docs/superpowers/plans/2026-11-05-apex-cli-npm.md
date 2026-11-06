# Apex CLI as an npm package — plan

Lead: Jigga. Assist: Muck. Review: Null. Branch: `feat/apex-cli-npm` (from `d723ec66`).
Target: macOS Apple Silicon only, same as the current tarball.

## The constraint that shapes everything

The trusted `apex` is not just a file on PATH. It works only after a root-run
enrollment (`scripts/install-cli-provenance.sh`) copies the signed binaries into
`/Library/Application Support/Apex Deck Provenance/Standalone/` and pins their
exact CDHashes in the authority config. So:

- npm can deliver the binaries, but it cannot make them trusted. No install
  script may run sudo (and pnpm/yarn block install scripts anyway).
- Every new version has new CDHashes, so **every upgrade needs one admin
  password**. We keep exact pins; loosening them to "any binary signed by our
  team" is a security change and is out of scope.

## Shape

```
npm i -g @apex-deck/cli
  @apex-deck/cli                 launcher only: bin/apex (POSIX sh), no install scripts
  @apex-deck/cli-darwin-arm64    optionalDependency, "os":["darwin"], "cpu":["arm64"]
                                 signed apex, apex-daemon, apex-provenance,
                                 manifest.json, install-cli-provenance.sh

apex [args]  (launcher)
  installed Standalone/manifest.json == package manifest.json  -> exec Standalone/apex "$@"
  nothing installed                 -> "One-time setup needs your admin password:"
                                       sudo "<absolute launcher path>" setup        (exit 1)
  older version installed           -> same message, worded as an update            (exit 1)
  newer version installed           -> "Installed Apex is newer than this npm package" (exit 1)
apex setup      (launcher, must be root) -> bundled installer --no-path-link <package dir>
apex uninstall  (launcher, must be root) -> removes Standalone + standalone pins; keeps data
```

- The launcher never runs the npm copy of `apex`; it always execs the
  root-owned copy, with a clean environment (trusted apex refuses inherited agent
  variables).
- The sudo hint prints the absolute launcher path, because sudo may not have
  `/opt/homebrew/bin` on PATH.
- npm owns PATH, so npm-driven setup does not create `/usr/local/bin/apex`. An
  existing link from the tarball install is left alone if it points at
  Standalone.

## Tasks and owners

1. **Installer upgrade + uninstall** — Jigga. `install-cli-provenance.sh`:
   - accept an existing Standalone install: same-version is a no-op, newer
     version replaces Standalone atomically and swaps the two standalone pins,
     older version is refused;
   - before replacing, if `apex backend status` shows the CLI backend running,
     stop it with `apex backend stop` (refuse while agents are mid-turn);
   - `--no-path-link`; `--uninstall`;
   - keep every existing guarantee (no key/journal changes, rollback, lock).
   Tests: extend the packaging tests with a fake-root harness.
2. **npm packages + launcher** — Muck.
   - `npm/cli/` (package.json, `bin/apex`, README) and `npm/cli-darwin-arm64/`
     template;
   - `scripts/package-cli-npm.mjs`, run from `release/`, builds both `.tgz` from
     the already-signed `release/Apex-CLI_<v>_arm64/` (checks manifest hashes and
     signatures, never re-signs), versions locked together;
   - launcher logic above, with tests in `tests/apex-cli-npm.test.mjs` (fake
     Standalone dir via an env override that the launcher honours only in tests).
   Contract with Task 1: launcher calls
   `/bin/bash "$platform_dir/install-cli-provenance.sh" --no-path-link "$platform_dir"`
   and `... --uninstall`; installed version = `Standalone/manifest.json` (mode 644).
3. **Local acceptance** — Jigga integrates, Muck runs.
   `npm pack` both, `npm i -g` into a throwaway prefix, then on this Mac:
   fresh-style message, `sudo … setup`, `apex` starts, shared threads visible,
   rebuild with a bumped prerelease version, `npm i -g` again, update message,
   `sudo … setup` upgrades, chats kept, `uninstall` leaves data intact.
4. **Publish** — only on the user's go. Needs an npm account with the
   `apex-deck` scope, and should wait for notarization.

## Not in this round

Intel Mac, Linux, Windows packages; notarization; API-key setup; loosening pins.
