"""Run matched full turns with an authenticated local CLI and APEX_DECK_BIN relay.

Build with cargo build -p apex-adapters --example code_mode_turn, then provide the
example executable as --driver, --family codex or claude_code, --model and --out.
Each invocation creates an exclusive JSONL file. Six orders per task balance arm
position. fresh_input includes cache creation. The Claude counter is num_turns;
Codex exposes distinct cumulative usage updates, a proxy for model round trips.
"""
import argparse
import hashlib
import itertools
import json
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import tempfile

ARMS = ("off", "forced", "selective")
TASKS = ("lookup", "conditional", "indexed")


def fixture(seed, task):
    rng = random.Random(seed)
    files = {}
    rows = []
    selected = sorted(rng.sample(range(32), 7))
    for i in range(32):
        name = f"station-{i:02}.log"
        data = [{"band": rng.choice(["amber", "blue", "green"]),
                 "delay": rng.randrange(200), "lot": rng.getrandbits(44)}
                for _ in range(32)]
        noise = [rng.randbytes(100).hex() for _ in data]
        files[name] = "".join(f"note {n}\nSCAN {json.dumps(row)}\n"
                              for n, row in zip(noise, data))
        include = {"lookup": i == 7, "indexed": i in selected, "conditional": True}[task]
        if include:
            rows.extend(row for row in data if task != "conditional" or row["band"] == "amber")
    files["dispatch.txt"] = "\n".join(f"station-{i:02}.log" for i in selected) + "\n"
    scope = {"lookup": "Select every SCAN in station-07.log only.",
             "conditional": "Use all 32 station logs, selecting only scans whose band equals amber.",
             "indexed": "Select every SCAN in the station logs named in dispatch.txt."}[task]
    prompt = (scope + " Each SCAN line contains a JSON object after the prefix. "
              "Return only a JSON object with integer count (selected scans) and total (sum of their delay).")
    return files, prompt, {"count": len(rows), "total": sum(r["delay"] for r in rows)}


def run(args, files, prompt, arm):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        workspace = root / "fixture"
        workspace.mkdir()
        for name, content in files.items():
            (workspace / name).write_text(content)
        state = root / "state"
        state.mkdir()
        name = {"claude_code": "claude", "codex": "codex"}[args.family]
        provider = shutil.which(name)
        if not provider:
            raise FileNotFoundError(name)
        meter = root / "bin"
        meter.mkdir()
        (meter / name).symlink_to(Path(__file__).resolve().with_name("code-mode-provider-meter.py"))
        (root / "installed-relay").symlink_to(Path(os.environ["APEX_DECK_BIN"]).resolve(strict=True))
        relay = root / "study-relay"
        shutil.copy2(Path(__file__).with_name("code-mode-study-relay.py"), relay)
        counters = root / "counters.jsonl"
        env = {**os.environ, "APEX_DECK_BIN": str(relay), "STUDY_PROMPT": prompt, "STUDY_PROVIDER": provider,
               "STUDY_COUNTERS": str(counters), "PATH": str(meter) + os.pathsep + os.environ["PATH"]}
        try:
            proc = subprocess.run([args.driver, args.family, args.model, arm, workspace, state],
                                  env=env, capture_output=True, text=True, check=True, timeout=210)
            row = json.loads(proc.stdout)
        except (OSError, subprocess.SubprocessError, ValueError) as error:
            # Keep partial relay evidence when the driver exits or times out.
            row = {"result": {"error": str(error)}, "steps": []}
        row["batch_traces"] = {
            path.stem: [json.loads(line) for line in path.read_text().splitlines()]
            for path in sorted(root.glob("batches-*.jsonl"))
        }
        events = [json.loads(line) for line in counters.read_text().splitlines()] if counters.exists() else []
        for metric in ("claude_model_turns", "codex_usage_updates"):
            values = [e[metric] for e in events if metric in e]
            row[metric] = sum(values) if values else None
        return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ["driver", "family", "model", "out"]:
        parser.add_argument("--" + arg, required=True)
    parser.add_argument("--seed", type=int, default=130001)
    args = parser.parse_args()
    if args.family not in ("claude_code", "codex"):
        parser.error("this comparison needs an adapter with the Code Mode bridge")
    orders = list(itertools.permutations(ARMS))
    with open(args.out, "x", buffering=1) as log:
        for repeat in range(6):
            for index, task in enumerate(TASKS):
                files, prompt, truth = fixture(args.seed + 3 * repeat + index, task)
                digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
                for arm in orders[(repeat + index) % len(orders)]:
                    try:
                        row = run(args, files, prompt, arm)
                    except (OSError, subprocess.SubprocessError, ValueError) as error:
                        row = {"result": {"error": str(error)}, "steps": []}
                    result = row["result"]
                    answer = re.sub(r"^\x60{3}(?:json)?\s*|\s*\x60{3}$", "", result.get("answer", "").strip())
                    try:
                        value = json.loads(answer)
                    except ValueError:
                        value = None
                    correct = value == truth and all(type(n) is int for n in value.values())
                    row.update(model=args.model, family=args.family, repeat=repeat, task=task,
                               arm=arm, correct=correct, expected=truth, fixture_sha256=digest,
                               fixture_bytes=sum(len(s.encode()) for s in files.values()))
                    print(json.dumps(row), file=log)
                    if "error" in result:
                        raise SystemExit(result["error"])


if __name__ == "__main__":
    main()
