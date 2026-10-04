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
use apex_core::{Approver, Decision, Progress, ProgressSink, ProposedAction};


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
        let found = approved_elsewhere.iter().position(|approved| {
            // Codex hook names normalize plugin server hyphens and app tool
            // dots; item/elicitation messages retain their routing names.
            !call.server.is_empty()
                && approved.server.replace('-', "_") == call.server.replace('-', "_")
                && approved.tool.replace('.', "__") == call.tool.replace('.', "__")
                && approved.arguments == call.arguments
        })?;
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

    #[test]
    fn plugin_and_app_names_share_one_approval_across_gates() {
        let mut gates = Gates::default();
        let plugin = McpCall { server: "computer-history".into(), tool: "post_note".into(), arguments: json!({"text":"hi"}) };
        gates.answered_at_hook(McpCall::from_hook("mcp__computer_history__post_note", json!({"text":"hi"})), Decision::Approve);
        assert_eq!(gates.at_codex(&plugin), Some(Decision::Approve));
        assert_eq!(gates.at_codex(&plugin), None);
        let app = McpCall { server: "codex_apps".into(), tool: "github.post_comment".into(), arguments: json!({"text":"hi"}) };
        gates.answered_at_codex(app, Decision::Approve);
        assert_eq!(gates.at_hook(&McpCall::from_hook("mcp__codex_apps__github__post_comment", json!({"text":"different"}))), None);
        assert_eq!(gates.at_hook(&McpCall::from_hook("mcp__codex_apps__github__post_comment", json!({"text":"hi"}))), Some(Decision::Approve));
    }

}
