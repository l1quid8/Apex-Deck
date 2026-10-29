#!/usr/bin/env python3
"""Update one systemd daemon from published stable tags, retaining Linux Allow.

Root owns configuration, candidates, backups and the transaction journal. Git,
Cargo and candidate executables always run as the configured daemon account.
No branch head or unpublished work is installed.
"""

import argparse
import fcntl
import hashlib
import json
import os
import pwd
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPOSITORY = "https://github.com/l1quid8/apex-deck.git"
RELEASE_API = "https://api.github.com/repos/l1quid8/apex-deck/releases/latest"
HERE = Path(__file__).resolve().parent


class MaintenanceRefused(RuntimeError):
    """No service mutation happened: the reserved idle moment is no longer valid."""


def version(text):
    if not isinstance(text, str) or not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", text):
        raise ValueError(f"Not a stable numeric version: {text!r}")
    return tuple(map(int, text.split(".")))


def read_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path, data):
    temporary = path.with_name(path.name + ".new")
    with temporary.open("w") as stream:
        json.dump(data, stream, sort_keys=True, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def digest(path):
    hashed = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hashed.update(chunk)
    return hashed.hexdigest()


def validate_identity(live, record, pid, running_hash, disk_hash=None):
    if pid <= 1 or record.get("pid") != pid or record.get("boot_id") != live.get("boot_id"):
        raise ValueError("RPC daemon identity does not match the configured systemd unit")
    if disk_hash is not None and running_hash != disk_hash:
        raise ValueError("Running service executable differs from the installed binary")


def validate_cgroup_members(members, main_pid):
    expected = set() if main_pid == 0 else {main_pid}
    if set(members) != expected:
        raise ValueError("busy: service child processes remain; wait for terminal/provider cleanup")


def update(system, root):
    """Journaled transaction; adapter separates real system effects from policy."""
    root.mkdir(parents=True, exist_ok=True)
    journal = root / "transaction.json"
    state_path = root / "state.json"
    state = read_json(state_path, {})
    recovery = read_json(journal)
    if recovery:
        lease = system.recovery_begin(recovery)
        if lease.get("ready") is not True:
            return {"status": "recovery_pending", "details": lease}
        try:
            if not lease.get("stopped") and lease.get("expires_at_ms", 0) < (time.time() + 60) * 1000:
                raise ValueError("Invalid or expired recovery maintenance lease")
            system.restore(recovery["backup"])
            system.start()
            system.healthy_backup(recovery["backup"])
            state["failed_release"] = recovery.get("release")
            write_json(state_path, state)
            journal.unlink()
            return {"status": "recovered", "backup": recovery["backup"]}
        finally:
            system.cancel(lease)
    live = system.live()
    running = version(live["version"])
    highest = max(running, version(state.get("highest_version", live["version"])))
    release = system.latest()
    if release.get("draft") is not False or release.get("prerelease") is not False:
        return {"status": "skipped", "reason": "Only published stable releases are eligible"}
    tag = release.get("tag_name", "")
    if not tag.startswith("v"):
        raise ValueError("Published release must use a vMAJOR.MINOR.PATCH tag")
    wanted = tag[1:]
    if version(wanted) <= highest:
        return {"status": "current", "running": live, "latest": tag}
    if state.get("failed_release") == tag:
        return {"status": "quarantined", "release": tag, "reason": "Earlier installation failed; wait for a newer release or inspect state.json"}
    candidate = system.prepare(release)
    if candidate["version"] != wanted:
        raise ValueError("Built candidate version does not match its published release")
    lease = system.begin(live)
    if lease.get("ready") is not True:
        return {"status": "busy", "release": tag, "details": lease}
    try:
        if lease.get("boot_id") != live["boot_id"] or lease.get("expires_at_ms", 0) < (time.time() + 60) * 1000:
            raise ValueError("Invalid or expired maintenance lease")
        backup = system.backup(candidate)
        write_json(journal, {"release": tag, "candidate": candidate, "backup": backup})
        try:
            system.stop(lease)
            system.install(candidate)
            system.start()
            system.healthy(candidate, live["boot_id"])
        except MaintenanceRefused:
            # Never turn an intentional refusal into an unconditional rollback
            # restart of a different/newer daemon.
            journal.unlink()
            raise
        except Exception as error:
            transaction = read_json(journal)
            try:
                rollback_lease = system.recovery_begin(transaction)
            except Exception as refusal:
                return {"status": "rollback_pending", "release": tag, "reason": str(error), "details": str(refusal)}
            if rollback_lease.get("ready") is not True:
                return {"status": "rollback_pending", "release": tag, "reason": str(error), "details": rollback_lease}
            try:
                system.restore(backup)
                system.start()
                system.healthy_backup(backup)
            finally:
                system.cancel(rollback_lease)
            state["failed_release"] = tag
            state["last_error"] = str(error)
            state["backup"] = backup
            write_json(state_path, state)
            journal.unlink()
            return {"status": "rolled_back", "release": tag, "reason": str(error), "backup": backup}
        state.update(highest_version=wanted, installed=candidate, backup=backup, updated_at=int(time.time()))
        state.pop("failed_release", None)
        state.pop("last_error", None)
        write_json(state_path, state)
        journal.unlink()
        return {"status": "updated", "release": tag, "candidate": candidate, "backup": backup}
    finally:
        system.cancel(lease)


class System:
    def __init__(self, config, root):
        self.config = config
        self.root = root
        self.user = config["user"]
        if not re.fullmatch(r"[a-z_][a-z0-9_-]*", self.user):
            raise ValueError("Invalid service user")
        self.account = pwd.getpwnam(self.user)
        self.unit = config.get("unit", "apex-daemon@" + self.user + ".service")
        if not isinstance(self.unit, str) or not re.fullmatch(r"apex-daemon(?:-[a-z0-9_-]+)?@" + re.escape(self.user) + r"\.service", self.unit):
            raise ValueError("Invalid daemon service unit for the configured account")
        self.binary = Path("/usr/local/bin/apex-daemon")
        self.data = Path(config.get("data_dir", self.account.pw_dir + "/.local/share/dev.apexdeck.app"))
        self.work = Path(self.account.pw_dir) / ".cache/apex-deck-update"
        self.source = self.work / "source"
        self.request = Path("/run/apex-deck-update") / f"{self.account.pw_uid}.request"
        self.active_lease = None

    def command(self, argv, *, user=False, cwd=None, timeout=120, env=None):
        if user:
            settings = {"HOME": self.account.pw_dir, "PATH": self.account.pw_dir + "/.cargo/bin:/usr/local/bin:/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
            settings.update(env or {})
            argv = ["runuser", "-u", self.user, "--", "env", *[f"{key}={value}" for key, value in settings.items()], *map(str, argv)]
        result = subprocess.run(list(map(str, argv)), cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        if result.returncode:
            raise RuntimeError(f"{argv[-3:]} failed ({result.returncode}):\n{result.stdout[-12000:]}")
        return result.stdout.strip()

    def rpc(self, command, args=None, timeout=12):
        # Attach only: a health check must never start a second host.
        argv = ["runuser", "-u", self.user, "--", str(self.binary), "--stdio", "--attach", "--data-dir", str(self.data)]
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        import selectors
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout
        try:
            child.stdin.write((json.dumps({"id": 900, "cmd": "hello", "args": {"protocol": 1}}) + "\n").encode())
            child.stdin.flush()
            buffered = b""
            while time.monotonic() < deadline:
                while b"\n" not in buffered:
                    if not selector.select(max(0, deadline - time.monotonic())):
                        raise RuntimeError("Daemon RPC timed out")
                    chunk = os.read(child.stdout.fileno(), 65536)
                    if not chunk:
                        raise RuntimeError("Daemon attach closed without a reply")
                    buffered += chunk
                    if len(buffered) > 32 * 1024 * 1024:
                        raise RuntimeError("Daemon RPC frame exceeds protocol limit")
                line, buffered = buffered.split(b"\n", 1)
                frame = json.loads(line)
                if frame.get("id") == 900:
                    if "err" in frame:
                        raise RuntimeError(str(frame["err"]))
                    welcome = frame["ok"]
                    if command == "hello":
                        return welcome
                    child.stdin.write((json.dumps({"id": 901, "cmd": command, "args": args or {}}) + "\n").encode())
                    child.stdin.flush()
                elif frame.get("id") == 901:
                    if "err" in frame:
                        raise RuntimeError(str(frame["err"]))
                    return frame["ok"]
            raise RuntimeError("Daemon RPC timed out")
        finally:
            selector.close()
            child.terminate()
            try:
                child.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate()

    def live(self, *, allow_disk_mismatch=False):
        live = self.rpc("hello")
        version(live.get("version"))
        if not re.fullmatch(r"[0-9a-f]{12,40}", live.get("build_commit", "")) or not live.get("boot_id"):
            raise ValueError("Daemon did not provide a verifiable live build identity")
        pid = int(self.command(["systemctl", "show", "-p", "MainPID", "--value", self.unit]))
        record = json.loads(self.command(["cat", self.data / "daemon.json"], user=True))
        running_hash = digest(Path(f"/proc/{pid}/exe")) if pid > 1 else ""
        validate_identity(live, record, pid, running_hash, None if allow_disk_mismatch else digest(self.binary))
        live["executable_sha256"] = running_hash
        return live

    def latest(self):
        request = urllib.request.Request(RELEASE_API, headers={"Accept": "application/vnd.github+json", "User-Agent": "Apex-Deck-VPS-Updater"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def prepare(self, release):
        tag = release["tag_name"]
        version(tag[1:])
        self.command(["mkdir", "-p", self.work], user=True)
        if not (self.source / ".git").is_dir():
            self.command(["git", "init", self.source], user=True)
            self.command(["git", "remote", "add", "origin", REPOSITORY], user=True, cwd=self.source)
        if self.command(["git", "remote", "get-url", "origin"], user=True, cwd=self.source) != REPOSITORY:
            raise ValueError("Updater build repository origin changed")
        self.command(["git", "fetch", "--no-tags", "--depth=1", "origin", "refs/tags/" + tag], user=True, cwd=self.source)
        commit = self.command(["git", "rev-parse", "FETCH_HEAD^{commit}"], user=True, cwd=self.source)
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("Release tag did not resolve to a commit")
        recipe_files = [HERE / name for name in ("vps_update.py", "vps_update_compat.py", "vps-update-allow-test.rs", "vps-update-maintenance.patch")]
        recipe = hashlib.sha256("".join(digest(path) for path in recipe_files).encode()).hexdigest()
        stage = self.root / "candidates" / (commit + "-" + recipe[:12])
        metadata = read_json(stage / "candidate.json")
        if metadata and digest(Path(metadata["path"])) == metadata["sha256"]:
            return metadata
        self.command(["git", "checkout", "--force", "--detach", commit], user=True, cwd=self.source)
        # This dedicated clone contains no user work. Never clean another checkout.
        self.command(["git", "clean", "-fdx"], user=True, cwd=self.source)
        # Source paths belong to the build user. Never let a release symlink
        # cause a privileged compatibility-helper write outside this checkout.
        compatibility = json.loads(self.command([
            "python3", "-c",
            "import json,sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from vps_update_compat import prepare_source; print(json.dumps(prepare_source(Path(sys.argv[2]))))",
            HERE, self.source,
        ], user=True))
        self.command(["git", "apply", "--check", HERE / "vps-update-maintenance.patch"], user=True, cwd=self.source)
        self.command(["git", "apply", HERE / "vps-update-maintenance.patch"], user=True, cwd=self.source)
        stage.mkdir(parents=True, exist_ok=True)
        build_env = {"CARGO_TARGET_DIR": str(self.work / "target"), "APEX_BUILD_COMMIT": commit[:12], "APEX_BUILD_DIRTY": "true", "CARGO_BUILD_JOBS": "2"}
        checks = [(["cargo", "test", "--locked", "-p", "apex-host", "--lib", "command::tests::vps_update_allow_compatibility", "--", "--exact", "--nocapture"], 1),
                  (["cargo", "test", "--locked", "-p", "apex-host", "--lib", "maintenance::tests::", "--", "--nocapture"], None),
                  (["cargo", "test", "--locked", "-p", "apex-daemon", "--lib", "--features", "remote", "maintenance", "--", "--nocapture"], None)]
        test_results = []
        for number, (argv, expected) in enumerate(checks, 1):
            output = self.command(argv, user=True, cwd=self.source, timeout=3600, env=build_env)
            (stage / f"focused-{number}.log").write_text(output + "\n")
            match = re.search(r"test result: ok\. (\d+) passed; 0 failed;", output)
            if not match or int(match[1]) < 1 or (expected is not None and int(match[1]) != expected):
                raise RuntimeError("Required focused regression test did not execute: " + output[-4000:])
            test_results.append({"command": argv, "passed": int(match[1])})
        output = self.command(["cargo", "build", "--release", "--locked", "-p", "apex-daemon", "--features", "remote"], user=True, cwd=self.source, timeout=3600, env=build_env)
        (stage / "build.log").write_text(output + "\n")
        target = stage / "apex-daemon"
        # Read as the build user, avoiding root following user-controlled symlinks.
        with target.open("wb") as output:
            subprocess.run(["runuser", "-u", self.user, "--", "cat", str(self.work / "target/release/apex-daemon")], stdout=output, check=True, timeout=30)
            output.flush()
            os.fsync(output.fileno())
        target.chmod(0o755)
        reported = self.command([target, "--version"], user=True)
        if not re.fullmatch(r"apex-daemon " + re.escape(tag[1:]) + r" \(" + commit[:12] + r"(?:-dirty)?\)", reported):
            raise RuntimeError("Candidate identity does not match tagged source: " + reported)
        metadata = {"version": tag[1:], "commit": commit, "sha256": digest(target), "path": str(target), "recipe_sha256": recipe, "compatibility": compatibility, "tests": test_results, "build_dirty": True}
        write_json(stage / "candidate.json", metadata)
        return metadata

    def begin(self, live):
        parent = self.request.parent
        parent.mkdir(mode=0o755, exist_ok=True)
        if parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022:
            raise ValueError("Maintenance request directory must be root owned and not user writable")
        nonce = secrets.token_hex(32)
        # Bound this reservation independently of any wall-clock adjustments.
        deadline = time.monotonic() + 240
        write_json(self.request, {"nonce": nonce, "boot_id": live["boot_id"], "expires_at_ms": int((time.time() + 240) * 1000)})
        try:
            lease = self.rpc("maintenance_begin", {"nonce": nonce})
            if lease.get("ready") is True:
                lease["deadline_monotonic"] = min(deadline, time.monotonic() + max(0, lease.get("expires_at_ms", 0) / 1000 - time.time()))
                try:
                    self.no_service_children()
                except Exception as error:
                    self.cancel(lease)
                    return {"ready": False, "reasons": [str(error)]}
                self.active_lease = lease
            else:
                self.request.unlink(missing_ok=True)
            return lease
        except Exception:
            self.request.unlink(missing_ok=True)
            raise

    def no_service_children(self, *, stopped=False):
        pid = int(self.command(["systemctl", "show", "-p", "MainPID", "--value", self.unit]))
        if stopped:
            active = self.command(["systemctl", "show", "-p", "ActiveState", "--value", self.unit])
            if pid != 0 or active not in ("inactive", "failed"):
                raise MaintenanceRefused("Daemon started after recovery observed it stopped")
        elif pid <= 1:
            raise ValueError("Unknown daemon PID; cannot establish idle state")
        relative = self.command(["systemctl", "show", "-p", "ControlGroup", "--value", self.unit])
        if stopped and relative == "":
            return  # systemd has removed the inactive unit's empty cgroup.
        if not relative.startswith("/") or ".." in Path(relative).parts or relative == "/":
            raise ValueError("Unknown daemon cgroup; cannot establish idle state")
        group = Path("/sys/fs/cgroup") / relative.lstrip("/")
        if not (group / "cgroup.procs").is_file():
            raise ValueError("Daemon cgroup cannot be inspected; cannot establish idle state")
        members = set()
        for file in group.rglob("cgroup.procs"):
            members.update(map(int, file.read_text().split()))
        validate_cgroup_members(members, pid)

    def recovery_begin(self, transaction):
        expected = {transaction["backup"]["sha256"]}
        if transaction.get("candidate"):
            expected.add(transaction["candidate"]["sha256"])
        if digest(self.binary) not in expected:
            raise ValueError("Recovery refused: installed binary is unrelated to the interrupted transaction")
        try:
            live = self.live(allow_disk_mismatch=True)
        except ValueError:
            raise  # A mismatched live identity is not evidence of a stopped host.
        except Exception:
            # A power loss can leave the service stopped. Restoring an inactive
            # unit interrupts no work; uncertainty about its state still refuses.
            pid = self.command(["systemctl", "show", "-p", "MainPID", "--value", self.unit])
            active = self.command(["systemctl", "show", "-p", "ActiveState", "--value", self.unit])
            if pid == "0" and active in ("inactive", "failed"):
                self.no_service_children(stopped=True)
                self.active_lease = {"ready": True, "stopped": True}
                return self.active_lease
            raise
        if live["executable_sha256"] not in expected:
            raise ValueError("Recovery refused: live daemon is unrelated to the interrupted transaction")
        return self.begin(live)

    def cancel(self, lease):
        try:
            self.rpc("maintenance_cancel", {"lease": lease.get("lease", "")}, timeout=5)
        except Exception:
            pass  # A successful restart discarded the old process's gate.
        finally:
            self.request.unlink(missing_ok=True)
            self.active_lease = None

    def backup(self, candidate):
        previous = self.live()
        directory = self.root / "backups"
        directory.mkdir(exist_ok=True)
        target = directory / (time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + previous["build_commit"])
        shutil.copyfile(self.binary, target)
        target.chmod(0o755)
        with target.open("rb") as stream:
            os.fsync(stream.fileno())
        folder = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(folder)
        finally:
            os.close(folder)
        return {"path": str(target), "sha256": digest(target), "live": previous}

    def stop(self, lease, *, allow_disk_mismatch=False):
        def require_reserved_time():
            if self.active_lease is not lease:
                raise MaintenanceRefused("Stop has no current maintenance reservation")
            if (lease.get("expires_at_ms", 0) < (time.time() + 60) * 1000
                    or lease.get("deadline_monotonic", 0) < time.monotonic() + 60):
                raise MaintenanceRefused("Maintenance lease too close to expiry")
        try:
            require_reserved_time()
            if self.live(allow_disk_mismatch=allow_disk_mismatch)["boot_id"] != lease["boot_id"]:
                raise MaintenanceRefused("Daemon restarted after maintenance was acquired")
            self.no_service_children()
            require_reserved_time()
        except Exception as error:
            raise MaintenanceRefused(str(error)) from error
        self.command(["systemctl", "stop", self.unit], timeout=45)
        if self.command(["systemctl", "show", "-p", "MainPID", "--value", self.unit]) != "0":
            raise RuntimeError("Daemon did not stop")

    def replace(self, source, expected):
        if digest(source) != expected:
            raise RuntimeError("Executable checksum changed")
        temporary = self.binary.with_name("apex-daemon.update-new")
        shutil.copyfile(source, temporary)
        temporary.chmod(0o755)
        with temporary.open("rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, self.binary)
        directory = os.open(self.binary.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def install(self, candidate):
        self.replace(Path(candidate["path"]), candidate["sha256"])

    def restore(self, backup):
        if not self.active_lease:
            raise MaintenanceRefused("Rollback has no reserved idle moment")
        if self.active_lease.get("stopped"):
            if self.command(["systemctl", "show", "-p", "MainPID", "--value", self.unit]) != "0":
                raise MaintenanceRefused("Daemon started after recovery observed it stopped")
            self.no_service_children(stopped=True)
            self.command(["systemctl", "stop", self.unit], timeout=45)
        else:
            self.stop(self.active_lease, allow_disk_mismatch=True)
        self.replace(Path(backup["path"]), backup["sha256"])

    def start(self):
        self.command(["systemctl", "reset-failed", self.unit])
        self.command(["systemctl", "start", self.unit], timeout=45)

    def check_process(self, expected, old_boot=None, backup=False):
        deadline = time.monotonic() + 45
        last = "not started"
        while time.monotonic() < deadline:
            try:
                live = self.live()
                commit = expected["live"]["build_commit"] if backup else expected["commit"][:12]
                wanted = expected["live"]["version"] if backup else expected["version"]
                pid = int(self.command(["systemctl", "show", "-p", "MainPID", "--value", self.unit]))
                record = json.loads(self.command(["cat", self.data / "daemon.json"], user=True))
                if live["version"] != wanted or live["build_commit"] != commit or (old_boot and live["boot_id"] == old_boot):
                    raise RuntimeError("Live protocol identity differs from candidate")
                if not backup and live.get("build_dirty") != expected["build_dirty"]:
                    raise RuntimeError("Live build patch marker differs from candidate")
                if pid <= 1 or record.get("pid") != pid or record.get("boot_id") != live["boot_id"]:
                    raise RuntimeError("systemd and live daemon identity disagree")
                if digest(Path(f"/proc/{pid}/exe")) != expected["sha256"]:
                    raise RuntimeError("Running executable hash differs from staged file")
                if self.command(["systemctl", "is-active", self.unit]) != "active":
                    raise RuntimeError("Daemon service is not active")
                self.rpc("session_load")
                if version(wanted) >= version("0.9.4"):
                    self.rpc("chat_list")
                return live
            except Exception as error:
                last = str(error)
                time.sleep(1)
        raise RuntimeError("Daemon health check failed: " + last)

    def healthy(self, candidate, old_boot):
        return self.check_process(candidate, old_boot)

    def healthy_backup(self, backup):
        return self.check_process(backup, backup=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("user")
    parser.add_argument("--prepare-only", action="store_true", help="Build and verify latest published tag without touching the service")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("run as root")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", args.user):
        parser.error("invalid service user")
    root = Path("/var/lib/apex-deck-update") / args.user
    root.mkdir(parents=True, exist_ok=True)
    config_path = Path("/etc/apex-deck-update") / (args.user + ".json")
    if config_path.stat().st_uid != 0 or config_path.stat().st_mode & 0o022:
        parser.error("configuration must be root owned and not user writable")
    config = read_json(config_path)
    if config.get("user") != args.user:
        parser.error("configuration user differs")
    with (root.parent / "update.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("An update is already running")
            return
        system = System(config, root)
        try:
            result = {"status": "prepared", "candidate": system.prepare(system.latest())} if args.prepare_only else update(system, root)
        except Exception as error:
            result = {"status": "error", "reason": str(error)}
        result["checked_at"] = int(time.time())
        write_json(root / "status.json", result)
        print(json.dumps(result, sort_keys=True), flush=True)
        if result["status"] == "error":
            raise SystemExit(1)


if __name__ == "__main__":
    main()
