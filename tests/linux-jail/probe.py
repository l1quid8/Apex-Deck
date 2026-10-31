#!/usr/bin/env python3
"""Runs inside the jail. probe.py <edit|read> <home> <data> <project>"""
import ctypes, errno, os, platform, socket, subprocess, sys
level, home, data, project = sys.argv[1:5]
bad = []
def check(name, ok):
    print(("ok   " if ok else "FAIL ") + name)
    if not ok: bad.append(name)
def refused(name, fn):
    try:
        fn(); check(name, False)
    except OSError as e:
        check(f"{name} ({errno.errorcode.get(e.errno)})", True)
def allowed(name, fn):
    try:
        fn(); check(name, True)
    except Exception as e:
        print(e); check(name, False)
def run(*cmd):
    return subprocess.run(cmd, capture_output=True, timeout=60, check=True)

refused("AF_UNIX socket", lambda: socket.socket(socket.AF_UNIX))
refused("AF_VSOCK socket", lambda: socket.socket(40))
refused("AF_ALG socket", lambda: socket.socket(38))
refused("dgram pair", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM))
refused("seqpacket pair", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET))
refused("dgram pair, cloexec", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM | socket.SOCK_CLOEXEC))
refused("dgram pair, nonblock", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM | socket.SOCK_NONBLOCK))
allowed("stream pair", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM))
allowed("stream pair, cloexec", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM | socket.SOCK_CLOEXEC))
allowed("AF_INET", lambda: socket.socket(socket.AF_INET))
libc = ctypes.CDLL(None, use_errno=True)
check("io_uring_setup", libc.syscall(425, 1, 0) == -1 and ctypes.get_errno() == errno.ENOSYS)
if platform.machine() == "x86_64":
    check("x32 socket number", libc.syscall(0x40000000 | 41, 1, 1, 0) == -1 and ctypes.get_errno() == errno.ENOSYS)

check("no /run", not os.path.exists("/run/user") and not os.path.exists("/run/systemd"))
check("no ssh key", not os.path.exists(f"{home}/.ssh/id_ed25519"))
check("no gateway token", not os.path.exists(f"{data}/gateway.token"))
check("attachments back", open(f"{data}/attachments/note.txt").read() == "shown")
refused("attachments read-only", lambda: open(f"{data}/attachments/x", "w"))
refused("write /usr", lambda: open("/usr/x", "w"))
check("only own pids", all(int(p) < 50 for p in os.listdir("/proc") if p.isdigit()))
check("own session", os.getsid(0) == os.getpid() or os.getsid(0) <= 3)
refused("reach the outside", lambda: socket.create_connection(("1.1.1.1", 443), timeout=2))
fds = [int(f) for f in os.listdir("/proc/self/fd")]
check("only stdio fds", sorted(f for f in fds if f > 2 and os.path.exists(f"/proc/self/fd/{f}")) == [])
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen()
allowed("own loopback", lambda: socket.create_connection(s.getsockname(), timeout=2))

if level == "edit":
    allowed("write project", lambda: open(f"{project}/out.txt", "w").close())
    allowed("git", lambda: run("git", "init", "-q", f"{project}/repo"))
    allowed("node child", lambda: run("node", "-e", "require('child_process').execSync('true')"))
    for tool in ("claude", "codex"):
        allowed(tool, lambda: run(tool, "--version"))
else:
    refused("write project", lambda: open(f"{project}/out.txt", "w"))
    allowed("list project", lambda: os.listdir(project))
print("ALL PASSED" if not bad else "FAILED: " + ", ".join(bad))
sys.exit(1 if bad else 0)
