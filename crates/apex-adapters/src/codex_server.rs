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
//! MCP approvals require this two-way path. If it cannot be started, the
//! turn is refused rather than falling back to an unprotected exec turn.

//!
//! Deck's hook (`codex_hook.rs`) asks about every MCP call. Without it the
//! turn first lists every MCP tool to set "prompt" on each (`mcp.rs`).

use std::time::Duration;
use std::collections::HashMap;

use apex_core::{Access, ActionKind, Approver, Decision, PlanUsage, Progress, ProgressSink, ProposedAction, Reply};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

use crate::events::{codex_plan, EventReader, OutputFormat};
use crate::report;
use crate::codex_hook::{hook_state, hooks_list, next_call, serve, trust_edit, Gates, Hook, HookState, McpCall};

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
/// command it does not know to be harmless. Other access levels keep MCP
/// elicitation enabled without asking for local sandbox escalations.
fn approval_policy(access: Access) -> Value {
    match access {
        Access::Ask => json!("untrusted"),
        Access::Read | Access::Edits | Access::Full => json!({"granular": {
            "mcp_elicitations": true, "rules": false, "sandbox_approval": false
        }}),
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
            // The reason goes in the title. An Always allow rule matches a
            // command's detail, so it then covers this command whatever
            // Codex says about it, and never a different command.
            let title = match reason {
                Some(reason) => format!("Run a command · {}", reason.split_whitespace().collect::<Vec<_>>().join(" ")),
                None => "Run a command".to_string(),
            };
            Some(ProposedAction { kind: ActionKind::Command, title, detail: command.to_string(), expires_at: None, risky: false })
        }
        "item/fileChange/requestApproval" => {
            let (title, detail) = params["itemId"]
                .as_str()
                .and_then(|item| reader.pending_edit(item))
                .unwrap_or_else(|| ("Edit files".to_string(), reason.unwrap_or("The edit was not described.").to_string()));
            Some(ProposedAction { kind: ActionKind::Edit, title, detail, expires_at: None, risky: false })
        }
        _ => None,
    }
}

pub(crate) fn approval_response(id: &Value, decision: Decision) -> Value {
    let decision = match decision {
        Decision::Approve | Decision::ApproveAlways => "accept",
        // The edit or command is skipped and the turn carries on.
        Decision::Reject => "decline",
    };
    json!({ "id": id, "result": { "decision": decision } })
}

/// MCP approval is an elicitation, not a command approval. "Always allow"
/// tells Codex to remember the choice for its session only. Each turn is a
/// fresh session, so the thread's saved list stays the one lasting record
/// and Remove in thread details really takes it back.
fn mcp_response(id: &Value, decision: Decision) -> Value {
    let mut result = json!({"action": if decision.approved() {"accept"} else {"decline"},
        "content": if decision.approved() {json!({})} else {Value::Null}});
    if decision == Decision::ApproveAlways { result["_meta"] = json!({"persist": "session"}); }
    json!({"id":id,"result":result})
}

/// Bind the CLI's approval to the exact in-flight call, never its prose
/// description or a display-name summary. Ambiguous or missing calls reject.
fn mcp_call(params: &Value, pending: &HashMap<String, Value>) -> Option<McpCall> {
    if params["_meta"]["codex_approval_kind"] != "mcp_tool_call" { return None; }
    let server = params["serverName"].as_str()?;
    let arguments = params["_meta"].get("tool_params")?;
    let mut matches = pending.values().filter(|item| item["server"] == server && &item["arguments"] == arguments);
    let item = matches.next()?;
    if matches.next().is_some() { return None; }
    Some(McpCall { server: server.to_string(), tool: item["tool"].as_str()?.to_string(), arguments: arguments.clone(), expires_at: None })
}

/// A server's own question that is not a tool call, such as Computer Use
/// asking to control an app. It is shown only when it can be answered with
/// a bare accept: a form that asks for nothing required. Computer Use tags
/// its nested app permission as a tool call, but its app arguments differ
/// from the enclosing JavaScript call. It must get a separate human decision,
/// never reuse the hook's decision. Other unmatched tool approvals reject.
fn mcp_question(params: &Value) -> Option<ProposedAction> {
    let meta = &params["_meta"];
    let app = if meta["codex_approval_kind"] == "mcp_tool_call" {
        if meta["connector_id"] != "computer-use" { return None; }
        Some(meta["tool_params"]["app"].as_str().filter(|app| !app.trim().is_empty())?)
    } else { None };
    if !matches!(params["mode"].as_str(), None | Some("form")) || params.get("url").is_some() { return None; }
    let schema = &params["requestedSchema"];
    if schema["required"].as_array().is_some_and(|required| !required.is_empty()) { return None; }
    let server = params["serverName"].as_str().filter(|name| !name.is_empty())?;
    let message = params["message"].as_str().filter(|text| !text.trim().is_empty())?;
    let detail = match app {
        Some(app) => format!("{message}\n\nApp: {app}\nRequested by: {server}"),
        None => message.to_string(),
    };
    Some(ProposedAction { kind: ActionKind::Other, title: format!("{server} asks permission"), detail, expires_at: None, risky: high_risk(params) })
}

