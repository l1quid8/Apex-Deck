#!/bin/bash
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset NODE_OPTIONS ELECTRON_RUN_AS_NODE PYTHONPATH PYTHONHOME DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH

root='/Library/Application Support/Apex Deck Provenance'
plist='/Library/LaunchDaemons/dev.apexdeck.provenance.plist'
product="$root/Standalone"
team='75N5HW62JH'

no_path_link=0
uninstall=0
src=""

for arg in "$@"; do
  case "$arg" in
    --no-path-link) no_path_link=1 ;;
    --uninstall) uninstall=1 ;;
    --*) echo "Unknown flag $arg" >&2; exit 1 ;;
    *) if [[ -z "$src" ]]; then src="$arg"; else echo "Too many positional arguments" >&2; exit 1; fi ;;
  esac
done

[[ $EUID == 0 ]] || { echo 'Run explicitly as administrator.' >&2; exit 1; }

# Replacing or removing Standalone swaps the CDHash pins, so any process still
# running the installed binaries would lose authority mid-turn. Refuse instead
# of stopping anything; fail closed if the process list cannot be read.
refuse_if_standalone_running() {
  local procs
  procs=$(/bin/ps -axo comm=) || { echo 'Cannot inspect running processes; refusing.' >&2; exit 1; }
  if printf '%s\n' "$procs" | /usr/bin/grep -Fqx -e "$product/apex" -e "$product/apex-daemon"; then
    echo 'Apex CLI is still running. Quit every apex window, run: apex backend stop' >&2
    echo 'then run this command again. Nothing was changed.' >&2
    exit 1
  fi
}

# ---------- UNINSTALL ----------
if [[ $uninstall == 1 ]]; then
  if [[ -n "$src" && ! -d "$src" ]]; then
    echo 'Expected platform directory to be a directory when provided.' >&2; exit 1
  fi
  if [[ ! -e "$root" ]]; then
    echo 'No Apex authority to uninstall.' >&2; exit 0
  fi
  /usr/bin/python3 -I - "$root" "$plist" <<'PY'
import os,sys,stat
root,plist=sys.argv[1:]
for path in [root,root+'/config.json',root+'/apex-provenance',plist]:
  if not os.path.lexists(path): continue
  s=os.lstat(path)
  if stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:
    raise SystemExit('Unsafe existing authority path; refusing uninstall: '+path)
