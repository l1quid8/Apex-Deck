# Gate `8f67474` — pre-flight record for the administrator checkpoint

Measured by @deepgeek on 2026-10-23 from `fix/assistant-workspace-integration` at
`b31bde9`, clean tree. This records only what can be read **without root**. It is
not installed evidence: no phase that requires `sudo` has been run, and none of
the numbers below describe a completed upgrade.

**Blocker, stated first.** This machine has no passwordless `sudo`
(`sudo -n true` → `sudo: a password is required`), and tooling here runs without a
terminal. Phases C through H of `UPGRADE-PROCEDURE.md` therefore cannot be
executed by an agent. The checkpoint requires a human at the keyboard. Everything
an unprivileged process *can* verify was verified and is recorded here.

## Phase A — artifact verification: PASS

| Check | Expected | Measured | Result |
| --- | --- | --- | --- |
| DMG SHA256 | `3a47ae30…f0bf58` | `3a47ae30977e0c97e816056995f849945c6e6af70611de1cdb75a1d584f0bf58` | match |
| UI CDHash | `b2ad5d46…` | `b2ad5d46b0e2142f72b6dd1f734968d0ca25f9a6` | match |
| daemon CDHash | `538dbd09…` | `538dbd0910120859858a1e613e659daaa31d4bcc` | match |
| broker CDHash | `12b8eb9a…` | `12b8eb9af7ae0cd92fbd1d4ee384296718c20a9a` | match |

`scripts/verify-protected-bundle.sh` returned exit 0 with four `OK` lines
including the exact broker match. The image was mounted `-readonly -nobrowse` at
`/tmp/gate-8f67474-preflight` and detached afterwards, and no stale mount of it
remains.

Two *other* Apex Deck images were already mounted before this run and were left
alone because they are not mine: `/dev/disk4s1` on
`/Volumes/Apex Deck 0.8.2-arm64` and `/dev/disk17s1` on
`/private/tmp/apex-null-release-082`. Neither is the gate image. The procedure
mounts by explicit `--mountpoint`, so an older image on `/Volumes` cannot be
mistaken for the candidate — but an operator should know they are there before
interpreting a mount listing.

The Phase G invocation form — the same script with only the two CDHashes and no
broker argument — was also exercised against the mounted candidate and returned
exit 0, so the command the operator will run in Phase G is known-good syntax
rather than assumed.

## Installed state before the upgrade — matches the procedure

| Item | Measured |
| --- | --- |
| LaunchAgent `ProgramArguments[0]` | `/Applications/Apex Deck.app/Contents/Resources/bin/apex-daemon` |
| `/Applications` UI / daemon | `714bea0f…` / `f6013a4a…` |
| protected `TrustedUI` UI / daemon | `7911a74d…` / `9a7405e0…` |
| `host-locks/` | absent — the new build creates it |
| broker service | `state = running`, pid 26868 |
| broker socket | `/var/run/dev.apexdeck.provenance.sock`, `root:daemon`, mode `666` |
| authority directory | root:wheel, `755`; `config.json`, `journal.json`, `private-key` are `600` root:wheel |
| `journal.json` | 50860 bytes, mtime 2026-10-22 18:17 — the record set the upgrade must preserve |

Every row agrees with the table in `UPGRADE-PROCEDURE.md`, so the hazards H1–H4
documented there are current, not historical.

## Installed acceptance baseline — independently reproduced

Run from `b31bde9`, clean tree, harness hash `108d34cd…`:

```
PASS 23  FAIL 2  SKIP 8  (of 33 checks)
evidence: target/acceptance-provenance/preflight-baseline
```

This reproduces @null's baseline exactly. The two failures are the two the
upgrade is meant to clear:

- `launchagent.daemon-path` — the agent runs the `/Applications` daemon.
- `static.fuses.installed` — unsafe fuse wire `101100011` (`RunAsNode`,
  `NODE_OPTIONS`, CLI inspect) in the `/Applications` copy. The protected copy
  passes `static.fuses` with `000011011`; this is the coverage gap H2 describes,
  now measured rather than predicted.

All eight skips are named in the run and none were relabelled. Four require the
signed window (`positive.protected-write`, `skip.full-access`, `skip.ui-issued`,
`skip.installed-import`), one needs a paired device, one is `static.cdhash-pins`
(root-only `config.json`), one needs the gate build installed
(`negative.installed-daemon`), and one is the e2e suite.

## Conditions an administrator must satisfy before Phase E

Measured at the time of writing — **both are currently unmet**:

- **A UI is running** (`pgrep -x 'Apex Deck'` returns a pid). Phase B requires
  every copy quit before executable paths change.
- **The per-user agent is loaded** (`launchctl print gui/$(id -u)/dev.apexdeck.daemon`
  succeeds). Phase B requires
  `launchctl bootout "gui/$(id -u)/dev.apexdeck.daemon"` first.

No `apex-daemon` process is running at this moment, so only the UI and the loaded
agent stand between the operator and Phase C.

## Two conditions the procedure does not mention

**1. The user store is 14 GB.** Phase C's `ditto` of
`~/Library/Application Support/dev.apexdeck.app` copies all of it. Space is not a
constraint — 102 GB free on `/System/Volumes/Data`, and Phase D's staged copy plus
the root backup are about 700 MB together — but the copy will take minutes, and
Phase C should not be interrupted with `Ctrl-C` partway. Budget the time rather
than discovering it under a running clock.

**2. Three earlier backup directories already exist**, each 333 MB:
`Apex Deck Provenance.backup-20261022-173203`, `…-181158`, `…-181240`. They do not
collide with this run, because every name the procedure creates is scoped to a
fresh `$STAMP`, and Phase C refuses to reuse an existing destination. They are
evidence of previous install attempts, not obstacles. Leave them in place until
the checkpoint is signed off; deleting a backup before the thing it backs up is
verified is the wrong order.

No `.upgrade-*` staging directory exists under the authority root, and no
`/Applications/Apex Deck.app.previous-*` or `.rolled-back-*` exists, so the Phase D
and Phase G preflight refusals will not fire.

## What is still required — and is not mine to run

1. Phase B as a human: quit both copies, bootout both services, prove with
   `pgrep` that no `apex-daemon` and no `Apex Deck` remains.
2. Phases C–G under `sudo`, following `UPGRADE-PROCEDURE.md` without deviation.
   Phase E and Rollback are the only blocks that can damage authority; both were
   rehearsed against a sandbox, neither has been run against this machine.
3. Phase H: the acceptance harness (expecting `launchagent.daemon-path` and
   `static.fuses.installed` to turn PASS, and `negative.installed-daemon` to
   execute rather than skip), then the interactive checklist.
4. A final `sudo authority-inventory.sh` compared against the Phase C snapshot:
   keys, journal and every pre-existing lock identity `SAME`, pins `CHANGED` to
   the candidate, `RESULT: PASS`.

The single check that says the gate closed is `launchagent.daemon-path`
transitioning to PASS. It cannot be moved by code; only by the installed
candidate writing the agent as the protected copy.
