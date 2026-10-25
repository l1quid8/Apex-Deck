# Gate `8f67474` — pre-flight record for the administrator checkpoint

Measured by @deepgeek on 2026-10-23 from `fix/assistant-workspace-integration` at
`b5e2d399`, clean tree. That is the tree the harness stamped, and it is an
ancestor of the reviewed `29f8b30`; an earlier draft of this record said
`b31bde9`, which was the head when the run started, not when it finished. This records only what can be read **without root**. It is
not installed evidence: no phase that requires `sudo` has been run, and none of
the numbers below describe a completed upgrade.

**Blocker, stated first.** This machine has no passwordless `sudo`
(`sudo -n true` → `sudo: a password is required`). The administrator commands in
Phases C–G of [UPGRADE-PROCEDURE.md](UPGRADE-PROCEDURE.md) require human
authentication. Phase H's shell harness runs as the ordinary user; its signed UI
and paired-device checks still need interactive evidence. The artifact and
unprivileged baseline measurements below do not establish installed acceptance.

Reviewed by @null after handback from @deepgeek. The unchanged-journal comparison
belongs in Phase F before launching the candidate, and the LaunchAgent path is
one required check among the full Phase H list. Neither alone closes the gate.

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

Run from `b5e2d399`, clean tree, harness hash `108d34cd…`:

```
PASS 23  FAIL 2  SKIP 8  (of 33 checks)
evidence: target/acceptance-provenance/evidence-20261023T063522Z.json
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

## What the after-run must look like

Reviewing the post-install evidence is a status diff against this measured
baseline, not a judgement about whether the number looks healthy. Three checks
must move and no others may:

| check | now | after the checkpoint |
| --- | --- | --- |
| `launchagent.daemon-path` | FAIL | **PASS** — the agent names the protected daemon |
| `static.fuses.installed` | FAIL | **PASS** — `/Applications` is the candidate, wire `000011011` |
| `negative.installed-daemon` | SKIP | **executes**, expected PASS |
| `negative.installed-daemon-serves` | absent | **appears**, expected PASS |

So the expected after-state is **27 PASS / 0 FAIL / 7 SKIP of 34**. Both the pass
count *and the total* change: 23 + 2 = 25, then the two installed-daemon checks
run for the first time, giving 27 of 34.

The second of those rows is easy to miss. `negative.installed-daemon` does not
merely change status, it changes category, and on success it emits a companion
check, `negative.installed-daemon-serves`, that today's run never produces at
all. Enumerating every id the harness can emit (`pass_check`/`fail_check`/
`skip_check` sites) finds exactly one that cannot run today, and it is that
companion. A reviewer expecting 33 checks would see 34 and reasonably suspect
someone had added a check; nobody will have.

It is also skipped today only because the `/Applications` build predates the
broker and has no client text, so on first install it exercises the G1
startup-crash path against a freshly installed daemon for the first time. A
failure there is a real regression, not an expected shift, and it would not be
visible to anyone watching only the two known failures.

Any **PASS that becomes FAIL or SKIP** is a regression. Any **SKIP that
disappears without a corresponding PASS** is a harness problem. Compare the
`source.harnessSha256` of the two runs before comparing anything else: evidence
from two different harness versions is not comparable, and the baseline carries
`108d34cd…`.

The seven remaining skips are not closed by a green harness, which is what
"a green LaunchAgent path alone does not close the gate" means in practice:

- `positive.protected-write`, `skip.full-access`, `skip.ui-issued`,
  `skip.installed-import` and `skip.remote-coding` need the signed UI window or
  a paired device — Phase H.
- `static.cdhash-pins` needs root. Running the harness once under `sudo`
  converts it to a real check without changing any status semantics; worth
  doing at the checkpoint, and the only skip that can be retired that way.
- `skip.native-cli` stays open until the e2e suite runs.

Phase H's interactive list is therefore not a formality sitting behind the
harness: seven checks, including the only proof that a protected *write* works
through the signed window, cannot be produced by `acceptance-provenance.sh` at
all.

## Conditions an administrator must satisfy before Phase E

Measured at the time of writing — **both are currently unmet**:

- **A UI is running** (`pgrep -x 'Apex Deck'` returns a pid). Phase B requires
  every copy quit before executable paths change.
- **The per-user agent is loaded** (`launchctl print gui/$(id -u)/dev.apexdeck.daemon`
  succeeds). Phase B requires
  `launchctl bootout "gui/$(id -u)/dev.apexdeck.daemon"` first.

No `apex-daemon` process was running in @deepgeek's snapshot. At @null's
2026-10-23 06:39Z read-back, the old `/Applications` UI **and daemon** were
running (pids 7105 and 7118); the loaded agent reported `state = running` and
the same `/Applications` daemon path. Recheck process paths immediately before
Phase C. The earlier absence of a daemon is not a quiescence guarantee.

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

1. Phase B: quit every UI copy, bootout the per-user daemon agent, and prove with
   `pgrep` that no `apex-daemon` and no `Apex Deck` remains. Leave the root broker
   running until Phase E stops it for the executable swap.
2. Follow Phases C–G in `UPGRADE-PROCEDURE.md`, authenticating only its explicit
   `sudo` commands; user-store backup and launching the UI run as the ordinary user.
   Phase E and Rollback are the only blocks that can damage authority; both were
   rehearsed against a sandbox, neither has been run against this machine.
   In Phase F, before launching any candidate UI or daemon, compare the Phase C
   and after-swap inventories. Require unchanged keys, journal and pre-existing
   lock identities, the exact candidate pins, and `RESULT: PASS`.
3. Phase H: the acceptance harness (expecting `launchagent.daemon-path` and
   `static.fuses.installed` to turn PASS, and `negative.installed-daemon` to
   execute rather than skip), then the interactive checklist.
4. A final `sudo /bin/bash scripts/authority-inventory.sh` after acceptance:
   unchanged keys and every pre-existing lock identity, pins matching the
   candidate. Successful protected writes may change the journal and create new
   lock scopes. Do not require the strict `--compare` verdict to pass across
   that activity window; the unchanged-journal proof is the Phase F comparison.
   Verify preservation of records through the signed UI separately.

`launchagent.daemon-path` must transition to PASS, together with
`static.fuses.installed` and the newly executing installed-daemon checks. The
gate closes only after the complete required signed UI, preserved-data,
ownership, Full access, paired-remote and native CLI evidence is reviewed.
Named shell skips remain outstanding until separately evidenced; they are not
passes. Tasks 4–8 remain gated until then. @null retains final installed
verification; @deepgeek can review the captured evidence without administrator
access.
