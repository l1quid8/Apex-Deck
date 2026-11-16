import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from uuid import uuid4

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/claude-recall-trial.py"
spec = importlib.util.spec_from_file_location("claude_recall_trial", SCRIPT)
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


# This subprocess exercises the actual stream-json runner without credentials
# or network access. It sends a tool request on the first-reply arm and reads
# the returned denial before writing the result.
FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, uuid
args = sys.argv[1:]
assert "--fork-session" in args
assert args[args.index("--permission-prompt-tool") + 1] == "stdio"
settings = json.loads(args[args.index("--settings") + 1])
assert settings["hooks"]["PreToolUse"][0]["matcher"] == "*"
prompt = json.loads(sys.stdin.readline())["message"]["content"]
parent = args[args.index("--resume") + 1]
sid = str(uuid.uuid4())
project = pathlib.Path(os.environ["SYNTH_PROJECT"])
assert (project / (parent + ".jsonl")).exists()
(project / (sid + ".jsonl")).write_text("checkpoint")
def emit(row):
    print(json.dumps(row), flush=True)
if prompt.startswith("/compact "):
    emit({"type":"system","subtype":"compact_boundary"})
if prompt.startswith("Ordinary"):
    req = {"subtype":"can_use_tool","tool_use_id":"one", "tool_name":"Write","input":{"file_path":"old-work"}}
    emit({"type":"control_request","request_id":"req","request":req})
    ans = json.loads(sys.stdin.readline())["response"]
    assert ans["request_id"] == "req" and ans["response"]["behavior"] == "deny"
    if os.environ.get("SYNTH_EXECUTED_TOOL"):
        emit({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"one","is_error":False}]}})
emit({"type":"result","session_id":sid,"is_error":False,"result":"synthetic answer",
      "usage":{"input_tokens":10},"total_cost_usd":0.01})
'''


class RecallTrialTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.exe = self.bin / "claude"
        self.exe.write_text(FAKE)
        self.exe.chmod(0o755)
        self.out = self.root / "trial"
        self.manifest = self.root / "manifest.json"
        self.threads = []
        for i in range(3):
            p = self.root / (str(uuid4()) + ".jsonl")
            prompt = "You are X (@x). The other models are: Y (@y).\n--- Conversation so far ---\n"
            prompt += "\n\n".join(f"[User]: decision {n}" for n in range(12))
            prompt += "\n--- Your reply ---\n"
            rows = [{"type":"user","message":{"content":prompt}}, {"type":"assistant","message":{
                "content":[{"type":"text","text":"done"}],"usage":{"input_tokens":10,"cache_read_input_tokens":100_000}}}]
            p.write_text("\n".join(json.dumps(row) for row in rows))
            self.threads.append({"room":f"room-{i}", "source":str(p), "cwd":str(self.root), "model":"synthetic",
                "first_reply":"Ordinary new question", "questions":[{"question":f"Which decision {n}?",
                "answer":str(n),"quote":f"decision {n}"} for n in range(5)]})
        self.environment = {"PATH":str(self.bin) + os.pathsep + os.environ["PATH"], "SYNTH_PROJECT":str(self.root)}

    def prep(self):
        trial.save(self.manifest, {"threads":self.threads})
        trial.prepare(self.manifest, self.out)

    def test_blind_trial_measures_four_distinct_forks_per_thread_and_enforces_all_gates(self):
        self.prep()
        with mock.patch.dict(os.environ, self.environment):
            trial.run(self.out)
        packet = trial.read(self.out / "blind/packet.json")
        grades = trial.read(self.out / "blind/grades.json")
        key = trial.read(self.out / "private/key.json")
        for k, (i, arm) in key.items():
            self.assertNotIn("session", packet[k])
            if arm == "first":
                self.assertEqual(packet[k]["blocked_tools"][0]["tool_input"], {"file_path":"old-work"})
                grades[k].update(answered_new_message=True, restarted_old_work=False)
            else:
                grades[k].update(grades=["right"] * 5, wrong_decision_as_fact=False)
        first = next(k for k,v in key.items() if v == [1,"first"])
        compact = next(k for k,v in key.items() if v == [1,"compacted"])
        control = next(k for k,v in key.items() if v == [1,"control"])
        def score():
            trial.save(self.root / "grades.json", grades)
            return trial.score(self.out, self.root / "grades.json")
        grades[compact]["grades"][:3] = ["partly right", "wrong", "doesn't know"]
        self.assertTrue(score()["passed"])  # exactly 12/15
        self.assertEqual(len(score()["arms"]), 12)
        self.assertAlmostEqual(score()["total_cost_usd"], .12)
        grades[control]["grades"][-1] = "wrong"
        self.assertFalse(score()["passed"])  # 11/14
        grades[compact]["grades"][:3] = ["right"]*3
        grades[compact]["wrong_decision_as_fact"] = True
        self.assertFalse(score()["passed"])
        grades[compact]["wrong_decision_as_fact"] = False
        grades[first]["restarted_old_work"] = True
        self.assertFalse(score()["passed"])
        trial.save(self.manifest, {"threads":self.threads, "retest_of":str(self.out),"compact_ask":"revised ask"})
        trial.prepare(self.manifest, self.root / "retest")
        self.assertEqual(trial.read(self.root / "retest/manifest.json")["attempt"], 2)

    def test_mutated_source_is_detected_even_when_provider_returns(self):
        self.prep()
        def mutate(t, parent, prompt, out):
            Path(t["source"]).write_text("changed")
        with self.assertRaisesRegex(ValueError, "Source or compaction checkpoint changed"):
            trial.run(self.out, mutate)

    def test_successful_tool_result_invalidates_trial(self):
        self.prep()
        with mock.patch.dict(os.environ, {**self.environment, "SYNTH_EXECUTED_TOOL":"1"}):
            with self.assertRaisesRegex(ValueError, "tool executed"):
                trial.run(self.out)

    def test_evidence_must_be_early_and_input_must_be_long_enough(self):
        self.threads[0]["questions"][0]["quote"] = "decision 9"
        with self.assertRaisesRegex(ValueError, "outside first half"):
            self.prep()
        self.threads[0]["questions"][0]["quote"] = "decision 0"
        p = Path(self.threads[0]["source"])
        p.write_text(p.read_text().replace("100000","64"))
        with self.assertRaisesRegex(ValueError, "only 74 prompt tokens"):
            self.prep()

    def test_deny_hook_records_proposal_and_returns_blocking_status(self):
        dest = self.root / "receipt"
        event = {"tool_name":"Edit","tool_use_id":"aa","tool_input":{"file_path":"fixture"}}
        with mock.patch("sys.stdin", io.StringIO(json.dumps(event))), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(trial.deny(dest), 2)
        self.assertEqual(json.loads(dest.read_text()), event)


if __name__ == "__main__":
    unittest.main()
