# `/curate` Task 8 acceptance record

Status: **desktop lifecycle verified; provider/access matrix executed with approval requests and provider blockers**. This is not a blanket all-provider acceptance pass. The old-service blocker is resolved. Current evidence is below; the original run remains as history.

## Serial retest and final review follow-up — 2026-10-31

The requested follow-up on `b5c4f9ee` is complete on `fix/curate-alternative-handle`; review remains pending. No push, merge, installation, service restart, or Ds4 server configuration change occurred. This section supersedes the pending serial-retest status below; provider quota, sign-in, and approval limitations in the original matrix still apply.

### Renamed alternative handle

The refusal now uses `apex_core::mention_for(&candidate)` rather than the participant ID. The host regression uses ID `backup` and current name `Renamed Helper`, requires `Message @renamed-helper`, rejects `@backup`, and still verifies that no journal or curation is created. It failed before the one-line fix with `Message @backup`, then passed afterward. This source fix has not been installed.

### Ds4 Read and Ask — serial passes at 65,536

The protected installed window became accessible through its exact TrustedUI application path. Access changes were made there, then verified from fresh `room_state`, on the disposable lookup copy only. Each lookup started from the same 54-message curated baseline, hiding #0–#33. No established TCP connection to port 8000 existed before either lookup; no other Ds4 call or curator was started during these tests. The server advertised 65,536 throughout. The two runs used a 600-second limit and ran one at a time.

| Access | Result | Elapsed | Actual journal tools |
|---|---|---|---|
| Read-only | Both markers returned, no approval | 141.58 s | Two Read calls, completed in 3 ms and 1 ms |
| Ask | Both markers returned, no approval | 95.27 s | One Read call, completed in 2 ms |

Both replies were exactly `COBALT-FERN-7319 AMBER-OTTER-8642`. The Read tool events are 17405–17406 and 17464–17465; its final message is 17655. Ask's tool events are 17992–17993 and final message 18229. Replayed daemon events preserve the actual tool inputs and outputs, not only the step index. The long original remains the measured 4,648-character fixture with its marker at offset 3,204. These are completed two-marker lookups, not a full-context performance benchmark or proof of arbitrary recall.