/// Codex marks some approval requests `riskLevel: "high"` in their `_meta`.
fn high_risk(params: &Value) -> bool {
    params["_meta"]["riskLevel"] == "high"
}

/// The card for an in-flight MCP call Codex asked about: risky when the
/// tool's name says so or Codex marks the request high risk.
fn call_action(call: &McpCall, params: &Value) -> ProposedAction {
    let mut action = call.action();
    action.risky |= high_risk(params);
    action
}


/// The id of `plugin/list`, which is sent alongside the MCP inventory.
const PLUGINS: u64 = 110;
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


/// The approval policy for every MCP tool, and the names for the `!` menu.
/// Plugins only feed the menu, so they are asked for alongside the first
/// inventory page and a failure there does not stop the turn.
async fn mcp_inventory(stdin: &mut ChildStdin, lines: &mut Lines<BufReader<ChildStdout>>) -> Result<(Value, Result<Vec<apex_core::server_request::ToolServer>, String>), String> {
    send(stdin, &json!({"id":PLUGINS,"method":"plugin/list","params":{}})).await
        .map_err(|_| "Couldn't list Codex MCP servers".to_string())?;
    let mut plugins = Err("no answer".to_string());
    let mut servers = Vec::new();
    let mut cursor = Value::Null;
    let mut cursors = std::collections::HashSet::new();
    for page in 0..100u64 {
        let id = 10 + page;
        send(stdin, &json!({"id":id,"method":"mcpServerStatus/list", "params":{
            "detail":"toolsAndAuthOnly", "limit":100, "cursor":cursor
        }})).await.map_err(|_| "Couldn't list Codex MCP servers".to_string())?;
        let with_plugins = [id, PLUGINS];
        let mut replies = answers(lines, if page == 0 { &with_plugins } else { &with_plugins[..1] }, SETUP_TIMEOUT).await;
        if page == 0 { plugins = replies.pop().expect("one answer per request"); }
        let result = replies.pop().expect("one answer per request")
            .map_err(|_| "Couldn't list Codex MCP servers; this turn did not run.".to_string())?;
        let data = result["data"].as_array().ok_or("Codex MCP inventory had no server list")?;
        servers.extend(data.iter().cloned());
        cursor = result["nextCursor"].clone();
        if cursor.is_null() {
            let policy = crate::mcp::codex_policy(&servers)?;
            let menu = plugins.map(|plugins| crate::mcp::menu_names(&servers, &plugins))
                .map_err(|e| format!("Couldn't list Codex plugins: {e}"));
            return Ok((policy, menu));
        }
        if !cursor.is_string() || !cursors.insert(cursor.to_string()) { return Err("Invalid Codex MCP inventory cursor".into()); }
    }
    Err("Codex MCP inventory exceeded its page limit".into())
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
    answers(lines, &[id], limit).await.pop().expect("one answer per request")
}

/// Read until every request in `ids` is answered, giving one result per id
/// in the same order. The server works on requests side by side, so ones
/// sent together can be answered in any order.
async fn answers(lines: &mut Lines<BufReader<ChildStdout>>, ids: &[u64], limit: Duration) -> Vec<Result<Value, String>> {
    let mut got: Vec<Option<Result<Value, String>>> = vec![None; ids.len()];
    let wait = async {
        while got.iter().any(Option::is_none) {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                    if message.get("method").is_some() { continue; }
                    let Some(slot) = message["id"].as_u64().and_then(|id| ids.iter().position(|&want| want == id)) else { continue };
                    got[slot] = Some(match message.get("error") {
                        Some(error) => Err(error["message"].as_str().unwrap_or("request refused").to_string()),
                        None => Ok(message["result"].clone()),
                    });
                }
                Ok(None) => return Err("it stopped before answering".to_string()),
                Err(e) => return Err(format!("its output could not be read: {e}")),
            }
        }
        Ok(())
    };
    let why = match tokio::time::timeout(limit, wait).await {
        Ok(ended) => ended.err(),
        Err(_) => Some(format!("no answer within {} seconds", limit.as_secs())),
    };
    got.into_iter().map(|slot| slot.unwrap_or_else(|| Err(why.clone().unwrap_or_default()))).collect()
}

