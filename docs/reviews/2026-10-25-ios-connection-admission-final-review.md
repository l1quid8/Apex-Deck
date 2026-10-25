# Final iOS admission diff review

Branch: `fix/ios-connection-admission`. Working changes; unmerged and undeployed.

The original iOS changes were recovered from stash `0cd4b020` into
`/Users/tylercaldwell/Downloads/apex-deck-worktrees/fix-ios-connection-admission`.
The stash was retained. Unrelated work in the shared checkout was left intact.

The original review missed a Linux availability regression. See
[the platform follow-up](2026-10-25-ios-platform-followup.md) for the correction,
additional tests and current verification limits.

## Findings corrected

1. **P2: protected management receipts blocked their connection's request loop.**
   `run_management_receipt` awaited broker consumption, grant execution, and
   outcome recording directly inside `serve`. Pending broker work prevented
   later requests on that connection from being read. Receipt execution now
   runs through the existing task/reply channel, and synchronous grant writes
   use the blocking executor. The local-only gate remains before task dispatch.
   A regression holds the blocking executor, submits a receipt, and verifies
   that a later session read succeeds before admission completes; the forged
   receipt is still refused. It failed with a timeout before the fix.

2. **P2: the protected pairing route discarded structured refusal reasons.**
   Mapping pairing errors to strings lost `expired`, `phone_left`, `changed`,
   and other reason codes used by the pairing sheet. The verified command
   executor now returns the original structured refusal, and the receipt route
   returns its normal wire frame after recording the outcome. Tests exercise
   malformed, unknown, expired, and cancelled invitations through this executor.
   The regression failed before reason preservation was restored. A failed
   outcome acknowledgement also explicitly reports an uncertain grant result
   and tells the caller not to retry automatically.

## Security review

No additional concrete grant-escalation bypass was identified in the reviewed
diff. Checks traced authenticated iroh peer identity into host dispatch, the
pinned-daemon broker gate, protected registry reads, current revocation and
tier/scope checks, exact signed response bindings, consume-before-dispatch,
replay barriers across restart, and local-only management receipt routing.
Raw socket grant changes remain denied; editable legacy registry bytes do not
authorize devices. Paired devices cannot execute desktop receipts or acquire
pairing, grant-management, or legacy-import authority.

Additional broker coverage verifies that assistant-room posts and approvals
reject both global Chat grants and thread-scoped Full grants. Denial does not
consume the intent; explicit global Full approval can subsequently admit it.
Forbidden-command coverage now includes every grant-changing verb and legacy
import, alongside desktop receipt execution.

## Verification

All checks exited successfully in the isolated worktree:

- `npx tsc --noEmit`.
- `npm test`: **2,533 passed, 3 skipped**, no failures.
- `TMPDIR=/tmp cargo test --features apex-daemon/remote`: **1,588 passed,
  13 ignored**, no failures across the default workspace targets, including
  host, daemon, provenance, adapters, core, and pairing tests.
- `TMPDIR=/tmp cargo test -p apex-host-production-check`, run in a separate
  invocation without fixture feature unification: **5 passed**, no failures.
- `git diff --check`.

Rust commands reused the existing cache via
`CARGO_TARGET_DIR=/Users/tylercaldwell/Downloads/apex-deck/target`.
Logs: `/tmp/apex-ios-review-{tsc,node,rust,production}.log`.
Failing-before and focused passing-after logs:
`/tmp/apex-ios-review-{red,reason-red,green}.log`.

Installed signed-UI issuance and a physical iPhone through the pinned daemon
and broker remain unvalidated. These code and fixture checks do not establish
that deployed workflow. No builds, installation, pairing migration, merge, or
protected-data modification was performed.
