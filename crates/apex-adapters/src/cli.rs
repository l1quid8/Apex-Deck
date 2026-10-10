use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use apex_core::{Access, 
    render_prompt, AgentTool, Approver, Backend, Decision, DeltaSink, NoApprover, Participant,
    ParticipantConfig, ParticipantError, Progress, ProgressSink, ProposedAction, Reply, TurnRequest,
};
use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::ansi::AnsiStripper;
use crate::events::{self, EventReader, OutputFormat};
use crate::grok_images;
use crate::codex_server::{self, TurnError};
use crate::presets::{agent_command_with, clean_effort, clean_model, output_format};
use crate::codex_hook;
use crate::{claude_session, report, BuildContext, Utf8Chunks};
use crate::owned_process::{OwnedChild, Registry};

/// How long a turn may go without any sign of life before the tool is
/// killed. Every update the tool sends restarts the clock, so long turns
/// that keep working are never cut off; the person can still press Stop.
const TURN_TIMEOUT: Duration = Duration::from_secs(900);

fn effective_turn_config(config: &ParticipantConfig, effort: Option<&str>) -> ParticipantConfig {
    let mut effective = config.clone();
    if config.auto_effort && matches!(config.backend, Backend::Agent { tool: AgentTool::ClaudeCode, .. }) && !apex_core::decision::supports_auto(config) {
        effective.effort = None;
    } else if apex_core::decision::supports_auto(config) {
        if let Some(effort) = effort.filter(|level| ["low", "medium", "high"].contains(level)) { effective.effort = Some(effort.into()); }
    }
    effective
}

/// A participant backed by a command-line tool.
///
/// Each turn starts the program fresh, writes the whole prompt to its
/// standard input and closes it. For a custom command, everything the
/// program prints to standard output is the reply. The coding agents Apex
/// Deck knows are run in their event modes instead, so the reply arrives as
/// it is written, along with what the agent is doing and what it used; see
/// `events.rs`.
pub struct CliParticipant {
    config: ParticipantConfig,
    timeout: Duration,
    cwd: Option<PathBuf>,
    path: Option<String>,
    codex_hook: Option<PathBuf>,
    temp: Option<PathBuf>,
    /// While the thread's Plan switch is on: the bot's own access, which a
    /// planning Claude gets back when the person agrees to start the work.
    plan: Option<Access>,
    /// Disable every tool for a text-only monitor turn.
    tools_disabled: bool,
    processes: Registry,
    cargo_target_dir: Option<PathBuf>,
}

impl CliParticipant {
    pub fn new(config: ParticipantConfig) -> Self {
        Self { config, timeout: TURN_TIMEOUT, cwd: None, path: None, codex_hook: None, temp: None, plan: None, tools_disabled: false, processes: Registry::default(), cargo_target_dir: None }
    }

    /// Start a text-only turn with tools disabled at both the CLI and
    /// protocol boundaries. Only Claude currently has a verified path.
    pub fn with_tools_disabled(mut self) -> Self {
        self.tools_disabled = true;
        self
    }

