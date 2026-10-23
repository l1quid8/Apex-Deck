# Gate integration status

Branch: `fix/assistant-workspace-integration` in the existing assistant-workspace
worktree. No integration changes were made in the primary checkout or installed
apps; other work continues in the primary checkout independently.

## Security follow-up after `ae792dce`

Independent broader source review found two P1 issues. The first is corrected
and scoped-review approved in `05d2502`: old Full/Edits room grants reset to Ask,
custom CLI bots stay inactive until added again through the UI, and preview/result
rows disclose omitted bots while the original snapshot stays available. Three
regressions failed before the fix; all 19 import integration tests pass afterwards.
The complete checks passed: 2,134 JS, 1,310 Rust with 8 existing ignored, the
3 feature-off production checks, TypeScript and whitespace validation. Logs:
`/tmp/apex-gate-security-{npm,cargo,production}.log`. The additional skipped-bot
count/result assertion also passed in a focused run after the full suite.

The second P1 is source-fixed and independently approved in `636e4ef`: an
editable `owner.lock` cannot be the adversarial singleton. Stable root-owned
lock inodes now protect both canonical ledger folder scopes; the Host retains
their exclusive kernel locks and protected IO requires live guards. A missing
broker still permits startup without authority. Observed contention is fatal,
and a failed initial ledger read after ownership succeeds now aborts startup
before recovery instead of combining empty task ownership with readable rooms.
That additional review finding was reproduced RED and fixed GREEN.

Final default Rust: **1,331 passed, 0 failed, 8 existing ignored**. Separate
feature-off production crate: **3 passed**. JavaScript: **2,134 passed**.
TypeScript, whitespace and shell syntax passed. Logs:
`/tmp/host-ownership-rust-final.log`, `/tmp/host-ownership-production-final.log`,
`/tmp/host-ownership-js.log`. The earlier in-progress Rust run was interrupted
for the startup fix and superseded by this complete final run.

Independent exact-commit security/spec/quality review approved `636e4ef` with
no remaining concrete P1/P2 in the scoped fix, including active-work lifetime.
See [the ownership plan](../../superpowers/plans/2026-10-22-protected-host-ownership.md)
for the contract and local `.superpowers/sdd/2026-10-22-protected-host-ownership/`
for the implementation report and review ledger. These are source/fixture
checks; signed installed duplicate-daemon, `owner.lock` replacement with a live
client, and actual broker-restart acceptance remain required.

G2b's remaining UI work remains assigned to @deepgeek from `ae792dce`; mention
@null with the scoped commit and results. It need not absorb this host fix.
No main merge, release build, installation, re-pin, import or new installed acceptance
run occurred during this follow-up. Use [INSTALL-CHECKPOINT.md](INSTALL-CHECKPOINT.md)
before preparing the candidate; the release directory belongs to a different
shared checkout and the old finish-install script is unsuitable.

## Integrated source

| Source commit | Integration commit | Scope |
| --- | --- | --- |
| `3a25e9f` | `2d5a1a5` | G4 TrustedUI launch handoff and LaunchAgent downgrade guard |
| `3f4bd11` | `11f5373` | G3 harness, adversarial tests and checklist mapping |
| `e12f11c` | `d27ddeb` | Real stdio attach, valid tamper fixture, source evidence stamps |
| `e4b2c79` | `ba81877` | G2b initial notice, preview, confirmation and result screen |

These are task-branch integrations. G2b and the overall security gate are not
complete; no main merge, release build, installation, re-pin or production import
has been performed.

## Null's integration corrections

- Both tamper starts must have usable protected storage. Regression tests first
  reproduced PASS for an exact empty fallback despite an unavailable-store log;
  either startup log now makes the check FAIL.
- `room_state.legacy` is the optional `LegacyMarker` from the protected room
  authority, cached when the room opens. Editable transcript JSON cannot set it.
  A regression covers import, restart, plan save, another restart and a new room
  with no marker.
