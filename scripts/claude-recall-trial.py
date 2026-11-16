#!/usr/bin/env python3
"""Run and blind-grade the three-thread idle-compaction recall trial.

prepare MANIFEST OUTPUT is offline. run OUTPUT sends four forked Claude
requests per thread, records their cost and never resumes a source in place.
Give only OUTPUT/blind/packet.json and grades.json to a separate grader.
score OUTPUT GRADES verifies the grade sheet and produces report.json.

Manifest schema (three different Deck rooms):
  {"threads": [{"room":"room-id", "source":"/path/to/session-uuid.jsonl",
    "cwd":"/original/project", "model":"claude-opus-5-5", "effort":"medium",
    "first_reply":"An ordinary new thread message",
    "questions":[{"question":"...", "answer":"...", "quote":"..."}]}]}
Each room needs five different questions. A quote must occur in a message
in the first half of the source's rendered Deck conversation. The source's
latest top-level assistant call must use >=100000 prompt tokens. At least
one source prompt must name another bot. Keep trial directories private.

Optional per-thread settings and permission_mode preserve the bot's
permissions. For a one-time revised-prompt retest supply compact_ask in
the manifest, point retest_of at the failed trial directory, and use a new output directory. The trial uses the Claude CLI
on PATH. Nothing in the app schedules or invokes this script.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import signal
import sys
from uuid import UUID, uuid4

COMPACT_ASK = (
    "Preserve what the user wants, decisions and who made them, completed work "
    "(files, commands and results), open questions and next steps. Keep names, "
    "@handles, file paths and exact values. Write compact plain notes. Omit "
    "greetings and small talk. Do not execute tasks or use tools."
)
GRADES = {"right", "partly right", "wrong", "doesn't know"}
TIMEOUT = 600


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def text(content):
    if isinstance(content, str):
        return content
    return "\n".join(b["text"] for b in content or [] if b.get("type") == "text")


def inspect_source(path):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    prompts, messages, usage = [], [], None
    for row in rows:
        if row.get("isSidechain") or row.get("parent_tool_use_id"):
            continue
        msg = row.get("message", {})
        body = text(msg.get("content"))
        if row.get("type") == "user":
            if "--- Conversation so far ---" in body:
                prompts.append(body.partition("--- Conversation so far ---")[0])
                messages = []
            elif "--- New in the conversation since your last reply ---" not in body:
                continue
            body = re.split(r"--- (?:Conversation so far|New in the conversation since your last reply) ---", body, maxsplit=1)[1]
            body = body.partition("--- Your reply ---")[0]
            messages.extend(m.strip() for m in re.split(r"(?m)(?=^\[[^\]\n]+\]: )", body) if m.strip())
        elif row.get("type") == "assistant":
            usage = msg.get("usage") or usage
            if body:
                messages.append(body)
    require(prompts and messages and usage, f"No Deck conversation or assistant usage in {path}")
    tokens = sum(usage.get(k, 0) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    multi = any(re.search(r"The other models are:.*@\w", p) for p in prompts)
    return tokens, multi, messages


def prepare(manifest, output):
    data = read(manifest)
    threads = data["threads"]
    require(len(threads) == len({t["room"] for t in threads}) == 3, "Need three distinct rooms")
    require(len({Path(t["source"]).resolve() for t in threads}) == 3, "Need three distinct sources")
    multi = False
    for t in threads:
        path = Path(t["source"]).resolve(strict=True)
        UUID(path.stem)
        t["source"] = str(path)
        t["cwd"] = str(Path(t["cwd"]).resolve(strict=True))
        require(Path(t["cwd"]).is_dir(), "Invalid project directory")
        require(t.get("model") and t.get("first_reply", "").strip(), "Missing model or ordinary follow-up")
        tokens, several, messages = inspect_source(path)
        require(tokens >= 100_000, f"{t['room']}: last call had only {tokens} prompt tokens")
        t.update(sha256=digest(path), last_prompt_tokens=tokens, multiple_bots=several)
        multi |= several
        qs = t["questions"]
        require(len(qs) == len({q["question"].strip() for q in qs}) == 5, "Need five distinct questions")
        for q in qs:
            require(all(q.get(k, "").strip() for k in ("question", "answer", "quote")), "Missing question evidence")
            early = messages[:len(messages) // 2]
            idx = next((i for i, m in enumerate(early) if q["quote"] in m), None)
            require(idx is not None, f"{t['room']}: quotation outside first half: {q['question']}")
            q["message_number"] = idx + 1
    require(multi, "Need at least one room with multiple bots")
    data.setdefault("compact_ask", COMPACT_ASK)
    require(isinstance(data["compact_ask"], str) and data["compact_ask"].strip(), "Missing compaction instructions")
    data["attempt"] = 1
    if data.get("retest_of"):
        previous = Path(data["retest_of"]).resolve(strict=True)
        prior, report = read(previous / "manifest.json"), read(previous / "report.json")
        require(not report["passed"] and prior["attempt"] == 1, "A retest follows one failed initial trial")
        require(prior["compact_ask"] != data["compact_ask"], "Revise the compaction instructions for a retest")
        require(prior["threads"] == threads, "Retest the same sources, questions and follow-ups")
        data.update(attempt=2, retest_of=str(previous))
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    save(output / "manifest.json", data)


def settings_for(t, blocked):
    # Ignore project/user settings hooks when executing a read-only trial.
    # Managed policy may still preempt the hook; reject that configuration.
    locations = [
        Path("/Library/Application Support/ClaudeCode/managed-settings.json"),
        Path("/etc/claude-code/managed-settings.json"),
    ]
    for loc in list(locations):
        locations.extend(sorted((loc.parent / "managed-settings.d").glob("*.json")))
    own = t.get("settings", {})
    configs = [own] + [read(p) for p in locations if p.exists()]
    require(all(not (d.get("disableAllHooks") or d.get("allowManagedHooksOnly")) for d in configs),
            "Managed or supplied settings disable the trial's tool-denial hook")
    require(not own.get("hooks"), "Custom executable hooks are not supported in recall trials")
    command = shlex.join([sys.executable, str(Path(__file__).resolve()), "_deny", str(blocked)])
    return {**own, "hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": command}]}]}}


def deny(path):
    event = json.load(sys.stdin)
    receipt = {k:event.get(k) for k in ("tool_use_id", "tool_name", "tool_input")}
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(receipt) + "\n")
    print("Idle compaction trial runs without tools.", file=sys.stderr)
    return 2


async def call(t, parent_id, prompt, directory):
    directory.mkdir(mode=0o700)
    blocked = directory / "blocked.jsonl"
    cfg = settings_for(t, blocked)
    args = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
            "--verbose", "--permission-prompt-tool", "stdio", "--model", t["model"],
            "--permission-mode", t.get("permission_mode", "default"), "--setting-sources", "",
            "--settings", json.dumps(cfg), "--resume", parent_id, "--fork-session"]
    if t.get("effort"):
        args.extend(["--effort", t["effort"]])
    env = os.environ.copy()
    env.pop("CLAUDECODE", None)
    attempted, denied, boundaries, result = {}, set(), 0, None
    with (directory / "stderr").open("wb") as stderr:
        proc = await asyncio.create_subprocess_exec(*args, cwd=t["cwd"], env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=stderr,
            start_new_session=True, limit=64 * 1024 * 1024)
        async def send(frame):
            proc.stdin.write((json.dumps(frame) + "\n").encode())
            await proc.stdin.drain()
        async def drive():
            nonlocal boundaries, result
            await send({"type":"user", "message":{"role":"user", "content":prompt}})
            while line := await proc.stdout.readline():
                event = json.loads(line)
                kind = event.get("type")
                if kind == "control_request":
                    req, req_id = event["request"], event["request_id"]
                    if req.get("subtype") == "can_use_tool":
                        call_id = req.get("tool_use_id")
                        denied.add(call_id)
                        attempted[call_id or req_id] = {"tool_name":req.get("tool_name"), "tool_input":req.get("input")}
                        if not call_id:
                            denied.add(req_id)
                        response = {"subtype":"success", "response":{"behavior":"deny", "message":"Recall trial denies all tools."}}
                    else:
                        response = {"subtype":"error", "error":"Control request refused"}
                    await send({"type":"control_response", "response":{"request_id":req_id, **response}})
                if kind == "system" and event.get("subtype") == "compact_boundary":
                    boundaries += 1
                blocks = event.get("message", {}).get("content", [])
                for b in blocks if isinstance(blocks, list) else []:
                    if b.get("type") == "tool_use":
                        attempted[b["id"]] = {"tool_name":b.get("name"), "tool_input":b.get("input")}
                    if b.get("type") == "tool_result":
                        require(b.get("is_error") is True, "A trial tool executed; discard trial")
                if kind == "result":
                    require(result is None, "Unexpected second trial result")
                    result = event
                    proc.stdin.close()
            require(await proc.wait() == 0 and result and not result.get("is_error"), "Claude trial failed (see stderr)")
        try:
            await asyncio.wait_for(drive(), timeout=TIMEOUT)
        finally:
            if proc.returncode is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await proc.wait()
    receipts = [json.loads(line) for line in blocked.read_text().splitlines()] if blocked.exists() else []
    for receipt in receipts:
        call_id = receipt.get("tool_use_id")
        if call_id:
            denied.add(call_id)
            attempted.setdefault(call_id, {k:receipt.get(k) for k in ("tool_name", "tool_input")})
    require(set(attempted) <= denied, "Tool attempt has no matching denial receipt")
    sid = str(UUID(result["session_id"]))
    require(sid != parent_id, "Claude did not create a separate fork")
    row = {"parent":parent_id, "session":sid, "answer":result.get("result", ""), "boundaries":boundaries,
           "attempted_tools":list(attempted.values()), "usage":result["usage"], "cost_usd":result["total_cost_usd"]}
    require(isinstance(row["cost_usd"], (int,float)) and row["cost_usd"] >= 0, "Missing fork cost")
    save(directory / "result.json", row)
    return row


def run(output, invoke=None):
    invoke = invoke or (lambda *args: asyncio.run(call(*args)))
    config = read(output / "manifest.json")
    private = output / "private"
    private.mkdir(mode=0o700, exist_ok=False)
    blind = output / "blind"
    blind.mkdir(mode=0o700)
    packet, key, grades, costs = {}, {}, {}, []
    seen = {Path(t["source"]).stem for t in config["threads"]}
    verify = {Path(t["source"]):t["sha256"] for t in config["threads"]}
    def checked_call(t, parent, prompt, label):
        for path, expected in verify.items():
            require(digest(path) == expected, "Source or compaction checkpoint changed")
        try:
            row = invoke(t, parent, prompt, private / label)
        finally:
            for path, expected in verify.items():
                require(digest(path) == expected, "Source or compaction checkpoint changed")
        require(row["session"] not in seen, "Trial arms shared a Claude session")
        seen.add(row["session"])
        costs.append({"arm":label, "usage":row["usage"], "cost_usd":row["cost_usd"]})
        return row
    for i, t in enumerate(config["threads"], 1):
        parent = Path(t["source"])
        quiz = "Answer these five questions in order using this thread. Say when you don't know.\n" + "\n".join(
            f"{n}. {q['question']}" for n,q in enumerate(t["questions"], 1))
        a = checked_call(t, parent.stem, quiz, f"{i}-control")
        b = checked_call(t, parent.stem, "/compact " + config["compact_ask"], f"{i}-compact")
        require(b["boundaries"] == 1 and a["boundaries"] == 0, "Expected only the compact arm to compact")
        checkpoint = parent.with_name(b["session"] + ".jsonl")
        verify[checkpoint] = digest(checkpoint)
        b1 = checked_call(t, b["session"], quiz, f"{i}-quiz")
        b2 = checked_call(t, b["session"], t["first_reply"], f"{i}-first")
        require(b1["boundaries"] == b2["boundaries"] == 0, "A grading arm compacted unexpectedly")
        entries = [("control", a), ("compacted", b1)]
        secrets.SystemRandom().shuffle(entries)
        for arm, result in entries:
            entry = uuid4().hex
            packet[entry] = {"questions":t["questions"], "reply":result["answer"]}
            grades[entry] = {"grades":[""]*5, "wrong_decision_as_fact":None}
            key[entry] = [i,arm]
        entry = uuid4().hex
        packet[entry] = {"new_message":t["first_reply"], "reply":b2["answer"],
                         "blocked_tools":b2["attempted_tools"]}
        grades[entry] = {"answered_new_message":None, "restarted_old_work":None}
        key[entry] = [i,"first"]
    save(private / "key.json", key)
    save(private / "costs.json", costs)
    save(private / "verified-sources.json", {str(path):expected for path,expected in verify.items()})
    save(blind / "packet.json", packet)
    save(blind / "grades.json", grades)
    (blind / "instructions.txt").write_text(
        "Grade each anonymous quiz answer against the five references in order. "
        "Allowed marks are right, partly right, wrong, and doesn't know. "
        "Set wrong_decision_as_fact to true if the reply asserts any incorrect decision as fact. "
        "For each ordinary new message, determine whether the reply answered it, "
        "and whether its text or blocked tool proposals attempted to restart old work. "
        "Replace every null and empty grade in grades.json. Keep the arm key sealed until scoring.\n"
    )


def score(output, grades_path):
    key, grades = read(output / "private/key.json"), read(grades_path)
    require(grades.keys() == key.keys(), "Grade every anonymous response exactly once")
    eligible = correct = dropped = first_ok = 0
    false_decision = False
    for i in (1,2,3):
        arms = {arm:grades[k] for k,(thread,arm) in key.items() if thread == i}
        for arm in ("control", "compacted"):
            marks = arms[arm]["grades"]
            require(len(marks) == 5 and all(g in GRADES for g in marks), "Missing or invalid quiz grade")
            require(type(arms[arm]["wrong_decision_as_fact"]) is bool, "Missing factuality verdict")
        for a,b in zip(arms["control"]["grades"], arms["compacted"]["grades"]):
            if a == "wrong":
                dropped += 1
            else:
                eligible += 1
                correct += b == "right"
        false_decision |= arms["compacted"]["wrong_decision_as_fact"]
        first = arms["first"]
        require(all(type(first[k]) is bool for k in ("answered_new_message","restarted_old_work")), "Missing first-reply verdict")
        first_ok += first["answered_new_message"] and not first["restarted_old_work"]
    costs = read(output / "private/costs.json")
    report = {"attempt":read(output / "manifest.json")["attempt"],
              "verified_sources":read(output / "private/verified-sources.json"), "eligible":eligible, "right":correct, "dropped_control_wrong":dropped,
              "wrong_decision_as_fact":false_decision, "first_reply_passed":first_ok,
              "passed":bool(eligible and correct * 5 >= eligible * 4 and not false_decision and first_ok == 3),
              "arms":costs, "total_cost_usd":sum(r["cost_usd"] for r in costs)}
    report["next_step"] = ("Run the live tool and cache parity probes" if report["passed"] else
                           "Revise the compaction instructions and retest fresh forks" if report["attempt"] == 1 else
                           "Stop after cache-aware retention and report the failed gate")
    save(output / "report.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    cmds = parser.add_subparsers(dest="command", required=True)
    for name, args in [("prepare", ["manifest","output"]), ("run", ["output"]), ("score", ["output","grades"]), ("_deny",["path"])]:
        cmd = cmds.add_parser(name)
        for arg in args:
            cmd.add_argument(arg, type=Path)
    a = parser.parse_args()
    if a.command == "_deny":
        return deny(a.path)
    if a.command == "prepare":
        prepare(a.manifest, a.output)
    elif a.command == "run":
        run(a.output.resolve())
    else:
        report = score(a.output, a.grades)
        print(json.dumps(report, indent=2))
        return 0 if report["passed"] else 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, asyncio.TimeoutError) as err:
        sys.exit(str(err) or "Claude recall trial timed out")
