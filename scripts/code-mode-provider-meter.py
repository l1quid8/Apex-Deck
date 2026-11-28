#!/usr/bin/env python3
"""Transparent benchmark-only CLI stdout relay. Persist counters, never frames."""
import json
import os
from pathlib import Path
import subprocess
import sys

provider = os.environ["STUDY_PROVIDER"]
if "app-server" not in sys.argv and "--output-format" not in sys.argv:
    os.execv(provider, [provider, *sys.argv[1:]])

with subprocess.Popen([provider, *sys.argv[1:]], stdout=subprocess.PIPE) as child:
    previous_total = None
    with Path(os.environ["STUDY_COUNTERS"]).open("a", buffering=1) as counters:
        for line in child.stdout:
            try:
                event = json.loads(line)
            except (UnicodeDecodeError, ValueError):
                event = None
            if isinstance(event, dict):
                if event.get("type") == "result" and type(event.get("num_turns")) is int:
                    print(json.dumps({"claude_model_turns": event["num_turns"]}), file=counters)
                if event.get("method") == "thread/tokenUsage/updated":
                    total = event.get("params", {}).get("tokenUsage", {}).get("total", {})
                    if total and total != previous_total:
                        print('{"codex_usage_updates":1}', file=counters)
                        previous_total = total
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
    sys.exit(child.wait())
