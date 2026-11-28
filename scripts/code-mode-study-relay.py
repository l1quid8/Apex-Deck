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
        def record(line, incoming):
            frame = json.loads(line)
            if not isinstance(frame, dict) or type(frame.get("id")) not in (int, str):
                return
            rpc_id = frame["id"]
            params = frame.get("params")
            with lock:
                if incoming:
                    if (frame.get("method") != "tools/call" or not isinstance(params, dict)
                            or params.get("name") != "deck_code_mode"):
                        return
                    ids.add(rpc_id)
                    entry = {"id": rpc_id, "plan": params.get("arguments")}
                elif rpc_id in ids:
                    ids.remove(rpc_id)
                    entry = {"id": rpc_id, "reply": frame.get("result"), "error": frame.get("error")}
                else:
                    return
                print(json.dumps(entry), file=log)

        def forward(source, dest, incoming):
            try:
                for line in source:
                    try:
                        record(line, incoming)
                    except (OSError, UnicodeError, ValueError, RecursionError) as error:
                        print(f"Study trace skipped a frame: {error}", file=sys.stderr)
                    dest.write(line)
                    dest.flush()
            except BrokenPipeError:
                pass
            finally:
                if incoming:
                    dest.close()

        threading.Thread(target=forward, args=(sys.stdin.buffer, child.stdin, True), daemon=True).start()
        forward(child.stdout, sys.stdout.buffer, False)
    sys.exit(child.wait())
