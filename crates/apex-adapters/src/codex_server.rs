//! One chat turn through Codex's app server.
//!
//! `codex exec` can print events, but it only hands over each message once
//! it is complete. The app server (`codex app-server`) is what Codex's own
//! interfaces use: a program that takes requests on standard input and
//! reports on standard output, one JSON message per line, including the
//! reply piece by piece as it is written.
//!
//! A turn is a short conversation with it:
//!
//! 1. `initialize`, answered with details of the server.
//! 2. `thread/start` with the model, folder and access level, answered with
//!    a thread id.
//! 3. `turn/start` with the prompt. From here the server sends
//!    notifications until `turn/completed`.
//!
//! The server is started fresh for each turn and stopped when the turn
//! ends, the same as every other command-line participant.
//!
//! The app server is marked experimental by Codex. If it cannot be started
//! or does not get as far as a thread, the caller falls back to
//! `codex exec`, which gives the same reply without the live text.

use std::time::Duration;

use apex_core::{Access, ActionKind, Approver, Decision, PlanUsage, Progress, ProgressSink, ProposedAction, Reply};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

use crate::events::{codex_plan, EventReader, OutputFormat};
use crate::report;

/// How long the server may take to answer a setup request.
const SETUP_TIMEOUT: Duration = Duration::from_secs(20);

/// How long to wait for the plan's limits after a turn. They are a nicety,
/// so the turn does not wait on them for long.
const LIMITS_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) const ARGS: &[&str] = &["app-server"];

/// What a turn needs besides the prompt.
pub(crate) struct Turn<'a> {
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub access: Access,
    pub cwd: Option<String>,
}

/// Why a turn through the app server did not produce a reply.
pub(crate) enum TurnError {
    /// The server could not be used at all. Nothing was asked of the model,
    /// so it is safe to try another way.
    Unavailable(String),
    /// The turn started and failed.
    Failed(String),
}

fn sandbox(access: Access) -> &'static str {
    match access {
        Access::Read => "read-only",
        Access::Ask | Access::Edits => "workspace-write",
        Access::Full => "danger-full-access",
    }
}

/// When Codex stops to ask. "untrusted" asks before every edit and every
/// command it does not know to be harmless; "never" leaves the sandbox as
/// the only limit.
fn approval_policy(access: Access) -> &'static str {
    match access {
        Access::Ask => "untrusted",
        Access::Read | Access::Edits | Access::Full => "never",
    }
}

/// What the server is asking permission for, if it is something a person
/// can be asked. `reader` has the edits announced so far, which is where
/// the content of a proposed edit comes from.
pub(crate) fn proposal(method: &str, params: &Value, reader: &EventReader) -> Option<ProposedAction> {
    let reason = params["reason"].as_str().map(str::trim).filter(|r| !r.is_empty());
    match method {
        "item/commandExecution/requestApproval" => {
            let command = params["command"].as_str().unwrap_or("(command not given)");
            let detail = match reason {
                Some(reason) => format!("{command}\n\n{reason}"),
                None => command.to_string(),
            };
            Some(ProposedAction { kind: ActionKind::Command, title: "Run a command".to_string(), detail })
        }
        "item/fileChange/requestApproval" => {
            let (title, detail) = params["itemId"]
                .as_str()
                .and_then(|item| reader.pending_edit(item))
                .unwrap_or_else(|| ("Edit files".to_string(), reason.unwrap_or("The edit was not described.").to_string()));
            Some(ProposedAction { kind: ActionKind::Edit, title, detail })
        }
        _ => None,
    }
}

pub(crate) fn approval_response(id: &Value, decision: Decision) -> Value {
    let decision = match decision {
        Decision::Approve => "accept",
        // The edit or command is skipped and the turn carries on.
        Decision::Reject => "decline",
    };
    json!({ "id": id, "result": { "decision": decision } })
}

pub(crate) fn thread_start(turn: &Turn<'_>) -> Value {
    let mut params = json!({
        "approvalPolicy": approval_policy(turn.access),
        "sandbox": sandbox(turn.access),
        // Each chat turn is its own short thread. Keeping them out of
        // Codex's saved sessions stops the history filling with them.
        "ephemeral": true,
    });
    if let Some(model) = turn.model {
        params["model"] = json!(model);
    }
    if let Some(cwd) = &turn.cwd {
        params["cwd"] = json!(cwd);
    }
    json!({ "method": "thread/start", "id": 1, "params": params })
}

pub(crate) fn turn_start(thread: &str, prompt: &str, effort: Option<&str>) -> Value {
    let mut params = json!({ "threadId": thread, "input": [{ "type": "text", "text": prompt }] });
    if let Some(effort) = effort {
        params["effort"] = json!(effort);
    }
    json!({ "method": "turn/start", "id": 2, "params": params })
}

/// Ask for the account's plan limits. It costs no quota.
pub(crate) fn rate_limits_read(id: u64) -> Value {
    json!({ "method": "account/rateLimits/read", "id": id })
}

