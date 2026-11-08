#!/usr/bin/env python3
"""Both default launch orders, using the actual CLI and desktop sidecar.

The sibling backend is the test-only fixture, never a production artifact.
No real profiles, authority service, provider login, or installed apps are used.
Build: cargo build -p apex-cli -p apex-daemon --features apex-daemon/test-support
       --bin apex --bin apex-daemon-fixture
"""
import fcntl, json, os, pathlib, pty, select, shutil, signal, socket, struct, subprocess, tempfile, termios, time

REPO = pathlib.Path(__file__).resolve().parent.parent
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='as-', dir='/tmp'))
STAGE = ROOT / 'bin'
STAGE.mkdir()
for source, name in [('apex', 'apex'), ('apex-daemon-fixture', 'apex-daemon')]:
    shutil.copy2(REPO / 'target/debug' / source, STAGE / name)


def wait(check, message):
    end = time.monotonic() + 20
    while time.monotonic() < end:
        if check():
            return
        time.sleep(.05)
    raise AssertionError(message)


def request(data, cmd, args=None):
    with socket.socket(socket.AF_UNIX) as stream:
        stream.settimeout(10)
        stream.connect(str(data / 'daemon.sock'))
        file = stream.makefile('rwb')
        for number, command, values in [(0, 'hello', {'protocol': 1}), (1, cmd, args or {})]:
            file.write((json.dumps({'id': number, 'cmd': command, 'args': values}) + '\n').encode())
            file.flush()
            while True:
                reply = json.loads(file.readline())
                if reply.get('id') == number:
                    assert 'err' not in reply, reply
                    if number == 1 or cmd == 'hello':
                        return reply['ok']
                    break


def run_case(order):
    home = ROOT / order
    home.mkdir()
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('APEX_', 'DYLD_', 'ELECTRON_'))
           and key not in ('NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR')}
    env.update(HOME=str(home), TERM='xterm-256color', TMPDIR='/tmp')
    data = home / 'Library/Application Support/dev.apexdeck.app'
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    cli = None
    daemon_pid = None
    try:
        def desktop():
            code = ("import {localDaemon} from './desktop/sidecar.mjs';"
                    "const d=await localDaemon({bin:process.argv[1]});"
                    "await d.stop(); console.log(JSON.stringify({socket:d.socket,owned:d.owned}));")
            result = subprocess.run(['node', '--input-type=module', '-e', code, str(STAGE / 'apex-daemon')],
                                    env=env, cwd=REPO, text=True, capture_output=True, timeout=25)
            assert result.returncode == 0, result.stderr
            value = json.loads(result.stdout)
            assert value['socket'] == str(data / 'daemon.sock'), value
            return value

        if order == 'desktop-first':
            assert desktop()['owned'] is True
        cli = subprocess.Popen([str(STAGE / 'apex')], env=env, cwd=REPO,
                               stdin=slave, stdout=slave, stderr=slave)
        wait(lambda: (data / 'daemon.json').exists() or cli.poll() is not None, 'default backend did not start')
        if cli.poll() is not None:
            raise AssertionError(os.read(master, 65536).decode(errors='replace'))
        info = json.loads((data / 'daemon.json').read_text())
        daemon_pid = info['pid']
        boot = request(data, 'hello', {'protocol': 1})['boot_id']
        assert desktop()['owned'] is False, 'desktop failed to reuse CLI/default store'
        assert request(data, 'hello', {'protocol': 1})['boot_id'] == boot
        # Use real fixture RPCs to seed the common profiles and catalog. The
        # independent renderer/two-client tests cover live edit/event behavior.
        revision = request(data, 'agent_profile_list')['revision']
        for name, provider in [('Jigga', 'claude'), ('Null', 'codex')]:
            saved = request(data, 'agent_profile_save', {'handle': name.lower(), 'name': name,
                'provider': provider, 'model': None, 'instructions': name + ' instructions',
                'access': 'ask', 'expectedRevision': revision})
            revision = saved['revision']
        request(data, 'chat_create', {'id': order, 'title': 'Shared ' + order, 'participants': [], 'options': {'policy': 'mention', 'max_bot_hops': 3}})
        request(data, 'room_post', {'id': order, 'text': 'persist across clients', 'client_message_id': order})
        os.write(master, b'/agents saved\r')
        buffer = bytearray()
        continued = False

        def agents_visible():
            nonlocal continued
            while select.select([master], [], [], .02)[0]:
                buffer.extend(os.read(master, 65536))
            if not continued and b'Continue' in buffer:
                os.write(master, b'\r')
                continued = True
            return b'Jigga' in buffer and b'Null' in buffer

        try:
            wait(agents_visible, 'CLI did not display shared saved agents')
        finally:
            (home / 'terminal-output.txt').write_bytes(buffer)
        os.write(master, b'\x03')
        cli.wait(timeout=10)
        assert request(data, 'hello', {'protocol': 1})['boot_id'] == boot, 'CLI exit stopped shared daemon'
        assert [p['id'] for p in request(data, 'agent_profile_list')['profiles']] == ['jigga', 'null']
        assert any(m['text'] == 'persist across clients' for m in request(data, 'room_state', {'id': order})['snapshot']['transcript'])
        assert not (home / '.apex/saved-chats-v1').exists(), 'created a second private team'
        return {'order': order, 'sharedData': str(data), 'boot': boot,
                'agents': ['jigga', 'null'], 'cliDisplayedAgents': True, 'threadPersisted': True}
    finally:
        if cli is not None and cli.poll() is None:
            cli.terminate()
            cli.wait(timeout=10)
        if daemon_pid is None and (data / 'daemon.json').exists():
            daemon_pid = json.loads((data / 'daemon.json').read_text())['pid']
        if daemon_pid is not None:
            os.kill(daemon_pid, signal.SIGTERM)
        os.close(master)
        os.close(slave)


assert os.uname().sysname == 'Darwin', 'This acceptance script tests macOS defaults'
checks = [run_case(order) for order in ['cli-first', 'desktop-first']]
(ROOT / 'checks.json').write_text(json.dumps(checks, indent=2) + '\n')
print(json.dumps({'passed': checks, 'evidence': str(ROOT / 'checks.json')}, indent=2))
