# Assistant workspace continuation

Continue from `fix/assistant-workspace-integration` in
`/Users/tylercaldwell/Downloads/apex-deck-worktrees/assistant-workspace-plan`.
Current integration status and contracts: [INTEGRATION.md](INTEGRATION.md).
The G2a completion base remains `12f2d61` on `fix/assistant-workspace-completion`.
The earlier `docs/assistant-workspace-plan` branch is preserved at `6b2e21e`.
Read this together with [HANDOFF.md](HANDOFF.md), the task briefs, and the
binding [security boundary](../../security/provenance-boundary.md).

## G2a fix round

The committed WIP already wired personal imports and per-room deduplication;
the earlier handoff understated its implementation progress. This continuation
adds regression coverage and fixes the following review findings:

- Clear process fingerprints from every imported personal receipt, including
  settled tasks, and turn every Attempted receipt into Uncertain. Editable
  legacy process IDs must never become recovery instructions to signal a group.
- Require Ask or Hand off for all imported action classes, including reads.
  Preserve local folders only as scope ceilings; preview that every operation
  needs a new approval. Machine links/grants remain inactive, schedules proposed,
  unfinished events failed, and old pending work requires a new decision.
- Mark imported personal messages individually and label historical messages and
  facts as unverified in model context. Preserve correction/forget chains.
- Validate saved ID namespaces and repair counter high-water marks before
  allocating any new decisions. Reject duplicate/empty IDs and exhausted counters
  per assistant with a preview problem, rather than importing ambiguous approvals.
- Count omitted grants and use distinct preview IDs for multiple grants to one
  assistant. Count skipped task/request/handoff/execution records in apply results.
- Accept all personal preview kinds and personal source hashes in the typed
  client; expose legacy markers and validate returned skipped IDs.

Ruling: retain local folder scope with every action at least Ask, rather than
clearing folders and promising an unavailable folder-grant editor. Independent
review traced the runtime paths and found no filesystem execution before a fresh
protected operation/schedule decision or settings change. A worker regression
shows zero command runs after a new request and one after a fresh bound approval.

Ruling: old HandoffReceipt payloads remain in the source snapshot and are reported
as skipped, rather than inserted into the active receipt index. This preserves
history without making legacy delivery/approval authority replayable.

## Verification

- Import integration checks: 15 passed, including later room imports, personal
  preservation, stale counters, invalid IDs, partial write failure and skipped receipts.
- Personal worker checks: imported context attribution and retained-folder scope
  each passed; the automatic read needs a fresh approval to execute.
- JavaScript suite: 2,092 passed. TypeScript and `git diff --check` passed.
- Full Rust suite: 1,303 passed, zero failed, eight existing checks ignored.
  The feature-off production boundary crate passed three checks separately.
  The first attempt
  failed all seven daemon attach tests at fixture setup because Deck's inherited
  TMPDIR exceeded macOS `sun_path`. Use `TMPDIR=/tmp cargo test -- --test-threads=2`
  for short, isolated socket paths. Do not change the production socket code.
- Independent scoped source review resolved all four reported personal-import
  findings and the skipped-personal-record accounting follow-up, and accepted
  the folder/receipt rulings. G3's broader security review
  and installed native acceptance are still required.

Test logs from this run: `/tmp/apex-workspace-completion-cargo-test-final.log`,
`/tmp/apex-workspace-completion-production-check-final.log`, and
`/tmp/apex-workspace-completion-npm-test.log`. These temporary logs may expire;
the commands and exact results above are the durable record.

## Next owners and interfaces

- Deepgeek: complete G2b's refresh wiring, legacy markers, read-only conversation
  viewer and old working folder before task retry. Return a scoped commit with
  tests and mention @null. Use a separate branch/worktree from the integrated
  commits; Null owns this checkout while verification runs.
- Null: shared contracts, integration, scoped review and final checks. G4, G3 and
  G2b's initial preview/confirm screen are on the integration branch. Finish G2b
  review and the broader security review, then prepare the concrete install
  checkpoint. Tasks 4–8 remain gated as stated in the approved plan.

No installation, production data import, release build, main merge or push was
performed by this continuation. Do not replace the parked/installed app as a
shortcut around the gate. Check current Git status before every integration;
other work continues in the main checkout.
