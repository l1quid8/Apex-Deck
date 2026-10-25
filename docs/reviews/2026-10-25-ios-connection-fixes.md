# iPhone connection fixes and verification

Branch: `fix/ios-connection-admission` (working changes; not merged or deployed).
Scope: all four findings in `2026-10-25-ios-connection-review.md`.

These are the original implementation results. The later
[platform follow-up](2026-10-25-ios-platform-followup.md) corrects a Linux
availability regression and records current verification limits.

## Changes

- Authenticated iroh phone intents now have a broker-backed admission path.
  The broker checks protected device grants, current tier/thread scope and
  revocation, binds the exact intent to device/session/request identity, and
  consumes it durably before host dispatch. Assistant-owned room intents require
  global Full authority. Desktop receipts remain forbidden to paired devices.
- Production device grants use protected broker storage. Additions, scope/tier
  changes and pairing approval require installed-UI receipts. Local revocation
  remains available. Legacy `devices.json` is retained without trusting it.
- Room loading reads first, propagates permission/provenance/network failures,
  and creates only for a missing room or an unsupported legacy helper. The host
  can restore an unopened saved room using its saved protected authority; a read
  cannot create an unknown room.
- Outgoing requests are bounded by both the native iroh limit and the negotiated
  host limit using the full serialized UTF-8 frame. Oversized attachments reject
  before native send, without dropping the link or clearing the draft.
- Thread banners and machine headings report unreachable/offline/reconnecting
  states without presenting disconnection as confirmed Mac sleep.

## Verification

All commands exited successfully:

- `npx tsc --noEmit`.
- `npm test`: **2,533 passed, 3 skipped**, 0 failed.
- `TMPDIR=/tmp cargo test -p apex-host -p apex-daemon --features apex-daemon/remote`:
  **962 passed, 6 ignored**, 0 failed across unit/integration targets.
- `cargo test -p apex-provenance`: **60 passed**, 0 failed.
- `TMPDIR=/tmp cargo test -p apex-host-production-check`, run separately to
  avoid test-support feature unification: **5 passed**, 0 failed.
- `git diff --check`.

Regression tests cover existing reads at all phone tiers, denied/lost reads,
saved-room restoration, exact and oversized UTF-8 frames, multibyte filenames,
6 MiB uploads, protected grant forgery/restart, raw socket grant escalation,
forged management receipts, signed claim bindings, replay across checkpoint and
restart, current revocation and tier/scope narrowing, and assistant authority.
A real PhoneApp Chromium test selects an oversized file, attempts Send, observes
retained text and attachment, then sends a smaller file on the same connection.

The initial full Node run exposed an obsolete test expectation that an existing
readable room must call `roomCreate`; its expectation now verifies read-first
behavior and retains the pop-out lifecycle/approval checks. Initial Rust runs
also exposed exact welcome expectations needing the new negotiated frame field.
The remote CLI socket fixtures require the short `TMPDIR=/tmp` path on macOS;
the environment's default temporary path exceeds the Unix socket path limit.
The complete reruns above pass.

Logs: `/tmp/apex-ios-{tsc,node,rust,provenance,production}.log`.

## Acceptance and rollout limits

The follow-up [final diff review](2026-10-25-ios-connection-admission-final-review.md)
found and corrected two management-receipt regressions. Tests exercise
broker Journal admission and signed response verification, actual phone UI send
behavior, fixture dispatch, and feature-off production rejection separately.
Successful installed-UI grant execution and authenticated iPhone -> pinned
installed daemon -> broker -> host execution have **not** been validated.
No application bundle, broker installation, protected data, or pairing record
was modified by this task.

Adoption requires matching updated Mac/broker and iPhone builds. Existing legacy
phone entries require explicit approval in the installed Mac UI; no automatic
migration grants them protected authority. Physical-iPhone validation remains
necessary after that rollout. This patch does not implement chunked uploads;
files exceeding the connection frame limit receive a visible rejection.
