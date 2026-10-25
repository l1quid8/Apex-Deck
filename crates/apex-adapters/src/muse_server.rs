//! One chat turn through Muse Code's session host (`muse serve`).
//!
//! Muse speaks MSP: JSON-RPC 2.0, one message per line on standard input
//! and output. A turn is a short conversation with it:
//!
//! 1. `initialize`, then the `initialized` notification.
//! 2. `session/start` with the folder and approval mode, answered with a
//!    session id. The connection is then subscribed to the session's view.
//! 3. `turn/start` with the prompt. From here the host sends `item/*`
//!    notifications, and `approval/request` when someone must decide, until
//!    `turn/completed`.
//!
//! The host is started fresh for each turn and stopped when the turn ends,
//! the same as every other command-line participant.
//!
//! Billing: the Muse subscription only applies through the real CLI with
//! its own sign-in. `META_API_KEY` overrides that sign-in and bills per
//! use, so `cli.rs` removes it from the host's environment, and this module
//! never handles credentials. Contributor mode is turned off for every run.

use std::time::Duration;

use apex_core::{
    Access, ActionKind, AgentTool, Approver, ContextUse, Decision, PlanUsage, PlanWindow,
    Progress, ProgressSink, ProposedAction, Reply,
};
use apex_core::work_steps::StepStatus;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout};

use crate::owned_process::OwnedChild;
use crate::work_feed::MuseSteps;

/// How long the host may take to answer a setup request.
const SETUP_TIMEOUT: Duration = Duration::from_secs(30);

/// The environment variable that would make Muse bill per use.
pub(crate) const API_KEY_ENV: &str = "META_API_KEY";

/// What a turn needs besides the prompt.
pub(crate) struct Turn<'a> {
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub access: Access,
    pub cwd: Option<String>,
}

/// Why a turn did not produce a reply.
pub(crate) enum TurnError {
    /// The host could not be used at all. Nothing was asked of the model.
    Unavailable(String),
    /// The turn started and failed.
    Failed(String),
    CleanupIncomplete(String),
}

/// The host's command line. Sandbox posture is fixed for the host's life,
/// so access that must be enforced goes here: read-only turns get no file
/// writes and no shell at all, and only full access leaves the shell
/// unsandboxed. Session logs are off so Deck's one-turn sessions don't
/// fill the person's own Muse history; the thread keeps the transcript.
pub(crate) fn args(access: Access, model: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["serve", "--contributor-mode", "off", "--no-session-log"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    match access {
        // Muse's host has no mode that puts every edit to the person: file
        // writes are allowed outright and its own judge clears commands it
        // thinks harmless. So, as with Grok, "ask first" means "do not".
        Access::Read | Access::Ask => args.extend(["--disable-write".into(), "--disable-shell".into()]),
        Access::Edits => {}
        Access::Full => args.push("--disable-sandbox".into()),
    }
    if let Some(model) = model {
        args.extend(["--model".into(), model.into()]);
    }
    args
}

/// The session's approval mode, selected over the wire. `promptUnmatched`
/// lets Muse's judge clear harmless commands and asks Deck about the rest.
fn approval_mode(access: Access) -> &'static str {
    match access {
        Access::Read | Access::Ask => "denyUnmatched",
        Access::Edits => "promptUnmatched",
        Access::Full => "allowAll",
    }
}

/// A UUIDv7, which every MSP command needs as its idempotency handle.
fn command_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut random = [0u8; 10];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut random))
        .is_err()
    {
        use std::hash::{BuildHasher, Hasher};
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(millis);
        random[..8].copy_from_slice(&hasher.finish().to_le_bytes());
    }
    let mut bytes = [0u8; 16];
    bytes[..6].copy_from_slice(&millis.to_be_bytes()[2..]);
    bytes[6..].copy_from_slice(&random);
    bytes[6] = 0x70 | (bytes[6] & 0x0f);
    bytes[8] = 0x80 | (bytes[8] & 0x3f);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

