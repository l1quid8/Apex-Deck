#!/bin/bash
# Read-only fingerprint of Apex Deck's protected authority.
#
# An upgrade has to prove the signing keys, journal.json and the root-owned
# host-locks/ inodes came through unchanged. This takes that fingerprint before
# and after, and compares the two mechanically instead of by eye.
#
# Usage:
#   sudo /bin/bash scripts/authority-inventory.sh > before.json
#   sudo /bin/bash scripts/authority-inventory.sh > after.json
#   /bin/bash scripts/authority-inventory.sh --compare before.json after.json
#
# It writes nothing, starts and stops nothing, and changes no pin. Run it as
# administrator for the hashes: config.json, the key material and journal.json
# are root-only by design, so an unprivileged run reports them unreadable. That
# is reported as INCONCLUSIVE with a nonzero exit, never as a pass — an
# unreadable journal must not be able to look like a preserved one.
#
# The broker only writes journal.json for a non-read transaction (main.rs:241),
# so a journal hash that moves while nothing is running means a real write.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

ROOT='/Library/Application Support/Apex Deck Provenance'
TRUSTED_APP="$ROOT/TrustedUI/Apex Deck.app"
INSTALLED_APP='/Applications/Apex Deck.app'

# A future edit must not be able to widen this into another path.
[[ "$ROOT" == '/Library/Application Support/Apex Deck Provenance' ]] || {
  echo 'Refusing: unexpected authority path.' >&2; exit 1; }

