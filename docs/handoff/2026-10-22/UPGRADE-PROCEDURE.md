# Authority-preserving upgrade procedure — gate candidate `8f67474`

Prepared by @deepgeek for @null's review. This is a procedure, not an
authorization: until it is reviewed and an administrator runs it, nothing here
has happened. No installation, root write, re-pin, merge or Tasks 4–8 is
implied by its existence.

Run the phases in order from one ordinary-user Terminal shell in the integration
checkout so `MNT` and `STAMP` remain available to later phases and rollback:

```sh
cd /Users/tylercaldwell/Downloads/apex-deck-worktrees/assistant-workspace-plan
```

Use `sudo` only where shown. The reviewed [pre-flight record](GATE-8f67474-PREFLIGHT.md)
documents the existing backups, user-store size and process state; repeat the
live Phase B checks before acting on that snapshot.

Two helper scripts accompany it, both read-only:

- `scripts/verify-protected-bundle.sh` — validates a candidate bundle against
  the selected CDHashes *before* anything is pinned.
- `scripts/authority-inventory.sh` — fingerprints keys, journal and
  `host-locks/` inodes before and after, and compares them.

## Why this is not `repin-provenance.sh`

`scripts/repin-provenance.sh` is correct for what it does — re-pinning a
rebuild when protected records may be recreated. It is wrong for this upgrade,
because it `rm -rf`'s the authority directory (`repin-provenance.sh:109-112`):

- `journal.json` holds every protected ledger — assistants, tasks,
  conversations, room authority, machine, project memory — plus receipts and
  the checkpoint. Its own header says those records are **not** migrated
  forward.
- `host-locks/` (introduced by `636e4ef`) holds one root-owned inode per
  (uid, data dir) scope. Deleting and recreating the directory gives every
  existing host a *different* inode for the same scope, which is exactly the
  replacement `ownership.rs` exists to prevent.

`scripts/finish-install.sh` is also excluded: stale staging paths, and an
automatic `repin-provenance.sh --yes` on a prompt meant for a human.

**The invariant: never replace the authority directory. Update inside it.**
Keys, journal and `host-locks/` are never moved, copied over or recreated — so
they are preserved by construction, and the inventories prove it afterwards.

## Candidate identity — verified on this machine, 2026-10-23

| What | Value |
| --- | --- |
| DMG | `release/Apex-Deck_0.8.2_gate-8f67474_arm64.dmg` |
| SHA256 | `3a47ae30977e0c97e816056995f849945c6e6af70611de1cdb75a1d584f0bf58` |
| UI CDHash | `b2ad5d46b0e2142f72b6dd1f734968d0ca25f9a6` |
| Daemon CDHash | `538dbd0910120859858a1e613e659daaa31d4bcc` |
| Broker CDHash | `12b8eb9af7ae0cd92fbd1d4ee384296718c20a9a` |
| Version | `0.8.2`, arm64, Developer ID signed, not notarized |

I re-derived the SHA256 from the file on disk and the three CDHashes by
mounting the DMG read-only, rather than copying them from the build receipt.
All four matched `gate-8f67474-HANDOFF.md`.

## What is installed now — measured, not assumed

| Copy | Version | UI CDHash | Daemon CDHash | Fuses | Root-protected |
| --- | --- | --- | --- | --- | --- |
| `/Applications/Apex Deck.app` | 0.8.2 | `714bea0f…` | `f6013a4a…` | `101100011` | **no** |
| protected `TrustedUI` | 0.8.2 | `7911a74d…` | `9a7405e0…` | `000011011` | yes |

Root broker binary CDHash `24d6295d…`. LaunchAgent
`~/Library/LaunchAgents/dev.apexdeck.daemon.plist` currently runs
`/Applications/Apex Deck.app/Contents/Resources/bin/apex-daemon`.
`host-locks/` does not exist yet.

Four hazards follow directly from that table.

**H1 — three different builds, all calling themselves 0.8.2.** Version strings
cannot identify a build here. `desktop/trustedInstall.mjs:117` decides
"same version" with `bundleVersion(trustedApp) === version`, a *string*
comparison, so today `/Applications` will hand off to a protected copy that is
a different build from itself, and after a partial upgrade it will hand off to
one that is a different build from the candidate. Every check in this procedure
is by CDHash. Both copies get updated in one session; do not stop between them.

