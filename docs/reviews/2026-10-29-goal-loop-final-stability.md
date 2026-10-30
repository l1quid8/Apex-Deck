# Goal/loop stability fixes for Jigga's final review

Branch: `feat/goal-loop`, based on `29eb884`. No merge, push, release, new
installation, or restart of the person's running service was performed.

Review commits:

- `a59c156`: runner polling cache, persistence/re-admission and regressions.
- `0c7884e`: bounded deleted-task polling data and preservation regression.
- `b6ad3a6`: delegation fixture version probes and immutable attribution.

## Phone start delays

Read-only measurements against the installed `29eb884` host found two expensive
paths while the phone was connected:

- Runner state/countdown polling reread the protected ledger on every lookup.
  A paused or scheduled runner woke every 200 ms; each client also polled every
  two seconds. The broker was observed using about 91% CPU. Even the three
  small verification rooms (1.7–4.2 KB) took 2.4–3.4 seconds to read. A chat
  catalog read took 14.5 seconds.
- `personal_list`, polled every 2.5 seconds even while viewing a phone thread,
  returned 11,155,458 bytes. One deleted task contributed duplicate `diff` and
  `reviewDiff` patches, each 5,519,638 encoded bytes. The phone's 8 MiB limit
  correctly refused those replies. Session and verification-room replies were
  small; increasing the frame limit would not address the cause.

The runner store now admits its protected document once per owning host, as the
existing assistant task store does. Polls read that admitted state in memory.
Mutations still use protected writes and broker revision checks, and publish
state only after persistence succeeds. Any operation error evicts the cache:
the next access must read the protected document and its revision again. This
also handles a helper that commits a mutation but loses its acknowledgement.
Startup read failures retain the existing disabled, write-closed behavior.

The derived deleted-task list now omits review patches. Stored task evidence,
ownership, revision, deletion metadata, explicit review and restoration remain
intact. Neither the phone frame limit nor authorization rules changed.

Both regressions were observed failing before their fixes. Coverage verifies
100 polls without another ledger read, a failed write before persistence,
recovery after storage returns, restart recovery, and a durable write followed
by a lost acknowledgement. The deleted-task regression starts with more than
8 MiB of encoded patch data, requires a list under 64 KiB, and checks durable
equality plus restoration of the original review evidence.

These are verified source fixes for observed blocking paths. The precise
contribution of each path to the earlier minute-long phone starts cannot be
separated from the old installed build. **The patched host has not been
installed, so improved physical-iPhone start latency is not yet a native
acceptance result.** A new reviewed candidate should repeat that measurement.

## Recorded delegation failures

All three were reproduced as fixture/assertion defects; no production
delegation behavior or timeouts were changed:

- Result attribution now checks immutable `taskId` and `eventId`, rather than
  searching human-facing text for an internal task ID. It waits for the exact
  expected completed-attempt count.
- Cross-host privacy assertions use unique project briefs because task/event
  IDs are local to each host and can legitimately collide.
- The fake Claude executable answers `--version` without performing worker
  side effects. Previously a usage probe wrote a second `run` marker. Unknown
  prompts now fail before writing files.

The corrected delegation file passed all seven scenarios, including in the
rebuilt-host combined E2E run recorded below.

## Installed real-helper startup acceptance

Command:

```sh
bash scripts/acceptance-provenance.sh --runner-startup-only --keep \
  --evidence .superpowers/sdd/2026-10-29-goal-loop-final/startup-helper-evidence.json
```

Passed: 1 check, 0 failures, 0 skips, exit 0, on installed/protected
`apex-daemon 0.9.5 (29eb8844a3ce)`. Both isolated service starts read the real
protected runner ledger. Their logs contain only listening/stopping, with no
unavailable-ledger fallback. App, daemon and broker signature checks passed.
The person's daemon and broker retained the same PIDs, and the daemon answered
hello plus a runner-state request afterward. The temporary services stopped.

This proves the installed candidate's startup repair. It is distinct from
acceptance of this document's newer source fixes.

## Verification and review

- `npx tsc --noEmit`: passed.
- `npm test`: 2,781 passed, 3 skipped, 0 failed.
- Final focused runner selection: 36 passed, 0 failed.
- `TMPDIR=/tmp cargo test --locked`: 1,698 passed, 14 ignored, 0 failed across
  39 result groups on the final source.
- `cargo test -p apex-host-production-check --locked`, invoked separately:
  6 passed, 0 failed.
- `TMPDIR=/tmp npm run test:e2e`, rebuilding the fixture daemon first:
  26 passed, 0 failed, 0 skipped. Includes all seven delegation cases and all
  four runner scenarios: actual one-minute repeat with no overlap, human
  interruption, cancellation/replay/configuration limits and crash cleanup.
- Independent review caught the uncertain-write cache issue; it was fixed with
  a failing-then-passing regression. Re-review found no remaining correctness
  issues in the combined changes.

Detailed commands, before/after regression logs, metadata-only socket probes,
helper signature/health evidence and full-suite logs are retained under the
ignored `.superpowers/sdd/2026-10-29-goal-loop-final/` directory. Existing
untracked plans, mockups and phone captures were preserved.
