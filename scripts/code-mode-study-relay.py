#!/usr/bin/env python3
"""Benchmark-only stdio relay. Record batch requests and replies by process and RPC id."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

# The client may clear inherited environment variables. Resolve study paths from
# the invoked wrapper in the isolated turn directory, not provider environment.
root = Path(sys.argv[0]).absolute().parent
helper = (root / "installed-relay").resolve(strict=True)
if sys.argv[1:] != ["--code-mode-mcp"]:
    os.execv(helper, [str(helper), *sys.argv[1:]])

with subprocess.Popen([helper, *sys.argv[1:]], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as child:
    ids = set()
    lock = threading.Lock()
    with (root / f"batches-{os.getpid()}.jsonl").open("x", buffering=1) as log:
        def forward(source, dest, incoming):
            for line in source:
                try:
                    frame = json.loads(line)
                except (UnicodeDecodeError, ValueError):
                    frame = None
                if isinstance(frame, dict):
                    with lock:
                        rpc_id = frame.get("id")
                        if incoming and frame.get("method") == "tools/call" and frame.get("params", {}).get("name") == "deck_code_mode":
                            ids.add(rpc_id)
                            print(json.dumps({"id": rpc_id, "plan": frame["params"].get("arguments")}), file=log)
                        elif not incoming and rpc_id in ids:
                            ids.remove(rpc_id)
                            print(json.dumps({"id": rpc_id, "reply": frame.get("result"), "error": frame.get("error")}), file=log)
                dest.write(line)
                dest.flush()
            dest.close()

        threading.Thread(target=forward, args=(sys.stdin.buffer, child.stdin, True), daemon=True).start()
        forward(child.stdout, sys.stdout.buffer, False)
    sys.exit(child.wait())
