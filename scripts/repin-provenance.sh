#!/bin/bash
# Re-pin the provenance broker after rebuilding Apex Deck.
#
# install-provenance.sh deliberately refuses to overwrite existing authority, so
# every rebuild — which changes the app's CDHash — leaves the pin stale and makes
# every protected command fail closed with "Only the pinned installed UI may
# record a submission or decision." This script performs the documented removal
# and hands off to the real installer, which re-runs all of its own checks.
#
# The authority directory holds more than the trust pins: journal.json contains
# every protected ledger (assistants, tasks, conversations, room authority,
# machine, project memory), plus the submission receipts and checkpoint. Those
# records are NOT migrated forward, so this script copies the directory aside
# before deleting it.
#
# Usage: sudo /bin/bash scripts/repin-provenance.sh [--yes] [--dry-run]
#   --yes       skip the confirmation prompt (for scripted rebuilds)
#   --dry-run   print what would happen; requires no root, changes nothing
# Exits nonzero if installation or verification fails.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

LABEL='dev.apexdeck.provenance'
ROOT='/Library/Application Support/Apex Deck Provenance'
PLIST="/Library/LaunchDaemons/$LABEL.plist"
SOCKET='/var/run/dev.apexdeck.provenance.sock'
APP='/Applications/Apex Deck.app'
BROKER="$APP/Contents/Resources/bin/apex-provenance"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$HERE/install-provenance.sh"
VERIFIER="$HERE/verify-install.sh"

DRY=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) /usr/bin/sed -n '2,20p' "${BASH_SOURCE[0]}" | /usr/bin/cut -c3-; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

run() {
  if (( DRY )); then
    /usr/bin/printf '  would run: %s\n' "$*"
  else
    "$@"
  fi
}

say() { echo "$*"; }

cdhash() {
  /usr/bin/codesign -d --verbose=4 "$1" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2; exit}'
}

# A future edit must not be able to widen this into a destructive rm.
[[ "$ROOT" == '/Library/Application Support/Apex Deck Provenance' ]] || {
  echo 'Refusing: unexpected authority path.' >&2; exit 1; }

if (( ! DRY )); then
  [[ $EUID == 0 ]] || { echo 'Run this as administrator (sudo).' >&2; exit 1; }
fi

for f in "$INSTALLER" "$VERIFIER"; do
  [[ -f "$f" ]] || { echo "Missing required script: $f" >&2; exit 1; }
done
[[ -d "$APP" ]] || { echo "Not installed: $APP" >&2; exit 1; }
[[ -f "$BROKER" && ! -L "$BROKER" ]] || {
  echo "This app ships no broker binary: $BROKER" >&2
  echo 'Install the rebuilt app before re-pinning.' >&2
  exit 1
}

# --- 1. Back up, because the journal is not migrated ------------------------
BACKUP=""
if [[ -e "$ROOT" || -L "$ROOT" ]]; then
  [[ -L "$ROOT" ]] && { echo 'Refusing: authority directory is a symlink.' >&2; exit 1; }
  BACKUP="$ROOT.backup-$(date +%Y%m%d-%H%M%S)"
  say "Backing up existing authority to:"
  say "  $BACKUP"
  run /usr/bin/ditto "$ROOT" "$BACKUP"
fi

# --- 2. Confirm, since this discards protected records ----------------------
if (( ! ASSUME_YES && ! DRY )) && [[ -e "$ROOT" || -e "$PLIST" ]]; then
  say ''
  say 'This removes the authority directory, which contains journal.json —'
  say 'every protected ledger (assistants, tasks, conversations, room authority,'
  say 'machine, project memory), the submission receipts and the signing key.'
  say 'These records are not migrated back automatically.'
  /usr/bin/printf "Type 'repin' to continue: "
  read -r reply
  [[ "$reply" == 'repin' ]] || { echo 'Aborted.' >&2; exit 1; }
fi

