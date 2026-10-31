#!/usr/bin/env python3
"""Runs inside the jail as a bot would, trying every way out in the design's
"Must be proven" lists. breakout.py <edit|read> <json from the kernel test>"""
import ctypes, errno, glob, json, os, socket, subprocess, sys
level, facts = sys.argv[1], json.loads(sys.argv[2])
home, data, project = facts["home"], facts["data"], facts["project"]
bad = []
def check(name, ok):
    print(("ok   " if ok else "FAIL ") + name, flush=True)
    if not ok: bad.append(name)
def refused(name, fn):
    try:
        fn(); check(name, False)
    except OSError as e:
        check(f"{name} ({errno.errorcode.get(e.errno, e.errno)})", True)
def unix(path):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(2); s.connect(path)

# Reading what only the daemon may read.
for name in ("gateway.token", "devices.json", "daemon.sock"):
    refused(f"read {name}", lambda: open(f"{data}/{name}", "rb"))
check("no data folder listing", not glob.glob(f"{data}/*"))

# Host command sockets, wherever a socket file could be planted.
for path in facts["sockets"]:
    refused(f"connect {path}", lambda: unix(path))
for name in facts["abstract"]:
    refused(f"abstract {name}", lambda: unix("\0" + name))
refused("X11 socket", lambda: unix("/tmp/.X11-unix/X0"))
check("no DISPLAY", "DISPLAY" not in os.environ and "WAYLAND_DISPLAY" not in os.environ)
for path in ("/run/dbus/system_bus_socket", "/run/docker.sock", "/var/run/docker.sock"):
    refused(f"connect {path}", lambda: unix(path))

# Making a usable socket any other way.
refused("AF_UNIX socket", lambda: socket.socket(socket.AF_UNIX))
for flags in (0, socket.SOCK_CLOEXEC, socket.SOCK_NONBLOCK, socket.SOCK_CLOEXEC | socket.SOCK_NONBLOCK):
    refused(f"dgram pair {flags}", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM | flags))
libc = ctypes.CDLL(None, use_errno=True)
check("io_uring_setup", libc.syscall(425, 1, 0) == -1 and ctypes.get_errno() == errno.ENOSYS)
if os.uname().machine == "x86_64":
    check("x32 socket number", libc.syscall(0x40000000 | 41, 1, 1, 0) == -1 and ctypes.get_errno() == errno.ENOSYS)
    check("x32 socketpair number", libc.syscall(0x40000000 | 53, 1, 2, 0, 0) == -1 and ctypes.get_errno() == errno.ENOSYS)
    for binary in glob.glob(f"{project}/socket32*"):
        ran = subprocess.run([binary], capture_output=True, timeout=10)
        check(f"{os.path.basename(binary)} made no socket", ran.returncode != 0)

# Running things outside the jail.
def fails(name, *cmd):
    try:
        ran = subprocess.run(cmd, capture_output=True, timeout=10)
        check(f"{name} fails", ran.returncode != 0)
    except (OSError, subprocess.TimeoutExpired) as e:
        check(f"{name} fails ({type(e).__name__})", True)
fails("systemd-run", "systemd-run", "--user", "true")
fails("sudo", "sudo", "-n", "true")
fails("crontab", "sh", "-c", "echo '* * * * * true' | crontab -")
fails("apex-daemon devices", "/.apex/init", "devices", "list")
try:
    subprocess.run(["/.apex/init", "pair"], capture_output=True, timeout=5)
except (OSError, subprocess.TimeoutExpired):
    pass

# The host, by sight and by signal.
PTRACE_ATTACH = 16
forwarder = [int(p.split("/")[2]) for p in glob.glob("/proc/[0-9]*") if int(p.split("/")[2]) not in (1, os.getpid())]
for pid in forwarder + [1]:
    libc.ptrace.argtypes = [ctypes.c_long] * 4
    check(f"ptrace {pid} refused", libc.ptrace(PTRACE_ATTACH, pid, 0, 0) == -1)