fn request(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

pub(crate) fn session_start(turn: &Turn<'_>) -> Value {
    let mut params = json!({ "commandId": command_id(), "approvalMode": approval_mode(turn.access) });
    if let Some(cwd) = &turn.cwd {
        params["workspaceRoot"] = json!(cwd);
    }
    if let Some(model) = turn.model {
        params["modelId"] = json!(model);
    }
    request(2, "session/start", params)
}

pub(crate) fn turn_start(session: &str, prompt: &str, effort: Option<&str>, images: &[crate::attachments::Image]) -> Value {
    let mut input = vec![json!({ "type": "text", "text": prompt })];
    input.extend(images.iter().map(|image| json!({ "type": "image", "mediaType": image.mime, "base64Data": image.data })));
    let mut params = json!({ "commandId": command_id(), "sessionId": session, "input": input });
    if let Some(effort) = effort {
        params["reasoningEffort"] = json!(effort);
    }
    request(3, "turn/start", params)
}

/// What Muse asks permission for, as a card. `None` when the request is
/// not one a person can sensibly be shown.
pub(crate) fn proposal(params: &Value) -> Option<ProposedAction> {
    let subject = &params["subject"];
    let tool = params["toolName"].as_str().unwrap_or("a tool");
    let raw = params["rawArgs"].as_str().unwrap_or_default();
    let (kind, title, detail) = match subject["kind"].as_str()? {
        "shell" => (
            ActionKind::Command,
            "Run a command".to_string(),
            subject["command"].as_str().unwrap_or(raw).to_string(),
        ),
        "fileAccess" => {
            let path = subject["path"].as_str().unwrap_or("a file");
            let access = subject["access"].as_str().unwrap_or("use");
            (ActionKind::Edit, format!("{} {path}", capitalized(access)), raw.to_string())
        }
        "network" => {
            let host = subject["host"].as_str().or(subject["target"].as_str()).unwrap_or("the network");
            (ActionKind::Other, format!("Connect to {host}"), raw.to_string())
        }
        "tool" => (
            ActionKind::Tool,
            format!("Use {}", subject["toolName"].as_str().unwrap_or(tool)),
            raw.to_string(),
        ),
        other => (ActionKind::Other, format!("{tool} ({other})"), raw.to_string()),
    };
    Some(ProposedAction { kind, title, detail, expires_at: None, risky: false })
}

fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// The offered choice that carries out `decision`. Always allow is kept by
/// Deck's own per-thread list, so Muse is only ever told "this once" and
/// never writes a lasting rule of its own that Deck could not take back.
pub(crate) fn choice(params: &Value, decision: Decision) -> Option<String> {
    let choices = params["availableChoices"].as_array()?;
    let pick = |wanted: &str, once: bool| {
        choices
            .iter()
            .find(|c| c["decision"] == wanted && (!once || c["scope"] == "once"))
            .and_then(|c| c["choiceId"].as_str())
            .map(str::to_string)
    };
    if decision.approved() {
        pick("approved", true).or_else(|| pick("approved", false))
    } else {
        pick("denied", true).or_else(|| pick("denied", false)).or_else(|| pick("abort", false))
    }
}

pub(crate) fn decide(id: u64, params: &Value, choice: &str) -> Value {
    request(
        id,
        "approval/decide",
        json!({
            "approvalId": params["approvalId"],
            "choiceId": choice,
            "commandId": command_id(),
            "requirementId": params["currentRequirementId"],
            "sessionId": params["sessionId"],
        }),
    )
}

/// A plan reading from `usage/changed` or `usage/read`.
pub(crate) fn plan(usage: &Value) -> Option<PlanUsage> {
    let window = |name: &str, value: &Value, minutes: Option<u64>| {
        let used = value["usedPercent"].as_f64()?;
        Some(PlanWindow {
            name: name.to_string(),
            used_percent: used.round().clamp(0.0, 100.0) as u32,
            window_minutes: minutes,
            resets_at: value["resetsAtMs"].as_u64().map(|ms| ms / 1000),
        })
    };
    let windows: Vec<PlanWindow> = [
        window("five_hour", &usage["window"], usage["window"]["windowDurationMins"].as_u64()),
        window("weekly", &usage["weekly"], Some(7 * 24 * 60)),
    ]
    .into_iter()
    .flatten()
    .collect();
    (!windows.is_empty()).then_some(PlanUsage { provider: AgentTool::Muse, windows, partial: false, reset_credits: None })
}

/// The line shown while a tool runs, such as "Running ls -la".
pub(crate) fn activity(item: &Value) -> Option<String> {
    let tool = item["tool"].as_str()?;
    let args: Value = item["args"].as_str().and_then(|a| serde_json::from_str(a).ok()).unwrap_or(Value::Null);
    let path = args["path"].as_str().or(args["file_path"].as_str());
    let line = match (tool, path) {
        ("bash" | "shell", _) => match args["command"].as_str() {
            Some(command) => format!("Running {}", first_line(command)),
            None => "Running a command".to_string(),
        },
        ("write_file", Some(path)) => format!("Writing {path}"),
        ("edit_file", Some(path)) => format!("Editing {path}"),
        ("read_file", Some(path)) => format!("Reading {path}"),
        ("search", _) => match args["pattern"].as_str().or(args["query"].as_str()) {
            Some(pattern) => format!("Searching for {}", first_line(pattern)),
            None => "Searching".to_string(),
        },
        ("web_search", _) => "Searching the web".to_string(),
        ("web_fetch", _) => match args["url"].as_str() {
            Some(url) => format!("Reading {url}"),
            None => "Reading a web page".to_string(),
        },
        (tool, _) => format!("Using {tool}"),
    };
    Some(line)
}

fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() > 120 {
        format!("{}…", line.chars().take(120).collect::<String>())
    } else {
        line.to_string()
    }
}