PY
  /bin/mkdir "$root/.cli-enrollment.lock" 2>/dev/null || { echo 'Another enrollment is in progress; inspect authority before retrying.' >&2; exit 1; }
  stage=$(/usr/bin/mktemp -d "$root/.cli-install.XXXXXX")
  /bin/chmod 700 "$stage"
  committed=0
  rollback() {
    st=$?
    if [[ $st != 0 && $committed == 1 ]]; then
      /bin/launchctl bootout system "$plist" >/dev/null 2>&1 || true
      [[ -f "$stage/config.before" ]] && /bin/cp -p "$stage/config.before" "$root/config.json" 2>/dev/null || true
      [[ -f "$stage/broker.before" ]] && /bin/cp -p "$stage/broker.before" "$root/apex-provenance" 2>/dev/null || true
      [[ -f "$stage/plist.before" ]] && /bin/cp -p "$stage/plist.before" "$plist" 2>/dev/null || true
      if [[ -e "$stage/product.before" ]]; then
        /bin/rm -rf "$product" 2>/dev/null || true
        /bin/mv "$stage/product.before" "$product" 2>/dev/null || true
      fi
      /bin/launchctl bootstrap system "$plist" >/dev/null 2>&1 || true
      echo 'Uninstall failed; previous install restored.' >&2
    fi
    if [[ $st == 0 || $committed == 0 ]]; then /bin/rm -rf "$stage"; /bin/rmdir "$root/.cli-enrollment.lock" 2>/dev/null || true; fi
    exit $st
  }
  trap rollback EXIT
  [[ -f "$root/config.json" ]] && /bin/cp -p "$root/config.json" "$stage/config.before"
  [[ -f "$root/apex-provenance" ]] && /bin/cp -p "$root/apex-provenance" "$stage/broker.before"
  [[ -f "$plist" ]] && /bin/cp -p "$plist" "$stage/plist.before"
  refuse_if_standalone_running
  /bin/launchctl bootout system "$plist" >/dev/null 2>&1 || true
  committed=1
  if [[ -e "$product" || -L "$product" ]]; then /bin/mv "$product" "$stage/product.before"; fi

  if [[ -L /usr/local/bin/apex ]]; then
    target=$(/usr/bin/readlink /usr/local/bin/apex || true)
    case "$target" in
      *Standalone/apex*|*Apex\ Deck\ Provenance/Standalone/apex*) /bin/rm -f /usr/local/bin/apex ;;
    esac
  fi

  decision=$(/usr/bin/python3 -I - "$root" "$stage" <<'PY'
import json,os,sys
root,stage=sys.argv[1:]
before=os.path.join(stage,'config.before')
if not os.path.exists(before):
  print('full-uninstall'); sys.exit(0)
with open(before) as f: old=json.load(f)
if old.get('cliStandaloneCdhash') or old.get('daemonStandaloneCdhash'):
  print('remove-standalone-pins')
else:
  if old.get('uiCdhash') is None:
    print('full-uninstall')
  else:
    print('remove-standalone-pins')
PY
)
  if [[ "$decision" == "full-uninstall" ]]; then
    echo "Removing standalone authority (fresh-only install)."
    /bin/rm -f "$root/config.json" "$root/apex-provenance" "$plist"
    # Keep private-key, public-key, journal.json, journal.log, host-locks
    echo 'Standalone uninstalled. Authority keys and journal were preserved.'
  else
    /usr/bin/python3 -I - "$root" <<'PY'
import json,os,sys
root=sys.argv[1]
path=os.path.join(root,'config.json')
with open(path) as f: c=json.load(f)
c.pop('cliStandaloneCdhash',None)
c.pop('daemonStandaloneCdhash',None)
tmp=path+'.next'
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as out:
  json.dump(c,out); out.write('\n'); out.flush(); os.fsync(out.fileno())
os.rename(tmp,path)
PY
    /bin/launchctl bootstrap system "$plist" >/dev/null 2>&1 || true
    /usr/bin/python3 -I - <<'PY'
import socket,time
for _ in range(50):
  try:
    with socket.socket(socket.AF_UNIX) as s:
      s.settimeout(.2); s.connect('/var/run/dev.apexdeck.provenance.sock')
    break
  except OSError:
    time.sleep(.1)
else:
  raise SystemExit('Authority did not become ready after uninstall')
PY
    echo 'Standalone uninstalled. Desktop pins and authority keys were preserved.'
  fi
  echo 'Data directory was preserved.'
  exit 0
fi

# ---------- INSTALL / UPGRADE ----------
[[ -n "$src" ]] || { echo 'Run with one extracted CLI directory.' >&2; exit 1; }
[[ -d "$src" && ! -L "$src" ]] || { echo 'Expected an extracted CLI directory.' >&2; exit 1; }

existing=0
is_upgrade=0
installed_version=""
if [[ -e "$root" || -L "$root" ]]; then
  existing=1
  /usr/bin/python3 -I - "$root" "$plist" <<'PY'
import os,sys,stat
root,plist=sys.argv[1:]
for path in [root,root+'/config.json',root+'/apex-provenance',plist]:
  if not os.path.lexists(path): continue
  s=os.lstat(path)
  if stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:
    raise SystemExit('Unsafe existing authority path; refusing enrollment: '+path)
PY
  # Fresh-only uninstall removes config.json and broker but preserves the
  # authority directory (keys, journal, locks). Reinstalling from that
  # preserved state must not attempt to verify a missing broker.
  if [[ -f "$root/apex-provenance" ]]; then
    /usr/bin/codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = \"$team\"" "$root/apex-provenance"
  fi
  if [[ -e "$product/manifest.json" ]]; then
    is_upgrade=1
    installed_version=$(/usr/bin/python3 -I - "$product/manifest.json" <<'PY'
import json,sys
with open(sys.argv[1]) as f: print(json.load(f).get('version',''))
PY
)
  fi
