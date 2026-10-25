#!/bin/bash
# Provenance acceptance harness, for the normal user, with no sudo.
#
# Runs the checklist in docs/security/provenance-boundary.md ("Test seams and
# remaining acceptance") against the *installed* protected copy and prints a
# PASS/FAIL/SKIP line per check plus a JSON evidence file whose path it prints.
#
# Safety, in the order it matters:
#   - nothing here writes to the user's data folder, installed apps, LaunchAgent
#     or protected authority journal. A current broker may create persistent
#     root-owned host-lock bookkeeping for this run's isolated scopes.
#   - every daemon this starts runs on a fresh `mktemp -d` data folder under
#     /tmp (short paths: macOS caps socket paths) and is stopped before exit.
#   - the user's running app, daemon and broker are never stopped, replaced or
#     reloaded. The only launchd command is `launchctl print`, which reads.
#   - the work folder is deleted on exit (--keep leaves it for inspection).
#
# Usage: scripts/acceptance-provenance.sh [--evidence PATH] [--keep] [--help]

set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export LC_ALL=C

REPO=$(cd "$(dirname "$0")/.." && pwd)
ROOT='/Library/Application Support/Apex Deck Provenance'
APP="$ROOT/TrustedUI/Apex Deck.app"
DAEMON="$APP/Contents/Resources/bin/apex-daemon"
BROKER="$ROOT/apex-provenance"
PIN_FILE="$ROOT/config.json"
JOURNAL="$ROOT/journal.json"
BROKER_SOCKET='/var/run/dev.apexdeck.provenance.sock'
BROKER_JOB='dev.apexdeck.provenance'
INSTALLED_APP='/Applications/Apex Deck.app'
INSTALLED_DAEMON="$INSTALLED_APP/Contents/Resources/bin/apex-daemon"
AGENT_PLIST="$HOME/Library/LaunchAgents/dev.apexdeck.daemon.plist"
EVIDENCE="$REPO/target/acceptance-provenance/evidence-$(/bin/date -u +%Y%m%dT%H%M%SZ).json"
KEEP=0
DAEMON_PID=''

usage() {
  /bin/cat <<'TEXT'
usage: scripts/acceptance-provenance.sh [--evidence PATH] [--keep]

  --evidence PATH  where to write the JSON evidence (default: a timestamped file
                   under target/acceptance-provenance/)
  --keep           keep the isolated temporary data folder for inspection
  --help           this text

Prints one PASS/FAIL/SKIP line per check from
docs/security/provenance-boundary.md and the path of the JSON evidence.
Never needs sudo, never writes to the user's data or the installed apps.
TEXT
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --evidence) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; EVIDENCE=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

WORK=$(/usr/bin/mktemp -d /tmp/apex-acceptance.XXXXXX) || { echo 'could not make a temporary folder' >&2; exit 1; }
TABLE="$WORK/results.tsv"
: > "$TABLE"
PIDS=()