    /// Run the tool in the folder, and with the PATH, given by `context`.
    pub fn with_context(mut self, context: &BuildContext) -> Self {
        self.cwd = context.cwd.clone();
        self.path = context.path.clone();
        self.codex_hook = context.codex_hook.clone();
        self.temp = context.temp.clone();
        self.processes = Registry::new(context.process_registry.clone());
        self.cargo_target_dir = context.cargo_target_dir.clone();
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The program and arguments for this participant's backend, and how
    /// to read what it prints.
    fn command_line(&self) -> Result<(String, Vec<String>, OutputFormat), ParticipantError> {
        match &self.config.backend {
            Backend::Cli { .. } if self.tools_disabled => Err(ParticipantError::Failed("This CLI does not have a verified tool-free mode, so the monitor check did not run.".into())),
            Backend::Cli { program, args } => Ok((program.clone(), args.clone(), OutputFormat::Text)),
            Backend::Agent { tool, model } => {
                if self.tools_disabled && *tool != AgentTool::ClaudeCode {
                    return Err(ParticipantError::Failed("This CLI does not have a verified tool-free mode, so the monitor check did not run.".into()));
                }
                let (program, mut args) =
                    agent_command_with(*tool, model.as_deref(), self.config.effort.as_deref(), self.config.access, self.plan.is_some());
                if self.tools_disabled {
                    let mut safe = Vec::with_capacity(args.len());
                    let mut i = 0;
                    while i < args.len() {
                        if args[i] == "--settings" { i += 2; } else { safe.push(args[i].clone()); i += 1; }
                    }
                    safe.extend(["--safe-mode", "--restricted", "--tools", "", "--strict-mcp-config", "--setting-sources", ""].into_iter().map(str::to_owned));
                    args = safe;
                }
                Ok((program, args, output_format(*tool)))
            }
            _ => Err(ParticipantError::NotConfigured("backend is not a command-line tool".into())),
        }
    }

    /// Start `program` in the workspace folder with every standard stream
    /// connected to us.
    fn start(&self, program: &str, args: &[String]) -> Result<OwnedChild, ParticipantError> {
        self.start_with(program, args, &[])
    }

    /// `start`, with extra environment variables for the program.
    fn start_with(&self, program: &str, args: &[String], env: &[(&str, std::ffi::OsString)]) -> Result<OwnedChild, ParticipantError> {
        let mut command = Command::new(program);
        command.args(args);
        command.envs(env.iter().map(|(name, value)| (*name, value)));

        // Keep colour codes and progress animations out of the reply.
        command.env("NO_COLOR", "1").env("TERM", "dumb");
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
        // Scratch files land in the thread's temp folder when it exists.
        if let Some(temp) = self.temp.as_ref().filter(|dir| dir.is_dir()) {
            command.env("TMPDIR", temp).env("TMP", temp).env("TEMP", temp);
        }
        if let Some(target_dir) = &self.cargo_target_dir { command.env("CARGO_TARGET_DIR", target_dir); }
        if let Some(cwd) = &self.cwd {
            // A missing folder would otherwise be reported as a missing program.
            if !cwd.is_dir() {
                return Err(ParticipantError::Failed(format!(
                    "the workspace folder {} does not exist",
                    cwd.display()
                )));
            }
            command.current_dir(cwd);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        self.processes.spawn(&mut command)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => {
                    ParticipantError::NotConfigured(format!("program `{program}` was not found"))
                }
                _ => ParticipantError::Failed(format!("could not start `{program}`: {e}")),
            })
    }

    /// A Codex turn through its app server, which reports the reply as it
    /// is written. An unavailable server refuses the turn: exec cannot
    /// enforce Deck MCP approval cards.
    async fn run_codex_server(
        &self,
        model: Option<&str>,
        prompt: &str,
        on_progress: ProgressSink<'_>,
        approver: &dyn Approver,
    ) -> Result<Reply, ParticipantError> {
        let program = "codex";
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
        let effort = clean_effort(self.config.effort.as_deref());
        let turn = codex_server::Turn {
            model: clean_model(model),
            effort: effort.as_deref(),
            access: self.config.access,
            cwd: self.cwd.as_ref().map(|dir| dir.to_string_lossy().into_owned()),
            plan: self.plan.is_some(),
        };
        match codex_server::run(child, turn, prompt, on_progress, approver, hook.as_ref()).await {
            Ok(reply) => Ok(reply),
            Err(TurnError::Unavailable(why)) => {
                Err(ParticipantError::Failed(format!("Codex app server unavailable ({why}); this turn did not run because MCP approvals require it.")))
            }
            Err(TurnError::Failed(why)) => {
                eprintln!("[apex-deck] `{program}` turn failed: {why}");
                let summary = last_lines(&why).unwrap_or(why);
                let hint = sign_in_hint(program, &summary).map(|h| format!(" {h}")).unwrap_or_default();
                Err(ParticipantError::Failed(format!("`{program}` reported an error: {summary}{hint}")))
            }
            Err(TurnError::CleanupIncomplete(why)) => Err(ParticipantError::CleanupIncomplete(why)),
        }
    }

