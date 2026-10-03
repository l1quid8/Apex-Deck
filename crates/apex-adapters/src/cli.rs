use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use apex_core::{
    render_prompt, Access, AgentTool, Approver, Backend, Decision, DeltaSink, NoApprover, Participant,
    ParticipantConfig, ParticipantError, Progress, ProgressSink, ProposedAction, Reply, TurnRequest,
};
use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

use crate::ansi::AnsiStripper;
use crate::events::{EventReader, OutputFormat};
use crate::codex_server::{self, TurnError};
use crate::presets::{agent_command, clean_effort, clean_model, output_format};
use crate::{claude_session, report, BuildContext, Utf8Chunks};

/// How long one turn may run before the tool is killed.
const TURN_TIMEOUT: Duration = Duration::from_secs(600);

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
}

impl CliParticipant {
    pub fn new(config: ParticipantConfig) -> Self {
        Self { config, timeout: TURN_TIMEOUT, cwd: None, path: None }
    }

    /// Run the tool in the folder, and with the PATH, given by `context`.
    pub fn with_context(mut self, context: &BuildContext) -> Self {
        self.cwd = context.cwd.clone();
        self.path = context.path.clone();
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
            Backend::Cli { program, args } => Ok((program.clone(), args.clone(), OutputFormat::Text)),
            Backend::Agent { tool, model } => {
                let (program, args) =
                    agent_command(*tool, model.as_deref(), self.config.effort.as_deref(), self.config.access);
                Ok((program, args, output_format(*tool)))
            }
            _ => Err(ParticipantError::NotConfigured("backend is not a command-line tool".into())),
        }
    }

    /// Start `program` in the workspace folder with every standard stream
    /// connected to us.
    fn start(&self, program: &str, args: &[String]) -> Result<Child, ParticipantError> {
        let mut command = Command::new(program);
        command.args(args);
        // Keep colour codes and progress animations out of the reply.
        command.env("NO_COLOR", "1").env("TERM", "dumb");
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
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
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => {
                    ParticipantError::NotConfigured(format!("program `{program}` was not found"))
                }
                _ => ParticipantError::Failed(format!("could not start `{program}`: {e}")),
            })
    }

    /// A Codex turn through its app server, which reports the reply as it
    /// is written. `Ok(None)` means the app server could not be used and
    /// nothing was asked of the model, so the caller should run the turn
    /// the plain way instead.
    async fn run_codex_server(
        &self,
        model: Option<&str>,
        prompt: &str,
        on_progress: ProgressSink<'_>,
        approver: &dyn Approver,
    ) -> Result<Option<Reply>, ParticipantError> {
        let program = "codex";
        let args: Vec<String> = codex_server::ARGS.iter().map(|a| a.to_string()).collect();
        let child = self.start(program, &args)?;
        let effort = clean_effort(self.config.effort.as_deref());
        let turn = codex_server::Turn {
            model: clean_model(model),
            effort: effort.as_deref(),
            access: self.config.access,
            cwd: self.cwd.as_ref().map(|dir| dir.to_string_lossy().into_owned()),
        };
        match codex_server::run(child, turn, prompt, on_progress, approver).await {
            Ok(reply) => Ok(Some(reply)),
            Err(TurnError::Unavailable(why)) => {
                eprintln!("[apex-deck] Codex app server not used ({why}); running `codex exec` instead");
                Ok(None)
            }
            Err(TurnError::Failed(why)) => {
                eprintln!("[apex-deck] `{program}` turn failed: {why}");
                let summary = last_lines(&why).unwrap_or(why);
                let hint = sign_in_hint(program, &summary).map(|h| format!(" {h}")).unwrap_or_default();
                Err(ParticipantError::Failed(format!("`{program}` reported an error: {summary}{hint}")))
            }
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
        let finished = claude_session::run(child, prompt, cwd, on_progress, approver)
            .await
            .map_err(|e| ParticipantError::Failed(format!("talking to `{program}` failed: {e}")))?;
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
        _ => "To fix: sign in to this tool in a terminal pane, then send your message again.",
    })
}

/// Passes proposals on, and notes how long the person took to answer.
struct Timed<'a> {
    inner: &'a dyn Approver,
    waited: &'a Mutex<Duration>,
    asking: &'a AtomicBool,
}

#[async_trait]
impl Approver for Timed<'_> {
    async fn decide(&self, action: ProposedAction) -> Decision {
        let asked = Instant::now();
        self.asking.store(true, Ordering::SeqCst);
        let decision = self.inner.decide(action).await;
        *self.waited.lock().unwrap() += asked.elapsed();
        self.asking.store(false, Ordering::SeqCst);
        decision
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
        let (program, args, format) = self.command_line()?;
        let program = program.as_str();
        let prompt = render_prompt(&request.system, &request.turns);
        let waited = Mutex::new(Duration::ZERO);
        let asking = AtomicBool::new(false);
        let approver = Timed { inner: approver, waited: &waited, asking: &asking };
        let turn = async {
            // Codex writes its reply live only through its app server.
            if let Backend::Agent { tool: AgentTool::Codex, model } = &self.config.backend {
                if let Some(reply) = self.run_codex_server(model.as_deref(), &prompt, on_progress, &approver).await? {
                    return Ok(reply);
                }
            }
            if matches!(&self.config.backend, Backend::Agent { tool: AgentTool::ClaudeCode, .. }) && self.config.access == Access::Ask {
                return self.run_claude_asking(program, &args, &prompt, on_progress, &approver).await;
            }
            self.run(program, &args, format, prompt, on_progress).await
        };
        // The time limit is on the tool's own work. Time spent waiting for
        // the person to answer does not count against it.
        tokio::pin!(turn);
        let started = Instant::now();
        loop {
            let allowed = self.timeout + *waited.lock().unwrap();
            let left = allowed.saturating_sub(started.elapsed());
            tokio::select! {
                result = &mut turn => return result,
                _ = tokio::time::sleep(left.max(Duration::from_millis(50))) => {
                    let over = started.elapsed() >= self.timeout + *waited.lock().unwrap();
                    if over && !asking.load(Ordering::SeqCst) {
                        return Err(ParticipantError::Failed(format!(
                            "`{program}` did not finish within {} seconds",
                            self.timeout.as_secs()
                        )));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{failure_summary, sign_in_hint, summarize_error};

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
}