cleanup() {
  local pid
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    kill "$pid" 2>/dev/null
  done
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    wait "$pid" 2>/dev/null
  done
  if [[ "$KEEP" == 1 ]]; then
    echo "kept the isolated folder: $WORK"
  else
    /bin/rm -rf "$WORK"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------- reporting

# One line per check: tabs and newlines would break the table and the JSON.
clean() { /usr/bin/tr '\t\n' '  ' <<<"${1:-}" | /usr/bin/cut -c1-600; }
record() { /usr/bin/printf '%s\t%s\t%s\n' "$1" "$2" "$(clean "$3")" >> "$TABLE"; }
pass_check() { record "$1" PASS "$2"; }
fail_check() { record "$1" FAIL "$2"; }
skip_check() { record "$1" SKIP "$2"; }
headline() { /usr/bin/head -3 "$1" 2>/dev/null | /usr/bin/tr '\n' ' '; }

# Text a binary contains: "does this build have the broker client at all?".
has_text() { /usr/bin/strings -a "$1" 2>/dev/null | /usr/bin/grep -F "$2" >/dev/null; }

# ------------------------------------------------------------- daemon runs

# start_daemon <binary> <data folder> <label>: `serve` in the background on a
# folder this script owns. Sets DAEMON_PID. Fails when it stops early.
start_daemon() {
  local bin=$1 data=$2 label=$3 i
  local log="$WORK/$label.log"
  local socket="$data/daemon.sock"
  "$bin" serve --data-dir "$data" >"$log" 2>&1 &
  DAEMON_PID=$!
  PIDS+=("$DAEMON_PID")
  for i in $(/usr/bin/seq 1 150); do
    [[ -S "$socket" ]] && return 0
    kill -0 "$DAEMON_PID" 2>/dev/null || return 1
    /bin/sleep 0.1
  done
  [[ -S "$socket" ]]
}

# Stop the daemon this script started. Never anyone else's.
stop_daemon() {
  [[ -n "$DAEMON_PID" ]] || return 0
  kill "$DAEMON_PID" 2>/dev/null
  wait "$DAEMON_PID" 2>/dev/null
  DAEMON_PID=''
}

# One protocol exchange on a daemon's own socket, as the desktop window does.
# speak <data folder> <json request>: prints the reply frame for id 1.
speak() {
  /usr/bin/python3 -I - "$1/daemon.sock" "$2" <<'PY'
import json, socket, sys
path, request = sys.argv[1], json.loads(sys.argv[2])
frames = [{"id": 0, "cmd": "hello", "args": {"protocol": 1}}, dict(request, id=1)]
try:
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(20)
    s.connect(path)
    s.sendall(("\n".join(json.dumps(f) for f in frames) + "\n").encode())
    buffer = b""
    while b"\n" not in buffer or buffer.count(b"\n") < 2:
        chunk = s.recv(65536)
        if not chunk:
            break
        buffer += chunk
    s.close()
except OSError as error:
    print(json.dumps({"unreachable": str(error)}))
    raise SystemExit
for line in buffer.decode(errors="replace").splitlines():
    try:
        frame = json.loads(line)
    except ValueError:
        continue
    if frame.get("id") == 1:
        print(json.dumps(frame))
        break
else:
    print(json.dumps({"missing": "no reply frame for id 1"}))
PY
}

# One protocol exchange over the stdio transport, the way an SSH client does it:
# `--stdio --attach` must attach to the daemon already serving this folder and
# relay the frames to it. `--attach` rather than a plain `--stdio` on purpose:
# without a running daemon it fails instead of quietly starting a second host,
# so a reply here proves the frames went through the stdio transport to the
# real daemon.
# stdio_speak <data folder> <json request>: prints the reply frame for id 1.
stdio_speak() {
  /usr/bin/python3 -I - "$DAEMON" "$1" "$2" <<'PY'
import json, subprocess, sys
daemon, data, request = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
frames = [{"id": 0, "cmd": "hello", "args": {"protocol": 1}}, dict(request, id=1)]
payload = "\n".join(json.dumps(frame) for frame in frames) + "\n"
try:
    done = subprocess.run(
        [daemon, "--stdio", "--attach", "--data-dir", data],
        input=payload, capture_output=True, text=True, timeout=120)
except subprocess.TimeoutExpired:
    print(json.dumps({"transport": "the --stdio session did not exit within 120s"}))
    raise SystemExit
except OSError as error:
    print(json.dumps({"transport": str(error)}))
    raise SystemExit
for line in done.stdout.splitlines():
    try:
        frame = json.loads(line)
    except ValueError:
        continue
    if frame.get("id") == 1:
        print(json.dumps(frame))
        raise SystemExit
detail = done.stderr.strip().splitlines()[-1:] or [""]
print(json.dumps({"transport": "no reply frame for id 1 over --stdio (exit %d): %s"
                  % (done.returncode, detail[0][:200])}))
PY
}

# The protected state of an isolated folder, as the protected daemon reports it.
protected_state() { # <data folder>
  speak "$1" '{"cmd":"assistant_tasks_list","args":{"owner":{"workspaceId":"acceptance","cwd":"/tmp","hostId":"acceptance","conversationId":"acceptance"}}}'
}

# Size and mtime of the broker's journal: read-only evidence that a refused
# attempt recorded nothing. Metadata only; the file itself is root-only.
journal_stamp() {
  if [[ -f "$JOURNAL" ]]; then /usr/bin/stat -f '%z:%m' "$JOURNAL" 2>/dev/null; else echo none; fi
}

# ---------------------------------------------------------------- the checks

static_signatures() {
  local pair image id
  for pair in "app:$APP" "daemon:$DAEMON" "broker:$BROKER"; do
    id="static.signature.${pair%%:*}"
    image=${pair#*:}
    [[ -e "$image" ]] || { skip_check "$id" "not installed: $image"; continue; }
    if /usr/bin/codesign --verify --strict -R='anchor apple generic' "$image" >"$WORK/sign.out" 2>&1; then
      pass_check "$id" "codesign --verify --strict -R='anchor apple generic' accepted $image"
    else
      fail_check "$id" "$(headline "$WORK/sign.out")"
    fi
  done
  if [[ -d "$APP" ]]; then
    if /usr/bin/codesign --verify --deep --strict "$APP" >"$WORK/deep.out" 2>&1; then
      pass_check "static.signature.app-deep" "codesign --verify --deep --strict accepted every nested resource in the app"
    else
      fail_check "static.signature.app-deep" "$(headline "$WORK/deep.out")"
    fi
  else
    skip_check "static.signature.app-deep" "not installed: $APP"
  fi
}

static_runtime() {
  local pair image id details
  for pair in "app:$APP" "daemon:$DAEMON" "broker:$BROKER"; do
    id="static.hardened-runtime.${pair%%:*}"
    image=${pair#*:}
    [[ -e "$image" ]] || { skip_check "$id" "not installed: $image"; continue; }
    details=$(/usr/bin/codesign -d --verbose=4 "$image" 2>&1)
    if [[ "$details" == *'(runtime)'* ]]; then
      pass_check "$id" "hardened runtime flag set on $(/usr/bin/basename "$image")"
    else
      fail_check "$id" "codesign reports no hardened runtime for $image"
    fi
  done
  static_fuses "$APP" static.fuses
  static_fuses "$INSTALLED_APP" static.fuses.installed
}

static_fuses() {
  local app=$1 id=$2
  if [[ ! -d "$app" ]]; then
    skip_check "$id" "not installed: $app"
    return
  fi
  # Every architecture slice, every fuse: the installer's rule applied to the
  # installed copy rather than to the one being installed.
  local fuses
  fuses=$(/usr/bin/python3 -I - "$app" <<'PY'
import os, sys
root = os.path.realpath(sys.argv[1])
framework = os.path.join(root, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')
try:
    blob = open(framework, 'rb').read()
except OSError as error:
    print('FAIL missing Electron Framework: %s' % error); raise SystemExit
sentinel = b'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
start = slices = 0
wires = []
while True:
    at = blob.find(sentinel, start)
    if at < 0:
        break
    at += len(sentinel)
    slices += 1
    if len(blob) < at + 8 or blob[at] != 1 or blob[at + 1] < 6:
        print('FAIL slice %d has an unsupported fuse wire' % slices); raise SystemExit
    wire = blob[at + 2:at + 2 + blob[at + 1]]
    wires.append(''.join(chr(b) for b in wire))
    start = at + 2 + blob[at + 1]
if not slices:
    print('FAIL no Electron fuse wire in the framework'); raise SystemExit
bad = [w for w in wires if any(w[i] != '0' for i in (0, 2, 3)) or any(w[i] != '1' for i in (4, 5))]
if bad:
    print('FAIL unsafe fuses %s' % ', '.join(bad)); raise SystemExit
print('OK %d slice(s): %s' % (slices, ', '.join(wires)))
PY
)
  case "$fuses" in
    OK*) pass_check "$id" "${fuses#OK }" ;;
    *) fail_check "$id" "${fuses#FAIL }" ;;
  esac
}

static_entitlements() {
  local pair image id verdict
  for pair in "app:$APP" "daemon:$DAEMON" "broker:$BROKER"; do
    id="static.entitlements.${pair%%:*}"
    image=${pair#*:}
    [[ -e "$image" ]] || { skip_check "$id" "not installed: $image"; continue; }
    # stdout only: the deprecated ':-' spelling warns on stderr.
    /usr/bin/codesign -d --entitlements :- "$image" 2>/dev/null > "$WORK/ent.plist"
    verdict=$(/usr/bin/python3 -I - "$WORK/ent.plist" <<'PY'
import plistlib, sys
banned = {
    'com.apple.security.get-task-allow': 'debugger attach',
    'com.apple.security.cs.disable-library-validation': 'unvalidated code injection',
    'com.apple.security.cs.allow-dyld-environment-variables': 'DYLD environment injection',
    'com.apple.security.cs.allow-unsigned-executable-memory': 'unsigned executable memory',
    'com.apple.security.cs.allow-unsafe-executable-memory': 'unsafe executable memory',
    'com.apple.security.cs.debugger': 'debugger attach',
}
raw = open(sys.argv[1], 'rb').read()
if not raw.strip():
    print('OK no entitlements'); raise SystemExit
try:
    values = plistlib.loads(raw)
except Exception as error:
    print('FAIL unreadable entitlements: %s' % error); raise SystemExit
if not isinstance(values, dict):
    print('FAIL entitlements are not a dictionary'); raise SystemExit
found = sorted(k for k in banned if values.get(k))
if found:
    print('FAIL %s' % ', '.join('%s (%s)' % (k, banned[k]) for k in found)); raise SystemExit
print('OK %s' % (', '.join(sorted(values)) or 'none'))
PY
)
    case "$verdict" in
      OK*) pass_check "$id" "${verdict#OK }" ;;
      *) fail_check "$id" "${verdict#FAIL }" ;;
    esac
  done
}

static_ownership() {
  if [[ ! -e "$APP" && ! -e "$BROKER" ]]; then
    skip_check "static.ownership" "not installed: $ROOT"
    skip_check "static.symlinks" "not installed: $APP"
    return
  fi
  local verdict
  verdict=$(/usr/bin/python3 -I - "$ROOT" "$APP" "$DAEMON" "$BROKER" <<'PY'
import os, sys
problems = []
for target in sys.argv[1:]:
    path = os.path.abspath(target)
    if not os.path.lexists(path):
        problems.append('missing %s' % path)
        continue
    current = path
    while True:
        st = os.lstat(current)
        if os.path.islink(current):
            problems.append('symlink in the path: %s' % current)
        elif st.st_uid != 0:
            problems.append('%s is owned by uid %d' % (current, st.st_uid))
        elif st.st_mode & 0o022:
            problems.append('%s is group or world writable (mode %o)' % (current, st.st_mode & 0o777))
        if current == '/':
            break
        current = os.path.dirname(current)
print('OK' if not problems else 'FAIL ' + '; '.join(problems[:6]))
PY
)
  case "$verdict" in
    OK*) pass_check "static.ownership" "every path component of the protected tree, app, daemon and broker is root-owned and closed to group and world writes" ;;
    *) fail_check "static.ownership" "${verdict#FAIL }" ;;
  esac
  if [[ ! -d "$APP" ]]; then
    skip_check "static.symlinks" "not installed: $APP"
    return
  fi
  local links
  links=$(/usr/bin/python3 -I - "$APP" <<'PY'
import os, sys
root = os.path.realpath(sys.argv[1])
escaping = []
count = 0
for base, dirs, files in os.walk(root, followlinks=False):
    for name in dirs + files:
        path = os.path.join(base, name)
        if os.path.islink(path):
            count += 1
            if os.path.commonpath([root, os.path.realpath(path)]) != root:
                escaping.append(path)
print('OK %d symlink(s) in the bundle, none escaping' % count if not escaping else 'FAIL escaping: ' + ', '.join(escaping[:4]))
PY
)
  case "$links" in
    OK*) pass_check "static.symlinks" "${links#OK }" ;;
    *) fail_check "static.symlinks" "${links#FAIL }" ;;
  esac
}

