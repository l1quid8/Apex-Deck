#!/bin/bash
# Explicit user-run enrollment. Never invoked automatically by Apex/agents.
# Usage: sudo /bin/bash install-cli-provenance.sh /path/to/extracted/Apex-CLI
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset NODE_OPTIONS ELECTRON_RUN_AS_NODE PYTHONPATH PYTHONHOME DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
[[ $EUID == 0 && $# == 1 ]] || { echo 'Run explicitly as administrator with one extracted CLI directory.' >&2; exit 1; }
root='/Library/Application Support/Apex Deck Provenance'
plist='/Library/LaunchDaemons/dev.apexdeck.provenance.plist'
product="$root/Standalone"
team='75N5HW62JH'
[[ -d "$1" && ! -L "$1" ]] || { echo 'Expected an extracted CLI directory.' >&2; exit 1; }
[[ ! -e "$product" && ! -L "$product" ]] || { echo 'Standalone is already installed; upgrade enrollment is not implemented.' >&2; exit 1; }
# Protect every existing authority path. Never reset a key or journal.
existing=0
if [[ -e "$root" || -L "$root" ]]; then
  existing=1
  /usr/bin/python3 -I - "$root" "$plist" <<'PY'
import os,sys,stat,json
root,plist=sys.argv[1:]
for path in [root,root+'/config.json',root+'/apex-provenance',plist]:
    s=os.lstat(path)
    if stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:
        raise SystemExit('Unsafe existing authority path; refusing enrollment: '+path)
with open(root+'/config.json') as f: c=json.load(f)
if c.get('cliStandaloneCdhash') or c.get('daemonStandaloneCdhash'):
    raise SystemExit('Existing standalone pins found; refusing overwrite')
PY
  /usr/bin/codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = \"$team\"" "$root/apex-provenance"
else
  [[ ! -e "$plist" && ! -L "$plist" ]] || { echo 'Existing service without authority directory; refusing enrollment.' >&2; exit 1; }
  /usr/bin/install -d -o root -g wheel -m 755 "$root"
fi
# Serialize enrollment without ever replacing a live lock.
/bin/mkdir "$root/.cli-enrollment.lock" || { echo 'Another or interrupted CLI enrollment exists; inspect authority before retrying.' >&2; exit 1; }
# Copy to a root-owned staging directory before checking identity/content.
stage=$(/usr/bin/mktemp -d "$root/.cli-install.XXXXXX")
/bin/chmod 700 "$stage"
committed=0
rollback() {
  status=$?
  if [[ $status != 0 && $committed == 1 ]]; then
    /bin/launchctl bootout system "$plist" >/dev/null 2>&1 || true
    if [[ $existing == 1 ]]; then
      /bin/cp -p "$stage/config.before" "$root/config.json"
      /bin/cp -p "$stage/broker.before" "$root/apex-provenance"
      /bin/launchctl bootstrap system "$plist" >/dev/null 2>&1 || true
    else
      echo 'Fresh enrollment failed; authority state retained for administrator inspection.' >&2
    fi
    echo 'CLI enrollment failed. Inspect authority service before retrying.' >&2
  fi
  # Failed state and backups are retained; successful staging is disposable.
  if [[ $status == 0 ]]; then /bin/rm -rf "$stage"; /bin/rmdir "$root/.cli-enrollment.lock"; fi
  exit "$status"
}
trap rollback EXIT
for binary in apex apex-daemon apex-provenance; do
  [[ -f "$1/$binary" && ! -L "$1/$binary" ]] || { echo "Missing regular binary: $binary" >&2; exit 1; }
  /usr/bin/install -o root -g wheel -m 755 "$1/$binary" "$stage/$binary"
  requirement="anchor apple generic and certificate leaf[subject.OU] = \"$team\""
  if [[ $binary == apex ]]; then requirement="$requirement and identifier \"dev.apexdeck.cli\""; fi
  /usr/bin/lipo -verify_arch arm64 "$stage/$binary"
  /usr/bin/codesign --verify --strict -R="$requirement" "$stage/$binary"
  details=$(/usr/bin/codesign -d --verbose=4 "$stage/$binary" 2>&1)
  [[ "$details" == *'(runtime)'* ]] || { echo 'Hardened runtime is required.' >&2; exit 1; }
  entitlements=$(/usr/bin/codesign -d --entitlements :- "$stage/$binary" 2>/dev/null)
  [[ "$entitlements" != *'com.apple.security.get-task-allow'* ]] || { echo 'Debugger entitlement refused.' >&2; exit 1; }
done
# A signed source binary is mandatory; manifest hashes detect mixed archives.
[[ -f "$1/manifest.json" && ! -L "$1/manifest.json" ]] || exit 1
/usr/bin/install -o root -g wheel -m 600 "$1/manifest.json" "$stage/manifest.json"
/usr/bin/python3 -I - "$stage" <<'PY'
import json,sys,hashlib,os
root=sys.argv[1]
with open(root+'/manifest.json') as f: m=json.load(f)
if m.get('formatVersion')!=1 or m.get('product')!='apex-cli' or m.get('architecture')!='arm64': raise SystemExit('Unsupported CLI manifest')
files=m.get('files',[])
if len(files)!=3 or {f.get('name') for f in files}!={'apex','apex-daemon','apex-provenance'}: raise SystemExit('Incomplete CLI manifest')
for f in files:
    with open(root+'/'+f['name'],'rb') as b: digest=hashlib.sha256(b.read()).hexdigest()
    if digest!=f.get('sha256'): raise SystemExit('CLI archive hash mismatch')
PY
cli_hash=$(/usr/bin/codesign -d --verbose=4 "$stage/apex" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2}')
daemon_hash=$(/usr/bin/codesign -d --verbose=4 "$stage/apex-daemon" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2}')
[[ "$cli_hash" =~ ^[0-9a-fA-F]{40}$ && "$daemon_hash" =~ ^[0-9a-fA-F]{40}$ ]] || exit 1
/usr/bin/python3 -I - /usr/local /usr/local/bin <<'PY'
import os,stat,sys
for p in sys.argv[1:]:
    if not os.path.lexists(p): os.mkdir(p,0o755)
    s=os.lstat(p)
    if stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022: raise SystemExit('Unsafe PATH directory: '+p)
PY
[[ ! -e /usr/local/bin/apex && ! -L /usr/local/bin/apex ]] || { echo '/usr/local/bin/apex already exists; refusing replacement.' >&2; exit 1; }
if [[ $existing == 1 ]]; then
  /bin/cp -p "$root/config.json" "$stage/config.before"
  /bin/cp -p "$root/apex-provenance" "$stage/broker.before"
fi
/usr/bin/python3 -I - "$root" "$stage" "$cli_hash" "$daemon_hash" "$existing" <<'PY'
import json,os,sys
root,stage,cli,daemon,existing=sys.argv[1:]
if existing=='1':
    with open(root+'/config.json') as f: c=json.load(f)
    c['cliStandaloneCdhash']=cli; c['daemonStandaloneCdhash']=daemon
else: c={'uiCdhash':None,'cliCdhash':cli,'daemonCdhash':daemon}
p=stage+'/config.next'
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f: json.dump(c,f); f.write('\n'); f.flush(); os.fsync(f.fileno())
PY
/usr/bin/install -d -o root -g wheel -m 755 "$stage/product"
/usr/bin/install -o root -g wheel -m 755 "$stage/apex" "$stage/product/apex"
/usr/bin/install -o root -g wheel -m 755 "$stage/apex-daemon" "$stage/product/apex-daemon"
/usr/bin/install -o root -g wheel -m 644 "$stage/manifest.json" "$stage/product/manifest.json"
/bin/mv "$stage/product" "$product"
if [[ $existing == 0 ]]; then
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
  /usr/sbin/chown root:wheel "$plist"; /bin/chmod 644 "$plist"
fi
# Stop before atomically replacing config/broker; never alter keys or journals.
if [[ $existing == 1 ]]; then /bin/launchctl bootout system "$plist"; fi
committed=1
/bin/mv "$stage/config.next" "$root/config.json"
/usr/bin/install -o root -g wheel -m 755 "$stage/apex-provenance" "$root/apex-provenance.next"
/bin/mv "$root/apex-provenance.next" "$root/apex-provenance"
/bin/launchctl bootstrap system "$plist"
/bin/launchctl print system/dev.apexdeck.provenance >/dev/null
# Bootstrap alone does not prove that the broker accepted its config.
/usr/bin/python3 -I - <<'PY'
import socket,time
for attempt in range(50):
    try:
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(.2); s.connect('/var/run/dev.apexdeck.provenance.sock')
        break
    except OSError: time.sleep(.1)
else: raise SystemExit('Authority did not become ready; rolling back')
PY
/bin/ln -s "$product/apex" /usr/local/bin/apex
echo 'Installed standalone Apex CLI. Existing authority keys, journal and desktop pins were preserved.'
echo 'Run apex as your normal user. Provider sign-in is initiated explicitly with /login.'
