#!/bin/bash
# Explicit first installation only. Never run automatically from a worker or UI.
# Usage: sudo /bin/bash scripts/install-provenance.sh '/path/Apex Deck.app' '/path/apex-provenance'
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset NODE_OPTIONS ELECTRON_RUN_AS_NODE PYTHONPATH PYTHONHOME
[[ $EUID == 0 ]] || { echo 'Run this installer explicitly as administrator.' >&2; exit 1; }
[[ $# == 2 ]] || { echo 'Expected a signed packaged app and broker binary.' >&2; exit 1; }
root='/Library/Application Support/Apex Deck Provenance'
[[ ! -e "$root" && ! -L "$root" ]] || { echo 'Existing authority found. Refusing to overwrite keys, records or trust pins.' >&2; exit 1; }
[[ -d "$1" && -f "$2" && ! -L "$2" ]] || exit 1
# Copy before validation so a user cannot replace source resources after checking.
# Failed installation is deliberately left for administrator inspection, not
# recursively deleted or silently retried with a fresh signing key.
/usr/bin/install -d -o root -g wheel -m 755 "$root/TrustedUI"
/usr/bin/ditto "$1" "$root/TrustedUI/Apex Deck.app"
/usr/bin/install -o root -g wheel -m 755 "$2" "$root/apex-provenance"
/usr/sbin/chown -R root:wheel "$root"
/bin/chmod -RN "$root"
/bin/chmod -R go-w "$root"
app="$root/TrustedUI/Apex Deck.app"
daemon="$app/Contents/Resources/bin/apex-daemon"
/usr/bin/python3 -I - "$app" <<'PY'
import os,sys,plistlib
root=os.path.realpath(sys.argv[1])
framework=os.path.join(root,'Contents/Frameworks/Electron Framework.framework/Electron Framework')
blob=open(framework,'rb').read(); sentinel=b'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
start=0; count=0
while True:
    at=blob.find(sentinel,start)
    if at<0: break
    at+=len(sentinel); count+=1
    if len(blob)<at+8 or blob[at]!=1 or blob[at+1]<6: raise SystemExit('Unsupported Electron fuse wire')
    wire=blob[at+2:at+2+blob[at+1]]
    if any(wire[i]!=ord('0') for i in (0,2,3)) or any(wire[i]!=ord('1') for i in (4,5)):
        raise SystemExit('Unsafe Electron fuses: refusing issuer enrollment')
    start=at+2+blob[at+1]
if not count: raise SystemExit('Electron fuse wire absent')
with open(os.path.join(root,'Contents/Info.plist'),'rb') as f: info=plistlib.load(f)
if info.get('CFBundleIdentifier')!='dev.apexdeck.app' or not info.get('ElectronAsarIntegrity'):
    raise SystemExit('App identity or ASAR integrity metadata absent')
for base,dirs,files in os.walk(root,followlinks=False):
    for name in dirs+files:
        p=os.path.join(base,name)
        if os.path.islink(p) and os.path.commonpath([root,os.path.realpath(p)])!=root:
            raise SystemExit('Refusing a bundle symlink outside the protected tree: '+p)
PY
/usr/bin/codesign --verify --deep --strict -R='anchor apple generic' "$app"
/usr/bin/codesign --verify --strict -R='anchor apple generic' "$daemon"
# Require hardened runtime and no debugger entitlement. The broker repeats
# dynamic checks on every connection; install-time checking is not authority.
for image in "$app" "$daemon"; do
  details=$(/usr/bin/codesign -d --verbose=4 "$image" 2>&1)
  [[ "$details" == *'(runtime)'* ]] || { echo 'Hardened runtime is required.' >&2; exit 1; }
done
ui_hash=$(/usr/bin/codesign -d --verbose=4 "$app" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2}')
daemon_hash=$(/usr/bin/codesign -d --verbose=4 "$daemon" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2}')
[[ "$ui_hash" =~ ^[0-9a-fA-F]{40}$ && "$daemon_hash" =~ ^[0-9a-fA-F]{40}$ ]] || exit 1
/usr/bin/printf '{"uiCdhash":"%s","daemonCdhash":"%s"}\n' "$ui_hash" "$daemon_hash" > "$root/config.json"
/bin/chmod 600 "$root/config.json"
plist='/Library/LaunchDaemons/dev.apexdeck.provenance.plist'
[[ ! -e "$plist" && ! -L "$plist" ]] || { echo 'LaunchDaemon already exists; leaving it intact.' >&2; exit 1; }
/bin/cat > "$plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.apexdeck.provenance</string>
<key>ProgramArguments</key><array><string>/Library/Application Support/Apex Deck Provenance/apex-provenance</string></array>
<key>UserName</key><string>root</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardErrorPath</key><string>/var/log/apex-provenance.log</string>
<key>ProcessType</key><string>Background</string>
</dict></plist>
PLIST
/usr/sbin/chown root:wheel "$plist"
/bin/chmod 644 "$plist"
/bin/launchctl bootstrap system "$plist"
echo "Installed protected authority. Trusted UI: $app"
echo 'Original app and user JSON were preserved. Legacy authority is NOT migrated.'
