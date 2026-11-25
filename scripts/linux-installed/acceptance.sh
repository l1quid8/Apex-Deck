#!/bin/bash
# Installed-mode acceptance for the protected Linux bundle. Disposable machines
# only (CI runner or throwaway VM): it creates a test account, installs the
# protected service, drives the real UI and uninstalls again.
#
#   sudo scripts/linux-installed/acceptance.sh BUNDLE.linux-installer.tar EVIDENCE_DIR
#
# Covers: install, administrator enrollment ceremony, launcher assets, launch
# through the broker, Allow once / Deny on a fixture request, broker restart,
# relaunch and a fresh approval, then uninstall keeping authority and refusing
# to reinstall over it.
set -euo pipefail
export LANG=C LC_ALL=C
[[ $EUID -eq 0 ]] || { echo "run as root on a disposable machine" >&2; exit 1; }
[[ ${CI:-} == true || ${APEX_ACCEPTANCE_DISPOSABLE:-} == 1 ]] || {
  echo "refusing: set APEX_ACCEPTANCE_DISPOSABLE=1 on a throwaway VM" >&2; exit 1; }

BUNDLE=$(realpath "$1"); EVIDENCE=$(realpath -m "$2")
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SLUG=apex-deck-nightly
SERVICE=$SLUG-provenance.service
TESTER=${APEX_ACCEPTANCE_USER:-apextest}
DISPLAY_NUM=:99
mkdir -p "$EVIDENCE"
step() { printf '\n=== %s\n' "$*"; }
fail() { echo "ACCEPTANCE FAILED: $*" >&2; exit 1; }

collect() {
  set +e
  journalctl --no-pager -b -u "$SERVICE" -u "$SLUG-daemon@*" >"$EVIDENCE/journal.txt" 2>&1
  systemctl --no-pager status "$SERVICE" "$SLUG-daemon@*" >"$EVIDENCE/units.txt" 2>&1
  # shellcheck disable=SC2024 # root writes the evidence file
  [[ -n ${UID_T:-} ]] && sudo -u "$TESTER" DISPLAY=$DISPLAY_NUM xwd -root -silent 2>/dev/null >"$EVIDENCE/screen.xwd"
  local data="$(getent passwd "$TESTER" | cut -d: -f6)/.local/share/dev.apexdeck.app.nightly"
  stat -c '%U:%G %a %n' "$data" "$data/saved-chats-v1" >"$EVIDENCE/scope-modes.txt" 2>&1
  cp /tmp/apex-acceptance-*.log "$EVIDENCE/" 2>/dev/null
  chmod -R a+rX "$EVIDENCE"
}
trap collect EXIT

step "Prepare a desktop account and its user manager (as a login would)"
id "$TESTER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$TESTER"
UID_T=$(id -u "$TESTER")
systemctl start "user@$UID_T.service"
export XDG_RUNTIME_DIR=/run/user/$UID_T
as_user() {
  sudo -u "$TESTER" env -i PATH=/usr/bin:/bin HOME="$(getent passwd "$TESTER" | cut -d: -f6)" \
    DISPLAY=$DISPLAY_NUM XDG_SESSION_TYPE=x11 XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus" "$@"
}

