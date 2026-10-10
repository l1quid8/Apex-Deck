#!/usr/bin/env bash
# Build apex-daemon for Linux from this checkout, install it on a VPS, restart
# its systemd unit, and verify that the running build is the commit you built.
#
# Usage: scripts/vps-deploy.sh <ssh-host> [--dry-run] [--allow-dirty]
#   --dry-run      print every command instead of running it. The only thing
#                  that still runs is `ssh -G`, a local config lookup.
#   --allow-dirty  deploy even with uncommitted changes to tracked files. The
#                  binary is then not the committed HEAD, so verification
#                  still compares against HEAD and will fail unless the build
#                  reports the same commit.
# Environment:
#   APEX_DAEMON_USER   remote user for the unit (default: the ssh config user)
#   APEX_DAEMON_UNIT   full unit name (default: apex-daemon@<user>)
#   APEX_LINUX_ARCH    amd64 (default) or arm64, passed to scripts/linux-build.sh
# Exits non-zero on any failed step or failed verification. It does not roll
# back automatically; the backup path and rollback command are printed.
set -euo pipefail

usage() { echo "usage: $0 <ssh-host> [--dry-run] [--allow-dirty]" >&2; exit 2; }

HOST=""
DRY_RUN=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $arg" >&2; usage ;;
    *) [[ -z "$HOST" ]] || usage; HOST="$arg" ;;
  esac
done
[[ -n "$HOST" ]] || usage

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${APEX_LINUX_ARCH:-amd64}"
case "$ARCH" in amd64|arm64) ;; *) echo "APEX_LINUX_ARCH must be amd64 or arm64" >&2; exit 2 ;; esac
BIN_LOCAL="$ROOT/target/linux-$ARCH/apex-daemon"
BIN_REMOTE="/usr/local/bin/apex-daemon"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP_REMOTE="/tmp/apex-daemon.$STAMP"
BACKUP_REMOTE="$BIN_REMOTE.bak-$STAMP"

# Remote user from ssh config. `ssh -G` only reads local config, no connection.
SSH_USER="${APEX_DAEMON_USER:-$(ssh -G "$HOST" 2>/dev/null | awk '$1 == "user" {print $2}')}"
UNIT="${APEX_DAEMON_UNIT:-apex-daemon@$SSH_USER}"

# Plain non-interactive ssh: ignore any RemoteCommand, forwards or shared
# connection the host's ssh config sets up for interactive use.
SSH_OPTS=(-o BatchMode=yes -o RemoteCommand=none -o ClearAllForwardings=yes -o ControlMaster=no -o ControlPath=none)

FAILS=0
fail() { echo "FAIL: $*" >&2; FAILS=$((FAILS + 1)); }

# Run a command, or print it in dry-run mode.
run() {
  echo "+ $*"
  (( DRY_RUN )) || "$@"
}

# Run a remote command over ssh (dry-run prints it).
remote() {
  if (( DRY_RUN )); then
    echo "+ ssh $HOST $(printf '%q ' "$@" | sed 's/ $//')"
  else
    echo "+ ssh $HOST $*"
    ssh "${SSH_OPTS[@]}" "$HOST" "$@"
  fi
}

# Capture remote output. Dry-run prints the command and returns nothing.
remote_out() {
  if (( DRY_RUN )); then
    echo "+ ssh $HOST $*" >&2
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "$HOST" "$@"
}

echo "Host: $HOST  user: ${SSH_USER:-unknown}  unit: $UNIT  arch: $ARCH"
(( DRY_RUN )) && echo "DRY RUN: nothing below is executed, except the local ssh -G lookup"

[[ -n "$SSH_USER" ]] || { echo "could not work out the remote user; set APEX_DAEMON_USER" >&2; exit 2; }

