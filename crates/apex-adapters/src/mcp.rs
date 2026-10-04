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
    ProposedAction { kind: ActionKind::Tool, title: format!("{server}: {tool}"), detail: serde_json::to_string_pretty(arguments).expect("JSON value"), expires_at: None }
}

/// Connected server names from `claude mcp list`. Lines look like
/// `name: target - ✔ Connected`; names may contain colons but not ": ".
pub(crate) fn claude_connected(listing: &str) -> Vec<String> {
    listing.lines()
        .filter(|line| line.trim_end().ends_with("✔ Connected"))
        .filter_map(|line| line.split_once(": ").map(|(name, _)| name.trim().to_owned()))
        .collect()
}

/// True when the server reported a startup or listing error.
pub(crate) fn failed(server: &Value) -> bool {
    !server["toolsError"].is_null()
}

/// One row per plugin identity, standalone server, or connector.
pub(crate) fn menu_names(servers: &[Value], plugins: &Value) -> Vec<apex_core::server_request::ToolServer> {
    use apex_core::server_request::ToolServer;
    use std::collections::BTreeMap;
    fn alias(entry: &mut ToolServer, name: &str) {
        for spelling in [name.to_owned(), name.replace('-', "_"), name.replace('_', "-")] {
            if !spelling.trim().is_empty() && spelling != entry.token && !entry.aliases.contains(&spelling) {
                entry.aliases.push(spelling);
            }
        }
    }
    let mut entries = BTreeMap::<String, ToolServer>::new();
    let mut plugin_keys = BTreeMap::<String, String>::new();
    if let Some(markets) = plugins["marketplaces"].as_array() {
        for plugin in markets.iter().filter_map(|m| m["plugins"].as_array()).flatten() {
            if plugin["installed"] != true || plugin["enabled"] != true { continue; }
            let Some(name) = plugin["name"].as_str().filter(|n| !n.trim().is_empty()) else { continue; };
            let identity = plugin["id"].as_str().or_else(|| plugin["pluginId"].as_str()).unwrap_or(name);
            let key = format!("plugin:{identity}");
            plugin_keys.insert(identity.to_owned(), key.clone());
            // Older plugin/list responses do not include an id.
            if identity == name { plugin_keys.insert(name.to_owned(), key.clone()); }
            let label = plugin["interface"]["displayName"].as_str().unwrap_or(name);
            let entry = entries.entry(key).or_insert_with(|| ToolServer { token: name.into(), label: label.into(), aliases: vec![] });
            alias(entry, name);
            alias(entry, label);
        }
    }
    for server in servers.iter().filter(|s| !failed(s)) {
        let Some(name) = server["name"].as_str().filter(|n| !n.trim().is_empty()) else { continue; };
        if name == "codex_apps" {
            if let Some(tools) = server["tools"].as_object() {
                for tool in tools.values() {
                    let meta = &tool["_meta"];
                    let Some(name) = meta["connector_name"].as_str().or_else(|| meta["connector_id"].as_str()) else { continue; };
                    let identity = meta["connector_id"].as_str().unwrap_or(name);
                    let entry = entries.entry(format!("app:{identity}")).or_insert_with(|| name.to_owned().into());
                    alias(entry, identity);
                }
            }
        } else if let Some(identity) = server["pluginId"].as_str() {
            let plugin_name = identity.split('@').next().unwrap_or(identity);
            let key = plugin_keys.get(identity).or_else(|| plugin_keys.get(plugin_name)).cloned().unwrap_or_else(|| format!("plugin:{identity}"));
            let entry = entries.entry(key).or_insert_with(|| ToolServer { token: plugin_name.into(), label: plugin_name.into(), aliases: vec![] });
            alias(entry, name);
            alias(entry, plugin_name);
        } else {
            entries.entry(format!("server:{name}")).or_insert_with(|| ToolServer { token: name.into(), label: name.into(), aliases: vec![] });
        }
    }
    // A connector can also be advertised as an installed app plugin. The
    // bang namespace addresses both with the exact same token, so retain one
    // row and union their aliases after grouping by the source identities.
    let mut tokens = BTreeMap::<String, ToolServer>::new();
    for entry in entries.into_values() {
        if let Some(existing) = tokens.get_mut(&entry.token) {
            alias(existing, &entry.label);
            for name in &entry.aliases { alias(existing, name); }
        } else { tokens.insert(entry.token.clone(), entry); }
    }
    tokens.into_values().collect()
}

