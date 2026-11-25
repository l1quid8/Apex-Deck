#!/bin/bash
# @@PRODUCT@@ protected Linux installer. Run once by an administrator:
#
#   sudo ./apex-deck-install install --user NAME [--data-dir DIR]
#   sudo apex-deck-install status | repair | uninstall [--purge]
#
# Packaging (scripts/package-linux-installer.mjs) fills in the placeholders from
# desktop/channels.json. This script only orchestrates the broker's own root
# commands (initialize, stage, enroll, activate, recover); every signature,
# tree, scope and health check is done by apex-provenance, never here.
#
# Trust: on first install this script and the bundle are trusted the way a
# downloaded installer is. Verify the bundle's sha256 and signature against
# the published key first (docs/linux-nightly.md). After that, the installed
# broker's compiled-in publisher key checks every release it stages.
set -euo pipefail
umask 022
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C

readonly PRODUCT='@@PRODUCT@@'
readonly APP_ID='@@APP_ID@@'
readonly CHANNEL='@@CHANNEL@@'
readonly ARCH='@@ARCH@@'
readonly AUTHORITY='@@LINUX_ROOT@@'
readonly RUNTIME='@@LINUX_RUNTIME@@'
readonly TREES='@@LINUX_TREE@@'
readonly SERVICE='@@LINUX_SERVICE@@'
readonly DAEMON_UNIT='@@LINUX_DAEMON_UNIT@@'
readonly SLUG="${TREES##*/}"
readonly STATE="/var/lib/${SLUG}-installer"
readonly LAUNCHER="/usr/local/bin/${SLUG}"
readonly INSTALLER="/usr/local/sbin/${SLUG}-install"
readonly DESKTOP="/usr/local/share/applications/${APP_ID}.desktop"
readonly ICONS=/usr/local/share/icons/hicolor
readonly APPARMOR="/etc/apparmor.d/${SLUG}"
readonly SYSTEMD=/etc/systemd/system

say() { printf '%s\n' "$*"; }
die() { printf '%s-install: %s\n' "$SLUG" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage:
  sudo $0 install --user NAME [--data-dir DIR]
  sudo $0 status
  sudo $0 repair
  sudo $0 uninstall [--purge]
EOF
  exit 2
}

bundle_dir() { cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P; }

