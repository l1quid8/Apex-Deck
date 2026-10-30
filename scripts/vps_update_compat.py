"""Carry the deployed 02f3a24 Linux workaround into supported release source.

This runs only in the updater's disposable, unprivileged build checkout. It is
not a security fix: it preserves the deployed SSH/local room-action behavior.
Unknown admission or phone routing changes refuse preparation before writing.
"""

import hashlib
import re
from pathlib import Path


class CompatibilityError(RuntimeError):
    pass


COMMAND = Path("crates/apex-host/src/command.rs")
TEST_NAME = "vps_update_allow_compatibility"
TEST_BEGIN = "    // BEGIN apex VPS update compatibility check\n"
TEST_END = "    // END apex VPS update compatibility check\n"

# SHA-256 of whitespace-normalized, complete bounded Rust function regions,
# taken from v0.9.4 (10f47ca9e504) and the deployed fix (02f3a24f8659).
# Accepting a new shape requires reviewing its routing and updating these
# guards; a textual anchor match alone never authorizes changing admission.
OLD_ADMISSION = "69ee66d1646cc02a183962f13fb0a11600cabda05270f2912206b5b3a155a4d4"
FIXED_ADMISSION = "a65f6cf2c822915a0af4726bf135ae7fb0efd9c96d8eea5dafb974737012df8e"
FIXED_ADMIN = "12335605e14aed64c3653030e46c9ee94688a0dbf1f3a42b8683d2cb1698fce5"
OLD_DEVICE = {
    "a161df9cb58f99cc01d9340e5b1aecadc0d979cf7ce519a9e4486f4b83ab00b7",  # 0.9.4 folder exception
    "b581d41490c714c63d6dcf73967ee5a641dd17f72eeb8bab23f625362797bbb7",  # deployed fix's parent
}
FIXED_DEVICE = {
    "eebb5d7df273f7a50a285dde9b22e88586058744bd99460b8da40da3f1e9947b",  # 0.9.4 folder exception retained
    "7b449061993815f5a8a76ad708ec53171a7c70d4dec184f450cabd79eaea7fa6",  # 02f3a24
}

PUBLIC_SIGNATURE = "    pub async fn call_with_client_capability(self: &Arc<Self>, command: Command, capability: apex_core::GeneratedUiCapability) -> Result<Value, String> {\n"
ADMIT_HEADER = '''        self.admit(command, capability, cfg!(target_os = "linux")).await
    }

    /// `local_admin` is true only for local socket/SSH stdio calls on Linux.
    /// Linux has no signed UI broker, so the Mac app sends room actions there
    /// unsigned (desktop/provenance.mjs needsAttestation) and SSH login is the
    /// trust boundary. Assistant commands and paired phones keep the gate.
    async fn admit(self: &Arc<Self>, command: Command, capability: apex_core::GeneratedUiCapability, local_admin: bool) -> Result<Value, String> {
'''
ADMIN_METHOD = '''    /// Protected room actions the Mac app sends unsigned to a Linux host.
    /// Room posts in assistant rooms are not here; they stay protected.
    pub fn is_room_admin(&self) -> bool {
        matches!(self, Self::RoomDecide { .. } | Self::RoomAnswer { .. } | Self::RoomCreate { .. } | Self::RoomImport { .. } | Self::RoomFork { .. } | Self::RoomUpdateParticipant { .. } | Self::RoomAddParticipant { .. } | Self::RoomRemoveParticipant { .. } | Self::RoomSetOptions { .. } | Self::RoomForgetAllowed { .. } | Self::RoomSetPlan { .. } | Self::RoomMount { .. })
    }

'''


def _digest(text):
    return hashlib.sha256(re.sub(r"\s+", "", text).encode()).hexdigest()


def _one(text, anchor):
    if text.count(anchor) != 1:
        raise CompatibilityError(f"Unsupported release source: expected one {anchor.strip()!r}")
    return text.index(anchor)


