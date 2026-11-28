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

This establishes an intermittent native crash after assertions, not its native cause. There is no crash stack in the original diagnostics. The tested fixture extracts only `menu()` and does not start Alfred's administration or watch paths.

## Diagnostic capture

The fixture retains its original `app.exit(0)` and one attempt. When `APEX_MENU_DIAGNOSTICS_DIR` is set it records platform/runtime versions, menu construction phases, assertion completion, exit request, lifecycle events, the child exit result and the exact generated synthetic fixture. Electron Crashpad collects local native dumps with `uploadToServer: false`; the child receives only an allowlist of OS launch/display environment settings, excluding CI/application secrets. The Windows app CI job retains this directory as a seven-day artifact on failure.

See Electron's [crashReporter documentation](https://www.electronjs.org/docs/latest/api/crash-reporter) for local dump storage and its [app lifecycle documentation](https://www.electronjs.org/docs/latest/api/app) for exit/quit semantics. This is instrumentation, not a claim that the crash is fixed. If it recurs, compare the final recorded phase with the native stack, then reproduce at that exact revision before changing shutdown behavior.

## Local verification

- Original regression run: 291 passed, three expected failures, nine ignored.
- Full Node suite: 4,204 passed, one failed, 29 skipped. The failure was the unrelated `App dock: drops, steady layouts, floating dialog, reveal and tab chips at 1512` resting-height assertion. Isolated rerun of the complete dock file passed both tests.
- Native menu and fixture environment checks: eight passed. Separate diagnostic-enabled menu run: seven passed with lifecycle evidence through exit code zero on macOS.
- TypeScript: `npx tsc --noEmit` passed.
- Protocol generation: `node scripts/gen-protocol-types.mjs --check` passed.
- Focused final release-watch and administration tests: 17 and eight passed, respectively.
- Storage authority save/fork/import regression: one passed.
- The complete host suite and separate production authority checks were still running at submission; final results are reported in the task chat.
