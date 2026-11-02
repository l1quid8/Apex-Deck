# Task 8 matching service upgrade

Status: **prepared and verified; installation not yet observed**. The Human authorized this installation and the subsequent Task 8 acceptance run. Administrator authentication is the remaining installation dependency. Do not infer an installation or provider result from this preparation record.

## Candidate and recovery

- Branch: `test/curate-service-upgrade`; source commit: `4aef067f177d`. No feature code changes.
- Frozen tracked source: `release/curate-task8-source-4aef067f177d/`. Unrelated untracked work was excluded and preserved.
- Production build was started inside that release directory, with `APEX_BUILD_COMMIT=4aef067f177d APEX_BUILD_DIRTY=false npm run _desktop:package -- --dir`. Existing dependencies and Cargo target were reused through symlinks. No release cleanup or replacement of other packages was performed.
- Installer: `release/Apex-Deck_0.9.6_curate-4aef067f177d_upgrade.pkg` (147.6 MB). SHA-256: `0ed771b35bc8c1222e914e3fc2bddd59e517b40a5937ca502722cae4cdb75b91`.
- Installer transaction ID: `428ebc70-a9fc-413f-990a-40791bb70e5a`.
- Candidate app and daemon both contain build stamp `4aef067f177d`; the bundled daemon reports `apex-daemon 0.9.6 (4aef067f177d)`.
- Independently expanded the finished package without executing its scripts. UI ASAR, daemon and broker SHA-256 values match the built artifacts, the embedded installer manifest matches the sidecar, and protected bundle verification passes on the extracted payload.
- Developer ID Application team: `75N5HW62JH`. Strict bundle/daemon/broker signature, hardened runtime, fuse and ASAR checks passed through `buildUpgrade` and `verify-protected-bundle.sh`.
- CDHashes: UI `a11c0aa8cda7de90411cb3670a55b2d3f04ad388`; daemon `ed013f3c1116c6223f052e551e97d2c78d791b77`; broker `0bcd03e32f7f3bfe247b01b570e7ccb5c92f670f`.
- The app is Developer ID signed; this locally generated Installer package is not notarized. The existing authority-preserving native Installer route supports replacing a same-version build; the automatic updater requires a newer version and was not used.
- User-store backup: `/Users/tylercaldwell/Library/Application Support/Apex Deck Backups/before-curate-4aef067f177d-161126/`. It contains 105,110 regular files, 9,883,646,740 bytes, plus preserved directories and symlinks. Unix sockets and other non-regular runtime endpoints were excluded. This was a file backup while the service was running, not an atomic service checkpoint.
- Backup directory permissions: 0700. `BACKUP-MANIFEST.json` records sizes; `JSON-SHA256.json` fingerprints 1,548 copied JSON files. A separate copy of the existing LaunchAgent plist is included.
- LaunchAgent SHA-256 before installation: `28494cbbd762ae2b02574d940a567d3a4fb04993cdb65214563afc599ad82fae`.
- The installer uses `scripts/upgrade.py`: stop writers, back up authority and both apps, replace the app and broker, update hashes in the existing config, verify preserved signing keys and unchanged LaunchAgent, and retain rollback evidence. No first-install or destructive re-pin script was run. Successful installation leaves this account's host stopped until Deck is reopened.

The native Installer is open at **Standard Install on Macintosh HD** for the exact package above. `sudo -n` reports that a password is required. The operator must authenticate in macOS, never send a password to the chat. Quit Deck before the package scripts run: preflight refuses while the app is open. Deck was left running because the observed Local Chat window showed Jigga still working in another worktree. An asynchronous authentication handoff asks the operator to let that work finish, quit Deck, install, then reopen it and report the result. The service restart can terminate the agent carrying out this work.

## Fresh checks

| Check | Result |
|---|---|
| Signed production app build | Passed |
| Native upgrade package build and protected bundle verification | Passed |
| Upgrade and build-stamp tests | 43 passed |
| `cargo test -p apex-core` | 215 passed |
| `TMPDIR=/tmp cargo test -p apex-host` | 859 passed, 9 ignored |
| `cargo test -p apex-daemon authority` | 6 passed |
| `npm test` | 2,855 passed, 3 skipped |
| `npx tsc --noEmit` | Passed |

Build warnings: electron-builder reported unresolved version metadata for dependencies reused through the `node_modules` symlink. Runtime dependencies are bundled by Vite; node_modules are excluded by the package configuration. Build/signature verification passed. Notarization was skipped because no notarization options were configured. Neither observation establishes native runtime acceptance.

Raw logs, before-install service hello, public authority metadata and isolated test fixtures are in `/tmp/apex-curate-upgrade-20261030/`. The before-install service hello still reports `d42276b021bb`, version `0.9.6`, clean.

## Resume after authentication

1. Confirm Installer reports success; inspect its failure output if it does not. Do not bypass preflight or reset provenance.
2. Reopen `/Applications/Apex Deck.app`, which hands off to the protected copy and starts the existing LaunchAgent. Read back both installed CDHashes, the service hello and the installer verification record at `/Library/Application Support/Apex Deck Upgrade/backup-428ebc70-a9fc-413f-990a-40791bb70e5a/installation-verified.json` (or the transaction's retry directory). Compare available before/after public key and authority/host-lock inode metadata, plus the LaunchAgent hash. The installer itself checks private-key preservation; do not claim independent private-key verification without root-readable evidence.
3. Probe `room_curate` and `room_curate_undo` using a nonexistent test ID: the expected response changes from unknown command to missing room. No real thread needs changing for this check.
4. Resume Task 8 on disposable test threads and the same data directory. Do not treat any fixture file read as a journal-read pass. A real curator must first hide both originals; the provider must then retrieve them from `attachments/deck-journals/<test-room>/chat.md`. The long-line fixture's code word starts at character 3,420. Existing user conversations and bot settings remain untouched.
5. Complete the real-provider access matrix, tool-free curator checks, all eight desktop scenarios, Stop, reload, journal lifecycle and failure recovery. Record actual per-cell evidence in `2026-10-30-curate-lookups.md`; all of those results remain pending now.

The required development launch remains `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev` from the main repository. The signed installed UI is also needed for operations requiring protected human attestations; an untrusted development window must not bypass that boundary.