static_pins() {
  # The pin file is root-only by design, and this harness never uses sudo.
  if [[ ! -e "$PIN_FILE" ]]; then
    skip_check "static.cdhash-pins" "no pin file at $PIN_FILE"
    return
  fi
  if [[ ! -r "$PIN_FILE" ]]; then
    skip_check "static.cdhash-pins" "$PIN_FILE is root-only by design, so the pinned CDHashes cannot be read without sudo; the broker enforces them on every connection (see positive.trusted-daemon)"
    return
  fi
  local pinned ui daemon got_ui got_daemon
  pinned=$(/usr/bin/python3 -I - "$PIN_FILE" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print('%s %s' % (data.get('uiCdhash', ''), data.get('daemonCdhash', '')))
except Exception as error:
    print('FAIL %s' % error)
PY
)
  case "$pinned" in
    FAIL*) fail_check "static.cdhash-pins" "${pinned#FAIL }"; return ;;
  esac
  read -r ui daemon <<<"$pinned"
  got_ui=$(/usr/bin/codesign -d --verbose=4 "$APP" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2}')
  got_daemon=$(/usr/bin/codesign -d --verbose=4 "$DAEMON" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{print $2}')
  if [[ -n "$ui" && "$got_ui" == "$ui" && "$got_daemon" == "$daemon" ]]; then
    pass_check "static.cdhash-pins" "installed UI $got_ui and daemon $got_daemon match the pins"
  else
    fail_check "static.cdhash-pins" "installed UI=$got_ui daemon=$got_daemon, pinned UI=$ui daemon=$daemon"
  fi
}

