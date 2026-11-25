//! Gives Claude Code and Codex agents Deck's command line: environment
//! variables so `"$APEX_DECK_BIN" task <verb>` (every platform) and
//! `"$APEX_DECK_BIN" phone <verb>` (where Deck's simulator runs) can reach the
//! daemon, and one prompt line that says the phone is there. Other agents get
//! neither.

use std::ffi::OsString;
use std::path::PathBuf;

use apex_core::{Access, AgentTool, Backend, ParticipantConfig};

/// Where an agent finds Deck: the daemon's own program, the socket the
/// daemon listens on, the thread the agent is in, and whether this machine
/// has the shared phone simulator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeckEnv {
    pub bin: PathBuf,
    pub socket: PathBuf,
    pub room: String,
    pub simulator: bool,
}

/// The line added to a phone bot's prompt.
pub const PHONE_HINT: &str = "A shared iPhone simulator (Deck's Phone tab) is available for building and testing iPhone apps. Before using it, run: \"$APEX_DECK_BIN\" phone help\n";

/// The socket file name inside the daemon's data folder. The daemon
/// listens on it, and a test there checks the two names match.
pub const DAEMON_SOCKET: &str = "daemon.sock";

/// The variables to start this agent's process with. Empty when Deck's
/// command line is off or this agent does not use it. The socket reaches only
/// Full agents: any process holding it can call every open command.
pub fn deck_vars(deck: Option<&DeckEnv>, config: &ParticipantConfig) -> Vec<(&'static str, OsString)> {
    let Some(deck) = deck.filter(|_| config.has_deck_cli()) else { return Vec::new() };
    let mut vars = vec![
        ("APEX_DECK_BIN", deck.bin.clone().into_os_string()),
        ("APEX_DECK_ROOM", OsString::from(&deck.room)),
        ("APEX_DECK_BOT", OsString::from(config.id.as_str())),
        ("APEX_DECK_BOT_NAME", OsString::from(&config.display_name)),
    ];
    if matches!(config.access, Access::Full) {
        vars.insert(1, ("APEX_DECK_PHONE_SOCKET", deck.socket.clone().into_os_string()));
    }
    vars
}

/// Codex filters inherited variables before running shell commands. Keep the
/// Deck values explicitly, without broadening the person's env policy.
pub(crate) fn codex_shell_flags(deck: Option<&DeckEnv>, config: &ParticipantConfig) -> Vec<String> {
    if !matches!(config.backend, Backend::Agent { tool: AgentTool::Codex, .. }) { return Vec::new(); }
    deck_vars(deck, config).into_iter().flat_map(|(name, value)| {
        let quoted = serde_json::to_string(&value.to_string_lossy()).expect("an environment string serializes");
        ["-c".into(), format!("shell_environment_policy.set.{name}={quoted}")]
    }).collect()
}

