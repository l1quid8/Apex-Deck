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
mod cli;
mod codex_server;
mod events;
mod openai;
mod presets;

use std::path::PathBuf;
use std::sync::Arc;

use apex_core::testing::ScriptedParticipant;
use apex_core::{Backend, Participant, ParticipantConfig};

pub use catalog::{codex_models_from_cache, installed_models};
pub use cli::CliParticipant;
pub use openai::{list_models, OpenAiCompatParticipant};
pub use presets::agent_command;

/// Pass on what a tool's output amounted to: text, activity and changes.
pub(crate) fn report(steps: Vec<events::Step>, on_progress: apex_core::ProgressSink<'_>) {
    use apex_core::Progress;
    for step in steps {
        match step {
            events::Step::Text(text) => on_progress(Progress::Text(&text)),
            events::Step::Activity(text) => on_progress(Progress::Activity(&text)),
            events::Step::Change(change) => on_progress(Progress::Change(&change)),
        }
    }
}

/// Where and how command-line participants run.
#[derive(Debug, Clone, Default)]
pub struct BuildContext {
    /// The folder tools are started in, normally the workspace folder.
    pub cwd: Option<PathBuf>,
    /// The PATH used to find and run tools. `None` keeps the app's own.
    /// Desktop apps often start with a shorter PATH than the user's
    /// terminal, so the shell passes in the terminal's.
    pub path: Option<String>,
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
