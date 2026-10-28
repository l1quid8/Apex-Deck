//! Backends that connect a room participant to a real model.
//!
//! - [`OpenAiCompatParticipant`] talks to any HTTP API that speaks the
//!   OpenAI-style chat completions format with streaming.
//! - [`CliParticipant`] runs a command-line tool once per turn.
//!
//! [`build`] picks the right one from a [`ParticipantConfig`].
//! [`installed_models`] reads the model list a tool keeps for its account.

mod ansi;
mod assistant;
pub use assistant::{assistant_profile_ok, build_assistant};
mod api_tools;
mod attachments;
mod api_info;
mod catalog;
mod claude_session;
mod claude_usage;
mod cli;
mod gemini_usage;
mod gateway_sandbox;
mod codex_server;
pub mod codex_images;
mod codex_hook;
mod events;
mod executable;
mod grok_images;
mod grok_usage;
pub mod keys;
mod mcp;
pub mod media;
pub mod model_metrics;
mod muse_server;
mod openai;
mod owned_process;
mod phone_env;
mod plan_cache;
mod presets;
mod step_labels;
mod work_feed;
#[cfg(windows)]
mod windows_job;

use std::path::PathBuf;
use std::sync::Arc;

use apex_core::testing::ScriptedParticipant;
use apex_core::{Access, AgentTool, Backend, Participant, ParticipantConfig, PlanUsage, RoomKind};

pub use catalog::{codex_models_from_cache, installed_models};
pub use gateway_sandbox::isolation_available;
pub use codex_hook::{codex_hook_main, hook_command as codex_hook_command, HOOK_ARG as CODEX_HOOK_ARG};

pub use api_info::{balance as api_balance, model as api_model, ApiModel, MediaSpec, ModelKind};
pub use cli::CliParticipant;
pub use openai::{list_models, OpenAiCompatParticipant};
pub use phone_env::{PhoneEnv, DAEMON_SOCKET, PHONE_HINT};
pub use presets::{agent_command, allow_reading};
pub use owned_process::{OwnedChild as OwnedProcessChild, Registry as OwnedProcessRegistry};
pub use executable::program as executable_program;
#[cfg(windows)]
pub use executable::on_path as executable_on_path;

/// Pass on what a tool's output amounted to: text, activity, changes,
/// work steps and the to-do list.
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
            events::Step::Work(step) => on_progress(Progress::Work(&step)),
            events::Step::Todo(items) => on_progress(Progress::Todo(&items)),
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
    /// Persistent per-thread storage for worker process ownership records.
    /// Host data, not scratch space; used to recover live process groups
    /// after a daemon restart.
    pub process_registry: Option<PathBuf>,
    /// Isolated Rust build output for task workspaces.
    pub cargo_target_dir: Option<PathBuf>,
    /// The thread's attachments folder, where bots whose model makes
    /// pictures or videos save them. `None` turns those bots off.
    pub media_dir: Option<PathBuf>,
    /// Canonical host-authorized folders for image input. Empty denies all local images.
    /// These must come from host storage configuration, never transcript text.
    pub attachment_roots: Vec<PathBuf>,
    /// Deck's shared phone, for Claude and Codex bots on a Mac. None turns it off.
    pub phone: Option<PhoneEnv>,
}

/// Create the participant described by `config`. A bot reached through an
/// API is given tools to work in `context`'s folder; see `api_tools`.
pub fn build(config: ParticipantConfig, context: &BuildContext) -> Arc<dyn Participant> {
    match &config.backend {
        Backend::OpenAiCompatible { .. } => Arc::new(
            OpenAiCompatParticipant::new(config)
                .with_media_dir(context.media_dir.clone())
                .with_attachment_roots(context.attachment_roots.clone())
                .with_tools(context),
        ),
        _ => build_without_tools(config, context),
    }
}

/// `build`, except that a bot reached through an API gets no tools. For
/// turns that only write, such as summarizing the chat.
pub fn build_without_tools(config: ParticipantConfig, context: &BuildContext) -> Arc<dyn Participant> {
    match &config.backend {
        Backend::OpenAiCompatible { .. } => Arc::new(OpenAiCompatParticipant::new(config).with_media_dir(context.media_dir.clone()).with_attachment_roots(context.attachment_roots.clone())),
        Backend::Cli { .. } | Backend::Agent { .. } => {
            Arc::new(CliParticipant::new(config).with_context(context))
        }
        Backend::Scripted { .. } => Arc::new(ScriptedParticipant::from_config(config)),
    }
}