/// `system` with the phone line added, when this agent has the phone: the
/// Deck command line on a machine with the simulator.
pub fn with_hint(system: &str, deck: Option<&DeckEnv>, config: &ParticipantConfig) -> String {
    if deck.is_some_and(|deck| deck.simulator) && config.has_deck_cli() {
        format!("{system}\n{PHONE_HINT}")
    } else {
        system.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{AgentTool, Backend, ParticipantConfig, ParticipantId};

    fn bot(tool: AgentTool, access: Access) -> ParticipantConfig {
        let mut config: ParticipantConfig = serde_json::from_value(serde_json::json!({"id": "jig", "display_name": "Jigga", "backend": {"kind": "scripted", "lines": []}})).unwrap();
        config.backend = Backend::Agent { tool, model: None };
        config.id = ParticipantId::new("jig");
        config.access = access;
        config
    }
    fn env(simulator: bool) -> DeckEnv { DeckEnv { bin: "/A/apex-daemon".into(), socket: "/D/daemon.sock".into(), room: "room-1".into(), simulator } }
    fn names(vars: &[(&'static str, OsString)]) -> Vec<&'static str> { vars.iter().map(|(name, _)| *name).collect() }

    #[test]
    fn the_socket_reaches_only_full_agents() {
        let os = |text: &str| OsString::from(text);
        let vars = deck_vars(Some(&env(true)), &bot(AgentTool::ClaudeCode, Access::Full));
        assert_eq!(vars, vec![("APEX_DECK_BIN", os("/A/apex-daemon")), ("APEX_DECK_PHONE_SOCKET", os("/D/daemon.sock")),
            ("APEX_DECK_ROOM", os("room-1")), ("APEX_DECK_BOT", os("jig")), ("APEX_DECK_BOT_NAME", os("Jigga"))]);
        for access in [Access::Read, Access::Ask, Access::Edits] {
            let lower = deck_vars(Some(&env(true)), &bot(AgentTool::ClaudeCode, access));
            assert_eq!(names(&lower), vec!["APEX_DECK_BIN", "APEX_DECK_ROOM", "APEX_DECK_BOT", "APEX_DECK_BOT_NAME"], "{access:?}");
        }
    }

    #[test]
    fn deck_variables_are_set_without_the_simulator_and_the_phone_line_only_with_it() {
        let full = bot(AgentTool::Codex, Access::Full);
        assert_eq!(deck_vars(Some(&env(false)), &full), deck_vars(Some(&env(true)), &full), "the task command works where there is no simulator");
        assert!(deck_vars(None, &full).is_empty());
        assert_eq!(with_hint("You are Jigga.\n", Some(&env(true)), &full), format!("You are Jigga.\n\n{PHONE_HINT}"));
        assert_eq!(with_hint("You are Jigga.\n", Some(&env(false)), &full), "You are Jigga.\n");
        assert_eq!(with_hint("You are Jigga.\n", None, &full), "You are Jigga.\n");
    }

    #[test]
    fn only_claude_code_and_codex_get_the_variables() {
        for tool in [AgentTool::ClaudeCode, AgentTool::Codex] {
            assert_eq!(deck_vars(Some(&env(false)), &bot(tool, Access::Full)).len(), 5, "{tool:?}");
        }
        for tool in [AgentTool::Gemini, AgentTool::Grok, AgentTool::Muse] {
            assert!(deck_vars(Some(&env(true)), &bot(tool, Access::Full)).is_empty(), "{tool:?}");
            assert_eq!(with_hint("x\n", Some(&env(true)), &bot(tool, Access::Full)), "x\n", "{tool:?}");
        }
        let mut api = bot(AgentTool::ClaudeCode, Access::Full);
        api.backend = Backend::OpenAiCompatible { base_url: "http://test.invalid".into(), model: "m".into(), api_key_env: None };
        assert!(deck_vars(Some(&env(true)), &api).is_empty());
    }

    #[test]
    fn codex_shell_settings_keep_only_the_deck_variables() {
        let flags = codex_shell_flags(Some(&env(false)), &bot(AgentTool::Codex, Access::Full));
        assert_eq!(flags.len(), 10);
        assert_eq!(&flags[..2], &["-c", "shell_environment_policy.set.APEX_DECK_BIN=\"/A/apex-daemon\""]);
        assert!(flags.contains(&"shell_environment_policy.set.APEX_DECK_BOT_NAME=\"Jigga\"".to_string()));
        assert!(codex_shell_flags(None, &bot(AgentTool::Codex, Access::Full)).is_empty());
        assert!(codex_shell_flags(Some(&env(true)), &bot(AgentTool::ClaudeCode, Access::Full)).is_empty());
        let lower_flags = codex_shell_flags(Some(&env(true)), &bot(AgentTool::Codex, Access::Ask));
        assert_eq!(lower_flags.len(), 8);
        assert!(!lower_flags.iter().any(|f| f.contains("APEX_DECK_PHONE_SOCKET")));
    }
}