async fn send(stdin: &mut ChildStdin, message: &Value) -> std::io::Result<()> {
    let mut line = message.to_string();
    line.push('\n');
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

/// Read until the answer to request `id` arrives, passing over anything
/// else; nothing before the turn starts needs handling.
async fn answer(lines: &mut Lines<BufReader<ChildStdout>>, id: u64, limit: Duration) -> Result<Value, String> {
    let wait = async {
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                    if message.get("method").is_some() || message["id"].as_u64() != Some(id) {
                        continue;
                    }
                    return match message.get("error") {
                        Some(error) => Err(error["message"].as_str().unwrap_or("request refused").to_string()),
                        None => Ok(message["result"].clone()),
                    };
                }
                Ok(None) => return Err("it stopped before answering".to_string()),
                Err(e) => return Err(format!("its output could not be read: {e}")),
            }
        }
    };
    tokio::time::timeout(limit, wait)
        .await
        .unwrap_or_else(|_| Err(format!("no answer within {} seconds", limit.as_secs())))
}

/// The reply as it builds up: one paragraph per agent message.
#[derive(Default)]
struct Writing {
    text: String,
    /// The agent message being written, and whether any of it streamed.
    current: Option<(String, bool)>,
}

impl Writing {
    fn start(&mut self, item: &str, on_progress: ProgressSink<'_>) {
        if !self.text.trim().is_empty() {
            self.text.push_str("\n\n");
            on_progress(Progress::Text("\n\n"));
        }
        self.current = Some((item.to_string(), false));
    }

    fn delta(&mut self, item: &str, delta: &str, on_progress: ProgressSink<'_>) {
        if let Some((current, streamed)) = &mut self.current {
            if current == item {
                *streamed = true;
                self.text.push_str(delta);
                on_progress(Progress::Text(delta));
            }
        }
    }

    /// A finished message whose text never streamed is added whole.
    fn complete(&mut self, item: &str, text: &str, on_progress: ProgressSink<'_>) {
        if let Some((current, streamed)) = self.current.take() {
            if current == item && !streamed && !text.is_empty() {
                self.text.push_str(text);
                on_progress(Progress::Text(text));
            }
        }
    }
}

