"""Exercise the installed feed reader against a local release mirror."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

module = Path(__file__).resolve().parents[1] / "scripts/linux-installer/fetch-nightly.py"
spec = importlib.util.spec_from_file_location("fetch_nightly", module)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class NativeFeed(unittest.TestCase):
    def test_downloads_only_release_inputs_and_checks_feed_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            name = "Apex-Deck-Nightly_20261128_abcdef0_arm64.linux-installer"
            bundle = root / (name + ".tar")
            manifest = dict(channel="nightly", version="1", buildNumber=12, commit="abcdef0" + "1"*33)
            inputs = {"manifest.json": json.dumps(manifest).encode(), "payload.tar": b"payload", "manifest.sig": bytes(64)}
            with tarfile.open(bundle, "w") as archive:
                for filename, data in inputs.items():
                    info = tarfile.TarInfo(name + "/release/" + filename)
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
            raw = bundle.read_bytes()
            asset = dict(arch="arm64", name=bundle.name, size=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            feed = dict(manifest, platform="linux", assetTag="nightly-linux-20261128-abcdef0", installers=[asset])

            def download(url, path, limit):
                data = json.dumps(feed).encode() if url.endswith(".json") else raw
                self.assertLessEqual(len(data), limit)
                path.write_bytes(data)

            with patch.object(reader, "download", download):
                work = root / "work"
                work.mkdir()
                reader.fetch(work, "arm64")
                for filename, data in inputs.items():
                    self.assertEqual((work / filename).read_bytes(), data)
                feed["buildNumber"] += 1
                other = root / "other"
                other.mkdir()
                with self.assertRaisesRegex(ValueError, "identity differs"):
                    reader.fetch(other, "arm64")


if __name__ == "__main__":
    unittest.main()