static_keys() {
  # Keys, pin file and journal: root-only, no ACL, exactly the modes the broker
  # itself refuses to use otherwise.
  local verdict
  verdict=$(/usr/bin/python3 -I - "$ROOT/private-key" "$ROOT/public-key" "$PIN_FILE" "$JOURNAL" <<'PY'
import os, subprocess, sys
problems = []
for path in sys.argv[1:]:
    name = os.path.basename(path)
    if not os.path.exists(path):
        problems.append('missing %s' % name)
        continue
    st = os.lstat(path)
    if st.st_uid != 0:
        problems.append('%s is owned by uid %d' % (name, st.st_uid))
    if name in ('private-key', 'config.json', 'journal.json') and st.st_mode & 0o077:
        problems.append('%s is reachable by another user (mode %o)' % (name, st.st_mode & 0o777))
    if name == 'public-key' and st.st_mode & 0o022:
        problems.append('%s is writable by group or world' % name)
    listing = subprocess.run(['/bin/ls', '-lde', path], capture_output=True, text=True).stdout.splitlines()
    if len(listing) > 1:
        problems.append('%s carries an ACL: %s' % (name, ' '.join(line.strip() for line in listing[1:])))
print('OK' if not problems else 'FAIL ' + '; '.join(problems[:6]))
PY
)
  case "$verdict" in
    OK*) pass_check "static.keys-and-acls" "private-key, public-key, config.json and journal.json are root-owned with no ACL and modes that keep other users out" ;;
    *) fail_check "static.keys-and-acls" "${verdict#FAIL }" ;;
  esac
}

static_broker() {
  local state
  state=$(/bin/launchctl print "system/$BROKER_JOB" 2>&1)
  if [[ "$state" == *'state = running'* ]]; then
    pass_check "static.broker-job" "launchd: system/$BROKER_JOB is running"
  else
    fail_check "static.broker-job" "launchd has no running system/$BROKER_JOB: $(/usr/bin/head -2 <<<"$state" | /usr/bin/tr '\n' ' ')"
  fi
  if [[ -S "$BROKER_SOCKET" ]]; then
    pass_check "static.broker-socket" "socket present: $BROKER_SOCKET"
  else
    fail_check "static.broker-socket" "no socket at $BROKER_SOCKET"
  fi
}