    async fn run(
        &self,
        program: &str,
        args: &[String],
        format: OutputFormat,
        prompt: String,
        on_progress: ProgressSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        let mut child = self.start(program, args)?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let mut stdout = child.stdout.take().expect("stdout was piped");
        let mut stderr = child.stderr.take().expect("stderr was piped");

        // Feed the prompt from its own task so a tool that prints before it
        // has read everything cannot deadlock against us.
        let writer = tokio::spawn(async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
        let errors = tokio::spawn(async move {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text).await;
            text
        });

        let cwd = self.cwd.as_ref().map(|dir| dir.to_string_lossy().into_owned());
        let mut reader = EventReader::new(format, cwd);
        let mut decoder = Utf8Chunks::default();
        let mut cleaner = AnsiStripper::default();
        let mut buffer = [0u8; 4096];
        // Colour codes are only stripped from plain output. In an event
        // stream they are escaped inside the JSON and must be left alone.
        let mut clean = |text: String| if format == OutputFormat::Text { cleaner.push(&text) } else { text };
        loop {
            let read = stdout
                .read(&mut buffer)
                .await
                .map_err(|e| ParticipantError::Failed(format!("reading output failed: {e}")))?;
            if read == 0 {
                break;
            }
            let text = clean(decoder.push(&buffer[..read]));
            report(reader.push(&text), on_progress);
        }
        let tail = clean(decoder.finish());
        report(reader.push(&tail), on_progress);
        report(reader.finish(), on_progress);

        let status = child
            .wait()
            .await
            .map_err(|e| ParticipantError::Failed(format!("waiting for `{program}` failed: {e}")))?;
        child.terminate_tree().await.map_err(ParticipantError::CleanupIncomplete)?;
        let _ = writer.await;
        let stderr_text = errors.await.unwrap_or_default();

        self.settle(program, status.success(), &status.to_string(), &stderr_text, reader)
    }

    /// Turn what a finished program printed into a reply, or into the line
    /// that explains why there is none.
    fn settle(
        &self,
        program: &str,
        success: bool,
        status: &str,
        stderr_text: &str,
        reader: EventReader,
    ) -> Result<Reply, ParticipantError> {
        let shown = reader.streamed().to_string();
        let outcome = reader.outcome();
        if !success || outcome.error.is_some() {
            let detail = AnsiStripper::default().push(stderr_text.trim());
            // The full output can run to pages; keep it in the app's log
            // and show the chat only the part that says what went wrong.
            eprintln!(
                "[apex-deck] `{program}` failed with {status}:\n--- error output ---\n{detail}\n--- output ---\n{}",
                shown.trim()
            );
            // A tool's own statement of what went wrong beats anything
            // picked out of its log.
            let summary = outcome
                .error
                .as_deref()
                .and_then(last_lines)
                .unwrap_or_else(|| failure_summary(&detail, &shown));
            let hint = sign_in_hint(program, &summary).map(|h| format!(" {h}")).unwrap_or_default();
            let how = if success { "reported an error".to_string() } else { format!("exited with {status}") };
            return Err(ParticipantError::Failed(format!("`{program}` {how}: {summary}{hint}")));
        }
        Ok(Reply {
            text: outcome.text.trim().to_string(),
            input_tokens: outcome.input_tokens,
            output_tokens: outcome.output_tokens,
            cost_micros: outcome.cost_micros,
            cost_estimated: false,
        })
    }

    /// A Claude Code turn that puts each edit and command to the person
    /// first. See claude_session.rs for the conversation with the program.
    async fn run_claude_asking(
        &self,
        program: &str,
        args: &[String],
        prompt: &str,
        on_progress: ProgressSink<'_>,
        approver: &dyn Approver,
    ) -> Result<Reply, ParticipantError> {
        let child = self.start(program, args)?;
        let cwd = self.cwd.as_ref().map(|dir| dir.to_string_lossy().into_owned());
        let finished = claude_session::run_with_policy(child, prompt, cwd, on_progress, approver, self.plan, self.tools_disabled)
            .await
            .map_err(|e| ParticipantError::Failed(format!("talking to `{program}` failed: {e}")))?;
        if let Some(error) = finished.cleanup_error { return Err(ParticipantError::CleanupIncomplete(error)); }
        self.settle(program, finished.success, &finished.status, &finished.stderr, finished.reader)
    }
}

const MAX_ERROR_LINE: usize = 300;

fn clip(line: &str) -> String {
    if line.chars().count() <= MAX_ERROR_LINE {
        line.to_string()
    } else {
        let head: String = line.chars().take(MAX_ERROR_LINE).collect();
        format!("{head}…")
    }
}

/// The message inside a line like `ERROR: {"error":{"message":"..."}}`.
fn json_message(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    value["error"]["message"]
        .as_str()
        .or_else(|| value["message"].as_str())
        .map(str::to_string)
}