**H2 — the installed `/Applications` copy has unsafe Electron fuses.**
Measured wire `101100011` against the candidate's `000011011`: `RunAsNode`,
`NODE_OPTIONS` and CLI-inspect arguments are **enabled** in the installed copy
and disabled in the candidate. `install-provenance.sh:35-36` would refuse to
install that bundle, so it predates the current fuse hardening. It was not
caught because acceptance's `static.fuses` reads `$APP`, the protected copy
only (`acceptance-provenance.sh:247-283`) — the untrusted copy's fuses are
outside that check. This procedure's stage-and-verify step closes that gap, and
the `/Applications` copy is replaced in Phase G. Acceptance now reports
`static.fuses.installed` separately, applying the same rule to every slice of
that copy. The old baseline therefore gains a second FAIL until it is replaced.

**H3 — `host-locks/` is absent before the upgrade.** The installed daemon
predates `636e4ef`, so no locks exist yet. The new build creates them on first
run. `--compare` therefore reports `ADDED`, not drift — but any lock present
*before* must survive with the same inode.

**H4 — the LaunchAgent points at the untrusted daemon.** This is the failing
`launchagent.daemon-path` check. `installAgent` refuses to downgrade an agent
that runs the protected daemon (`launchAgent.mjs:141`), so once the protected
copy writes the agent it cannot be rewritten by the `/Applications` copy. The
order in Phase G is what makes the check pass and stay passing.

## Phase A — verify the artifact (no root)

```sh
DMG='/Users/tylercaldwell/Downloads/apex-deck/release/Apex-Deck_0.8.2_gate-8f67474_arm64.dmg'
MNT='/tmp/gate-8f67474'
/usr/bin/shasum -a 256 "$DMG"          # expect 3a47ae30…
/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$DMG"
/bin/bash scripts/verify-protected-bundle.sh "$MNT/Apex Deck.app" \
  b2ad5d46b0e2142f72b6dd1f734968d0ca25f9a6 \
  538dbd0910120859858a1e613e659daaa31d4bcc \
  "$MNT/Apex Deck.app/Contents/Resources/bin/apex-provenance" \
  12b8eb9af7ae0cd92fbd1d4ee384296718c20a9a
```

Expect four `OK` lines and exit 0, including an exact broker CDHash match.
**Stop on anything else.** Leave the image
mounted until the end of Phase G; detach it last. If a mount attempt reports
`Resource busy`, check `/sbin/mount | grep gate` and detach the stale one first.

## Phase B — quiesce, and prove it

Hosts must be stopped before executable paths or pins change.

1. Quit Apex Deck from every copy (Dock, ⌘Q, both bundle names).
2. Stop the per-user agent: `launchctl bootout "gui/$(id -u)/dev.apexdeck.daemon"`
3. Prove nothing that serves or holds authority is left:

```sh
pgrep -x apex-daemon       # must print nothing
pgrep -x 'Apex Deck'       # must print nothing
/bin/bash scripts/authority-inventory.sh | /usr/bin/python3 -c \
  'import json,sys; print(json.load(sys.stdin)["running"])'
```

The broker (`apex-provenance`) is expected to be the one remaining process. It
is the authority, not a host, and it is stopped in Phase E only to replace its
own binary. **Do not proceed while any `apex-daemon` is alive.**

## Phase C — capture before, take backups

```sh
STAMP="$(/bin/date +%Y%m%d-%H%M%S)"
sudo /bin/bash scripts/authority-inventory.sh > "$HOME/gate-8f67474-before.json"
```

Run it with `sudo`: `config.json`, `journal.json` and the private key are
root-only. An unprivileged inventory records unreadable hashes; comparing it
prints `RESULT: INCONCLUSIVE` with exit 2 rather than pretending they matched.

Back up root authority — keys, journal and pins together, plus a fallback copy
of the locks. The fallback's inodes differ by design; it is for recovery, not
for the identity check:

```sh
sudo /bin/bash -euo pipefail -s -- "$STAMP" <<'BACKUP'
STAMP=$1
[[ "$STAMP" =~ ^[0-9]{8}-[0-9]{6}$ ]] || exit 1
ROOT='/Library/Application Support/Apex Deck Provenance'
BACKUP="/Library/Application Support/Apex Deck Provenance.backup-$STAMP"
[[ ! -e "$BACKUP" && ! -L "$BACKUP" ]] || exit 1
/usr/bin/install -d -o root -g wheel -m 700 "$BACKUP"
for f in private-key public-key journal.json config.json; do
  /usr/bin/ditto "$ROOT/$f" "$BACKUP/$f"
done
if [[ -d "$ROOT/host-locks" ]]; then
  /usr/bin/ditto "$ROOT/host-locks" "$BACKUP/host-locks"
fi
BACKUP
```