case "${1:-}" in
  -h|--help) /usr/bin/sed -n '2,21p' "${BASH_SOURCE[0]}" | /usr/bin/cut -c3-; exit 0 ;;
  --compare)
    [[ $# == 3 ]] || { echo 'Usage: --compare BEFORE.json AFTER.json' >&2; exit 2; }
    /usr/bin/python3 -I - "$2" "$3" <<'PY'
import json, sys

def load(path):
    with open(path, "rb") as handle:
        return json.load(handle)

try:
    before, after = load(sys.argv[1]), load(sys.argv[2])
except (OSError, ValueError) as error:
    print("FAIL could not read an inventory: %s" % error)
    raise SystemExit(1)

problems, unproven = [], []

def say(state, item, detail=""):
    print("%-7s %s%s" % (state, item, (" — " + detail) if detail else ""))

def metadata(item):
    return tuple(item.get(k) for k in ("device", "inode", "uid", "gid", "mode", "symlink"))

def protected(item):
    try:
        return item.get("uid") == 0 and not item.get("symlink") and not (int(item["mode"], 8) & 0o022)
    except (KeyError, TypeError, ValueError):
        return False

for side, snapshot in (("before", before), ("after", after)):
    if snapshot.get("inventoryErrors"):
        say("UNPROVEN", side + " inventory", "; ".join(snapshot["inventoryErrors"]))
        unproven.append(side + " inventory")
    if snapshot.get("locksDirectory") and snapshot.get("locksReadable") is not True:
        say("UNPROVEN", side + " host-locks listing", "could not enumerate every existing lock")
        unproven.append(side + " host-locks listing")
    identities = {"authority directory": snapshot.get("authorityDirectory"),
                  "host-locks directory": snapshot.get("locksDirectory")}
    identities.update(snapshot.get("authority") or {})
    identities.update({"host-locks/" + key: value for key, value in (snapshot.get("locks") or {}).items()})
    for name, item in identities.items():
        if item and (any(type(item.get(key)) is not int for key in ("device", "inode", "uid", "gid"))
                     or not isinstance(item.get("mode"), str) or type(item.get("symlink")) is not bool):
            say("UNPROVEN", side + " " + name, "identity metadata is incomplete; take a fresh inventory")
            unproven.append(side + " " + name)

was_root, now_root = before.get("authorityDirectory"), after.get("authorityDirectory")
if not was_root or not now_root:
    say("UNPROVEN", "authority directory", "identity was not captured on both sides")
    unproven.append("authority directory")
elif metadata(was_root) != metadata(now_root) or not protected(now_root):
    say("FAIL", "authority directory", "identity or protection changed")
    problems.append("authority directory")

# Keys and journal must be identical. A journal that moved means a protected
# write happened while the upgrade claimed everything was stopped.
for name in ("private-key", "public-key", "journal.json"):
    was, now = before["authority"].get(name), after["authority"].get(name)
    if not was or not now or not was.get("sha256") or not now.get("sha256"):
        say("UNPROVEN", name, "unreadable on one side, so equality is unproven")
        unproven.append(name)
    elif (was["sha256"] == now["sha256"] and was.get("bytes") == now.get("bytes")
          and metadata(was) == metadata(now) and protected(now)):
        say("SAME", name, "%s… %s bytes" % (now["sha256"][:16], now["bytes"]))
    else:
        say("FAIL", name, "content, identity or protection changed: %s… (%s bytes) -> %s… (%s bytes)" % (
            (was.get("sha256") or "?")[:16], was.get("bytes"),
            (now.get("sha256") or "?")[:16], now.get("bytes")))
        problems.append(name)

# The carry-forward rule for host-locks is identity, not content: a replaced
# inode would let a new host lock a different inode for the same scope. Locks
# that appear are new scopes, not replaced ones; locks that vanish or change
# inode are the failure this check exists for.
was_locks, now_locks = before.get("locks") or {}, after.get("locks") or {}
for name in sorted(set(was_locks) | set(now_locks)):
    was, now = was_locks.get(name), now_locks.get(name)
    if now and not protected(now):
        say("FAIL", "host-locks/" + name, "root ownership or write protection is missing")
        problems.append("host-locks/" + name)
    elif now and not now.get("sha256"):
        say("UNPROVEN", "host-locks/" + name, "content could not be read")
        unproven.append("host-locks/" + name)
    elif was and now and metadata(was) == metadata(now) and was.get("sha256") == now.get("sha256"):
        say("SAME", "host-locks/" + name, "inode %s" % now.get("inode"))
    elif not was:
        say("ADDED", "host-locks/" + name, "inode %s, a scope that had no lock before" % now.get("inode"))
    elif not now:
        say("FAIL", "host-locks/" + name, "vanished during the upgrade")
        problems.append("host-locks/" + name)
    else:
        say("FAIL", "host-locks/" + name,
            "inode %s -> %s, content %s" % (was.get("inode"), now.get("inode"),
                                            "unchanged" if was.get("sha256") == now.get("sha256") else "changed"))
        problems.append("host-locks/" + name)

was_dir, now_dir = before.get("locksDirectory"), after.get("locksDirectory")
if now_dir and not protected(now_dir):
    say("FAIL", "host-locks/ directory", "root ownership or write protection is missing")
    problems.append("host-locks/ directory")
elif not was_dir and now_dir:
    say("ADDED", "host-locks/ directory", "inode %s, created by this build" % now_dir.get("inode"))
elif was_dir and now_dir and metadata(was_dir) == metadata(now_dir):
    say("SAME", "host-locks/ directory", "inode %s" % now_dir.get("inode"))
elif was_dir and now_dir:
    say("FAIL", "host-locks/ directory", "inode %s -> %s" % (was_dir.get("inode"), now_dir.get("inode")))
    problems.append("host-locks/ directory")
elif was_dir:
    say("FAIL", "host-locks/ directory", "vanished during the upgrade")
    problems.append("host-locks/ directory")
else:
    say("SKIP", "host-locks/ directory", "absent on both sides")

# Pins and bundles are expected to move to the candidate. Reported, not failed.
was_pins, now_pins = before.get("pins"), after.get("pins")
for key in ("uiCdhash", "daemonCdhash"):
    was = (was_pins or {}).get(key) if isinstance(was_pins, dict) else None
    now = (now_pins or {}).get(key) if isinstance(now_pins, dict) else None
    if was is None or now is None:
        say("UNPROVEN", "pin " + key, "config.json unreadable on one side")
        unproven.append("pin " + key)
    elif was == now:
        say("SAME", "pin " + key, str(now))
    else:
        say("CHANGED", "pin " + key, "%s -> %s" % (was, now))

for app in ("trustedUI", "installed"):
    was, now = before["apps"].get(app, {}), after["apps"].get(app, {})
    moved = (was.get("uiCdhash"), was.get("daemonCdhash"), was.get("version")) != (
        now.get("uiCdhash"), now.get("daemonCdhash"), now.get("version"))
    say("CHANGED" if moved else "SAME", "%s app" % app,
        "version %s, UI %s…, daemon %s…" % (now.get("version"),
                                            str(now.get("uiCdhash"))[:12],
                                            str(now.get("daemonCdhash"))[:12]))
if after["apps"].get("trustedUI", {}).get("exists") and not after["apps"]["trustedUI"].get("rootProtected"):
    say("FAIL", "trustedUI root protection",
        "the protected copy is not root-owned with group and world writes closed")
    problems.append("trustedUI root protection")

was_agent, now_agent = before.get("agent") or {}, after.get("agent") or {}
say("CHANGED" if was_agent.get("program") != now_agent.get("program") else "SAME",
    "LaunchAgent program", str(now_agent.get("program")))

for process in (after.get("running") or []):
    if isinstance(process, dict):
        say("RUNNING", "after inventory", "pid %s %s (%s)" % (
            process.get("pid"), process.get("name"), process.get("exe")))
    else:
        say("RUNNING", "after inventory", str(process))

print("")
if problems:
    print("RESULT: FAIL — %d item(s) drifted: %s" % (len(problems), ", ".join(problems)))
    if unproven:
        print("        also unproven: %s" % ", ".join(unproven))
    raise SystemExit(1)
if unproven:
    print("RESULT: INCONCLUSIVE — nothing drifted, but these could not be proven: %s" % ", ".join(unproven))
    print("        re-run both inventories with sudo before recording an upgrade")
    raise SystemExit(2)
print("RESULT: PASS — keys, journal and host-lock inodes are preserved in place")
PY
    exit $?
    ;;
  '') ;;
  *) echo "Unknown argument: $1" >&2; exit 2 ;;