async fn send(stdin: &mut ChildStdin, message: &Value) -> std::io::Result<()> {
    let mut line = message.to_string();
    line.push('\n');
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

/// Read until the answer to request `id` arrives. Notifications that come
/// first are passed over; none of them matter before the turn starts.
async fn answer(lines: &mut Lines<BufReader<ChildStdout>>, id: u64) -> Result<Value, String> {
    answer_within(lines, id, SETUP_TIMEOUT).await
}

async fn answer_within(lines: &mut Lines<BufReader<ChildStdout>>, id: u64, limit: Duration) -> Result<Value, String> {
    let wait = async {
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                    if message["id"].as_u64() == Some(id) && message.get("method").is_none() {
                        return match message.get("error") {
                            Some(error) => Err(error["message"].as_str().unwrap_or("request refused").to_string()),
                            None => Ok(message["result"].clone()),
                        };
                    }
                }
                Ok(None) => return Err("it stopped before answering".to_string()),
                Err(e) => return Err(format!("its output could not be read: {e}")),
            }
        }
    };
    match tokio::time::timeout(limit, wait).await {
        Ok(result) => result,
        Err(_) => Err(format!("no answer within {} seconds", limit.as_secs())),
    }
}

/// Run one turn. `child` must have been started with `ARGS` and all three
/// standard streams piped.
pub(crate) async fn run(
    mut child: Child,
    turn: Turn<'_>,
    prompt: &str,
    on_progress: ProgressSink<'_>,
    approver: &dyn Approver,
) -> Result<Reply, TurnError> {
    let mut stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");
    let mut lines = BufReader::new(stdout).lines();
    // Drain the log so a chatty server cannot block on a full pipe.
    tokio::spawn(async move {
        let mut sink = Vec::new();
        let _ = stderr.read_to_end(&mut sink).await;
    });

    let unavailable = |what: &str, why: String| TurnError::Unavailable(format!("{what}: {why}"));

    initialize(&mut stdin, &mut lines).await.map_err(TurnError::Unavailable)?;

    send(&mut stdin, &thread_start(&turn))
        .await
        .map_err(|e| unavailable("the app server went away", e.to_string()))?;
    let started = answer(&mut lines, 1).await.map_err(|e| unavailable("could not start a thread", e))?;
    let Some(thread) = started["thread"]["id"].as_str() else {
        return Err(unavailable("could not start a thread", "no thread id in the answer".to_string()));
    };

    // From here the model is being asked, so failures are final.
    send(&mut stdin, &turn_start(thread, prompt, turn.effort))
        .await
        .map_err(|e| TurnError::Failed(format!("could not send the message: {e}")))?;

    let mut reader = EventReader::new(OutputFormat::CodexServer, turn.cwd.clone());
    while !reader.turn_over() {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => return Err(TurnError::Failed(ended_early(reader))),
            Err(e) => return Err(TurnError::Failed(format!("reading output failed: {e}"))),
        };
        if let Ok(message) = serde_json::from_str::<Value>(&line) {
            let id = message.get("id").filter(|id| !id.is_null());
            match (id, message.get("method")) {
                // The server is asking us something. Requests to approve an
                // edit or a command go to the person. Anything else cannot
                // be answered here, and is refused rather than left to hang.
                (Some(id), Some(method)) => {
                    let reply = match proposal(method.as_str().unwrap_or(""), &message["params"], &reader) {
                        Some(action) => {
                            on_progress(Progress::Activity(&format!("Waiting for approval: {}", action.title)));
                            approval_response(id, approver.decide(action).await)
                        }
                        None => json!({ "id": id, "error": { "code": -32601, "message": "Apex Deck cannot answer this request during a chat turn" } }),
                    };
                    let _ = send(&mut stdin, &reply).await;
                    continue;
                }
                // The answer to `turn/start`. Only a refusal matters.
                (Some(_), None) => {
                    if let Some(error) = message.get("error") {
                        let why = error["message"].as_str().unwrap_or("the turn was refused");
                        return Err(TurnError::Failed(why.to_string()));
                    }
                    continue;
                }
                _ => {}
            }
        }
        report(reader.push(&format!("{line}\n")), on_progress);
    }

    // The turn has used some of the plan; read where it stands now.
    if send(&mut stdin, &rate_limits_read(3)).await.is_ok() {
        if let Ok(result) = answer_within(&mut lines, 3, LIMITS_TIMEOUT).await {
            if let Some(plan) = codex_plan(&result["rateLimits"], false) {
                on_progress(Progress::Plan(&plan));
            }
        }
    }

    // Closing its input tells the server to exit; do not wait long for it.
    drop(stdin);
    if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }

    let outcome = reader.outcome();
    match outcome.error {
        Some(error) => Err(TurnError::Failed(error)),
        None => Ok(Reply {
            text: outcome.text.trim().to_string(),
            input_tokens: outcome.input_tokens,
            output_tokens: outcome.output_tokens,
        }),
    }
}