Back up the user store and the agent separately — these are different stores,
and one does not preserve the other:

```sh
/usr/bin/install -d -m 700 "$HOME/gate-backup-$STAMP" || exit 1
/usr/bin/ditto "$HOME/Library/Application Support/dev.apexdeck.app" "$HOME/gate-backup-$STAMP/user-store" || exit 1
if [[ -f "$HOME/Library/LaunchAgents/dev.apexdeck.daemon.plist" ]]; then
  /bin/cp "$HOME/Library/LaunchAgents/dev.apexdeck.daemon.plist" "$HOME/gate-backup-$STAMP/" || exit 1
else
  : > "$HOME/gate-backup-$STAMP/no-previous-agent"
fi
```

Do not `mv` or delete anything yet. Old bundles are renamed aside in place in
Phase E and G, which keeps them without copying ~500 MB twice.

## Phase D — stage and validate, before anything is pinned

```sh
ROOT='/Library/Application Support/Apex Deck Provenance'
sudo /usr/bin/install -d -o root -g wheel -m 700 "$ROOT/.upgrade-$STAMP"
sudo /usr/bin/ditto "$MNT/Apex Deck.app" "$ROOT/.upgrade-$STAMP/Apex Deck.app"
sudo /usr/bin/install -m 755 "$MNT/Apex Deck.app/Contents/Resources/bin/apex-provenance" \
  "$ROOT/.upgrade-$STAMP/apex-provenance"
sudo /usr/sbin/chown -R root:wheel "$ROOT/.upgrade-$STAMP"
sudo /bin/chmod -RN "$ROOT/.upgrade-$STAMP"
sudo /bin/chmod -R go-w "$ROOT/.upgrade-$STAMP"
```

Validate the staged copy — signature, hardened runtime, fuses, ASAR integrity,
symlink containment, and both CDHashes. It runs under `sudo` because the
staging directory is `700 root`:wheel, which is what stops a user swapping the
bytes between validation and the swap.

```sh
sudo /bin/bash scripts/verify-protected-bundle.sh "$ROOT/.upgrade-$STAMP/Apex Deck.app" \
  b2ad5d46b0e2142f72b6dd1f734968d0ca25f9a6 \
  538dbd0910120859858a1e613e659daaa31d4bcc \
  "$ROOT/.upgrade-$STAMP/apex-provenance" \
  12b8eb9af7ae0cd92fbd1d4ee384296718c20a9a
```

Exit 0 required. Nothing has been pinned, swapped or started at this point, so
a failure here costs nothing: delete `.upgrade-$STAMP` and stop.

## Phase E — swap executables, then re-pin

Run this entire block as one command. The child shell stops on the first failed
operation; do not proceed to Phase F after a nonzero exit. On interruption or
failure, use the conditional rollback below, which also handles a partially
completed swap. Do not repeat Phase E: its preflight deliberately refuses an
already-started swap. Keys, journal and `host-locks/` are not opened for writing.

