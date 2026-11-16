import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class CacheMeasurementTest(unittest.TestCase):
    def test_each_deck_prompt_starts_a_turn_in_the_same_session(self):
        script = Path(__file__).resolve().parents[1] / "scripts/measure-claude-cache.py"
        events = [
            {"type": "user", "entrypoint": "sdk-cli", "isMeta": True, "message": {"content": "Initial provider metadata"}},
            {"type": "user", "message": {"content": [{"type":"text","text":"You are Null in sample-room\n\n--- Conversation so far ---\n[User]: Hello\n\n--- Your reply ---\n"}]}},
            {"type": "assistant", "message": {"id": "a", "usage": {"input_tokens": 10}}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "content": "result"}]}},
            {"type": "assistant", "message": {"id": "b", "usage": {"input_tokens": 2}}},
            {"type": "user", "message": {"content": "<task-notification>Helper finished</task-notification>"}},
            {"type": "assistant", "message": {"id":"helper", "usage":{"input_tokens":1}}},
            {"type": "user", "message": {"content": "--- New in the conversation since your last reply ---\n[User]: Continue\n\n--- Your reply ---\n"}},
            {"type": "assistant", "message": {"id": "c", "usage": {"input_tokens": 3}}},
        ]
        with tempfile.TemporaryDirectory() as folder:
            log = Path(folder) / "fixture.jsonl"
            log.write_text("\n".join(json.dumps(event) for event in events))
            result = subprocess.run(
                [sys.executable, str(script), "--project", folder, "--deck-match", "sample-room"],
                capture_output=True, text=True, check=True,
            )
        rows = list(csv.DictReader(io.StringIO(result.stdout)))
        self.assertEqual([(r["kind"], r["turn"], r["calls"], r["input"]) for r in rows],
                         [("deck", "1", "3", "13"), ("deck", "2", "1", "3")])


if __name__ == "__main__":
    unittest.main()
