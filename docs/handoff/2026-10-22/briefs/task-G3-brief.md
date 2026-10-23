# Task G3: Provenance acceptance harness (installed, non-root) + automated adversarial tests

## Why

`docs/security/provenance-boundary.md` → "Test seams and remaining acceptance" lists what
must pass before Phase 4 (copied verbatim; this is the checklist):

- Verify signed UI and daemon success through the root broker in isolated data.
- Attempt the same intent from shell, raw socket, stdio attach and an alternative
  daemon; observe denied issuance and no protected state change.
- Tamper user JSON, restart, and confirm protected originals/approval states win.
- Crash between claim/dispatch/outcome, then verify uncertain status and no
  repeated effects; test concurrent compare-and-swap and rejected approvals.
- Inspect installed signatures, all fuse slices, keys, ACLs, nested resources and
  symlink containment; reject developer/ad-hoc or modified/copied mutable code.
- Verify Full access edits, builds, Git, network and subprocesses in that signed
  installation. Verify ordinary remote coding compatibility separately.
- Finish reviewed legacy migration and rerun native CLI integration acceptance.

Facts discovered on the real install today (2026-10-22), which the harness must encode:
- The broker (`crates/apex-provenance/native/peer.m`) trusts a peer only if every path
  component of its executable is root-owned and not group/world-writable. So the daemon
  shipped inside `/Applications/Apex Deck.app` (user-owned; `/Applications` is
  group-writable) is ALWAYS untrusted; only the copy under
  `/Library/Application Support/Apex Deck Provenance/TrustedUI/Apex Deck.app` is trusted.
- The per-user LaunchAgent `~/Library/LaunchAgents/dev.apexdeck.daemon.plist`
  (written by `desktop/launchAgent.mjs` from the *running* app's resourcesPath) silently
  flips to the untrusted `/Applications` daemon whenever the `/Applications` app is
  launched.

## Deliverables

1. `scripts/acceptance-provenance.sh` — runs as the normal user (no sudo), read-only with
   respect to the user's real data dir and the installed apps; every write goes to a fresh
   `mktemp -d` isolated data dir that it deletes at the end. It must not stop or replace the
   user's running app/daemon/LaunchAgent. Emits a human table and a JSON evidence file
   (path printed) with PASS/FAIL/SKIP + reason per check. Checks:
   - Static: codesign `--verify --deep --strict` of the TrustedUI app and its daemon/broker;
     CDHashes of TrustedUI UI/daemon vs the broker's pinned values *when readable* (config
     is root-only → SKIP with reason, never sudo); hardened runtime flag; no
     get-task-allow / disable-library-validation / dyld env / unsigned-exec-memory
     entitlements; Electron fuse wire values in every architecture slice (reuse the parsing
     approach from `scripts/install-provenance.sh`); ownership/mode of every path
     component; no bundle symlink escaping the tree; broker LaunchDaemon loaded and socket
     present.
   - Negative (must be refused, and the isolated data dir's protected state unchanged):
     raw socket `issue` from a shell process (e.g. python/perl/nc writing a frame);
     `read`/`write` from the untrusted `/Applications` daemon binary run with
     `serve --data-dir <tmp>` (expect "Protected ledgers require the pinned daemon"
     logged and startup continuing — depends on G1); `apex-daemon --stdio --attach` to the
     isolated trusted daemon attempting a protected command without attestation;
     a copied TrustedUI daemon into the tmp dir (user-owned copy) → refused.
   - Positive: the TrustedUI daemon `serve --data-dir <tmp>` reads/writes its protected
     ledgers through the broker (no "unavailable" line; a protected write round-trips).
   - Tamper: write a forged plain `assistant-tasks-v1.json` into the isolated data dir,
     restart the trusted daemon, confirm the protected (empty/original) state wins.
   - LaunchAgent: report which binary the user's LaunchAgent points at, FAIL if it is
     not the TrustedUI daemon (report only; do not modify).
   - Full-access/remote/UI-issued positive flows that need the trusted UI window: SKIP
     with "covered by the final smoke test" — do not fake them.
2. Automated tests (cargo/node, no installed app) for whatever in the checklist is
   testable at source level and not already covered: crash between claim/dispatch/outcome
   → uncertain status and no repeat; concurrent CAS rejection; stale typed approval is
   rejected and recorded. First grep existing tests (`crates/apex-provenance`,
   `crates/apex-host/tests`, `crates/apex-daemon/tests`) and add only missing cases;
   list in the report which checklist items are covered by which existing test names.
3. Run the script once against the currently installed build and include its JSON
   evidence path and summary in the report. Failures caused by real defects are findings
   to report, not to paper over; fix only defects inside the script itself.

## Constraints

- Never use sudo, never write outside the tmp dir and the repo, never touch the running
  app, the LaunchAgent, `/Applications`, or `~/Library/Application Support/dev.apexdeck.app`.
- Do not modify broker trust logic. Commit the script, tests and a short section appended
  to `docs/security/provenance-boundary.md` mapping each checklist item → evidence/test/SKIP.