```sh
sudo /bin/bash -euo pipefail -s -- "$STAMP" <<'SWAP'
ROOT='/Library/Application Support/Apex Deck Provenance'
STAMP=$1
[[ "$STAMP" =~ ^[0-9]{8}-[0-9]{6}$ ]] || exit 1
STAGE="$ROOT/.upgrade-$STAMP"
BACKUP="/Library/Application Support/Apex Deck Provenance.backup-$STAMP"
for image in "$ROOT/TrustedUI/Apex Deck.app" "$ROOT/apex-provenance" \
  "$STAGE/Apex Deck.app" "$STAGE/apex-provenance" "$BACKUP/config.json"; do
  [[ -e "$image" && ! -L "$image" ]] || { echo "Missing or linked: $image" >&2; exit 1; }
done
for previous in "$STAGE/previous-Apex Deck.app" "$STAGE/previous-apex-provenance"; do
  [[ ! -e "$previous" && ! -L "$previous" ]] || { echo 'Swap already started; use Rollback.' >&2; exit 1; }
done
if /usr/bin/pgrep -x apex-daemon >/dev/null || /usr/bin/pgrep -x 'Apex Deck' >/dev/null; then
  echo 'A host or UI is still alive; return to Phase B.' >&2; exit 1
fi
/bin/launchctl bootout system/dev.apexdeck.provenance
/bin/mv "$ROOT/TrustedUI/Apex Deck.app" "$STAGE/previous-Apex Deck.app"
/bin/mv "$STAGE/Apex Deck.app" "$ROOT/TrustedUI/Apex Deck.app"
/bin/mv "$ROOT/apex-provenance" "$STAGE/previous-apex-provenance"
/bin/mv "$STAGE/apex-provenance" "$ROOT/apex-provenance"
/usr/sbin/chown root:wheel "$ROOT/apex-provenance"
/bin/chmod 755 "$ROOT/apex-provenance"
/usr/bin/python3 -I - "$ROOT" <<'PY'
import json, os, sys
root = sys.argv[1]
path = os.path.join(root, "config.json")
with open(path, "rb") as f:
    config = json.load(f)
def cdhash(image):
    import subprocess
    done = subprocess.run(["/usr/bin/codesign", "-d", "--verbose=4", image],
                          capture_output=True, text=True, check=True)
    out = done.stderr
    for line in out.splitlines():
        if line.startswith("CDHash="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no CDHash for " + image)
app = os.path.join(root, "TrustedUI", "Apex Deck.app")
config["uiCdhash"] = cdhash(app)
config["daemonCdhash"] = cdhash(os.path.join(app, "Contents/Resources/bin/apex-daemon"))
temp = path + ".tmp"
with open(temp, "w") as f:
    json.dump(config, f)
    f.write("\n")
os.chmod(temp, 0o600)
os.chown(temp, 0, 0)
os.replace(temp, path)
print("pinned", config["uiCdhash"], config["daemonCdhash"])
PY
/bin/launchctl bootstrap system /Library/LaunchDaemons/dev.apexdeck.provenance.plist
SWAP
```

Only after that command exits 0, confirm the broker is running:

```sh
sudo /bin/launchctl print system/dev.apexdeck.provenance | /usr/bin/grep -E 'state|pid'
ls -l /var/run/dev.apexdeck.provenance.sock
```

**Stop conditions:** if the broker does not reach `state = running`, or the
socket is absent, do not continue to Phase G — go to Rollback. The authority is
not yet verified: keys, journal and locks remain untouched, but trust pins may
already have changed, so rollback must restore the matching bundles and pins.

## Phase F — prove the authority came through

Take the after-swap inventory *before* any app runs, while the protected store
is still untouched:

```sh
sudo /bin/bash scripts/authority-inventory.sh > "$HOME/gate-8f67474-after.json"
/bin/bash scripts/authority-inventory.sh --compare \
  "$HOME/gate-8f67474-before.json" "$HOME/gate-8f67474-after.json"
```

Required reading of that output:

- `SAME private-key`, `SAME public-key`, `SAME journal.json` — all three, with
  the journal byte count unchanged. `UNPROVEN` here means the inventory was not
  run with `sudo`; redo it.
- `SAME host-locks/…` for anything that existed, or `ADDED` if this is the
  first build to create locks. `FAIL … inode … -> …` is the one outcome that
  must stop the upgrade.
- `CHANGED pin uiCdhash`, `CHANGED pin daemonCdhash` — expected; they are
  `b2ad5d46…` and `538dbd09…` in the after file.
- `RESULT: PASS`.

**Do not require `--compare` to pass across the acceptance window.** After
Phase H the journal may have changed through legitimate protected writes. For
the whole-window review, compare before-swap against the post-acceptance
inventory and read the per-item lines; the strict tool may exit 1 for the changed
journal, which is not the Phase F preservation verdict. The keys and every
pre-existing lock identity must still say `SAME`. Journal growth and `ADDED`
lock scopes are expected after real activity; neither is an upgrade-time loss.

## Phase G — `/Applications`, the agent, and launching the protected copy

