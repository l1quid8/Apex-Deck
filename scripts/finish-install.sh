#!/bin/bash
# Replace a running Apex Deck install and verify it starts.
#
# Why this exists: Apex Deck hosts the assistant chat, so an agent working inside
# the app cannot quit the app to replace it — the session dies mid-swap. This
# script must be run from a real Terminal window, not from inside the app.
#
# It is deliberately non-destructive by default:
#
#   * The protected ledgers are plain files under ~/Library/Application Support/
#     dev.apexdeck.app (assistant-conversations-v1.json, assistant-tasks-v1.json).
#     Nothing here touches them.
#   * There is currently no journal.json in the authority directory, so a re-pin
#     would not carry or lose records — it only re-registers trust in the broker.
#   * Therefore: install, relaunch, and see whether the pinned CDHash already
#     matches. Only re-pin if the daemon is actually denied.
#
# Usage: /bin/bash scripts/finish-install.sh [options]
#   --yes         do not prompt for confirmation
#   --repin       re-pin the broker after installing (destructive; see above)
#   --auto-repin  re-pin only if the relaunched daemon is denied its ledgers
#   --no-backup   do not preserve the replaced .app (saves ~600 MB)
#   --no-relaunch stop after installing; do not open the app
#   --dry-run     print what would happen; changes nothing
#   -h, --help    show this text
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

DEST='/Applications/Apex Deck.app'
ROOT='/Library/Application Support/Apex Deck Provenance'
LABEL='dev.apexdeck.provenance'
SOCKET='/var/run/dev.apexdeck.provenance.sock'
LOG="$HOME/Library/Logs/Apex Deck/apex-daemon.log"
STAGE="${STAGE:-$HOME/Downloads/apex-deck/staging/Apex Deck.app}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The build we intend to install. Bump these when a new DMG is staged.
# Staged from "/Volumes/Apex Deck 0.8.2-arm64 1" (built 2026-10-22 17:15).
EXPECT_APP='7911a74dbc5bf2c944d5099008d6b2ed8847dec1'
EXPECT_DAEMON='9a7405e048a2a80296a6b7a72161dd87cde74e71'
EXPECT_BROKER='24d6295d28f48fe0bbb99d635b9e9a91360940fc'

DRY=0; ASSUME_YES=0; BACKUP=1; RELAUNCH=1; REPIN=0; AUTO_REPIN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)      ASSUME_YES=1 ;;
    --repin)       REPIN=1 ;;
    --auto-repin)  AUTO_REPIN=1 ;;
    --no-backup)   BACKUP=0 ;;
    --no-relaunch) RELAUNCH=0 ;;
    --dry-run)     DRY=1 ;;
    -h|--help)     /usr/bin/sed -n '2,25p' "${BASH_SOURCE[0]}" | /usr/bin/cut -c3-; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n=== %s ===\n' "$*"; }
ok()   { printf '  OK: %s\n' "$*"; }
warn() { printf '  WARN: %s\n' "$*" >&2; }
bad()  { printf '  FAIL: %s\n' "$*" >&2; }
run()  { if (( DRY )); then printf '  would run: %s\n' "$*"; else "$@"; fi; }

cdhash() { /usr/bin/codesign -d --verbose=4 "$1" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2; exit}'; }
app_running()    { /usr/bin/pgrep -f "$DEST/Contents/MacOS/Apex Deck" >/dev/null 2>&1; }
daemon_running() { /usr/bin/pgrep -f "$DEST/Contents/Resources/bin/apex-daemon" >/dev/null 2>&1; }

wait_gone() { # wait_gone <seconds> <fn>
  local deadline=$(( SECONDS + $1 ))
  while (( SECONDS < deadline )); do "$2" || return 0; sleep 0.5; done
  "$2" || return 0
  return 1
}

STATUS=0
fail() { bad "$*"; STATUS=1; }