After each answer the lookup copy was rewound to 54, preventing answer contamination. Its original Full settings were restored through the installed UI and verified from fresh room state. Both QA panes were closed; both rooms were idle. The lifecycle copy remains at its pre-existing Read baseline and retains three new disposable probe messages (#90–#92). Existing conversations and the server were left running.

Evidence: [Read result](curate-task8-review-2026-10-31/serial-retest/ds4-read.json), [Ask result](curate-task8-review-2026-10-31/serial-retest/ds4-ask.json), [actual replayed events](curate-task8-review-2026-10-31/serial-retest/replayed-events.json), and the server/hello/final-state records in the same directory. The earlier contaminated timeouts and curator timing are not used as performance evidence.

### Queue reproduction with and without a failed send

Both cases were exercised in the protected desktop UI in lifecycle room `pane-mvwtcdzq-0`, separately from the Ds4 server:

1. **No unconfirmed send ahead:** send a normal message to unauthenticated Grok, let its acknowledged turn fail and become idle, queue `/curate`, then press its visible Resume button. Curation dispatched (turn_started 17717), failed at Grok sign-in, and left no queued command. This does not reproduce a queue defect.
2. **Unconfirmed send ahead:** queue a harmless message for the paused bot, edit it to address Null with an unknown tool server, and let the host reject it. Ordinary composer validation refused the same fixture before queueing, so the queued-edit route was required to create a genuine retained send failure. The UI showed `Send unconfirmed for Null` and `Retry send`. Queue `/curate` behind it; the UI showed two queued items and `Paused for Null`. Press Resume: the second line changed to `Queued for Null`, but both items stayed, the failed send kept Retry send, and no curator started. All participants were idle. Both disposable items were removed afterward, and the bot's queue count cleared.

This reproduces the reported symptom under a known condition: Resume clears pause flags but deliberately does not retry or discard an unconfirmed earlier send, which remains a FIFO blocker for the same recipient. Retrying automatically could duplicate an already committed send. `ParticipantQueues.drain` checks `item.failed` before dispatch; `resume` does not clear it. Added behavioral coverage for compact, curate, and curate_undo verifies that Resume leaves the failed send and later command in place, and removal followed by Resume allows the command to dispatch. No production queue behavior was changed. The original incident lacks local state and therefore cannot be conclusively assigned this cause; the matching reproduction and UI explanation are the evidence, not a reconstruction of that history.

Native queue observations are recorded in [queue-observations.json](curate-task8-review-2026-10-31/serial-retest/queue-observations.json). Queue items are renderer-local, so the RPC room snapshot alone is not claimed to capture them. The UI currently labels the blocked command merely “Queued” after Resume; explaining its failed-send blocker more clearly is a follow-up UX limitation.

### Fresh verification

| Command | Result |
|---|---|
| `cargo test -p apex-core` | 217 passed |
| `TMPDIR=/tmp cargo test -p apex-host` | 864 passed, 9 ignored |
| `cargo test -p apex-daemon authority` | 6 passed |
| `npm test` | 2,889 passed, 3 skipped |
| `npx tsc --noEmit` | Passed |
| `git diff --check` | Passed |

Scoped Rust total: **1,087 passed, 9 ignored**; this is the plan's Task 8 sequence, not the entire workspace. Every command exited 0. The renamed-handle regression was observed failing before its fix and passing afterward. The three added queue cases characterize the existing deliberate retry rule; no speculative queue fix was made. [Validation summary](curate-task8-review-2026-10-31/serial-retest/validation.json).

## Review follow-up — 2026-10-31

Task 8 remains **open**. Follow-up branch: `fix/curate-acceptance-review`, starting at report commit `53d82b1f`. No push, merge, installation or service restart is part of this follow-up. The feature implementation was already on local `main`; the earlier “nothing merged” statement applies to the acceptance-report commit, not the complete feature.

### Corrections to the earlier results

- The Ds4 **Ask timeout is contaminated**: its lookup overlapped a Ds4 curator in the other QA room on the same local server. It cannot establish an end-to-end lookup failure or a performance limitation. The Read timeout followed Stop and did not establish an uncontended server either. Both cells require serial retesting. The recorded successful file reads remain evidence of access, separate from response completion.
- The recorded Ds4 curator duration is not an uncontended performance measurement and must not be used for Task 9 comparisons.
- Gemini's tool-free path deliberately overrides the usual `agy` discovery and launches `gemini`, avoiding Antigravity's existing service. This Mac has `/Users/tylercaldwell/.local/bin/agy`, but `gemini` is absent from the terminal PATH. The earlier isolation error therefore does not indicate that journal access failed. The follow-up adds executable preflight for the actual isolated route and preserves the isolation boundary; it does not substitute `agy`.

### Source changes and regression evidence

- `curator_profile_ok` checks the actual tool-free Gemini executable before the host starts curation. Missing/non-executable `gemini` is refused with a cause and the handle of another eligible bot when one is present (otherwise generic guidance). A host regression verifies the named alternative and no curation. A Unix adapter test supplies only `agy`, then a non-executable `gemini`, then an executable `gemini`. The original behavior accepted the first configuration; the regression failed against that behavior.
- An undone note covered by a later `/compact` now describes the restoration historically and says the messages are before the latest summary. It no longer promises bots still see the originals inline. The previous test explicitly required the inaccurate wording; its replacement failed before the fix.
- The parser rejects a final JSON object identical to the prompt's example, including fenced/whitespace variants. A genuine later answer still wins; the same IDs with a real reason remain valid. Integration coverage verifies that rejecting the example leaves the transcript and curation list untouched and ends the curator turn. The parser regression failed before the fix.

### Queue diagnosis — unresolved, no speculative queue change

The retained raw events for lifecycle room `pane-mvwtcdzq-0` show Grok failing at global event `11136`, `participant_idle` at `11137`, and room `idle` at `11141`. The queue's local items, `failed` flags, `connectionPaused`, reservations, and the Resume click were not captured, so those frames do not identify the local blocker.

New behavioral tests replay an acknowledged normal post, a queued whole-room command, provider failure, participant idle, room idle, and Resume. All three commands (`compact`, `curate`, `curate_undo`) dispatch and clear their reservations in this reproduction. Existing tests separately verify that an *unconfirmed send* requires **Retry send**, and Resume deliberately does not retry it. That is a possible explanation only, not an established cause of the recorded desktop incident. No production queue change is justified by this evidence. Native reproduction with local queue-state capture is still required before calling this finding resolved.

### Serial Ds4 retest — blocked before either lookup

Prepared a serial-only harness using the original curated 54-message QA baseline, with a 600-second limit per lookup, no overlapping curator, no live TCP connections to port 8000 at the initial idle check, and restoration of the QA bot's original Full setting. Both QA rooms were idle. The server currently advertises **65,536** tokens; its configuration was left unchanged.

The service refused the first QA `room_update_participant` call because this mutation requires a protected installed-UI provenance receipt. Computer control found the installed process but could not select its window (`cgWindowNotFound`; the launcher path also timed out). The Human was asked to bring the installed window onscreen. No access setting changed, no new Ds4 model call started, and neither Read nor Ask was rerun. These cells remain pending; this is not a successful serial retest. See [retest-blocker.json](curate-task8-review-2026-10-31/retest-blocker.json).

### Follow-up validation

| Command | Result |
|---|---|
| `cargo test -p apex-core` | 217 passed |
| `TMPDIR=/tmp cargo test -p apex-host` | 864 passed, 9 ignored |
| `cargo test -p apex-adapters --lib` | 328 passed, 3 ignored |
| `npm test` | 2,886 passed, 3 skipped |
| `npx tsc --noEmit` | Passed |
| `git diff --check` | Passed |

Rust total: **1,409 passed, 12 ignored**. Additional final scoped runs passed 38 core curation tests and 23 host curation tests; these overlap the totals above. TypeScript emitted no diagnostics. [Validation summary](curate-task8-review-2026-10-31/validation.json) and the four red-stage logs beside it retain the measured results. An earlier full host run included the deliberately failing alternative regression before its fix; the final full host run passed. Native acceptance of the new source fixes remains pending because this follow-up does not install them.

## Current live run — 2026-10-31

Executed on `test/curate-task8-resume`, based on `feff887b`. The installed protected UI and service are 0.9.7; live `hello` reports clean build `861824670088`, boot `8ba7cb0261f71e4005bcbca838388c24`. This is a newer installed build than the originally prepared 0.9.6 upgrade; this run does not independently attest the earlier installer transaction or private-key preservation.

Created disposable Work room `pane-mvwsyria-0` using the installed UI with existing saved configurations: Codex `gpt-6.1-sol`, Claude `claude-opus-5-5`, Gemini `gemini-4-argon`, Grok `grok-4.7`, Muse `muse-spark-1.3`, and local OpenAI-compatible Ds4 `deepseek-v4-flash` at `127.0.0.1:8000/v1`. A trusted-UI fork, `pane-mvwtcdzq-0`, separates lifecycle tests from lookup tests. Existing conversations and saved agent configurations are preserved. Access changes apply only to the QA copies, up to their original Full baseline. No authentication or approval was supplied to make a failed cell pass.

The required dev command was launched from the main repository with the prescribed data directory. Its daemon build finished and Vite started. The installed protected UI was used for native acceptance; the dev process was subsequently closed. Starting development does not replace the running installed service.

Fixture preparation encountered transient `Resource temporarily unavailable (os error 35)` save failures. Some setting/name changes did not persist. Writes later recovered without a service restart; each subsequent tested access level is verified from `room_state`, rather than inferred from the selected radio button.

### Fixture and contamination controls

A real Codex curator hid all of `#0–#33` at boundary 54. Both the short marker in `#0` and long bot message `#31` are inside that hidden range; their original prompts are hidden too. The journal header covers `#0–#53`, permissions are `0600`, size 10,517 bytes. Independent decoded `|`-chunk reconstruction equals the saved originals byte-for-byte:

| Original | Characters | SHA-256 |
|---|---:|---|
| `#0` | 133 | `e885f11f9cc618abd66c1e743c8cdb717cbffbc6fc5e07ffef75144432a577f1` |
| `#31` | 4,648 | `5c0099e89dc7e4d02f9ccbc14fffe9afe3b717895dfefb478bc2ecec8db7f110` |

Fixture deviation: the prepared file contained 5,000 characters, but Codex's echoed **stored message** contains 4,648. The long marker begins at zero-based offset 3,204, still past the 2,000-character clipping risk and requested 3,000-character boundary. This run tests that measured original; it does not claim an exact 5,000-character stored fixture. Ds4's initial fixture generation stalled and was stopped.

Each lookup starts from the same 54-message curated baseline. After recording a response and its tools, the QA room is rewound to 54, preventing later bots from reading another bot's answer inline. A harness race initially misread pre-start idle as completion; that observation was discarded and Codex's actual completed turn was recorded separately. Approval cards are recorded and the turn stopped, without approving them. Timeouts are bounded at 150 seconds, followed by Stop and idle read-back.

### Confirmed desktop observations

- Typing `/cur` offered `/curate` and `/curate undo` with their expected descriptions.
- Real curation produced “34 older messages hidden from bots · chosen by Null.” Expanding it showed the exact ranges, reason, placeholder and Undo control.
- “Show in chat” visibly scrolled to original `#0`; the Human transcript still displayed the full text.
- Renderer reload restored the curation note and an in-flight provider turn after hydration.
- In the lifecycle fork, native `/curate undo` restored 34 messages and changed the note to undone. Later undo restored 35 after a second real Claude curation.
- With Ds4 visibly “Choosing what to hide”, clicking **Stop Ds4** showed “Stopped. Nothing was hidden.” Fresh room state was idle, contained no new curation, and its journal was absent because earlier curations were undone.
- Grok's failed curator showed “Couldn’t finish /curate: … Not signed in …”, cleared its working state and applied no curation. A subsequent native `@null` message returned exactly `QA_RECOVERED`.
- A normal failed Grok turn first paused the QA queue. A queued `/curate` remained paused after Resume; after removing that disposable item and reloading the renderer, the idle-room curator failure and successful following send above were exercised. This queue observation is retained as a limitation, not silently counted as a clean recovery.

- A real `/compact` in the lifecycle fork set boundary 66, preserving all 66 originals. Undo returned `restored: 0, sealed: 44`.
- After 24 more QA messages, a real Codex curation hid exactly `#66–#69` at boundary 90. Its separate **Show in chat** visibly jumped to “Post-compact completed disposable QA filler 0”, distinct from the earlier jump to `#0`.
- Native `/curate undo` displayed: “4 messages are back for the bots. The 44 older messages can’t be restored to active context: they’re before the latest /compact. Originals remain in your chat and available for lookup.” Read-back marked only the later curation undone; another undo returned `restored: 0, sealed: 44`.
- Blocking only the lifecycle QA journal directory with a task-owned file refused `/curate` before a model turn, in under a millisecond, with no curation change. The blocker was removed and the original QA directory restored in `finally`; a subsequent real Codex curation hid 44 messages.
- Read-only custom `/usr/bin/true` bot `qa-cli` was refused: “QA CLI can't pick without tools. Message another bot, then run /curate again.” No curator turn started for that request.

The restored/undone note wording after a subsequent compact remains a known source issue: `noteLines` ignores `sealed` when `undone` is set, so the earlier Task 7 wording review is still unresolved. The defensive `!curating` structured-step guard is now present in the current checkout. Neither observation is silently treated as a new fix in this acceptance task.

Selected evidence is retained in [evidence.json](curate-task8-2026-10-31/evidence.json): measured originals and hashes, all attempted matrix cells, replies, approval actions, errors, forced-read events, and curator outcomes. Raw RPC frames and automated logs remain in `/tmp/curate-task8-20261031/`; those temporary files are supplementary.

### Provider/access results

**P** = completed answer with both correct markers; **A** = pending host approval request, recorded and canceled without approval; **R/T** = file-read tool returned both markers, but no completed answer within 150 seconds; **Q** = explicit provider quota error; **L** = provider not signed in; **N/A** = access level is absent from Deck's UI.

| Provider | Read | Ask | Edit | Full | Forced Read-only during another bot's turn | Tool-free curator |
|---|---|---|---|---|---|---|
| Codex / Null | P | A | P | P | P | P — hid 37 |
| Claude / Jigga | P | A | A | P | P | P — hid 40 |
| Gemini / Forge | P | Q | Q | Q | Not requested | Failed — CLI executable not found |
| Grok / Gronk | L | N/A | L | L | Not requested | Failed — not signed in |
| Muse / Muck | P | N/A | P | P | Not requested | P — hid 43 |
| Local API / Ds4 | P (serial retest) | P (serial retest) | P | P | Not requested | P — hid 31 |

- All 22 available provider/access cells were attempted. Grok and Muse do not expose Ask, so no unsupported configuration was injected. Neither provider authentication, subscriptions nor bot permissions were widened to turn a failed cell into a pass.
- Codex Ask requested approval for a Python command that decoded journal chunks. Claude Ask and Edit requested approval for shell-based reads/searches. The actual approval action text is in the evidence bundle. Read-only Claude used its read/search tools without an approval request.
- Gemini's later normal turns explicitly reported `Individual quota reached` (exit 3). Its separate tool-free curator failed with `Gateway isolation: CLI executable was not found`; that result is not conflated with quota or a successful curator.
- Grok reported exit 1, `Not signed in`. Its failure occurs before journal access, so this establishes no Grok lookup capability.
- **Superseded for end-to-end/latency conclusions by the review follow-up above.** Ds4's Read-only and Ask `read` tools completed in 1 ms and 0 ms respectively and returned both markers in the journal output. Those are successful file-access observations; the answer timeouts remain failed end-to-end answer checks. Edit and Full subsequently completed with both markers.
- Codex and Claude correctly reconstructed the 4,648-character original in their Read runs. Gemini supplied both correct markers but incorrect length/offset; Muse initially repeated the requested 5,000/3,420 values rather than the measured original. Those numerical claims were rejected. A **P** in this table certifies the two-marker retrieval task, not arbitrary reconstruction accuracy.
- Successful tool-free curator turns emitted “Choosing what to hide” but **zero `work_step` events**. Retained event ranges cover all six curator attempts, plus Stop/retry runs. The custom CLI refusal produced no curator turn. These are real provider calls, not scripted participants.

### Forced Read-only setup and proof

An initial Plan-mode probe returned both markers but emitted no contention fallback: Plan mode directly makes requests Read-only. It is preserved as a separate probe and **not counted** as the forced-read result.

The actual test used normal mode and the QA bots' original Full settings. Task-owned `work` marker files were placed only at `bot-copies/pane-mvwsyria-0/{null,jigga}/work`, causing their separate-copy requests to refuse before creating a worktree. Ds4 started first and held the room editor slot. The service then emitted:

- Event `14404`: Null is Read-only because Ds4 is editing and a separate copy is unavailable.
- Event `14405`: Jigga is Read-only for the same reason.

Both participants returned `COBALT-FERN-7319` and `AMBER-OTTER-8642`. Both requests were started before either answer existed inline. The holder was stopped after the readers finished, all test messages were removed by QA-only rewind to the curated baseline, and all marker files were removed in `finally`. Final read-back: idle, Plan off, 54 original fixture messages, Full baseline restored for the six provider copies, and neither copy blocker exists. No shared-checkout file was changed by this setup.

### Acceptance limits and handoff

The desktop command/menu, real picking, count/chooser note, expanded note, distinct jumps to `#0` and `#66`, undo/journal removal, sealed undo, later partial undo, bubble Stop, renderer reload and failed-curator followed by successful native send were exercised. Journal write refusal/recovery and custom-CLI refusal were additionally exercised against the installed service.

The feature is **not verified for every provider at every access level without approval**. Remaining constraints are the A/R-T/Q/L cells above, Gemini's curator executable failure, the pre-existing undone-note wording after a later compact, and the external-command/local-queue observation recorded above. No service cold restart was performed while other conversations were active. No performance/quality comparison with `/compact` or tiny-model benchmark is claimed; those are Task 9. Both QA panes are closed and their test snapshots/journals remain available for review; the installed service and other conversations were left running.

README and SPEC already contain the commands and an acceptance-pending link. That wording remains accurate because of these limitations. This run changes documentation/evidence only; it performs no merge, push or installation. A named whole-branch review is the next gate, rather than an assertion that this report itself is an independent review.

### Current automated verification

All commands ran on checkout `feff887b`; these are source tests, separate from installed runtime build `861824670088`.

| Command | Result |
|---|---|
| `cargo test -p apex-core` | 215 passed, 0 failed |
| `TMPDIR=/tmp cargo test -p apex-host` | 863 passed, 0 failed, 9 ignored |
| `cargo test -p apex-daemon authority` | 6 passed, 0 failed |
| `npm test` | 2,883 passed, 0 failed, 3 skipped |
| `npx tsc --noEmit` | Passed, no diagnostics |

Scoped Rust total: **1,084 passed, 9 ignored**. The complete command chain exited 0. Cargo initially waited for the required dev build's target-directory lock; no test failure was suppressed. No product source changed during this run.

## Historical run — 2026-10-30

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

The Human explicitly authorized preparing and installing the matching service upgrade, preserving existing data, and then resuming Task 8. That authorization covers the upgrade's required app/service restart; it does not authorize a destructive provenance reset, changing the required dev data directory, or widening existing bot permissions. The verified installer and data backup are recorded in [the upgrade report](2026-10-30-curate-service-upgrade.md). macOS administrator authentication remains necessary; this is an authentication dependency, not another request for permission.

Task 8 is not complete and the branch is not ready to merge on the evidence above.
