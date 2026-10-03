//! Models a tool reports for the account it is signed in to.
//!
//! The interface ships with a list of known model names for each tool, but
//! what an account can actually use changes more often than Apex Deck is
//! released. Where a tool keeps its own list on disk, this reads it so the
//! picker shows what that install really offers. Nothing here starts a
//! process or makes a request, and every failure just means "nothing found".

use std::path::PathBuf;

use apex_core::{AgentTool, ModelChoice};
use serde_json::Value;

/// The models `tool` lists for this computer's account, best first. Empty
/// when the tool keeps no list, has never been run, or the list cannot be
/// read; the interface then falls back to its built-in names.
pub fn installed_models(tool: AgentTool) -> Vec<ModelChoice> {
    match tool {
        AgentTool::Codex => codex_home()
            .and_then(|home| std::fs::read_to_string(home.join("models_cache.json")).ok())
            .map(|text| codex_models_from_cache(&text))
            .unwrap_or_default(),
        // Claude Code and Gemini CLI keep no list of models on disk.
        AgentTool::ClaudeCode | AgentTool::Gemini => Vec::new(),
    }
}

/// Where Codex keeps its settings: `$CODEX_HOME`, or `.codex` in the home
/// folder.
fn codex_home() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".codex"))
}

/// Read the model list Codex saves after it asks the server what the
/// signed-in account may use.
///
/// The file is Codex's own and its layout is not a promise, so this takes
/// only what it recognises: a `models` list whose entries have a `slug`,
/// and optionally a display name, a priority, a visibility, and the effort
/// levels the model accepts. Entries Codex hides from its own picker are
/// left out.
pub fn codex_models_from_cache(json: &str) -> Vec<ModelChoice> {
    let Ok(root) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    let Some(models) = root.get("models").and_then(Value::as_array) else { return Vec::new() };

    let mut found: Vec<(i64, ModelChoice)> = Vec::new();
    for model in models {
        let Some(id) = model.get("slug").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        let visible = model.get("visibility").and_then(Value::as_str).map_or(true, |v| v == "list");
        if !visible || found.iter().any(|(_, m)| m.id == id) {
            continue;
        }
        let label = model
            .get("display_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty() && *name != id)
            .map(str::to_string);
        // Each level is `{ "effort": "low", ... }`; a bare string is accepted too.
        let efforts = model.get("supported_reasoning_levels").and_then(Value::as_array).map(|levels| {
            let mut out: Vec<String> = Vec::new();
            for level in levels {
                let name = level.get("effort").and_then(Value::as_str).or_else(|| level.as_str());
                if let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) {
                    if !out.iter().any(|e| e == name) {
                        out.push(name.to_string());
                    }
                }
            }
            out
        });
        let priority = model.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX);
        found.push((priority, ModelChoice { id: id.to_string(), label, efforts }));
    }
    // Codex shows lower priority numbers first. The sort is stable, so
    // entries without one keep the order of the file.
    found.sort_by_key(|(priority, _)| *priority);
    found.into_iter().map(|(_, model)| model).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listed_models_are_read_with_their_names_and_effort_levels() {
        let json = r#"{
            "fetched_at": "2026-10-01T00:00:00Z",
            "models": [
                { "slug": "model-b", "display_name": "Model B", "visibility": "list", "priority": 2,
                  "supported_reasoning_levels": [ { "effort": "low", "description": "Fast" }, { "effort": "high" } ] },
                { "slug": "model-a", "display_name": "model-a", "visibility": "list", "priority": 1,
                  "supported_reasoning_levels": [] },
                { "slug": "internal", "visibility": "hide", "priority": 0 },
                { "slug": "model-b", "visibility": "list" },
                { "display_name": "No slug" }
            ]
        }"#;
        assert_eq!(
            codex_models_from_cache(json),
            vec![
                ModelChoice { id: "model-a".into(), label: None, efforts: Some(vec![]) },
                ModelChoice {
                    id: "model-b".into(),
                    label: Some("Model B".into()),
                    efforts: Some(vec!["low".into(), "high".into()])
                },
            ]
        );
    }

    #[test]
    fn a_minimal_entry_is_kept_and_its_effort_levels_are_unknown() {
        assert_eq!(
            codex_models_from_cache(r#"{"models":[{"slug":"m"}]}"#),
            vec![ModelChoice { id: "m".into(), label: None, efforts: None }]
        );
    }

    #[test]
    fn anything_unreadable_means_no_models() {
        assert!(codex_models_from_cache("").is_empty());
        assert!(codex_models_from_cache("not json").is_empty());
        assert!(codex_models_from_cache(r#"{"models":"nope"}"#).is_empty());
        assert!(codex_models_from_cache(r#"[1,2,3]"#).is_empty());
    }

    #[test]
    fn tools_without_a_list_on_disk_report_nothing() {
        assert!(installed_models(AgentTool::ClaudeCode).is_empty());
        assert!(installed_models(AgentTool::Gemini).is_empty());
    }
}
