# Shared CLI and desktop agents and threads

2026-11-05 · branch `fix/shared-cli-desktop-store` · Null with Muck.
Unrelated shared-checkout work was preserved. No merge or installed-app update.

## Behavior

- CLI and desktop resolve the same default data root and attach to one daemon.
  New macOS installations use `~/Library/Application Support/dev.apexdeck.app/`.
  Installing the desktop is not required to create this directory or run Apex.
- A previous CLI-only `~/.apex/` store is reused in place when it is the only
  populated store. Selection is serialized and persisted as a restricted enum
  in `shared-store-v1.json` at the standard desktop root. Credentials and
  path-bound protected authority are not moved or copied.
- Explicit `--data-dir` and `APEX_DECK_DATA_DIR` select another store deliberately.
  `--connect-deck` remains attach-only, rather than a prerequisite for sharing.
- Desktop profile events update the Agents view even when threads/projects did
  not change. Profile revisions protect CLI edits from stale desktop saves;
  profile authorship is separate from layout-save authorship.
- CLI listings and edits use the actual mention, including desktop agents with
  generated storage IDs. Edits retain the existing ID and appearance/voice
  metadata; duplicate handles are checked under the same write lock.
- The desktop launches a persistent detached backend, reuses a concurrent
  startup winner, and leaves the shared daemon running on quit. CLI exit also
  leaves shared work running. Explicit backend stop affects connected clients.
- Corrected missing desktop/broker protected-command entries for profile save,
  provider setup, and backend stop. Existing role, receipt binding and replay
  checks remain in force.

## Observed acceptance

`python3 scripts/test-apex-shared-store.py` passed both default startup orders:
CLI first and desktop launcher first. It used the actual CLI terminal process,
the actual desktop sidecar, disposable HOME directories, and the test-only
backend fixture. Both clients reused one boot/store; the CLI displayed saved
Jigga and Null; a shared thread retained its message; CLI exit retained the
daemon. Evidence: `/tmp/as-ilgpzjzo/checks.json` and its terminal captures.

Independent renderer and two-client fixture tests cover profile events,
stale-save protection, thread/message access, and backend restart persistence.
Selection tests cover legacy CLI reuse, concurrent starts, persistent selection,
invalid markers, and preservation of two conflicting old stores.

Final process rerun evidence: `/tmp/as-_88p5ytl/checks.json`, both orders passed.

Verification commands and outcomes:

- `TMPDIR=/tmp cargo test -p apex-cli -p apex-host -p apex-daemon -p apex-provenance`:
  1,530 passed, zero failures, 21 ignored across 31 groups.
- `npm test`: 3,378 passed, zero failures, three skipped.
- After the final generated-ID changes, `cargo test -p apex-cli --lib --tests`:
  56 passed, zero failures, two ignored; host `agent_profiles` tests: five passed.
- `npx tsc --noEmit` and `git diff --check`: passed.
- Initial regressions reproduced the separate root, missing edit identity,
  accepted duplicate mention, and missing broker protected-command registration.
  Two old host test callers were updated to carry the loaded profile revision;
  no stale-write guard was weakened to accommodate them.

## Refreshed signed CLI artifact

`release/Apex-CLI_0.9.8_shared-store_arm64.tar.gz`

SHA256: `9a57f2fe63b33a8f57cc1f14197e18c9dfa590bcfe0f16f747bc9cc39d4c1d8f`

Built from `release/`, then extracted separately under
`/tmp/apex-shared-signed-gmv_5a8x/Apex-CLI_0.9.8_arm64`. Read-back verified all
three manifest hashes and all three Developer ID signatures (team `75N5HW62JH`).
The extracted CLI returned `apex 0.9.8`. This is a signed test archive, not a
notarized installer. It does not contain an updated desktop application.

The exact signed artifact also passed `scripts/test-apex-standalone.py`:
independent IPC-only autostart, two-terminal boot reuse, refusal of raw login and
profile writes, wizard cancellation, restored terminal attributes, and persistent
backend after both terminal exits. Evidence: `/tmp/apex-standalone-4jod1xla`.
Installed authority acceptance remains untested.

For a fresh CLI authority installation, extract into a new directory, enter the
contained `Apex-CLI_0.9.8_arm64` directory, and run:

```sh
sudo /bin/bash ./install-cli-provenance.sh "$PWD"
apex
```

The existing installer still refuses a previously installed standalone CLI;
an upgrade protocol is not part of this sharing fix. Development desktop testing
uses the repository's authorized dev command, and a desktop release must include
these changes before testing an installed CLI/desktop pair.

## Boundaries

Both interfaces need this implementation for live profile sync and the desktop
lifecycle change. Installing a CLI archive does not update an older desktop.
No real user history, provider credential, root authority installation, or running
desktop was replaced during testing. Fixture admission is not installed authority
acceptance; real signed saves/login and installed desktop verification remain
separate checks.

If both old roots were populated before shared selection, startup reports the
conflict and preserves both. Automatic history reconciliation is not implemented;
`--data-dir` explicitly selects either root. No history or grants are silently
discarded, combined, or auto-certified.