/// The last line that starts with "error", without that prefix and with a
/// JSON message unwrapped if there is one.
fn error_line(text: &str) -> Option<String> {
    let rest = text.lines().map(str::trim).rev().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        let rest = lower.strip_prefix("error")?;
        // Require "error:" or "error " so words like "errors" do not match.
        if !(rest.starts_with(':') || rest.starts_with(' ')) {
            return None;
        }
        Some(line["error".len()..].trim_start_matches(':').trim())
    })?;
    Some(clip(&json_message(rest).unwrap_or_else(|| rest.to_string())))
}

/// The last few distinct lines, or `None` if there is no text at all.
fn last_lines(text: &str) -> Option<String> {
    let mut tail: Vec<String> = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()).rev() {
        let line = clip(line);
        if !tail.contains(&line) {
            tail.push(line);
        }
        if tail.len() == 3 {
            break;
        }
    }
    if tail.is_empty() {
        return None;
    }
    tail.reverse();
    Some(tail.join(" | "))
}

/// Reduce a tool's error output to the part worth showing in the chat.
///
/// Tools often print banners, the prompt, warnings and log lines before the
/// line that explains the failure. This picks the last line that starts
/// with "error" (unwrapping a JSON message if there is one), or failing
/// that the last few lines.
#[cfg(test)]
pub(crate) fn summarize_error(stderr: &str) -> String {
    failure_summary(stderr, "")
}

/// What to show in the chat when a tool exits with a failure.
///
/// Tools disagree on where they explain themselves. Codex writes to its
/// error output. Claude Code prints a failure inside the run, such as not
/// being signed in or a model the account cannot use, as its normal output
/// and may leave the error output empty or filled with unrelated warnings.
/// So an explicit error line wins wherever it is, then whatever the tool
/// printed as its answer, then the tail of the error output.
pub(crate) fn failure_summary(stderr: &str, stdout: &str) -> String {
    error_line(stderr)
        .or_else(|| error_line(stdout))
        .or_else(|| last_lines(stdout))
        .or_else(|| last_lines(stderr))
        .unwrap_or_else(|| "no error output".to_string())
}

/// What to do about a failure that means the tool is not signed in.
/// Each tool signs in through its own interactive mode, which a chat turn
/// cannot drive, so the fix is always a step in a terminal.
pub(crate) fn sign_in_hint(program: &str, summary: &str) -> Option<&'static str> {
    let lower = summary.to_ascii_lowercase();
    let signed_out = [
        "/login",
        "not logged in",
        "not signed in",
        "please log in",
        "please sign in",
        "invalid api key",
        "authentication_error",
        "oauth token has expired",
        "401 unauthorized",
        "missing bearer",
    ]
        .iter()
        .any(|needle| lower.contains(needle));
    if !signed_out {
        return None;
    }
    let name = std::path::Path::new(program).file_name().and_then(|n| n.to_str()).unwrap_or(program);
    Some(match name {
        "claude" => "To fix: open a Claude Code pane (or run `claude` in a terminal), type /login, finish signing in, then send your message again.",
        "codex" => "To fix: run `codex login` in a terminal pane, then send your message again.",
        "gemini" => "To fix: run `gemini` in a terminal pane, sign in when asked, then send your message again.",
        "grok" => "To fix: run `grok login` in a terminal pane, then send your message again.",
        _ => "To fix: sign in to this tool in a terminal pane, then send your message again.",
    })
}

/// Passes proposals on, and restarts the quiet clock once the person has
/// answered.
struct Timed<'a> {
    inner: &'a dyn Approver,
    last_heard: &'a Mutex<Instant>,
    asking: &'a AtomicBool,
}

/// Restarts the quiet clock however the wait ends, including when it is
/// abandoned.
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

impl Timed<'_> {
    /// The quiet clock stops while the person is being asked.
    fn waiting(&self) -> Asking<'_> {
        self.asking.store(true, Ordering::SeqCst);
        Asking { asking: self.asking, last_heard: self.last_heard }
    }
}

#[async_trait]
impl Approver for Timed<'_> {
    async fn decide(&self, action: ProposedAction) -> Decision {
        let _asking = self.waiting();
        self.inner.decide(action).await
    }

    async fn ask(&self, questions: Vec<apex_core::Question>) -> apex_core::Answer {
        let _asking = self.waiting();
        self.inner.ask(questions).await
    }
}

#[async_trait]
impl Participant for CliParticipant {
    fn config(&self) -> &ParticipantConfig {
        &self.config
    }