# --- 3. Boot out before deleting, so launchd cannot respawn a dead binary ---
say "Booting out $LABEL"
if ! run /bin/launchctl bootout "system/$LABEL" 2>/dev/null; then
  say '  (not loaded)'
fi

if [[ -e "$PLIST" || -L "$PLIST" ]]; then
  say "Removing $PLIST"
  run /bin/rm -f "$PLIST"
fi

if [[ -e "$ROOT" ]]; then
  say 'Removing the authority directory'
  run /bin/rm -rf "$ROOT"
fi

# --- 4. Hand off to the real installer, which re-runs every check -----------
say 'Reinstalling authority pinned to the installed app'
run /bin/bash "$INSTALLER" "$APP" "$BROKER"

# --- 5. Verify -------------------------------------------------------------
say ''
say 'Verifying the installed app against the build in release/'
VERIFY_STATUS=0
run /bin/bash "$VERIFIER" || VERIFY_STATUS=$?

# verify-install.sh does not look at the provenance broker at all, so check the
# thing this script exists to change: that the pin matches the app you will run.
PIN_STATUS=0
if (( DRY )); then
  say '  would check: config.json uiCdhash/daemonCdhash match the installed app,'
  say '               LaunchDaemon loaded, and the broker socket present'
else
  say ''
  say 'Verifying the pin matches the installed app'
  if [[ ! -f "$ROOT/config.json" ]]; then
    say '  FAIL: no config.json — installation did not complete'
    PIN_STATUS=1
  else
    actual_ui=$(cdhash "$APP" | /usr/bin/tr 'A-Z' 'a-z')
    actual_daemon=$(cdhash "$APP/Contents/Resources/bin/apex-daemon" | /usr/bin/tr 'A-Z' 'a-z')
    pinned_ui=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["uiCdhash"].lower())' "$ROOT/config.json")
    pinned_daemon=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["daemonCdhash"].lower())' "$ROOT/config.json")
    if [[ "$actual_ui" == "$pinned_ui" ]]; then
      say "  OK: pinned UI CDHash ${pinned_ui:0:16}..."
    else
      say "  FAIL: pinned UI ${pinned_ui:0:16}... != installed ${actual_ui:0:16}..."
      PIN_STATUS=1
    fi
    if [[ "$actual_daemon" == "$pinned_daemon" ]]; then
      say "  OK: pinned daemon CDHash ${pinned_daemon:0:16}..."
    else
      say "  FAIL: pinned daemon ${pinned_daemon:0:16}... != installed ${actual_daemon:0:16}..."
      PIN_STATUS=1
    fi
  fi

  if /bin/launchctl print "system/$LABEL" >/dev/null 2>&1; then
    say '  OK: LaunchDaemon is loaded'
  else
    say '  FAIL: LaunchDaemon is not loaded'
    PIN_STATUS=1
  fi
  if [[ -S "$SOCKET" ]]; then
    say "  OK: broker socket present at $SOCKET"
  else
    say "  FAIL: broker socket missing at $SOCKET"
    PIN_STATUS=1
  fi
  if [[ -f /var/log/apex-provenance.log ]]; then
    say "  log: /var/log/apex-provenance.log"
  fi
fi

# --- 6. Summary ------------------------------------------------------------
say ''
if (( VERIFY_STATUS != 0 || PIN_STATUS != 0 )); then
  echo "RESULT: re-pin needs attention (verify-install exit $VERIFY_STATUS, pin check exit $PIN_STATUS)." >&2
  [[ -n "$BACKUP" ]] && echo "Previous authority preserved at: $BACKUP" >&2
  exit 1
fi
echo 'RESULT: re-pinned and verified. Launch the installed app to exercise the boundary.'
if [[ -n "$BACKUP" ]]; then
  say ''
  say "Previous authority preserved at: $BACKUP"
  say 'Its records are not restored automatically. To carry them forward, copy'
  say 'private-key, public-key and journal.json back into the authority directory'
  say '(keep the new config.json) and restart the daemon — the key and journal must'
  say 'be restored together or the broker refuses with "Authority key mismatch".'
fi
exit 0
