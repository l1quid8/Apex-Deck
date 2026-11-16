#!/usr/bin/env python3
"""Run the native updater's admission and maintenance acceptance checks in a Linux checkout."""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from vps_update import candidate_checks, verify_candidate_result
from vps_update_compat import COMMAND, prepare_source


def main():
    if sys.platform != "linux":
        raise SystemExit("Candidate acceptance requires Linux for the jail and device tests")
    root = Path(__file__).resolve().parents[1]
    # Preparation can write historical sources. Inspect disposable copies of the
    # candidate's actual admission and maintenance modules before selecting tests.
    with tempfile.TemporaryDirectory(prefix="vps-candidate-") as directory:
        fixture = Path(directory)
        for source in (COMMAND, Path("crates/apex-host/src/maintenance.rs"), Path("crates/apex-daemon/src/maintenance.rs")):
            (fixture / source).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / source, fixture / source)
        if not prepare_source(fixture).get("native_maintenance"):
            raise SystemExit("Expected native Linux admission and maintenance")

    for argv, expected in candidate_checks(native_maintenance=True):
        print(" ".join(argv), flush=True)
        result = subprocess.run(argv, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        print(result.stdout, flush=True)
        result.check_returncode()
        verify_candidate_result(result.stdout, expected)


if __name__ == "__main__":
    main()