step "Unpack the bundle as an administrator would"
WORK=$(mktemp -d /root/apex-bundle.XXXXXX)
tar -xf "$BUNDLE" -C "$WORK"
INSTALL=$(echo "$WORK"/*/apex-deck-install)
[[ -x $INSTALL ]] || fail "bundle has no apex-deck-install"

step "Install, answering the administrator ceremony on a real terminal"
expect -f - "$INSTALL" "$TESTER" "$UID_T" <<'EOF' | tee /tmp/apex-acceptance-install.log
set timeout 240
lassign $argv installer user uid
spawn $installer install --user $user
expect {
  -re {Type exactly: (ENROLL [0-9]+ ACCEPT SAME-ACCOUNT LIMIT (NO|ALLOW) LINGER)\r} {
    set answer $expect_out(1,string)
    if {![string match "ENROLL $uid *" $answer]} { puts "wrong UID in ceremony"; exit 3 }
    send -- "$answer\r"
  }
  timeout { puts "no ceremony prompt"; exit 2 }
  eof { puts "installer ended before ceremony"; exit 2 }
}
expect {
  -re {is installed for} {}
  timeout { exit 4 }
  eof { exit 4 }
}
lassign [wait] pid spawnid os_error value
exit $value
EOF
[[ ${PIPESTATUS[0]} -eq 0 ]] || fail "install did not complete"

step "Check services, launcher assets and refusal to install over authority"
systemctl is-active --quiet "$SERVICE" || fail "broker is not active"
systemctl is-active --quiet "$SLUG-daemon@$UID_T.service" || fail "desktop engine is not active"
test -x /usr/local/bin/$SLUG && test -x /usr/local/sbin/$SLUG-install
desktop-file-validate /usr/local/share/applications/dev.apexdeck.app.nightly.desktop
ls /usr/local/share/icons/hicolor/*/apps/dev.apexdeck.app.nightly.png >/dev/null
if "$INSTALL" install --user "$TESTER" </dev/null >/tmp/apex-acceptance-reinstall.log 2>&1; then
  fail "second install did not refuse existing authority"
fi
grep -q 'Existing authority found' /tmp/apex-acceptance-reinstall.log || fail "wrong refusal text"

step "Start a display and accessibility for the desktop account"
as_user Xvfb $DISPLAY_NUM -screen 0 1440x900x24 -nolisten tcp >/tmp/apex-acceptance-xvfb.log 2>&1 &
for _ in $(seq 50); do as_user xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
as_user openbox >/tmp/apex-acceptance-openbox.log 2>&1 &
as_user busctl --user set-property org.a11y.Bus /org/a11y/bus org.a11y.Status IsEnabled b true
DRIVER=/usr/local/libexec/apex-installed-test/ui-driver.py
install -D -m 0755 "$HERE/ui-driver.py" "$DRIVER"

broker_pid() { systemctl show -p MainPID --value "$SERVICE"; }
launch_ui() {
  as_user /usr/local/bin/$SLUG >>/tmp/apex-acceptance-launcher.log 2>&1 || true
  as_user "$DRIVER" wait-window --timeout 120 || fail "UI window did not appear"
  # The window must belong to the broker's supervised launch, not the launcher.
  local window pid parent
  window=$(as_user xdotool search --onlyvisible --name '^Apex Deck Nightly$' | head -1)
  pid=$(as_user xdotool getwindowpid "$window")
  parent=$(ps -o ppid= -p "$pid" | tr -d ' ')
  [[ $parent == "$(broker_pid)" ]] || fail "UI pid $pid has parent $parent, not the broker $(broker_pid)"
  [[ "$(stat -c %U /proc/$pid)" == "$TESTER" ]] || fail "UI is not running as $TESTER"
}

MARKERS=$(as_user mktemp -d /tmp/apex-markers.XXXXXX)

step "Launch through the broker; Allow once runs the request, Deny does not"
launch_ui
as_user "$DRIVER" approve --marker "$MARKERS/allowed-1"
as_user "$DRIVER" deny --marker "$MARKERS/denied-1"
[[ -f $MARKERS/allowed-1 ]] || fail "Allow once did not run the request"
[[ ! -e $MARKERS/denied-1 ]] || fail "Deny still ran the request"

step "Restart the broker: the supervised UI and engine are replaced, authority kept"
KEY_BEFORE=$(sha256sum /var/lib/$SLUG-provenance/public-key)
OLD_UI=$(pgrep -u "$TESTER" -f "/opt/$SLUG/.*/apex-deck" | head -1 || true)
systemctl restart "$SERVICE"
systemctl start "$SLUG-daemon@$UID_T.service"
for _ in $(seq 100); do [[ -z $OLD_UI ]] || ! kill -0 "$OLD_UI" 2>/dev/null && break; sleep 0.2; done
[[ -z $OLD_UI ]] || ! kill -0 "$OLD_UI" 2>/dev/null || fail "old UI survived broker restart"
[[ "$(sha256sum /var/lib/$SLUG-provenance/public-key)" == "$KEY_BEFORE" ]] || fail "authority key changed"
launch_ui
as_user "$DRIVER" approve --marker "$MARKERS/allowed-2"
[[ -f $MARKERS/allowed-2 ]] || fail "approval after restart did not run"
[[ ! -e $MARKERS/denied-1 ]] || fail "denied request ran after restart"

step "Uninstall keeps authority and the launcher is gone"
pkill -u "$TESTER" -f "/opt/$SLUG/" || true
/usr/local/sbin/$SLUG-install uninstall </dev/null
! systemctl is-active --quiet "$SERVICE" || fail "broker still active after uninstall"
[[ ! -e /usr/local/bin/$SLUG && ! -e /opt/$SLUG ]] || fail "uninstall left the tree or launcher"
[[ -f /var/lib/$SLUG-provenance/public-key ]] || fail "uninstall removed authority without --purge"
if "$INSTALL" install --user "$TESTER" </dev/null >/tmp/apex-acceptance-reinstall-2.log 2>&1; then
  fail "install over kept authority was not refused"
fi

step "Installed-mode acceptance passed"
