# `/curate` Task 8 acceptance record

Status: **incomplete — matching desktop service required**. This report records an attempted native-app run, not a successful curation or provider lookup.

## Checkout and launch evidence

- Checkout: `c9d3c313497f`, with Tasks 1–7 and the quoted-tool-request fix. Task 8 branch: `test/curate-task8`.
- Started from `/Users/tylercaldwell/Downloads/apex-deck` with the required command:

  ```sh
  APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev
  ```

- `cargo build -p apex-daemon --features remote` succeeded. Electron opened the actual desktop UI at `localhost:5173/`.
- The UI visibly reports: “This Mac's service is build d42276b021bb; this app is build c9d3c313497f. Features may fail until they match, so update one of them.”
- A fresh protocol `hello` on the same data directory's `daemon.sock` confirms service version `0.9.6`, build `d42276b021bb`, `build_dirty: false`.
- Both command probes used the nonexistent ID `qa-curate-task8-nonexistent-probe`, so they did not address or alter a real thread:

  ```text
  room_curate      -> unknown variant `room_curate`
  room_curate_undo -> unknown variant `room_curate_undo`
  ```

The installed daemon predates this feature. Rebuilding the checkout does not replace it: `desktop/sidecar.mjs` attaches to a daemon already listening on that data directory's socket. The native installed app and active group conversations remain on that service. No service was stopped, replaced, installed or re-pinned. No provider access level was changed. No test message was submitted to a provider.

Raw probe output and automated logs are under `/tmp/apex-curate-task8-20261030/` for this run. Temporary logs are supplementary; the identifying results are copied here.

## Eight desktop scenarios

| Scenario | Result |
|---|---|
| 1. `/curate` command/menu | Not exercised; service rejects the command before a curator can run |
| 2. Real bot picking / working bubble | Blocked by service version |
| 3. Hidden note with actual count and chooser | Blocked by service version |
| 4. Expanded note and both distinct Show in chat targets | Blocked by service version |
| 5. `/curate undo` command/menu | Not exercised; service rejects the command |
| 6. Successful undo and journal removal | Blocked by service version |
| 7. Undo blocked by `/compact`, with accurate historical details | Blocked by service version |
| 8. Partial undo after a later curation | Blocked by service version |

Native Stop, reload persistence, journal lifecycle, failing-provider recovery followed by a successful send, journal-warning recovery, tool-free curator turns, and custom-CLI refusal also remain untested. Existing unit tests and earlier preview runs do not substitute for these checks.

## Provider lookup matrix

`B` means **blocked before testing by the old daemon**, not a provider failure or a successful read. No approval-card behavior has been established in this run. Each cell must retrieve both a short-message code word and a second word beyond character 3,000 of a 5,000-character single-line original, from messages actually hidden by `/curate`.

| Provider | Read | Ask | Edits | Full | Forced read-only while another bot runs | Tool-free curator |
|---|---|---|---|---|---|---|
| Claude | B | B | B | B | B | B |
| Codex | B | B | B | B | B | B |
| Gemini | B | B | B | B | Not requested | B |
| Grok | B | B | B | B | Not requested | B |
| Muse | B | B | B | B | Not requested | B |
| API bot | B | B | B | B | Not requested | B |

## Known source findings carried into acceptance

These were rechecked in the current source, not reproduced in a live curator turn:

- `src/curationNotes.ts` still says “bots see them again” for an undone note even after `/compact` seals its boundary. The Task 7 wording review remains unresolved.
- `src/ChatPane.tsx` still renders structured work steps before checking the curation marker. The defensive Task 7 guard remains unresolved; no real-provider failure has been demonstrated.
- Example-only curator JSON rejection remains a prerequisite for Task 9, as requested in the backend review.

## Automated verification

The complete Task 8 sequence exited successfully on this checkout:

| Command | Result |
|---|---|
| `cargo test -p apex-core` | 215 passed, 0 failed |
| `TMPDIR=/tmp cargo test -p apex-host` | 859 passed, 0 failed, 9 ignored |
| `cargo test -p apex-daemon authority` | 6 passed, 0 failed |
| `npm test` | 2,855 passed, 0 failed, 3 skipped |
| `npx tsc --noEmit` | Passed, no diagnostics |
| `git diff --check` | Passed |

Rust total for these requested commands: 1,080 passed, 9 ignored. This is the scoped Task 8 sequence, not a repeat of the entire Rust workspace suite. The app isolation test emitted CSP-block diagnostics and itself passed. No test failure was omitted.

README and SPEC now document the commands with an explicit live-acceptance-pending link here. Product code was not changed in this task. The author checked this documentation against the observed UI, socket replies and completed logs; a whole-feature acceptance review is deferred until the native/provider scenarios run.

## Resume gate

Run the acceptance scenarios after the UI and service both use the reviewed feature build. Do not stop the active service, replace the installed app, re-pin provenance, change the required dev data directory, or widen bot permissions merely to fill the table. The plan explicitly requires the Human's word before installation. A matching upgrade package was proposed for preparation; authorization is pending.

Task 8 is not complete and the branch is not ready to merge on the evidence above.