launch_agent() {
  if [[ ! -e "$AGENT_PLIST" ]]; then
    skip_check "launchagent.daemon-path" "no LaunchAgent at $AGENT_PLIST, so the app runs its own daemon"
    return
  fi
  local program
  program=$(/usr/bin/python3 -I - "$AGENT_PLIST" <<'PY'
import plistlib, sys
try:
    data = plistlib.load(open(sys.argv[1], 'rb'))
except Exception as error:
    print('FAIL %s' % error); raise SystemExit
args = data.get('ProgramArguments') or []
print(args[0] if args else 'FAIL no ProgramArguments')
PY
)
  case "$program" in
    FAIL*) fail_check "launchagent.daemon-path" "${program#FAIL }" ;;
    "$DAEMON") pass_check "launchagent.daemon-path" "the LaunchAgent runs the protected daemon at $DAEMON" ;;
    *) fail_check "launchagent.daemon-path" "the LaunchAgent runs $program, not the protected daemon at $DAEMON; launching the /Applications app rewrites it. Report only: this harness changed nothing" ;;
  esac
}

# The three negative checks that need a protected daemon to talk to, sharing
# one isolated folder so the before/after comparison is about the same state.
negative_suite() {
  if [[ ! -x "$DAEMON" ]]; then
    skip_check "negative.raw-socket-issue" "not installed: $DAEMON"
    skip_check "negative.stdio-protected-command" "not installed: $DAEMON"
    return
  fi
  if ! start_daemon "$DAEMON" "$WORK/neg-data" "neg-daemon"; then
    local why
    why=$(headline "$WORK/neg-daemon.log")
    skip_check "negative.raw-socket-issue" "the protected daemon did not start: $why"
    skip_check "negative.stdio-protected-command" "the protected daemon did not start: $why"
    return
  fi
  local before after journal_before journal_after reply

  # 1. A shell process, not the pinned UI: the broker must refuse.
  before=$(protected_state "$WORK/neg-data")
  journal_before=$(journal_stamp)
  reply=$(/usr/bin/python3 -I - <<'PY'
import json, socket
request = {"op": "issue", "dataDir": "/tmp/apex-acceptance-not-authorized",
           "command": {"cmd": "assistant_message", "args": {"requestId": "acceptance-raw-socket"}}}
try:
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(10)
    s.connect('/var/run/dev.apexdeck.provenance.sock')
    s.sendall((json.dumps(request) + "\n").encode())
    print(s.recv(65536).decode(errors="replace").strip())
except OSError as error:
    print(json.dumps({"transport": str(error)}))
PY
)
  journal_after=$(journal_stamp)
  after=$(protected_state "$WORK/neg-data")
  if [[ "$reply" == *'"error"'* && "$reply" != *'"payload"'* ]]; then
    if [[ "$before" != "$after" ]]; then
      fail_check "negative.raw-socket-issue" "the isolated protected state changed after a refused issue: $before -> $after"
    elif [[ "$journal_before" == "$journal_after" ]]; then
      pass_check "negative.raw-socket-issue" "refused ($(python_text "$reply")) and recorded nothing: isolated protected state and broker journal unchanged"
    else
      pass_check "negative.raw-socket-issue" "refused ($(python_text "$reply")); isolated protected state unchanged (the broker journal changed during the check, so its stamp is not evidence)"
    fi
  else
    fail_check "negative.raw-socket-issue" "expected a refusal, got: $reply"
  fi

  # 2. A protected submission over the stdio transport (`--stdio --attach`, what
  # an SSH client uses) without a receipt. Not the socket: the point of this
  # check is that the other transport refuses too.
  before=$(protected_state "$WORK/neg-data")
  reply=$(stdio_speak "$WORK/neg-data" '{"cmd":"assistant_message","args":{"requestId":"acceptance-stdio","workspaceId":"acceptance","cwd":"/tmp","hostId":"acceptance","conversationId":"acceptance","assistantId":"acceptance","text":"acceptance harness"}}')
  after=$(protected_state "$WORK/neg-data")
  if [[ "$reply" == *'"transport"'* ]]; then
    fail_check "negative.stdio-protected-command" "the stdio transport did not answer: $(python_text "$reply")"
  elif [[ "$reply" == *'"err"'* && "$reply" == *'protected provenance receipt'* ]]; then
    if [[ "$before" == "$after" ]]; then
      pass_check "negative.stdio-protected-command" "refused over --stdio --attach: $(python_text "$reply")"
    else
      fail_check "negative.stdio-protected-command" "the protected state changed after a refused stdio command: $before -> $after"
    fi
  else
    fail_check "negative.stdio-protected-command" "expected a receipt refusal over --stdio, got: $reply"
  fi
  stop_daemon

  # 3. The same bytes from a user-owned path: the pin matches, the path does not.
  local copy="$WORK/copied/apex-daemon"
  /bin/mkdir -p "$WORK/copied"
  if ! /bin/cp "$DAEMON" "$copy" 2>/dev/null; then
    fail_check "negative.copied-daemon" "could not copy the protected daemon into $WORK"
    return
  fi
  if ! start_daemon "$copy" "$WORK/copied-data" "copied-daemon"; then
    fail_check "negative.copied-daemon" "the copied daemon did not start: $(headline "$WORK/copied-daemon.log")"
    return
  fi
  local listing
  listing=$(protected_state "$WORK/copied-data")
  if /usr/bin/grep -q 'require the pinned daemon' "$WORK/copied-daemon.log"; then
    pass_check "negative.copied-daemon" "refused: $(/usr/bin/grep -m1 -o 'protected ledgers unavailable ([^)]*)' "$WORK/copied-daemon.log")"
  else
    fail_check "negative.copied-daemon" "a user-owned copy of the protected daemon was not refused: $(headline "$WORK/copied-daemon.log")"
  fi
  stop_daemon
  if [[ "$listing" == *'"ok"'* ]]; then
    pass_check "negative.copied-daemon-serves" "the refused daemon still serves its own socket, as designed, over empty ledgers: $listing"
  else
    fail_check "negative.copied-daemon-serves" "the refused daemon did not answer its own socket: $listing"
  fi
}

