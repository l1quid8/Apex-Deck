"""Exercise the staging-only Linux compatibility carry against released source."""

import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMMAND = Path("crates/apex-host/src/command.rs")
RELEASE = "10f47ca9e5044cba0f4e2e33ec8dc26cdb8a382d"
DEPLOYED_FIX = "02f3a24f865922731ac614207227300a10a26f3a"


def historical_source(commit):
    label = {RELEASE: "v0.9.4", DEPLOYED_FIX: "02f3a24"}[commit]
    return (ROOT / "tests/fixtures/vps-update" / (label + "-routing.rs.txt")).read_text()


class SourceCompatibilityTests(unittest.TestCase):
    def setUp(self):
        module_path = ROOT / "scripts/vps_update_compat.py"
        self.assertTrue(module_path.exists(), "source compatibility helper is missing")
        spec = importlib.util.spec_from_file_location("vps_update_compat", module_path)
        self.compat = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.compat)
        self.temp = tempfile.TemporaryDirectory(prefix="apex-source-compat-test-")
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name)
        self.command = self.source / COMMAND
        self.command.parent.mkdir(parents=True)

    def stage(self, commit=RELEASE):
        self.command.write_text(historical_source(commit))

    def stage_native(self):
        shutil.copyfile(ROOT / COMMAND, self.command)
        for name in ("apex-daemon", "apex-host"):
            module = Path("crates") / name / "src/maintenance.rs"
            (self.source / module).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / module, self.source / module)

    def test_native_release_preserves_current_admission(self):
        self.stage_native()
        before = self.command.read_bytes()
        self.assertTrue(self.compat.prepare_source(self.source)["native_maintenance"])
        self.assertTrue(self.compat.prepare_source(self.source, native_only=True)["native_maintenance"])
        self.assertEqual(self.command.read_bytes(), before)
        modified = before.replace(b"local_linux_cli_admitted()?;", b"/* probe skipped */")
        self.assertNotEqual(modified, before)
        self.command.write_bytes(modified)
        with self.assertRaises(self.compat.CompatibilityError):
            self.compat.prepare_source(self.source)
        self.assertEqual(self.command.read_bytes(), modified)

    def test_native_retired_full_access_route_remains_read_only(self):
        self.stage_native()
        current = self.command.read_text()
        previous = current.replace(
            "Command::PersonalBrowserSession {}",
            "Command::PersonalBrowserSession {} | Command::AgentFullAccess { .. }", 1
        )
        self.assertNotEqual(previous, current)
        self.command.write_text(previous)
        self.assertTrue(self.compat.prepare_source(self.source)["native_maintenance"])
        self.assertEqual(self.command.read_text(), previous)

    def test_native_full_access_exception_does_not_accept_broader_or_unchecked_routes(self):
        self.stage_native()
        current = self.command.read_text()
        mutations = {
            "broader paired bypass": (
                "if matches!(command, Command::PersonalBrowserSession {}) {",
                "if matches!(command, Command::PersonalBrowserSession {} | Command::SettingsSave { .. }) {",
            ),
            "missing confined authorization": (
                "        check()?;\n        match command {",
                "        match command {",
            ),
            "missing raw receipt gate": (
                "command if needs_receipt(&command)? => return Err(",
                "command if false => return Err(",
            ),
            "missing terminal surface check": (
                'if !cfg!(target_os = "linux") || !local_linux_cli_surface(&command) {',
                'if !cfg!(target_os = "linux") {',
            ),
        }
        for name, (before, after) in mutations.items():
            with self.subTest(mutation=name):
                self.assertEqual(current.count(before), 1, "mutation must target one reviewed routing gate")
                modified = current.replace(before, after, 1)
                self.command.write_text(modified)
                for native_only in (False, True):
                    with self.assertRaisesRegex(self.compat.CompatibilityError, "Unsupported native Linux admission routing"):
                        self.compat.prepare_source(self.source, native_only=native_only)
                    self.assertEqual(self.command.read_text(), modified)

    def test_nightly_cannot_carry_the_historical_stable_patch(self):
        self.stage()
        before = self.command.read_bytes()
        with self.assertRaisesRegex(self.compat.CompatibilityError, "requires native"):
            self.compat.prepare_source(self.source, native_only=True)
        self.assertEqual(self.command.read_bytes(), before)

    def test_release_carries_fix_and_preserves_phone_folder_exception(self):
        self.stage()
        before = self.command.read_text()
        result = self.compat.prepare_source(self.source)
        after = self.command.read_text()
        self.assertTrue(result["carried_hotfix"])
        self.assertTrue(result["test_added"])
        self.assertIn('self.admit(command, capability, cfg!(target_os = "linux")).await', after)
        self.assertIn("if local_admin && command.is_room_admin()", after)
        self.assertIn("return self.admit(command, capability, false).await;", after)
        exception = before.split("            // The one exception:", 1)[1].split(
            "            return self.call_with_client_capability", 1
        )[0]
        self.assertIn("            // The one exception:" + exception, after)
        self.assertEqual(after.count("fn vps_update_allow_compatibility()"), 1)

    def test_deployed_hotfix_is_accepted_without_reapplying(self):
        self.stage(DEPLOYED_FIX)
        result = self.compat.prepare_source(self.source)
        self.assertFalse(result["carried_hotfix"])
        self.assertTrue(result["test_added"])
        self.assertEqual(self.command.read_text().count("pub fn is_room_admin("), 1)

    def test_second_preparation_is_byte_identical(self):
        self.stage()
        self.compat.prepare_source(self.source)
        first = self.command.read_bytes()
        result = self.compat.prepare_source(self.source)
        self.assertEqual(self.command.read_bytes(), first)
        self.assertFalse(result["carried_hotfix"])
        self.assertFalse(result["test_added"])

    def test_changed_admission_shape_is_rejected_without_any_write(self):
        self.stage()
        text = self.command.read_text().replace(
            "if command.requires_provenance() {return Ok(true);}",
            "if command.requires_provenance() {return Ok(false);}", 1
        )
        self.assertNotEqual(text, self.command.read_text())
        self.command.write_text(text)
        with self.assertRaises(self.compat.CompatibilityError):
            self.compat.prepare_source(self.source)
        self.assertEqual(self.command.read_text(), text)

    def test_partial_existing_fix_is_rejected(self):
        self.stage(DEPLOYED_FIX)
        text = self.command.read_text().replace(
            "if local_admin && command.is_room_admin() {return Ok(false);}", "", 1
        )
        self.command.write_text(text)
        with self.assertRaises(self.compat.CompatibilityError):
            self.compat.prepare_source(self.source)
        self.assertEqual(self.command.read_text(), text)

    def test_changed_phone_path_is_rejected(self):
        self.stage()
        text = self.command.read_text().replace(
            "if self.device_folder_command(&command)? {",
            "if true {", 1
        )
        self.command.write_text(text)
        with self.assertRaises(self.compat.CompatibilityError):
            self.compat.prepare_source(self.source)
        self.assertEqual(self.command.read_text(), text)

    def test_partial_or_changed_injected_test_is_rejected(self):
        self.stage()
        self.compat.prepare_source(self.source)
        text = self.command.read_text().replace(
            "fn vps_update_allow_compatibility()", "fn vps_update_allow_compatibility_broken()", 1
        )
        self.command.write_text(text)
        with self.assertRaises(self.compat.CompatibilityError):
            self.compat.prepare_source(self.source)
        self.assertEqual(self.command.read_text(), text)

    def test_broadened_deployed_allowlist_is_rejected(self):
        self.stage(DEPLOYED_FIX)
        text = self.command.read_text().replace(
            "matches!(self, Self::RoomDecide { .. }",
            "matches!(self, Self::PersonalSend { .. } | Self::RoomDecide { .. }", 1
        )
        self.command.write_text(text)
        with self.assertRaises(self.compat.CompatibilityError):
            self.compat.prepare_source(self.source)
        self.assertEqual(self.command.read_text(), text)

    def test_duplicate_test_marker_is_rejected(self):
        self.stage()
        self.compat.prepare_source(self.source)
        text = self.command.read_text() + "    // END apex VPS update compatibility check\n"
        self.command.write_text(text)
        with self.assertRaises(self.compat.CompatibilityError):
            self.compat.prepare_source(self.source)
        self.assertEqual(self.command.read_text(), text)


if __name__ == "__main__":
    unittest.main()