require_host() {
  [[ $EUID -eq 0 ]] || die "run as root (sudo)."
  [[ "$(cat /proc/1/comm 2>/dev/null)" == systemd ]] || die "systemd must be PID 1; protected services need systemd and logind."
  command -v loginctl >/dev/null || die "logind (loginctl) is required."
  local machine; machine=$(uname -m)
  case "$machine:$ARCH" in
    x86_64:x64 | aarch64:arm64) ;;
    *) die "this bundle is for $ARCH; this machine is $machine." ;;
  esac
  # Kernel peer identity uses SO_PEERPIDFD (Linux 6.5). Older kernels fail closed.
  local major minor
  IFS=. read -r major minor _ <<<"$(uname -r)"
  if (( major < 6 || (major == 6 && ${minor%%[!0-9]*} < 5) )); then
    die "Linux 6.5 or newer is required (found $(uname -r))."
  fi
  # The broker refuses any group/world-writable or non-root ancestor.
  local dir
  for dir in /opt /var/lib /etc/systemd/system; do
    [[ -d $dir ]] || continue
    [[ "$(stat -c %u "$dir")" == 0 && $(( 8#$(stat -c %a "$dir") & 8#022 )) == 0 ]] ||
      die "$dir must be owned by root and not group/world-writable (protected install rule)."
  done
}

# The tree the broker currently runs: the broker unit's ExecStart path.
active_tree() {
  local unit="$SYSTEMD/$SERVICE" line
  [[ -f $unit ]] || return 1
  line=$(grep -m1 '^ExecStart=' "$unit") || return 1
  line=${line#*\"}; line=${line%%\"*}
  [[ $line == "$TREES"/*/resources/bin/apex-provenance ]] || return 1
  printf '%s\n' "${line%/resources/bin/apex-provenance}"
}

broker() { "$1/resources/bin/apex-provenance" "${@:2}"; }

# Fresh root-only directory for copied inputs; the broker requires root
# ownership with no writable ancestors for every file it verifies.
work_dir() {
  install -d -m 0755 "$STATE"
  mktemp -d "$STATE/incoming.XXXXXX"
}

copy_release() { # bundle-dir -> work-dir
  local name
  for name in manifest.json manifest.sig payload.tar; do
    [[ -f "$1/release/$name" && ! -L "$1/release/$name" ]] || die "bundle is missing release/$name."
    install -m 0644 "$1/release/$name" "$2/$name"
  done
}

# Extract only the broker from the payload into the work dir. The broker then
# verifies the whole payload, itself included, against its compiled-in key.
bootstrap_broker() { # work-dir
  local out="$1/bootstrap"
  mkdir -m 0755 "$out"
  tar -xf "$1/payload.tar" -C "$out" --no-same-owner --no-same-permissions \
    resources/bin/apex-provenance
  chmod 0755 "$out/resources" "$out/resources/bin" "$out/resources/bin/apex-provenance"
  broker "$out" verify-linux-release "$1/manifest.json" "$1/manifest.sig" "$1/payload.tar" >&2
  printf '%s\n' "$out"
}

stage() { # broker-tree work-dir -> staged tree
  local line
  line=$(broker "$1" stage-linux-release "$2/manifest.json" "$2/manifest.sig" "$2/payload.tar")
  line=${line##*: }
  [[ $line == "$TREES"/staging-* && -d $line ]] || die "unexpected staging result: $line"
  printf '%s\n' "$line"
}

user_home() { getent passwd "$1" | cut -d: -f6; }

default_data_dir() { printf '%s/.local/share/%s\n' "$(user_home "$1")" "$APP_ID"; }

# Two-sided enrollment: the broker listens on the administrator's terminal and
# prints the exact confirmation to type; the desktop account sends its scope.
enroll() { # tree user data-dir
  local tree=$1 user=$2 data=$3 requester status=0
  [[ -t 0 ]] || die "enrollment needs an interactive administrator terminal."
  runuser -u "$user" -- mkdir -p -m 0700 -- "$data" "$data/saved-chats-v1"
  (
    for _ in $(seq 1 100); do [[ -S "${RUNTIME}/enroll.sock" ]] && break; sleep 0.1; done
    exec runuser -u "$user" -- env -i PATH=/usr/bin:/bin HOME="$(user_home "$user")" \
      "$tree/resources/bin/apex-provenance" request-linux-enrollment "$data"
  ) &
  requester=$!
  broker "$tree" enroll-linux || status=$?
  wait "$requester" || status=1
  (( status == 0 )) || die "enrollment was not saved; nothing was activated. Run install again after uninstall."
}

activate() { # tree work-dir
  broker "$1" activate-linux-release "$1" "$2/manifest.json" "$2/manifest.sig" "$2/payload.tar"
}

install_launcher() { # tree
  local tree=$1 assets="$1/resources/linux" icon size
  install -d -m 0755 /usr/local/bin /usr/local/sbin "$(dirname "$DESKTOP")"
  # The launcher starts the installed UI; it finds the broker, hands off, and
  # the broker launches the supervised window. It grants nothing by itself.
  printf '#!/bin/sh\nexec %q "$@"\n' "$tree/apex-deck" >"$LAUNCHER.new"
  chmod 0755 "$LAUNCHER.new"; mv -f "$LAUNCHER.new" "$LAUNCHER"
  install -m 0755 "$assets/apex-deck-install" "$INSTALLER"
  install -m 0644 "$assets/$APP_ID.desktop" "$DESKTOP"
  for icon in "$assets"/icons/*.png; do
    size=$(basename "$icon" .png)
    install -D -m 0644 "$icon" "$ICONS/$size/apps/$APP_ID.png"
  done
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$(dirname "$DESKTOP")" || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t -f "$ICONS" || true
}

# Ubuntu 23.10+ blocks unprivileged user namespaces unless a profile allows
# them; Chromium's sandbox needs them. Grant only that, only to the app binary.
install_apparmor() {
  [[ -d /etc/apparmor.d && -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] || return 0
  cat >"$APPARMOR" <<EOF
abi <abi/4.0>,
include <tunables/global>

profile $SLUG $TREES/staging-*/apex-deck flags=(unconfined) {
  userns,
  include if exists <local/$SLUG>
}
EOF
  chmod 0644 "$APPARMOR"
  apparmor_parser -r "$APPARMOR"
}

cmd_install() {
  local user='' data=''
  while (( $# )); do
    case $1 in
      --user) user=${2:?}; shift 2 ;;
      --data-dir) data=${2:?}; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n $user ]] || usage
  require_host
  local uid; uid=$(id -u "$user" 2>/dev/null) || die "no such user: $user"
  (( uid != 0 )) || die "enroll an ordinary desktop account, not root."
  [[ -n $data ]] || data=$(default_data_dir "$user")
  [[ $data == /* ]] || die "--data-dir must be absolute."
  # Like the macOS installer: never overwrite or adopt existing authority.
  local existing
  for existing in "$AUTHORITY" "$TREES" "$SYSTEMD/$SERVICE" "$SYSTEMD/$DAEMON_UNIT" "$STATE"; do
    [[ ! -e $existing ]] || die "Existing authority found at $existing. Use '$INSTALLER repair', or uninstall first."
  done
  local bundle boot tree
  bundle=$(bundle_dir)
  WORK=$(work_dir)
  trap 'rm -rf -- "$WORK"' EXIT
  local work=$WORK
  copy_release "$bundle" "$work"
  boot=$(bootstrap_broker "$work")
  say "Verified $PRODUCT payload."
  broker "$boot" initialize-linux-authority
  tree=$(stage "$boot" "$work")
  say "Staged $tree"
  install_apparmor
  enroll "$tree" "$user" "$data"
  activate "$tree" "$work"
  printf 'USER=%q\nDATA_DIR=%q\n' "$user" "$data" >"$STATE/install.env"
  install_launcher "$tree"
  say "$PRODUCT is installed for $user. Open it from Applications, or run $LAUNCHER as $user."
}

cmd_status() {
  [[ $EUID -eq 0 ]] || die "run as root (sudo)."
  local tree
  tree=$(active_tree) || { say "$PRODUCT is not installed."; return 1; }
  say "$PRODUCT ($CHANNEL, $ARCH) active release: $tree"
  [[ -f $STATE/install.env ]] && sed 's/^/  /' "$STATE/install.env"
  systemctl --no-pager --lines=0 status "$SERVICE" || true
}

cmd_repair() {
  require_host
  local tree sha meta
  tree=$(active_tree) || die "no installed release to repair."
  # The broker kept the verified inputs of every activated release.
  for meta in "$AUTHORITY"/releases/*/; do
    [[ -f "$meta/manifest.json" ]] || continue
    sha=$(sha256sum "$meta/manifest.json" | cut -d' ' -f1)
    if broker "$tree" verify-linux-release "$meta/manifest.json" "$meta/manifest.sig" "$meta/payload.tar" >/dev/null 2>&1 &&
       [[ $tree == *-"${sha:0:16}" ]]; then
      install_apparmor
      broker "$tree" recover-linux-release "$tree" "$meta/manifest.json" "$meta/manifest.sig" "$meta/payload.tar"
      install_launcher "$tree"
      say "Repaired $PRODUCT at $tree."
      return 0
    fi
  done
  die "could not find the verified release inputs for $tree."
}

cmd_uninstall() {
  local purge=0
  [[ ${1:-} == --purge ]] && purge=1
  [[ $EUID -eq 0 ]] || die "run as root (sudo)."
  local unit
  for unit in $(systemctl list-units --all --plain --no-legend "${DAEMON_UNIT%@.service}@*.service" | awk '{print $1}'); do
    systemctl stop "$unit" || true
  done
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f -- "$SYSTEMD/$SERVICE" "$SYSTEMD/$DAEMON_UNIT"
  rm -rf -- "$SYSTEMD/${DAEMON_UNIT%@.service}"@*.service.d
  find "$SYSTEMD" -maxdepth 2 -path "$SYSTEMD/user@*.service.wants/${DAEMON_UNIT%@.service}@*" -type l -delete
  systemctl daemon-reload
  rm -f -- "$LAUNCHER" "$INSTALLER" "$DESKTOP" "$ICONS"/*/apps/"$APP_ID.png"
  if [[ -f $APPARMOR ]]; then
    apparmor_parser -R "$APPARMOR" 2>/dev/null || true
    rm -f -- "$APPARMOR"
  fi
  rm -rf -- "$TREES" "$RUNTIME"
  if (( purge )); then
    [[ -t 0 ]] || die "--purge needs an interactive terminal."
    say "Purging deletes the protected authority key and journal. The enrolled data folder"
    say "stays on disk but its protected history can no longer be verified."
    local answer
    read -r -p "Type PURGE $SLUG to continue: " answer
    [[ $answer == "PURGE $SLUG" ]] || die "confirmation did not match; authority kept at $AUTHORITY."
    rm -rf -- "$AUTHORITY" "$STATE"
    say "$PRODUCT and its authority were removed."
  else
    rm -rf -- "$STATE"
    say "$PRODUCT was removed. Authority was kept at $AUTHORITY; the enrolled data folder"
    say "stays locked to the protected engine. Reinstall needs 'uninstall --purge' first."
  fi
}

case ${1:-} in
  install) shift; cmd_install "$@" ;;
  status) cmd_status ;;
  repair) cmd_repair ;;
  uninstall) shift; cmd_uninstall "$@" ;;
  *) usage ;;
esac