/// The handshake every conversation with the server starts with.
async fn initialize(stdin: &mut ChildStdin, lines: &mut Lines<BufReader<ChildStdout>>) -> Result<(), String> {
    let hello = json!({
        "method": "initialize",
        "id": 0,
        "params": { "clientInfo": { "name": "apex_deck", "title": "Apex Deck", "version": env!("CARGO_PKG_VERSION") } }
    });
    send(stdin, &hello).await.map_err(|e| format!("could not start the app server: {e}"))?;
    answer(lines, 0).await.map_err(|e| format!("the app server did not start: {e}"))?;
    send(stdin, &json!({ "method": "initialized", "params": {} }))
        .await
        .map_err(|e| format!("the app server went away: {e}"))
}

/// Read the account's plan limits without starting a turn. `child` must
/// have been started with `ARGS` and all three standard streams piped.
pub(crate) async fn read_plan(mut child: Child) -> Result<PlanUsage, String> {
    let mut stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");
    tokio::spawn(async move {
        let mut sink = Vec::new();
        let _ = stderr.read_to_end(&mut sink).await;
    });
    let mut lines = BufReader::new(stdout).lines();
    initialize(&mut stdin, &mut lines).await?;
    send(&mut stdin, &rate_limits_read(1)).await.map_err(|e| format!("the app server went away: {e}"))?;
    let result = answer_within(&mut lines, 1, SETUP_TIMEOUT).await;
    drop(stdin);
    if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
    codex_plan(&result?["rateLimits"], false).ok_or_else(|| "the answer had no rate limits".to_string())
}

fn ended_early(reader: EventReader) -> String {
    match reader.outcome().error {
        Some(error) => error,
        None => "it stopped before the turn finished".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_start_carries_access_model_and_folder() {
        let turn = Turn { model: Some("m"), effort: None, access: Access::Edits, cwd: Some("/work".into()) };
        assert_eq!(
            thread_start(&turn),
            json!({ "method": "thread/start", "id": 1, "params": {
                "approvalPolicy": "never", "sandbox": "workspace-write", "ephemeral": true, "model": "m", "cwd": "/work"
            } })
        );
        let asking = Turn { model: None, effort: None, access: Access::Ask, cwd: None };
        assert_eq!(
            thread_start(&asking)["params"],
            json!({ "approvalPolicy": "untrusted", "sandbox": "workspace-write", "ephemeral": true })
        );
        let bare = Turn { model: None, effort: None, access: Access::Read, cwd: None };
        assert_eq!(
            thread_start(&bare)["params"],
            json!({ "approvalPolicy": "never", "sandbox": "read-only", "ephemeral": true })
        );
        let full = Turn { model: None, effort: None, access: Access::Full, cwd: None };
        assert_eq!(thread_start(&full)["params"]["sandbox"], "danger-full-access");
    }

    #[test]
    fn approval_requests_become_proposals_and_other_requests_do_not() {
        let mut reader = EventReader::new(OutputFormat::CodexServer, Some("/work".into()));
        reader.push("{\"method\":\"item/started\",\"params\":{\"item\":{\"type\":\"fileChange\",\"id\":\"i1\",\"changes\":[{\"path\":\"/work/a.rs\",\"kind\":\"update\",\"diff\":\"-x\\n+y\\n\"}]}}}\n");

        let command = proposal("item/commandExecution/requestApproval", &json!({ "itemId": "i0", "command": "cargo test", "reason": "needs network" }), &reader).unwrap();
        assert_eq!((command.kind, command.title.as_str(), command.detail.as_str()), (ActionKind::Command, "Run a command", "cargo test\n\nneeds network"));

        let edit = proposal("item/fileChange/requestApproval", &json!({ "itemId": "i1" }), &reader).unwrap();
        assert_eq!((edit.kind, edit.title.as_str(), edit.detail.as_str()), (ActionKind::Edit, "Edit a.rs", "a.rs\n-x\n+y\n"));

        let unknown = proposal("item/fileChange/requestApproval", &json!({ "itemId": "never-announced" }), &reader).unwrap();
        assert_eq!(unknown.title, "Edit files");

        assert!(proposal("item/tool/requestUserInput", &json!({}), &reader).is_none());
        assert_eq!(approval_response(&json!(7), Decision::Approve), json!({ "id": 7, "result": { "decision": "accept" } }));
        assert_eq!(approval_response(&json!("a"), Decision::Reject), json!({ "id": "a", "result": { "decision": "decline" } }));
    }

    #[test]
    fn rate_limits_are_read_with_no_params() {
        assert_eq!(rate_limits_read(3), json!({ "method": "account/rateLimits/read", "id": 3 }));
    }

    #[test]
    fn turn_start_carries_the_prompt_and_effort_only_when_set() {
        assert_eq!(
            turn_start("t1", "hello", Some("high")),
            json!({ "method": "turn/start", "id": 2, "params": {
                "threadId": "t1", "input": [{ "type": "text", "text": "hello" }], "effort": "high"
            } })
        );
        assert!(turn_start("t1", "hello", None)["params"].get("effort").is_none());
    }
}