/// Whether `tool` can run in a talk-only chat room on this host.
pub fn chat_tool_ok(tool: AgentTool, path: Option<&str>) -> Result<(), String> {
    match tool {
        AgentTool::ClaudeCode => Ok(()),
        AgentTool::Codex | AgentTool::Gemini | AgentTool::Grok | AgentTool::Muse => {
            gateway_sandbox::isolation_available(path)
        }
    }
}

/// Whether `config` is allowed in a talk-only `RoomKind::Chat` room on this host.
pub fn chat_profile_ok(config: &ParticipantConfig, path: Option<&str>) -> Result<(), String> {
    if config.media.is_some() {
        return Err("Talk-only chat rooms do not support media-generating profiles.".into());
    }
    match &config.backend {
        Backend::OpenAiCompatible { .. } | Backend::Scripted { .. } => Ok(()),
        Backend::Agent { tool, .. } => chat_tool_ok(*tool, path),
        Backend::Cli { .. } => Err("Custom CLI commands cannot run in talk-only chat rooms because they have no verified tool-free mode.".into()),
    }
}

/// Single room-participant builder: `Work` rooms get full tools and workspace context;
/// `Chat` rooms are built with tools disabled, no `cwd`, no `media_dir`, no attachment roots, and `Access::Read`.
pub fn participant_for_room(
    kind: RoomKind,
    mut config: ParticipantConfig,
    context: &BuildContext,
) -> Arc<dyn Participant> {
    match kind {
        RoomKind::Work => build(config, context),
        RoomKind::Chat => {
            config.access = Access::Read;
            config.media = None;
            let chat_context = BuildContext {
                codex_hook: None,
                cwd: None,
                path: context.path.clone(),
                temp: context.temp.clone(),
                process_registry: context.process_registry.clone(),
                cargo_target_dir: None,
                media_dir: None,
                attachment_roots: Vec::new(),
                phone: None,
            };
            match &config.backend {
                Backend::OpenAiCompatible { .. } => Arc::new(OpenAiCompatParticipant::new(config)),
                Backend::Cli { .. } | Backend::Agent { .. } => Arc::new(
                    CliParticipant::new(config)
                        .with_context(&chat_context)
                        .with_tools_disabled(),
                ),
                Backend::Scripted { .. } => Arc::new(ScriptedParticipant::from_config(config)),
            }
        }
    }
}

/// Read how much of a provider account's plan is used, without asking a
/// model anything. Codex is asked through its app server. Claude, Grok and
/// Gemini are read from the endpoints behind each CLI's usage screen, with
/// the login that CLI saved. Every chat shares one answer per provider, so
/// opening several at once reads only once, and a failed read is logged
/// once and not retried until its wait is over.
///
/// `model` is the model the bot is set to. A provider can put a model in a
/// small quota group of its own (Antigravity's Argon), so the answer for one
/// model is not the answer for another, and each model keeps its own answer.
pub async fn plan_usage(tool: AgentTool, model: Option<&str>, context: &BuildContext) -> Option<PlanUsage> {
    let name = match tool {
        AgentTool::ClaudeCode => "Claude",
        AgentTool::Codex => "Codex",
        AgentTool::Grok => "Grok",
        AgentTool::Gemini => "Gemini",
        // Muse reports its plan only during a turn (`usage/changed`), and
        // `muse_server` keeps the latest. Until the first turn there is none.
        AgentTool::Muse => return plan_cache::last(tool),
    };
    let read = || async {
        match tool {
            AgentTool::ClaudeCode => claude_usage::read_plan().await,
            AgentTool::Codex => read_codex_plan(context).await.map_err(|why| plan_cache::Failure::new(why, plan_cache::Failure::SHORT)),
            AgentTool::Grok => grok_usage::read_plan().await,
            AgentTool::Gemini => gemini_usage::read_plan(context.path.as_deref(), model).await,
            AgentTool::Muse => unreachable!("answered from the last turn above"),
        }
    };
    plan_cache::get(tool, model, read)
        .await
        .map_err(|failure| {
            let wait = failure.wait.as_secs();
            eprintln!("[apex-deck] could not read {name} plan limits: {}; trying again in {wait}s", failure.why)
        })
        .ok()
        .flatten()
}

