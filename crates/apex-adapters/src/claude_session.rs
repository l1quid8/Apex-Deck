//! One chat turn with Claude Code that asks before it acts.
//!
//! In its ordinary print mode Claude Code is given a prompt and left to
//! run: anything that would need permission is simply refused. To ask the
//! person instead, it is started with `--input-format stream-json` and
//! `--permission-prompt-tool stdio`, which make it a two-way conversation
//! over standard input and output, one JSON message per line:
//!
//! 1. We send the prompt as a `user` message.
//! 2. Claude Code prints the same events as its one-way event mode (see
//!    `events.rs`). When a tool needs permission it also prints a
//!    `control_request` of subtype `can_use_tool` and waits.
//! 3. We answer with a `control_response` that allows or denies it.
//! 4. A `result` event ends the turn. A retained room can then send its next
//!    message on the same pipes. Closing input ends the process.
//!
//! This is the protocol Anthropic's Agent SDK speaks to the same program.

use std::time::{Duration, Instant};

use apex_core::{
    Access, ActionKind, Answer, Approver, Decision, PlanAnswer, Progress, ProgressSink, ProposedAction,
    Question, QuestionOption,
};
use serde_json::{json, Value};
use futures::FutureExt;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use crate::owned_process::OwnedChild;

use crate::events::{EventReader, OutputFormat};
use crate::report;

pub(crate) fn user_message(prompt: &str) -> Value {
    json!({ "type": "user", "message": { "role": "user", "content": prompt } })
}

/// The answer to a permission request. An allowed tool must be given its
/// input back, which is where a client could change it; we pass it through.
pub(crate) fn permission_response(request_id: &Value, input: &Value, decision: Decision) -> Value {
    let response = match decision {
        Decision::Approve | Decision::ApproveAlways => {
            json!({ "behavior": "allow", "updatedInput": input })
        }
        Decision::Reject => {
            json!({ "behavior": "deny", "message": "The person reading the chat rejected this action." })
        }
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}

/// Claude's AskUserQuestion input, as questions for the person.
pub(crate) fn ask_user_questions(input: &Value) -> Vec<Question> {
    let text = |v: &Value| v.as_str().unwrap_or("").to_string();
    input["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|q| Question {
            header: text(&q["header"]),
            question: text(&q["question"]),
            options: q["options"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|o| QuestionOption {
                    label: text(&o["label"]),
                    description: text(&o["description"]),
                })
                .collect(),
            multi_select: q["multiSelect"].as_bool().unwrap_or(false),
        })
        .collect()
}

