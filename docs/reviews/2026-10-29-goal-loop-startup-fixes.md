# Goal/loop startup repair for review

Branch: `feat/goal-loop`. Candidate version: `0.9.5`. Nothing installed, pushed,
tagged, published, or merged into `main` during this repair.

## Changes

- `3a285b3`: admit the exact `room-runners-v1.json` ledger in the provenance
  helper. The existing pinned-daemon, user/scope, revision and journal rules
  continue to apply. Regression coverage exercises protected read/write,
  rejection of untrusted callers and stale revisions, signed checkpoint/reload,
  isolation by user/folder, and rejection of near-match ledger names.
- Runner recovery errors now log a diagnostic and disable goals/loops until
  host restart. Saved data is retained; it is never replaced with an empty
  writable store. Ordinary chat still accepts messages. Runner read/mutation
  APIs return an unavailable error, and unrecovered work cannot dispatch even
  if the storage subsequently becomes readable. A fresh startup reopens it.
  Cleanup of owned runner check processes still runs and retains its existing
  failure behavior.
- `94bbb6d`: merge all of local `main` through `c45ed76` into this branch.
  Fetch confirmed `origin/main` is behind that local main. Conflict resolution
  preserves both runner context and client-message correlation, all chat and
  runner commands/capabilities, and the shared chat composer. The newer client
  delivery path now yields automation on a new human message; retries cannot
  interrupt replacement work. Chat runner mutations obey move/reconnect fences.
- `548f710`: set the npm and Rust workspace versions, root lockfiles and phone
  bridge lockfile to `0.9.5`. Local main still said `0.9.3`; merging alone would
  not have prevented a downgrade from the installed `0.9.4`.
- During final read-back, main advanced to `10f47ca` (the `0.9.4` release
  metadata and iPhone build 25). That metadata-only commit was also merged;
  candidate manifests/lockfiles retain `0.9.5` and the iPhone now retains build
  25. No application logic changed after the passing suites. TypeScript was
  checked again after this merge.

## Real-helper startup acceptance

Run after a reviewed candidate has been installed and pinned normally:

```sh
bash scripts/acceptance-provenance.sh --runner-startup-only
```

This starts the real protected installed daemon twice on a fresh temporary data
directory and asks for `room_runner_state` through its socket after each start.
It requires the real helper ownership and signed protected-document reads;
there is no fixture or protected-ledger bypass. Both starts must return an empty
runner successfully, and neither may log unavailable protected storage or runner
recovery failure. The check also runs as part of the full provenance acceptance
harness. It never stops the person's running app/daemon or changes installed
binaries. The helper may retain host-lock bookkeeping for the temporary scope.

The check was executed against the current stable installation and correctly
failed: `unknown variant room_runner_state`. Evidence:
`/tmp/goal-loop-real-helper-startup-before-upgrade.json`. This proves the check
does not silently accept an older host. **It is not a passing installed test of
this branch.** That remains pending until review and a candidate installation.

## Verification

Both new Rust regressions failed before their respective fixes: the helper
returned `Not a protected ledger name`, and host construction failed on the
unreadable runner document. Both passed after repair. The merge regression also
failed before wiring client delivery to yield, then passed; retry keeps the new
attempt's generation and reservation intact.

- `npx tsc --noEmit`: passed before the merge and again on the combined branch.
- `npm test`: 2,781 passed, 3 skipped, zero failures after merge and version bump.
- `cargo test -p apex-host-production-check --locked`, run separately: 6 passed,
  with the guard confirming `test-support` was not compiled.
- Root and mobile `cargo metadata --no-deps --locked`: passed; every workspace
  package reports `0.9.5`.
- `TMPDIR=/tmp cargo test --locked` on `0.9.5`: 1,695 passed, 14 ignored,
  zero failures across 39 result groups, including both new Rust startup
  regressions and the client-delivery merge regression.
- `cargo build -p apex-daemon --features test-support --bin apex-daemon-fixture
  --locked`: passed for `0.9.5`.
- `TMPDIR=/tmp node --experimental-strip-types --test
  tests/e2e/runner.e2e.mjs`: all 4 scenarios passed. Includes an actual one-minute
  loop firing twice without overlap, completion, blocked/stuck/limits, Stop,
  stale End, human interruption without Resume, configuration changes and
  owned-check cleanup after a crash.

The first full Rust invocation used Deck's long `TMPDIR` and failed the seven
`apex-daemon --test attach` cases at socket-path construction:
`a_crashed_daemons_socket_is_replaced_on_the_next_start`,
`a_data_folder_too_deep_for_a_socket_is_named`,
`an_ssh_session_that_drops_mid_reply_does_not_stop_the_agent`,
`attach_without_a_daemon_fails_and_says_how_to_start_one`,
`serve_owns_the_folder_and_listens_on_a_private_socket`,
`stdio_attaches_to_the_running_daemon_and_shares_its_rooms`, and
`stdio_will_not_share_a_folder_the_desktop_app_owns`.
The passing final run uses `TMPDIR=/tmp` to stay within macOS `sun_path` limits.

Detailed logs, the initial socket-path failure, and the real installed-helper
negative result are retained under the ignored evidence directory
`.superpowers/sdd/2026-10-29-goal-loop-startup/`.

No production build or native UI sign-off was attempted for this repair. Jigga's
review and the passing real-helper check on an installed candidate remain
distinct from fixture and source-test results.