esac

/usr/bin/python3 -I - "$ROOT" "$TRUSTED_APP" "$INSTALLED_APP" <<'PY'
import hashlib, json, os, plistlib, pwd, subprocess, sys, time

root, trusted, installed = sys.argv[1:4]
# sudo may change HOME and uid to root. Inspect the invoking user's agent,
# never root's unrelated gui/0 service. Do not trust a supplied home path.
user_uid = os.getuid()
if user_uid == 0:
    try:
        user_uid = int(os.environ["SUDO_UID"])
        if user_uid <= 0:
            raise ValueError("not an ordinary user")
    except (KeyError, ValueError):
        raise SystemExit("Run with sudo from the Apex Deck user's shell (SUDO_UID is required).")
user_home = pwd.getpwuid(user_uid).pw_dir
agent = os.path.join(user_home, "Library/LaunchAgents/dev.apexdeck.daemon.plist")
inventory_errors = []

def sha256(path):
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError as error:
        inventory_errors.append("cannot hash %s: %s" % (path, error))
        return None

def stat_of(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as error:
        inventory_errors.append("cannot stat %s: %s" % (path, error))
        return None
    return {"mode": oct(info.st_mode & 0o777), "uid": info.st_uid, "gid": info.st_gid,
            "device": info.st_dev, "inode": info.st_ino,
            "bytes": info.st_size, "mtime": int(info.st_mtime), "symlink": os.path.islink(path)}

def entry(path):
    info = stat_of(path)
    if info is None:
        return None
    info["sha256"] = sha256(path)
    return info

def cdhash(path):
    try:
        done = subprocess.run(["/usr/bin/codesign", "-d", "--verbose=4", path],
                              capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.SubprocessError):
        return None
    for line in done.stderr.splitlines():
        if line.startswith("CDHash="):
            return line.split("=", 1)[1].strip().lower()
    return None

# The rule peer.m applies before trusting a peer: every component root-owned,
# not a symlink, closed to group and world writes. /Applications fails this.
def root_protected(path):
    at = os.path.abspath(path)
    while True:
        try:
            info = os.lstat(at)
        except OSError:
            return False
        if os.path.islink(at) or info.st_uid != 0 or info.st_mode & 0o022:
            return False
        if os.path.dirname(at) == at:
            return True
        at = os.path.dirname(at)

def bundle(app, broker):
    exists = os.path.isdir(app)
    version = None
    try:
        with open(os.path.join(app, "Contents", "Info.plist"), "rb") as handle:
            version = plistlib.load(handle).get("CFBundleShortVersionString")
    except (OSError, ValueError, plistlib.InvalidFileException):
        pass
    return {"path": app, "exists": exists, "version": version,
            "uiCdhash": cdhash(app) if exists else None,
            "daemonCdhash": cdhash(os.path.join(app, "Contents", "Resources", "bin", "apex-daemon")),
            "rootProtected": root_protected(app) if exists else False,
            "brokerCdhash": cdhash(broker)}

pins = None
if os.path.exists(os.path.join(root, "config.json")):
    try:
        with open(os.path.join(root, "config.json"), "rb") as handle:
            data = json.load(handle)
        pins = {key: data.get(key) for key in ("uiCdhash", "daemonCdhash")}
    except (OSError, ValueError):
        pins = None

locks_directory = stat_of(os.path.join(root, "host-locks"))
locks_readable = locks_directory is None
locks = {}
if locks_directory:
    try:
        names = sorted(os.listdir(os.path.join(root, "host-locks")))
        locks_readable = True
    except OSError as error:
        inventory_errors.append("cannot list host-locks: %s" % error)
        names = []
    for name in names:
        locks[name] = entry(os.path.join(root, "host-locks", name))

agent_info = {"path": agent, "exists": os.path.exists(agent), "program": None, "loaded": None}
if agent_info["exists"]:
    try:
        with open(agent, "rb") as handle:
            agent_info["program"] = (plistlib.load(handle).get("ProgramArguments") or [None])[0]
    except (OSError, ValueError, plistlib.InvalidFileException):
        agent_info["program"] = "unreadable"
try:
    done = subprocess.run(["/bin/launchctl", "print", "gui/%d/dev.apexdeck.daemon" % user_uid],
                          capture_output=True, text=True, timeout=60)
    agent_info["loaded"] = done.returncode == 0
except (OSError, subprocess.SubprocessError):
    pass

# Match on the executable, not on the command line: a shell that merely mentions
# apex-daemon in its text is not a running daemon, and "nothing is running" is
# the claim this list exists to support.
WATCHED = {"apex-daemon", "apex-provenance", "Apex Deck"}

def processes():
    try:
        done = subprocess.run(["/bin/ps", "-axo", "pid=,comm="],
                              capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as error:
        inventory_errors.append("cannot list running processes: %s" % error)
        return []
    if done.returncode != 0:
        inventory_errors.append("cannot list running processes: ps exited %d" % done.returncode)
        return []
    keep = []
    for line in done.stdout.splitlines():
        fields = line.split(None, 1)
        if len(fields) < 2 or os.path.basename(fields[1]) not in WATCHED:
            continue
        keep.append({"pid": int(fields[0]), "name": os.path.basename(fields[1]), "exe": fields[1]})
    return keep

print(json.dumps({
    "takenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "host": os.uname().nodename,
    "root": root,
    "userUid": user_uid,
    "authorityDirectory": stat_of(root),
    "authority": {name: entry(os.path.join(root, name))
                  for name in ("private-key", "public-key", "journal.json", "config.json")},
    "pins": pins,
    "locksDirectory": locks_directory,
    "locksReadable": locks_readable,
    "locks": locks,
    "apps": {"trustedUI": bundle(trusted, os.path.join(root, "apex-provenance")),
             "installed": bundle(installed, os.path.join(root, "apex-provenance"))},
    "agent": agent_info,
    "running": processes(),
    "inventoryErrors": inventory_errors,
}, indent=2, sort_keys=True))
PY