/// The answer to AskUserQuestion. Answered: allowed, with the answers added
/// to its input under each question's own text, several picks joined with
/// ", ". Skipped: denied with a message saying so.
pub(crate) fn question_response(request_id: &Value, input: &Value, answer: Answer) -> Value {
    let response = match answer {
        Answer::Answered(chosen) => {
            let mut answers = serde_json::Map::new();
            for (question, picked) in input["questions"]
                .as_array()
                .into_iter()
                .flatten()
                .zip(chosen)
            {
                if let Some(text) = question["question"].as_str() {
                    answers.insert(text.to_string(), json!(picked.join(", ")));
                }
            }
            let mut updated = if input.is_object() {
                input.clone()
            } else {
                json!({})
            };
            updated["answers"] = Value::Object(answers);
            json!({ "behavior": "allow", "updatedInput": updated })
        }
        Answer::Skipped => {
            json!({ "behavior": "deny", "message": "The person skipped this question." })
        }
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}

/// The answer to ExitPlanMode, Claude asking to start the work after
/// planning. Approved: allowed, and Claude's mode for the rest of the turn
/// goes back to what the bot's own access allows. Refused: Claude keeps
/// planning. A read-only bot can't start the work at all.
pub(crate) fn plan_exit_response(
    request_id: &Value,
    input: &Value,
    decision: Decision,
    own: Access,
    note: Option<&str>,
) -> Value {
    let mode = match own {
        Access::Full => Some("bypassPermissions"),
        Access::Edits => Some("acceptEdits"),
        Access::Ask => Some("default"),
        Access::Read => None,
    };
    let response = match (decision.approved(), mode) {
        (_, None) => {
            json!({ "behavior": "deny", "message": "This agent can only read, so it can't start the work. The person can hand your plan to another agent." })
        }
        (true, Some(mode)) => json!({
            "behavior": "allow",
            "updatedInput": match note {
                // Claude shows the model the edited plan, so the note rides there.
                Some(note) => {
                    let mut edited = input.clone();
                    edited["plan"] = json!(format!("{}\n\n{note}", input["plan"].as_str().unwrap_or("")));
                    edited
                }
                None => input.clone(),
            },
            "updatedPermissions": [{ "type": "setMode", "mode": mode, "destination": "session" }],
        }),
        (false, Some(_)) => {
            json!({ "behavior": "deny", "message": "The person wants to keep planning." })
        }
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}

/// How long a reply waits for helper agents still working in the
/// background before it is handed in without them.
pub(crate) const HELPER_LIMIT: Duration = Duration::from_secs(30 * 60);

/// How often the work line is refreshed while helpers work. It also keeps
/// the turn's silence limit from stopping a reply that is only waiting.
pub(crate) const HELPER_HEARTBEAT: Duration = Duration::from_secs(30);

/// The work line while a reply waits for its helpers.
pub(crate) fn helpers_line(helpers: usize, waited: Duration) -> String {
    let who = match helpers {
        0 => "Helpers finished, writing up".to_string(),
        1 => "1 helper still working".to_string(),
        n => format!("{n} helpers still working"),
    };
    match waited.as_secs() / 60 {
        0 => who,
        minutes => format!("{who} · {minutes} min"),
    }
}

async fn send(stdin: &mut ChildStdin, message: &Value) -> std::io::Result<()> {
    let mut line = message.to_string();
    line.push('\n');
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

/// A cold start is safe only when none of the user frame reached stdin.
#[derive(Debug)]
struct UnsentPrompt(std::io::Error);

impl std::fmt::Display for UnsentPrompt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for UnsentPrompt {}

pub(crate) fn definitely_unsent(error: &std::io::Error) -> bool {
    error.get_ref().is_some_and(|cause| cause.is::<UnsentPrompt>())
}

async fn send_prompt(stdin: &mut ChildStdin, message: &Value) -> std::io::Result<()> {
    let mut frame = message.to_string();
    frame.push('\n');
    let bytes = frame.as_bytes();
    let n = stdin.write(bytes).await
        .map_err(|err| std::io::Error::new(err.kind(), UnsentPrompt(err)))?;
    if n == 0 {
        let err = std::io::Error::new(std::io::ErrorKind::WriteZero, "Claude stdin closed");
        return Err(std::io::Error::new(err.kind(), UnsentPrompt(err)));
    }
    stdin.write_all(&bytes[n..]).await?;
    stdin.flush().await
}

/// What the turn produced, or why it did not finish. The error text is the
/// program's error output, for the caller to summarise.
pub(crate) struct Finished {
    pub reader: EventReader,
    pub success: bool,
    pub status: String,
    pub stderr: String,
    pub cleanup_error: Option<String>,
}

/// Run one turn. `child` must have been started with every standard
/// stream piped and the flags from `presets.rs` for ask-first access.
#[cfg(test)]
pub(crate) async fn run(
    child: OwnedChild,
    prompt: &str,
    cwd: Option<String>,
    on_progress: ProgressSink<'_>,
    approver: &dyn Approver,
    after_plan: Option<Access>,
) -> std::io::Result<Finished> {
    run_with_policy(child, prompt, cwd, on_progress, approver, after_plan, false).await
}

#[cfg(test)]
pub(crate) async fn run_with_policy(
    child: OwnedChild,
    prompt: &str,
    cwd: Option<String>,
    on_progress: ProgressSink<'_>,
    approver: &dyn Approver,
    after_plan: Option<Access>,
    tools_disabled: bool,
) -> std::io::Result<Finished> {
    run_with_images(child, prompt, cwd, on_progress, approver, after_plan, tools_disabled, &[]).await
}

// Eight parts of one turn. A struct would be assembled at every call site and
// taken apart again here, and the call sites read better as a flat list.
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub(crate) async fn run_with_images(
    child: OwnedChild,
    prompt: &str,
    cwd: Option<String>,
    on_progress: ProgressSink<'_>,
    approver: &dyn Approver,
    after_plan: Option<Access>,
    tools_disabled: bool,
    images: &[crate::attachments::Image],
) -> std::io::Result<Finished> {
    run_with_computer(child,prompt,cwd,on_progress,approver,after_plan,tools_disabled,images,false).await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_with_computer(
    child: OwnedChild, prompt: &str, cwd: Option<String>, on_progress: ProgressSink<'_>,
    approver: &dyn Approver, after_plan: Option<Access>, tools_disabled: bool,
    images: &[crate::attachments::Image], trusted_computer: bool,
) -> std::io::Result<Finished> {
    let mut process = ClaudeProcess::new(child);
    let (reader, gave_up) = process.drive(prompt, cwd, on_progress, approver, after_plan, tools_disabled, images, trusted_computer).await?;
    process.finish(reader, gave_up).await
}

/// The last request began between writing its input and seeing the result.
#[derive(Clone, Copy)]
struct CacheWindow {
    warm_until: Instant,
    cold_after: Instant,
}

#[derive(Default)]
struct CacheClock {
    hour: Option<CacheWindow>,
    five_minutes: Option<CacheWindow>,
    unknown_until: Option<Instant>,
}

impl CacheClock {
    const MARGIN: Duration = Duration::from_secs(30);

    fn record(&mut self, usage: &Value, start: Instant, seen: Instant) {
        let writes = &usage["cache_creation"];
        let (Some(hour), Some(five), Some(read)) = (
            writes["ephemeral_1h_input_tokens"].as_u64(),
            writes["ephemeral_5m_input_tokens"].as_u64(),
            usage["cache_read_input_tokens"].as_u64(),
        ) else {
            if self.unknown_until.is_none() {
                eprintln!("[apex-deck] Claude cache lifetime unknown");
            }
            self.unknown_until = Some(seen + Duration::from_secs(3600) + Self::MARGIN);
            return;
        };
        for (window, writes, ttl) in [
            (&mut self.hour, hour, Duration::from_secs(3600)),
            (&mut self.five_minutes, five, Duration::from_secs(300)),
        ] {
            if writes > 0 || (read > 0 && window.is_some()) {
                let warm = start + ttl;
                let cold = seen + ttl + Self::MARGIN;
                *window = Some(CacheWindow {
                    warm_until: window.map_or(warm, |w| w.warm_until.max(warm)),
                    cold_after: window.map_or(cold, |w| w.cold_after.max(cold)),
                });
            }
        }
    }

    fn remaining(&self, now: Instant) -> Option<Duration> {
        if self.unknown_until.is_some_and(|until| until > now) {
            return None;
        }
        [self.hour, self.five_minutes].into_iter().flatten()
            .map(|window| window.cold_after.saturating_duration_since(now)).max()
    }
}

/// Own the buffered pipes for the entire process. Each Deck reply gets a new
/// event reader and borrows the approver supplied for just that reply.
pub(crate) struct ClaudeProcess {
    child: OwnedChild,
    stdin: ChildStdin,
    lines: tokio::io::Lines<BufReader<ChildStdout>>,
    errors: tokio::task::JoinHandle<()>,
    stderr_tail: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    previous_cost_micros: Option<u64>,
    cache: CacheClock,
    spoiled: bool,
    retained: bool,
}

/// A dropped in-flight future must promptly kill the worker and also reap
/// its durable registry entry. The caller only receives a worker on success.
struct InFlight(Option<ClaudeProcess>);

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Some(mut process) = self.0.take() {
            process.terminate_now();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    if let Err(err) = process.close().await {
                        eprintln!("[apex-deck] Claude cancellation cleanup failed: {err}");
                    }
                });
            }
        }
    }
}