marker = facts["host_marker"]
seen = []
for path in glob.glob("/proc/[0-9]*/cmdline"):
    pid = int(path.split("/")[2])
    if pid in (1, os.getpid()) or pid in forwarder: continue
    try: seen.append(open(path, "rb").read().decode("latin-1"))
    except OSError: pass
check("host processes unseen", not any(marker in line for line in seen))

# The network: nothing direct, and only what the proxy passes.
refused("host loopback", lambda: socket.create_connection(("127.0.0.1", facts["loopback"]), timeout=2))
refused("direct outside", lambda: socket.create_connection(("1.1.1.1", 443), timeout=2))
refused("direct metadata", lambda: socket.create_connection(("169.254.169.254", 80), timeout=2))
def proxy(target):
    s = socket.create_connection(("127.0.0.1", facts["proxy"]), timeout=5)
    s.sendall(f"CONNECT {target} HTTP/1.1\r\n\r\n".encode())
    return s.recv(200).decode("latin-1").split("\r\n")[0]
check("proxy passes a public name", " 200 " in proxy("public.test:443"))
for target in ("169.254.169.254:443", "127.0.0.1:443", "[::1]:443", "[::ffff:169.254.169.254]:443",
               "[64:ff9b::a9fe:a9fe]:443", "10.0.0.1:443", "metadata.test:443", "mixed-refused.test:443",
               f"{facts['own']}:443", "own.test:443", "public.test:80", "public.test:8443",
               "1.1.1.1:80", f"{facts['own']}:8443"):
    check(f"proxy refuses {target}", " 403 " in proxy(target))
# Each lookup of this name answers differently; what was checked is what's dialled.
check("proxy rebinding name", " 200 " in proxy("rebinds.test:443"))
check("proxy rebinding name, refused turn", " 403 " in proxy("rebinds.test:443"))
if os.path.exists("/usr/bin/curl"):
    follow = subprocess.run(["curl", "-s", "-p", "-L", "--max-time", "10", "-o", "/dev/null", "-w", "%{http_code}", "http://public.test:443/"],
                            capture_output=True, text=True)
    check("redirect to metadata stops at the proxy", follow.returncode != 0 and "200" not in follow.stdout)
else:
    check("curl present for the redirect test", False)

# The forwarder: purposes come from its ports, so a bot can't name a third.
s = socket.create_connection(("127.0.0.1", facts["hook"]), timeout=5)
s.sendall(b"proxy\nCONNECT public.test:443 HTTP/1.1\r\n\r\n"); s.shutdown(socket.SHUT_WR)
check("hook port stays the hook", s.recv(100) == b"hook-only")
s.close()

# Terminals and descriptors.
check("no controlling terminal", not os.path.exists("/dev/pts/ptmx") or subprocess.run(["sh", "-c", "exec </dev/tty"], capture_output=True).returncode != 0)
fds = [int(f) for f in os.listdir("/proc/self/fd")]
check("only stdio fds", sorted(f for f in fds if f > 2 and os.path.exists(f"/proc/self/fd/{f}")) == [])

# Writes: the jail's home is its own, so these must not reach the host's files.
for path in (f"{home}/.bashrc", f"{home}/.claude/settings.json", f"{home}/.claude.json", f"{home}/.config/autostart/x.desktop"):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f: f.write("planted\n")
    except OSError:
        pass
refused("write /etc", lambda: open("/etc/x", "w"))
refused("write /usr", lambda: open("/usr/x", "w"))

if level == "edit":
    open(f"{project}/wrote-this", "w").close()
    check("project writable", True)
else:
    refused("project read-only", lambda: open(f"{project}/wrote-this", "w"))
print("ALL PASSED" if not bad else "FAILED: " + ", ".join(bad))
sys.exit(1 if bad else 0)