else
  [[ ! -e "$plist" && ! -L "$plist" ]] || { echo 'Existing service without authority directory; refusing enrollment.' >&2; exit 1; }
  /usr/bin/install -d -o root -g wheel -m 755 "$root"
fi

/bin/mkdir "$root/.cli-enrollment.lock" || { echo 'Another enrollment exists; inspect authority before retrying.' >&2; exit 1; }
stage=$(/usr/bin/mktemp -d "$root/.cli-install.XXXXXX")
/bin/chmod 700 "$stage"
committed=0
plist_created=0
product_placed=0
rollback() {
  st=$?
  if [[ $st != 0 && $committed == 1 ]]; then
    /bin/launchctl bootout system "$plist" >/dev/null 2>&1 || true
    [[ -f "$stage/config.before" ]] && /bin/cp -p "$stage/config.before" "$root/config.json" 2>/dev/null || true
    [[ -f "$stage/broker.before" ]] && /bin/cp -p "$stage/broker.before" "$root/apex-provenance" 2>/dev/null || true
    if [[ -e "$stage/product.before" ]]; then
      /bin/rm -rf "$product" 2>/dev/null || true
      /bin/mv "$stage/product.before" "$product" 2>/dev/null || true
    elif [[ $product_placed == 1 ]]; then
      # No earlier product existed; remove the one this run placed.
      /bin/rm -rf "$product" 2>/dev/null || true
    fi
    if [[ $plist_created == 1 ]]; then
      # This run wrote the service file; there was no service before it.
      /bin/rm -f "$plist" 2>/dev/null || true
    else
      /bin/launchctl bootstrap system "$plist" >/dev/null 2>&1 || true
    fi
    echo 'CLI enrollment failed. Inspect authority before retrying.' >&2
  fi
  if [[ $st == 0 || $committed == 0 ]]; then /bin/rm -rf "$stage"; /bin/rmdir "$root/.cli-enrollment.lock" 2>/dev/null || true; fi
  exit $st
}
trap rollback EXIT

for binary in apex apex-daemon apex-provenance; do
  [[ -f "$src/$binary" && ! -L "$src/$binary" ]] || { echo "Missing regular binary: $binary" >&2; exit 1; }
  /usr/bin/install -o root -g wheel -m 755 "$src/$binary" "$stage/$binary"
  req="anchor apple generic and certificate leaf[subject.OU] = \"$team\""
  [[ $binary == apex ]] && req="$req and identifier \"dev.apexdeck.cli\""
  /usr/bin/lipo -verify_arch arm64 "$stage/$binary"
  /usr/bin/codesign --verify --strict -R="$req" "$stage/$binary"
  d=$(/usr/bin/codesign -d --verbose=4 "$stage/$binary" 2>&1)
  [[ "$d" == *'(runtime)'* ]] || { echo 'Hardened runtime is required.' >&2; exit 1; }
  ent=$(/usr/bin/codesign -d --entitlements :- "$stage/$binary" 2>/dev/null || true)
  [[ "$ent" != *'com.apple.security.get-task-allow'* ]] || { echo 'Debugger entitlement refused.' >&2; exit 1; }
done

[[ -f "$src/manifest.json" && ! -L "$src/manifest.json" ]] || { echo 'Missing manifest.json' >&2; exit 1; }
/usr/bin/install -o root -g wheel -m 600 "$src/manifest.json" "$stage/manifest.json"
/usr/bin/python3 -I - "$stage" <<'PY'
import json,hashlib,sys
root=sys.argv[1]
with open(root+'/manifest.json') as f: m=json.load(f)
if m.get('formatVersion')!=1 or m.get('product')!='apex-cli' or m.get('architecture')!='arm64':
  raise SystemExit('Unsupported CLI manifest')
files=m.get('files',[])
if len(files)!=3 or {f.get('name') for f in files}!={'apex','apex-daemon','apex-provenance'}:
  raise SystemExit('Incomplete CLI manifest')