impl ClaudeProcess {
    pub(crate) fn new(mut child: OwnedChild) -> Self {
        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        let mut stderr = child.stderr.take().expect("stderr was piped");
        // Drain continuously, even while the room is idle. Keep a bounded
        // diagnostic tail so a long-lived process cannot exhaust host memory.
        let stderr_tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let tail = stderr_tail.clone();
        let errors = tokio::spawn(async move {
            let mut chunk = [0; 8192];
            while let Ok(n) = stderr.read(&mut chunk).await {
                if n == 0 { break; }
                let mut bytes = tail.lock().unwrap();
                let excess = (bytes.len() + n).saturating_sub(64 * 1024);
                bytes.drain(..excess);
                bytes.extend_from_slice(&chunk[..n]);
            }
        });
        Self { child, stdin, lines: BufReader::new(stdout).lines(), errors, stderr_tail, previous_cost_micros: Some(0), cache: CacheClock::default(), spoiled: false, retained: false }
    }

    pub(crate) fn is_alive(&mut self) -> bool {
        !self.spoiled && matches!(self.child.try_wait(), Ok(None))
            && self.lines.get_mut().fill_buf().now_or_never().is_none()
    }

    /// Install this turn's dynamic MCP server credentials before dispatching
    /// its prompt. On any failure the caller must discard the process. The
    /// error never includes a request, argument, or credential.
    pub(crate) async fn set_servers(&mut self, servers: &Value) -> std::io::Result<()> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static IDS: AtomicU64 = AtomicU64::new(1);
        let names = servers.as_object()
            .filter(|map| !map.is_empty())
            .ok_or_else(|| std::io::Error::other("Missing dynamic MCP server map"))?;
        let id = format!("apex-set-servers-{}", IDS.fetch_add(1, Ordering::Relaxed));
        tokio::time::timeout(Duration::from_secs(15), async {
            send(&mut self.stdin, &json!({
                "type": "control_request", "request_id": id,
                "request": { "subtype": "mcp_set_servers", "servers": servers }
            })).await?;
            while let Some(line) = self.lines.next_line().await? {
                let event: Value = serde_json::from_str(&line)
                    .map_err(|_| std::io::Error::other("Invalid response during MCP setup"))?;
                if event["type"] == "system" && (!self.retained || event["subtype"] != "init") {
                    continue;
                }
                let reply = &event["response"];
                let changed = &reply["response"];
                let installed = changed["added"].as_array().is_some_and(|added| {
                    names.keys().all(|name| added.iter().any(|value| value.as_str() == Some(name)))
                });
                if event["type"] == "control_response" && reply["request_id"] == id
                    && reply["subtype"] == "success" && installed
                    && changed["errors"].as_object().is_some_and(|errors| errors.is_empty())
                {
                    return Ok(());
                }
                return Err(std::io::Error::other("Claude could not install this turn's MCP servers"));
            }
            Err(std::io::Error::other("Claude closed during MCP setup"))
        }).await.map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "Claude MCP setup timed out"))?
    }

    pub(crate) fn terminate_now(&mut self) {
        self.child.signal_tree_kill();
    }

    pub(crate) fn cache_lifetime(&self) -> Option<Duration> {
        self.cache.remaining(Instant::now())
    }

    pub(crate) async fn close(mut self) -> Result<(), String> {
        drop(self.stdin);
        let waited = match tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await {
            Ok(status) => status,
            Err(_) => {
                let _ = self.child.start_kill();
                self.child.wait().await
            }
        };
        self.child.terminate_tree().await?;
        self.errors.abort();
        waited.map(|_| ()).map_err(|err| err.to_string())
    }

    /// Own the process while a turn is in flight. Cancelling this future
    /// drops its owned process group. Only a clean result returns an idle
    /// worker to the caller.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn run_retained(
        mut self, prompt: &str, cwd: Option<String>, on_progress: ProgressSink<'_>,
        approver: &dyn Approver, after_plan: Option<Access>, tools_disabled: bool,
        images: &[crate::attachments::Image], trusted_computer: bool,
    ) -> std::io::Result<(Finished, Option<Self>)> {
        self.retained = true;
        let mut in_flight = InFlight(Some(self));
        let (reader, gave_up) = match in_flight.0.as_mut().unwrap().drive(
            prompt, cwd, on_progress, approver, after_plan, tools_disabled, images, trusted_computer,
        ).await {
            Ok(turn) => turn,
            Err(err) => {
                in_flight.0.take().unwrap().close().await.map_err(std::io::Error::other)?;
                return Err(err);
            }
        };
        let mut process = in_flight.0.take().unwrap();
        let complete = reader.turn_over();
        // Exiting plan mode changes the process's permissions. A computer
        // server also holds credentials bound to the single host turn.
        if complete && !reader.failed() && !gave_up
            && !trusted_computer && process.is_alive()
        {
            process.stderr_tail.lock().unwrap().clear();
            let finished = Finished {
                reader, success: true, status: "completed".into(),
                stderr: String::new(), cleanup_error: None,
            };
            return Ok((finished, Some(process)));
        }

        let mut finished = process.finish(reader, gave_up).await?;
        if !complete && !gave_up && finished.success {
            finished.success = false;
            finished.status = "EOF before a Claude result".into();
        }
        Ok((finished, None))
    }

    #[allow(clippy::too_many_arguments)]
    async fn drive(
        &mut self, prompt: &str, cwd: Option<String>, on_progress: ProgressSink<'_>,
        approver: &dyn Approver, after_plan: Option<Access>, tools_disabled: bool,
        images: &[crate::attachments::Image], trusted_computer: bool,
    ) -> std::io::Result<(EventReader, bool)> {
        // A prompt larger than the pipe can hold would block here if the
        // program printed before reading it all; it reads its input first.
        let mut message = user_message(prompt);
        message["message"]["content"] = crate::attachments::claude_content(prompt, images);
        let mut last_request_start = Instant::now();
        send_prompt(&mut self.stdin, &message).await?;

        let mut reader = EventReader::new(OutputFormat::ClaudeStream, cwd);
        // Set once the reply is written but helper agents it started are still
        // working. Their results arrive as a follow-up turn, which only happens
        // while the program's input stays open.
        let mut waiting_since: Option<Instant> = None;
        let mut gave_up = false;
        loop {
            if reader.turn_over() {
                if reader.helpers() == 0 {
                    break;
                }
                let since = *waiting_since.get_or_insert_with(Instant::now);
                reader.await_follow_up();
                on_progress(Progress::Activity(&helpers_line(
                    reader.helpers(),
                    since.elapsed(),
                )));
            }
            let next = match waiting_since {
                None => self.lines.next_line().await?,
                Some(since) => {
                    if since.elapsed() >= HELPER_LIMIT {
                        gave_up = true;
                        break;
                    }
                    let wait = HELPER_HEARTBEAT.min(HELPER_LIMIT.saturating_sub(since.elapsed()));
                    match tokio::time::timeout(wait, self.lines.next_line()).await {
                        Ok(next) => next?,
                        Err(_) => {
                            on_progress(Progress::Activity(&helpers_line(
                                reader.helpers(),
                                since.elapsed(),
                            )));
                            continue;
                        }
                    }
                }
            };
            let Some(line) = next else { break };
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                if self.retained && message["type"] == "result" {
                    self.cache.record(&message["usage"], last_request_start, Instant::now());
                }
                if message["type"] == "user" && message["message"]["content"].as_array()
                    .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_result"))
                {
                    last_request_start = Instant::now();
                }
                if message["type"] == "system" && message["subtype"] == "compact_boundary" {
                    self.spoiled = true;
                }
                // A background shell can produce an unsolicited assistant reply
                // after this turn, even if a new room message has just arrived.
                if message["type"] == "system" && message["subtype"] == "background_tasks_changed"
                    && message["tasks"].as_array().is_some_and(|tasks| tasks.iter().any(|task|
                        !task["task_type"].as_str().is_some_and(|kind| kind.contains("agent"))))
                {
                    self.spoiled = true;
                }
                if message["type"] == "system" && message["subtype"] == "init" {
                    if tools_disabled && !trusted_computer && ["mcp_servers", "tools"].iter().any(|key| message[*key].as_array().is_some_and(|items| !items.is_empty())) {
                        self.child.terminate_tree().await.map_err(std::io::Error::other)?;
                        return Err(std::io::Error::other("Model-only Claude advertised native tools or MCP connections; turn refused"));
                    }
                    on_progress(Progress::ToolServers(&crate::mcp::claude_init_servers(&message)));
                }
                if message["type"] == "control_request" {
                    let request = &message["request"];
                    // Claude asks the person with AskUserQuestion in every access
                    // mode, Full included (probed 2026-10-06). The questions go
                    // out raw; the room cleans them for display, and the answers
                    // come back matched by position.
                    // A trusted computer call is the one exception to a tool-free turn.
                    let computer_call = trusted_computer && request["subtype"] == "can_use_tool"
                        && request["tool_name"].as_str().and_then(crate::mcp::claude_tool).is_some_and(|(server, _)| server == crate::computer::SERVER);
                    let reply = if tools_disabled && !computer_call && request["subtype"] == "can_use_tool" {
                        json!({ "type": "control_response", "response": { "subtype": "success", "request_id": message["request_id"], "response": { "behavior": "deny", "message": "This turn is configured without tools." } } })
                    } else if tools_disabled && !computer_call {
                        json!({ "type": "control_response", "response": { "subtype": "error", "request_id": message["request_id"], "error": "This turn is configured without tools or control requests." } })
                    } else if request["subtype"] == "can_use_tool"
                        && request["tool_name"] == "AskUserQuestion"
                    {
                        on_progress(Progress::Activity("Waiting for your answer"));
                        let answer = approver.ask(ask_user_questions(&request["input"])).await;
                        question_response(&message["request_id"], &request["input"], answer)
                    } else if let (true, Some(own)) = (
                        request["subtype"] == "can_use_tool" && request["tool_name"] == "ExitPlanMode",
                        after_plan,
                    ) {
                        // Started by the Plan switch: Claude has a plan and asks
                        // to start the work. A read-only bot is refused unasked.
                        let answer = if own == Access::Read {
                            PlanAnswer { decision: Decision::Reject, note: None }
                        } else {
                            let plan = request["input"]["plan"].as_str().unwrap_or("").to_string();
                            on_progress(Progress::Activity("Waiting for you: start the work?"));
                            approver
                                .decide_plan(ProposedAction {
                                    kind: ActionKind::Plan,
                                    title: "Start the work?".into(),
                                    detail: plan,
                                    expires_at: None,
                                    risky: false,
                                })
                                .await
                        };
                        self.spoiled |= answer.decision.approved() && own != Access::Read;
                        plan_exit_response(&message["request_id"], &request["input"], answer.decision, own, answer.note.as_deref())
                    } else if request["subtype"] == "can_use_tool" {
                        let tool = request["tool_name"].as_str().unwrap_or("a tool");
                        let action = reader.claude_action(tool, &request["input"]);
                        let decision = match crate::mcp::claude_tool(tool) {
                            Some(("apex-computer", _)) if trusted_computer => Decision::Approve,
                            Some((_, name)) if !crate::mcp::needs_approval(name) => Decision::Approve,
                            _ => {
                                on_progress(Progress::Activity(&format!(
                                    "Waiting for approval: {}",
                                    action.title
                                )));
                                approver.decide(action).await
                            }
                        };
                        self.spoiled |= decision == Decision::ApproveAlways;
                        permission_response(&message["request_id"], &request["input"], decision)
                    } else {
                        // Something else it wants from its host. Say so plainly
                        // rather than leave it waiting.
                        json!({ "type": "control_response", "response": {
                            "subtype": "error", "request_id": message["request_id"], "error": "Apex Deck does not support this request"
                        } })
                    };
                    send(&mut self.stdin, &reply).await?;
                    continue;
                }
            }
            report(reader.push(&format!("{line}\n")), on_progress);
        }
        report(reader.finish(), on_progress);
        if gave_up {
            reader.add_note("(Helpers were still working after 30 minutes, so this reply was handed in without them.)");
        }

        reader.settle_claude_cost(&mut self.previous_cost_micros);
        Ok((reader, gave_up))
    }

    async fn finish(mut self, reader: EventReader, gave_up: bool) -> std::io::Result<Finished> {
        // With its input closed and the turn over, the program exits by itself.
        // Shutting down MCP servers, hooks or background shells can hold it
        // past the grace period; a turn that already ended is still a reply.
        drop(self.stdin);
        let (status, killed) = match tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await {
            Ok(status) => (status?, false),
            Err(_) => {
                let _ = self.child.kill().await;
                (self.child.wait().await?, true)
            }
        };
        let cleanup = self.child.terminate_tree().await.err();
        let _ = self.errors.await;
        let stderr = String::from_utf8_lossy(&self.stderr_tail.lock().unwrap()).into_owned();
        Ok(Finished {
            success: cleanup.is_none() && (status.success() || (killed && (reader.turn_over() || gave_up))),
            status: status.to_string(),
            stderr,
            cleanup_error: cleanup,
            reader,
        })
    }
}

