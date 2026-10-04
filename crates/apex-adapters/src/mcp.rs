//! Turn-local MCP approval policy. No config files or credentials are read.
use apex_core::{ActionKind, ProposedAction};
use serde_json::{json, Value};

const RISKY: &[&str] = &["order", "trade", "buy", "sell", "swap", "transfer", "withdraw", "deposit", "leverage", "cancel", "post", "tweet", "publish", "send", "reply", "delete", "exercise"];

pub(crate) fn needs_approval(tool: &str) -> bool {
    let name = tool.to_ascii_lowercase();
    RISKY.iter().any(|word| name.contains(word))
}

pub(crate) fn claude_tool(tool: &str) -> Option<(&str, &str)> {
    tool.strip_prefix("mcp__")?.split_once("__")
}

pub(crate) fn action(server: &str, tool: &str, arguments: &Value) -> ProposedAction {
    ProposedAction { kind: ActionKind::Tool, title: format!("{server}: {tool}"), detail: serde_json::to_string_pretty(arguments).expect("JSON value") }
}

/// True when the server reported a startup or listing error.
pub(crate) fn failed(server: &Value) -> bool {
    !server["toolsError"].is_null()
}

/// Overrides only approval policy, never transport or enabled state. All
/// catalog tools prompt at the CLI boundary; Deck releases ordinary reads.
/// Exact tool overrides defeat pre-existing per-tool `approve` settings.
pub(crate) fn codex_policy(servers: &[Value]) -> Result<Value, String> {
    fn key(part: &str) -> Result<&str, String> {
        // Codex splits override paths on dots; quoting creates a literal
        // quote in the key. Reject ambiguous paths instead of misaddressing.
        if part.is_empty() || part.contains('.') || part.chars().any(char::is_control) {
            return Err("MCP policy contains a name Codex cannot safely override".into());
        }
        Ok(part)
    }
    let mut config = json!({"approvals_reviewer":"user",
        "apps._default.default_tools_approval_mode":"prompt",
        "apps._default.approvals_reviewer":"user"});
    for server in servers {
        let name = key(server["name"].as_str().ok_or("MCP inventory has no server name")?)?;
        if failed(server) {
            // A server that failed to start offers no tools now. Keep its
            // default at prompt in case it comes up mid-turn; don't refuse.
            if name == "codex_apps" { return Err("Couldn't list Codex app tools; this turn did not run.".into()); }
            let prefix = match server["pluginId"].as_str() {
                Some(plugin) => format!("plugins.{}.mcp_servers.{name}", key(plugin)?),
                None => format!("mcp_servers.{name}"),
            };
            config[format!("{prefix}.default_tools_approval_mode")] = json!("prompt");
            continue;
        }
        let tools = server["tools"].as_object().ok_or("MCP inventory has no tool catalog")?;
        let prefix = if name == "codex_apps" {
            for (catalog_name, tool) in tools {
                let connector = key(tool["_meta"]["connector_id"].as_str().ok_or("App tool has no connector identity")?)?;
                let tool_name = tool["name"].as_str().unwrap_or(catalog_name);
                if tool_name.is_empty() { return Err("App tool has no tool identity".into()); }
                config[format!("apps.{connector}.default_tools_approval_mode")] = json!("prompt");
                config[format!("apps.{connector}.approvals_reviewer")] = json!("user");
                // Tool names can contain dots. Keep them literal keys in
                // a tools table; a dotted override path would split them.
                config[format!("apps.{connector}.tools")][tool_name]["approval_mode"] = json!("prompt");
            }
            continue;
        } else if let Some(plugin) = server["pluginId"].as_str() {
            format!("plugins.{}.mcp_servers.{name}", key(plugin)?)
        } else {
            format!("mcp_servers.{name}")
        };
        config[format!("{prefix}.default_tools_approval_mode")] = json!("prompt");
        for (name, tool) in tools {
            let tool_name = key(tool["name"].as_str().unwrap_or(name))?;
            config[format!("{prefix}.tools.{tool_name}.approval_mode")] = json!("prompt");
        }
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn risky_names_always_ask_and_plain_reads_do_not() {
        for word in RISKY { assert!(needs_approval(&format!("GET_{}_now", word.to_ascii_uppercase()))); }
        for name in ["get_balance", "list_accounts", "search_products", "get_profile"] { assert!(!needs_approval(name)); }
        assert!(needs_approval("get_open_orders"), "deliberate overmatch");
    }
    #[test]
    fn a_claude_tool_with_double_underscores_keeps_its_risky_prefix() {
        let (server, tool) = claude_tool("mcp__probe__post__read").unwrap();
        assert_eq!(server, "probe");
        assert_eq!(tool, "post__read");
        assert!(needs_approval(tool));
    }
    #[test]
    fn policy_covers_configured_plugin_and_app_tools_without_transport() {
        let servers = vec![json!({"name":"trade", "tools":{"place_order":{"name":"place_order"}},"transport":{"token":"secret"}}), json!({"name":"plugin-server","pluginId":"test@library","tools":{"publish":{"name":"publish"}}}), json!({"name":"codex_apps","tools":{"x.post":{"_meta":{"connector_id":"x-app","_codex_apps":{"resource_uri":"/connector/link/post"}}}}})];
        let config = codex_policy(&servers).unwrap();
        assert_eq!(config["mcp_servers.trade.tools.place_order.approval_mode"], "prompt");
        assert_eq!(config["plugins.test@library.mcp_servers.plugin-server.tools.publish.approval_mode"], "prompt");
        assert_eq!(config["apps.x-app.tools"]["x.post"]["approval_mode"], "prompt");
        assert!(!config.to_string().contains("secret"));
        assert!(!config.to_string().contains("enabled"));
    }
    #[test]
    fn one_failed_server_is_skipped_but_still_asks_and_others_load() {
        let servers = vec![json!({"name":"computer-use","tools":{},"toolsError":"No such file or directory"}), json!({"name":"x-mcp","tools":{"post_tweet":{"name":"post_tweet"}}})];
        let config = codex_policy(&servers).unwrap();
        assert_eq!(config["mcp_servers.computer-use.default_tools_approval_mode"], "prompt");
        assert_eq!(config["mcp_servers.x-mcp.tools.post_tweet.approval_mode"], "prompt");
    }
    #[test]
    fn incomplete_inventory_refuses_instead_of_using_unprotected_tools() {
        assert!(codex_policy(&[json!({"name":"codex_apps","tools":{},"toolsError":"auth needed"})]).is_err());
        assert!(codex_policy(&[json!({"name":"trade"})]).is_err());
        assert!(codex_policy(&[json!({"name":"codex_apps","tools":{"post":{}}})]).is_err());
    }
}