def _regions(text):
    start = _one(text, PUBLIC_SIGNATURE)
    end = _one(text, "    /// Called only with the peer ID")
    device = _one(text, "    pub async fn call_from_device(")
    try:
        device_end = text.index('        #[cfg(feature="test-support")]', device)
    except ValueError as error:
        raise CompatibilityError("Unsupported release source: phone routing boundary missing") from error
    if not start < end < device < device_end:
        raise CompatibilityError("Unsupported release source: admission boundaries moved")
    return text[start:end], text[device:device_end]


def _fixed_shape(text):
    admission, device = _regions(text)
    if _digest(admission) != FIXED_ADMISSION or _digest(device) not in FIXED_DEVICE:
        raise CompatibilityError("Unsupported or partial Linux room-action compatibility routing")
    start = _one(text, "    pub fn is_room_admin(")
    try:
        end = text.index("\n    }", start) + len("\n    }")
    except ValueError as error:
        raise CompatibilityError("Incomplete Linux room-action method") from error
    if _digest(text[start:end]) != FIXED_ADMIN or text.count("    async fn admit(") != 1:
        raise CompatibilityError("Unsupported or partial Linux room-action allowlist")


def prepare_source(source_root: Path) -> dict:
    """Verify/carry the workaround and insert its real API regression test.

    All source compatibility checks happen in memory before the single write.
    Return enough provenance for the updater's build receipt. Repeated calls
    leave the staged source byte-identical.
    """
    command = Path(source_root) / COMMAND
    original = command.read_text()
    text = original
    admission, device = _regions(text)
    carried = False
    has_admin = "is_room_admin" in text
    has_admit = "async fn admit(" in text
    if has_admin or has_admit:
        _fixed_shape(text)
    else:
        if _digest(admission) != OLD_ADMISSION or _digest(device) not in OLD_DEVICE:
            raise CompatibilityError("Unsupported release source: admission or phone routing changed")
        rewritten = admission.replace(PUBLIC_SIGNATURE, PUBLIC_SIGNATURE + ADMIT_HEADER, 1)
        gate = "        let needs_receipt = |command:&Command| -> Result<bool,String> {\n"
        _one(rewritten, gate)
        rewritten = rewritten.replace(gate, gate + "            if local_admin && command.is_room_admin() {return Ok(false);}\n", 1)
        # Replace only the already-verified Linux phone prefix. In particular,
        # keep v0.9.4's independently authorized device_folder_command branch.
        fallback = "return self.call_with_client_capability(command, capability).await;"
        _one(device, fallback)
        rewritten_device = device.replace(fallback, "return self.admit(command, capability, false).await;", 1)
        text = text.replace(admission, rewritten, 1).replace(device, rewritten_device, 1)
        anchor = '    /// Read a command from `{ "cmd", "args" }`.'
        _one(text, anchor)
        text = text.replace(anchor, ADMIN_METHOD + anchor, 1)
        _fixed_shape(text)
        carried = True

    test_asset = Path(__file__).with_name("vps-update-allow-test.rs").read_text()
    test_block = TEST_BEGIN + test_asset.rstrip() + "\n" + TEST_END
    test_added = TEST_NAME not in text and TEST_BEGIN not in text and TEST_END not in text
    if test_added:
        anchor = "#[cfg(test)]\nmod tests {\n"
        _one(text, anchor)
        text = text.replace(anchor, anchor + test_block, 1)
    elif (text.count(test_block) != 1 or text.count(f"fn {TEST_NAME}()") != 1
          or text.count(TEST_BEGIN) != 1 or text.count(TEST_END) != 1):
        raise CompatibilityError("Changed or partial updater regression test in staged source")
    if text != original:
        command.write_text(text)
    return {
        "carried_hotfix": carried,
        "test_added": test_added,
        "command_sha256": hashlib.sha256(text.encode()).hexdigest(),
    }