```sh
sudo /bin/bash -euo pipefail -s -- "$STAMP" "$MNT" <<'APPLICATIONS'
STAMP=$1
MNT=$2
[[ "$STAMP" =~ ^[0-9]{8}-[0-9]{6}$ ]] || exit 1
[[ -d "$MNT/Apex Deck.app" && -d '/Applications/Apex Deck.app' ]] || exit 1
[[ ! -e "/Applications/Apex Deck.app.previous-$STAMP" && ! -L "/Applications/Apex Deck.app.previous-$STAMP" ]] || exit 1
/bin/mv "/Applications/Apex Deck.app" "/Applications/Apex Deck.app.previous-$STAMP"
/usr/bin/ditto "$MNT/Apex Deck.app" "/Applications/Apex Deck.app"
APPLICATIONS
```

Require exit 0 before verification or launch. A failed copy leaves the original
in `.previous-$STAMP`; use Rollback rather than retrying the rename.

```sh
/bin/bash scripts/verify-protected-bundle.sh "/Applications/Apex Deck.app" \
  b2ad5d46b0e2142f72b6dd1f734968d0ca25f9a6 \
  538dbd0910120859858a1e613e659daaa31d4bcc
```

Then launch the **protected** copy, which is the one the broker trusts and the
only one that may write the agent:

```sh
/usr/bin/open "/Library/Application Support/Apex Deck Provenance/TrustedUI/Apex Deck.app"
```

Confirm the agent now runs the protected daemon, and nothing else does:

```sh
/usr/bin/python3 -c 'import plistlib,os;print(plistlib.load(open(os.path.expanduser("~/Library/LaunchAgents/dev.apexdeck.daemon.plist"),"rb"))["ProgramArguments"][0])'
pgrep -x apex-daemon   # then: ps -o comm= -p <pid> — must be the TrustedUI daemon
```

The path must be
`/Library/Application Support/Apex Deck Provenance/TrustedUI/Apex Deck.app/Contents/Resources/bin/apex-daemon`.
That is `launchagent.daemon-path`. Do not open the `/Applications` copy to
"check" it — the handoff it performs is expected (H1), but opening it is not
evidence of anything and only adds noise to the running-process comparison.

Detach the image once Phase G verifies: `/usr/bin/hdiutil detach "$MNT"`.

## Phase H — installed acceptance and interactive evidence

```sh
/bin/bash scripts/acceptance-provenance.sh --evidence "$HOME/gate-8f67474-acceptance"
```

Expect `launchagent.daemon-path` and `static.fuses.installed` to **PASS**. The
`negative.installed-daemon` checks must now execute, because this candidate has
a broker client. `static.cdhash-pins` remains SKIP without administrator access;
UI/device-dependent checks remain SKIP in this shell harness even when a window
is open. Capture their evidence separately rather than relabeling them.
Require zero harness failures and review every skip. A passing
LaunchAgent path alone does not close the gate; all required interactive items
below must also be evidenced before Tasks 4–8 proceed.

Then, interactively, and none of it may be inferred from counts:

- a protected write issued by the signed UI, and an import preview with explicit
  confirmation, including a partial failure and a re-import deduplication;
- assistants, tasks, conversations and rooms restored with `Imported ·
  unverified` markers, and legacy conversations opening read-only;
- old permissions and custom commands remaining **inactive** until separately
  approved (`05d2502`);
- duplicate daemon, `owner.lock` replacement and broker restart (`636e4ef`);
- Full access edits, builds, Git, network, subprocess; ordinary paired remote
  coding; native CLI acceptance.

Take a final `sudo authority-inventory.sh > after-acceptance.json`, compare
against before, and confirm unchanged keys and pre-existing lock identities.
The journal may have grown and new lock scopes may have been added.

## Rollback — same authority, no journal loss

Rollback touches only what Phase E and G swapped. It preserves the keys, journal,
receipts and lock identities as they stand immediately before rollback,
including writes and new locks from Phase H. Quit all UI copies first. Stop the
per-user agent if it is loaded:

```sh
if /bin/launchctl print "gui/$(id -u)/dev.apexdeck.daemon" >/dev/null 2>&1; then
  /bin/launchctl bootout "gui/$(id -u)/dev.apexdeck.daemon" || exit 1
fi
sudo /bin/bash scripts/authority-inventory.sh > "$HOME/gate-8f67474-pre-rollback.json"
```

The root block handles every partial-swap state: each saved original is restored
only if it was actually renamed aside, and an installed candidate is retained
under a rollback name. A missing active path after a failed rename is safe.
An existing rollback destination is a stop condition requiring inspection.