# --- 1. Preflight -----------------------------------------------------------
step '1. Preflight'
[[ -d "$STAGE" ]] || { bad "staged build missing: $STAGE"; exit 1; }
for b in apex-daemon apex-provenance; do
  [[ -f "$STAGE/Contents/Resources/bin/$b" ]] || { bad "staged build has no $b"; exit 1; }
done
ok 'staged build ships apex-daemon and apex-provenance'

stage_daemon=$(cdhash "$STAGE/Contents/Resources/bin/apex-daemon")
stage_broker=$(cdhash "$STAGE/Contents/Resources/bin/apex-provenance")
stage_app=$(cdhash "$STAGE")
say "  staged  app=${stage_app:0:16}...  daemon=${stage_daemon:0:16}...  broker=${stage_broker:0:16}..."
[[ "$stage_daemon" == "$EXPECT_DAEMON" ]] || { bad "staged daemon ${stage_daemon:0:16}... != expected ${EXPECT_DAEMON:0:16}..."; exit 1; }
[[ "$stage_broker" == "$EXPECT_BROKER" ]] || { bad "staged broker ${stage_broker:0:16}... != expected ${EXPECT_BROKER:0:16}..."; exit 1; }
[[ "$stage_app" == "$EXPECT_APP" ]]       || { bad "staged app ${stage_app:0:16}... != expected ${EXPECT_APP:0:16}..."; exit 1; }
ok 'staged build matches the expected CDHashes'
if /usr/bin/codesign --verify --deep --strict "$STAGE" 2>/dev/null; then
  ok 'staged build signature verifies'
else
  bad 'staged build signature does not verify'; exit 1
fi

if [[ -d "$DEST" ]]; then
  cur_app=$(cdhash "$DEST"); cur_daemon=$(cdhash "$DEST/Contents/Resources/bin/apex-daemon")
  say "  installed app=${cur_app:0:16}...  daemon=${cur_daemon:0:16}..."
fi

# The ledgers are plain files; confirm they are present and record their sizes so
# the person can see nothing here is about to touch them.
LEDGERS="$HOME/Library/Application Support/dev.apexdeck.app"
for f in assistant-conversations-v1.json assistant-tasks-v1.json; do
  if [[ -f "$LEDGERS/$f" ]]; then
    say "  ledger: $(/usr/bin/stat -f '%z bytes  %Sm' "$LEDGERS/$f")  $f"
  else
    warn "ledger not found: $LEDGERS/$f (will start empty)"
  fi
done

if (( ! DRY )) && (( ! ASSUME_YES )); then
  say ''
  say "This will quit Apex Deck (ending any assistant chat running in it) and"
  say "replace $DEST with the staged build. Ledgers are not touched."
  (( REPIN )) && say 'It will also re-pin the provenance broker (--repin).'
  printf "Type 'install' to continue: "
  read -r reply
  [[ "$reply" == 'install' ]] || { echo 'Aborted.' >&2; exit 1; }
fi

# --- 2. Quit the app and its daemon ----------------------------------------
step '2. Quit app and user daemon'
if (( DRY )); then
  run /usr/bin/osascript -e 'quit app "Apex Deck"'
  run /usr/bin/pkill -TERM -f "$DEST/Contents/MacOS/Apex Deck"
  run /usr/bin/pkill -TERM -f "$DEST/Contents/Resources/bin/apex-daemon"