- Both stale hash refusals carry `[LEGACY_IMPORT_PREVIEW_CHANGED]` over the
  existing string-error protocol. `createLegacyImportClient().apply()` converts
  that token, including IPC-wrapped errors, to `LegacyImportPreviewChangedError`
  with `.code === "LEGACY_IMPORT_PREVIEW_CHANGED"`. `isStalePreview()` uses that
  code rather than matching human-readable sentences. No apply is retried.
- `runLaunchPlan()` executes the startup open/quit/notice effects before the
  caller continues to agent work. Tests cover successful handoff, missing
  install, development/isolated-data bypass, and open failure. A rejected open
  with an empty error message now shows the notice instead of exiting as if the
  handoff succeeded.

Ruling: preserve the existing string-error wire and normalize a stable token in
the typed client, rather than migrate every command to a new error envelope —
this closes the copy-dependent decision without changing transport or receipt
semantics. Older hosts without the token report a normal error and do not retry.

## Handoff to @deepgeek

Complete G2b on a separate task branch/worktree and mention @null with the scoped
commit and test evidence. Consume `RoomState.legacy` and the typed stale error
above. Remaining required work:

1. Refresh assistant/task/conversation/room views after import. The initial
   panel's optional callback is not connected to their state owners.
2. Render the imported/unverified marker where those lists show status; type
   legacy task and conversation data, and open legacy transcripts read-only via
   `api.history(snapshot, requestId)` with the same label.
3. Show the legacy task's saved `owner.cwd` before a fresh retry decision.
4. Clear/disable the old confirmation while a stale preview reloads. The current
   screen keeps the old preview and re-enables Import before the new read ends.
   Keep it unavailable if that reload fails; never retry apply automatically.
5. List unreadable/unavailable/conflicting sources even when their record counts
   and problem arrays are empty. `interestingLedgers()` currently hides these.
6. Verify pane/backend changes, shared notice state after import, and changed
   sources after dismissal. The session preview cache currently never refreshes
   on its own, and capability misses are cached permanently. Test real lifecycle
   behavior; the initial component harness runs effects on every render and does
   not model dependency arrays.

## Verification and gate

Focused corrections passed after observed failing regressions: 16 host import
tests, 27 import client/model/component tests, 3 tamper-check tests and 39 startup/
LaunchAgent tests. Full JavaScript: 2,134 passed. Full Rust: 1,307 passed, zero
failed, 8 existing ignored checks. The separate feature-off production crate
passed all 3 checks. TypeScript, JavaScript syntax, shell syntax and whitespace
checks passed.

Commands and temporary logs (logs may expire):

- `npm test`: `/tmp/apex-integration-npm.log`
- `npx tsc --noEmit`
- `TMPDIR=/tmp cargo test -- --test-threads=2`: `/tmp/apex-integration-cargo.log`
- `TMPDIR=/tmp cargo test -p apex-host-production-check -- --test-threads=2`:
  `/tmp/apex-integration-production.log`

Installed acceptance reran from clean commit `542f10c2267d3a0cd31b60fb2e9fbc5ffeed5183`
at 2026-10-23 04:59Z: **23 PASS / 1 FAIL / 8 SKIP**. Evidence:
`target/acceptance-provenance/evidence-20261023T045910Z.json` (ignored; not
committed). Its source/hash stamp was checked against that checkout and the
actual script bytes. The sole failure remains `launchagent.daemon-path`, pointing
at `/Applications/Apex Deck.app/Contents/Resources/bin/apex-daemon`. Both tamper
startup log guards passed. The isolated folder was removed and the existing
broker remained running. This final documentation update changes no tested code.

Repeat acceptance after the reviewed candidate is installed and re-pinned. The
rolled-back installation is a baseline, not acceptance of this source. A green
LaunchAgent path alone does not close the gate: the signed UI-issued write/import,
preserved data, Full access, ordinary remote coding, and native CLI evidence are
still required. Tasks 4–8 remain gated until those checks and the security review
are complete.