# Preflight: refuse a dirty tree (tracked files only, since the Linux build copies
# the tracked working tree, and untracked scratch folders are not part of it).
COMMIT="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
DIRTY="$(git -C "$ROOT" status --porcelain --untracked-files=no)"
echo "Local commit: $COMMIT"
if [[ -n "$DIRTY" ]]; then
  echo "Tracked files with uncommitted changes:"
  printf '  %s\n' "$DIRTY"
  if (( ! ALLOW_DIRTY )); then
    echo "REFUSED: working tree is dirty. Commit first, or pass --allow-dirty." >&2
    exit 1
  fi
  echo "WARNING: deploying with --allow-dirty; the binary is not exactly $COMMIT."
fi

echo "Step 1: build for Linux ($ARCH)"
run "$ROOT/scripts/linux-build.sh" "$ARCH"
if (( ! DRY_RUN )) && [[ ! -x "$BIN_LOCAL" ]]; then
  echo "build did not produce $BIN_LOCAL" >&2
  exit 1
fi

echo "Step 2: copy to $HOST:$TMP_REMOTE"
run scp "${SSH_OPTS[@]}" "$BIN_LOCAL" "$HOST:$TMP_REMOTE"

echo "Step 3: back up the current binary to $BACKUP_REMOTE"
remote sudo cp -p "$BIN_REMOTE" "$BACKUP_REMOTE"

echo "Step 4: install"
remote sudo install -m 0755 "$TMP_REMOTE" "$BIN_REMOTE"
remote rm -f "$TMP_REMOTE"

echo "Step 5: restart $UNIT"
RESTART_EPOCH=""
if (( ! DRY_RUN )); then
  RESTART_EPOCH="$(remote_out date +%s)"
fi
remote sudo systemctl restart "$UNIT"

echo "Step 6: verify"
if (( DRY_RUN )); then
  remote_out "$BIN_REMOTE" --version
  remote_out systemctl is-active "$UNIT"
  remote_out systemctl show -p MainPID --value "$UNIT"
  echo "(dry run: checks below are what a real run requires)"
  echo "  - remote --version output contains commit $COMMIT"
  echo "  - systemctl is-active $UNIT prints 'active'"
  echo "  - MainPID start time (ps -o lstart=) is at or after the restart time"
  echo "Dry run complete. Nothing was built, copied, installed or restarted."
  exit 0
fi

VERSION_OUT="$(remote_out "$BIN_REMOTE" --version 2>&1 || true)"
echo "  remote --version: ${VERSION_OUT:-<no output>}"
if ! printf '%s\n' "$VERSION_OUT" | grep -Eq "(^|[^0-9a-f])$COMMIT([^0-9a-f]|$)"; then
  fail "remote --version does not show commit $COMMIT (saw: ${VERSION_OUT:-nothing})"
fi

ACTIVE="$(remote_out systemctl is-active "$UNIT" || true)"
echo "  unit state: $ACTIVE"
[[ "$ACTIVE" == "active" ]] || fail "$UNIT is '$ACTIVE', not 'active'"

PID="$(remote_out systemctl show -p MainPID --value "$UNIT" || true)"
if [[ -z "$PID" || "$PID" == "0" ]]; then
  fail "$UNIT has no main PID"
else
  START_EPOCH="$(remote_out "date -d \"\$(ps -o lstart= -p $PID)\" +%s" 2>/dev/null || true)"
  echo "  main PID $PID started at epoch ${START_EPOCH:-unknown}; restart at epoch $RESTART_EPOCH"
  if [[ -z "$START_EPOCH" ]]; then
    fail "could not read the start time of PID $PID"
  elif (( START_EPOCH < RESTART_EPOCH )); then
    fail "PID $PID started before the restart, so the old process is still running"
  fi
fi

if (( FAILS > 0 )); then
  echo
  echo "VERIFICATION FAILED ($FAILS problem(s)). Nothing was rolled back."
  echo "Rollback: ssh $HOST 'sudo install -m 0755 $BACKUP_REMOTE $BIN_REMOTE && sudo systemctl restart $UNIT'"
  exit 1
fi
echo "Deployed $COMMIT to $HOST; $UNIT is active on PID $PID."
echo "Backup kept at $HOST:$BACKUP_REMOTE"
