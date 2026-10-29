# VPS automatic release updater: deployment and verification

The VPS updater is installed for `l1quid8`. It builds exact newer stable
published release tags, carries the existing Linux Allow workaround, tests
Allow/new threads and maintenance, waits for an idle reservation, retains a
rollback executable and journals installation/recovery. It checks every 30
minutes with up to two minutes of jitter; build time is additional.

## Running deployment

- Daemon: `apex-daemon-managed@l1quid8.service`, enabled at boot.
- Data: `/home/l1quid8/.local/share/dev.apexdeck.app` (existing data).
- Running version: `0.9.4 (10f47ca9e504-dirty)` from published source
  `10f47ca9e5044cba0f4e2e33ec8dc26cdb8a382d` plus carried Allow and maintenance.
- Executable SHA-256:
  `bfdf1fc82b878d5a556844287f00a19df7da11f4b7b656721483b49e543bf244`.
- Timer: `apex-deck-update@l1quid8.timer`; updater service:
  `apex-deck-update@l1quid8.service`.
- Configuration: `/etc/apex-deck-update/l1quid8.json`, including
  `"unit":"apex-daemon-managed@l1quid8.service"`.
- State/status/evidence: `/var/lib/apex-deck-update/l1quid8/`.
- Retained pre-install Allow hotfix:
  `/var/lib/apex-deck-update/l1quid8/backups/20261029T193315Z-02f3a24f8659`,
  SHA-256 `648bd942e6f0da75db1c90e841c6fa57eb7c8042d1f043959ed1182d18a377cc`.
  Existing manual `/usr/local/bin/apex-daemon.bak-*` files were preserved.

The interrupted one-time bootstrap left the original service with no process,
but systemd's state remained frozen/auto-restart-queued. It rejected both stop
and thaw. Recovery copied the exact service template and instance settings to
the managed unit and retained the existing user, data and remote endpoint.
The old instance `apex-daemon@l1quid8.service` is disabled and masked. Use the
managed unit for daemon status/restarts; do not unmask/start the old instance
against the same data directory while the managed service is running.

The one-time bootstrap's observed idle evidence and completed transaction are
retained as `bootstrap-idle.json`, `bootstrap-evidence.json` and
`bootstrap-completed.json` on the VPS. Subsequent updates use the maintenance
gate and do not use cgroup freezing.

## Verification

- 37 focused Python updater/compatibility tests passed. Regression coverage
  includes version floors, busy deferral, failed compatibility, rollback,
  interrupted recovery, expired/unheld leases, slow probes, leftover recovery
  processes, mismatched identity and configured service selection.
- Nine focused Linux Rust checks passed on the VPS: one actual public-command
  new-thread/Allow/Allow-always test with retained phone/assistant refusals,
  four host maintenance tests and four daemon maintenance/authorization tests.
  Full output: `verified-focused-{1,2,3}.log` under the VPS state directory.
- `npx tsc --noEmit` passed. The full Rust suite was not rerun, as requested.
- An isolated candidate smoke test passed maintenance sealing, cancel and
  new-thread creation before installation.
- The deployed daemon passed live maintenance sealing/cancel. An expired
  monotonic reservation refused to stop it, and the daemon boot remained the
  same throughout those checks.
- Fresh live RPC identity, systemd PID, daemon data record and running executable
  hash matched. Session and chat-list reads passed. The updater service returned
  `current` for `v0.9.4` without restarting the daemon.
- Installed script/unit hashes, enabled/active timer, scheduled next run,
  retained rollback hash and absence of a pending transaction were read back.
  Exact observations are in
  [the machine-readable evidence](2026-10-29-vps-auto-update-evidence.json).

## Independent review

The read-only reviewer found two Important issues before timer enablement:
identity/process probes could consume a maintenance lease before stopping, and
inactive recovery did not inspect leftover service processes. Both were
reproduced with failing tests and fixed. Stop now requires the current held
lease and checks wall-clock and monotonic time before and after probes; stopped
recovery verifies an empty cgroup and rechecks before stopping. Identity
mismatches refuse recovery. The reviewer independently passed all 37 Python
tests after the fix pass and found no remaining Important issues in those fixes.

The reviewer did not judge live deployment/timer/bootstrap evidence because its
review was restricted to local source. The operator readbacks above supply that
evidence. The existing same-account Linux Allow trust gap is deliberately
preserved; this updater does not claim to resolve desktop authorization.
An unknown future routing shape, failed focused check or incompatible carried
maintenance patch skips installation and retains the working daemon.