else
  if app_running; then
    /usr/bin/osascript -e 'quit app "Apex Deck"' >/dev/null 2>&1 || true
    if wait_gone 15 app_running; then
      ok 'app quit gracefully'
    else
      warn 'app did not quit; sending TERM'
      /usr/bin/pkill -TERM -f "$DEST/Contents/MacOS/Apex Deck" 2>/dev/null || true
      if ! wait_gone 10 app_running; then
        warn 'sending KILL'
        /usr/bin/pkill -KILL -f "$DEST/Contents/MacOS/Apex Deck" 2>/dev/null || true
      fi
      if wait_gone 5 app_running; then ok 'app stopped'; else bad 'app still running'; exit 1; fi
    fi
  else
    ok 'app was not running'
  fi
  if daemon_running; then
    /usr/bin/pkill -TERM -f "$DEST/Contents/Resources/bin/apex-daemon" 2>/dev/null || true
    if wait_gone 10 daemon_running; then
      ok 'user daemon stopped'
    else
      warn 'daemon did not stop; sending KILL'
      /usr/bin/pkill -KILL -f "$DEST/Contents/Resources/bin/apex-daemon" 2>/dev/null || true
      if wait_gone 5 daemon_running; then ok 'daemon stopped'; else bad 'daemon still running (owner.lock will block the new one)'; exit 1; fi
    fi
  else
    ok 'user daemon was not running'
  fi
fi

# --- 3. Preserve the replaced app ------------------------------------------
step '3. Preserve the replaced app'
if (( BACKUP )) && [[ -d "$DEST" ]]; then
  KEEP="$DEST.replaced-$(date +%Y%m%d-%H%M%S)"
  say "  keeping: $KEEP"
  run /usr/bin/ditto "$DEST" "$KEEP"
else
  say '  skipped'
fi

# --- 4. Install the staged build -------------------------------------------
step '4. Install the staged build'
if [[ ! -w /Applications ]]; then
  bad '/Applications is not writable by this user; run this step with sudo'
fi
run /bin/rm -rf "$DEST.new"
run /usr/bin/ditto "$STAGE" "$DEST.new"
run /bin/rm -rf "$DEST"
run /bin/mv "$DEST.new" "$DEST"

if (( ! DRY )); then
  got_daemon=$(cdhash "$DEST/Contents/Resources/bin/apex-daemon")
  got_broker=$(cdhash "$DEST/Contents/Resources/bin/apex-provenance")
  got_app=$(cdhash "$DEST")
  say "  installed app=${got_app:0:16}...  daemon=${got_daemon:0:16}...  broker=${got_broker:0:16}..."
  [[ "$got_daemon" == "$EXPECT_DAEMON" ]] && ok 'installed daemon matches' || fail 'installed daemon does not match the staged build'
  [[ "$got_broker" == "$EXPECT_BROKER" ]] && ok 'installed broker matches' || fail 'installed broker does not match the staged build'
  [[ "$got_app" == "$EXPECT_APP" ]]       && ok 'installed app matches'    || fail 'installed app does not match the staged build'
  if /usr/bin/codesign --verify --deep --strict "$DEST" 2>/dev/null; then
    ok 'installed signature verifies'
  else
    fail 'installed signature does not verify'
  fi
fi

# --- 5. Optional re-pin ----------------------------------------------------
step '5. Re-pin the provenance broker'
if (( REPIN )); then
  say '  sudo will ask for your Mac password'
  if (( DRY )); then
    run /usr/bin/sudo /bin/bash "$HERE/repin-provenance.sh" --yes
  else
    if /usr/bin/sudo /bin/bash "$HERE/repin-provenance.sh" --yes; then
      ok 're-pin reported success'
    else
      fail 're-pin failed (see the output above)'
    fi
  fi
else
  say '  skipped: the installed build may already match the existing pin'
  say '  (the running daemon was being denied, which proves the pin is not the'
  say '   stale build). Relaunch decides; use --repin to force a re-pin.'
fi

# --- 6. Relaunch and read the evidence -------------------------------------
# These globals are what step 7/8 report on.
DENIED=0; EMPTY=0; STOPS=0; BOUND=0

