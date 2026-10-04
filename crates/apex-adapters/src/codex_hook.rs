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