    async fn respond(
        &self,
        request: TurnRequest,
        on_delta: DeltaSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        let text_only = |update: Progress<'_>| {
            if let Progress::Text(text) = update {
                on_delta(text);
            }
        };
        self.respond_with_progress(request, &text_only).await
    }

    async fn respond_with_progress(
        &self,
        request: TurnRequest,
        on_progress: ProgressSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        // Nobody can be asked through this entry point, so anything that
        // would need a yes is refused.
        self.respond_with_approvals(request, on_progress, &NoApprover).await
    }

    async fn respond_with_approvals(
        &self,
        request: TurnRequest,
        on_progress: ProgressSink<'_>,
        approver: &dyn Approver,
    ) -> Result<Reply, ParticipantError> {
        let effective = effective_turn_config(&self.config, request.effort_override.as_deref());
        if effective != self.config {
            let mut request = request;
            request.effort_override = None;
            let scoped = Self { config: effective, timeout: self.timeout, cwd: self.cwd.clone(), path: self.path.clone(), codex_hook: self.codex_hook.clone(), temp: self.temp.clone(), plan: self.plan, tools_disabled: self.tools_disabled, processes: self.processes.clone(), cargo_target_dir: self.cargo_target_dir.clone() };
            return scoped.respond_with_approvals(request, on_progress, approver).await;
        }
        // The Plan switch: the turn runs read-only, remembering the bot's own
        // access. A custom command can't be held to read-only.
        if request.plan && self.plan.is_none() {
            if matches!(self.config.backend, Backend::Cli { .. }) {
                return Err(ParticipantError::Failed("This custom command can't be held to read-only, so it sits out while Plan is on.".into()));
            }
            let mut config = self.config.clone();
            config.access = Access::Read;
            let planning = Self { config, timeout: self.timeout, cwd: self.cwd.clone(), path: self.path.clone(), codex_hook: self.codex_hook.clone(), temp: self.temp.clone(), plan: Some(self.config.access), tools_disabled: self.tools_disabled, processes: self.processes.clone(), cargo_target_dir: self.cargo_target_dir.clone() };
            return planning.respond_with_approvals(request, on_progress, approver).await;
        }
        // Rebuild both CLI launch paths with the scheduler's effective access.
        // Arbitrary custom commands cannot enforce a scoped read-only turn.
        if request.access.is_some_and(|access| access != self.config.access) {
            if matches!(self.config.backend, Backend::Cli { .. }) {
                return Err(ParticipantError::Failed("custom CLI cannot enforce read-only access while another participant edits".into()));
            }
            let mut config = self.config.clone();
            config.access = request.access.unwrap();
            let scoped = Self { config, timeout: self.timeout, cwd: self.cwd.clone(), path: self.path.clone(), codex_hook: self.codex_hook.clone(), temp: self.temp.clone(), plan: self.plan, tools_disabled: self.tools_disabled, processes: self.processes.clone(), cargo_target_dir: self.cargo_target_dir.clone() };
            return scoped.respond_with_approvals(request, on_progress, approver).await;
        }
        let (program, args, format) = self.command_line()?;
        let program = program.as_str();
        let prompt = render_prompt(&request.system, &request.turns);
        let last_heard = Mutex::new(Instant::now());
        let asking = AtomicBool::new(false);
        let approver = Timed { inner: approver, last_heard: &last_heard, asking: &asking };
        let heard = |update: Progress<'_>| {
            *last_heard.lock().unwrap() = Instant::now();
            on_progress(update);
        };
        let on_progress: ProgressSink<'_> = &heard;
        let turn = async {
            // Codex writes its reply live only through its app server.
            if let Backend::Agent { tool: AgentTool::Codex, model } = &self.config.backend {
                return self.run_codex_server(model.as_deref(), &prompt, on_progress, &approver).await;
            }
            if matches!(&self.config.backend, Backend::Agent { tool: AgentTool::ClaudeCode, .. }) {
                return self.run_claude_asking(program, &args, &prompt, on_progress, &approver).await;
            }
            // Grok's pictures are saved to disk, so the ones this turn made
            // are found by comparing the folder before and after.
            if matches!(&self.config.backend, Backend::Agent { tool: AgentTool::Grok, .. }) {
                let root = self.cwd.as_deref().and_then(grok_images::session_root);
                let before = root.as_deref().map(grok_images::pictures_in).unwrap_or_default();
                let mut reply = self.run(program, &args, format, prompt, on_progress).await?;
                if let Some(root) = &root {
                    let pictures = grok_images::new_pictures(&before, &grok_images::pictures_in(root));
                    events::attach_images(&mut reply.text, &pictures);
                }
                return Ok(reply);
            }
            self.run(program, &args, format, prompt, on_progress).await
        };
        // The time limit is on silence, not on the whole turn. Time spent
        // waiting for the person to answer does not count against it.
        tokio::pin!(turn);
        loop {
            let left = self.timeout.saturating_sub(last_heard.lock().unwrap().elapsed());
            tokio::select! {
                result = &mut turn => return result,
                _ = tokio::time::sleep(left.max(Duration::from_millis(50))) => {
                    let over = last_heard.lock().unwrap().elapsed() >= self.timeout;
                    if over && !asking.load(Ordering::SeqCst) {
                        let mut cleanup = self.processes.terminate_all().await.err();
                        // Give the protocol task time to consume EOF and wait
                        // the direct child so it is reaped before returning.
                        let _ = tokio::time::timeout(Duration::from_millis(500), &mut turn).await;
                        if cleanup.is_some() {
                            let retry = self.processes.terminate_all().await.err();
                            cleanup = cleanup.or(retry);
                        }
                        if let Some(cleanup) = cleanup {
                            return Err(ParticipantError::CleanupIncomplete(format!("`{program}` timed out and its worker tree could not be verified stopped: {cleanup}")));
                        }
                        return Err(ParticipantError::Failed(format!(
                            "`{program}` went {} seconds without any output, so it was stopped",
                            self.timeout.as_secs()
                        )));
                    }
                }
            }
        }
    }

    async fn cancel_active_turn(&self) -> Result<bool, String> {
        self.processes.terminate_all().await
    }
}

