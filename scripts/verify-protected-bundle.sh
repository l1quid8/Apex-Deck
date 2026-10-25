#!/bin/bash
# Read-only validation of a packaged Apex Deck bundle before it is pinned.
#
# This is the check step of the authority-preserving upgrade
# (docs/handoff/2026-10-22/UPGRADE-PROCEDURE.md): the candidate bundle is
# validated while it is still staged under the protected root, and only then
# swapped into place and pinned. The checks are the ones
# scripts/install-provenance.sh applies during a first installation, so a
# staged copy can never be pinned more weakly than a fresh install would be.
#
# Usage:
#   /bin/bash scripts/verify-protected-bundle.sh '/path/to/Apex Deck.app' \
#       <expected-ui-cdhash> <expected-daemon-cdhash> [broker-binary expected-broker-cdhash]
#
# Exit 0: every check passed and both CDHashes matched. Exit 1: something is
# wrong, reported on the line above. It writes nothing and needs no root; it
# does not install, pin, start or stop anything.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

APP="${1:-}"
EXPECT_UI="$(/usr/bin/printf '%s' "${2:-}" | /usr/bin/tr 'A-Z' 'a-z')"
EXPECT_DAEMON="$(/usr/bin/printf '%s' "${3:-}" | /usr/bin/tr 'A-Z' 'a-z')"
BROKER="${4:-}"
EXPECT_BROKER="$(/usr/bin/printf '%s' "${5:-}" | /usr/bin/tr 'A-Z' 'a-z')"

case "${1:-}" in
  -h|--help) /usr/bin/sed -n '2,17p' "${BASH_SOURCE[0]}" | /usr/bin/cut -c3-; exit 0 ;;
esac
[[ $# == 3 || $# == 5 ]] || {
  echo 'FAIL expected app/UI/daemon hashes, optionally followed by broker path and its expected hash' >&2; exit 1; }

[[ -d "$APP" ]] || { echo "FAIL no bundle at: $APP" >&2; exit 1; }
[[ "$EXPECT_UI" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL expected UI CDHash must be 40 hex digits' >&2; exit 1; }
[[ "$EXPECT_DAEMON" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'FAIL expected daemon CDHash must be 40 hex digits' >&2; exit 1; }
if [[ $# == 5 ]]; then
  [[ -n "$BROKER" && "$EXPECT_BROKER" =~ ^[0-9a-f]{40}$ ]] || {
    echo 'FAIL expected broker path and a 40 hex digit broker CDHash' >&2; exit 1; }
fi

DAEMON="$APP/Contents/Resources/bin/apex-daemon"
[[ -f "$DAEMON" && ! -L "$DAEMON" ]] || { echo "FAIL no daemon in the bundle: $DAEMON" >&2; exit 1; }

# Electron fuses, application identity, ASAR integrity metadata and bundle
# symlink containment. Identical to the first-install check.
if ! /usr/bin/python3 -I - "$APP" <<'PY'
import os,sys,plistlib
root=os.path.realpath(sys.argv[1])
framework=os.path.join(root,'Contents/Frameworks/Electron Framework.framework/Electron Framework')
blob=open(framework,'rb').read(); sentinel=b'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
start=0; count=0
while True:
    at=blob.find(sentinel,start)
    if at<0: break
    at+=len(sentinel); count+=1
    if len(blob)<at+8 or blob[at]!=1 or blob[at+1]<6: raise SystemExit('FAIL unsupported Electron fuse wire')
    wire=blob[at+2:at+2+blob[at+1]]
    if any(wire[i]!=ord('0') for i in (0,2,3)) or any(wire[i]!=ord('1') for i in (4,5)):
        raise SystemExit('FAIL unsafe Electron fuses')
    start=at+2+blob[at+1]
if not count: raise SystemExit('FAIL Electron fuse wire absent')
with open(os.path.join(root,'Contents/Info.plist'),'rb') as f: info=plistlib.load(f)
if info.get('CFBundleIdentifier')!='dev.apexdeck.app' or not info.get('ElectronAsarIntegrity'):
    raise SystemExit('FAIL app identity or ASAR integrity metadata absent')
for base,dirs,files in os.walk(root,followlinks=False):
    for name in dirs+files:
        p=os.path.join(base,name)
        if os.path.islink(p) and os.path.commonpath([root,os.path.realpath(p)])!=root:
            raise SystemExit('FAIL a bundle symlink points outside the protected tree: '+p)
PY
then
  exit 1
fi

/usr/bin/codesign --verify --deep --strict -R='anchor apple generic' "$APP" 2>/dev/null || {
  echo 'FAIL the bundle does not pass a strict deep anchored signature check' >&2; exit 1; }
/usr/bin/codesign --verify --strict -R='anchor apple generic' "$DAEMON" 2>/dev/null || {
  echo 'FAIL the daemon does not pass a strict anchored signature check' >&2; exit 1; }

for image in "$APP" "$DAEMON"; do
  details=$(/usr/bin/codesign -d --verbose=4 "$image" 2>&1)
  [[ "$details" == *'(runtime)'* ]] || {
    echo "FAIL hardened runtime is absent from $image" >&2; exit 1; }
done

cdhash() {
  # No early exit in awk: quitting on the first match sends SIGPIPE to codesign,
  # which `pipefail` would then report as a failure of a check that passed.
  /usr/bin/codesign -d --verbose=4 "$1" 2>&1 \
    | /usr/bin/awk -F= '/^CDHash=/{hash=tolower($2)} END{print hash}'
}
actual_ui=$(cdhash "$APP")
actual_daemon=$(cdhash "$DAEMON")

status=0
if [[ "$actual_ui" == "$EXPECT_UI" ]]; then
  echo "OK   UI CDHash ${actual_ui}"
else
  echo "FAIL UI CDHash $actual_ui is not the selected candidate $EXPECT_UI" >&2
  status=1
fi
if [[ "$actual_daemon" == "$EXPECT_DAEMON" ]]; then
  echo "OK   daemon CDHash ${actual_daemon}"
else
  echo "FAIL daemon CDHash $actual_daemon is not the selected candidate $EXPECT_DAEMON" >&2
  status=1
fi

if [[ -n "$BROKER" ]]; then
  [[ -f "$BROKER" && ! -L "$BROKER" ]] || { echo "FAIL no broker binary at: $BROKER" >&2; exit 1; }
  /usr/bin/codesign --verify --strict -R='anchor apple generic' "$BROKER" 2>/dev/null || {
    echo 'FAIL the broker does not pass a strict anchored signature check' >&2; exit 1; }
  broker_details=$(/usr/bin/codesign -d --verbose=4 "$BROKER" 2>&1)
  [[ "$broker_details" == *'(runtime)'* ]] || {
    echo 'FAIL hardened runtime is absent from the broker' >&2; exit 1; }
  actual_broker=$(cdhash "$BROKER")
  if [[ "$actual_broker" == "$EXPECT_BROKER" ]]; then
    echo "OK   broker CDHash ${actual_broker}"
  else
    echo "FAIL broker CDHash $actual_broker is not the selected candidate $EXPECT_BROKER" >&2
    status=1
  fi
fi

version=$(/usr/bin/python3 -I - "$APP" <<'PY'
import os,plistlib,sys
try:
    with open(os.path.join(sys.argv[1],'Contents/Info.plist'),'rb') as f:
        print(plistlib.load(f).get('CFBundleShortVersionString') or 'unknown')
except Exception:
    print('unknown')
PY
)
echo "OK   version ${version} (reported only: a version string does not identify a build)"
exit "$status"
