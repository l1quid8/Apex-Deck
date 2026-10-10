#!/usr/bin/env bash
# Read-only check that the Mac's installed Apex Deck is the build you think it
# is, and that the apex-daemon running now is the one inside it.
#
# Checks: installed app version and signature, sha256 of the bundled UI
# (app.asar) and daemon, a freshly built app (hashes compared with the
# installed one), and every running apex-daemon (start time, executable path,
# hash, and whether it runs from the installed app).
#
# Usage: scripts/verify-install.sh [path/to/Apex Deck.app]
#   Default fresh build: release/mac-arm64/Apex Deck.app under the repo.
#   An explicit path that does not exist is an error; the default is optional.
# Exits 1 on any mismatch or failed check. It installs, restarts and kills nothing.
set -euo pipefail

APP="/Applications/Apex Deck.app"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRESH_ARG="${1:-}"
if [[ -z "$FRESH_ARG" ]]; then
  FRESH="$ROOT/release/mac-arm64/Apex Deck.app"
  FRESH_REQUIRED=0
else
  FRESH="$FRESH_ARG"
  [[ "$FRESH" = /* ]] || FRESH="$PWD/$FRESH"
  FRESH_REQUIRED=1
fi

ROWS=()
FAILS=0
WARNS=0
row() { ROWS+=("$1|$2|$3"); }   # label | value | status
bad() { FAILS=$((FAILS + 1)); }
warn() { WARNS=$((WARNS + 1)); }

sha() { shasum -a 256 "$1" | awk '{print $1}'; }

plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null || echo "unknown"; }

# First line of `<binary> --version`, or "not reported" when the binary lacks the flag.
# Bounded to 5 seconds so a hung binary cannot stall the check.
bin_version() {
  local out=""
  if [[ -x "$1" ]]; then
    out=$(perl -e 'alarm 5; exec @ARGV' "$1" --version </dev/null 2>/dev/null | awk 'NR==1' || true)
  fi
  echo "${out:-not reported}"
}

INST_BIN="$APP/Contents/Resources/bin/apex-daemon"
INST_UI="$APP/Contents/Resources/app.asar"

echo "Installed app: $APP"
if [[ ! -d "$APP" ]]; then
  row "installed app" "missing" "FAIL"; bad
  INST_SHA_BIN=""; INST_SHA_UI=""
else
  row "installed version" "$(plist "$APP" CFBundleShortVersionString) ($(plist "$APP" CFBundleVersion))" "info"
  if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
    row "codesign verify" "passes" "OK"
  else
    row "codesign verify" "FAILED" "FAIL"; bad
  fi
  if [[ -f "$INST_UI" ]]; then
    INST_SHA_UI=$(sha "$INST_UI")
    row "installed UI app.asar sha256" "${INST_SHA_UI:0:16}..." "info"
  else
    INST_SHA_UI=""; row "installed UI app.asar" "missing" "FAIL"; bad
  fi
  if [[ -f "$INST_BIN" ]]; then
    INST_SHA_BIN=$(sha "$INST_BIN")
    row "installed daemon sha256" "${INST_SHA_BIN:0:16}..." "info"
    row "installed daemon --version" "$(bin_version "$INST_BIN")" "info"
  else
    INST_SHA_BIN=""; row "installed daemon" "missing" "FAIL"; bad
  fi
fi

echo "Fresh build: $FRESH"
if [[ -d "$FRESH" ]]; then
  FRESH_BIN="$FRESH/Contents/Resources/bin/apex-daemon"
  FRESH_UI="$FRESH/Contents/Resources/app.asar"
  row "fresh version" "$(plist "$FRESH" CFBundleShortVersionString) ($(plist "$FRESH" CFBundleVersion))" "info"
  if [[ -f "$FRESH_UI" && -n "${INST_SHA_UI:-}" ]]; then
    if [[ "$(sha "$FRESH_UI")" == "$INST_SHA_UI" ]]; then
      row "UI payload vs installed" "MATCH" "OK"
    else
      row "UI payload vs installed" "MISMATCH" "FAIL"; bad
    fi
  else
    row "UI payload vs installed" "cannot compare" "FAIL"; bad
  fi
  if [[ -f "$FRESH_BIN" && -n "${INST_SHA_BIN:-}" ]]; then
    if [[ "$(sha "$FRESH_BIN")" == "$INST_SHA_BIN" ]]; then
      row "daemon vs installed" "MATCH" "OK"
    else
      row "daemon vs installed" "MISMATCH" "FAIL"; bad
    fi
    row "fresh daemon --version" "$(bin_version "$FRESH_BIN")" "info"
  else
    row "daemon vs installed" "cannot compare" "FAIL"; bad
  fi
elif [[ "$FRESH_REQUIRED" == 1 ]]; then
  row "fresh build" "not found: $FRESH" "FAIL"; bad
else
  row "fresh build" "not built here (skipped)" "warn"; warn
fi

echo "Running apex-daemon processes"
# pgrep misses the app's daemon here (its args are not visible to it), and
# pgrep -x sees only a truncated name. ps sees the full command line, so match
# that, then keep only processes whose executable is apex-daemon (see below).
# Only the shared service counts: `serve` without `--data-dir`. Test daemons
# and dev builds use their own data folder and don't serve the installed app.
CANDIDATES=$(ps -axo pid=,args= | grep -E '/apex-daemon serve( |$)' | grep -v -e grep -e '--data-dir' | awk '{print $1}' || true)
PIDS=""
for pid in $CANDIDATES; do
  exe=$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | awk 'NR==1 && /^n/ {print substr($0, 2)}' || true)
  [[ -n "$exe" ]] || exe=$(ps -o comm= -p "$pid" | sed 's/^ *//' || true)
  case "$exe" in
    */apex-daemon|*/apex-daemon" (deleted)") PIDS="$PIDS $pid" ;;
  esac
done
if [[ -z "${PIDS// /}" ]]; then
  row "running daemon" "none running" "warn"; warn
fi
for pid in $PIDS; do
  start=$(ps -o lstart= -p "$pid" | sed 's/^ *//' || true)
  exe=$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | awk 'NR==1 && /^n/ {print substr($0, 2)}' || true)
  [[ -n "$exe" ]] || exe=$(ps -o comm= -p "$pid" | sed 's/^ *//' || true)
  row "PID $pid started" "${start:-unknown}" "info"
  row "PID $pid executable" "${exe:-unknown}" "info"
  if [[ "$exe" == *" (deleted)" ]]; then
    row "PID $pid binary" "file was replaced or deleted after start" "FAIL"; bad
  elif [[ "$exe" != "$APP/"* ]]; then
    row "PID $pid location" "NOT inside $APP" "FAIL"; bad
  else
    row "PID $pid location" "inside installed app" "OK"
  fi
  if [[ -f "$exe" ]]; then
    run_sha=$(sha "$exe")
    if [[ -n "${INST_SHA_BIN:-}" && "$run_sha" == "$INST_SHA_BIN" ]]; then
      row "PID $pid sha256 vs installed" "MATCH" "OK"
    else
      row "PID $pid sha256 vs installed" "MISMATCH" "FAIL"; bad
    fi
    row "PID $pid --version" "$(bin_version "$exe")" "info"
  else
    row "PID $pid sha256 vs installed" "binary not readable" "FAIL"; bad
  fi
done

echo
printf '%-34s %-46s %s\n' "CHECK" "VALUE" "RESULT"
printf '%-34s %-46s %s\n' "-----" "-----" "------"
for r in ${ROWS[@]+"${ROWS[@]}"}; do
  IFS='|' read -r label value status <<<"$r"
  printf '%-34s %-46s %s\n' "$label" "$value" "$status"
done
echo
if (( FAILS > 0 )); then
  echo "RESULT: $FAILS mismatch or failed check(s), $WARNS warning(s). Not verified."
  exit 1
fi
echo "RESULT: all checks passed ($WARNS warning(s))."