/// What every Codex turn sets, with or without the inventory: ChatGPT apps
/// ask, and the person, not an automatic reviewer, answers. With Deck's
/// hook in place this is the whole policy.
pub(crate) fn base_policy() -> Value {
    json!({"approvals_reviewer":"user",
        "apps._default.default_tools_approval_mode":"prompt",
        "apps._default.approvals_reviewer":"user"})
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
    let mut config = base_policy();
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
    fn plugin_menu_groups_servers_and_display_name_by_plugin_identity() {
        let servers = vec![json!({"name":"native_control", "pluginId":"computer-use@market", "tools":{}}),
            json!({"name":"screen-reader", "pluginId":"computer-use@market", "tools":{}}),
            json!({"name":"standalone", "tools":{}})];
        let plugins = json!({"marketplaces":[{"plugins":[{"id":"computer-use@market", "name":"computer-use",
            "installed":true,"enabled":true,"interface":{"displayName":"Computer Use"}}]}]});
        let entries = serde_json::to_value(menu_names(&servers, &plugins)).unwrap();
        assert_eq!(entries.as_array().unwrap().len(), 2);
        assert_eq!(entries[0]["token"], "computer-use");
        assert_eq!(entries[0]["label"], "Computer Use");
        for alias in ["native_control", "native-control", "screen-reader", "screen_reader", "Computer Use"] {
            assert!(entries[0]["aliases"].as_array().unwrap().contains(&json!(alias)), "{alias}");
        }
        assert_eq!(entries[1], json!({"token":"standalone","label":"standalone","aliases":[]}));
    }
    #[test]
    fn menu_includes_plugin_aliases_and_individual_apps() {
        let servers = vec![json!({"name":"codex_apps","tools":{
            "gmail.read":{"_meta":{"connector_id":"gmail-app","connector_name":"Gmail"}},
            "gmail.search":{"_meta":{"connector_id":"gmail-app","connector_name":"Gmail"}},
            "drive.read":{"_meta":{"connector_id":"drive-app"}}
        }}), json!({"name":"github-server","pluginId":"github@market","tools":{}}),
        json!({"name":"broken","toolsError":"failed"})];
        let plugins = json!({"marketplaces":[{"plugins":[
            {"name":"design","installed":true,"enabled":true},
            {"name":"disabled","installed":true,"enabled":false},
            {"name":"available","installed":false,"enabled":true}
        ]}]});
        assert_eq!(menu_names(&servers, &plugins).iter().map(|e| e.token.as_str()).collect::<Vec<_>>(), vec!["design", "drive-app", "github", "gmail"]);
    }
    #[test]
    fn app_and_installed_plugin_share_one_addressable_token() {
        let servers = vec![json!({"name":"codex_apps", "tools":{
            "gmail.read":{"_meta":{"connector_id":"gmail-id", "connector_name":"Gmail"}}
        }})];
        let plugins = json!({"marketplaces":[{"plugins":[{"id":"gmail@market", "name":"gmail",
            "installed":true,"enabled":true,"interface":{"displayName":"Gmail"}}]}]});
        let entries = menu_names(&servers, &plugins);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].token, "gmail");
        assert!(entries[0].matches("gmail-id"));
        assert!(entries[0].matches("Gmail"));
    }
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
    fn claude_listing_keeps_only_connected_servers() {
        let listing = "Checking MCP server health…\n\nclaude.ai Hyper MCP: https://apex-terminal.xyz/mcp - ✔ Connected\nclaude.ai Canva: https://mcp.canva.com/mcp - ! Needs authentication\nplugin:design:slack: https://mcp.slack.com/mcp (HTTP) - ✔ Connected\nplugin:design:gmail:  (HTTP) - - Not configured\n";
        assert_eq!(claude_connected(listing), ["claude.ai Hyper MCP", "plugin:design:slack"]);
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