# The /Applications daemon, but only when that build contains the broker client.
negative_installed_daemon() {
  if [[ ! -x "$INSTALLED_DAEMON" ]]; then
    skip_check "negative.installed-daemon" "no daemon at $INSTALLED_DAEMON"
    return
  fi
  if ! has_text "$INSTALLED_DAEMON" 'dev.apexdeck.provenance'; then
    skip_check "negative.installed-daemon" "the installed /Applications build predates the provenance broker and has no broker client to refuse; re-run after installing a gate build"
    return
  fi
  if ! start_daemon "$INSTALLED_DAEMON" "$WORK/installed-data" "installed-daemon"; then
    fail_check "negative.installed-daemon" "the installed daemon did not start: $(headline "$WORK/installed-daemon.log")"
    return
  fi
  local answered
  answered=$(protected_state "$WORK/installed-data")
  if /usr/bin/grep -q 'require the pinned daemon' "$WORK/installed-daemon.log"; then
    pass_check "negative.installed-daemon" "refused and still serving, with empty ledgers: $(/usr/bin/grep -m1 -o 'protected ledgers unavailable ([^)]*)' "$WORK/installed-daemon.log")"
  else
    fail_check "negative.installed-daemon" "the /Applications daemon was not refused: $(headline "$WORK/installed-daemon.log")"
  fi
  stop_daemon
  if [[ "$answered" == *'"ok"'* ]]; then
    pass_check "negative.installed-daemon-serves" "the refused /Applications daemon still answers, over empty ledgers (G1): $answered"
  else
    fail_check "negative.installed-daemon-serves" "the refused /Applications daemon did not start serving (the G1 startup crash): $answered"
  fi
}

positive_trusted_daemon() {
  if [[ ! -x "$DAEMON" ]]; then
    skip_check "positive.trusted-daemon" "not installed: $DAEMON"
    skip_check "positive.protected-read" "not installed: $DAEMON"
    return
  fi
  if ! start_daemon "$DAEMON" "$WORK/pos-data" "trusted-daemon"; then
    fail_check "positive.trusted-daemon" "the protected daemon did not start: $(headline "$WORK/trusted-daemon.log")"
    skip_check "positive.protected-read" "the protected daemon did not start"
    return
  fi
  local unavailable reply
  unavailable=$(/usr/bin/grep -c 'protected ledgers unavailable' "$WORK/trusted-daemon.log")
  if [[ "$unavailable" == 0 ]]; then
    pass_check "positive.trusted-daemon" "the protected daemon starts with every protected ledger served through the root broker"
  else
    fail_check "positive.trusted-daemon" "$(/usr/bin/grep -m1 'protected ledgers unavailable' "$WORK/trusted-daemon.log")"
  fi
  reply=$(protected_state "$WORK/pos-data")
  stop_daemon
  if [[ "$reply" == *'"ok"'* && "$reply" != *'require the pinned daemon'* && "$reply" != *'unavailable'* ]]; then
    pass_check "positive.protected-read" "the protected task ledger answered through the broker: $reply"
  else
    fail_check "positive.protected-read" "the protected ledger did not answer through the broker: $reply"
  fi
}

