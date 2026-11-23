import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "vps_update.py"


def load_updater():
    spec = importlib.util.spec_from_file_location("vps_update", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class CandidateAcceptanceTests(unittest.TestCase):
    def test_native_checks_require_linux_cli_and_confined_device_cases_to_run(self):
        updater = load_updater()
        checks = updater.candidate_checks(native_maintenance=True)
        exact = {argv[-4] for argv, expected in checks if expected == 1 and argv[-3] == "--"}
        self.assertIn("command::tests::linux_local_cli_admission_saves_real_changes_only_after_the_probe", exact)
        self.assertIn("protocol::tests::device_access_updates::linux_device_raise_refuses_failed_confinement_without_saving", exact)
        self.assertNotIn("command::tests::vps_update_allow_compatibility", exact)
        with self.assertRaisesRegex(RuntimeError, "did not execute"):
            updater.verify_candidate_result("test result: ok. 0 passed; 0 failed;", 1)
        self.assertEqual(updater.verify_candidate_result("test result: ok. 1 passed; 0 failed;", 1), 1)


class FakeSystem:
    def __init__(self):
        self.events = []
        self.channel = "stable"
        self.current = {"version": "0.9.3", "build_commit": "02f3a24f8659", "boot_id": "old"}
        self.release = {"tag_name": "v0.9.4", "draft": False, "prerelease": False}
        self.busy = False
        self.fail_build = False
        self.fail_health = False
        self.candidate = {"version": "0.9.4", "commit": "a" * 40, "sha256": "b" * 64, "path": "/candidate"}

    def live(self):
        return self.current.copy()

    def latest(self):
        return self.release

    def prepare(self, release):
        self.events.append("prepare")
        if self.fail_build:
            raise RuntimeError("Allow regression failed")
        return self.candidate.copy()

    def begin(self, live):
        self.events.append("begin")
        return {"ready": not self.busy, "lease": "lease", "boot_id": live["boot_id"], "expires_at_ms": 9999999999999}

    def cancel(self, lease):
        self.events.append("cancel")

    def recovery_begin(self, transaction):
        return self.begin(self.live())

    def backup(self, candidate):
        self.events.append("backup")
        return {"path": "/backup", "sha256": "c" * 64, "live": self.current.copy()}

    def stop(self, lease):
        self.events.append("stop")

    def install(self, candidate):
        self.events.append("install")

    def start(self):
        self.events.append("start")

    def healthy(self, candidate, old_boot):
        self.events.append("healthy")
        if self.fail_health:
            raise RuntimeError("new daemon failed health")
        self.current = {"version": candidate["version"], "build_commit": candidate["commit"][:12], "boot_id": "new"}
        if self.channel == "nightly":
            self.current["build_identity"] = {key: candidate[key] for key in ("channel", "version", "buildNumber", "commit")}

    def restore(self, backup):
        self.events.append("restore")
        self.current = backup["live"].copy()

    def healthy_backup(self, backup):
        self.events.append("healthy_backup")


class UpdateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SCRIPT.exists():
            raise AssertionError("VPS updater has not been implemented")
        cls.mod = load_updater()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.system = FakeSystem()

    def run_update(self):
        return self.mod.update(self.system, self.root)

    def test_same_or_older_release_never_builds_or_stops(self):
        for version in ("0.9.2", "0.9.3"):
            self.system.release["tag_name"] = "v" + version
            self.assertEqual(self.run_update()["status"], "current")
        self.assertEqual(self.system.events, [])

    def test_high_water_mark_blocks_downgrade_after_manual_rollback(self):
        (self.root / "state.json").write_text(json.dumps({"highest_version": "0.10.0"}))
        self.assertEqual(self.run_update()["status"], "current")
        self.assertEqual(self.system.events, [])

    def test_numeric_versions_and_invalid_release_shapes(self):
        self.assertGreater(self.mod.version("0.10.0"), self.mod.version("0.9.99"))
        for value in ("v1.2.3", "1.2", "1.2.3-beta", "01.2.3", "../../bin", "1.2.3.4"):
            with self.assertRaises(ValueError):
                self.mod.version(value)
        self.system.release["prerelease"] = True
        self.assertEqual(self.run_update()["status"], "skipped")
        self.assertEqual(self.system.events, [])

    def test_rpc_identity_must_match_service_pid_boot_and_executable(self):
        live = {"boot_id": "boot"}
        record = {"pid": 123, "boot_id": "boot"}
        self.mod.validate_identity(live, record, 123, "hash", "hash")
        for pid, info, disk in [(0, record, "hash"), (124, record, "hash"),
                                (123, {"pid": 123, "boot_id": "other"}, "hash"),
                                (123, record, "other-hash")]:
            with self.assertRaises(ValueError):
                self.mod.validate_identity(live, info, pid, "hash", disk)

    def test_unknown_or_orphan_service_children_prevent_restart(self):
        self.mod.validate_cgroup_members({123}, 123)
        for members in ({123, 124}, set(), {124}):
            with self.assertRaises(ValueError):
                self.mod.validate_cgroup_members(members, 123)

    def test_stopped_service_requires_an_empty_cgroup(self):
        self.mod.validate_cgroup_members(set(), 0)
        for members in ({0}, {123}, {123, 124}):
            with self.assertRaises(ValueError):
                self.mod.validate_cgroup_members(members, 0)

    def test_failed_compatibility_never_touches_live_daemon(self):
        self.system.fail_build = True
        with self.assertRaisesRegex(RuntimeError, "Allow regression"):
            self.run_update()
        self.assertEqual(self.system.events, ["prepare"])

    def test_busy_daemon_keeps_candidate_without_restart(self):
        self.system.busy = True
        self.assertEqual(self.run_update()["status"], "busy")
        self.assertEqual(self.system.events, ["prepare", "begin"])
        self.assertFalse((self.root / "transaction.json").exists())

    def test_success_keeps_backup_and_records_high_water_mark(self):
        self.assertEqual(self.run_update()["status"], "updated")
        self.assertEqual(self.system.events, ["prepare", "begin", "backup", "stop", "install", "start", "healthy", "cancel"])
        state = json.loads((self.root / "state.json").read_text())
        self.assertEqual(state["highest_version"], "0.9.4")
        self.assertEqual(state["backup"]["path"], "/backup")
        self.assertFalse((self.root / "transaction.json").exists())

    def test_health_failure_rolls_back_and_quarantines_candidate(self):
        self.system.fail_health = True
        self.assertEqual(self.run_update()["status"], "rolled_back")
        self.assertEqual(self.system.events[-6:], ["begin", "restore", "start", "healthy_backup", "cancel", "cancel"])
        self.assertEqual(self.system.current["build_commit"], "02f3a24f8659")
        self.assertEqual(self.run_update()["status"], "quarantined")
        self.assertEqual(self.system.events.count("stop"), 1)

    def test_failed_health_defers_rollback_while_new_bot_work_is_busy(self):
        def unhealthy(candidate, boot):
            self.system.busy = True
            raise RuntimeError("new daemon health failure")
        self.system.healthy = unhealthy
        self.assertEqual(self.run_update()["status"], "rollback_pending")
        self.assertNotIn("restore", self.system.events)
        self.assertTrue((self.root / "transaction.json").exists())

    def test_interrupted_transaction_is_recovered_before_checking_releases(self):
        (self.root / "transaction.json").write_text(json.dumps({"backup": {"path": "/backup", "live": self.system.current}}))
        self.assertEqual(self.run_update()["status"], "recovered")
        self.assertEqual(self.system.events, ["begin", "restore", "start", "healthy_backup", "cancel"])
        self.assertFalse((self.root / "transaction.json").exists())

    def test_interrupted_transaction_waits_for_idle_before_recovery(self):
        (self.root / "transaction.json").write_text(json.dumps({"backup": {"path": "/backup", "live": self.system.current}}))
        self.system.busy = True
        self.assertEqual(self.run_update()["status"], "recovery_pending")
        self.assertEqual(self.system.events, ["begin"])
        self.assertTrue((self.root / "transaction.json").exists())

    def test_candidate_version_must_match_release(self):
        self.system.candidate["version"] = "0.9.2"
        with self.assertRaisesRegex(ValueError, "candidate version"):
            self.run_update()
        self.assertEqual(self.system.events, ["prepare"])

    def test_expired_or_wrong_boot_lease_never_stops(self):
        for lease in ({"ready": True, "lease": "x", "boot_id": "other", "expires_at_ms": 9999999999999},
                      {"ready": True, "lease": "x", "boot_id": "old", "expires_at_ms": 0}):
            self.system.begin = lambda live: lease
            with self.assertRaisesRegex(ValueError, "maintenance lease"):
                self.run_update()
        self.assertNotIn("stop", self.system.events)

    def test_stop_refusal_does_not_restart_or_rollback_a_newer_daemon(self):
        def refuse(lease):
            raise self.mod.MaintenanceRefused("Daemon restarted after maintenance was acquired")
        self.system.stop = refuse
        with self.assertRaises(self.mod.MaintenanceRefused):
            self.run_update()
        self.assertNotIn("restore", self.system.events)
        self.assertNotIn("start", self.system.events)
        self.assertFalse((self.root / "transaction.json").exists())

    def adapter(self):
        system = object.__new__(self.mod.System)
        system.active_lease = None
        system.unit = "apex-daemon@test.service"
        system.no_service_children = lambda: None
        system.command = lambda argv, **kwargs: self.fail("Unexpected system mutation: " + str(argv))
        return system

    def test_configured_daemon_unit_is_used_for_maintenance_stop(self):
        unit = "apex-daemon-managed@root.service"
        system = self.mod.System({"user": "root", "unit": unit}, self.root)
        system.live = lambda **kwargs: {"boot_id": "boot"}
        system.no_service_children = lambda: None
        calls = []
        def command(argv, **kwargs):
            calls.append(argv)
            return "0" if "MainPID" in argv else ""
        system.command = command
        lease = {"boot_id": "boot", "lease": "held", "expires_at_ms": 9999999999999,
                 "deadline_monotonic": self.mod.time.monotonic() + 240}
        system.active_lease = lease
        system.stop(lease)
        self.assertEqual(calls, [["systemctl", "stop", unit],
                                 ["systemctl", "show", "-p", "MainPID", "--value", unit]])

    def test_default_daemon_unit_remains_the_existing_template(self):
        system = self.mod.System({"user": "root"}, self.root)
        self.assertEqual(system.unit, "apex-daemon@root.service")

    def test_configured_unit_cannot_target_unrelated_services_or_accounts(self):
        for unit in ("sshd.service", "../apex-daemon@root.service", "--all",
                     "apex-daemon-managed@someoneelse.service", "apex-daemon-nightly@root.service", "", None, 123):
            with self.subTest(unit=unit), self.assertRaisesRegex(ValueError, "service unit"):
                self.mod.System({"user": "root", "unit": unit}, self.root)

    def test_real_stop_adapter_treats_identity_probe_failure_as_refusal(self):
        system = self.adapter()
        def broken_live(**kwargs):
            raise ValueError("RPC is for another service")
        system.live = broken_live
        lease = {"boot_id": "old", "lease": "held", "expires_at_ms": 9999999999999,
                 "deadline_monotonic": self.mod.time.monotonic() + 240}
        system.active_lease = lease
        with self.assertRaises(self.mod.MaintenanceRefused):
            system.stop(lease)

    def test_real_stop_rechecks_monotonic_lease_after_slow_probes(self):
        system = self.adapter()
        elapsed = [1000]
        lease = {"boot_id": "old", "lease": "held", "expires_at_ms": 1061000,
                 "deadline_monotonic": 1061}
        system.active_lease = lease
        def slow_live(**kwargs):
            elapsed[0] += 70
            return {"boot_id": "old"}
        system.live = slow_live
        calls = []
        system.command = lambda argv, **kwargs: calls.append(argv) or "0"
        # The monotonic clock must bound admission even if wall time is adjusted.
        with patch.object(self.mod.time, "time", return_value=1000), \
             patch.object(self.mod.time, "monotonic", side_effect=lambda: elapsed[0]):
            with self.assertRaises(self.mod.MaintenanceRefused):
                system.stop(lease)
        self.assertEqual(calls, [])

    def test_real_stop_requires_the_current_held_lease(self):
        system = self.adapter()
        system.live = lambda **kwargs: {"boot_id": "old"}
        calls = []
        system.command = lambda argv, **kwargs: calls.append(argv) or "0"
        with self.assertRaises(self.mod.MaintenanceRefused):
            system.stop({"boot_id": "old", "lease": "unheld", "expires_at_ms": 9999999999999,
                         "deadline_monotonic": self.mod.time.monotonic() + 240})
        self.assertEqual(calls, [])

    def test_inactive_recovery_refuses_leftover_service_processes(self):
        system = self.adapter()
        system.binary = self.root / "binary"
        system.binary.write_bytes(b"backup")
        transaction = {"backup": {"sha256": self.mod.digest(system.binary)}}
        def offline(**kwargs):
            raise RuntimeError("No daemon responds")
        system.live = offline
        system.command = lambda argv, **kwargs: "0" if "MainPID" in argv else "inactive"
        def leftover(**kwargs):
            raise ValueError("busy: leftover service worker")
        system.no_service_children = leftover
        with self.assertRaisesRegex(ValueError, "leftover"):
            system.recovery_begin(transaction)
        self.assertIsNone(system.active_lease)

    def test_inactive_recovery_does_not_hide_mismatched_rpc_identity(self):
        system = self.adapter()
        system.binary = self.root / "binary"
        system.binary.write_bytes(b"backup")
        transaction = {"backup": {"sha256": self.mod.digest(system.binary)}}
        def mismatch(**kwargs):
            raise ValueError("RPC daemon identity does not match")
        system.live = mismatch
        system.command = lambda argv, **kwargs: "0" if "MainPID" in argv else "inactive"
        with self.assertRaisesRegex(ValueError, "identity"):
            system.recovery_begin(transaction)
        self.assertIsNone(system.active_lease)

    def test_stopped_restore_rechecks_for_service_descendants(self):
        system = self.adapter()
        system.active_lease = {"ready": True, "stopped": True}
        calls = []
        system.command = lambda argv, **kwargs: calls.append(argv) or "0"
        def leftover(**kwargs):
            raise ValueError("busy: leftover service worker")
        system.no_service_children = leftover
        system.replace = lambda *args: self.fail("Unexpected binary replacement")
        with self.assertRaisesRegex(ValueError, "leftover"):
            system.restore({"path": "/backup", "sha256": "hash"})
        self.assertFalse(any("stop" in call for call in calls))

    def test_real_restore_adapter_requires_a_current_lease(self):
        system = self.adapter()
        with self.assertRaises(self.mod.MaintenanceRefused):
            system.restore({"path": "/backup", "sha256": "hash"})

    def test_recovery_rejects_a_newer_manual_executable_before_stopping(self):
        system = self.adapter()
        system.binary = self.root / "manual-binary"
        system.binary.write_bytes(b"unrelated manual deployment")
        with self.assertRaisesRegex(ValueError, "unrelated"):
            system.recovery_begin({"backup": {"sha256": "old"}, "candidate": {"sha256": "candidate"}})

    def test_recovery_rechecks_that_an_inactive_service_did_not_start(self):
        system = self.adapter()
        system.active_lease = {"ready": True, "stopped": True}
        calls = []
        def command(argv, **kwargs):
            calls.append(argv)
            return "42"
        system.command = command
        with self.assertRaises(self.mod.MaintenanceRefused):
            system.restore({"path": "/backup", "sha256": "hash"})
        self.assertEqual(len(calls), 1)
        self.assertIn("MainPID", calls[0])


class NightlyTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_updater()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.system = FakeSystem()
        self.system.channel = "nightly"
        self.system.current.update(version="0.9.4", build_commit="a" * 12,
                                   build_identity=self.identity(100, "a"))
        self.system.release = self.manifest(101, "b")
        self.system.candidate.update(self.system.release)

    def identity(self, number, sha):
        return {"channel": "nightly", "version": "0.9.4", "buildNumber": number, "commit": sha * 40}

    def manifest(self, number, sha):
        return {**self.identity(number, sha), "schemaVersion": 1, "tag": "nightly-20261123-" + sha * 7}

    def test_build_number_drives_same_version_updates_and_rollback_floor(self):
        self.assertEqual(self.mod.update(self.system, self.root)["status"], "updated")
        state = json.loads((self.root / "state.json").read_text())
        self.assertEqual(state["highest_build_number"], 101)
        self.assertEqual(state["highest_commit"], "b" * 40)
        self.assertNotIn("highest_version", state)
        self.system.events.clear()
        self.system.current = state["backup"]["live"]
        self.assertEqual(self.mod.update(self.system, self.root)["status"], "current")
        self.assertEqual(self.system.events, [])

    def test_rolled_back_build_number_quarantines_its_identity_and_blocks_replays(self):
        self.system.current["build_identity"] = self.identity(99, "a")
        self.system.fail_health = True
        self.assertEqual(self.mod.update(self.system, self.root)["status"], "rolled_back")
        state = json.loads((self.root / "state.json").read_text())
        self.assertEqual(state["failed_build_number"], 101)
        self.assertEqual(state["failed_commit"], "b" * 40)
        self.system.events.clear()

        self.assertEqual(self.mod.update(self.system, self.root)["status"], "quarantined")
        self.system.release = {**self.manifest(101, "b"), "commit": "b" * 7 + "c" * 33}
        with self.assertRaisesRegex(ValueError, "two source commits"):
            self.mod.update(self.system, self.root)
        self.system.release = self.manifest(100, "c")
        self.assertEqual(self.mod.update(self.system, self.root)["status"], "current")
        self.assertEqual(self.system.events, [])

        self.system.fail_health = False
        self.system.release = self.manifest(102, "d")
        self.system.candidate.update(self.system.release)
        self.assertEqual(self.mod.update(self.system, self.root)["status"], "updated")
        state = json.loads((self.root / "state.json").read_text())
        self.assertEqual(state["highest_build_number"], 102)
        self.assertNotIn("failed_build_number", state)
        self.assertNotIn("failed_commit", state)

    def test_rejects_conflicting_and_malformed_builds_before_mutation(self):
        for fields in ({"buildNumber": 100}, {"buildNumber": True}, {"buildNumber": 2**53}, {"buildNumber": 0},
                       {"commit": "b" * 7}, {"tag": "nightly"}, {"tag": "nightly-20261123-aaaaaaa"},
                       {"tag": "v0.9.4"}, {"channel": "stable"}, {"schemaVersion": 2}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.system.release = {**self.manifest(101, "b"), **fields}
                self.mod.update(self.system, self.root)
        self.assertEqual(self.system.events, [])

    def test_rejects_candidate_identity_mismatch_before_reserving_maintenance(self):
        self.system.candidate["buildNumber"] = 102
        with self.assertRaisesRegex(ValueError, "candidate identity"):
            self.mod.update(self.system, self.root)
        self.assertEqual(self.system.events, ["prepare"])

    def test_tag_must_resolve_to_full_manifest_commit_before_candidate_build(self):
        system = self.mod.System({"user": "root"}, self.root, "nightly")
        system.source = self.root / "source"
        (system.source / ".git").mkdir(parents=True)
        called = []

        def command(argv, **kwargs):
            called.append(argv)
            if argv[:3] == ["git", "remote", "get-url"]:
                return self.mod.REPOSITORY
            if argv[:2] == ["git", "rev-parse"]:
                return "b" * 7 + "c" * 33
            return ""

        system.command = command
        with self.assertRaisesRegex(ValueError, "different source commit"):
            system.prepare(self.system.release)
        self.assertEqual(called[-2][-1], "refs/tags/nightly-20261123-bbbbbbb")
        self.assertEqual(called[-1], ["git", "rev-parse", "FETCH_HEAD^{commit}"])

    def test_daemon_unit_binary_data_cache_and_request_are_separate(self):
        stable = self.mod.System({"user": "root"}, self.root)
        nightly = self.mod.System({"user": "root"}, self.root, "nightly")
        self.assertEqual(nightly.unit, "apex-daemon-nightly@root.service")
        self.assertEqual(nightly.binary, Path("/usr/local/bin/apex-daemon-nightly"))
        self.assertEqual(nightly.data.name, "dev.apexdeck.app.nightly")
        self.assertEqual(nightly.work.name, "apex-deck-nightly-update")
        self.assertEqual(nightly.request, Path("/run/apex-deck-nightly-update/0.request"))
        for unit in (stable.unit, "apex-daemon-managed@root.service", "apex-daemon-nightly@another.service"):
            with self.subTest(unit=unit), self.assertRaisesRegex(ValueError, "service unit"):
                self.mod.System({"user": "root", "unit": unit}, self.root, "nightly")
        with self.assertRaisesRegex(ValueError, "own absolute daemon data directory"):
            self.mod.System({"user": "root", "data_dir": str(stable.data)}, self.root, "nightly")
        with self.assertRaisesRegex(ValueError, "socket path"):
            self.mod.System({"user": "root", "data_dir": "/" + "é" * 60}, self.root, "nightly")


if __name__ == "__main__":
    unittest.main()
