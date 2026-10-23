# Gate install checkpoint

This is a preparation record, not authorization to replace the running app or
reset protected authority. G2b completion, the stale multi-daemon authority fix,
and review of both security fixes remain prerequisites. Tasks 4–8 remain gated
by the installed checks in INTEGRATION.md.

## Select the reviewed source

The integration lives in the assistant-workspace worktree. The primary checkout
is shared with other work, and its `release/` directory is an output directory,
not an independent Git checkout. Running `git` or Cargo there can select the
primary checkout's branch. On inspection it was `fix/checklist-context-replay`,
not the gate integration, with work in progress. Preserve that work in place.

`scripts/package-mac.mjs` rebuilds release binaries and invokes Electron Builder
relative to its working directory. Calling that script by its absolute path does
not select the script's source checkout. Its default output is also relative.

After G2b and security fixes are reviewed and integrated, record the exact clean
integration commit. Prepare an isolated, commit-pinned source worktree beneath
`/Users/tylercaldwell/Downloads/apex-deck/release/` and start the release build
there, as AGENTS.md requires. Do not switch or clean the shared primary checkout.
Confirm the source worktree's own Git root and HEAD before building. Run required
TypeScript/JS/Rust and feature-off production checks on the integrated source.
Use the lockfile and record the signing identity, build log and source SHA.

Build only the reviewed commit, and copy its finished versioned DMG into
`/Users/tylercaldwell/Downloads/apex-deck/release/`, using a distinct filename if
another artifact for that version already exists. Record the exact app and DMG
paths, app version, SHA256 hashes and UI/daemon/broker CDHashes. Verify strict
deep signatures, hardened runtime, entitlements, every fuse slice and ASAR
integrity before offering this concrete artifact for the install checkpoint.

## Preserve and install

Inventory the running app and daemon executable paths again. Record and preserve
the existing app, normal data directory, LaunchAgent and root authority, including
its keys, journal and config. File versions and bundle identifiers alone do not
identify a build. The legacy user files and protected authority are different
stores; a backup of one does not preserve the other.

Do **not** use `scripts/finish-install.sh` for this candidate. It contains old
staging paths/CDHashes and statements that the authority has no journal. Its
automatic re-pin path invokes `repin-provenance.sh --yes`.

`repin-provenance.sh` currently copies the root authority to a timestamped backup,
then removes the active keys, journal, pins and LaunchDaemon before reinstalling.
It does not restore the journal or automatically roll back a failed install.
Keeping that backup is essential, but it is not preservation of the active
protected records. Resolve and review how existing keys/journal will be carried
forward before running the reset; never assume this authority is empty. Do not
use `--yes` to bypass the administrator's explicit decision. Any restoration must
keep the private key, public key and journal together, with the new build pins.

After installation and the reviewed authority update, compare explicitly against
the selected candidate rather than the verifier's optional default build:

```sh
/bin/bash scripts/verify-install.sh '/absolute/path/to/reviewed/Apex Deck.app'
```

This verifier compares the selected candidate's UI payload and daemon hashes
with `/Applications/Apex Deck.app`, then checks running daemon paths. It does
not compare the full protected TrustedUI bundle independently.
The re-pin script's own default verifier path is relative to its source checkout
and may refer to an older artifact. It cannot replace the explicit comparison.
Launch the protected TrustedUI app and verify the actual running executable and
LaunchAgent paths. A successful copy or selected launch target is insufficient.

## Evidence required to close the gate

Run the committed `scripts/acceptance-provenance.sh` as the normal user, retain
its JSON, and check its source commit, dirty flag and harness hash. The existing
23 PASS / 1 FAIL / 8 SKIP result describes the rolled-back baseline only.

`launchagent.daemon-path` must pass. Also record the installed signed UI issuing a
protected write, the import preview and explicit confirmation, truthful partial
failure/deduplication behavior, and restored assistants/tasks/conversations/rooms
with unverified markers and read-only legacy history. Old work and approvals
must remain inactive until separately approved. Compare inventories to the
pre-install snapshot; do not infer restoration from counts alone.

Record Full access file edits, builds, Git, network and subprocess behavior,
ordinary remote coding on the existing route, and native CLI acceptance. The
harness marks UI/device-dependent checks SKIP; capture their actual evidence
separately rather than relabeling those skips. Review all remaining FAIL/SKIP
items before declaring the gate passed or beginning Tasks 4–8.