for f in files:
  with open(root+'/'+f['name'],'rb') as b: d=hashlib.sha256(b.read()).hexdigest()
  if d!=f.get('sha256'): raise SystemExit('CLI archive hash mismatch')
PY

new_version=$(/usr/bin/python3 -I - "$stage/manifest.json" <<'PY'
import json,sys
with open(sys.argv[1]) as f: print(json.load(f).get('version',''))
PY
)

if [[ $is_upgrade == 1 ]]; then
  decision=$(/usr/bin/python3 -I - "$installed_version" "$new_version" <<'PY'
import sys
old,new=sys.argv[1],sys.argv[2]
def parts(v):
  base=v.split('-')[0]
  p=[int(x) if x.isdigit() else 0 for x in base.split('.')]
  while len(p)<3: p.append(0)
  return p
if old==new:
  print('same'); sys.exit(0)
op=parts(old); np=parts(new)
if np<op:
  print('older'); sys.exit(0)
if np==op:
  old_pre='-' in old; new_pre='-' in new
  if not old_pre and new_pre:
    print('older'); sys.exit(0)
print('newer')
PY
)
  if [[ "$decision" == "older" ]]; then
    echo "Incoming version $new_version is older than installed $installed_version; refusing downgrade." >&2
    exit 1
  fi
fi

cli_hash=$(/usr/bin/codesign -d --verbose=4 "$stage/apex" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2}')
daemon_hash=$(/usr/bin/codesign -d --verbose=4 "$stage/apex-daemon" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2}')
[[ "$cli_hash" =~ ^[0-9a-fA-F]{40}$ && "$daemon_hash" =~ ^[0-9a-fA-F]{40}$ ]] || { echo 'Invalid CDHash' >&2; exit 1; }

# Same version string is not proof of same build: a rebuilt package keeps its
# version but changes every hash. Skip only when the installed files, broker
# and pins all match this payload exactly.
if [[ $is_upgrade == 1 && "$decision" == "same" && -f "$plist" ]]; then
  if /usr/bin/python3 -I - "$root" "$product" "$stage" "$cli_hash" "$daemon_hash" <<'PY'
import hashlib,json,os,sys
root,product,stage,cli,daemon=sys.argv[1:]
def sha(p):
  with open(p,'rb') as f: return hashlib.sha256(f.read()).hexdigest()
try:
  with open(stage+'/manifest.json') as f: m=json.load(f)
  where={'apex':product+'/apex','apex-daemon':product+'/apex-daemon','apex-provenance':root+'/apex-provenance'}
  for f in m['files']:
    if sha(where[f['name']])!=f['sha256']: sys.exit(1)
  if sha(product+'/manifest.json')!=sha(stage+'/manifest.json'): sys.exit(1)
  with open(root+'/config.json') as f: c=json.load(f)
  # A CLI-only (fresh) install pins under cliCdhash/daemonCdhash; once the
  # desktop or a later CLI install shares the authority, standalone pins win.
  solo=c.get('uiCdhash') is None
  pin_cli=c.get('cliStandaloneCdhash') or (c.get('cliCdhash') if solo else None)
  pin_daemon=c.get('daemonStandaloneCdhash') or (c.get('daemonCdhash') if solo else None)
  if pin_cli!=cli or pin_daemon!=daemon: sys.exit(1)
except Exception:
  sys.exit(1)
PY
  then
    echo "Standalone already at version $installed_version with this exact build; no changes needed."
    exit 0
  fi
  echo "Replacing standalone $installed_version with a different build of the same version."
fi
if [[ $is_upgrade == 1 ]]; then refuse_if_standalone_running; fi

/usr/bin/python3 -I - /usr/local /usr/local/bin <<'PY'
import os,stat,sys
for p in sys.argv[1:]:
  if not os.path.lexists(p):
    try: os.mkdir(p,0o755)
    except FileExistsError: pass
  s=os.lstat(p)
  if stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:
    raise SystemExit('Unsafe PATH directory: '+p)
PY