pub use codex_server::ResetOutcome;

/// Use one of a provider's usage resets: `credit`, or the next one when
/// `None`. Codex and Claude offer them. `key` names the person's attempt; asking
/// again with the same key after a failure can't spend a second credit, and
/// a fresh one is made when it is `None`. Gives what happened and, when the
/// plan could be read after, where it stands now, which is also what the
/// next `plan_usage` gives.
pub async fn use_plan_reset(tool: AgentTool, credit: Option<&str>, key: Option<&str>, context: &BuildContext) -> Result<(ResetOutcome, Option<PlanUsage>), String> {
    let key = key.map_or_else(attempt_key, str::to_string);
    let (outcome, mut plan) = match tool {
        AgentTool::Codex => codex_server::consume_reset(start_codex_server(context)?, credit, &key).await?,
        AgentTool::ClaudeCode => {
            // Claude needs a grant named; without one, use the one it lists first.
            let grant = credit
                .map(str::to_string)
                .or_else(|| plan_cache::last(tool)?.reset_credits?.credits.first().map(|c| c.id.clone()))
                .ok_or("Claude has no usage reset to use")?;
            let outcome = claude_usage::consume_reset(&grant, &key).await?;
            let plan = if outcome == ResetOutcome::NothingToReset { None } else { claude_usage::read_plan().await.ok() };
            (outcome, plan)
        }
        _ => return Err("only Codex and Claude offer usage resets".to_string()),
    };
    if outcome == ResetOutcome::Reset {
        // The windows started over even if reading them after failed: try
        // once more, then fall back to the last plan with its windows emptied.
        if plan.is_none() {
            plan = match tool {
                AgentTool::Codex => read_codex_plan(context).await.ok(),
                _ => claude_usage::read_plan().await.ok(),
            };
        }
        if plan.is_none() {
            plan = plan_cache::last(tool).map(|mut last| {
                last.windows.iter_mut().for_each(|w| w.used_percent = 0);
                last.reset_credits = None;
                last
            });
        }
        if let Some(plan) = plan.as_mut().filter(|plan| plan.reset_credits.is_none()) {
            // The credit just used is gone. When the provider picked it,
            // which one is unknown, so only the count stays.
            plan.reset_credits = plan_cache::last(tool).and_then(|last| last.reset_credits).map(|mut known| {
                known.available = known.available.saturating_sub(1);
                match credit {
                    Some(used) => known.credits.retain(|c| c.id != used),
                    None => known.credits.clear(),
                }
                known
            });
        }
    }
    if let Some(plan) = plan.as_ref() {
        plan_cache::remember(plan);
    }
    Ok((outcome, plan))
}

/// A fresh UUID-shaped key for one reset attempt.
fn attempt_key() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut bytes = [0u8; 16];
    for half in bytes.chunks_mut(8) {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        half.copy_from_slice(&hasher.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

async fn read_codex_plan(context: &BuildContext) -> Result<PlanUsage, String> {
    codex_server::read_plan(start_codex_server(context)?).await
}

/// `codex app-server` with all three standard streams piped.
fn start_codex_server(context: &BuildContext) -> Result<owned_process::OwnedChild, String> {
    let mut command = tokio::process::Command::new(executable::program("codex", context.path.as_deref()));
    command.args(codex_server::ARGS).env("NO_COLOR", "1").env("TERM", "dumb");
    if let Some(path) = &context.path {
        command.env("PATH", path);
    }
    if let Some(cwd) = context.cwd.as_ref().filter(|dir| dir.is_dir()) {
        command.current_dir(cwd);
    }
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    owned_process::Registry::new(context.process_registry.clone()).spawn(&mut command)
        .map_err(|e| format!("could not start codex: {e}"))
}

/// Verify and stop worker groups persisted by an earlier host process.
/// Ambiguous or reused PIDs are left untouched and reported for manual
/// cleanup; callers should keep the room's editor/write lease held on error.
pub fn recover_owned_processes(directory: &std::path::Path) -> Result<(), String> {
    owned_process::recover(directory)
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

pub use codex_server::list_servers as codex_tool_servers;
pub use claude_session::list_servers as claude_tool_servers;

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
