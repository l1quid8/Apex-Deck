# PR92 review fixes and Windows crash investigation

Source: [PR92](https://github.com/l1quid8/Apex-Deck/pull/92), target `main`, original base `b8fee74149e4efbd63a0e7b9dadcd1b88f578c35`, original head `12226bc74334e7ba2e190a4430e63c1956f9b716`.

## Behavior

- Talk-only chat creation uses no execution folder. An exact assigned project is saved in the protected RoomAuthority transaction alongside the room kind and permissions. The optional `project` argument chooses among assigned projects. Discovery, initial delivery, subsequent actions and undo revalidate that exact project and current access. Editable catalog/pane fields supply no authority. Fork/import creates a new unassigned chat; ordinary saves preserve an existing association.
- Explicit blocker assertions remain risks when followed or preceded by a question. Pure questions and hypothetical clauses remain progress.
- Resolution uses bounded full evidence independently of the short displayed quote. Every identified risk-bearing clause must resolve; ambiguous clauses with several adverse indicators stay open. A receipt or passing check cannot erase an unrelated failure. Fresh adverse evidence cannot declare a global clearance.
- Truncated captures and old ellipsized excerpts remain unresolved conservatively, even after a global all-clear, until the watch expires or is cancelled. This avoids treating missing evidence as resolved.

New tests reproduced all three original defects before production changes. A second independent review exposed introductory-question and unsplit-risk-cue variants; tests reproduced these too. The revised implementation passed the independent static review. No merge, installation or release is part of this work.

## Windows evidence

The selected connected account's current diagnostics were read at the original head:

- [daemon Windows app shard 1/4](https://github.com/l1quid8/Apex-Deck/actions/runs/46133273862/job/140942966861): 1,095 passed, 62 skipped, one failed. `tests/desktop-menu.test.mjs` printed its native-menu assertion success and then exited `3221225477` (`0xC0000005`).
- [Windows desktop UI job](https://github.com/l1quid8/Apex-Deck/actions/runs/46133273844/job/140942935219): the identical native-menu test passed at the same head, and all 106 tests passed.
- [daemon aggregate](https://github.com/l1quid8/Apex-Deck/actions/runs/46133273862/job/140947061501): failed downstream of the Windows shard.

This establishes an intermittent native crash after assertions. The tested fixture extracts only `menu()` and does not start Alfred's administration or watch paths.

Further investigation found [Electron issue 55011](https://github.com/electron/electron/issues/55011), which documents the same intermittent Windows exit code under load when `app.exit()` runs inside `ready`, and a zero-delay timer workaround. The pinned [Electron v44.5.1 implementation](https://github.com/electron/electron/blob/v44.5.1/shell/browser/browser.cc#L130) takes C `exit()` when the main loop cannot yet accept the exit code. The upstream report attributes the native crash to sandbox startup threads racing static teardown. This is a strong match; the original CI crash has no dump to establish its exact native stack.

A new native characterization check proved the old fixture exited before a scheduled main-loop turn: six menu tests passed and the native scenario failed that assertion. The success exit now waits one main-loop turn, matching the upstream workaround. The resulting eight native menu/environment checks passed; recorded phases show assertions, main-loop turn, exit request, then quit code zero. The real Windows crash remains subject to verification in the new CI run.

## Diagnostic capture

The fixture retains `app.exit(0)` and one attempt, deferring the success exit until the main loop runs. When `APEX_MENU_DIAGNOSTICS_DIR` is set it records platform/runtime versions, menu construction phases, assertion completion, exit request, lifecycle events, the child exit result and the exact generated synthetic fixture. Electron Crashpad collects local native dumps with `uploadToServer: false`; the child receives only an allowlist of OS launch/display environment settings, excluding CI/application secrets. The Windows app CI job retains this directory as a seven-day artifact on failure.

See Electron's [crashReporter documentation](https://www.electronjs.org/docs/latest/api/crash-reporter) for local dump storage and its [app lifecycle documentation](https://www.electronjs.org/docs/latest/api/app) for exit/quit semantics. The diagnostic capture remains in place alongside the focused early-exit workaround. If a crash recurs, compare the final recorded phase with the native stack and reproduce at that exact revision.

## Local verification

- Original regression run: 291 passed, three expected failures, nine ignored.
- Full Node suite: 4,204 passed, one failed, 29 skipped. The failure was the unrelated `App dock: drops, steady layouts, floating dialog, reveal and tab chips at 1512` resting-height assertion. Isolated rerun of the complete dock file passed both tests.
- Native menu and fixture environment checks: eight passed. Separate diagnostic-enabled menu run: seven passed with lifecycle evidence through exit code zero on macOS.
- TypeScript: `npx tsc --noEmit` passed.
- Protocol generation: `node scripts/gen-protocol-types.mjs --check` passed.
- Focused final release-watch and administration tests: 17 and eight passed, respectively.
- Storage authority save/fork/import regression: one passed.
- Complete host attempt: 1,457 passed and 18 ignored, with two pre-existing runner fixture checks stuck launching native children (`configured_argv_check_runs_and_bounds_output_and_timeout` and `configured_check_cannot_write_host_data_after_full_acceptance`). Their samples were still at `_dyld_start`, before test code. The run was interrupted after several minutes; this is not a complete host-suite pass.
- Separate production authority invocation compiled but its empty unit-test executable also stalled at `_dyld_start`; it was interrupted before integration tests ran. That gate remains unverified locally.
- New main-loop characterization: observed the old immediate-exit path fail, then eight native checks pass after the deferral. No retries or skips were added.
