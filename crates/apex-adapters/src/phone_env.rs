//! Gives Claude and Codex bots Deck's shared phone: five environment
//! variables so `"$APEX_DECK_BIN" phone <verb>` can reach the daemon, and
//! one line in the prompt that says the phone is there. Other bots get
//! neither.

use std::ffi::OsString;
use std::path::PathBuf;

use apex_core::{AgentTool, Backend, ParticipantConfig};

/// Where a bot finds the phone: the daemon's own program, the socket the
/// daemon listens on, and the chat the bot is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneEnv {
    pub bin: PathBuf,
    pub socket: PathBuf,
    pub room: String,
}

/// The line added to a phone bot's prompt.
pub const PHONE_HINT: &str = "A shared iPhone simulator (Deck's Phone tab) is available for building and testing iPhone apps. Before using it, run: \"$APEX_DECK_BIN\" phone help\n";

/// The socket file name inside the daemon's data folder. The daemon
/// listens on it, and a test there checks the two names match.
pub const DAEMON_SOCKET: &str = "daemon.sock";

/// Only Claude Code and Codex bots get the phone.
pub fn uses_phone(config: &ParticipantConfig) -> bool {
    matches!(config.backend, Backend::Agent { tool: AgentTool::ClaudeCode | AgentTool::Codex, .. })
}

/// The variables to start this bot's process with. Empty when the phone is
/// off or this bot does not use it.
pub fn phone_vars(phone: Option<&PhoneEnv>, config: &ParticipantConfig) -> Vec<(&'static str, OsString)> {
    let Some(phone) = phone.filter(|_| uses_phone(config)) else { return Vec::new() };
    vec![
        ("APEX_DECK_BIN", phone.bin.clone().into_os_string()),
        ("APEX_DECK_PHONE_SOCKET", phone.socket.clone().into_os_string()),
        ("APEX_DECK_ROOM", OsString::from(&phone.room)),
        ("APEX_DECK_BOT", OsString::from(config.id.as_str())),
        ("APEX_DECK_BOT_NAME", OsString::from(&config.display_name)),
    ]
}

/// Codex filters inherited variables before running shell commands. Keep the
/// phone's five values explicitly, without broadening the person's env policy.
pub(crate) fn codex_shell_flags(phone: Option<&PhoneEnv>, config: &ParticipantConfig) -> Vec<String> {
    if !matches!(config.backend, Backend::Agent { tool: AgentTool::Codex, .. }) { return Vec::new(); }
    phone_vars(phone, config).into_iter().flat_map(|(name, value)| {
        let quoted = serde_json::to_string(&value.to_string_lossy()).expect("an environment string serializes");
        ["-c".into(), format!("shell_environment_policy.set.{name}={quoted}")]
    }).collect()
}

/// `system` with the phone line added, when this bot has the phone.
pub fn with_hint(system: &str, phone: Option<&PhoneEnv>, config: &ParticipantConfig) -> String {
    if phone.is_some() && uses_phone(config) {
        format!("{system}\n{PHONE_HINT}")
    } else {
        system.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{AgentTool, Backend, ParticipantConfig, ParticipantId};

    fn bot(tool: AgentTool) -> ParticipantConfig {
        let mut config: ParticipantConfig = serde_json::from_value(serde_json::json!({"id": "jig", "display_name": "Jigga", "backend": {"kind": "scripted", "lines": []}})).unwrap();
        config.backend = Backend::Agent { tool, model: None };
        config.id = ParticipantId::new("jig");
        config
    }
    fn env() -> PhoneEnv { PhoneEnv { bin: "/A/apex-daemon".into(), socket: "/D/daemon.sock".into(), room: "room-1".into() } }

    #[test]
    fn claude_and_codex_get_the_phone_others_do_not() {
        let vars = phone_vars(Some(&env()), &bot(AgentTool::ClaudeCode));
        let os = |text: &str| OsString::from(text);
        assert_eq!(vars, vec![("APEX_DECK_BIN", os("/A/apex-daemon")), ("APEX_DECK_PHONE_SOCKET", os("/D/daemon.sock")),
            ("APEX_DECK_ROOM", os("room-1")), ("APEX_DECK_BOT", os("jig")), ("APEX_DECK_BOT_NAME", os("Jigga"))]);
        assert_eq!(phone_vars(Some(&env()), &bot(AgentTool::Codex)).len(), 5);
        assert!(phone_vars(Some(&env()), &bot(AgentTool::Gemini)).is_empty());
        assert!(phone_vars(None, &bot(AgentTool::ClaudeCode)).is_empty());
    }

    #[test]
    fn codex_shell_settings_keep_only_the_five_phone_variables() {
        let flags = codex_shell_flags(Some(&env()), &bot(AgentTool::Codex));
        assert_eq!(flags.len(), 10);
        assert_eq!(&flags[..2], &["-c", "shell_environment_policy.set.APEX_DECK_BIN=\"/A/apex-daemon\""]);
        assert!(flags.contains(&"shell_environment_policy.set.APEX_DECK_BOT_NAME=\"Jigga\"".to_string()));
        assert!(codex_shell_flags(None, &bot(AgentTool::Codex)).is_empty());
        assert!(codex_shell_flags(Some(&env()), &bot(AgentTool::ClaudeCode)).is_empty());
    }

    #[test]
    fn the_hint_is_added_only_when_the_phone_is_there() {
        assert_eq!(with_hint("You are Jigga.\n", Some(&env()), &bot(AgentTool::Codex)), format!("You are Jigga.\n\n{PHONE_HINT}"));
        assert_eq!(with_hint("You are Jigga.\n", None, &bot(AgentTool::Codex)), "You are Jigga.\n");
        assert_eq!(with_hint("You are Jigga.\n", Some(&env()), &bot(AgentTool::Grok)), "You are Jigga.\n");
    }
}