if [[ $no_path_link == 0 ]]; then
  if [[ -L /usr/local/bin/apex ]]; then
    t=$(/usr/bin/readlink /usr/local/bin/apex || true)
    case "$t" in
      *Standalone/apex*|*Apex\ Deck\ Provenance/Standalone/apex*) ;;
      *) echo '/usr/local/bin/apex exists and does not point to Standalone; refusing replacement.' >&2; exit 1 ;;
    esac
  elif [[ -e /usr/local/bin/apex ]]; then
    echo '/usr/local/bin/apex already exists; refusing replacement.' >&2; exit 1
  fi
fi

if [[ $existing == 1 ]]; then
  [[ -f "$root/config.json" ]] && /bin/cp -p "$root/config.json" "$stage/config.before"
  [[ -f "$root/apex-provenance" ]] && /bin/cp -p "$root/apex-provenance" "$stage/broker.before"
fi

/usr/bin/python3 -I - "$root" "$stage" "$cli_hash" "$daemon_hash" "$existing" <<'PY'
import json,os,sys
root,stage,cli,daemon,existing=sys.argv[1:]
config_path=os.path.join(root,'config.json')
if existing=='1' and os.path.exists(config_path):
  with open(config_path) as f: c=json.load(f)
  c['cliStandaloneCdhash']=cli
  c['daemonStandaloneCdhash']=daemon
  if c.get('uiCdhash') is None:
    c['cliCdhash']=cli
    c['daemonCdhash']=daemon
else:
  # Fresh install or reinstall after full uninstall: no config exists; start fresh.
  c={'uiCdhash':None,'cliCdhash':cli,'daemonCdhash':daemon}
p=stage+'/config.next'
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f: json.dump(c,f); f.write('\n'); f.flush(); os.fsync(f.fileno())
PY

/usr/bin/install -d -o root -g wheel -m 755 "$stage/product"
/usr/bin/install -o root -g wheel -m 755 "$stage/apex" "$stage/product/apex"
/usr/bin/install -o root -g wheel -m 755 "$stage/apex-daemon" "$stage/product/apex-daemon"
/usr/bin/install -o root -g wheel -m 644 "$stage/manifest.json" "$stage/product/manifest.json"

# Uninstall removes the service file but keeps the authority directory, so a
# reinstall (existing=1) can also find it missing. Recreate it whenever absent.
if [[ ! -e "$plist" && ! -L "$plist" ]]; then
  plist_created=1
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

if [[ $existing == 1 ]]; then /bin/launchctl bootout system "$plist" >/dev/null 2>&1 || true; fi
committed=1
if [[ -e "$product" || -L "$product" ]]; then /bin/mv "$product" "$stage/product.before"; fi
/bin/mv "$stage/product" "$product"
product_placed=1
/bin/mv "$stage/config.next" "$root/config.json"
/usr/bin/install -o root -g wheel -m 755 "$stage/apex-provenance" "$root/apex-provenance.next"
/bin/mv "$root/apex-provenance.next" "$root/apex-provenance"
/bin/launchctl bootstrap system "$plist"
/bin/launchctl print system/dev.apexdeck.provenance >/dev/null
/usr/bin/python3 -I - <<'PY'
import socket,time
for _ in range(50):
  try:
    with socket.socket(socket.AF_UNIX) as s:
      s.settimeout(.2); s.connect('/var/run/dev.apexdeck.provenance.sock')
    break
  except OSError:
    time.sleep(.1)
else:
  raise SystemExit('Authority did not become ready; rolling back')
PY

if [[ $no_path_link == 0 ]]; then
  [[ -L /usr/local/bin/apex ]] && /bin/rm -f /usr/local/bin/apex
  if [[ ! -e /usr/local/bin/apex ]]; then /bin/ln -s "$product/apex" /usr/local/bin/apex; fi
fi

if [[ $is_upgrade == 1 ]]; then
  echo "Upgraded standalone Apex CLI from $installed_version to $new_version. Existing authority keys, journal and desktop pins were preserved."
else
  echo 'Installed standalone Apex CLI. Existing authority keys, journal and desktop pins were preserved.'
fi
echo 'Run apex as your normal user. Provider sign-in is initiated explicitly with /login.'
