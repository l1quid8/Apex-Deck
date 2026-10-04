# Codex MCP approvals through a hook: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Written 2026-10-03 by Jigga for Null, to build on `feat/mcp-tool-approvals`.

**Goal:** Codex turns get the same catch-all MCP approval Claude has, without listing every MCP tool before each turn.

**Architecture:** When Deck starts `codex app-server`, it passes a `PreToolUse` hook (`matcher="^mcp__"`) with `-c`. The hook runs Deck's own executable with `--codex-hook`. That helper sends the call to the running turn over a private Unix socket and prints Deck's answer. Reads go through, and risky tools get the existing approval card. Before each turn Deck checks with `hooks/list` that Codex will run the hook, and trusts it through `config/batchWrite` when it is new or the app has moved. If any of that fails, the turn uses today's inventory policy (`mcp.rs`), which is slower but safe.

**Tech Stack:** Rust (tokio, serde_json), Tauri 2, codex-cli ≥ 0.160.0 app-server JSON-RPC.

**Spec:** No separate spec. The design is the "Design" section below. Background: the 2026-10-03 chat (Jigga's hook tests in `/tmp/deck-hook-probe`) and `2026-10-03-mcp-safety.md`.

## Before you start

- Commit the work already in the tree first, in separate commits (MCP approval cards, `!` tool servers, docs). This plan changes `codex_server.rs` and `mcp.rs`, which are still uncommitted, and the hook work should be reviewable on its own.
- Run the Rust tests serially: `cargo test --workspace -- --test-threads=1`. One storage test has failed in parallel runs before.

## Design

**Why a hook.** Claude takes one rule, `{"permissions":{"ask":["mcp__*"]}}`, that covers every MCP tool, even ones Deck has never seen. Codex has no wildcard for MCP servers, so today Deck asks Codex for every server and tool before each turn (`mcpServerStatus/list`) and sets "prompt" on each one. That takes 3.4–7.2 s on the human's machine, mostly because five servers fail to connect. It also misses servers that load after the thread starts (`openai-api-key-local-confirmation`).

**What Jigga tested (codex-cli 0.160.0, throwaway `CODEX_HOME`s, fake MCP server):**

- A `PreToolUse` hook with `matcher="^mcp__"` caught every MCP call, including a server it didn't name, and a deny stopped the call before the server saw it. It also fired on a server set to auto-approve.
- The hook input on stdin includes `session_id`, `turn_id`, `hook_event_name`, `tool_name` (`mcp__deckprobe__place_order_probe`), `tool_input` (`{"qty":1}`) and `tool_use_id`.
- A deny is `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` on stdout, exit 0.
- **Codex runs the tool anyway if the hook crashes or times out.** The helper must answer deny on every error, and before Codex's 600 s cap.
- A hook passed with `-c` is listed by `hooks/list` as `source: "sessionFlags"`, key `/<session-flags>/config.toml:pre_tool_use:0:0`, `trustStatus: "untrusted"`. Codex silently skips untrusted hooks.
- Trust passed with `-c hooks.state…` is ignored. Trust written with `config/batchWrite` (keyPath `hooks.state."<key>".trusted_hash`, value = the listed `currentHash`) takes effect at once, in the same process and in later ones. It adds two lines to `~/.codex/config.toml`. The hash changes when the command or timeout changes.
- `--dangerously-bypass-hook-trust` also runs untrusted plugin hooks (it ran `watch@claude-cowork`'s SessionStart hook). Never use it.

**Not tested yet (Task 1):** whether Codex passes the environment to the hook, whether it runs the command through a shell (paths with spaces), a real app-server turn with the hook, the order of the hook and Codex's own `mcpServer/elicitation/request`, plugin and ChatGPT app tools, and how much faster turns actually start. Codex may still wait for the broken servers itself before the first model request.

**Two gates, one card.** Codex may also send its own `mcpServer/elicitation/request` for the same call, before or after the hook. Deck keeps answering those as today. One answer from the person covers exactly one identical call (same server, tool and arguments) at the *other* gate, and never a second call at the same gate (`Gates` in Task 4).

## Global Constraints

- Hook mode needs codex-cli ≥ 0.160.0 and a Unix platform (macOS, Linux). Otherwise Deck uses the inventory policy.
- Hook flag: `hooks.PreToolUse=[{matcher="^mcp__", hooks=[{type="command", command="<command>", timeout=600}]}]`.
- Hook command: `'<path to Deck's executable>' --codex-hook`, single-quoted for `sh`.
- Session key: `/<session-flags>/config.toml:pre_tool_use:0:0`.
- Socket path env var: `APEX_DECK_CODEX_HOOK`.
- Codex hook timeout: 600 s. Helper deadline: 570 s.
- Deck trusts a hook only when every listed field matches what Deck passed: key, `source: "sessionFlags"`, `eventName: "preToolUse"`, `handlerType: "command"`, matcher, command, `timeoutSec: 600`, `enabled: true`.
- Deck never reads Codex config files. The only thing it writes is `hooks.state."<session key>".trusted_hash`, through `config/batchWrite`.
- Never use `--dangerously-bypass-hook-trust`.
- Every helper failure prints a deny. Allowing prints nothing.
- The risky word list stays `mcp::RISKY`, unchanged.
- Exact activity lines: `Turning on Apex Deck's approval hook in Codex`, `Checking MCP tool approval policies` (inventory only), `Starting Codex`, `Waiting for approval: <title>`.
- Exact deny reasons: `The person reading the chat rejected this tool call.` / `Apex Deck couldn't check this tool call (<why>), so it was blocked.` / `Apex Deck's approval helper failed, so this tool call was blocked.` / `Apex Deck couldn't read this tool call, so it was blocked.`
- Commits only once the human has OK'd them, one per task.

## Review Focus

1. **The app lives at a path with spaces or a quote** (`/Applications/Apex Deck.app/…`). The hook must still run the helper. Pinned by Task 3's `the_hook_command_survives_spaces_and_quotes_in_the_app_path` and Task 4's end-to-end tests, which put the helper under `Apex Deck/`.
2. **A card is left unanswered until the helper gives up, or Codex kills the helper.** The call must be blocked, the card taken down, and the quiet clock running again. Pinned by Task 2's tests and Task 4's `a_helper_that_hangs_up_withdraws_the_question_and_blocks_the_call`.
3. **The same risky call twice in one turn, or Codex asking at both gates.** One card per call, and one approval never lets two calls through. Pinned by Task 4's `one_answer_covers_one_call_at_the_other_gate_only` and `codex_asks_once_per_risky_call_when_both_the_hook_and_codex_ask`.
4. **Something other than Deck's hook sits at the session key, or the app has moved** (status `modified`). Deck must never trust a command it didn't pass, and must re-trust its own. Pinned by Task 4's `only_decks_own_hook_is_trusted`.
5. **Codex without hooks, or the helper missing.** The turn must fall back to the inventory policy and never run unprotected. Pinned by Task 4's `codex_without_the_hook_falls_back_to_the_inventory_policy`.

---

### Task 1: Spike against the real Codex (no repo changes)

This checks what Jigga's tests didn't. It runs real model turns, uses a little plan quota, and trusts the spike's hook in the human's real `~/.codex/config.toml`. Deck manages those same two lines later and will overwrite the hash. If your sandbox blocks network access or writing `~/.codex`, ask the human.

**Files:**
- Create: `/tmp/deck-hook-spike/spike.py` (outside the repo)
- Uses: `/tmp/deck-hook-probe/server.py`, Jigga's fake MCP server. It has `probe_echo` and `place_order_probe`, does nothing, and logs each call to `/tmp/deck-hook-probe/server-calls.log`.

- [x] **Step 1: Write the driver**

```python
#!/usr/bin/env python3
"""Task 1 spike: Deck's hook in a real `codex app-server` turn.

Trusting the hook writes two lines to ~/.codex/config.toml, the same two
lines Deck will manage. Nothing else in the user's config changes."""
import argparse, json, os, subprocess, time

parser = argparse.ArgumentParser()
parser.add_argument("--allow", action="store_true", help="the helper prints permissionDecision allow for reads")
parser.add_argument("--inventory", action="store_true", help="list every MCP tool before the thread, as Deck does today")
parser.add_argument("--prompt", default="Use only the deckprobe MCP server. Call probe_echo with text 'hi', then call place_order_probe with qty 1. Call no other tools. Report each tool's result or error verbatim.")
args = parser.parse_args()

SPIKE = "/tmp/deck hook spike"  # a space, like "/Applications/Apex Deck.app"
HELPER, LOG = f"{SPIKE}/helper.sh", f"{SPIKE}/helper.log"
SERVER, WORK = "/tmp/deck-hook-probe/server.py", "/tmp/deck-hook-probe"
os.makedirs(SPIKE, exist_ok=True)
allow = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}' if args.allow else ""
with open(HELPER, "w") as f:
    f.write(f"""#!/bin/sh
input=$(cat)
now=$(python3 -c 'import time; print(time.time())')
printf '%s arg1=%s env=%s input=%s\\n' "$now" "$1" "$APEX_DECK_CODEX_HOOK" "$input" >> '{LOG}'
case "$input" in
  *place_order_probe*) echo '{{"hookSpecificOutput":{{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"spike: blocked"}}}}' ;;
  *) printf '%s' '{allow}' ;;
esac
""")
os.chmod(HELPER, 0o755)

COMMAND = f"'{HELPER}' --codex-hook"
HOOK = 'hooks.PreToolUse=[{matcher="^mcp__", hooks=[{type="command", command=' + json.dumps(COMMAND) + ', timeout=600}]}]'
proc = subprocess.Popen(
    ["codex", "app-server", "-c", HOOK,
     "-c", 'mcp_servers.deckprobe.command="python3"',
     "-c", "mcp_servers.deckprobe.args=[" + json.dumps(SERVER) + "]"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=WORK,
    env=dict(os.environ, APEX_DECK_CODEX_HOOK="spike-socket-path"))
t0 = time.time()
def log(*parts): print(f"{time.time() - t0:7.2f}s", *parts, flush=True)
def send(message): proc.stdin.write(json.dumps(message) + "\n"); proc.stdin.flush()
def wait(id):
    while True:
        message = json.loads(proc.stdout.readline())
        if message.get("id") == id and "method" not in message: return message

log("t0 epoch", t0)
send({"id": 0, "method": "initialize", "params": {"clientInfo": {"name": "spike", "version": "0"}, "capabilities": {"experimentalApi": True}}}); wait(0)
send({"method": "initialized", "params": {}})
send({"id": 120, "method": "hooks/list", "params": {"cwds": [WORK]}})
ours = [h for e in wait(120)["result"]["data"] for h in e["hooks"] if h["source"] == "sessionFlags"]
log("hook as listed:", json.dumps(ours))
if ours and ours[0]["trustStatus"] != "trusted":
    send({"id": 121, "method": "config/batchWrite", "params": {"edits": [{"keyPath": f'hooks.state."{ours[0]["key"]}".trusted_hash', "value": ours[0]["currentHash"], "mergeStrategy": "replace"}]}})
    log("trust write:", json.dumps(wait(121))[:300])
if args.inventory:
    send({"id": 10, "method": "mcpServerStatus/list", "params": {"detail": "toolsAndAuthOnly", "limit": 100}})
    wait(10); log("inventory done")
send({"id": 1, "method": "thread/start", "params": {"approvalPolicy": {"granular": {"mcp_elicitations": True, "rules": False, "sandbox_approval": False}}, "sandbox": "read-only", "ephemeral": True, "cwd": WORK, "config": {"approvals_reviewer": "user"}}})
thread = wait(1)["result"]["thread"]["id"]; log("thread started")
send({"id": 2, "method": "turn/start", "params": {"threadId": thread, "input": [{"type": "text", "text": args.prompt}]}})
first = None
for line in proc.stdout:
    message = json.loads(line)
    method = message.get("method", "")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    if method and "id" in message:
        log("REQUEST", method, json.dumps(params)[:400])
        if method == "mcpServer/elicitation/request":
            send({"id": message["id"], "result": {"action": "accept", "content": {}}})
        else:
            send({"id": message["id"], "error": {"code": -32601, "message": "spike"}})
        continue
    if method == "item/agentMessage/delta" and first is None:
        first = time.time() - t0; log("first reply text")
    item = params.get("item", {})
    if method in ("item/started", "item/completed") and item.get("type") == "mcpToolCall":
        log(method, json.dumps(item)[:400])
    if method.startswith("hook"):
        log(method, json.dumps(params)[:400])
    if method == "turn/completed":
        log("turn completed", json.dumps(params)[:400]); break
proc.terminate()
print(f"first reply text at {first:.2f}s" if first is not None else "no reply text")
```

- [x] **Step 2: Run the main check**

```bash
mkdir -p /tmp/deck-hook-spike && : > "/tmp/deck hook spike/helper.log" 2>/dev/null; : > /tmp/deck-hook-probe/server-calls.log
python3 /tmp/deck-hook-spike/spike.py
cat "/tmp/deck hook spike/helper.log"; cat /tmp/deck-hook-probe/server-calls.log
```

Gates. **If G1, G2 or G3 fails, stop and report. Don't build around it.**
- **G1 (environment):** each helper log line shows `env=spike-socket-path`.
- **G2 (shell and spaces):** the helper ran at all from `/tmp/deck hook spike/`, and its lines show `arg1=--codex-hook`.
- **G3 (block):** `server-calls.log` has a `probe_echo` call and no `place_order_probe` call. The model reports the order call as blocked.
- **G4 (order):** record whether Codex sent `mcpServer/elicitation/request` for each tool, and whether that came before or after the helper ran. Compare the helper's epoch times with `t0 epoch` plus the driver's offsets. Any answer is fine; `Gates` handles both orders.

- [x] **Step 3: Check what an explicit allow does**

Run: `python3 /tmp/deck-hook-spike/spike.py --allow`
- **G5:** record whether Codex still sent an elicitation for `probe_echo` after the helper printed `permissionDecision: allow`. Deck's helper prints nothing on allow either way. This is for the docs.

- [x] **Step 4: Check plugin and ChatGPT app tools**

List the tools with `mcpServerStatus/list` (Jigga's `/tmp/deck-hook-probe/inv.py` shows the request). Pick one read-only tool from a server that has a `pluginId`, and one from `codex_apps`. Never pick a tool whose name contains any word in `mcp::RISKY`. Then run:

`python3 /tmp/deck-hook-spike/spike.py --prompt "Call the <server> tool <tool> with <harmless arguments>, then the codex_apps tool <tool> with <harmless arguments>. Call no other tools."`

- **G6:** record the `tool_name` the helper saw for each. If either call never reached the helper, don't stop. Record it, and Jigga will add the gap to the docs.

- [x] **Step 5: Measure the speed-up**

Run each of these three times:
- `python3 /tmp/deck-hook-spike/spike.py --prompt "Reply with just: ok"`
- `python3 /tmp/deck-hook-spike/spike.py --inventory --prompt "Reply with just: ok"`

Write down the six "first reply text at" times.
- **G7:** if the hook runs (no `--inventory`) aren't at least 2 s faster by median, stop and report the numbers. Codex may be waiting for the broken servers itself. The hook still closes the late-loading-server gap, but the human should decide whether that alone is worth the build.

- [x] **Step 6: Record the findings**

Add a `## Spike findings` section at the end of this file: G1–G7 results, the six timings, and anything that surprised you. If every gate passed, go on to Task 2. Otherwise stop and post the findings in the chat.

---

### Task 2: Take down an approval card when its wait is abandoned

The hook's wait can end without an answer: the helper gives up at 570 s, or Codex stops it. Dropping `RoomApprover::decide` today leaves the card on screen and the desk entry behind, and dropping `Timed::decide` leaves `asking` set, so the quiet clock never runs again.

**Files:**
- Modify: `crates/apex-core/src/approval.rs` (add `ApprovalDesk::withdraw`, plus a test)
- Modify: `crates/apex-core/src/room.rs:120-140` (`RoomApprover::decide`, plus a new test module at the end)
- Modify: `crates/apex-adapters/src/cli.rs:370-385` (`Timed::decide`, plus a test)

**Interfaces:**
- Produces: `ApprovalDesk::withdraw(&self, request: &str) -> bool`. After this task, dropping any `decide` future is safe: the card is withdrawn, the room sees `ApprovalResolved { approved: false }`, and the quiet clock resumes.

- [x] **Step 1: Write the failing tests**

In `crates/apex-core/src/approval.rs`, inside `mod tests`:

```rust
    #[test]
    fn a_withdrawn_proposal_cannot_be_answered() {
        let desk = ApprovalDesk::default();
        let (request, _answer) = desk.open();
        assert!(desk.withdraw(&request));
        assert!(!desk.withdraw(&request), "already gone");
        assert!(!desk.resolve(&request, Decision::Approve));
        assert_eq!(desk.waiting(), 0);
    }
```

At the end of `crates/apex-core/src/room.rs`:

```rust
#[cfg(test)]
mod approver_tests {
    use super::*;
    use crate::approval::ActionKind;
    use futures::FutureExt;
    use std::sync::Mutex;

    fn action() -> ProposedAction {
        ProposedAction { kind: ActionKind::Tool, title: "probe: place_order".into(), detail: "{}".into() }
    }

    #[test]
    fn a_card_whose_wait_is_abandoned_is_taken_down() {
        let desk = ApprovalDesk::default();
        let id = ParticipantId::new("null");
        let events = Mutex::new(Vec::new());
        let sink = |event: RoomEvent| events.lock().unwrap().push(event);
        let approver = RoomApprover { desk: &desk, id: &id, on_event: &sink };
        let mut waiting = approver.decide(action());
        assert!(waiting.as_mut().now_or_never().is_none(), "nobody has answered");
        assert_eq!(desk.waiting(), 1);
        drop(waiting);
        assert_eq!(desk.waiting(), 0, "the card is gone");
        let events = events.into_inner().unwrap();
        assert!(matches!(events.as_slice(), [RoomEvent::ApprovalRequested { .. }, RoomEvent::ApprovalResolved { approved: false, .. }]), "{events:?}");
    }

    #[test]
    fn an_answered_card_is_settled_once() {
        let desk = ApprovalDesk::default();
        let id = ParticipantId::new("null");
        let events = Mutex::new(Vec::new());
        let sink = |event: RoomEvent| events.lock().unwrap().push(event);
        let approver = RoomApprover { desk: &desk, id: &id, on_event: &sink };
        let mut waiting = approver.decide(action());
        assert!(waiting.as_mut().now_or_never().is_none());
        assert!(desk.resolve("ask-1", Decision::Approve));
        assert_eq!(futures::executor::block_on(waiting), Decision::Approve);
        let events = events.into_inner().unwrap();
        assert!(matches!(events.as_slice(), [RoomEvent::ApprovalRequested { .. }, RoomEvent::ApprovalResolved { approved: true, .. }]), "{events:?}");
    }
}
```

In `crates/apex-adapters/src/cli.rs`, inside `mod tests`:

```rust
    #[test]
    fn an_abandoned_question_restarts_the_quiet_clock() {
        use super::{AtomicBool, Duration, Instant, Mutex, Ordering, Timed};
        use apex_core::{ActionKind, Approver, Decision, ProposedAction};
        use futures::FutureExt;
        struct Never;
        #[async_trait::async_trait]
        impl Approver for Never {
            async fn decide(&self, _: ProposedAction) -> Decision { std::future::pending().await }
        }
        let last_heard = Mutex::new(Instant::now() - Duration::from_secs(60));
        let asking = AtomicBool::new(false);
        let timed = Timed { inner: &Never, last_heard: &last_heard, asking: &asking };
        let mut waiting = timed.decide(ProposedAction { kind: ActionKind::Tool, title: "probe: place_order".into(), detail: "{}".into() });
        assert!(waiting.as_mut().now_or_never().is_none());
        assert!(asking.load(Ordering::SeqCst));
        drop(waiting);
        assert!(!asking.load(Ordering::SeqCst), "the quiet clock runs again");
        assert!(last_heard.lock().unwrap().elapsed() < Duration::from_secs(5));
    }
```

- [x] **Step 2: Run them to see them fail**

Run: `cargo test -p apex-core withdraw -- --test-threads=1`, then `cargo test -p apex-core approver_tests -- --test-threads=1`, then `cargo test -p apex-adapters an_abandoned_question -- --test-threads=1`
Expected: the first fails to compile (no `withdraw`). The others fail on `desk.waiting()` being 1 and on `asking` still being true.

- [x] **Step 3: Implement**

In `crates/apex-core/src/approval.rs`, in `impl ApprovalDesk`, after `resolve`:

```rust
    /// Take a proposal down without an answer, as when the tool that asked
    /// stopped waiting. Returns false if it was already answered.
    pub fn withdraw(&self, request: &str) -> bool {
        self.waiting.lock().unwrap().remove(request).is_some()
    }
```

In `crates/apex-core/src/room.rs`, replace `impl Approver for RoomApprover<'_>` with:

```rust
#[async_trait]
impl Approver for RoomApprover<'_> {
    async fn decide(&self, action: ProposedAction) -> Decision {
        let (request, answer) = self.desk.open_for(self.id.clone());
        (self.on_event)(RoomEvent::ApprovalRequested { id: self.id.clone(), request: request.clone(), action });
        let mut card = Card { approver: self, request: Some(request) };
        // No answer at all (the chat was closed) counts as a refusal.
        let decision = answer.await.unwrap_or(Decision::Reject);
        card.settle(decision == Decision::Approve);
        decision
    }
}

/// A proposal on screen. If the wait for it is abandoned, as when the tool
/// that asked stops waiting, it is taken down and shown as refused.
struct Card<'a, 'b> {
    approver: &'a RoomApprover<'b>,
    request: Option<String>,
}

impl Card<'_, '_> {
    fn settle(&mut self, approved: bool) {
        if let Some(request) = self.request.take() {
            (self.approver.on_event)(RoomEvent::ApprovalResolved { id: self.approver.id.clone(), request, approved });
        }
    }
}

impl Drop for Card<'_, '_> {
    fn drop(&mut self) {
        if let Some(request) = &self.request {
            self.approver.desk.withdraw(request);
        }
        self.settle(false);
    }
}
```

In `crates/apex-adapters/src/cli.rs`, replace `impl Approver for Timed<'_>` with:

```rust
#[async_trait]
impl Approver for Timed<'_> {
    async fn decide(&self, action: ProposedAction) -> Decision {
        /// Restarts the quiet clock however the wait ends, including when
        /// it is abandoned.
        struct Asking<'a> {
            asking: &'a AtomicBool,
            last_heard: &'a Mutex<Instant>,
        }
        impl Drop for Asking<'_> {
            fn drop(&mut self) {
                *self.last_heard.lock().unwrap() = Instant::now();
                self.asking.store(false, Ordering::SeqCst);
            }
        }
        self.asking.store(true, Ordering::SeqCst);
        let _asking = Asking { asking: self.asking, last_heard: self.last_heard };
        self.inner.decide(action).await
    }
}
```

- [x] **Step 4: Run the tests to see them pass**

Run: `cargo test --workspace -- --test-threads=1`
Expected: all pass, with no warnings.

- [x] **Step 5: Commit (once the human has OK'd commits)**

```bash
git add crates/apex-core/src/approval.rs crates/apex-core/src/room.rs crates/apex-adapters/src/cli.rs
git commit -m "fix: take down an approval card when its wait is abandoned"
```

---

### Task 3: The hook helper (`apex-deck --codex-hook`)

The process Codex runs before each MCP call. It reads the hook input, asks the turn over the socket named in `APEX_DECK_CODEX_HOOK`, and prints Deck's answer. Any failure prints a deny.

**Files:**
- Create: `crates/apex-adapters/src/codex_hook.rs`
- Create: `crates/apex-adapters/src/bin/apex-deck-codex-hook.rs` (the same helper as a separate binary, so the adapter tests can run it)
- Modify: `crates/apex-adapters/src/lib.rs` (add `mod codex_hook;` and the exports)
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Produces (public, from `apex_adapters`): `CODEX_HOOK_ARG: &str = "--codex-hook"`, `codex_hook_main() -> i32`, `codex_hook_command(helper: &Path) -> String`.
- Produces (crate): `codex_hook::{SOCKET_ENV, HOOK_TIMEOUT_SECS, Verdict}`. `Verdict` is `enum Verdict { Allow, Deny(String) }`, deriving `Debug, PartialEq`.
- Wire format, helper to Deck: the hook input JSON object, compact, on one line. Deck to helper: `{"decision":"allow"}` or `{"decision":"deny","reason":"…"}`, on one line.

- [x] **Step 1: Write the failing tests**

Create `crates/apex-adapters/src/codex_hook.rs` with only the tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hook_command_survives_spaces_and_quotes_in_the_app_path() {
        let command = hook_command(Path::new("/Applications/Apex Deck.app/Contents/MacOS/it's"));
        assert_eq!(command, r#"'/Applications/Apex Deck.app/Contents/MacOS/it'\''s' --codex-hook"#);
    }

    const CALL: &[u8] = br#"{"session_id":"t","hook_event_name":"PreToolUse","tool_name":"mcp__probe__place_order","tool_input":{"quantity":"0.001"}}"#;

    /// A stand-in for the turn: takes one call, keeps the line it was sent,
    /// and answers `answer`, or nothing.
    #[cfg(unix)]
    fn deck(tag: &str, answer: Option<&'static str>) -> (PathBuf, std::thread::JoinHandle<String>) {
        use std::io::{BufRead, BufReader, Write};
        let dir = std::env::temp_dir().join(format!("apex-hook-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("s");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&stream).read_line(&mut line).unwrap();
            match answer {
                Some(answer) => stream.write_all(format!("{answer}\n").as_bytes()).unwrap(),
                None => std::thread::sleep(Duration::from_millis(500)),
            }
            line
        });
        (socket, thread)
    }

    fn blocked(printed: &str) -> bool {
        serde_json::from_str::<Value>(printed).map_or(false, |out| out["hookSpecificOutput"]["permissionDecision"] == "deny")
    }

    #[cfg(unix)]
    #[test]
    fn deck_allowing_prints_nothing_and_deck_denying_blocks_with_its_reason() {
        let (socket, deck_side) = deck("allow", Some(r#"{"decision":"allow"}"#));
        assert_eq!(respond(CALL, Some(&socket), Duration::from_secs(5)), "");
        let sent: Value = serde_json::from_str(&deck_side.join().unwrap()).unwrap();
        assert_eq!(sent["tool_name"], "mcp__probe__place_order");
        assert_eq!(sent["tool_input"]["quantity"], "0.001");

        let (socket, _) = deck("deny", Some(r#"{"decision":"deny","reason":"no thanks"}"#));
        let printed: Value = serde_json::from_str(&respond(CALL, Some(&socket), Duration::from_secs(5))).unwrap();
        assert_eq!(printed["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(printed["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(printed["hookSpecificOutput"]["permissionDecisionReason"], "no thanks");
    }

    #[cfg(unix)]
    #[test]
    fn every_failure_blocks_the_call() {
        assert!(blocked(&respond(CALL, None, Duration::from_secs(1))), "not started by Deck");
        assert!(blocked(&respond(CALL, Some(Path::new("/no/such/apex/socket")), Duration::from_secs(1))), "Deck has gone");
        assert!(blocked(&respond(&b"not json"[..], None, Duration::from_secs(1))), "unreadable input");
        let (socket, _) = deck("silent", None);
        assert!(blocked(&respond(CALL, Some(&socket), Duration::from_millis(100))), "no answer before the deadline");
        let (socket, _) = deck("odd", Some(r#"{"decision":"maybe"}"#));
        assert!(blocked(&respond(CALL, Some(&socket), Duration::from_secs(1))), "an answer Deck never gives");
    }
}
```

In `crates/apex-adapters/src/lib.rs`, after `mod codex_server;`, add `mod codex_hook;`.

- [x] **Step 2: Run them to see them fail**

Run: `cargo test -p apex-adapters codex_hook -- --test-threads=1`
Expected: compile errors: `hook_command`, `respond`, `Path`, `PathBuf`, `Duration`, `Value` not found.

- [x] **Step 3: Implement**

At the top of `crates/apex-adapters/src/codex_hook.rs`, above the tests:

```rust
//! Apex Deck's catch-all approval for Codex MCP calls.
//!
//! Codex has no wildcard approval rule for MCP servers. So when Deck starts
//! Codex it adds a `PreToolUse` hook that matches every MCP tool
//! (`^mcp__`) and runs Deck's own executable with `--codex-hook`. That
//! helper hands the call to the running turn over a private socket and
//! prints the answer: reads go through, risky tools get an approval card.
//!
//! Codex runs the tool anyway if a hook fails or runs out of time, so the
//! helper answers "deny" on every error and before Codex's time limit.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

/// The argument that makes Deck's executable act as the hook helper.
pub const HOOK_ARG: &str = "--codex-hook";
/// Where the helper finds the turn's socket.
pub(crate) const SOCKET_ENV: &str = "APEX_DECK_CODEX_HOOK";
/// Codex waits no longer than this for a hook.
pub(crate) const HOOK_TIMEOUT_SECS: u64 = 600;
/// The helper gives up first, so that its "deny" is what Codex sees.
const HELPER_DEADLINE: Duration = Duration::from_secs(HOOK_TIMEOUT_SECS - 30);

/// The command Codex runs before each MCP call. Codex runs it through a
/// shell, so the path is quoted for one.
pub fn hook_command(helper: &Path) -> String {
    format!("'{}' {HOOK_ARG}", helper.to_string_lossy().replace('\'', r"'\''"))
}

/// What the helper tells Codex.
#[derive(Debug, PartialEq)]
pub(crate) enum Verdict {
    Allow,
    Deny(String),
}

/// The helper process: read Codex's hook input, ask the turn that started
/// Codex, print the answer. Every failure blocks the call.
pub fn codex_hook_main() -> i32 {
    use std::io::Write;
    let socket = std::env::var_os(SOCKET_ENV).map(PathBuf::from);
    let printed = respond(std::io::stdin().lock(), socket.as_deref(), HELPER_DEADLINE);
    let mut out = std::io::stdout();
    let _ = out.write_all(printed.as_bytes());
    let _ = out.flush();
    0
}

/// What to print for one hook call. Allowing prints nothing, which leaves
/// the call to Codex's own checks; anything else blocks it.
pub(crate) fn respond(input: impl Read, socket: Option<&Path>, deadline: Duration) -> String {
    let asked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ask_deck(input, socket, deadline)));
    let verdict = match asked {
        Ok(Ok(verdict)) => verdict,
        Ok(Err(why)) => Verdict::Deny(format!("Apex Deck couldn't check this tool call ({why}), so it was blocked.")),
        Err(_) => Verdict::Deny("Apex Deck's approval helper failed, so this tool call was blocked.".into()),
    };
    match verdict {
        Verdict::Allow => String::new(),
        Verdict::Deny(reason) => json!({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason
        }}).to_string(),
    }
}

#[cfg(unix)]
fn ask_deck(input: impl Read, socket: Option<&Path>, deadline: Duration) -> Result<Verdict, String> {
    use std::io::{BufRead, BufReader, Write};
    // One JSON value, without waiting for the end of the input.
    let call = serde_json::Deserializer::from_reader(input).into_iter::<Value>().next()
        .and_then(Result::ok).filter(Value::is_object).ok_or("unreadable hook input")?;
    let socket = socket.ok_or("not started by Apex Deck")?;
    let mut stream = std::os::unix::net::UnixStream::connect(socket).map_err(|e| format!("Deck is not listening: {e}"))?;
    stream.set_read_timeout(Some(deadline)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(deadline)).map_err(|e| e.to_string())?;
    stream.write_all(format!("{call}\n").as_bytes()).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).map_err(|_| "no answer in time")?;
    let answer: Value = serde_json::from_str(&line).map_err(|_| "no answer")?;
    match answer["decision"].as_str() {
        Some("allow") => Ok(Verdict::Allow),
        Some("deny") => Ok(Verdict::Deny(answer["reason"].as_str().unwrap_or("Apex Deck blocked this tool call.").to_string())),
        _ => Err("an answer Deck never gives".into()),
    }
}

#[cfg(not(unix))]
fn ask_deck(_: impl Read, _: Option<&Path>, _: Duration) -> Result<Verdict, String> {
    Err("Apex Deck's Codex hook needs macOS or Linux".into())
}
```

Create `crates/apex-adapters/src/bin/apex-deck-codex-hook.rs`:

```rust
//! The Codex hook helper on its own, for the adapter tests. The app runs
//! the same code as `apex-deck --codex-hook`.
fn main() {
    std::process::exit(apex_adapters::codex_hook_main())
}
```

In `crates/apex-adapters/src/lib.rs`, next to the other `pub use` lines:

```rust
pub use codex_hook::{codex_hook_main, hook_command as codex_hook_command, HOOK_ARG as CODEX_HOOK_ARG};
```

Replace `src-tauri/src/main.rs` `fn main` with:

```rust
fn main() {
    // Codex runs this executable before each MCP call; see the adapters'
    // codex_hook.rs. It answers and exits without opening a window.
    if std::env::args().nth(1).as_deref() == Some(apex_adapters::CODEX_HOOK_ARG) {
        std::process::exit(apex_adapters::codex_hook_main());
    }
    apex_deck_lib::run()
}
```

- [x] **Step 4: Run the tests to see them pass, and try the real binary**

Run: `cargo test -p apex-adapters codex_hook -- --test-threads=1`
Expected: 3 passed.

Run: `cargo build -p apex-deck && printf '%s' '{"tool_name":"mcp__a__get_b","tool_input":{}}' | target/debug/apex-deck --codex-hook`
Expected: one line of JSON with `"permissionDecision":"deny"` and the reason `Apex Deck couldn't check this tool call (not started by Apex Deck), so it was blocked.` No window opens.

Run: `cargo test --workspace -- --test-threads=1`
Expected: all pass, with no warnings.

- [x] **Step 5: Commit (once the human has OK'd commits)**

```bash
git add crates/apex-adapters/src/codex_hook.rs crates/apex-adapters/src/bin/apex-deck-codex-hook.rs crates/apex-adapters/src/lib.rs src-tauri/src/main.rs
git commit -m "feat: add the Codex hook helper (apex-deck --codex-hook)"
```

---

### Task 4: Deck answers the hook during Codex turns

**Files:**
- Modify: `crates/apex-adapters/src/codex_hook.rs` (flag, trust check, two gates, socket, serving)
- Modify: `crates/apex-adapters/src/mcp.rs` (`base_policy`)
- Modify: `crates/apex-adapters/src/codex_server.rs` (`mcp_call`, `hook_ready`, `run`)
- Modify: `crates/apex-adapters/src/cli.rs` (`start_with`, `run_codex_server`, the `codex_hook` field)
- Modify: `crates/apex-adapters/src/lib.rs` (`BuildContext::codex_hook`)
- Modify: `src-tauri/src/lib.rs:232` (pass Deck's executable)
- Test: `crates/apex-adapters/tests/adapters.rs`

**Interfaces:**
- Consumes (Task 3): `hook_command`, `HOOK_TIMEOUT_SECS`, `Verdict`, `SOCKET_ENV`, the `apex-deck-codex-hook` binary.
- Consumes (Task 2): a dropped `approver.decide(…)` withdraws its card.
- Produces:
  - `BuildContext.codex_hook: Option<PathBuf>`
  - `codex_hook::{SESSION_KEY, hook_flag(command: &str) -> String, HookState, hook_state(listed: &Value, command: &str) -> HookState, hooks_list(id: u64, cwd: Option<&str>) -> Value, trust_edit(id: u64, hash: &str) -> Value, McpCall, Gates, Hook, next_call, serve, answer_line}`
  - `mcp::base_policy() -> Value`
  - `codex_server::run(child, turn, prompt, on_progress, approver, hook: Option<&Hook>)`

- [x] **Step 1: Write the failing unit tests**

Append to `mod tests` in `crates/apex-adapters/src/codex_hook.rs`:

```rust
    use apex_core::{Approver, Decision, Progress, ProposedAction};

    #[test]
    fn the_hook_flag_is_toml_with_the_command_escaped() {
        let command = hook_command(Path::new("/Applications/Apex Deck.app/Contents/MacOS/it's"));
        assert_eq!(hook_flag(&command), r#"hooks.PreToolUse=[{matcher="^mcp__", hooks=[{type="command", command="'/Applications/Apex Deck.app/Contents/MacOS/it'\\''s' --codex-hook", timeout=600}]}]"#);
    }

    fn listed(command: &str, trust: &str) -> Value {
        json!({"data": [{"cwd": "/w", "hooks": [
            {"key": "/w/.codex/hooks.json:pre_tool_use:0:0", "source": "project", "eventName": "preToolUse", "handlerType": "command",
             "command": command, "matcher": "^mcp__", "timeoutSec": 600, "enabled": true, "currentHash": "sha256:theirs", "trustStatus": "untrusted"},
            {"key": SESSION_KEY, "source": "sessionFlags", "eventName": "preToolUse", "handlerType": "command",
             "command": command, "matcher": "^mcp__", "timeoutSec": 600, "enabled": true, "currentHash": "sha256:ours", "trustStatus": trust}
        ]}]})
    }

    #[test]
    fn only_decks_own_hook_is_trusted() {
        let ours = "'/a/apex-deck' --codex-hook";
        assert_eq!(hook_state(&listed(ours, "trusted"), ours), HookState::Trusted);
        assert_eq!(hook_state(&listed(ours, "untrusted"), ours), HookState::Untrusted { hash: "sha256:ours".into() });
        assert_eq!(hook_state(&listed(ours, "modified"), ours), HookState::Untrusted { hash: "sha256:ours".into() }, "the app moved");
        assert_eq!(hook_state(&listed("'/evil' --codex-hook", "untrusted"), ours), HookState::Missing, "a command Deck didn't pass");
        let mut off = listed(ours, "trusted");
        off["data"][0]["hooks"][1]["enabled"] = json!(false);
        assert_eq!(hook_state(&off, ours), HookState::Missing);
        assert_eq!(hook_state(&json!({}), ours), HookState::Missing);
        assert_eq!(trust_edit(121, "sha256:ours")["params"]["edits"], json!([{
            "keyPath": "hooks.state.\"/<session-flags>/config.toml:pre_tool_use:0:0\".trusted_hash",
            "value": "sha256:ours", "mergeStrategy": "replace"
        }]));
        assert_eq!(hooks_list(120, Some("/w"))["params"], json!({"cwds": ["/w"]}));
    }

    #[test]
    fn one_answer_covers_one_call_at_the_other_gate_only() {
        let order = || McpCall::from_hook("mcp__probe__place_order", json!({"quantity": "0.001"}));
        let mut gates = Gates::default();
        assert_eq!(gates.at_hook(&order()), None, "a risky call asks");
        gates.answered_at_hook(order(), Decision::Approve);
        assert_eq!(gates.at_hook(&order()), None, "a second identical call asks again");
        assert_eq!(gates.at_codex(&order()), Some(Decision::Approve), "Codex's own request for the approved call doesn't ask twice");
        assert_eq!(gates.at_codex(&order()), None, "one approval lets one call through");

        gates.answered_at_codex(order(), Decision::Approve);
        let mut bigger = order();
        bigger.arguments = json!({"quantity": "1000"});
        assert_eq!(gates.at_hook(&bigger), None, "different arguments ask");
        gates.answered_at_codex(order(), Decision::Reject);
        assert_eq!(gates.at_hook(&order()), Some(Decision::Approve));
        assert_eq!(gates.at_hook(&order()), None, "a refusal lets nothing through");

        let read = McpCall::from_hook("mcp__probe__get_balance", json!({}));
        assert_eq!((gates.at_hook(&read), gates.at_codex(&read)), (Some(Decision::Approve), Some(Decision::Approve)));
        let odd = McpCall::from_hook("not_an_mcp_name", json!({}));
        assert!(odd.risky(), "a name Deck can't split always asks");
        assert_eq!(odd.action().title, "not_an_mcp_name");
        assert_eq!(order().action().title, "probe: place_order");
    }

    struct Never;
    #[async_trait::async_trait]
    impl Approver for Never {
        async fn decide(&self, _: ProposedAction) -> Decision { std::future::pending().await }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_helper_that_hangs_up_withdraws_the_question_and_blocks_the_call() {
        use tokio::io::AsyncWriteExt;
        let (deck_end, mut helper_end) = tokio::net::UnixStream::pair().unwrap();
        helper_end.write_all(&[CALL, &b"\n"[..]].concat()).await.unwrap();
        helper_end.shutdown().await.unwrap(); // the helper's deadline passed
        let mut gates = Gates::default();
        let served = tokio::time::timeout(Duration::from_secs(2), serve(deck_end, &mut gates, &Never, &|_: Progress<'_>| {})).await;
        assert!(served.is_ok(), "Deck stops waiting when the helper hangs up");
        assert_eq!(gates.at_codex(&McpCall::from_hook("mcp__probe__place_order", json!({"quantity": "0.001"}))), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reads_pass_the_hook_without_asking() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (deck_end, mut helper_end) = tokio::net::UnixStream::pair().unwrap();
        helper_end.write_all(b"{\"tool_name\":\"mcp__probe__get_balance\",\"tool_input\":{}}\n").await.unwrap();
        serve(deck_end, &mut Gates::default(), &Never, &|_: Progress<'_>| {}).await;
        let mut answer = String::new();
        BufReader::new(helper_end).read_line(&mut answer).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&answer).unwrap()["decision"], "allow");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_socket_folder_is_private_and_goes_with_the_turn() {
        use std::os::unix::fs::PermissionsExt;
        let hook = Hook::bind(Path::new("/a/apex-deck")).unwrap();
        let folder = hook.socket().parent().unwrap().to_path_buf();
        assert_eq!(std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(hook.command, "'/a/apex-deck' --codex-hook");
        drop(hook);
        assert!(!folder.exists());
    }
```

- [x] **Step 2: Write the failing end-to-end tests**

In `crates/apex-adapters/tests/adapters.rs`:

1. Add `codex_hook: None` to every `BuildContext { … }` literal (lines 173, 183, 211, 249 and `context_in`).
2. In `FAKE_MCP_CODEX`, before the `*'"mcpServerStatus/list"'*)` line, add the answer an older Codex gives:

```sh
 *'"hooks/list"'*) echo '{"id":120,"error":{"code":-32601,"message":"Method not found"}}' ;;
```

3. Append:

```rust
/// A stand-in for `codex app-server` with Deck's hook. It lists the hook
/// with `trust` until Deck writes the trust, refuses the MCP inventory (the
/// hook makes it unnecessary), and for each MCP call runs the hook command
/// through `sh -c`, the way Codex does, with Deck's socket in its
/// environment. `order` says whether Codex's own approval request comes
/// before the hook, after it, or not at all.
#[cfg(unix)]
const FAKE_CODEX_HOOKED: &str = r#"#!/bin/sh
printf '%s\n' "$@" > "DIR/args"
listed=first
hook() {
 printf '{"session_id":"thread-hook","hook_event_name":"PreToolUse","tool_name":"mcp__probe__%s","tool_input":{"quantity":"0.001"}}' "$1" | sh -c "$(cat "DIR/hook-command")" | grep -q '"deny"' && return 1
 return 0
}
codex_asks() {
 echo "{\"method\":\"item/started\",\"params\":{\"item\":{\"type\":\"mcpToolCall\",\"id\":\"call-$1\",\"server\":\"probe\",\"tool\":\"$1\",\"arguments\":{\"quantity\":\"0.001\"}}}}"
 echo '{"method":"mcpServer/elicitation/request","id":"approval-1","params":{"threadId":"thread-hook","serverName":"probe","mode":"form","_meta":{"codex_approval_kind":"mcp_tool_call","tool_params":{"quantity":"0.001"}},"requestedSchema":{"type":"object","properties":{}}}}'
 IFS= read -r answer
 echo "{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"mcpToolCall\",\"id\":\"call-$1\"}}}"
 case "$answer" in *'"action":"accept"'*) return 0 ;; *) return 1 ;; esac
}
while IFS= read -r line; do
 case "$line" in
 *'"method":"initialize"'*) echo '{"id":0,"result":{}}' ;;
 *'"method":"hooks/list"'*)
  if [ "$listed" = first ]; then cat <<'EOF'
LISTED_FIRST
EOF
  else cat <<'EOF'
LISTED_TRUSTED
EOF
  fi ;;
 *'"method":"config/batchWrite"'*) printf '%s\n' "$line" > "DIR/trust"; listed=trusted; echo '{"id":121,"result":{}}' ;;
 *'"mcpServerStatus/list"'*) echo '{"id":10,"error":{"message":"the hook makes the inventory unnecessary"}}' ;;
 *'"method":"thread/start"'*) printf '%s\n' "$line" > "DIR/thread"; echo '{"id":1,"result":{"thread":{"id":"thread-hook"}}}' ;;
 *'"method":"turn/start"'*)
  for tool in get_balance place_order place_order; do
   case ORDER in
   hook-only) hook $tool ;;
   hook-first) hook $tool && codex_asks $tool ;;
   codex-first) codex_asks $tool && hook $tool ;;
   esac && allowed=$((allowed+1)) || denied=$((denied+1))
  done
  echo "{\"method\":\"item/completed\",\"params\":{\"item\":{\"type\":\"agentMessage\",\"id\":\"reply\",\"text\":\"allowed=${allowed:-0} denied=${denied:-0}\"}}}"
  echo '{"method":"turn/completed","params":{"turn":{"status":"completed","error":null}}}' ;;
 *'"account/rateLimits/read"'*) echo '{"id":3,"result":{}}' ;;
 esac
done
"#;

/// A fake Codex that supports the hook, and a context whose helper is the
/// real one, installed under a folder with a space the way
/// `/Applications/Apex Deck.app` is.
#[cfg(unix)]
fn hooked(tag: &str, trust: &str, order: &str) -> (std::path::PathBuf, BuildContext) {
    let dir = fake_tool(tag, "codex", "#!/bin/sh\n");
    let app = dir.join("Apex Deck");
    std::fs::create_dir_all(&app).unwrap();
    let helper = app.join("apex-deck");
    let _ = std::fs::remove_file(&helper);
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_apex-deck-codex-hook"), &helper).unwrap();
    let command = apex_adapters::codex_hook_command(&helper);
    std::fs::write(dir.join("hook-command"), &command).unwrap();
    let listing = |id: u64, trust: &str| serde_json::json!({"id": id, "result": {"data": [{"cwd": "/", "hooks": [{
        "key": "/<session-flags>/config.toml:pre_tool_use:0:0", "source": "sessionFlags", "eventName": "preToolUse",
        "handlerType": "command", "command": command, "matcher": "^mcp__", "timeoutSec": 600, "enabled": true,
        "currentHash": "sha256:fake", "trustStatus": trust}]}]}}).to_string();
    let script = FAKE_CODEX_HOOKED
        .replace("DIR", &dir.to_string_lossy())
        .replace("ORDER", order)
        .replace("LISTED_FIRST", &listing(120, trust))
        .replace("LISTED_TRUSTED", &listing(122, "trusted"));
    std::fs::write(dir.join("codex"), script).unwrap();
    let context = BuildContext { codex_hook: Some(helper), ..context_in(&dir) };
    (dir, context)
}

/// Run one turn with someone to ask, collecting the activity lines.
async fn work_hooked(participant: &dyn Participant, approver: &dyn Approver) -> (Result<apex_core::Reply, ParticipantError>, Vec<String>) {
    use apex_core::Progress;
    let activity = Mutex::new(Vec::new());
    let result = participant
        .respond_with_approvals(request("hi"), &|update| if let Progress::Activity(line) = update { activity.lock().unwrap().push(line.to_string()) }, approver)
        .await;
    (result, activity.into_inner().unwrap())
}

#[cfg(unix)]
#[tokio::test]
async fn codex_hook_lets_reads_through_and_asks_before_each_risky_call_without_the_inventory() {
    use apex_core::AgentTool;
    let (dir, context) = hooked("codex-hook", "trusted", "hook-only");
    for access in [Access::Read, Access::Ask, Access::Edits, Access::Full] {
        let mut cfg = config("null", Backend::Agent { tool: AgentTool::Codex, model: None });
        cfg.access = access;
        let no = Fixed::new(Decision::Reject);
        let (result, activity) = work_hooked(build(cfg, &context).as_ref(), &no).await;
        assert_eq!(result.unwrap().text, "allowed=1 denied=2");
        let asked = no.asked.lock().unwrap();
        assert_eq!(asked.len(), 2);
        for action in asked.iter() {
            assert_eq!((action.kind, action.title.as_str()), (ActionKind::Tool, "probe: place_order"));
            assert_eq!(serde_json::from_str::<serde_json::Value>(&action.detail).unwrap(), serde_json::json!({"quantity": "0.001"}));
        }
        assert_eq!(activity[0], "Starting Codex", "no inventory wait: {activity:?}");
    }
    let args = std::fs::read_to_string(dir.join("args")).unwrap();
    assert!(args.contains(r#"hooks.PreToolUse=[{matcher="^mcp__""#), "{args}");
    let thread = std::fs::read_to_string(dir.join("thread")).unwrap();
    assert!(thread.contains(r#""approvals_reviewer":"user""#) && !thread.contains("mcp_servers."), "{thread}");
    assert!(!dir.join("trust").exists(), "a trusted hook is not written again");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn codex_hook_is_trusted_once_through_codex_settings() {
    use apex_core::AgentTool;
    let (dir, context) = hooked("codex-hook-trust", "untrusted", "hook-only");
    let bot = build(config("null", Backend::Agent { tool: AgentTool::Codex, model: None }), &context);
    let (result, activity) = work_hooked(bot.as_ref(), &Fixed::new(Decision::Reject)).await;
    assert_eq!(result.unwrap().text, "allowed=1 denied=2");
    assert_eq!(activity[..2], ["Turning on Apex Deck's approval hook in Codex", "Starting Codex"]);
    let trust: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("trust")).unwrap()).unwrap();
    assert_eq!(trust["params"]["edits"], serde_json::json!([{
        "keyPath": "hooks.state.\"/<session-flags>/config.toml:pre_tool_use:0:0\".trusted_hash",
        "value": "sha256:fake", "mergeStrategy": "replace"
    }]));
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn codex_asks_once_per_risky_call_when_both_the_hook_and_codex_ask() {
    use apex_core::AgentTool;
    for order in ["hook-first", "codex-first"] {
        let (dir, context) = hooked(&format!("codex-hook-{order}"), "trusted", order);
        let yes = Fixed::new(Decision::Approve);
        let bot = build(config("null", Backend::Agent { tool: AgentTool::Codex, model: None }), &context);
        let (result, _) = work_hooked(bot.as_ref(), &yes).await;
        assert_eq!(result.unwrap().text, "allowed=3 denied=0", "{order}");
        assert_eq!(yes.asked.lock().unwrap().len(), 2, "{order}: one card per risky call");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn codex_without_the_hook_falls_back_to_the_inventory_policy() {
    use apex_core::AgentTool;
    let dir = fake_tool("codex-no-hooks", "codex", FAKE_MCP_CODEX);
    // An older Codex that has no hooks/list, then a helper that has gone.
    for helper in [std::path::PathBuf::from(env!("CARGO_BIN_EXE_apex-deck-codex-hook")), dir.join("no-such-helper")] {
        let context = BuildContext { codex_hook: Some(helper), ..context_in(&dir) };
        let no = Fixed::new(Decision::Reject);
        let bot = build(config("null", Backend::Agent { tool: AgentTool::Codex, model: None }), &context);
        let (result, activity) = work_hooked(bot.as_ref(), &no).await;
        assert_eq!(result.unwrap().text, "allowed=1 denied=2");
        assert_eq!(activity[0], "Checking MCP tool approval policies");
    }
    std::fs::remove_dir_all(dir).unwrap();
}
```

- [x] **Step 3: Run them to see them fail**

Run: `cargo test -p apex-adapters -- --test-threads=1`
Expected: compile errors: `codex_hook` isn't a field of `BuildContext`; `hook_flag`, `hook_state`, `Gates`, `Hook` and `serve` not found.

- [x] **Step 4: Implement `codex_hook.rs` (Deck's side)**

Add these imports at the top of `codex_hook.rs`, next to the existing ones:

```rust
use apex_core::{Approver, Decision, Progress, ProgressSink, ProposedAction};
```

Then add, above the tests:

```rust
/// Where Codex files the first hook passed with `-c` at launch.
pub(crate) const SESSION_KEY: &str = "/<session-flags>/config.toml:pre_tool_use:0:0";
const MATCHER: &str = "^mcp__";
const REJECTED: &str = "The person reading the chat rejected this tool call.";

/// The `-c` value that adds the hook to one Codex launch.
pub(crate) fn hook_flag(command: &str) -> String {
    format!(
        "hooks.PreToolUse=[{{matcher={}, hooks=[{{type=\"command\", command={}, timeout={HOOK_TIMEOUT_SECS}}}]}}]",
        toml_string(MATCHER),
        toml_string(command)
    )
}

/// A TOML basic string.
fn toml_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// What `hooks/list` says about Deck's hook.
#[derive(Debug, PartialEq)]
pub(crate) enum HookState {
    /// Not listed exactly as Deck passed it: hooks are off, or it isn't Deck's.
    Missing,
    /// Deck's, but not trusted yet, or trusted for an older command.
    Untrusted { hash: String },
    Trusted,
}

pub(crate) fn hook_state(listed: &Value, command: &str) -> HookState {
    let ours = listed["data"].as_array().into_iter().flatten()
        .filter_map(|entry| entry["hooks"].as_array()).flatten()
        .find(|hook| hook["key"] == SESSION_KEY && hook["source"] == "sessionFlags"
            && hook["eventName"] == "preToolUse" && hook["handlerType"] == "command"
            && hook["matcher"] == MATCHER && hook["command"] == command
            && hook["timeoutSec"] == HOOK_TIMEOUT_SECS && hook["enabled"] == true);
    let Some(hook) = ours else { return HookState::Missing };
    match (hook["trustStatus"].as_str(), hook["currentHash"].as_str()) {
        (Some("trusted"), _) => HookState::Trusted,
        (_, Some(hash)) if hash.starts_with("sha256:") => HookState::Untrusted { hash: hash.to_string() },
        _ => HookState::Missing,
    }
}

pub(crate) fn hooks_list(id: u64, cwd: Option<&str>) -> Value {
    json!({"id": id, "method": "hooks/list", "params": {"cwds": cwd.into_iter().collect::<Vec<_>>()}})
}

/// The settings change that trusts Deck's hook: two lines in the user's
/// Codex config, and nothing else.
pub(crate) fn trust_edit(id: u64, hash: &str) -> Value {
    json!({"id": id, "method": "config/batchWrite", "params": {"edits": [{
        "keyPath": format!("hooks.state.\"{SESSION_KEY}\".trusted_hash"), "value": hash, "mergeStrategy": "replace"
    }]}})
}

/// One MCP call, as both gates see it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct McpCall {
    pub server: String,
    pub tool: String,
    pub arguments: Value,
}

impl McpCall {
    /// From the hook's `tool_name`, `mcp__<server>__<tool>`. A name of any
    /// other shape keeps no server and always asks.
    pub(crate) fn from_hook(tool_name: &str, arguments: Value) -> Self {
        match crate::mcp::claude_tool(tool_name) {
            Some((server, tool)) => Self { server: server.to_string(), tool: tool.to_string(), arguments },
            None => Self { server: String::new(), tool: tool_name.to_string(), arguments },
        }
    }

    pub(crate) fn risky(&self) -> bool {
        self.server.is_empty() || crate::mcp::needs_approval(&self.tool)
    }

    pub(crate) fn action(&self) -> ProposedAction {
        let mut action = crate::mcp::action(&self.server, &self.tool, &self.arguments);
        if self.server.is_empty() {
            action.title = self.tool.clone();
        }
        action
    }
}

/// A risky call can meet two gates in one turn: Deck's hook and Codex's own
/// approval request, in either order. The person answers once. An approval
/// at one gate lets exactly one identical call through the other gate, and
/// never a second call through the same gate.
#[derive(Default)]
pub(crate) struct Gates {
    approved_at_hook: Vec<McpCall>,
    approved_at_codex: Vec<McpCall>,
}

impl Gates {
    /// The answer at the hook when nobody needs asking.
    pub(crate) fn at_hook(&mut self, call: &McpCall) -> Option<Decision> {
        Self::check(call, &mut self.approved_at_codex)
    }

    /// The answer to Codex's own request when nobody needs asking.
    pub(crate) fn at_codex(&mut self, call: &McpCall) -> Option<Decision> {
        Self::check(call, &mut self.approved_at_hook)
    }

    pub(crate) fn answered_at_hook(&mut self, call: McpCall, decision: Decision) {
        if decision == Decision::Approve {
            self.approved_at_hook.push(call);
        }
    }

    pub(crate) fn answered_at_codex(&mut self, call: McpCall, decision: Decision) {
        if decision == Decision::Approve {
            self.approved_at_codex.push(call);
        }
    }

    fn check(call: &McpCall, approved_elsewhere: &mut Vec<McpCall>) -> Option<Decision> {
        if !call.risky() {
            return Some(Decision::Approve);
        }
        let found = approved_elsewhere.iter().position(|approved| approved == call)?;
        approved_elsewhere.remove(found);
        Some(Decision::Approve)
    }
}

/// Deck's answer to the helper: one JSON line.
pub(crate) fn answer_line(verdict: &Verdict) -> String {
    let answer = match verdict {
        Verdict::Allow => json!({"decision": "allow"}),
        Verdict::Deny(reason) => json!({"decision": "deny", "reason": reason}),
    };
    format!("{answer}\n")
}

/// The turn's end of the helper's line: a socket in a folder only this
/// user can open. The folder is removed when the turn ends.
#[cfg(unix)]
pub(crate) struct Hook {
    pub command: String,
    dir: PathBuf,
    listener: tokio::net::UnixListener,
}

#[cfg(unix)]
impl Hook {
    pub(crate) fn bind(helper: &Path) -> std::io::Result<Self> {
        use std::os::unix::fs::DirBuilderExt;
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        // Kept short: a socket path must fit in about 100 bytes.
        let dir = std::env::temp_dir().join(format!("apex-hook-{}-{}-{nanos:x}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        match tokio::net::UnixListener::bind(dir.join("s")) {
            Ok(listener) => Ok(Self { command: hook_command(helper), dir, listener }),
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                Err(e)
            }
        }
    }

    pub(crate) fn socket(&self) -> PathBuf {
        self.dir.join("s")
    }

    pub(crate) fn flag(&self) -> String {
        hook_flag(&self.command)
    }
}

#[cfg(unix)]
impl Drop for Hook {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The helper's next call. Without a hook it never comes.
#[cfg(unix)]
pub(crate) async fn next_call(hook: Option<&Hook>) -> std::io::Result<tokio::net::UnixStream> {
    match hook {
        Some(hook) => hook.listener.accept().await.map(|(stream, _)| stream),
        None => std::future::pending().await,
    }
}

/// Answer one helper call. Reads go through, and a risky call goes to the
/// person. If the helper hangs up first (its deadline passed, or Codex
/// stopped it), the card is withdrawn and the call counts as refused.
#[cfg(unix)]
pub(crate) async fn serve(stream: tokio::net::UnixStream, gates: &mut Gates, approver: &dyn Approver, on_progress: ProgressSink<'_>) {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let (read, mut write) = stream.into_split();
    let mut read = BufReader::new(read);
    let mut line = String::new();
    let call = match tokio::time::timeout(Duration::from_secs(5), read.read_line(&mut line)).await {
        Ok(Ok(count)) if count > 0 => serde_json::from_str::<Value>(&line).ok()
            .and_then(|input| Some(McpCall::from_hook(input["tool_name"].as_str()?, input["tool_input"].clone()))),
        _ => None,
    };
    let verdict = match call {
        None => Verdict::Deny("Apex Deck couldn't read this tool call, so it was blocked.".into()),
        Some(call) => {
            let decision = match gates.at_hook(&call) {
                Some(decision) => decision,
                None => {
                    let action = call.action();
                    on_progress(Progress::Activity(&format!("Waiting for approval: {}", action.title)));
                    let mut byte = [0u8; 1];
                    let decision = tokio::select! {
                        decision = approver.decide(action) => decision,
                        _ = read.read(&mut byte) => Decision::Reject,
                    };
                    gates.answered_at_hook(call, decision);
                    decision
                }
            };
            match decision {
                Decision::Approve => Verdict::Allow,
                Decision::Reject => Verdict::Deny(REJECTED.into()),
            }
        }
    };
    let _ = write.write_all(answer_line(&verdict).as_bytes()).await;
}

// Elsewhere there is no hook; these keep the callers free of `cfg`.
#[cfg(not(unix))]
pub(crate) struct Hook {
    pub command: String,
}

#[cfg(not(unix))]
impl Hook {
    pub(crate) fn bind(_: &Path) -> std::io::Result<Self> {
        Err(std::io::ErrorKind::Unsupported.into())
    }

    pub(crate) fn socket(&self) -> PathBuf {
        PathBuf::new()
    }

    pub(crate) fn flag(&self) -> String {
        hook_flag(&self.command)
    }
}

#[cfg(not(unix))]
pub(crate) async fn next_call(_: Option<&Hook>) -> std::io::Result<std::convert::Infallible> {
    std::future::pending().await
}

#[cfg(not(unix))]
pub(crate) async fn serve(stream: std::convert::Infallible, _: &mut Gates, _: &dyn Approver, _: ProgressSink<'_>) {
    match stream {}
}
```

- [x] **Step 5: Implement `mcp.rs`**

Add above `codex_policy`:

```rust
/// What every Codex turn sets, with or without the inventory: ChatGPT apps
/// ask, and the person, not an automatic reviewer, answers. With Deck's
/// hook in place this is the whole policy.
pub(crate) fn base_policy() -> Value {
    json!({"approvals_reviewer":"user",
        "apps._default.default_tools_approval_mode":"prompt",
        "apps._default.approvals_reviewer":"user"})
}
```

In `codex_policy`, replace the `let mut config = json!({...});` statement with `let mut config = base_policy();`.

- [x] **Step 6: Implement `codex_server.rs`**

Add to the imports: `use crate::codex_hook::{hook_state, hooks_list, next_call, serve, trust_edit, Gates, Hook, HookState, McpCall};`

Replace `mcp_proposal` with:

```rust
/// Bind the CLI's approval to the exact in-flight call, never its prose
/// description or a display-name summary. Ambiguous or missing calls reject.
fn mcp_call(params: &Value, pending: &HashMap<String, Value>) -> Option<McpCall> {
    if params["_meta"]["codex_approval_kind"] != "mcp_tool_call" { return None; }
    let server = params["serverName"].as_str()?;
    let arguments = params["_meta"].get("tool_params")?;
    let mut matches = pending.values().filter(|item| item["server"] == server && &item["arguments"] == arguments);
    let item = matches.next()?;
    if matches.next().is_some() { return None; }
    Some(McpCall { server: server.to_string(), tool: item["tool"].as_str()?.to_string(), arguments: arguments.clone() })
}
```

In the test `mcp_approval_binds_exact_arguments_and_rejects_ambiguous_or_unrelated_forms`, replace the three lines starting `let (action, risky) = mcp_proposal(…)` with:

```rust
        let call = mcp_call(&params, &pending).unwrap();
        assert!(call.risky(), "use exact tool name, not title punctuation");
        assert_eq!(call.action().title,"probe: post: read");
```

Replace the remaining `mcp_proposal(` calls with `mcp_call(`.

Add after `PLUGINS`:

```rust
/// Request ids for the hook check, clear of the others.
const HOOKS_LIST: u64 = 120;
const TRUST_WRITE: u64 = 121;
const HOOKS_RELIST: u64 = 122;

/// Send one setup request and wait for its answer.
async fn request(stdin: &mut ChildStdin, lines: &mut Lines<BufReader<ChildStdout>>, message: &Value) -> Result<Value, String> {
    send(stdin, message).await.map_err(|e| format!("the app server went away: {e}"))?;
    answer(lines, message["id"].as_u64().unwrap_or_default()).await
}

/// Make sure Codex will run Deck's hook this turn, trusting it when it is
/// new or the app has moved. False means the turn uses the inventory
/// policy instead: a Codex without hooks, hooks switched off, or trust
/// that did not take.
async fn hook_ready(
    stdin: &mut ChildStdin,
    lines: &mut Lines<BufReader<ChildStdout>>,
    cwd: Option<&str>,
    command: &str,
    on_progress: ProgressSink<'_>,
) -> bool {
    let hash = match request(stdin, lines, &hooks_list(HOOKS_LIST, cwd)).await.map(|listed| hook_state(&listed, command)) {
        Ok(HookState::Trusted) => return true,
        Ok(HookState::Untrusted { hash }) => hash,
        Ok(HookState::Missing) => {
            eprintln!("[apex-deck] Codex did not list Deck's approval hook; using the MCP inventory");
            return false;
        }
        Err(why) => {
            eprintln!("[apex-deck] Codex hooks unavailable ({why}); using the MCP inventory");
            return false;
        }
    };
    on_progress(Progress::Activity("Turning on Apex Deck's approval hook in Codex"));
    if let Err(why) = request(stdin, lines, &trust_edit(TRUST_WRITE, &hash)).await {
        eprintln!("[apex-deck] couldn't trust Deck's approval hook ({why}); using the MCP inventory");
        return false;
    }
    let listed = request(stdin, lines, &hooks_list(HOOKS_RELIST, cwd)).await;
    let trusted = matches!(listed.map(|listed| hook_state(&listed, command)), Ok(HookState::Trusted));
    if !trusted {
        eprintln!("[apex-deck] Deck's approval hook is still not trusted; using the MCP inventory");
    }
    trusted
}
```

Change `run`'s signature to take the hook last:

```rust
pub(crate) async fn run(
    mut child: Child,
    turn: Turn<'_>,
    prompt: &str,
    on_progress: ProgressSink<'_>,
    approver: &dyn Approver,
    hook: Option<&Hook>,
) -> Result<Reply, TurnError> {
```

Replace everything from `on_progress(Progress::Activity("Checking MCP tool approval policies"));` up to `on_progress(Progress::Activity("Starting Codex"));` with:

```rust
    let hooked = match hook {
        Some(hook) => hook_ready(&mut stdin, &mut lines, turn.cwd.as_deref(), &hook.command, on_progress).await,
        None => false,
    };
    let policy = if hooked {
        // The hook asks about every MCP call, so no tool list is needed.
        crate::mcp::base_policy()
    } else {
        on_progress(Progress::Activity("Checking MCP tool approval policies"));
        let (policy, menu) = mcp_inventory(&mut stdin, &mut lines).await.map_err(TurnError::Failed)?;
        // Without the plugins the list would be short, so keep the last one.
        if let Ok(servers) = &menu {
            on_progress(Progress::ToolServers(servers));
        }
        policy
    };
    on_progress(Progress::Activity("Starting Codex"));
```

Replace the head of the turn loop, from `let mut pending_mcp = HashMap::new();` through the `let line = match lines.next_line().await { … };` statement, with:

```rust
    let mut pending_mcp = HashMap::new();
    let mut gates = Gates::default();
    let mut listening = hook;
    while !reader.turn_over() {
        let next = tokio::select! {
            next = lines.next_line() => next,
            call = next_call(listening) => {
                match call {
                    Ok(stream) => serve(stream, &mut gates, approver, on_progress).await,
                    Err(e) => {
                        eprintln!("[apex-deck] Codex approval hook stopped listening: {e}");
                        listening = None;
                    }
                }
                continue;
            }
        };
        let line = match next {
            Ok(Some(line)) => line,
            Ok(None) => return Err(TurnError::Failed(ended_early(reader))),
            Err(e) => return Err(TurnError::Failed(format!("reading output failed: {e}"))),
        };
```

In the elicitation branch, replace the `else if let Some((action, risky)) = mcp_proposal(…) { … }` arm with:

```rust
                        } else if let Some(call) = mcp_call(params, &pending_mcp) {
                            match gates.at_codex(&call) {
                                Some(decision) => decision,
                                None => {
                                    let action = call.action();
                                    on_progress(Progress::Activity(&format!("Waiting for approval: {}", action.title)));
                                    let decision = approver.decide(action).await;
                                    gates.answered_at_codex(call, decision);
                                    decision
                                }
                            }
                        } else { Decision::Reject };
```

Add this to the end of the module doc at the top of `codex_server.rs`:

```rust
//!
//! Deck's hook (`codex_hook.rs`) asks about every MCP call. Without it the
//! turn first lists every MCP tool to set "prompt" on each (`mcp.rs`).
```

- [x] **Step 7: Implement `cli.rs`, `lib.rs` and the Tauri side**

In `crates/apex-adapters/src/lib.rs`, add to `BuildContext`:

```rust
    /// Deck's own executable, which Codex runs as an approval hook before
    /// each MCP call (`--codex-hook`). `None` leaves Codex on the slower
    /// MCP inventory policy.
    pub codex_hook: Option<PathBuf>,
```

In `crates/apex-adapters/src/cli.rs`:
- Add `use crate::codex_hook;`.
- Add the field `codex_hook: Option<PathBuf>,` to `CliParticipant`, set it to `None` in `new`, set `self.codex_hook = context.codex_hook.clone();` in `with_context`, and add `codex_hook: self.codex_hook.clone()` to the `scoped` literal in `respond_with_approvals`.
- Replace `fn start(&self, program: &str, args: &[String])`'s first two lines (`let mut command = Command::new(program); command.args(args);`) so that `start` becomes a wrapper:

```rust
    fn start(&self, program: &str, args: &[String]) -> Result<Child, ParticipantError> {
        self.start_with(program, args, &[])
    }

    /// `start`, with extra environment variables for the program.
    fn start_with(&self, program: &str, args: &[String], env: &[(&str, std::ffi::OsString)]) -> Result<Child, ParticipantError> {
        let mut command = Command::new(program);
        command.args(args);
        command.envs(env.iter().map(|(name, value)| (*name, value)));
        // …the rest of the old `start` body, unchanged…
    }
```

- In `run_codex_server`, replace the `let args … ; let child = self.start(program, &args)?;` lines with:

```rust
        let mut args: Vec<String> = codex_server::ARGS.iter().map(|a| a.to_string()).collect();
        // Deck's catch-all MCP approval; see codex_hook.rs. A helper that
        // has gone would make Codex run every tool unasked, so check first.
        let hook = self.codex_hook.as_deref().filter(|helper| helper.is_file()).and_then(|helper| {
            codex_hook::Hook::bind(helper).map_err(|e| eprintln!("[apex-deck] Codex approval hook unavailable: {e}")).ok()
        });
        let mut env = Vec::new();
        if let Some(hook) = &hook {
            args.extend(["-c".to_string(), hook.flag()]);
            env.push((codex_hook::SOCKET_ENV, hook.socket().into_os_string()));
        }
        let child = self.start_with(program, &args, &env)?;
```

  Pass `hook.as_ref()` as the last argument of `codex_server::run(…)`.

In `src-tauri/src/lib.rs`, in the `BuildContext { … }` literal near line 232, add:

```rust
        codex_hook: if cfg!(unix) { std::env::current_exe().ok() } else { None },
```

- [x] **Step 8: Run the tests to see them pass**

Run: `cargo test --workspace -- --test-threads=1`
Expected: all pass, with no warnings. Then run `cargo test -p apex-adapters codex_ -- --test-threads=1` three more times to check the end-to-end tests aren't flaky.

If you have a Windows target installed, also run `cargo check -p apex-adapters --target x86_64-pc-windows-msvc`. If you don't, read the `cfg(not(unix))` stubs by eye.

- [x] **Step 9: Commit (once the human has OK'd commits)**

```bash
git add crates/apex-adapters src-tauri/src/lib.rs
git commit -m "feat: approve Codex MCP calls through a PreToolUse hook"
```

---

### Task 5: Check it in the desktop app and write it down

**Files:**
- Modify: `README.md` (the MCP approvals section added on this branch)
- Modify: `docs/superpowers/plans/2026-10-03-open-work.md`
- Modify: `docs/superpowers/plans/2026-10-03-mcp-safety.md`

- [x] **Step 1: Build the app and time the helper**

Run: `npm run tauri build`
Then time the helper with no Deck socket, which is the slowest case because it still prints a deny:

```bash
APP="$(find src-tauri/target/release/bundle -name 'Apex Deck.app' -maxdepth 3 | head -1)/Contents/MacOS"
time (printf '%s' '{"tool_name":"mcp__a__get_b","tool_input":{}}' | "$APP/$(ls "$APP" | head -1)" --codex-hook)
```

Expected: deny JSON, with a "real" time well under 0.1 s. Write down the number.

- [ ] **Step 2: Check a plain turn in the app**

Start the built app. In a thread with Null, send "Reply with just: ok".
Expected: the first turn shows "Turning on Apex Deck's approval hook in Codex", then "Starting Codex". Later turns go straight to "Starting Codex". "Checking MCP tool approval policies" never appears. Write down roughly how long it takes until the reply starts.

Then show the human the two lines Deck added: `grep -n -A1 'session-flags' ~/.codex/config.toml`.

- [ ] **Step 3: Check the approval card (needs the human)**

Ask the human before this step. It adds a fake server to their Codex config for a few minutes.

```bash
codex mcp add deckprobe -- python3 /tmp/deck-hook-probe/server.py
: > /tmp/deck-hook-probe/server-calls.log
```

Then, in the app:
1. Ask Null: "Call the deckprobe tool probe_echo with text hi." Expected: no card. `server-calls.log` gains a `probe_echo` line.
2. Ask Null: "Call the deckprobe tool place_order_probe with qty 1." Expected: exactly one card titled `deckprobe: place_order_probe`. The human rejects it. `server-calls.log` gains nothing.
3. Ask again, and the human approves. Expected: one card only, and one new `place_order_probe` line.
4. (Optional, the human's choice: it takes 10 minutes.) Ask again and leave the card. Expected: at about 9.5 minutes the card is taken down as refused, Null reports the call was blocked, and nothing reaches `server-calls.log`.

Then remove the fake server: `codex mcp remove deckprobe`.

- [x] **Step 4: Write it down**

In `README.md`, in the MCP approvals section, add:

```markdown
**Codex approvals.** Codex has no catch-all approval rule for MCP servers, so each time Deck starts Codex it adds a `PreToolUse` hook (`codex app-server -c hooks.PreToolUse=…`). The hook runs Deck itself (`apex-deck --codex-hook`) before every MCP call. Reads go through, and trading or publishing tools get an approval card, the same as with Claude.

Codex only runs hooks the user has trusted. The first time, and again after the app moves or updates, Deck trusts its own hook through Codex's settings API. That adds two lines to `~/.codex/config.toml`:

    [hooks.state."/<session-flags>/config.toml:pre_tool_use:0:0"]
    trusted_hash = "sha256:…"

They only match a hook passed at launch with Deck's exact command, so Codex in a terminal is unaffected. Codex waits at most 10 minutes for a hook, so a card left unanswered that long is taken down and the call is blocked. With Codex older than 0.160, on Windows, or if the trust doesn't take, Deck instead lists every MCP tool before the turn, which is slower.
```

In `2026-10-03-open-work.md`: under "In progress" (or "Current implementation status" once it's committed), add the hook with a link to this plan and the commits. Under "Verification still owed", record the Step 1–3 results, or what's still unchecked. Note that the `!` menu no longer refreshes from each Codex turn in hook mode. It lists when a pane opens and when the menu opens, and that list is cached.

In `2026-10-03-mcp-safety.md`, at the top of "### Codex", add: "Superseded on Codex 0.160+ by the PreToolUse hook (`2026-10-03-codex-mcp-hook.md`). The inventory policy below is now the fallback."

- [x] **Step 5: Commit (once the human has OK'd commits)**

```bash
git add README.md docs/superpowers/plans/2026-10-03-open-work.md docs/superpowers/plans/2026-10-03-mcp-safety.md docs/superpowers/plans/2026-10-03-codex-mcp-hook.md
git commit -m "docs: describe the Codex approval hook"
```

## Known gaps after this plan

- **The `!` menu** no longer refreshes from each Codex turn in hook mode. It lists when a pane opens or the menu opens, and that list is cached. A server added mid-session shows up after the participant changes or the app restarts.
- **Windows** has no hook, so it keeps the inventory policy.
- **Codex runs the tool if the hook process can't start.** Deck checks the helper exists before each turn. Nothing else can be done about that from Deck's side.


## Spike findings

Null ran Task 1 against the real `codex-cli 0.160.0` app-server on 2026-10-03. Evidence lives in `/tmp/deck-hook-spike/{main,allow,coverage,timing-*}.log`, `/tmp/deck hook spike/helper.log`, and `/tmp/deck-hook-probe/server-calls.log`.

- **G1 PASS:** every hook call received `APEX_DECK_CODEX_HOOK=spike-socket-path`.
- **G2 PASS:** the helper ran from `/tmp/deck hook spike/helper.sh` with `arg1=--codex-hook`.
- **G3 PASS:** only `probe_echo` reached the fake server in both probe turns. Neither fake order reached it. The model reported `Tool call blocked by PreToolUse hook: spike: blocked.`
- **G4 observed:** the hook ran before `item/started` and the read's elicitation. Denying the order prevented its elicitation and server call.
- **G5 observed:** explicit hook allow did not suppress Codex's own elicitation for `probe_echo`. Two-gate handling is needed.
- **G6 PASS (interception):** the helper saw `mcp__computer_history__computer_history_get_settings` and `mcp__codex_apps__github__get_profile`. The settings tool failed downstream; the GitHub profile read succeeded. This verifies hook coverage, not plugin health. Hook names are normalized, whereas item/elicitation names retain `computer-history` and `github.get_profile`; Task 4 must account for this when matching exact calls.
- **G7 PASS:** time to first reply text, in seconds:

  | Run | Hook, no inventory | Inventory |
  | --- | ---: | ---: |
  | 1 | 3.98 | 6.55 |
  | 2 | 10.43 | 7.82 |
  | 3 | 3.71 | 6.93 |
  | Median | 3.98 | 6.93 |

  Median improvement: **2.95 seconds**, above the 2-second gate. Runs alternated hook/inventory sequentially. Model/network timing varied, so this small sample does not guarantee per-turn savings.

The driver verified all fields identifying its own session hook before writing the plan-authorized trust hash through `config/batchWrite` to `hooks.state."/<session-flags>/config.toml:pre_tool_use:0:0"` in the real Codex config. No persistent fake server was added, no trust bypass flag was used, and no other hook was trusted. The current hash refers to the spike helper; Deck's integration will replace it with its own hash.

Current-batch baseline: **204 Rust tests passed serially**, **85 frontend tests passed**, `npm run build` passed (bundle-size advisory), and `git diff --check` passed. No app restart or commit was performed. Tasks 2–5 have not begun; waiting for explicit commit authorization to separate the existing approval, `!server`, and docs changes first.

## Implementation findings

- Task 2 committed as `98c3842`: card/desk cleanup and quiet-clock restart on cancellation. All 208 Rust tests passed serially.
- Task 3 committed as `1ba9ee0`: helper; all 211 Rust tests passed. Real debug executable denied without opening a window.
- Task 4 committed as `719ea93`: exact hook trust checks, two-gate approval handling, Unix socket, inventory fallback. All 222 Rust tests passed without warnings; Codex subset repeated three times (27 unit and 15 integration tests each). No Windows target installed; non-Unix stubs read.
- Implementation corrects the plan's shadowed `call` fixture in the adapter unit test. Spike G6 requires matching plugin server hyphens and app tool dots across gates; a new failing test reproduced duplicate approval, then the fix passed while retaining full argument equality and one-use approvals.
- Task 5 release app and DMG built at `target/release/bundle/{macos,dmg}`. Helper denied in 0.3772 s on its first launch, then 0.0086/0.0065/0.0058/0.0062 s: the cold run misses the suggested 0.1 s target, warm runs meet it.
- Two real Codex turns through the production adapter with the release bundle's helper returned `ok`. First: trust activity at 0.280 s, Starting Codex at 0.315 s, text at 5.047 s. Second: Starting Codex at 0.155 s, text at 6.316 s, no trust write. Neither ran the MCP inventory. The trust hash in the session-flags entry now belongs to Deck's bundled helper, replacing the spike helper hash.
- Native UI remains unverified: the separately built `Apex Deck Hook Check.app` was rejected by computer-use approval ("Computer Use was not approved to use Apex Deck Hook Check"). Production app remains running and was not restarted. Task 5 steps 2 and 3 remain pending; the temporary fake server permission question is unanswered and no server was added. Automated fake-server tests are not human approval-card evidence.