```sh
sudo /bin/bash -euo pipefail -s -- "$STAMP" <<'ROLLBACK'
ROOT='/Library/Application Support/Apex Deck Provenance'
STAMP=$1
[[ "$STAMP" =~ ^[0-9]{8}-[0-9]{6}$ ]] || exit 1
STAGE="$ROOT/.upgrade-$STAMP"
BACKUP="/Library/Application Support/Apex Deck Provenance.backup-$STAMP"
APPLICATIONS='/Applications'
[[ -f "$BACKUP/config.json" && ! -L "$BACKUP/config.json" ]] || exit 1
if /usr/bin/pgrep -x apex-daemon >/dev/null || /usr/bin/pgrep -x 'Apex Deck' >/dev/null; then
  echo 'A host or UI is still alive; stop it before rollback.' >&2; exit 1
fi
if /bin/launchctl print system/dev.apexdeck.provenance >/dev/null 2>&1; then
  /bin/launchctl bootout system/dev.apexdeck.provenance
fi
restore() {
  local active=$1 saved=$2 quarantined=$3
  [[ ! -L "$saved" ]] || exit 1
  if [[ -e "$saved" ]]; then
    [[ ! -e "$quarantined" && ! -L "$quarantined" ]] || exit 1
    if [[ -e "$active" || -L "$active" ]]; then /bin/mv "$active" "$quarantined"; fi
    /bin/mv "$saved" "$active"
  fi
}
restore "$ROOT/TrustedUI/Apex Deck.app" "$STAGE/previous-Apex Deck.app" "$STAGE/rolled-back-Apex Deck.app"
restore "$ROOT/apex-provenance" "$STAGE/previous-apex-provenance" "$STAGE/rolled-back-apex-provenance"
restore "$APPLICATIONS/Apex Deck.app" "$APPLICATIONS/Apex Deck.app.previous-$STAMP" "$APPLICATIONS/Apex Deck.app.rolled-back-$STAMP"
[[ -d "$ROOT/TrustedUI/Apex Deck.app" && -f "$ROOT/apex-provenance" ]] || exit 1
[[ ! -e "$ROOT/config.json.rollback-$STAMP" && ! -L "$ROOT/config.json.rollback-$STAMP" ]] || exit 1
/usr/bin/install -o root -g wheel -m 600 "$BACKUP/config.json" "$ROOT/config.json.rollback-$STAMP"
/bin/mv "$ROOT/config.json.rollback-$STAMP" "$ROOT/config.json"
/bin/launchctl bootstrap system /Library/LaunchDaemons/dev.apexdeck.provenance.plist
ROLLBACK
```

Before restarting any host, capture an after-rollback inventory and compare it
to the snapshot taken immediately before rollback:

```sh
sudo /bin/bash scripts/authority-inventory.sh > "$HOME/gate-8f67474-after-rollback.json"
/bin/bash scripts/authority-inventory.sh --compare \
  "$HOME/gate-8f67474-pre-rollback.json" "$HOME/gate-8f67474-after-rollback.json"
```

Require `SAME` on keys, journal and every lock inode, and `RESULT: PASS`.
Separately compare original-before to after-rollback for key and existing-lock
preservation; a journal changed by Phase H must stay changed, not be replaced
with its old backup.

After exit 0, restore the original user LaunchAgent. If none existed before,
retain any new plist in the user backup and leave the agent unloaded. Otherwise
restore its original target and start it as the user:

```sh
AGENT="$HOME/Library/LaunchAgents/dev.apexdeck.daemon.plist"
if [[ -f "$HOME/gate-backup-$STAMP/dev.apexdeck.daemon.plist" ]]; then
  /bin/cp "$HOME/gate-backup-$STAMP/dev.apexdeck.daemon.plist" "$AGENT" || exit 1
  /bin/launchctl bootstrap "gui/$(id -u)" "$AGENT" || exit 1
elif [[ -f "$HOME/gate-backup-$STAMP/no-previous-agent" ]]; then
  if [[ -e "$AGENT" ]]; then
    [[ ! -e "$HOME/gate-backup-$STAMP/candidate-agent.plist" ]] || exit 1
    /bin/mv "$AGENT" "$HOME/gate-backup-$STAMP/candidate-agent.plist" || exit 1
  fi
else
  echo 'Original agent backup is unproven; stop and inspect.' >&2; exit 1
fi
```