/// Run one turn. `child` must have been started with `ARGS` and all three
/// standard streams piped.
pub(crate) async fn run(
    mut child: Child,
    turn: Turn<'_>,
    prompt: &str,
    on_progress: ProgressSink<'_>,
    approver: &dyn Approver,
    hook: Option<&Hook>,
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
    let mut start = thread_start(&turn);
    start["params"]["config"] = policy;
    send(&mut stdin, &start)
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
        if let Ok(message) = serde_json::from_str::<Value>(&line) {
            let item = &message["params"]["item"];
            if message["method"] == "item/started" && item["type"] == "mcpToolCall" {
                if let Some(id) = item["id"].as_str() { pending_mcp.insert(id.to_string(), item.clone()); }
            }
            if message["method"] == "item/completed" {
                if let Some(id) = item["id"].as_str() { pending_mcp.remove(id); }
            }
            let id = message.get("id").filter(|id| !id.is_null());
            match (id, message.get("method")) {
                // The server is asking us something. Requests to approve an
                // edit or a command go to the person. Anything else cannot
                // be answered here, and is refused rather than left to hang.
                (Some(id), Some(method)) => {
                    if method == "mcpServer/elicitation/request" {
                        let params = &message["params"];
                        // Only the fields that decide which buttons the card shows.
                        let meta = &params["_meta"];
                        eprintln!("[apex-deck] permission request: server={} connector={} tool={} persist={} riskLevel={}",
                            params["serverName"], meta["connector_id"], meta["tool_name"], meta["persist"], meta["riskLevel"]);
                        let decision = if params["threadId"] != thread {
                            Decision::Reject
                        } else if let Some(action) = mcp_question(params) {
                            // App access is a separate decision even if its arguments
                            // happen to match a read that the hook already allowed.
                            on_progress(Progress::Activity(&format!("Waiting for approval: {}", action.title)));
                            approver.decide(action).await
                        } else if let Some(call) = mcp_call(params, &pending_mcp) {
                            match gates.at_codex(&call) {
                                Some(decision) => decision,
                                None => {
                                    let action = call_action(&call, params);
                                    on_progress(Progress::Activity(&format!("Waiting for approval: {}", action.title)));
                                    let decision = approver.decide(action).await;
                                    gates.answered_at_codex(call, decision);
                                    decision
                                }
                            }
                        } else {
                            eprintln!("[apex-deck] declined MCP question: {params}");
                            Decision::Reject
                        };
                        send(&mut stdin, &mcp_response(id, decision)).await
                            .map_err(|_| TurnError::Failed("Could not deliver MCP approval".into()))?;
                        continue;
                    }
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
                crate::plan_cache::remember(&plan);
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
        "params": { "clientInfo": { "name": "apex_deck", "title": "Apex Deck", "version": env!("CARGO_PKG_VERSION") }, "capabilities":{"experimentalApi":true} }
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
    #[test]
    fn a_codex_command_rule_covers_that_command_whatever_the_reason_and_nothing_longer() {
        let reader = EventReader::new(OutputFormat::CodexServer, None);
        let ask = |command: &str, reason: &str| {
            proposal("item/commandExecution/requestApproval", &json!({ "command": command, "reason": reason }), &reader).unwrap()
        };
        let null = apex_core::ParticipantId::new("null");
        let rule = apex_core::AllowedRule::new(&null, &ask("cargo test", "needs network"));
        assert!(rule.covers(&null, &ask("cargo test", "wants to write to target/")), "a different reason is the same command");
        assert!(rule.covers(&null, &ask("cargo test", "")), "no reason at all");
        assert!(!rule.covers(&null, &ask("cargo test\n\nrm -rf ~", "needs network")), "a longer command asks again");
        assert!(!rule.covers(&null, &ask("cargo test --release", "needs network")));
        assert_eq!(ask("ls", "line one\n  line two").title, "Run a command · line one line two");
    }

    #[test]
    fn codex_high_risk_marks_the_card_risky() {
        let ask = json!({"serverName":"computer-use", "mode":"form", "message":"Allow Codex to use Terminal?",
            "requestedSchema":{"type":"object","properties":{}}, "_meta":{"codex_approval_kind":"app_approval","riskLevel":"high"}});
        assert!(mcp_question(&ask).unwrap().risky);
        let mut low = ask.clone(); low["_meta"]["riskLevel"] = json!("low");
        assert!(!mcp_question(&low).unwrap().risky);
        let read = McpCall { server: "probe".into(), tool: "get_balance".into(), arguments: json!({}), expires_at: None };
        assert!(!call_action(&read, &json!({"_meta":{}})).risky);
        assert!(call_action(&read, &json!({"_meta":{"riskLevel":"high"}})).risky, "Codex's own mark is kept");
        let order = McpCall { server: "probe".into(), tool: "place_order".into(), arguments: json!({}), expires_at: None };
        assert!(call_action(&order, &json!({"_meta":{}})).risky, "the name alone is enough");
    }

    use super::*;

    #[test]
    fn mcp_approval_binds_exact_arguments_and_rejects_ambiguous_or_unrelated_forms() {
        let params = json!({"serverName":"probe", "_meta":{"codex_approval_kind":"mcp_tool_call", "tool_params":{"quantity":"0.001"}}});
        let call = json!({"server":"probe", "tool":"post: read", "arguments":{"quantity":"0.001"}});
        let mut pending = HashMap::from([("c1".to_string(),call.clone())]);
        let resolved = mcp_call(&params, &pending).unwrap();
        assert!(resolved.risky(), "use exact tool name, not title punctuation");
        assert_eq!(resolved.action().title,"probe: post: read");
        assert_eq!(resolved.action().expires_at, None, "Codex's own MCP approval never shows a deadline");
        let mut different = params.clone(); different["_meta"]["tool_params"]["quantity"]=json!("1000");
        assert!(mcp_call(&different,&pending).is_none());
        pending.insert("c2".into(),call);
        assert!(mcp_call(&params,&pending).is_none());
        assert!(mcp_call(&json!({"serverName":"probe","mode":"form"}),&pending).is_none());
        let accepted=mcp_response(&json!(1),Decision::Approve);
        assert_eq!(accepted["result"],json!({"action":"accept","content":{}}));
        assert!(!accepted.to_string().contains("persist"));
        assert_eq!(mcp_response(&json!(1),Decision::Reject)["result"]["action"],"decline");
    }

    #[test]
    fn other_mcp_questions_reach_the_person_only_when_a_bare_accept_answers_them() {
        let ask = json!({"serverName":"computer-use", "mode":"form", "message":"Allow Codex to use Apex Deck?",
            "requestedSchema":{"type":"object","properties":{}}, "_meta":{"codex_approval_kind":"app_approval"}});
        let action = mcp_question(&ask).unwrap();
        assert_eq!(action.kind, ActionKind::Other);
        assert_eq!(action.title, "computer-use asks permission");
        assert_eq!(action.detail, "Allow Codex to use Apex Deck?");
        let mut no_meta = ask.clone(); no_meta.as_object_mut().unwrap().remove("_meta");
        assert!(mcp_question(&no_meta).is_some());
        let mut tool = ask.clone(); tool["_meta"]["codex_approval_kind"] = json!("mcp_tool_call");
        assert!(mcp_question(&tool).is_none(), "tool calls must bind to an in-flight call");
        let mut url = ask.clone(); url["mode"] = json!("url"); url["url"] = json!("https://example.com");
        assert!(mcp_question(&url).is_none());
        let mut needs_input = ask.clone();
        needs_input["requestedSchema"] = json!({"type":"object","properties":{"code":{"type":"string"}},"required":["code"]});
        assert!(mcp_question(&needs_input).is_none());
        let mut silent = ask.clone(); silent["message"] = json!(" ");
        assert!(mcp_question(&silent).is_none());
    }

    #[test]
    fn always_allow_asks_codex_to_remember_only_for_its_session() {
        let always = mcp_response(&json!(9), Decision::ApproveAlways);
        assert_eq!(always, json!({"id":9,"result":{"action":"accept","content":{},"_meta":{"persist":"session"}}}));
        assert!(!always.to_string().contains("\"always\""), "nothing Codex keeps after the turn");
        let once = mcp_response(&json!(9), Decision::Approve);
        assert_eq!(once, json!({"id":9,"result":{"action":"accept","content":{}}}));
        let deny = mcp_response(&json!(9), Decision::Reject);
        assert_eq!(deny, json!({"id":9,"result":{"action":"decline","content":null}}));
    }

    #[test]
    fn nested_computer_use_app_permission_reaches_its_own_card() {
        // Shape emitted by @oai/sky computer-use-policy.js through node_repl.
        let ask = json!({"serverName":"node_repl", "mode":"form",
            "message":"Allow Computer Use to use \"Apex Deck\"?",
            "requestedSchema":{"type":"object","properties":{}},
            "_meta":{"codex_approval_kind":"mcp_tool_call","connector_id":"computer-use",
                "connector_name":"Computer Use","tool_name":"get_app_state",
                "tool_params":{"app":"dev.apexdeck.app"},"persist":["session","always"]}});
        let pending = HashMap::from([("c1".to_string(), json!({"server":"node_repl","tool":"js",
            "arguments":{"code":"await cua.getApp(\"Apex Deck\")"}}))]);
        assert!(mcp_call(&ask, &pending).is_none());
        let action = mcp_question(&ask).expect("nested app permission needs a separate user decision");
        assert!(action.detail.starts_with("Allow Computer Use to use \"Apex Deck\"?"));
        assert!(action.detail.contains("dev.apexdeck.app"), "show exact target as well as server prose");
        assert!(!mcp_response(&json!(7), Decision::Approve).to_string().contains("persist"));
        let mut unrelated = ask.clone(); unrelated["_meta"]["connector_id"] = json!("trading");
        assert!(mcp_question(&unrelated).is_none());
        let mut missing_target = ask.clone(); missing_target["_meta"]["tool_params"] = json!({});
        assert!(mcp_question(&missing_target).is_none());
        let mut form = ask.clone(); form["requestedSchema"]["required"] = json!(["choice"]);
        assert!(mcp_question(&form).is_none());
    }

    #[test]
    fn full_access_keeps_mcp_approval_transport_enabled() {
        let turn = Turn { model: None, effort: None, access: Access::Full, cwd: None };
        let policy = thread_start(&turn)["params"]["approvalPolicy"].clone();
        assert_eq!(policy["granular"]["mcp_elicitations"], true);
        assert_eq!(policy["granular"]["sandbox_approval"], false);
        assert_eq!(thread_start(&turn)["params"]["sandbox"], "danger-full-access");
    }

    #[test]
    fn thread_start_carries_access_model_and_folder() {
        let turn = Turn { model: Some("m"), effort: None, access: Access::Edits, cwd: Some("/work".into()) };
        assert_eq!(
            thread_start(&turn),
            json!({ "method": "thread/start", "id": 1, "params": {
                "approvalPolicy": approval_policy(Access::Edits), "sandbox": "workspace-write", "ephemeral": true, "model": "m", "cwd": "/work"
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
            json!({ "approvalPolicy": approval_policy(Access::Read), "sandbox": "read-only", "ephemeral": true })
        );
        let full = Turn { model: None, effort: None, access: Access::Full, cwd: None };
        assert_eq!(thread_start(&full)["params"]["sandbox"], "danger-full-access");
    }

    #[test]
    fn approval_requests_become_proposals_and_other_requests_do_not() {
        let mut reader = EventReader::new(OutputFormat::CodexServer, Some("/work".into()));
        reader.push("{\"method\":\"item/started\",\"params\":{\"item\":{\"type\":\"fileChange\",\"id\":\"i1\",\"changes\":[{\"path\":\"/work/a.rs\",\"kind\":\"update\",\"diff\":\"-x\\n+y\\n\"}]}}}\n");

        let command = proposal("item/commandExecution/requestApproval", &json!({ "itemId": "i0", "command": "cargo test", "reason": "needs network" }), &reader).unwrap();
        assert_eq!((command.kind, command.title.as_str(), command.detail.as_str()), (ActionKind::Command, "Run a command · needs network", "cargo test"));

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

pub async fn list_servers(cwd: Option<String>, path: Option<String>) -> Result<Vec<apex_core::server_request::ToolServer>, String> {
    use std::process::Stdio;
    let mut command = tokio::process::Command::new("codex");
    if let Some(path) = path { command.env("PATH", path); }
    command.args(ARGS).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    if let Some(cwd) = cwd { command.current_dir(cwd); }
    let mut child = command.spawn().map_err(|e| format!("Couldn’t start codex for tool discovery: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let result = async {
        initialize(&mut stdin, &mut lines).await?;
        mcp_inventory(&mut stdin, &mut lines).await.and_then(|(_, names)| names)
    }.await;
    let _ = child.kill().await;
    result
}
