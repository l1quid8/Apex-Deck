#!/usr/bin/python3
"""Explicit macOS administrator transaction; never installs or resets authority."""
import fcntl
import ctypes
import hashlib
import json
import os
import plistlib
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path('/Library/Application Support/Apex Deck Provenance')
PRODUCTION = ROOT / 'TrustedUI/Apex Deck.app'
DEV_ROOT = ROOT / 'TrustedDev'
DEV_APP = DEV_ROOT / 'Apex Deck.app'
STATE = DEV_ROOT / 'state.json'
CONFIG = ROOT / 'config.json'
BROKER = 'system/dev.apexdeck.provenance'
BROKER_PLIST = Path('/Library/LaunchDaemons/dev.apexdeck.provenance.plist')
PROD_LABEL = 'dev.apexdeck.daemon'
DEV_LABEL = 'dev.apexdeck.trusted-dev'
CLEAN_ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'}


def run(*args, required=True):
    result = subprocess.run(list(map(str, args)), env=CLEAN_ENV, capture_output=True,
                            text=True, timeout=45)
    if required and result.returncode:
        raise RuntimeError(json.dumps(list(map(str, args))) + ': ' + result.stderr.strip())
    return result


def read_json(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Expected a regular JSON record: ' + str(path))
    return json.loads(path.read_bytes())


def atomic_json(path, value):
    if path.is_symlink():
        raise RuntimeError('Refusing linked record: ' + str(path))
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write((json.dumps(value, sort_keys=True) + '\n').encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if temporary.exists():
            temporary.unlink()


def protected(path):
    for part in (path, *path.parents):
        st = part.lstat()
        if stat.S_ISLNK(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Not a root-protected path: ' + str(part))


def dev_config(original, pins):
    if not all(re.fullmatch('[a-f0-9]{40}', pins.get(k, '')) for k in ('ui', 'daemon', 'cli')):
        raise RuntimeError('Invalid exact dev signature pins')
    if not all(re.fullmatch('[a-f0-9]{40}', original.get(k, '')) for k in ('uiCdhash', 'daemonCdhash')):
        raise RuntimeError('Invalid production pins')
    return dict(original, uiCdhash=pins['ui'], daemonCdhash=pins['daemon'], cliCdhash=pins['cli'])


def activate(system, pins, identity):
    if system.read_state() is not None:
        raise RuntimeError('Dev mode or recovery is already active; run desktop:dev:stop first.')
    original = system.read_config()
    state = dict(identity, production=original, dev=dev_config(original, pins), phase='prepared')
    system.save_state(state)
    try:
        system.stop_service('production')
        system.write_config(state['dev'])
        system.reload_broker()
        system.start_service('dev')
        system.verify('dev')
        state['phase'] = 'active'
        system.save_state(state)
    except BaseException as error:
        try:
            system.stop_service('dev')
            system.write_config(original)
            system.reload_broker()
            system.start_service('production')
            system.verify('production')
            system.clear_state()
        except BaseException as recovery:
            raise RuntimeError('Activation failed: %s. Recovery incomplete: %s. Keep state and run desktop:dev:stop.' % (error, recovery)) from error
        raise


def restore(system):
    state = system.read_state()
    if state is None:
        return
    current = system.read_config()
    if current not in (state['dev'], state['production']):
        raise RuntimeError('Trust pins changed outside dev mode; refusing to overwrite them. Recovery state retained.')
    system.stop_service('dev')
    system.write_config(state['production'])
    system.reload_broker()
    system.start_service('production')
    system.verify('production')
    system.clear_state()


def hash_file(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Expected a regular artifact: ' + str(path))
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def cdhash(image):
    details = run('/usr/bin/codesign', '-d', '--verbose=4', image)
    match = re.search(r'^CDHash=([a-f0-9]{40})$', details.stderr, re.M)
    if not match:
        raise RuntimeError('Missing signed CDHash: ' + str(image))
    return match[1]


def signing_team(image):
    details = run('/usr/bin/codesign', '-d', '--verbose=4', image)
    match = re.search(r'^TeamIdentifier=([A-Z0-9]+)$', details.stderr, re.M)
    if not match:
        raise RuntimeError('Developer ID signing team absent')
    return match[1]


def validate_app(app, team):
    protected(app)
    root = app.resolve()
    for base, dirs, files in os.walk(app, followlinks=False):
        for name in dirs + files:
            p = Path(base) / name
            if p.is_symlink():
                resolved = p.resolve(strict=True)
                if os.path.commonpath([str(root), str(resolved)]) != str(root):
                    raise RuntimeError('Bundle symlink escapes protected app')
            else:
                protected(p)
    requirement = 'anchor apple generic and certificate leaf[subject.OU] = "%s"' % team
    pins = {}
    for role, image in (('ui', app), ('daemon', app / 'Contents/Resources/bin/apex-daemon'),
                        ('cli', app / 'Contents/Resources/bin/apex')):
        run('/usr/bin/codesign', '--verify', '--strict', '-R=' + requirement, image)
        details = run('/usr/bin/codesign', '-d', '--verbose=4', image).stderr
        if '(runtime)' not in details:
            raise RuntimeError('Hardened runtime absent')
        ent = run('/usr/bin/codesign', '-d', '--entitlements', '-', '--xml', image).stdout
        values = plistlib.loads(ent.encode()) if ent.strip() else {}
        for key in ('com.apple.security.get-task-allow', 'com.apple.security.cs.disable-library-validation',
                    'com.apple.security.cs.allow-dyld-environment-variables', 'com.apple.security.cs.allow-unsigned-executable-memory'):
            if values.get(key):
                raise RuntimeError('Unsafe entitlement: ' + key)
        pins[role] = cdhash(image)
    verifier = PRODUCTION / 'Contents/Resources/updater/verify-protected-bundle.sh'
    protected(verifier)
    run('/bin/bash', verifier, app, pins['ui'], pins['daemon'])
    run('/usr/bin/codesign', '--verify', '--strict', '-R=identifier "dev.apexdeck.cli"', app / 'Contents/Resources/bin/apex')
    run('/usr/bin/codesign', '--verify', '--strict', '-R=identifier "apex-daemon"', app / 'Contents/Resources/bin/apex-daemon')
    return pins


def rpc(data, cmd, args=None, with_welcome=False):
    endpoint = data / 'daemon.sock'
    # The supported live folder fits the Unix path limit. No alternate endpoint
    # or user-chosen host is accepted by this administrator helper.
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(8)
        client.connect(str(endpoint))
        client.sendall((json.dumps({'id': 0, 'cmd': 'hello', 'args': {'protocol': 1}}) + '\n' +
                        json.dumps({'id': 1, 'cmd': cmd, 'args': args or {}}) + '\n').encode())
        with client.makefile('rb') as stream:
            welcome = None
            while True:
                line = stream.readline(32 * 1024 * 1024 + 1)
                if not line or len(line) > 32 * 1024 * 1024:
                    raise RuntimeError('Invalid daemon response')
                reply = json.loads(line)
                if reply.get('id') == 0:
                    welcome = reply.get('ok')
                if reply.get('id') == 1:
                    if 'err' in reply:
                        raise RuntimeError(str(reply['err']))
                    return (welcome, reply.get('ok')) if with_welcome else reply.get('ok')


def rpc_as_user(data, cmd, args=None, with_welcome=False, uid=None):
    # The daemon's Unix listener rejects peers whose effective UID differs
    # from its owner, including root. This helper is deliberately synchronous
    # and single-threaded: drop only for this read and always restore before
    # any protected file or launchd operation. Never widen daemon IPC access.
    previous = os.geteuid()
    if uid is None or uid <= 0:
        raise RuntimeError('A signed-in daemon owner UID is required')
    if previous == uid:
        return rpc(data, cmd, args, with_welcome)
    if previous != 0:
        raise RuntimeError('Cannot query a daemon owned by another user')
    os.seteuid(uid)
    try:
        return rpc(data, cmd, args, with_welcome)
    finally:
        os.seteuid(previous)


def processes():
    rows = []
    for line in run('/bin/ps', '-axo', 'pid=,ppid=,uid=,stat=,comm=').stdout.splitlines():
        parts = line.strip().split(None, 4)
        if len(parts) == 5 and 'Z' not in parts[3]:
            rows.append((int(parts[0]), int(parts[1]), int(parts[2]), parts[4]))
    return rows


def process_birth(pid):
    # Darwin proc_bsdinfo from <sys/proc_info.h>; same kernel birth identity
    # used by apex_adapters::owned_process, including microseconds/PID reuse.
    class BsdInfo(ctypes.Structure):
        _fields_ = [('prefix', ctypes.c_uint32 * 12), ('comm', ctypes.c_char * 16),
                    ('name', ctypes.c_char * 32), ('middle', ctypes.c_uint32 * 6),
                    ('seconds', ctypes.c_uint64), ('micros', ctypes.c_uint64)]
    info = BsdInfo()
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.restype = ctypes.c_int
    if lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info) or info.prefix[3] != pid:
        raise RuntimeError('Could not verify worker process birth identity')
    return 'macos:%s:%s' % (info.seconds, info.micros)


def room_is_idle(state):
    if not isinstance(state, dict) or 'active' not in state:
        return False
    runner = state.get('runner') or {}
    return not (state['active'] or state.get('approvals') or state.get('questions') or runner.get('phase') in ('running', 'scheduled', 'waiting'))


def check_idle_children(data, rows, daemon_pid, uid, idle_rooms, birth=process_birth, group=os.getpgid, recheck=None):
    allowed = []
    registry = data / 'worker-processes'
    for pid, parent, child_uid, command in rows:
        if parent != daemon_pid:
            continue
        verified = []
        if child_uid == uid and Path(command).name in ('claude', 'codex', 'gemini', 'agy', 'grok', 'muse'):
            if registry.is_dir() and not registry.is_symlink():
                for directory in registry.iterdir():
                    if directory.name not in idle_rooms or directory.is_symlink() or not directory.is_dir():
                        continue
                    record = directory / ('%s.json' % pid)
                    try:
                        value = read_json(record)
                        expected_group = value.get('pgid')
                        descendants = {pid}
                        while True:
                            expanded = descendants | {row[0] for row in rows if row[1] in descendants}
                            if expanded == descendants:
                                break
                            descendants = expanded
                        # Persistent MCP servers are normal children of a warm
                        # CLI session. They may stop with an idle session only
                        # when they remain within its owned process group.
                        contained = all(row[2] == uid and group(row[0]) == expected_group for row in rows if row[0] in descendants)
                        if value.get('pid') == pid and value.get('birth') == birth(pid) and expected_group == pid and expected_group == group(pid) and contained:
                            verified.append(directory.name)
                    except (OSError, RuntimeError, ValueError):
                        continue
        if len(verified) != 1:
            raise RuntimeError('Daemon child %s (%s) is active or cannot be verified as an idle CLI session. Finish its work before switching.' % (pid, Path(command).name))
        if recheck is not None and not recheck(verified[0]):
            raise RuntimeError('Thread %s started work during the idle check; finish it before switching.' % verified[0])
        allowed.append(pid)
    return allowed


def check_idle(call, confirm_unknown=None):
    unknown = []
    idle_rooms = set()

    def inspect(cmd, label, default):
        try:
            return call(cmd)
        except (OSError, RuntimeError, ValueError):
            unknown.append(label)
            return default

    if inspect('pty_list', 'terminal activity', []):
        raise RuntimeError('Open terminal sessions remain; finish and close them before switching.')
    for assistant in inspect('personal_list', 'assistant activity', []):
        busy = any(event.get('state') in ('received', 'processing', 'held') for event in assistant.get('events', []))
        busy = busy or any(task.get('status') in ('running', 'queued', 'applying') for task in assistant.get('tasks', []))
        if busy:
            raise RuntimeError('Assistant %s still has active or queued work.' % assistant.get('id', '?'))
    catalog = inspect('chat_list', 'chat activity catalog', {'rooms': []})
    if not isinstance(catalog, dict) or not isinstance(catalog.get('rooms'), list):
        unknown.append('chat activity catalog')
        catalog = {'rooms': []}
    for room in catalog['rooms']:
        room_id = room['id']
        try:
            state = call('room_state', {'id': room_id})
        except (OSError, RuntimeError, ValueError):
            unknown.append(room_id)
            continue
        if not isinstance(state, dict) or 'active' not in state:
            unknown.append(room_id)
            continue
        if not room_is_idle(state):
            raise RuntimeError('Thread %s still has active or pending work.' % room_id)
        idle_rooms.add(room_id)
    if unknown:
        if confirm_unknown is None:
            raise RuntimeError('Cannot verify activity in threads: ' + ', '.join(unknown))
        confirm_unknown(unknown)
    return idle_rooms


class MacSystem:
    def __init__(self, uid):
        account = pwd.getpwuid(uid)
        self.uid = uid
        self.home = Path(account.pw_dir)
        self.data = self.home / 'Library/Application Support/dev.apexdeck.app'
        self.prod_plist = self.home / 'Library/LaunchAgents' / (PROD_LABEL + '.plist')
        self.dev_plist = self.home / 'Library/LaunchAgents' / (DEV_LABEL + '.plist')
        self.confirmed_unknown = set()

    def ctl(self, *args, required=True):
        return run('/bin/launchctl', *args, required=required)

    def query(self, cmd, args=None, with_welcome=False):
        return rpc_as_user(self.data, cmd, args, with_welcome, uid=self.uid)

    def target(self, mode):
        return 'gui/%s/%s' % (self.uid, DEV_LABEL if mode == 'dev' else PROD_LABEL)

    def read_config(self):
        protected(CONFIG)
        return read_json(CONFIG)

    def read_state(self):
        if not STATE.exists() and not STATE.is_symlink():
            return None
        protected(STATE)
        state = read_json(STATE)
        if state.get('uid') != self.uid:
            raise RuntimeError('Dev mode belongs to another account')
        return state

    def save_state(self, state):
        atomic_json(STATE, state)

    def clear_state(self):
        self.dev_plist.unlink(missing_ok=True)
        STATE.unlink(missing_ok=True)

    def write_config(self, config):
        atomic_json(CONFIG, config)

    def broker_roundtrip(self):
        # Deliberately incomplete input fails before any journal operation.
        # A complete expected rejection proves the broker processed a fresh
        # request; a socket connect or a cached host read cannot prove that.
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2)
            client.connect('/var/run/dev.apexdeck.provenance.sock')
            client.sendall(b'{}\n')
            with client.makefile('rb') as stream:
                line = stream.readline(4097)
                if not line or len(line) > 4096 or json.loads(line) != {'error': 'Missing data directory'}:
                    raise RuntimeError('Provenance broker did not complete the read-only readiness check')

    def reload_broker(self):
        # Stop first: a stale Unix socket file is not broker readiness.
        self.unload_service(BROKER)
        self.ctl('bootstrap', 'system', BROKER_PLIST)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                self.broker_roundtrip()
                return
            except (OSError, RuntimeError, ValueError):
                time.sleep(.1)
        raise RuntimeError('Provenance broker did not restart')

    def service_pid(self, mode):
        result = self.ctl('print', self.target(mode), required=False)
        match = re.search(r'^\s*pid = (\d+)\s*$', result.stdout, re.M)
        return int(match[1]) if match else None

    def preflight(self, mode):
        protected(ROOT)
        protected(PRODUCTION)
        protected(BROKER_PLIST)
        if mode == 'production':
            self.validate_production_agent()
        rows = processes()
        wanted = self.service_pid(mode)
        for pid, parent, uid, command in rows:
            if command.endswith('/Contents/MacOS/Apex Deck') or command.endswith('/Contents/MacOS/SpikeApp'):
                raise RuntimeError('Quit Apex Deck and Unified Computer Use before switching modes.')
            if command.endswith('/apex-daemon') and pid != wanted:
                raise RuntimeError('Another daemon is running (pid %s). Finish its work before switching global trust pins.' % pid)
            if command.endswith('/bin/apex') or '/Standalone/' in command:
                raise RuntimeError('A standalone CLI is open; quit it before switching global trust pins.')
            if command.endswith('/Electron.app/Contents/MacOS/Electron'):
                raise RuntimeError('Quit development Electron windows before switching.')
        if self.data.is_symlink() or self.data.resolve() != self.data:
            raise RuntimeError('Live data folder must be canonical and not linked')
        if mode == 'production':
            # Must be an installed primary service, not an arbitrary owner.
            if not wanted:
                raise RuntimeError('Production service is not running; open installed Apex Deck, quit its UI, then retry.')
            info = read_json(self.data / 'daemon.json')
            if info.get('pid') != wanted:
                raise RuntimeError('Foreign data-folder owner; nothing was stopped')
        if wanted:
            idle = check_idle(self.query, self.confirm_unknown)
            # Claude/Codex can keep a warm session alive after a completed turn.
            # Re-read processes after inspecting activity; never treat mere
            # process existence, or an uninspectable thread, as proof of work.
            current = processes()
            if self.service_pid(mode) != wanted:
                raise RuntimeError('Daemon changed during activity inspection; retry the switch')
            check_idle_children(self.data, current, wanted, self.uid, idle,
                                recheck=lambda room: room_is_idle(self.query('room_state', {'id': room})))

    def confirm_unknown(self, ids):
        unchecked = set(ids) - self.confirmed_unknown
        if not unchecked:
            return
        if not sys.stdin.isatty():
            raise RuntimeError('Activity could not be inspected. Run this command interactively after confirming all agents are idle.')
        print('The running daemon could not report the following activity (for example, oversized history or unavailable protected state):')
        print(', '.join(sorted(unchecked)))
        answer = input('After checking that ALL agents are idle and no phone/CLI is submitting work, type idle to switch: ')
        if answer.strip() != 'idle':
            raise RuntimeError('Switch cancelled; unknown activity was not approved')
        self.confirmed_unknown.update(unchecked)

    def stop_service(self, mode):
        if mode in ('production', 'dev'):
            # Prevent the old RunAtLoad job racing dev mode on the next login.
            self.ctl('disable', self.target(mode))
        self.unload_service(self.target(mode))

    def unload_service(self, target):
        result = self.ctl('print', target, required=False)
        if result.returncode:
            return
        match = re.search(r'^\s*pid = (\d+)\s*$', result.stdout, re.M)
        pid = int(match[1]) if match else None
        self.ctl('bootout', target)
        # bootout acknowledges the request before launchd finishes removing
        # the job. Starting it immediately can fail with EINPROGRESS/EIO.
        # Wait for both job removal and old-process exit, including pid-less
        # jobs between retries. No force-kill or blind bootstrap retry.
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            registered = self.ctl('print', target, required=False).returncode == 0
            alive = pid is not None and any(row[0] == pid for row in processes())
            if not registered and not alive:
                return
            time.sleep(.1)
        raise RuntimeError('Service %s did not finish unloading; no force-kill or bootstrap was attempted' % target)

    def start_service(self, mode):
        plist = self.dev_plist if mode == 'dev' else self.prod_plist
        if mode == 'dev':
            value = {'Label': DEV_LABEL, 'ProgramArguments': [str(DEV_APP / 'Contents/Resources/bin/apex-daemon'),
                      'serve', '--data-dir', str(self.data)], 'RunAtLoad': True,
                     'KeepAlive': {'SuccessfulExit': False}, 'ThrottleInterval': 10,
                     'StandardErrorPath': str(self.home / 'Library/Logs/Apex Deck/trusted-dev-daemon.log'),
                     'StandardOutPath': str(self.home / 'Library/Logs/Apex Deck/trusted-dev-daemon.log')}
            # Drop privileges before writing in the user's LaunchAgents folder.
            # A symlink in a user-owned ancestor must never redirect a root write.
            code = 'import os,sys,plistlib,json; p=sys.argv[1]; f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o644); s=os.fdopen(f,"wb"); plistlib.dump(json.loads(sys.argv[2]),s); s.close()'
            account = pwd.getpwuid(self.uid)
            result = subprocess.run(['/usr/bin/python3', '-I', '-c', code, str(plist), json.dumps(value)],
                                    env=CLEAN_ENV, user=self.uid, group=account.pw_gid, extra_groups=(),
                                    capture_output=True, text=True, timeout=10)
            if result.returncode:
                raise RuntimeError('Could not write dev user service: ' + result.stderr.strip())
        else:
            self.validate_production_agent()
        self.ctl('enable', self.target(mode))
        if self.ctl('print', self.target(mode), required=False).returncode:
            # GUI bootstrap keeps this daemon in the person's launchd domain.
            self.ctl('bootstrap', 'gui/%s' % self.uid, plist)
        self.ctl('kickstart', self.target(mode))
        state = self.read_state()
        if mode == 'production' and state and state.get('productionDisabled'):
            self.ctl('disable', self.target(mode))

    def validate_production_agent(self):
        if self.prod_plist.is_symlink():
            raise RuntimeError('Production LaunchAgent is linked')
        with self.prod_plist.open('rb') as stream:
            value = plistlib.load(stream)
        if value.get('Label') != PROD_LABEL or value.get('ProgramArguments') != [str(PRODUCTION / 'Contents/Resources/bin/apex-daemon'), 'serve']:
            raise RuntimeError('Unexpected production LaunchAgent; nothing was switched')

    def production_disabled(self):
        result = self.ctl('print-disabled', 'gui/%s' % self.uid)
        return bool(re.search(r'"dev\.apexdeck\.daemon"\s*=>\s*true', result.stdout))

    def verify(self, mode):
        deadline = time.monotonic() + 30
        error = None
        while time.monotonic() < deadline:
            try:
                pid = self.service_pid(mode)
                info = read_json(self.data / 'daemon.json')
                if not pid or info.get('pid') != pid:
                    raise RuntimeError('Waiting for expected service owner')
                self.broker_roundtrip()
                # session_load reads a protected ledger; a degraded daemon can
                # answer hello but cannot pass this check.
                welcome, _ = self.query('devices_list', with_welcome=True)
                expected_app = DEV_APP if mode == 'dev' else PRODUCTION
                expected_executable = str(expected_app / 'Contents/Resources/bin/apex-daemon')
                if not any(row[0] == pid and row[2] == self.uid and row[3] == expected_executable for row in processes()):
                    raise RuntimeError('Daemon executable or user differs from expected service')
                state = self.read_state()
                expected = state['source']['stamp'] if mode == 'dev' else state.get('productionBuild') if state else None
                if expected and (welcome or {}).get('build_commit') != expected:
                    raise RuntimeError('Daemon source stamp does not match the selected snapshot')
                self.query('session_load')
                self.query('chat_list')
                return
            except (OSError, RuntimeError, ValueError) as why:
                error = why
                time.sleep(.2)
        raise RuntimeError('Protected daemon readiness failed: ' + str(error))


def snapshot_manifest(app):
    manifest = read_json(app / 'Contents/Resources/trusted-dev.json')
    if manifest.get('schema') != 1 or not re.fullmatch('[a-f0-9]{64}', manifest.get('sourceId', '')):
        raise RuntimeError('Invalid dev snapshot manifest')
    for name in ('apex-daemon', 'apex'):
        if hash_file(app / 'Contents/Resources/bin' / name) != manifest['binaries'][name]:
            raise RuntimeError('Dev binary differs from signed manifest: ' + name)
    return manifest


def main():
    if sys.platform != 'darwin':
        raise RuntimeError('Trusted dev switching is macOS-only')
    if len(sys.argv) < 2 or sys.argv[1] not in ('start', 'stop', 'status'):
        raise RuntimeError('Usage: sudo /usr/bin/python3 -I scripts/trusted-dev.py start <snapshot.app> | stop | status')
    action = sys.argv[1]
    if os.geteuid() != 0:
        raise RuntimeError('Administrator authorization is required for protected trust switching')
    uid = int(os.environ.get('SUDO_UID', '0'))
    if uid <= 0:
        raise RuntimeError('Run through sudo from the signed-in user account')
    system = MacSystem(uid)
    protected(ROOT)
    if not DEV_ROOT.exists():
        DEV_ROOT.mkdir(mode=0o755)
    protected(DEV_ROOT)
    lock = os.open(DEV_ROOT / 'switch.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, 'w') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another dev switch is in progress')
        if action == 'status':
            print(json.dumps({'mode': 'dev' if system.read_state() else 'production',
                              'productionPid': system.service_pid('production'), 'devPid': system.service_pid('dev')}))
            return
        state = system.read_state()
        if action == 'stop':
            if state:
                # A crash before production was stopped leaves its service
                # running. It is an expected recovery owner, not a foreign one.
                system.preflight('dev' if system.service_pid('dev') else 'production' if system.service_pid('production') else 'recovery')
                pins = validate_app(PRODUCTION, state['team'])
                if pins['ui'] != state['production']['uiCdhash'] or pins['daemon'] != state['production']['daemonCdhash']:
                    raise RuntimeError('Production changed during dev mode; refusing stale restore')
                system.preflight('dev' if system.service_pid('dev') else 'production' if system.service_pid('production') else 'recovery')
            restore(system)
            print('Production trust and service restored. Open installed Apex Deck.')
            return
        if len(sys.argv) != 3:
            raise RuntimeError('Expected one signed dev app')
        system.preflight('dev' if state else 'production')
        original = state['production'] if state else system.read_config()
        team = signing_team(PRODUCTION)
        prod_pins = validate_app(PRODUCTION, team)
        if prod_pins['ui'] != original['uiCdhash'] or prod_pins['daemon'] != original['daemonCdhash']:
            raise RuntimeError('Production app and current primary trust pins disagree')
        source = Path(sys.argv[2]).resolve(strict=True)
        # Only this dedicated inactive slot is replaced, never production.
        stage = DEV_ROOT / 'candidate.app'
        if stage.exists() or stage.is_symlink():
            raise RuntimeError('Stale protected candidate exists; inspect it before retrying')
        try:
            run('/usr/bin/ditto', source, stage)
            run('/usr/sbin/chown', '-R', 'root:wheel', stage)
            run('/bin/chmod', '-RN', stage)
            run('/bin/chmod', '-R', 'go-w', stage)
            pins = validate_app(stage, team)
            manifest = snapshot_manifest(stage)
            if manifest.get('production') != {'ui': prod_pins['ui'], 'daemon': prod_pins['daemon']}:
                raise RuntimeError('Production changed since the snapshot build; rebuild before activation')
            if state:
                system.preflight('dev')
                restore(system)
            if DEV_APP.exists():
                shutil.rmtree(DEV_APP)
            stage.rename(DEV_APP)
        finally:
            if stage.exists() and not stage.is_symlink():
                shutil.rmtree(stage)
        production_welcome, _ = system.query('devices_list', with_welcome=True)
        # Copying and signature validation can take time. Recheck activity
        # immediately before recording the switch and stopping the service.
        system.preflight('production')
        activate(system, pins, {'uid': uid, 'team': team, 'source': manifest,
                               'productionBuild': production_welcome.get('build_commit'),
                               'productionDisabled': system.production_disabled()})
        print('Trusted dev active: ' + manifest['stamp'])


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print('trusted-dev: ' + str(error), file=sys.stderr)
        sys.exit(1)