/// Names of Claude's connected MCP servers and enabled plugins, without
/// running a turn. A plugin listing that fails leaves just the servers.
pub async fn list_servers(
    cwd: Option<String>,
    path: Option<String>,
) -> Result<Vec<apex_core::server_request::ToolServer>, String> {
    #[cfg(unix)]
    if crate::linux_jail::should_jail(apex_core::Access::Read) {
        let bwrap = crate::gateway_sandbox::find_bwrap(path.as_deref());
        match crate::linux_jail::state(bwrap.as_deref()) {
            crate::linux_jail::JailState::Fails(reason) => {
                return Err(format!("Couldn't list Claude tool servers: {reason}"));
            }
            crate::linux_jail::JailState::Works => {}
        }
        let _bwrap = bwrap.ok_or_else(|| {
            format!("Couldn't list Claude tool servers: {}: it isn't installed", crate::linux_jail::probe::NEEDS_ADMIN)
        })?;
        #[cfg(target_os = "linux")]
        {
            let cwd_path = cwd.as_deref().map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
            let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
            let data_dir = home.join(".local/share/apex-deck");
            let path_os = path.as_ref().map(std::ffi::OsString::from).unwrap_or_else(|| std::env::var_os("PATH").unwrap_or_default());
            let program = crate::executable::program("claude", path.as_deref());
            let backend = apex_core::Backend::Agent { tool: apex_core::AgentTool::ClaudeCode, model: None };

            let run_jailed = |args: &[&str]| {
                let spec = crate::linux_jail::build_spec(
                    std::path::Path::new(&program),
                    &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                    &cwd_path,
                    apex_core::Access::Read,
                    Some(&backend),
                    &home,
                    &data_dir,
                    "discovery",
                    "claude",
                    &path_os,
                    &[],
                    &[],
                    &[],
                );
                let bwrap = _bwrap.clone();
                async move {
                    let spec = spec.map_err(|e| format!("Couldn't list Claude tool servers: {e}"))?;
                    let registry = crate::owned_process::Registry::default();
                    let mut jailed = crate::linux_jail::launch::jailed_command(&spec, &bwrap)
                        .map_err(|e| format!("Couldn't list Claude tool servers: {e}"))?;
                    jailed.command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
                    let (mut child, control) = jailed.spawn(&registry)
                        .map_err(|e| format!("Couldn't list Claude tool servers: {e}"))?;
                    let net = std::sync::Arc::new(crate::linux_jail::proxy::Internet::default());
                    let purposes = std::sync::Arc::new(crate::linux_jail::DaemonPurposes::new(net));
                    tokio::spawn(crate::linux_jail::channel::serve(control, purposes));
                    let mut stdout = child.stdout.take().unwrap();
                    let mut stderr = child.stderr.take().unwrap();
                    let mut out = Vec::new();
                    let mut err = Vec::new();
                    let (status, _, _) = tokio::join!(
                        child.wait(),
                        tokio::io::AsyncReadExt::read_to_end(&mut stdout, &mut out),
                        tokio::io::AsyncReadExt::read_to_end(&mut stderr, &mut err),
                    );
                    let status = status.map_err(|e| format!("Couldn't list Claude tool servers: {e}"))?;
                    Ok::<std::process::Output, String>(std::process::Output { status, stdout: out, stderr: err })
                }
            };

            let (servers, plugins) = tokio::join!(
                run_jailed(&["mcp", "list"]),
                tokio::time::timeout(Duration::from_secs(15), run_jailed(&["plugin", "list", "--json"]))
            );
            let output = servers.map_err(|e| format!("Couldn't list Claude tool servers: {e}"))?;
            if !output.status.success() {
                return Err("Couldn't list Claude tool servers".into());
            }
            let mut entries: Vec<apex_core::server_request::ToolServer> =
                crate::mcp::claude_connected(&String::from_utf8_lossy(&output.stdout))
                    .into_iter()
                    .map(Into::into)
                    .collect();
            let plugins = plugins.ok().and_then(Result::ok).filter(|o| o.status.success()).map(|o| {
                crate::mcp::claude_plugins(&String::from_utf8_lossy(&o.stdout), cwd.as_deref())
            });
            for name in plugins.unwrap_or_default() {
                let entry = apex_core::server_request::ToolServer::from(name);
                if !entries.iter().any(|known| known.token == entry.token) {
                    entries.push(entry);
                }
            }
            return Ok(entries);
        }
        #[cfg(not(target_os = "linux"))]
        return Err("Couldn't list Claude tool servers: Linux agent jail is only available on Linux".into());
    }
    let claude = |args: &[&str]| {
        let mut command = tokio::process::Command::new(crate::executable::program("claude", path.as_deref()));
        if let Some(path) = &path {
            command.env("PATH", path);
        }
        command
            .args(args)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        if let Some(cwd) = &cwd {
            command.current_dir(cwd);
        }
        command
    };
    let (servers, plugins) = tokio::join!(
        claude(&["mcp", "list"]).output(),
        tokio::time::timeout(Duration::from_secs(15), claude(&["plugin", "list", "--json"]).output())
    );
    let output = servers.map_err(|e| format!("Couldn't list Claude tool servers: {e}"))?;
    if !output.status.success() {
        return Err("Couldn't list Claude tool servers".into());
    }
    let mut entries: Vec<apex_core::server_request::ToolServer> =
        crate::mcp::claude_connected(&String::from_utf8_lossy(&output.stdout))
            .into_iter()
            .map(Into::into)
            .collect();
    let plugins = plugins.ok().and_then(Result::ok).filter(|o| o.status.success()).map(|o| {
        crate::mcp::claude_plugins(&String::from_utf8_lossy(&o.stdout), cwd.as_deref())
    });
    for name in plugins.unwrap_or_default() {
        let entry = apex_core::server_request::ToolServer::from(name);
        if !entries.iter().any(|known| known.token == entry.token) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_exit_allow_carries_the_note_as_probed() {
        let input = json!({"plan": "1. A\n2. B", "other": 1});
        let r = plan_exit_response(&json!("p1"), &input, Decision::Approve, Access::Full, Some("Do NOT do step 2"))["response"]["response"].clone();
        assert_eq!(r["behavior"], "allow");
        assert_eq!(r["updatedInput"]["plan"], "1. A\n2. B\n\nDo NOT do step 2");
        assert_eq!(r["updatedInput"]["other"], 1);
    }

    #[test]
    fn plan_exit_without_note_is_unchanged() {
        let input = json!({"plan": "1. A"});
        let r = plan_exit_response(&json!("p1"), &input, Decision::Approve, Access::Edits, None)["response"]["response"].clone();
        assert_eq!(r["updatedInput"], input);
    }

    #[test]
    fn starting_the_work_hands_back_the_bots_own_access() {
        let input = json!({"plan": "1. Do it"});
        let response = |decision, own| {
            plan_exit_response(&json!("p1"), &input, decision, own, None)["response"]["response"].clone()
        };
        let mode = |own| response(Decision::Approve, own)["updatedPermissions"][0]["mode"].clone();
        assert_eq!(
            response(Decision::Approve, Access::Full)["behavior"],
            "allow"
        );
        assert_eq!(
            response(Decision::Approve, Access::Full)["updatedInput"],
            input
        );
        assert_eq!(
            response(Decision::Approve, Access::Full)["updatedPermissions"][0],
            json!({"type": "setMode", "mode": "bypassPermissions", "destination": "session"})
        );
        assert_eq!(mode(Access::Edits), "acceptEdits");
        assert_eq!(mode(Access::Ask), "default");
        assert_eq!(
            response(Decision::Reject, Access::Full),
            json!({"behavior": "deny", "message": "The person wants to keep planning."})
        );
        assert_eq!(
            response(Decision::Approve, Access::Read)["behavior"],
            "deny",
            "a read-only bot never starts the work"
        );
    }

    #[test]
    fn answers_go_back_under_each_questions_own_text() {
        use apex_core::Answer;
        let input = json!({"questions": [
            {"question": "Which colour?", "header": "Colour", "options": [{"label": "red", "description": "warm"}, {"label": "blue"}], "multiSelect": false},
            {"question": "Which fruit?", "header": "Fruit", "options": [{"label": "apple"}, {"label": "pear"}], "multiSelect": true}
        ]});
        let asked = ask_user_questions(&input);
        assert_eq!(asked.len(), 2);
        assert_eq!(asked[0].options[0].description, "warm");
        assert!(asked[1].multi_select);

        let reply = question_response(
            &json!("r1"),
            &input,
            Answer::Answered(vec![
                vec!["blue".into()],
                vec!["apple".into(), "pear".into()],
            ]),
        );
        let response = &reply["response"]["response"];
        assert_eq!(response["behavior"], "allow");
        assert_eq!(
            response["updatedInput"]["answers"],
            json!({"Which colour?": "blue", "Which fruit?": "apple, pear"})
        );
        assert_eq!(
            response["updatedInput"]["questions"], input["questions"],
            "the input goes back as it came"
        );

        let skipped = question_response(&json!("r2"), &input, Answer::Skipped);
        assert_eq!(
            skipped["response"]["response"],
            json!({"behavior": "deny", "message": "The person skipped this question."})
        );
    }

    #[test]
    fn an_approval_returns_the_tools_input_and_a_refusal_says_why() {
        let input = json!({ "file_path": "a.txt", "content": "hi" });
        assert_eq!(
            permission_response(&json!("r1"), &input, Decision::Approve),
            json!({ "type": "control_response", "response": {
                "subtype": "success", "request_id": "r1", "response": { "behavior": "allow", "updatedInput": input }
            } })
        );
        let denied = permission_response(&json!("r2"), &input, Decision::Reject);
        assert_eq!(denied["response"]["response"]["behavior"], "deny");
        assert!(denied["response"]["response"]["message"]
            .as_str()
            .unwrap()
            .contains("rejected"));
    }

    #[test]
    fn the_helper_line_counts_helpers_and_minutes() {
        assert_eq!(
            helpers_line(2, Duration::from_secs(10)),
            "2 helpers still working"
        );
        assert_eq!(
            helpers_line(1, Duration::from_secs(190)),
            "1 helper still working · 3 min"
        );
        assert_eq!(
            helpers_line(0, Duration::from_secs(0)),
            "Helpers finished, writing up"
        );
    }

    #[cfg(unix)]
    fn fake_process(script: &str) -> ClaudeProcess {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let child = crate::owned_process::Registry::default().spawn(&mut command).unwrap();
        ClaudeProcess::new(child)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retained_turns_use_the_current_approver_and_separate_text_tokens_and_cost() {
        struct Allow;
        #[async_trait::async_trait]
        impl Approver for Allow {
            async fn decide(&self, _: ProposedAction) -> Decision { Decision::Approve }
        }

        let process = fake_process(r#"set -e
for turn in first second; do
    read -r prompt
    case "$prompt" in *"$turn"*) ;; *) exit 1 ;; esac
    echo '{"type":"control_request","request_id":"test","request":{"subtype":"can_use_tool","tool_name":"Write","input":{}}}'
    read -r answer
    case "$turn/$answer" in first/*allow*|second/*deny*) ;; *) exit 2 ;; esac
    if [ "$turn" = first ]; then
        echo '{"type":"result","result":"one","total_cost_usd":0.01,"usage":{"output_tokens":10,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":200,"ephemeral_5m_input_tokens":0}}}'
    else
        echo '{"type":"result","result":"two","total_cost_usd":0.013,"usage":{"output_tokens":3,"cache_read_input_tokens":200,"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":200}}}'
    fi
done
cat >/dev/null"#);
        let (finished, next) = process.run_retained(
            "first", None, &|_| {}, &Allow, None, false, &[], false,
        ).await.unwrap();
        assert!(finished.success);
        let first = finished.reader.outcome();
        assert_eq!((first.text.as_str(), first.cost_micros, first.output_tokens),
            ("one", Some(10_000), Some(10)));
        let process = next.unwrap();
        assert!(process.cache_lifetime().unwrap() > Duration::from_secs(3600));
        let (finished, next) = process.run_retained(
            "second", None, &|_| {}, &apex_core::NoApprover, None, false, &[], false,
        ).await.unwrap();
        assert!(finished.success);
        let second = finished.reader.outcome();
        assert_eq!((second.text.as_str(), second.cost_micros, second.output_tokens),
            ("two", Some(3_000), Some(3)));
        let process = next.unwrap();
        assert!(process.cache_lifetime().unwrap() > Duration::from_secs(3600));
        process.close().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn eof_before_result_discards_the_worker_and_reports_failure() {
        let process = fake_process(r#"read -r prompt
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Partial"}]}}'
echo 'unavailable' >&2"#);
        let (finished, next) = process.run_retained(
            "go", None, &|_| {}, &apex_core::NoApprover, None, false, &[], false,
        ).await.unwrap();
        assert!(next.is_none());
        assert!(!finished.success);
        assert!(finished.stderr.contains("unavailable"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn elevated_permissions_or_compaction_retire_a_finished_worker() {
        struct Always;
        #[async_trait::async_trait]
        impl Approver for Always {
            async fn decide(&self, _: ProposedAction) -> Decision { Decision::ApproveAlways }
        }

        for (event, plan) in [
            (json!({"type":"control_request","request_id":"a","request":{
                "subtype":"can_use_tool","tool_name":"Write","input":{}}}), None),
            (json!({"type":"control_request","request_id":"p","request":{
                "subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"work"}}}), Some(Access::Ask)),
            (json!({"type":"system","subtype":"compact_boundary"}), None),
        ] {
            let control = if event["type"] == "control_request" { "read -r answer" } else { "" };
            let script = format!("read -r prompt\necho '{event}'\n{control}\necho '{{\"type\":\"result\",\"result\":\"done\"}}'\ncat >/dev/null");
            let (finished, next) = fake_process(&script).run_retained(
                "go", None, &|_| {}, &Always, plan, false, &[], false,
            ).await.unwrap();
            assert!(finished.success);
            assert!(next.is_none(), "worker reused after {event}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn idle_output_invalidates_worker_before_next_user_message() {
        let process = fake_process(r#"read -r prompt
echo '{"type":"result","result":"one"}'
sleep 0.1
echo '{"type":"system","subtype":"init"}'
cat >/dev/null"#);
        let (_, next) = process.run_retained(
            "one", None, &|_| {}, &apex_core::NoApprover, None, false, &[], false,
        ).await.unwrap();
        if let Some(mut process) = next {
            tokio::time::timeout(Duration::from_secs(2), async {
                while process.is_alive() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.expect("unsolicited output left the worker eligible for reuse");
            process.close().await.unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_reaps_a_waiting_worker() {
        let process = fake_process("read -r prompt; exec sleep 60");
        let pid = process.child.id().unwrap() as i32;
        let turn = process.run_retained(
            "go", None, &|_| {}, &apex_core::NoApprover, None, false, &[], false,
        );
        assert!(tokio::time::timeout(Duration::from_millis(30), turn).await.is_err());
        tokio::time::timeout(Duration::from_secs(3), async {
            // Signal zero checks existence without signalling the process.
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("cancelled Claude worker remained alive");
    }

    #[test]
    fn mixed_cache_writes_reads_and_missing_fields_preserve_independent_deadlines() {
        let mut clock = CacheClock::default();
        let t = Instant::now();
        let seconds = Duration::from_secs;
        let usage = |hour, five, read| json!({"cache_creation":{
            "ephemeral_1h_input_tokens":hour, "ephemeral_5m_input_tokens":five},
            "cache_read_input_tokens":read});
        clock.record(&usage(100, 0, 0), t, t + seconds(90));
        assert_eq!(clock.hour.unwrap().warm_until, t + seconds(3600));
        assert_eq!(clock.hour.unwrap().cold_after, t + seconds(3720));
        clock.record(&usage(0, 90, 0), t + seconds(600), t + seconds(601));
        assert_eq!(clock.hour.unwrap().cold_after, t + seconds(3720));
        assert_eq!(clock.five_minutes.unwrap().cold_after, t + seconds(931));
        clock.record(&usage(0, 0, 200), t + seconds(700), t + seconds(701));
        assert_eq!(clock.hour.unwrap().cold_after, t + seconds(4331));
        assert_eq!(clock.five_minutes.unwrap().cold_after, t + seconds(1031));
        clock.record(&json!({}), t + seconds(800), t + seconds(801));
        clock.record(&usage(100, 0, 0), t + seconds(900), t + seconds(901));
        assert_eq!(clock.remaining(t + seconds(4430)), None);
        assert_eq!(clock.remaining(t + seconds(4431)), Some(seconds(100)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mcp_setup_requires_this_requests_acknowledgement_before_the_user_prompt() {
        let script = r#"IFS= read -r setup
case "$setup" in *mcp_set_servers*) ;; *) exit 1 ;; esac
id=$(echo "$setup" | sed 's/.*"request_id":"\([^"]*\)".*/\1/')
echo "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"$id\",\"response\":{\"added\":[\"apex-test\"],\"errors\":{}}}}"
IFS= read -r prompt
case "$prompt" in *first*) ;; *) exit 1 ;; esac
echo '{"type":"result","result":"done"}'
cat >/dev/null"#;
        let servers = json!({"apex-test":{"type":"stdio","command":"fixture"}});
        let mut process = fake_process(script);
        process.set_servers(&servers).await.unwrap();
        let (done, next) = process.run_retained(
            "first", None, &|_| {}, &apex_core::NoApprover, None, false, &[], false,
        ).await.unwrap();
        assert!(done.success);
        next.unwrap().close().await.unwrap();

        let mut process = fake_process(&script.replace(r#"$id"#, "wrong"));
        assert!(process.set_servers(&servers).await.is_err());
        process.terminate_now();
        process.close().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn only_a_definitely_unsent_user_message_is_safe_to_retry() {
        let mut process = fake_process("exit 1");
        process.child.wait().await.unwrap();
        let error = match process.run_retained(
            "first", None, &|_| {}, &apex_core::NoApprover, None, false, &[], false,
        ).await {
            Err(error) => error,
            Ok(_) => panic!("dead process accepted a user frame"),
        };
        assert!(definitely_unsent(&error));

        let process = fake_process("read -r prompt; exit 1");
        let (done, next) = process.run_retained(
            "first", None, &|_| {}, &apex_core::NoApprover, None, false, &[], false,
        ).await.unwrap();
        assert!(!done.success);
        assert!(next.is_none());
    }

    /// A stand-in for Claude Code: the first turn starts a helper and ends,
    /// then, while its input stays open, the helper finishes and a
    /// follow-up turn passes on what it found.
    #[tokio::test]
    async fn a_reply_waits_for_its_helpers_and_adds_what_they_found() {
        let script = r#"read -r prompt
echo '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a1","task_type":"local_agent"},{"task_id":"b1","task_type":"local_bash"}]}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Helpers launched."}]},"parent_tool_use_id":null}'
echo '{"type":"result","is_error":false,"result":"Helpers launched."}'
sleep 1
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"PINEAPPLE"}]},"parent_tool_use_id":"toolu_1"}'
echo '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1","task_type":"local_bash"}]}'
echo '{"type":"system","subtype":"init"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"The helper found PINEAPPLE."}]},"parent_tool_use_id":null}'
echo '{"type":"result","is_error":false,"result":"The helper found PINEAPPLE."}'
cat > /dev/null"#;
        let mut command = tokio::process::Command::new("sh");
        command
            .args(["-c", script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let child = crate::owned_process::Registry::default().spawn(&mut command).unwrap();
        let activity = std::sync::Mutex::new(Vec::<String>::new());
        let sink = |p: Progress<'_>| {
            if let Progress::Activity(a) = p {
                activity.lock().unwrap().push(a.to_string())
            }
        };
        let finished = run(child, "go", None, &sink, &apex_core::NoApprover, None)
            .await
            .unwrap();
        assert!(finished.success);
        assert_eq!(
            finished.reader.outcome().text,
            "Helpers launched.\n\nThe helper found PINEAPPLE."
        );
        assert!(
            activity
                .lock()
                .unwrap()
                .iter()
                .any(|a| a == "1 helper still working"),
            "a background shell is not a helper: {:?}",
            activity.lock().unwrap()
        );
    }

    #[test]
    fn the_prompt_is_sent_as_a_user_message() {
        assert_eq!(
            user_message("hello"),
            json!({ "type": "user", "message": { "role": "user", "content": "hello" } })
        );
    }
}
