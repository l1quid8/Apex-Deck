"""Copy only release inputs from the native Nightly bundle into a private directory."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

BASE = "https://github.com/l1quid8/Apex-Deck/releases/download"
LIMITS = {"manifest.json": 4 << 20, "manifest.sig": 64, "payload.tar": 2 << 30}


def download(url, path, limit):
    subprocess.run(["curl", "--disable", "--fail", "--silent", "--show-error", "--location",
                    "--proto", "=https", "--proto-redir", "=https", "--max-filesize", str(limit),
                    "--output", str(path), url], check=True)


def fetch(work, arch):
    feed_path = work / "feed.json"
    download(f"{BASE}/nightly/apex-deck-nightly-update-linux.json", feed_path, 1 << 20)
    feed = json.loads(feed_path.read_bytes())
    tag = feed["assetTag"]
    identity = re.fullmatch(r"nightly-linux-([0-9]{8})-([a-f0-9]{7})", tag)
    if not identity or feed["channel"] != "nightly" or feed["platform"] != "linux":
        raise ValueError("Unexpected Linux Nightly feed identity")
    date, sha = identity.groups()
    name = f"Apex-Deck-Nightly_{date}_{sha}_{arch}.linux-installer"
    asset, = [a for a in feed["installers"] if a["arch"] == arch]
    size = asset["size"]
    if asset["name"] != name + ".tar" or type(size) is not int or not 0 < size <= 4 << 30:
        raise ValueError("Invalid native installer asset")
    bundle = work / "bundle.tar"
    download(f"{BASE}/{tag}/{name}.tar", bundle, size)
    with bundle.open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    if bundle.stat().st_size != size or digest.hexdigest() != asset["sha256"]:
        raise ValueError("Downloaded installer differs from the Linux feed")
    # Stream named members to fixed private files. No archive-owned path, mode
    # or link is installed, and the outer installer script is never executed.
    for filename, limit in LIMITS.items():
        path = work / filename
        member = f"{name}/release/{filename}"
        with path.open("xb") as output, subprocess.Popen(
            ["tar", "--extract", "--to-stdout", "--file", str(bundle), "--", member],
            stdout=subprocess.PIPE,
        ) as proc:
            while chunk := proc.stdout.read(1 << 20):
                if output.tell() + len(chunk) > limit:
                    proc.kill()
                    raise ValueError(f"Oversized {filename}")
                output.write(chunk)
            if proc.wait():
                raise ValueError(f"Could not read {member}")
    manifest = json.loads((work / "manifest.json").read_bytes())
    if any(manifest[k] != feed[k] for k in ("channel", "buildNumber", "commit", "version")):
        raise ValueError("Manifest identity differs from feed")
    bundle.unlink()


if __name__ == "__main__":
    fetch(Path(sys.argv[1]), {"x64": "x86_64", "arm64": "arm64"}[sys.argv[2]])
