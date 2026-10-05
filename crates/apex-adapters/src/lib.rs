//! Backends that connect a room participant to a real model.
//!
//! - [`OpenAiCompatParticipant`] talks to any HTTP API that speaks the
//!   OpenAI-style chat completions format with streaming.
//! - [`CliParticipant`] runs a command-line tool once per turn.
//!
//! [`build`] picks the right one from a [`ParticipantConfig`].
//! [`installed_models`] reads the model list a tool keeps for its account.

mod ansi;
mod catalog;
mod claude_session;
mod claude_usage;
mod cli;
mod gemini_usage;
mod codex_server;
mod codex_hook;
mod events;
mod grok_usage;
mod mcp;
mod openai;
mod plan_cache;
mod presets;

use std::path::PathBuf;
use std::sync::Arc;

use apex_core::testing::ScriptedParticipant;
use apex_core::{AgentTool, Backend, Participant, ParticipantConfig, PlanUsage};

pub use catalog::{codex_models_from_cache, installed_models};
pub use codex_hook::{codex_hook_main, hook_command as codex_hook_command, HOOK_ARG as CODEX_HOOK_ARG};

pub use cli::CliParticipant;
pub use openai::{list_models, OpenAiCompatParticipant};
pub use presets::{agent_command, allow_reading};

/// Pass on what a tool's output amounted to: text, activity and changes.
pub(crate) fn report(steps: Vec<events::Step>, on_progress: apex_core::ProgressSink<'_>) {
    use apex_core::Progress;
    for step in steps {
        match step {
            events::Step::Text(text) => on_progress(Progress::Text(&text)),
            events::Step::Activity(text) => on_progress(Progress::Activity(&text)),
            events::Step::Change(change) => on_progress(Progress::Change(&change)),
            events::Step::Context(context) => on_progress(Progress::Context(context)),
            events::Step::Plan(plan) => {
                plan_cache::remember(&plan);
                on_progress(Progress::Plan(&plan))
            }
        }
    }
}

/// Where and how command-line participants run.
#[derive(Debug, Clone, Default)]
pub struct BuildContext {
    /// Deck's own executable, which Codex runs as an approval hook before
    /// each MCP call (`--codex-hook`). `None` leaves Codex on the slower
    /// MCP inventory policy.
    pub codex_hook: Option<PathBuf>,

    /// The folder tools are started in, normally the workspace folder.
    pub cwd: Option<PathBuf>,
    /// The PATH used to find and run tools. `None` keeps the app's own.
    /// Desktop apps often start with a shorter PATH than the user's
    /// terminal, so the shell passes in the terminal's.
    pub path: Option<String>,
    /// The thread's own temp folder, given to tools as `TMPDIR` so their
    /// scratch files go away when the thread is deleted. `None` keeps the
    /// system's.
    pub temp: Option<PathBuf>,
}

/// Create the participant described by `config`.
pub fn build(config: ParticipantConfig, context: &BuildContext) -> Arc<dyn Participant> {
    match &config.backend {
        Backend::OpenAiCompatible { .. } => Arc::new(OpenAiCompatParticipant::new(config)),
        Backend::Cli { .. } | Backend::Agent { .. } => {
            Arc::new(CliParticipant::new(config).with_context(context))
        }
        Backend::Scripted { .. } => Arc::new(ScriptedParticipant::from_config(config)),
    }
}

/// Read how much of a provider account's plan is used, without asking a
/// model anything. Codex is asked through its app server. Claude, Grok and
/// Gemini are read from the endpoints behind each CLI's usage screen, with
/// the login that CLI saved. Every chat shares one answer per provider, so
/// opening several at once reads only once, and a failed read is logged
/// once and not retried until its wait is over.
pub async fn plan_usage(tool: AgentTool, context: &BuildContext) -> Option<PlanUsage> {
    let name = match tool {
        AgentTool::ClaudeCode => "Claude",
        AgentTool::Codex => "Codex",
        AgentTool::Grok => "Grok",
        AgentTool::Gemini => "Gemini",
    };
    let read = || async {
        match tool {
            AgentTool::ClaudeCode => claude_usage::read_plan().await,
            AgentTool::Codex => read_codex_plan(context).await.map_err(|why| plan_cache::Failure::new(why, plan_cache::Failure::SHORT)),
            AgentTool::Grok => grok_usage::read_plan().await,
            AgentTool::Gemini => gemini_usage::read_plan().await,
        }
    };
    plan_cache::get(tool, read)
        .await
        .map_err(|failure| {
            let wait = failure.wait.as_secs();
            eprintln!("[apex-deck] could not read {name} plan limits: {}; trying again in {wait}s", failure.why)
        })
        .ok()
        .flatten()
}

async fn read_codex_plan(context: &BuildContext) -> Result<PlanUsage, String> {
    let mut command = tokio::process::Command::new("codex");
    command.args(codex_server::ARGS).env("NO_COLOR", "1").env("TERM", "dumb");
    if let Some(path) = &context.path {
        command.env("PATH", path);
    }
    if let Some(cwd) = context.cwd.as_ref().filter(|dir| dir.is_dir()) {
        command.current_dir(cwd);
    }
    let child = command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start codex: {e}"))?;
    codex_server::read_plan(child).await
}

/// Splits a byte stream into text without cutting a multi-byte character in
/// half when it straddles two chunks.
#[derive(Default)]
pub(crate) struct Utf8Chunks {
    pending: Vec<u8>,
}

impl Utf8Chunks {
    /// Add bytes and return the text that is now complete.
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            // Invalid bytes that more input cannot fix: decode lossily.
            Err(_) => {
                let text = String::from_utf8_lossy(&self.pending).into_owned();
                self.pending.clear();
                return text;
            }
        };
        let rest = self.pending.split_off(valid);
        String::from_utf8(std::mem::replace(&mut self.pending, rest))
            .expect("prefix was checked to be valid UTF-8")
    }

    /// Whatever is left when the stream ends.
    pub(crate) fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8Chunks;

    #[test]
    fn a_character_split_across_chunks_is_held_until_complete() {
        let bytes = "né".as_bytes(); // 'é' is two bytes
        let mut chunks = Utf8Chunks::default();
        assert_eq!(chunks.push(&bytes[..2]), "n");
        assert_eq!(chunks.push(&bytes[2..]), "é");
        assert_eq!(chunks.finish(), "");
    }

    #[test]
    fn invalid_bytes_are_replaced_instead_of_stalling_the_stream() {
        let mut chunks = Utf8Chunks::default();
        assert_eq!(chunks.push(&[b'a', 0xff, b'b']), "a\u{fffd}b");
    }
}

pub use codex_server::list_servers as codex_tool_servers;
pub use claude_session::list_servers as claude_tool_servers;