tamper_forged_json() {
  local id="tamper.forged-user-json"
  local fixture="$REPO/crates/apex-host/tests/fixtures/forged-assistant-tasks-v1.json"
  if [[ ! -x "$DAEMON" ]]; then
    skip_check "$id" "not installed: $DAEMON"
    return
  fi
  if [[ ! -f "$fixture" ]]; then
    fail_check "$id" "missing fixture $fixture; it is the same file apex-host parses in acceptance_tamper_fixture_is_a_valid_forged_ledger"
    return
  fi
  local data="$WORK/tamper-data" first second verdict
  /bin/mkdir -p "$data"
  if ! /bin/cp "$fixture" "$data/assistant-tasks-v1.json"; then
    fail_check "$id" "could not plant the fixture at $data/assistant-tasks-v1.json"
    return
  fi
  if ! start_daemon "$DAEMON" "$data" "tamper-daemon"; then
    fail_check "$id" "the protected daemon did not start over a forged file: $(headline "$WORK/tamper-daemon.log")"
    return
  fi
  first=$(protected_state "$data")
  stop_daemon
  if /usr/bin/grep -q 'protected ledgers unavailable' "$WORK/tamper-daemon.log"; then
    fail_check "$id" "first start: protected ledgers unavailable; an empty fallback is not evidence that protected state won"
    return
  fi
  # A second start over the same forged file: one start could plausibly ignore
  # it and a later start adopt it, so both are compared.
  if ! start_daemon "$DAEMON" "$data" "tamper-daemon-again"; then
    fail_check "$id" "the protected daemon did not restart over the forged file: $(headline "$WORK/tamper-daemon-again.log")"
    return
  fi
  second=$(protected_state "$data")
  stop_daemon
  if /usr/bin/grep -q 'protected ledgers unavailable' "$WORK/tamper-daemon-again.log"; then
    fail_check "$id" "restart: protected ledgers unavailable; an empty fallback is not evidence that protected state won"
    return
  fi
  verdict=$(/usr/bin/python3 -I - "$first" "$second" "$fixture" "$data/assistant-tasks-v1.json" <<'PY'
import json, sys
first, second, fixture, planted = sys.argv[1:5]
# The exact protected ledger for this workspace. The forged file may not change
# a single field of it: not the revision, not the task list, nothing.
expected = {"workspaceId": "acceptance", "revision": 0, "tasks": [], "executions": [],
            "routingThreads": [], "namedOnlyWorkerIds": []}
forged = json.load(open(fixture, encoding='utf-8'))
task_id = next(iter(forged["tasks"]))
def answer(text):
    frame = json.loads(text)
    return frame.get("ok", frame.get("err") or frame.get("transport"))
try:
    answers = [answer(first), answer(second)]
except ValueError:
    print("FAIL a reply was not JSON: %s" % (first or second)[:200]); raise SystemExit
for start, value in enumerate(answers, 1):
    if not isinstance(value, dict):
        print("FAIL start %d did not answer with a ledger: %s" % (start, value)); raise SystemExit
    if value != expected:
        print("FAIL start %d answered %s; the protected ledger is %s"
              % (start, json.dumps(value, sort_keys=True)[:300], json.dumps(expected, sort_keys=True)))
        raise SystemExit
if open(planted, 'rb').read() != open(fixture, 'rb').read():
    print("FAIL the planted file was rewritten, so the comparison above proves nothing"); raise SystemExit
print("PASS a valid forged ledger (revision %d, task %s) was ignored across a restart: both starts "
      "answered the protected ledger exactly (revision 0, no tasks) and the planted file was left untouched"
      % (forged["revision"], task_id))
PY
)
  case "$verdict" in
    PASS\ *) pass_check "$id" "${verdict#PASS }" ;;
    FAIL\ *) fail_check "$id" "${verdict#FAIL }" ;;
    *) fail_check "$id" "unexpected verdict: ${verdict:-empty}" ;;
  esac
}

skips() {
  skip_check "positive.protected-write" "a protected write needs a receipt only the pinned UI can obtain, so it cannot be driven from a shell; covered by the final trusted-UI smoke test"
  skip_check "skip.full-access" "Full access edits, builds, Git, network and subprocesses need the signed UI window: covered by the final smoke test"
  skip_check "skip.remote-coding" "ordinary remote coding compatibility needs a paired device and the signed UI: covered separately"
  skip_check "skip.ui-issued" "UI-issued intents and approvals need the signed window: covered by the final smoke test"
  skip_check "skip.native-cli" "native CLI integration acceptance is 'npm run test:e2e' once the reviewed migration lands; this harness does not run it"
  skip_check "skip.installed-import" "the legacy import needs the trusted UI window to preview and confirm: covered by the install checkpoint"
}

python_text() { /usr/bin/python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); print(d.get("err") or d.get("error") or d.get("transport") or d.get("missing") or "")' "$1" 2>/dev/null; }

