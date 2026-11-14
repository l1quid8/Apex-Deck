use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRow {
    pub key: String,
    pub label: String,
    pub detail: String,
    pub surfaces: Vec<String>,
    pub handler: HandlerId,
    pub argument_mode: String,
    pub scope: String,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HandlerId {
    Attach,
    Detach,
    Setup,
    Threads,
    New,
    Rename,
    Add,
    Remove,
    Agents,
    Stop,
    Model,
    Access,
    Clear,
    Compact,
    Curate,
    CurateUndo,
    Goal,
    Loop,
    Plan,
    Usage,
    Help,
    Diff,
    Fork,
    Export,
    ExportJson,
    Image,
}
pub fn catalog() -> Result<Vec<CatalogRow>, String> {
    let rows: Vec<CatalogRow> =
        serde_json::from_str(include_str!("../../../shared/composer-commands.json"))
            .map_err(|e| e.to_string())?;
    let mut keys = std::collections::HashSet::new();
    for row in &rows {
        if !keys.insert(&row.key) {
            return Err("Duplicate catalog command".into());
        }
    }
    Ok(rows
        .into_iter()
        .filter(|r| r.surfaces.iter().any(|s| s == "cli"))
        .collect())
}
#[derive(Debug, PartialEq, Eq)]
pub enum ParsedInput {
    Message(String),
    Command { key: String, args: String },
    Unknown(String),
}
pub fn parse_input(text: &str) -> ParsedInput {
    let text = text.trim();
    if text.starts_with("//") {
        return ParsedInput::Message(text[1..].into());
    }
    let mut rows = catalog().expect("validated embedded catalog");
    rows.sort_by_key(|r| std::cmp::Reverse(r.key.len()));
    let lower = text.to_lowercase();
    for row in rows {
        let prefix = format!("/{}", row.key);
        if lower == prefix
            || lower
                .strip_prefix(&prefix)
                .is_some_and(|rest| rest.starts_with(char::is_whitespace))
        {
            return ParsedInput::Command {
                key: row.key,
                args: text[prefix.len()..].trim().into(),
            };
        }
    }
    if let Some(after) = text.strip_prefix('/') {
        let word = after.split_whitespace().next().unwrap_or("");
        if !word.is_empty()
            && word.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return ParsedInput::Unknown(format!("/{word}"));
        }
    }
    ParsedInput::Message(text.into())
}
pub fn runner_input(kind: &str, arg: &str) -> Result<Value, String> {
    let arg = arg.trim();
    if arg.is_empty() {
        return Ok(json!({"action":"show"}));
    }
    if ["pause", "resume", "clear"].contains(&arg.to_lowercase().as_str()) {
        return Ok(json!({"action":arg.to_lowercase()}));
    }
    let text = if arg.eq_ignore_ascii_case("start") {
        ""
    } else if arg
        .get(..5)
        .is_some_and(|s| s.eq_ignore_ascii_case("start"))
        && arg[5..].starts_with(char::is_whitespace)
    {
        arg[5..].trim()
    } else {
        arg
    };
    if kind == "goal" {
        if text.is_empty() {
            return Err("Goal objective required after \"start\"".into());
        }
        return Ok(json!({"objective":text}));
    }
    if text.is_empty() {
        return Err("Loop interval and prompt required, e.g. /loop 10m check build".into());
    }
    let (interval, prompt) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    let invalid = || format!("Invalid interval \"{interval}\": expected <number><s|m|h>, e.g. 10m");
    let split = interval
        .find(|c: char| !c.is_ascii_digit())
        .filter(|n| *n > 0)
        .ok_or_else(invalid)?;
    let multiplier = match interval[split..].to_lowercase().as_str() {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        _ => return Err(invalid()),
    };
    let n = interval[..split]
        .parse::<u64>()
        .map_err(|_| format!("Interval \"{interval}\" too long: maximum 24h"))?;
    if n == 0 {
        return Err(format!(
            "Invalid interval \"{interval}\": must be positive integer"
        ));
    }
    let seconds = n
        .checked_mul(multiplier)
        .ok_or_else(|| format!("Interval \"{interval}\" too long: maximum 24h"))?;
    if seconds < 10 {
        return Err(format!("Interval \"{interval}\" too short: minimum 10s"));
    }
    if seconds > 86400 {
        return Err(format!("Interval \"{interval}\" too long: maximum 24h"));
    }
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Loop prompt required after interval, e.g. /loop 10m check build".into());
    }
    Ok(json!({"prompt":prompt,"intervalSeconds":seconds}))
}
