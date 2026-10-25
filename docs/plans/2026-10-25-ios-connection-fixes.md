# iPhone connection fixes

Authorized scope: the four findings in the iPhone connection review.

1. Read existing rooms before creating one. Restore unopened saved rooms only
   from the host's protected manifest; reject missing rooms without synthesizing
   authority. Retain old-helper fallback and propagate denied/lost reads.
2. Bound outgoing UTF-8 JSON by both the native link limit and the host's
   advertised frame limit. Reject before native send and retain the draft/link.
3. Replace assumed sleep with offline/reconnecting wording in every phone view.
4. Protect `devices.json` in broker storage; retain legacy bytes without trusting
   them. Device additions, tier/scope changes and pairing confirmation require an
   installed-UI receipt. Revocation may remain available locally because it only
   removes authority. The broker admits authenticated phone commands using the
   protected grant, exact serialized intent, unique connection identity and
   numeric request ID. It checks current tier/scope and consumes the submission
   atomically. Assistant-owned room intents require global Full authority, just
   as the personal assistant surface does; ordinary socket coding access cannot
   issue phone submissions. Paired clients cannot submit desktop receipts.

Regression coverage: permitted scoped reads, unopened saved-room restoration,
permission/network failures, exact/oversized UTF-8 frames, 6 MiB upload followed by
successful request, offline wording, forged device JSON, untrusted admission,
replay, changed commands, revocation, tier/scope narrowing, ordinary room and
assistant admission. Use the real broker Journal in positive admission tests;
fixture daemon tests cover dispatch but do not establish OS identity acceptance.

Validation: `npx tsc --noEmit`, full Node suite, apex-provenance tests, apex-host
and apex-daemon suites (remote enabled), and apex-host-production-check separately.
No builds, installs, merges or protected-data migrations are part of this task.
Existing phones require explicit UI reapproval when adopting protected grants.
