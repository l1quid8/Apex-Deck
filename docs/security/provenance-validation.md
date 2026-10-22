# Provenance candidate validation

**Verdict: gated candidate, not verified for activation. Phase 4 is blocked.**

## Passing software checks

- `npm test`: 2,049 passed, zero failed.
- `TMPDIR=/tmp MACOSX_DEPLOYMENT_TARGET=13.0 cargo test --workspace --lib --features apex-daemon/remote`:
  1,093 passed, five existing ignored tests, zero failures. A short temporary
  path is needed for the existing macOS Unix-socket pairing fixtures.
- `MACOSX_DEPLOYMENT_TARGET=13.0 cargo test -p apex-provenance`:
  ten library tests and one native audit-token rejection test passed.
- `MACOSX_DEPLOYMENT_TARGET=13.0 cargo test -p apex-host --test provenance_production_storage --features test-support`:
  one production-construction rejection test passed, including with test support
  compiled but no isolated fixture registered.
- `npx tsc --noEmit`, Vite production bundle, installer shell syntax, JS syntax
  and `git diff --check`: passed.

The independent security review found and prompted fixes for: personal JSON
forgery; mutable standing rules; room continuation/approval routes; writable
remembered permissions, participants, cwd and fallback mounts; pre-JavaScript
Electron injection; journal/framing limits; and dependency-test fixture scope.
It accepts retaining this as a gated candidate, not production acceptance.
The review independently reran the provenance, production-construction,
desktop-wrapper and installer-syntax checks.

## Full suite is NOT green

`cargo test --workspace` fails four existing real-process CLI integration tests
in `crates/apex-daemon/tests/attach.rs`:

- `serve_owns_the_folder_and_listens_on_a_private_socket`
- `stdio_attaches_to_the_running_daemon_and_shares_its_rooms`
- `a_crashed_daemons_socket_is_replaced_on_the_next_start`
- `an_ssh_session_that_drops_mid_reply_does_not_stop_the_agent`

The standalone unsigned test daemon exits with
`Protected provenance service unavailable` before becoming ready. These tests
cannot bootstrap the new trusted host from a user-owned data directory and
must be exercised/adapted with the installed trusted-path acceptance harness.
They were not deleted, ignored, changed to expect success, or hidden behind a
production bypass. Their failure prevents declaring this phase verified.

Unit tests that assume an already-trusted UI use explicit isolated fixtures.
Those passes do not establish a successful real signed UI/daemon session.
The negative production-storage test establishes fail-closed behavior, not a
positive installed flow. Serialized journal round-trips are not crash/reboot
acceptance. Native peer rejection is not a complete hostile-client exercise
against a running root broker.

## Blocked native checks

No root broker or protected UI copy has been installed. The root installation
path does not exist. `sudo -n true` returned `sudo: a password is required`.
Actual installation requires administrator authentication outside this session.
No installed application, LaunchAgent or normal user data was replaced.

The activation gates in [the design](provenance-boundary.md) still apply:
trusted-path success, raw CLI/socket hostile requests, direct-file tampering and
restart, concurrent CAS, uncertain execution recovery, artifact permissions and
fuses, Full access smoke, and explicit legacy migration. Normal old JSON is
preserved but never automatically certified. Do not point the candidate at the
normal data directory before migration is ready.

## Review build

Built and signed source commit `04da0fcd519049a9b58dd114f2eb2a897353b465`:

`/Users/tylercaldwell/Downloads/apex-deck/release/provenance-boundary-review-0.8.2/mac-arm64/Apex Deck.app`

Offline checks passed: strict deep code-signature verification of the app and
both bundled services; hardened runtime; only JIT and audio-input entitlements;
RunAsNode, Node options and CLI inspector disabled; ASAR integrity and
OnlyLoadAppFromAsar enabled. The actual archive header SHA256 matches the
signed Info.plist. [Artifact audit and hashes](provenance-artifact-audit.json)
records the exact artifact. It is signed but not notarized, installed or
launched. This user-owned candidate must be copied into the protected location
by the installer before the broker will accept it. A packaged artifact alone
cannot pass the native installation gate.