/// Run one turn. `child` must have been started with `args` and all three
/// standard streams piped.
pub(crate) async fn run(
    mut child: OwnedChild,
    turn: Turn<'_>,
    prompt: &str,
    images: &[crate::attachments::Image],
    on_progress: ProgressSink<'_>,
    approver: &dyn Approver,
) -> Result<Reply, TurnError> {
    let mut stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");
    let mut lines = BufReader::new(stdout).lines();
    // Keep the host's log for the error message; draining it also stops a
    // chatty host from blocking on a full pipe.
    let log = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });
    let unavailable = |what: &str, why: String| TurnError::Unavailable(format!("{what}: {why}"));

    let hello = request(
        1,
        "initialize",
        json!({
            "clientInfo": { "name": "apex_deck", "title": "Apex Deck", "version": env!("CARGO_PKG_VERSION") },
            // Deck has no dialog for Muse's own questions, so the host
            // keeps them back instead of waiting on an answer.
            "capabilities": { "userInputDialogs": false },
        }),
    );
    let started = async {
        send(&mut stdin, &hello).await.map_err(|e| format!("could not start: {e}"))?;
        answer(&mut lines, 1, SETUP_TIMEOUT).await?;
        send(&mut stdin, &json!({ "jsonrpc": "2.0", "method": "initialized" }))
            .await
            .map_err(|e| format!("it went away: {e}"))?;
        send(&mut stdin, &session_start(&turn)).await.map_err(|e| format!("it went away: {e}"))?;
        answer(&mut lines, 2, SETUP_TIMEOUT).await
    }
    .await;
    let started = match started {
        Ok(started) => started,
        Err(why) => {
            let log = log.await.unwrap_or_default();
            let _ = child.terminate_tree().await;
            let why = crate::cli::failure_summary(&log, "").replace("no error output", &why);
            return Err(unavailable("Muse could not start a session", why));
        }
    };
    let Some(session) = started["session"]["sessionId"].as_str().map(str::to_string) else {
        return Err(unavailable("Muse could not start a session", "no session id in the answer".into()));
    };
    let window = started["session"]["modelId"].as_str().and_then(crate::catalog::muse_context_limit);

    // From here the model is being asked, so failures are final.
    send(&mut stdin, &turn_start(&session, prompt, turn.effort, images))
        .await
        .map_err(|e| TurnError::Failed(format!("could not send the message: {e}")))?;

    let mut writing = Writing::default();
    let mut input_tokens: Option<u64> = None;
    let mut output_tokens: Option<u64> = None;
    let mut next_id = 10u64;
    let mut failure: Option<String> = None;
    let mut checking = false;
    let mut steps = MuseSteps::new(turn.cwd.clone());
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => {
                for step in steps.finish(StepStatus::Failed) {
                    on_progress(Progress::Work(&step));
                }
                let log = log.await.unwrap_or_default();
                let _ = child.terminate_tree().await;
                return Err(TurnError::Failed(crate::cli::failure_summary(&log, "").replace("no error output", "Muse stopped before the turn finished")));
            }
            Err(e) => {
                for step in steps.finish(StepStatus::Failed) {
                    on_progress(Progress::Work(&step));
                }
                return Err(TurnError::Failed(format!("reading output failed: {e}")));
            }
        };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let method = message["method"].as_str().unwrap_or_default();
        let params = &message["params"];
        let item = &params["item"];
        match method {
            "approval/request" => {
                // The response only says the card is shown; the decision
                // travels as its own command.
                if let Some(id) = message.get("id") {
                    let _ = send(&mut stdin, &json!({ "jsonrpc": "2.0", "id": id, "result": {} })).await;
                }
                let decision = match proposal(params) {
                    // Helpers Muse started run under the same rules, so
                    // their requests are put to the person too.
                    Some(action) => {
                        on_progress(Progress::Activity(&format!("Waiting for approval: {}", action.title)));
                        approver.decide(action).await
                    }
                    None => Decision::Reject,
                };
                match choice(params, decision) {
                    Some(choice) => {
                        next_id += 1;
                        send(&mut stdin, &decide(next_id, params, &choice))
                            .await
                            .map_err(|_| TurnError::Failed("could not deliver the approval".into()))?;
                    }
                    None => eprintln!("[apex-deck] Muse approval had no matching choice: {params}"),
                }
            }
            // Withheld by `userInputDialogs: false`; answered as unable, so
            // a host that asks anyway is not left waiting.
            "userInput/request" => {
                if let Some(id) = message.get("id") {
                    let _ = send(&mut stdin, &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Apex Deck cannot show Muse's questions" } })).await;
                }
            }
            "item/started" if item["kind"] == "agentMessage" => {
                writing.start(item["itemId"].as_str().unwrap_or_default(), on_progress);
            }
            "item/started" if item["kind"] == "toolCall" => {
                if let Some(line) = activity(item) {
                    on_progress(Progress::Activity(&line));
                }
                for step in steps.notice("item/started", params) {
                    on_progress(Progress::Work(&step));
                }
            }
            "item/completed" if item["kind"] == "toolCall" => {
                for step in steps.notice("item/completed", params) {
                    on_progress(Progress::Work(&step));
                }
            }
            // Partial tool output: the final text comes from
            // `item/completed`, so this changes nothing visible.
            "item/updated" if item["kind"] == "toolCall" => {
                for step in steps.notice("item/updated", params) {
                    on_progress(Progress::Work(&step));
                }
            }
            "item/delta" if params["field"] == "output" => {
                for step in steps.notice("item/delta", params) {
                    on_progress(Progress::Work(&step));
                }
            }
            "session/todoListChanged" => {
                if let Some(items) = MuseSteps::todos(params) {
                    on_progress(Progress::Todo(&items));
                }
            }
            // Muse's own checks before it hands the reply in. Several run
            // side by side, so the line is shown once.
            "item/started" if item["kind"] == "reminderChild" && item["blocking"] == true && !checking => {
                checking = true;
                on_progress(Progress::Activity("Muse is checking its work"));
            }
            "item/delta" if params["field"] == "text" => {
                writing.delta(params["itemId"].as_str().unwrap_or_default(), params["delta"].as_str().unwrap_or_default(), on_progress);
            }
            "item/completed" if item["kind"] == "agentMessage" => {
                writing.complete(item["itemId"].as_str().unwrap_or_default(), item["text"].as_str().unwrap_or_default(), on_progress);
            }
            "session/tokenUsage" => {
                // Each model call reports its own counts; the turn's total
                // is their sum, as Deck counts for the other agents.
                let usage = &params["usage"];
                if let Some(n) = usage["inputTokens"].as_u64() {
                    input_tokens = Some(input_tokens.unwrap_or(0) + n);
                }
                if let Some(n) = usage["outputTokens"].as_u64() {
                    output_tokens = Some(output_tokens.unwrap_or(0) + n);
                }
                if let (Some(used), Some(window)) = (params["promptTokens"].as_u64(), window) {
                    on_progress(Progress::Context(ContextUse { used_tokens: used, window_tokens: window }));
                }
            }
            "session/contextUsage" => {
                if let (Some(used), Some(window)) = (params["usedTokens"].as_u64(), params["windowTokens"].as_u64().or(window)) {
                    on_progress(Progress::Context(ContextUse { used_tokens: used, window_tokens: window }));
                }
            }
            "usage/changed" => {
                if let Some(plan) = plan(params) {
                    crate::plan_cache::remember(&plan);
                    on_progress(Progress::Plan(&plan));
                }
            }
            "turn/completed" => {
                match params["terminal"].as_str() {
                    Some("completed") => {}
                    Some("cancelled") => failure = Some("the turn was cancelled".into()),
                    _ => {
                        let error = &params["error"];
                        let why = error["message"].as_str().or(params["reason"].as_str()).unwrap_or("the turn failed");
                        failure = Some(match error.get("quota") {
                            Some(_) => format!("{why} (your Muse plan's usage limit is reached; it resets on its own)"),
                            None => why.to_string(),
                        });
                    }
                }
                break;
            }
            _ => {
                // The answer to `turn/start`. Only a refusal matters.
                if message["id"].as_u64() == Some(3) {
                    if let Some(error) = message.get("error") {
                        failure = Some(error["message"].as_str().unwrap_or("the turn was refused").to_string());
                        break;
                    }
                }
            }
        }
    }

    // The turn is over, so no step may be left running.
    let end = match failure.as_deref() {
        None => StepStatus::Done,
        Some("the turn was cancelled") => StepStatus::Stopped,
        _ => StepStatus::Failed,
    };
    for step in steps.finish(end) {
        on_progress(Progress::Work(&step));
    }

    // Closing its input tells the host to exit; do not wait long for it.
    drop(stdin);
    if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    if let Err(error) = child.terminate_tree().await {
        return Err(TurnError::CleanupIncomplete(format!("worker cleanup failed: {error}")));
    }
    if let Some(why) = failure {
        return Err(TurnError::Failed(why));
    }
    Ok(Reply {
        text: writing.text.trim().to_string(),
        input_tokens,
        output_tokens,
        cost_micros: None,
        cost_estimated: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_ids_are_version_7_uuids() {
        let id = command_id();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "7");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"), "{id}");
        assert_ne!(id, command_id());
    }

    #[test]
    fn access_is_enforced_by_the_host_flags() {
        let read = args(Access::Read, None);
        assert_eq!(read, ["serve", "--contributor-mode", "off", "--no-session-log", "--disable-write", "--disable-shell"]);
        assert_eq!(args(Access::Ask, None), read, "nobody can be asked before each edit, so ask first is read only");
        assert_eq!(args(Access::Edits, Some("muse-spark-1.3")), ["serve", "--contributor-mode", "off", "--no-session-log", "--model", "muse-spark-1.3"]);
        assert!(args(Access::Full, None).contains(&"--disable-sandbox".to_string()));
        assert_eq!(approval_mode(Access::Ask), "denyUnmatched");
        assert_eq!(approval_mode(Access::Edits), "promptUnmatched");
        assert_eq!(approval_mode(Access::Full), "allowAll");
    }

    #[test]
    fn the_session_and_turn_carry_folder_model_effort_and_images() {
        let turn = Turn { model: Some("muse-wonder-1.0"), effort: Some("low"), access: Access::Edits, cwd: Some("/w".into()) };
        let start = session_start(&turn);
        assert_eq!(start["params"]["workspaceRoot"], "/w");
        assert_eq!(start["params"]["modelId"], "muse-wonder-1.0");
        assert_eq!(start["params"]["approvalMode"], "promptUnmatched");
        let image = crate::attachments::Image { path: "/x.png".into(), mime: "image/png", data: "AAAA".into() };
        let message = turn_start("s1", "hi", Some("low"), &[image]);
        assert_eq!(message["params"]["sessionId"], "s1");
        assert_eq!(message["params"]["reasoningEffort"], "low");
        assert_eq!(message["params"]["input"][0], json!({"type":"text","text":"hi"}));
        assert_eq!(message["params"]["input"][1], json!({"type":"image","mediaType":"image/png","base64Data":"AAAA"}));
    }

    fn shell_request() -> Value {
        json!({
            "approvalId": "a1", "sessionId": "s1", "toolName": "bash", "rawArgs": "{\"command\":\"rm -rf build\"}",
            "currentRequirementId": {"approvalId": "a1", "sourceIndex": 0},
            "subject": {"kind": "shell", "command": "rm -rf build"},
            "availableChoices": [
                {"choiceId": "allow_once", "decision": "approved", "scope": "once", "label": "Allow once"},
                {"choiceId": "allow_local_prefix", "decision": "approvedPolicyAmendment", "scope": "localPersistent", "label": "Always"},
                {"choiceId": "allow_session", "decision": "approved", "scope": "session", "label": "Session"},
                {"choiceId": "deny", "decision": "denied", "scope": "once", "label": "Deny"}
            ]
        })
    }

    #[test]
    fn a_shell_request_becomes_a_command_card() {
        let action = proposal(&shell_request()).unwrap();
        assert_eq!(action.kind, ActionKind::Command);
        assert_eq!(action.title, "Run a command");
        assert_eq!(action.detail, "rm -rf build");
    }

    #[test]
    fn decisions_pick_this_once_choices_and_never_a_lasting_muse_rule() {
        let params = shell_request();
        assert_eq!(choice(&params, Decision::Approve).as_deref(), Some("allow_once"));
        assert_eq!(choice(&params, Decision::ApproveAlways).as_deref(), Some("allow_once"));
        assert_eq!(choice(&params, Decision::Reject).as_deref(), Some("deny"));
        let decide = decide(11, &params, "allow_once");
        assert_eq!(decide["method"], "approval/decide");
        assert_eq!(decide["params"]["requirementId"], json!({"approvalId": "a1", "sourceIndex": 0}));
    }

    #[test]
    fn plan_usage_reads_both_windows() {
        let plan = plan(&json!({"window": {"usedPercent": 2, "windowDurationMins": 300, "resetsAtMs": 1791845454000u64}, "weekly": {"usedPercent": 0, "resetsAtMs": 1792368000000u64}})).unwrap();
        assert_eq!(plan.provider, AgentTool::Muse);
        assert_eq!(plan.windows[0], PlanWindow { name: "five_hour".into(), used_percent: 2, window_minutes: Some(300), resets_at: Some(1791845454) });
        assert_eq!(plan.windows[1].name, "weekly");
        assert!(super::plan(&json!({})).is_none());
    }

    #[test]
    fn tool_calls_are_described_in_plain_words() {
        let item = |tool: &str, args: Value| json!({"tool": tool, "args": args.to_string()});
        assert_eq!(activity(&item("bash", json!({"command": "ls -la\necho hi"}))).unwrap(), "Running ls -la");
        assert_eq!(activity(&item("write_file", json!({"path": "a.txt", "content": "hi"}))).unwrap(), "Writing a.txt");
        assert_eq!(activity(&item("subagent_spawn", json!({}))).unwrap(), "Using subagent_spawn");
    }

    // Recorded from Muse Code 1.4.10; see
    // tests/fixtures/work_steps/probe-notes-all-providers.md.
    const MUSE_FIXTURE: &str = include_str!("../tests/fixtures/work_steps/muse_turn.jsonl");

    use apex_core::work_steps::{StepKind, TodoStatus, WorkStep, STEPS_PER_REPLY_MAX};
    use std::collections::HashMap;

    /// Every `Work` step as last reported, in the order first seen, plus
    /// each to-do list, driven the way `run()` drives them.
    fn muse_feed() -> (Vec<WorkStep>, Vec<Vec<apex_core::work_steps::TodoItem>>) {
        let mut feed = MuseSteps::new(Some("/tmp/probe-all".into()));
        let mut order: Vec<String> = Vec::new();
        let mut by_key: HashMap<String, WorkStep> = HashMap::new();
        let mut lists = Vec::new();
        let mut todo_writes: Vec<String> = Vec::new();
        for line in MUSE_FIXTURE.lines() {
            let message: Value = serde_json::from_str(line).unwrap();
            let method = message["method"].as_str().unwrap_or("");
            let params = &message["params"];
            if method == "turn/completed" {
                for step in feed.finish(StepStatus::Done) {
                    if !by_key.contains_key(&step.key) {
                        order.push(step.key.clone());
                    }
                    by_key.insert(step.key.clone(), step);
                }
                continue;
            }
            if method == "session/todoListChanged" {
                lists.push(MuseSteps::todos(params).unwrap());
                continue;
            }
            if method == "item/started"
                && params["item"]["kind"] == "toolCall"
                && params["item"]["tool"] == "write_todos"
            {
                todo_writes.push(params["item"]["itemId"].as_str().unwrap().to_string());
            }
            for step in feed.notice(method, params) {
                if !by_key.contains_key(&step.key) {
                    order.push(step.key.clone());
                }
                by_key.insert(step.key.clone(), step);
            }
        }
        // The fixture's `write_todos` ids must never have become steps.
        for id in &todo_writes {
            assert!(!by_key.contains_key(id), "write_todos {id} became a step");
        }
        assert!(!todo_writes.is_empty(), "fixture has no write_todos to check");
        (order.into_iter().map(|k| by_key.remove(&k).unwrap()).collect(), lists)
    }

    fn muse_step<'a>(all: &'a [WorkStep], label: &str) -> &'a WorkStep {
        all.iter().find(|s| s.label == label).unwrap_or_else(|| panic!("no step {label}: {all:#?}"))
    }

    #[test]
    fn muse_feed_makes_steps() {
        let (all, lists) = muse_feed();
        for s in &all {
            assert!(matches!(s.status, StepStatus::Done | StepStatus::Failed), "{s:?}");
            assert!(s.label.chars().count() <= 120, "{s:?}");
        }

        let cat = muse_step(&all, "cat missing.txt");
        assert_eq!((cat.kind, cat.status, cat.exit_code), (StepKind::Command, StepStatus::Failed, Some(1)));
        assert_eq!(cat.output.as_deref(), Some("cat: missing.txt: No such file or directory\n"));

        // Overlapping calls keep their own outputs.
        let read = muse_step(&all, "Read a.txt");
        assert_eq!(read.status, StepStatus::Done);
        assert!(read.output.as_deref().unwrap().starts_with("Read text file"));
        let ls = muse_step(&all, "ls sub");
        assert_eq!(ls.output.as_deref(), Some("b.txt\n"));

        let search = muse_step(&all, "Search alpha");
        assert_eq!((search.kind, search.status), (StepKind::Search, StepStatus::Done));
        assert!(search.output.as_deref().unwrap().contains("alpha one"));

        let edit = muse_step(&all, "Edit a.txt");
        assert_eq!((edit.kind, edit.status), (StepKind::Edit, StepStatus::Done));
        assert!(edit.output.as_deref().unwrap().starts_with("edited"));

        let helper = all.iter().find(|s| s.kind == StepKind::Helper).expect("workflow helper step");
        assert_eq!(helper.status, StepStatus::Failed);
        assert_eq!(
            helper.output.as_deref(),
            Some("workflow_launch_unavailable: this client did not install a workflow launcher; no child work started")
        );

        assert_eq!(lists.len(), 3);
        assert_eq!(
            lists[0].iter().map(|t| (t.text.as_str(), t.status)).collect::<Vec<_>>(),
            [
                ("Read a.txt, ls sub, cat missing, search alpha, append probe", TodoStatus::InProgress),
                ("Start helper subagent to count lines in a.txt", TodoStatus::Pending),
            ]
        );
        // A cancelled step stays in the list, marked as called off.
        assert_eq!(
            lists[2].iter().map(|t| (t.text.as_str(), t.status)).collect::<Vec<_>>(),
            [
                ("Read a.txt, ls sub, cat missing, search alpha, append probe", TodoStatus::Completed),
                ("Start helper subagent to count lines in a.txt", TodoStatus::Cancelled),
            ]
        );
    }

    #[test]
    fn muse_partial_updates_change_nothing_visible() {
        let mut feed = MuseSteps::new(None);
        for line in MUSE_FIXTURE.lines() {
            let message: Value = serde_json::from_str(line).unwrap();
            let method = message["method"].as_str().unwrap_or("");
            if (method == "item/updated" || method == "item/delta") && message["params"]["item"]["kind"] == "toolCall" {
                assert!(feed.notice(method, &message["params"]).is_empty(), "{line}");
            } else {
                feed.notice(method, &message["params"]);
            }
        }
    }

    #[test]
    fn muse_finish_closes_open_steps() {
        let mut feed = MuseSteps::new(None);
        let started = feed.notice(
            "item/started",
            &json!({"item": {"itemId": "i1", "kind": "toolCall", "tool": "bash", "args": "{\"command\":\"sleep 60\"}"}}),
        );
        assert_eq!(started.len(), 1);
        let stopped = feed.finish(StepStatus::Stopped);
        assert_eq!(stopped.len(), 1);
        assert_eq!((stopped[0].key.as_str(), stopped[0].status), ("i1", StepStatus::Stopped));
        assert!(feed.finish(StepStatus::Stopped).is_empty());
    }

    #[test]
    fn muse_steps_stop_at_the_reply_cap() {
        let mut feed = MuseSteps::new(None);
        let mut emitted = 0;
        for n in 0..STEPS_PER_REPLY_MAX + 5 {
            emitted += feed
                .notice(
                    "item/started",
                    &json!({"item": {"itemId": format!("cap-{n}"), "kind": "toolCall", "tool": "bash", "args": "{\"command\":\"true\"}"}}),
                )
                .len();
        }
        assert_eq!(emitted, STEPS_PER_REPLY_MAX);
    }
}
