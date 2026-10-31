#!/usr/bin/env python3
"""Supervised wire/native proof. No screen text or typed values are written to disk.

Starts a persistent relay while STOPPED, checks refusals, then waits for the
Human's menu Start. Creates one unsaved TextEdit scratch document and types only
the fixed harmless fixture below. This is not a DS4 or Deck model-driven proof.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import select
import subprocess
import time

HELPER = Path.home() / "Library/Application Support/Apex Computer Spike/Apex Computer Spike.app/Contents/Helpers/SpikeMCP"
FIXTURE = "Apex computer live typing proof"


class Client:
    def __init__(self):
        self.proc = subprocess.Popen([str(HELPER)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.pending = bytearray()
        self.identifier = 0

    def request(self, method, params=None, timeout=12):
        self.identifier += 1
        message = {"jsonrpc": "2.0", "id": self.identifier, "method": method}
        if params is not None:
            message["params"] = params
        self.proc.stdin.write(json.dumps(message).encode() + b"\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + timeout
        while b"\n" not in self.pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.proc.stdout], [], [], remaining)[0]:
                raise RuntimeError("bounded_response_timeout")
            data = os.read(self.proc.stdout.fileno(), 65536)
            if not data:
                raise RuntimeError("relay_disconnected")
            self.pending.extend(data)
            if len(self.pending) > 8 * 1024 * 1024:
                raise RuntimeError("oversized_response")
        line, _, rest = self.pending.partition(b"\n")
        self.pending = bytearray(rest)
        response = json.loads(line)
        if response.get("id") != self.identifier or "error" in response:
            raise RuntimeError("unexpected_protocol_reply")
        return response["result"]

    def tool(self, name, arguments):
        return self.request("tools/call", {"name": name, "arguments": arguments})

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=8)
        if self.proc.stderr.read():
            raise RuntimeError("unexpected_stderr_content_not_logged")


def text(result):
    return "\n".join(item.get("text", "") for item in result.get("content", [])
                     if item.get("type") == "text")


def snapshot(result):
    if result.get("isError"):
        # Refusal codes are generic; do not print an unexpected result/body.
        code = text(result)
        if re.fullmatch(r"[a-zA-Z0-9_;= -]{1,160}", code):
            raise RuntimeError(code)
        raise RuntimeError("tool_refused_body_not_logged")
    match = re.search(r"(?m)^snapshot: ([0-9a-fA-F-]{36})$", text(result))
    if not match:
        raise RuntimeError("snapshot_missing")
    return match.group(1)


def refused(result, code):
    assert result.get("isError") is True, "expected_refusal"
    assert result.get("content") == [{"type": "text", "text": code}], "refusal_leaked_content"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="wait for Human Start, then type the fixture")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    evidence = {"test": "embedded-agent-desktop-relay-typing", "model_driven": False, "engine_pin": "5261b5287b5208e7c4bf3713df6f66faaaf2c4cc", "passed": False}
    client = Client()
    try:
        state = client.request("spike/status")
        evidence["permissions"] = {key: state[key] for key in
                                   ("accessibilityTrusted", "listenEventAccess", "tapHealthy")}
        assert state["stopped"], "must_start_stopped"
        client.request("initialize")
        tools = client.request("tools/list")["tools"]
        assert {t["name"] for t in tools} == {
            "request_app", "read_screen", "get_screenshot", "click", "type_text", "press_key"}
        for name in ("read_screen", "get_screenshot"):
            refused(client.tool(name, {}), "cancelled_or_stopped")
        refused(client.tool("request_app", {"app": "com.apple.TextEdit"}), "cancelled_or_stopped")
        evidence["stopped_read_and_control_refusals"] = True
        print("PASS: stopped read_screen/get_screenshot/control return only refusal codes", flush=True)
        if not args.live:
            evidence["passed"] = True
            return
        assert all(evidence["permissions"].values()), "native_permissions_not_ready"
        print("READY: choose Computer Spike > Start new isolated run, then leave mouse/keyboard idle", flush=True)
        deadline = time.monotonic() + 600
        while client.request("spike/status")["stopped"]:
            if time.monotonic() >= deadline:
                raise RuntimeError("human_start_pending")
            time.sleep(0.25)
        # Allow the Human's menu mouse-up to finish before taking an observation.
        time.sleep(1)
        started = time.monotonic()
        opened = client.tool("request_app", {"app": "com.apple.TextEdit"})
        current = snapshot(opened)
        focused = re.search(r"(?m)^focused_ref: (@e[0-9]+)$", text(opened))
        evidence["request_app_reached_editor"] = bool(focused and re.search(
            rf"(?m)^ *element: [0-9]+ {re.escape(focused.group(1))} textfield(?: |$)", text(opened)))
        assert evidence["request_app_reached_editor"], "request_app_has_no_editor"
        window_pattern = r"(?m)^window: w-[0-9]+$"
        old_window = re.search(window_pattern, text(opened))
        assert old_window, "initial_window_missing"
        activity = client.request("spike/status")["eventCounts"]
        # Always make a scratch document; never type into a preexisting document.
        created = client.tool("press_key", {"snapshot": current, "key": "Cmd-N"})
        current = snapshot(created)
        document_deadline = time.monotonic() + 3
        while True:
            new_window = re.search(window_pattern, text(created))
            if new_window and new_window.group() != old_window.group() and re.search(r"(?m)^focused_ref: @e[0-9]+$", text(created)):
                break
            assert time.monotonic() < document_deadline, "new_scratch_document_not_confirmed"
            time.sleep(0.05)
            created = client.tool("read_screen", {})
            current = snapshot(created)
        after_activity = client.request("spike/status")["eventCounts"]
        for category in ("otherKeyboard", "otherMouse"):
            assert after_activity.get(category, 0) == activity.get(category, 0), "human_activity_during_setup"
        typed = client.tool("type_text", {"snapshot": current, "text": FIXTURE})
        snapshot(typed)
        assert "last_action: delivery=delivered_verified verification_scope=element_value application_commit=not_verified\n" in text(typed), "native_element_typing_not_verified"
        assert FIXTURE in text(typed), "typed_value_missing"
        reread = client.tool("read_screen", {})
        snapshot(reread)
        assert FIXTURE in text(reread), "reread_value_missing"
        refused(client.tool("press_key", {"snapshot": "invalid", "key": "Return"}), "fresh_snapshot_required")
        evidence.update({"typing_verified": True, "reread_verified": True,
                         "active_refusal_has_no_screen": True,
                         "delivery": "delivered_verified", "verification_scope": "element_value",
                         "application_commit": "not_verified", "fixture_characters": len(FIXTURE),
                         "fixture_sha256": hashlib.sha256(FIXTURE.encode()).hexdigest(),
                         "active_seconds": round(time.monotonic() - started, 3)})
        print("PASS: request_app reached editor; scratch-document typing and reread verified; refusal has no screen", flush=True)
    finally:
        client.close()  # Disconnect independently latches Stop inside the app.
        try:
            if args.live and evidence.get("typing_verified"):
                again = Client()
                try:
                    assert again.request("spike/status")["stopped"], "disconnect_did_not_stop"
                    refused(again.tool("read_screen", {}), "cancelled_or_stopped")
                    refused(again.tool("get_screenshot", {}), "cancelled_or_stopped")
                    evidence["disconnect_stop_blocks_reads"] = True
                    evidence["passed"] = True
                finally:
                    again.close()
        finally:
            if args.report:
                args.report.write_text(json.dumps(evidence, indent=2) + "\n")
            print(json.dumps(evidence, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
