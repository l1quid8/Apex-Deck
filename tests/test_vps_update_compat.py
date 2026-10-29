"""Exercise the staging-only Linux compatibility carry against released source."""

import importlib.util
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