# What produced this evidence. A run from a dirty tree says so, because the
# numbers then describe this folder, not a commit anyone can check out.
source_stamp() {
  local git binary
  binary=$(command -v git || echo /usr/bin/git)
  SOURCE_COMMIT=$("$binary" -C "$REPO" rev-parse HEAD 2>/dev/null) || SOURCE_COMMIT=''
  SOURCE_COMMIT=${SOURCE_COMMIT:-unknown}
  SOURCE_BRANCH=$("$binary" -C "$REPO" symbolic-ref --short -q HEAD 2>/dev/null) || SOURCE_BRANCH=''
  SOURCE_BRANCH=${SOURCE_BRANCH:-detached}
  SOURCE_DIRTY=$("$binary" -C "$REPO" status --porcelain 2>/dev/null | /usr/bin/wc -l | /usr/bin/tr -d ' ')
  [[ "$SOURCE_DIRTY" =~ ^[0-9]+$ ]] || SOURCE_DIRTY=''
  SOURCE_HARNESS_SHA=$(/usr/bin/shasum -a 256 "$0" 2>/dev/null | /usr/bin/awk '{print $1}')
  SOURCE_HARNESS_SHA=${SOURCE_HARNESS_SHA:-unknown}
  # An absolute path, so the evidence says which script even when the caller
  # used a relative one.
  SOURCE_HARNESS_PATH="$(cd "$(/usr/bin/dirname "$0")" && pwd)/$(/usr/bin/basename "$0")"
}
source_stamp

# ------------------------------------------------------------------- report

echo "Apex Deck provenance acceptance, $(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "source:         $SOURCE_BRANCH $SOURCE_COMMIT (uncommitted files: ${SOURCE_DIRTY:-unknown})"
echo "harness:        $SOURCE_HARNESS_SHA"
echo "protected copy: $APP"
echo "isolated work:  $WORK (deleted on exit unless --keep)"
echo

static_signatures
static_runtime
static_entitlements
static_ownership
static_pins
static_keys
static_broker
launch_agent
negative_suite
negative_installed_daemon
positive_trusted_daemon
tamper_forged_json
skips

/usr/bin/awk -F'\t' '{ printf "%-5s %-40s %s\n", $2, $1, $3 }' "$TABLE"
echo
/usr/bin/awk -F'\t' '{ n[$2]++ } END { printf "PASS %d  FAIL %d  SKIP %d  (of %d checks)\n", n["PASS"] + 0, n["FAIL"] + 0, n["SKIP"] + 0, NR }' "$TABLE"

/bin/mkdir -p "$(dirname "$EVIDENCE")"
/usr/bin/python3 -I - "$TABLE" "$EVIDENCE" "$APP" "$INSTALLED_APP" "$KEEP" "$WORK" "$SOURCE_COMMIT" "$SOURCE_BRANCH" "$SOURCE_DIRTY" "$SOURCE_HARNESS_SHA" "$SOURCE_HARNESS_PATH" <<'PY'
import json, os, platform, plistlib, subprocess, sys, time

table, evidence, app, installed, keep, work = sys.argv[1:7]
commit, branch, dirty, harness_sha, harness_path = sys.argv[7:12]
checks = []
with open(table, encoding='utf-8') as lines:
    for line in lines:
        parts = line.rstrip('\n').split('\t')
        if len(parts) == 3:
            checks.append({'id': parts[0], 'status': parts[1], 'detail': parts[2]})


def version(bundle):
    try:
        with open(os.path.join(bundle, 'Contents/Info.plist'), 'rb') as handle:
            return plistlib.load(handle).get('CFBundleShortVersionString')
    except OSError:
        return None


def daemon_version(binary):
    try:
        out = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=30)
        return (out.stdout + out.stderr).strip() or None
    except OSError:
        return None


counts = {name: sum(1 for c in checks if c['status'] == name) for name in ('PASS', 'FAIL', 'SKIP')}
document = {
    'kind': 'apex-deck-provenance-acceptance',
    'schemaVersion': 1,
    'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'checklist': 'docs/security/provenance-boundary.md#test-seams-and-remaining-acceptance',
    # Which source tree this describes. Read `dirty` before quoting a commit:
    # a dirty run is evidence about a working folder, not about that commit.
    'source': {
        'commit': commit,
        'branch': branch,
        'dirty': dirty != '0',
        'uncommittedFiles': int(dirty) if dirty.isdigit() else None,
        'harnessPath': harness_path,
        'harnessSha256': harness_sha,
    },
    'user': os.environ.get('USER'),
    'host': platform.node(),
    'macos': platform.mac_ver()[0],
    'protectedApp': {
        'path': app,
        'version': version(app),
        'daemon': daemon_version(os.path.join(app, 'Contents/Resources/bin/apex-daemon')),
    },
    'installedApp': {
        'path': installed,
        'version': version(installed),
        'daemon': daemon_version(os.path.join(installed, 'Contents/Resources/bin/apex-daemon')),
    },
    'isolatedWorkFolder': work if keep == '1' else 'deleted on exit',
    'summary': counts,
    'passed': counts['FAIL'] == 0,
    'checks': checks,
}
with open(evidence, 'w', encoding='utf-8') as handle:
    json.dump(document, handle, indent=2)
    handle.write('\n')
print('evidence: %s' % evidence)
PY

if /usr/bin/awk -F'\t' '$2 == "FAIL" { found = 1 } END { exit !found }' "$TABLE"; then
  exit 1
fi
exit 0