#[cfg(test)]
mod tests {
    use super::{failure_summary, sign_in_hint, summarize_error, CliParticipant};
    use crate::events::{EventReader, OutputFormat};

    #[test]
    fn reported_cost_reaches_the_cli_reply() {
        let config = serde_json::from_value(serde_json::json!({
            "id": "claude", "display_name": "Claude",
            "backend": {"kind":"agent", "tool":"claude_code", "model":null}
        })).unwrap();
        let mut reader = EventReader::new(OutputFormat::ClaudeStream, None);
        reader.push(r#"{"type":"result","is_error":false,"result":"Done.","total_cost_usd":0.025}"#);
        reader.finish();
        let reply = CliParticipant::new(config)
            .settle("claude", true, "ok", "", reader)
            .unwrap();
        assert_eq!(reply.cost_micros, Some(25_000));
    }

    #[test]
    fn the_last_error_line_wins_and_its_json_message_is_unwrapped() {
        let stderr = "OpenAI Codex v0.155.1\n--------\nworkdir: /tmp\nuser\nYou are null...\n\
warning: Model metadata for `x` not found.\n\
2026-10-03T09:52:02Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed\n\
ERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'x' model is not supported when using Codex with a ChatGPT account.\"}}\n\
ERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'x' model is not supported when using Codex with a ChatGPT account.\"}}";
        assert_eq!(
            summarize_error(stderr),
            "The 'x' model is not supported when using Codex with a ChatGPT account."
        );
    }

    #[test]
    fn a_plain_error_line_is_shown_without_its_prefix() {
        assert_eq!(summarize_error("starting up\nerror: unknown flag --frob\n"), "unknown flag --frob");
        assert_eq!(summarize_error("Error something broke"), "something broke");
    }

    #[test]
    fn without_an_error_line_the_last_few_distinct_lines_are_shown() {
        assert_eq!(summarize_error("one\ntwo\nthree\nfour\nfour\n"), "two | three | four");
        assert_eq!(summarize_error("errors were found: 3"), "errors were found: 3");
        assert_eq!(summarize_error("  \n\n"), "no error output");
    }

    #[test]
    fn very_long_lines_are_cut() {
        let long = format!("error: {}", "x".repeat(5000));
        let summary = summarize_error(&long);
        assert_eq!(summary.chars().count(), 301);
        assert!(summary.ends_with('…'));
    }

    #[test]
    fn a_failure_printed_as_normal_output_is_shown_when_the_error_output_is_empty() {
        // Claude Code reports a failure inside the run on standard output.
        assert_eq!(failure_summary("", "Not logged in · Please run /login\n"), "Not logged in · Please run /login");
        assert_eq!(failure_summary("   \n", ""), "no error output");
    }

    #[test]
    fn normal_output_beats_warnings_but_not_an_explicit_error_line() {
        let warnings = "\"m\" isn't described by this version's model catalog\n[tool:unrecognized_model] {}";
        let answer = "There's an issue with the selected model (m). It may not exist or you may not have access to it.";
        assert_eq!(failure_summary(warnings, answer), answer);
        assert_eq!(failure_summary("error: unknown option '--effort'", "partial reply"), "unknown option '--effort'");
        assert_eq!(failure_summary("some warning", ""), "some warning");
    }

    #[test]
    fn a_signed_out_failure_says_how_to_sign_in() {
        let hint = sign_in_hint("claude", "Not logged in · Please run /login").unwrap();
        assert!(hint.contains("/login"), "{hint}");
        assert!(sign_in_hint("/opt/homebrew/bin/codex", "Invalid API key").unwrap().contains("codex login"));
        assert!(sign_in_hint("mytool", "please log in first").is_some());
        assert!(sign_in_hint("claude", "usage limit reached").is_none());
    }
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
        let mut waiting = timed.decide(ProposedAction { kind: ActionKind::Tool, title: "probe: place_order".into(), detail: "{}".into(), expires_at: None, risky: false });
        assert!(waiting.as_mut().now_or_never().is_none());
        assert!(asking.load(Ordering::SeqCst));
        drop(waiting);
        assert!(!asking.load(Ordering::SeqCst), "the quiet clock runs again");
        assert!(last_heard.lock().unwrap().elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn the_quiet_clock_stops_while_the_person_answers_a_question() {
        use super::{AtomicBool, Duration, Instant, Mutex, Ordering, Timed};
        use apex_core::{Answer, Approver, Decision, ProposedAction, Question};
        use futures::FutureExt;
        struct Thinking;
        #[async_trait::async_trait]
        impl Approver for Thinking {
            async fn decide(&self, _: ProposedAction) -> Decision { Decision::Reject }
            async fn ask(&self, _: Vec<Question>) -> Answer { std::future::pending().await }
        }
        let last_heard = Mutex::new(Instant::now() - Duration::from_secs(60));
        let asking = AtomicBool::new(false);
        let timed = Timed { inner: &Thinking, last_heard: &last_heard, asking: &asking };
        let mut waiting = timed.ask(vec![Question { header: String::new(), question: "Go?".into(), options: vec![], multi_select: false }]);
        assert!(waiting.as_mut().now_or_never().is_none());
        assert!(asking.load(Ordering::SeqCst), "the person is being asked, so the bot is not quiet");
        drop(waiting);
        assert!(!asking.load(Ordering::SeqCst));
        assert!(last_heard.lock().unwrap().elapsed() < Duration::from_secs(5));
    }

}

#[cfg(test)]
mod auto_tests {
    use super::*;
    #[test]
    fn reply_override_uses_the_tools_flags_and_does_not_change_saved_settings() {
        for tool in [AgentTool::ClaudeCode, AgentTool::Codex] {
            let config: ParticipantConfig = serde_json::from_value(serde_json::json!({"id":"bot","display_name":"Bot","backend":{"kind":"agent","tool":tool,"model":null},"effort":"xhigh"})).unwrap();
            let temporary = effective_turn_config(&config, Some("low"));
            let (_, args) = agent_command_with(tool, None, temporary.effort.as_deref(), Access::Read, false);
            assert!(args.iter().any(|s| s == "low" || s == "model_reasoning_effort=\"low\""));
            assert_eq!(config.effort.as_deref(), Some("xhigh"));
            assert_eq!(effective_turn_config(&config, None).effort.as_deref(), Some("xhigh"));
        }
    }
    #[test]
    fn a_fixed_unsupported_model_is_not_changed_by_auto() {
        let config: ParticipantConfig = serde_json::from_value(serde_json::json!({"id":"bot","display_name":"Bot","backend":{"kind":"agent","tool":"claude_code","model":"haiku"},"effort":"high"})).unwrap();
        assert_eq!(effective_turn_config(&config, None), config);
    }
    #[test]
    fn unsupported_claude_model_receives_no_effort_even_with_an_override() {
        let config: ParticipantConfig = serde_json::from_value(serde_json::json!({"id":"bot","display_name":"Bot","backend":{"kind":"agent","tool":"claude_code","model":"haiku"},"effort":"high","auto_effort":true})).unwrap();
        assert_eq!(effective_turn_config(&config, Some("low")).effort, None);
    }
}
