//! Turn-local trusted registration. Configured server names never grant trust.
use apex_core::ComputerTurn;
use serde_json::{json, Value};

pub(crate) const SERVER: &str = "apex-computer";
pub(crate) const ENV_KEYS: [&str; 3] = [
    "APEX_COMPUTER_TURN_TOKEN",
    "APEX_COMPUTER_THREAD_ID",
    "APEX_COMPUTER_PARTICIPANT_ID",
];

pub(crate) fn env(turn: &ComputerTurn) -> Vec<(String, String)> {
    ENV_KEYS
        .into_iter()
        .zip([
            turn.token.clone(),
            turn.thread_id.clone(),
            turn.participant_id.clone(),
        ])
        .map(|(k, v)| (k.into(), v))
        .collect()
}

pub(crate) fn claude_config(turn: &ComputerTurn) -> Value {
    json!({"mcpServers": {SERVER: {"type":"stdio", "command":turn.relay, "args":[]}}})
}

pub(crate) fn trusted_name(name: &str) -> bool {
    matches!(name, "apex-computer" | "apex_computer")
}

pub(crate) fn codex_flags(turn: &ComputerTurn) -> Vec<String> {
    // Pin the bundled executable and arguments. Codex merges table overrides;
    // a pre-existing HTTP server at this reserved name fails configuration
    // validation rather than allowing an untrusted transport to inherit trust.
    let table = format!("mcp_servers.{SERVER}");
    vec![
        "-c".into(),
        format!(
            "{table}={{command={},args=[],enabled=true,env_vars={}}}",
            json!(turn.relay),
            json!(ENV_KEYS)
        ),
        "-c".into(),
        format!(
            "mcp_servers.apex_computer={{command={},args=[],enabled=false}}",
            json!(turn.relay)
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capability_stays_in_child_environment_and_never_launch_flags_or_debug() {
        let turn = ComputerTurn {
            relay: "/A/Unified Computer Use.app/Contents/Helpers/SpikeMCP".into(),
            thread_id: "r".into(),
            participant_id: "p".into(),
            token: "PRIVATE_TURN_TOKEN".into(),
        };
        assert_eq!(
            env(&turn)[0],
            (
                "APEX_COMPUTER_TURN_TOKEN".into(),
                "PRIVATE_TURN_TOKEN".into()
            )
        );
        assert_eq!(
            claude_config(&turn)["mcpServers"][SERVER]["command"],
            turn.relay.to_string_lossy().as_ref()
        );
        assert!(!claude_config(&turn)
            .to_string()
            .contains("PRIVATE_TURN_TOKEN"));
        assert!(!codex_flags(&turn).join(" ").contains("PRIVATE_TURN_TOKEN"));
        let request = apex_core::TurnRequest {
            computer: Some(turn),
            ..Default::default()
        };
        assert!(!format!("{request:?}").contains("PRIVATE_TURN_TOKEN"));
    }
}
