# Provenance journal compaction

This is a source/tested follow-up on `docs/assistant-workspace-plan`, not native
activation acceptance. Phase 4 and Full access execution rules are unchanged.

## Behavior

The broker compacts its candidate journal before mutating operations once the
live entry count reaches 75,000, and retries compaction if the serialized
candidate exceeds 128 MiB. It uses the existing atomic write and fsync path;
it acknowledges only after persistence. Failed operations discard the candidate.
Read operations do not compute or discard a new checkpoint.

`CheckpointPayload` contains domain/kind, generation, a consumed-key/claim-time
map, and cumulative folded/resolved/orphaned/expired counters. It is signed with
the established Ed25519 authority key using `Signed`. `Journal::open` verifies
the signature and structure before constructing the cached claim map. Journal
has no public Deserialize implementation, preventing accidental unverified
loads. `validate(public_key)` rejects malformed keys/counters and overlap
between checkpoint claims and live entries.

- Resolved claims fold immediately; their original payloads/outcomes are removed.
- Unresolved claims fold after seven days, retaining consumed keys. Later finish
  attempts explicitly report archival, not successful outcome recording. This is
  a retention policy, not proof an old operation has finished.
- Fresh unresolved claims remain finishable. Legacy zero/unknown timestamps never
  expire unresolved entries automatically.
- Unclaimed entries expire after one day. Claim checks expiry independently of
  the compaction threshold. Compaction may remove these never-consumed entries.
- Renewing a never-consumed expired submission requires a trusted UI issuance.
  New receipts have an optional random `issuanceId` so old receipts cannot be
  revived by renewal. Exact live retries reuse the original token; legacy
  receipts without this field remain readable.
- Both issue and claim refuse checkpoint-consumed keys. Repeated compaction and
  restart cannot re-mint authority for a consumed submission. Finish explicitly
  reports archival for folded keys. Finish remains idempotent for live entries.

Journal version remains 1, compatible with the requested existing version
checks. Do **not** downgrade to the pre-compaction broker: that binary ignores
checkpoint fields and cannot enforce archived claim state. Root-owned build
pins and controlled installation remain part of this requirement. Update broker
and daemon together: older receipt parsers reject the new `issuanceId` field.

## Requested eight tests

All pass with `cargo test -p apex-provenance` (23 library tests and one native
audit-token rejection test, zero failures):

1. `compaction_preserves_claim_set_and_rejects_replay`
2. `compaction_never_reissues_a_consumed_submission`
3. `compaction_leaves_live_unclaimed_receipts_claimable`
4. `compaction_does_not_fold_recent_unresolved_claims`
5. `archived_submission_finish_is_reported_not_silently_dropped`
6. `checkpoint_signature_is_verified_on_load`
7. `expired_unclaimed_receipt_fails_closed_and_can_be_reissued`
8. `compact_if_due_is_testable_with_a_low_threshold`

`TMPDIR=/tmp MACOSX_DEPLOYMENT_TARGET=13.0 cargo test --workspace --lib --features apex-daemon/remote`
passes: 1,106 tests, five existing ignores, zero failures.

`npx tsc --noEmit`, `git diff --check`, and all four desktop provenance wrapper
tests also pass. The wrapper tests include unchanged ordinary Full access
transport.

Five additional regressions cover legacy JSON, signed malformed checkpoints/live
entry overlap, recovery at the real 100,000-entry limit, below-threshold expiry
and renewal token rejection, and failed compaction preserving the original
journal. The expiry test was observed failing before implementing the fix.

## Limits and remaining activation work

This reclaims live-entry slots and payload bytes; it is not infinite retention.
Checkpoint claims remain capped at 200,000 and signed payloads at 16 MiB. The
fully serialized journal remains bounded at 128 MiB, including protected
ledgers. Capacity failures preserve claims and reject the transaction. A journal
filled entirely with noneligible live entries cannot be reclaimed yet. Growing
beyond the checkpoint cap needs a separate storage/retention design, not silent
claim eviction. Whole-file root rollback protection needs an external monotonic
anchor and remains outside the same-UID worker threat boundary.

The preexisting atomic writer can rename successfully and then fail directory
fsync, leaving disk and running memory inconsistent. This patch does not claim
to resolve that native activation/recovery concern. Native installation,
positive trusted-client acceptance, crash/reboot testing, project-memory ledger
protection and legacy migration remain outstanding.

The full workspace test command remains red in the four documented real-process
CLI tests because the protected service is absent; see
[the validation report](provenance-validation.md#full-suite-is-not-green). No
production fallback, ignored test, or access restriction was added to hide this.
