//! Text-only assistant inference, separate from workspace workers and monitors.
use std::sync::Arc;
use apex_core::{Backend, Participant, ParticipantConfig};
use crate::{BuildContext, CliParticipant, OpenAiCompatParticipant};

pub fn assistant_profile_ok(config: &ParticipantConfig) -> Result<(), String> {
    if config.media.is_some() { return Err("Choose a text provider for assistant conversations.".into()); }
    match config.backend {
        Backend::Agent { .. } | Backend::OpenAiCompatible { .. } => Ok(()),
        _ => Err("Choose a connected text provider. Custom commands and scripted profiles cannot run assistant conversations.".into()),
    }
}

/// Never use `build_without_tools` here: its CLI path retains workspace tools.
/// Known CLI adapters remove tools and isolate personal configuration; API
/// participants receive neither workspace tools nor a media generation folder.
pub fn build_assistant(config: ParticipantConfig, context: &BuildContext) -> Result<Arc<dyn Participant>, String> {
    assistant_profile_ok(&config)?;
    Ok(match config.backend {
        Backend::OpenAiCompatible { .. } => Arc::new(OpenAiCompatParticipant::new(config)),
        Backend::Agent { .. } => Arc::new(CliParticipant::new(config).with_context(context).with_tools_disabled()),
        _ => unreachable!("validated above"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_known_text_backends_can_be_assistants() {
        let profile=|backend| serde_json::from_value::<ParticipantConfig>(serde_json::json!({"id":"a","display_name":"Assistant","backend":backend})).unwrap();
        for tool in ["claude_code","codex","gemini","grok","muse"] {
            assert!(assistant_profile_ok(&profile(serde_json::json!({"kind":"agent","tool":tool}))).is_ok());
        }
        assert!(assistant_profile_ok(&profile(serde_json::json!({"kind":"cli","program":"sh","args":[]}))).is_err());
        assert!(assistant_profile_ok(&profile(serde_json::json!({"kind":"scripted","lines":[]}))).is_err());
    }
}