relaunch_and_observe() {
  local before=0 new
  [[ -f "$LOG" ]] && before=$(/usr/bin/wc -l < "$LOG" | /usr/bin/tr -d ' ')
  say "  launching $DEST (watching $LOG from line $((before+1)))"
  /usr/bin/open -a "$DEST" || { bad 'open failed'; return 1; }

  local n=0
  while (( n < 120 )); do app_running && break; sleep 0.5; n=$((n+1)); done
  if app_running; then ok 'app process is running'; else fail 'app did not start'; fi

  # Binding the socket is the step that used to hang behind "Connecting to This Mac".
  n=0; BOUND=0
  while (( n < 180 )); do
    if [[ -f "$LOG" ]] && /usr/bin/tail -n +"$((before+1))" "$LOG" 2>/dev/null | /usr/bin/grep -q 'listening on ws://'; then
      BOUND=1; break
    fi
    sleep 1; n=$((n+1))
  done
  if (( BOUND )); then ok 'daemon bound its socket (past the splash)'; else fail 'daemon never logged "listening on ws://" within 180s'; fi

  new=$(/usr/bin/tail -n +"$((before+1))" "$LOG" 2>/dev/null)
  DENIED=$(printf '%s' "$new" | /usr/bin/grep -c 'Protected ledgers require the pinned daemon')
  EMPTY=$(printf '%s' "$new" | /usr/bin/grep -c 'starting with empty ledgers')
  STOPS=$(printf '%s' "$new" | /usr/bin/grep -c 'apex-daemon: stopping')
  say "  pin denials: $DENIED   empty-ledger falls: $EMPTY   daemon stops: $STOPS"
  if (( DENIED == 0 && EMPTY == 0 )); then
    ok 'protected ledgers are readable by this build'
  else
    bad 'this build is still being denied its protected ledgers'
  fi
  if (( STOPS > 1 )); then fail "daemon restarted $STOPS times; restart loop is still present"; else ok 'no restart loop'; fi
  say ''
  say '  last lines:'
  printf '%s\n' "$new" | /usr/bin/tail -12 | /usr/bin/sed 's/^/    /'
}

step '6. Relaunch and verify'
if (( ! RELAUNCH )); then
  say '  skipped (--no-relaunch)'
elif (( DRY )); then
  run /usr/bin/open -a "$DEST"
  say '  would then watch the daemon log for "Protected ledgers require the pinned daemon"'
else
  relaunch_and_observe

  # Only now, with an observed denial, is a re-pin justified.
  if (( AUTO_REPIN )) && (( DENIED > 0 )); then
    step '6b. Denied after install — re-pinning'
    say '  This replaces the authority directory. It holds only pins, keys and'
    say '  the TrustedUI registration; there is no journal.json, so no ledger'
    say '  records are affected.'
    /usr/bin/osascript -e 'quit app "Apex Deck"' >/dev/null 2>&1 || true
    wait_gone 15 app_running || /usr/bin/pkill -KILL -f "$DEST/Contents/MacOS/Apex Deck" 2>/dev/null
    wait_gone 10 daemon_running || /usr/bin/pkill -KILL -f "$DEST/Contents/Resources/bin/apex-daemon" 2>/dev/null
    if /usr/bin/sudo /bin/bash "$HERE/repin-provenance.sh" --yes; then
      ok 're-pin reported success'
      STATUS=0
      DENIED=0; EMPTY=0; STOPS=0; BOUND=0
      relaunch_and_observe
    else
      fail 're-pin failed (see the output above)'
    fi
  fi
fi

# --- 7. Summary ------------------------------------------------------------
step 'Result'
if (( DRY )); then
  say 'DRY RUN: nothing was changed.'
  exit 0
fi
if (( STATUS != 0 )); then
  say 'NEEDS ATTENTION. Evidence above.'
  say "Daemon log: $LOG"
  if (( DENIED > 0 )) && (( ! REPIN )) && (( ! AUTO_REPIN )); then
    say ''
    say 'The build is installed but the broker still denies it. Re-pin, then'
    say 'relaunch:'
    say "  /bin/bash $HERE/finish-install.sh --yes --repin"
  fi
  exit 1
fi
say 'Installed build relaunched cleanly and can read its ledgers.'
say 'Open the app and confirm it reaches the workspace instead of the splash.'