Restoring the old `config.json` restores the old pins — so it must be copied
back *together with* the old bundles, never on its own. A pin that names a
bundle that is not in place is what makes every protected command fail closed
with "Only the pinned installed UI may record a submission or decision."

Verify the broker state, both restored bundle hashes, original LaunchAgent
target and actual daemon executable against the before inventory. Restart the
previous UI only after those match.

Never restore keys or journal from the user store, and never copy
`journal.json` without `private-key` and `public-key`: the broker refuses a
mismatched pair with "Authority key mismatch".

## Rehearsal — Phase E and Rollback executed before this handover

The original Phase E was run end to end
against a sandbox on 2026-10-23 rather than merely written down. The sandbox
used **real bundles** — APFS clones of the protected copy (`7911a74d…`) and the
candidate (`b2ad5d46…`), so `codesign` derived the real hashes — over
**synthetic authority**: `private-key`, `public-key`, `journal.json`,
`host-locks/` with two lock files, and a `config.json` carrying both pins plus
two keys the procedure does not know about. The code run was the Phase E and
Rollback blocks from commit `9992dd0`, with `sudo` and the `launchctl` lines
omitted. That rehearsal predates the guarded shells and conditional rollback
added during @null's review; it does not claim to have exercised the current
live service or administrator path.

| Property | Result |
| --- | --- |
| pins rewritten to the candidate | `7911a74d…`/`9a7405e0…` → `b2ad5d46…`/`538dbd09…` |
| `config.json` mode through the atomic replace | `600`, preserved |
| `config.json` keys not named by the procedure | `uiBundleId` and `futureKey` both survived |
| temp file left behind | none |
| `private-key`, `public-key`, `journal.json`, both lock files, and the `host-locks` directory itself | same inode, same size, same SHA-256 after the swap **and** again after rollback |
| rollback | trusted bundle back to `7911a74d…`, pins back to `7911a74d…`/`9a7405e0…`, authority identical |
| re-pin against a bundle that cannot be hashed | refused; **no** temp file; `config.json` unchanged byte for byte and inode for inode |

The last row is the one to keep in mind during the checkpoint: `cdhash()` runs
*before* `config.json` is opened for writing, so a bundle that cannot be
validated aborts the re-pin instead of applying half a pin. The same ordering
means the `os.chown` call aborting — which is what a mistaken non-root run
produces — also leaves the old `config.json` in place.

What the rehearsal did **not** prove: root ownership of the rewritten
`config.json` (a root process creates the temp file root-owned already, so the
documented `os.chown` restores rather than changes it); the `launchctl bootout`
and `bootstrap` steps; and that the broker actually *enforces* the new pins.
Those are Phase F and Phase H, against the real authority.

## Evidence to return to @null

1. `gate-8f67474-before.json`, `gate-8f67474-after.json`,
   `after-acceptance.json`, and the `--compare` output for each pair used.
2. `verify-protected-bundle.sh` output for the mounted DMG, the staged copy and
   `/Applications`.
3. The acceptance harness JSON, with its `source` block (commit, dirty flag,
   harness hash) and the full PASS/FAIL/SKIP list — including the skips, named.
4. The LaunchAgent `ProgramArguments[0]`, the running daemon's `comm`, and the
   broker's `launchctl print` state.
5. Interactive evidence listed in Phase H, plus the before/after inventory
   comparison for preserved records.

## What I could not verify from here

- **No passwordless `sudo` on this machine**, so I did not read the live
  `journal.json`, `private-key`, `config.json` or `host-locks/`. The "measured"
  table above comes from unprivileged reads: ownership, modes, inodes, bundle
  CDHashes, fuses and the LaunchAgent. Record counts and pin values are for the
  administrator's `sudo` inventory to capture.
- **No installation, re-pin or launch happened against the live authority.**
  Nothing was written outside this repository and `/tmp`; the mounted image was
  detached. Phase E and Rollback *were* executed against a sandbox (see the
  rehearsal above), so their logic is measured rather than assumed — the live
  paths are not.
- I did not exercise `verify-protected-bundle.sh` or `authority-inventory.sh`
  as root. Both are read-only by construction, but their `sudo` paths are
  unproven until the checkpoint run — which is worth saying plainly rather than
  leaving to be discovered.
- The rehearsal could not show the broker rejecting a stale pin or accepting the
  new one. It is the broker, not this procedure, that turns a correct
  `config.json` into a working gate; that evidence only exists after Phase F.
