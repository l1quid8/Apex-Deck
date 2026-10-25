//! Turning single tool calls from the Claude Code and Codex feeds into
//! structured work steps and to-do lists. The reader in `events.rs` keeps
//! the state between events; everything here looks at one event at a time.
//! Field shapes: tests/fixtures/work_steps/probe-notes.md.

use std::collections::HashMap;

use apex_core::work_steps::{
    STEPS_PER_REPLY_MAX, cut_detail, cut_output, StepKind, StepStatus, TodoItem, TodoStatus,
    WorkStep,
};
use serde_json::Value;

use crate::step_labels::{codex_label, folder_note, split_cd, unwrap_shell};

/// Longest step label, in characters, counting the closing "…".
const MAX_LABEL: usize = 120;

/// `text` cut to `MAX_LABEL` characters.
pub(crate) fn cap_label(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_LABEL {
        return text.to_string();
    }
    let head: String = text.chars().take(MAX_LABEL - 1).collect();
    format!("{head}…")
}

/// The first line that has something on it.
fn first_line(text: &str) -> &str {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
}

fn file_name(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

fn running(key: &str, parent: Option<&str>, kind: StepKind, label: &str, detail: &str) -> WorkStep {
    WorkStep {
        key: key.to_string(),
        parent: parent.map(str::to_string),
        kind,
        label: cap_label(label),
        folder: None,
        detail: cut_detail(detail),
        output: None,
        status: StepStatus::Running,
        exit_code: None,
        duration_ms: None,
        output_cut: false,
    }
}

/// Some(cut output) when there is any output at all.
fn output(text: &str) -> Option<String> {
    (!text.is_empty()).then(|| cut_output(text))
}

fn todo_status(status: &str) -> Option<TodoStatus> {
    match status {
        "pending" => Some(TodoStatus::Pending),
        "in_progress" | "inProgress" => Some(TodoStatus::InProgress),
        "completed" => Some(TodoStatus::Completed),
        "cancelled" | "canceled" => Some(TodoStatus::Cancelled),
        _ => None,
    }
}

/// A string or number field as text: task ids come as either.
fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

// ----------------------------------------------------------------- Claude

/// Claude Code tools that keep the to-do list. Their calls are not work.
pub(crate) fn claude_todo_tool(name: &str) -> bool {
    matches!(name, "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskGet" | "TaskList")
}

/// The step a Claude Code tool call starts. `cwd` is the room folder.
pub(crate) fn claude_step(
    id: &str,
    parent: Option<&str>,
    tool: &str,
    input: &Value,
    cwd: Option<&str>,
) -> WorkStep {
    let field = |key: &str| input[key].as_str().map(str::trim).filter(|s| !s.is_empty());
    let path = field("file_path").or(field("notebook_path")).or(field("path"));
    let named = |verb: &str| match path {
        Some(p) => format!("{verb} {}", file_name(p)),
        None => verb.to_string(),
    };
    match tool {
        "Bash" => {
            let command = field("command").unwrap_or("");
            let (dir, rest) = split_cd(command);
            let label = match first_line(rest) {
                "" => "Bash",
                line => line,
            };
            let mut step = running(id, parent, StepKind::Command, label, command);
            step.folder = dir.and_then(|d| folder_note(d, cwd));
            step
        }
        "Read" => running(id, parent, StepKind::Read, &named("Read"), path.unwrap_or("")),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            running(id, parent, StepKind::Edit, &named("Edit"), path.unwrap_or(""))
        }
        "WebFetch" => {
            let url = field("url").unwrap_or("");
            running(id, parent, StepKind::Web, &format!("Fetch {url}"), url)
        }
        "WebSearch" => {
            let query = field("query").unwrap_or("");
            running(id, parent, StepKind::Web, &format!("Search the web for {query}"), query)
        }
        "Agent" | "Task" => {
            let label = field("description").unwrap_or("Helper");
            let detail = field("prompt").unwrap_or(label);
            running(id, parent, StepKind::Helper, label, detail)
        }
        _ => {
            let main = ["pattern", "query", "command", "url", "file_path", "path", "description"]
                .iter()
                .find_map(|key| field(key));
            let label = match main {
                Some(main) => format!("{tool} {}", first_line(main)),
                None => tool.to_string(),
            };
            let detail = match input {
                Value::Null => String::new(),
                Value::Object(map) if map.is_empty() => String::new(),
                _ => serde_json::to_string(input).unwrap_or_default(),
            };
            running(id, parent, StepKind::Tool, &label, &detail)
        }
    }
}

/// The text of a Claude Code `tool_result`: a string, or a list of blocks
/// of which only the text ones are kept.
pub(crate) fn claude_result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A step with the result of its tool call filled in.
pub(crate) fn with_output(mut step: WorkStep, text: &str, status: StepStatus) -> WorkStep {
    step.output = output(text);
    step.status = status;
    step
}

/// A `TodoWrite` call's whole list.
pub(crate) fn todo_write(input: &Value) -> Vec<TodoItem> {
    input["todos"]
        .as_array()
        .map(|todos| {
            todos
                .iter()
                .filter_map(|t| {
                    Some(TodoItem {
                        text: t["content"].as_str().or(t["subject"].as_str())?.to_string(),
                        status: todo_status(t["status"].as_str().unwrap_or("pending"))?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ------------------------------------------------------------------- Grok

/// Grok's to-do tool. It reaches Deck through the Claude Code reader, but
/// it hands the list back in the result rather than in the call.
pub(crate) fn grok_todo_tool(name: &str) -> bool {
    name == "todo_write"
}

/// A Grok `todo_write` result as a whole list. The result text is JSON,
/// `{"type":"Todo","TodosUpdated":{"todos":[{"content","priority","status"}]}}`.
/// It is always the merged list, even when the call sent only the items
/// that changed, so the result is the one to read.
pub(crate) fn grok_todos(text: &str) -> Option<Vec<TodoItem>> {
    let value: Value = serde_json::from_str(text.trim()).ok()?;
    let todos = value["TodosUpdated"]["todos"].as_array()?;
    Some(
        todos
            .iter()
            .filter_map(|t| {
                let text = t["content"].as_str().or(t["text"].as_str())?.trim();
                let status = todo_status(t["status"].as_str()?)?;
                (!text.is_empty()).then(|| TodoItem { text: text.to_string(), status })
            })
            .collect(),
    )
}

/// The id `TaskCreate` gave its task: from the structured result, or from
/// its text, "Task #<id> created ...".
pub(crate) fn created_task_id(result: &Value, text: &str) -> Option<String> {
    id_text(&result["task"]["id"]).or_else(|| {
        let rest = &text[text.find("Task #")? + "Task #".len()..];
        let id: String = rest.chars().take_while(|c| !c.is_whitespace() && *c != ':').collect();
        (!id.is_empty()).then_some(id)
    })
}

/// Fold one finished `TaskCreate` / `TaskUpdate` call into the list kept
/// as (task id, item). True if the list changed.
pub(crate) fn fold_task(
    tasks: &mut Vec<(String, TodoItem)>,
    tool: &str,
    input: &Value,
    result: &Value,
    text: &str,
) -> bool {
    let subject = input["subject"].as_str().map(str::trim).filter(|s| !s.is_empty());
    match tool {
        "TaskCreate" => {
            let (Some(id), Some(subject)) = (created_task_id(result, text), subject) else {
                return false;
            };
            tasks.push((id, TodoItem { text: subject.to_string(), status: TodoStatus::Pending }));
            true
        }
        "TaskUpdate" => {
            let Some(id) = id_text(&input["taskId"]) else {
                return false;
            };
            let Some(at) = tasks.iter().position(|(t, _)| *t == id) else {
                return false;
            };
            let status = input["status"].as_str();
            if status == Some("deleted") {
                tasks.remove(at);
                return true;
            }
            let before = tasks[at].1.clone();
            let item = &mut tasks[at].1;
            if let Some(status) = status.and_then(todo_status) {
                item.status = status;
            }
            if let Some(subject) = subject {
                item.text = subject.to_string();
            }
            *item != before
        }
        _ => false,
    }
}

// ------------------------------------------------------------------ Codex

/// The step for a Codex app server item, or `None` for items that are not
/// work (messages, reasoning, plans). `done` is true on `item/completed`.
pub(crate) fn codex_step(
    item: &Value,
    parent: Option<&str>,
    cwd: Option<&str>,
    done: bool,
) -> Option<WorkStep> {
    let key = item["id"].as_str()?;
    let text = |key: &str| item[key].as_str().map(str::trim).filter(|s| !s.is_empty());
    let mut step = match item["type"].as_str()? {
        "commandExecution" => {
            let command = item["command"].as_str().unwrap_or("");
            let short = |c: &str| first_line(c).to_string();
            let (kind, label) = codex_label(command, &item["commandActions"], &short);
            let mut step = running(key, parent, kind, &label, &unwrap_shell(command));
            step.folder = text("cwd").and_then(|dir| folder_note(dir, cwd));
            if done {
                step.output = item["aggregatedOutput"].as_str().and_then(output);
                step.exit_code = item["exitCode"].as_i64().and_then(|c| i32::try_from(c).ok());
                step.duration_ms = item["durationMs"].as_u64();
            }
            step
        }
        "fileChange" => {
            let paths: Vec<&str> = item["changes"]
                .as_array()
                .map(|c| c.iter().filter_map(|c| c["path"].as_str()).collect())
                .unwrap_or_default();
            let mut label = format!(
                "Edit {}",
                paths.iter().take(3).map(|p| file_name(p)).collect::<Vec<_>>().join(", ")
            );
            if paths.len() > 3 {
                label.push_str(&format!(" +{} more", paths.len() - 3));
            }
            let mut step = running(key, parent, StepKind::Edit, &label, &paths.join("\n"));
            if done {
                let diffs: Vec<&str> = item["changes"]
                    .as_array()
                    .map(|c| c.iter().filter_map(|c| c["diff"].as_str()).collect())
                    .unwrap_or_default();
                step.output = output(&diffs.join("\n"));
            }
            step
        }
        "webSearch" => {
            let query = text("query").unwrap_or("");
            let label = match query {
                "" => "Search the web".to_string(),
                q => format!("Search the web for {q}"),
            };
            running(key, parent, StepKind::Web, &label, query)
        }
        "mcpToolCall" => {
            let label = format!("{} {}", text("server").unwrap_or(""), text("tool").unwrap_or(""));
            let label = match label.trim() {
                "" => "MCP tool",
                l => l,
            };
            let detail = match &item["arguments"] {
                Value::Null => String::new(),
                args => serde_json::to_string(args).unwrap_or_default(),
            };
            let mut step = running(key, parent, StepKind::Tool, label, &detail);
            if done {
                let said = item["error"]["message"].as_str().map(str::to_string).or_else(|| {
                    let result = &item["result"];
                    let texts = claude_result_text(&result["content"]);
                    match (texts.is_empty(), result) {
                        (false, _) => Some(texts),
                        (true, Value::Null) => None,
                        (true, other) => serde_json::to_string(other).ok(),
                    }
                });
                step.output = said.as_deref().and_then(output);
            }
            step
        }
        _ => return None,
    };
    if done {
        step.status = codex_status(item);
    }
    Some(step)
}

/// How a finished Codex item ended.
fn codex_status(item: &Value) -> StepStatus {
    match item["status"].as_str() {
        Some("failed") => StepStatus::Failed,
        Some("declined" | "interrupted" | "cancelled" | "canceled") => StepStatus::Stopped,
        _ if item["exitCode"].as_i64().is_some_and(|c| c != 0) => StepStatus::Failed,
        _ => StepStatus::Done,
    }
}

/// The box for a Codex helper, named after the last part of its agent
/// path (Codex gives no task text).
pub(crate) fn codex_helper_step(thread: &str, path: Option<&str>) -> WorkStep {
    let label = path.map(file_name).filter(|l| !l.is_empty()).unwrap_or("Helper");
    running(thread, None, StepKind::Helper, label, path.unwrap_or(""))
}

/// A Codex `turn/plan/updated` plan as a to-do list.
pub(crate) fn codex_plan(plan: &Value) -> Vec<TodoItem> {
    plan.as_array()
        .map(|steps| {
            steps
                .iter()
                .filter_map(|s| {
                    Some(TodoItem {
                        text: s["step"].as_str()?.to_string(),
                        status: todo_status(s["status"].as_str()?)?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// -------------------------------------------------------------------- Muse

/// The step a Muse `toolCall` item starts, or `None` for items that are
/// not work. `write_todos` keeps the to-do list instead of a step. `item`
/// is a notification's `params.item`; `cwd` is the room folder.
pub(crate) fn muse_step(item: &Value, cwd: Option<&str>) -> Option<WorkStep> {
    let key = item["itemId"].as_str()?;
    let tool = item["tool"].as_str().unwrap_or("");
    if tool == "write_todos" {
        return None;
    }
    let args: Value = item["args"]
        .as_str()
        .and_then(|a| serde_json::from_str(a).ok())
        .unwrap_or(Value::Null);
    let arg = |name: &str| args[name].as_str().map(str::trim).filter(|s| !s.is_empty());
    let path = arg("path").or(arg("file_path"));
    let named = |verb: &str| match path {
        Some(p) => format!("{verb} {}", file_name(p)),
        None => verb.to_string(),
    };
    match tool {
        "bash" | "shell" => {
            let command = arg("command").unwrap_or("");
            let (dir, rest) = split_cd(command);
            let label = match first_line(rest) {
                "" => "Bash",
                line => line,
            };
            let mut step = running(key, None, StepKind::Command, label, command);
            step.folder = dir.and_then(|d| folder_note(d, cwd));
            Some(step)
        }
        "read_file" => Some(running(key, None, StepKind::Read, &named("Read"), path.unwrap_or(""))),
        "search" => {
            let pattern = arg("pattern").or(arg("query")).unwrap_or("");
            let label = match pattern.is_empty() {
                true => "Search".to_string(),
                false => format!("Search {}", first_line(pattern)),
            };
            Some(running(key, None, StepKind::Search, &label, pattern))
        }
        "edit_file" | "write_file" => {
            Some(running(key, None, StepKind::Edit, &named("Edit"), path.unwrap_or("")))
        }
        "web_search" | "web_fetch" => {
            let target = arg("url").or(arg("query")).unwrap_or("");
            let label = match (tool, target.is_empty()) {
                ("web_fetch", false) => format!("Fetch {target}"),
                (_, false) => format!("Search the web for {target}"),
                _ => "Search the web".to_string(),
            };
            Some(running(key, None, StepKind::Web, &label, target))
        }
        "workflow" => {
            let name = arg("name").unwrap_or("Helper");
            let detail = arg("script").or(arg("prompt")).unwrap_or(name);
            Some(running(key, None, StepKind::Helper, name, detail))
        }
        _ => {
            let main = ["command", "pattern", "query", "url", "path", "description"]
                .iter()
                .find_map(|name| arg(name));
            let label = match main {
                Some(main) => format!("{tool} {}", first_line(main)),
                None if tool.is_empty() => "Tool".to_string(),
                None => tool.to_string(),
            };
            let detail = match &args {
                Value::Null => String::new(),
                _ => serde_json::to_string(&args).unwrap_or_default(),
            };
            Some(running(key, None, StepKind::Tool, &label, &detail))
        }
    }
}

/// A finished Muse `toolCall` item's output text and exit code. Bash output
/// is the `output` field inside the pretty-printed `visibleOutput` JSON;
/// a failed helper reports its `failureReason`; everything else is
/// `visibleOutput` as is.
fn muse_output(tool: &str, item: &Value) -> (String, Option<i32>) {
    let visible = item["visibleOutput"].as_str().unwrap_or("");
    match tool {
        "bash" | "shell" => match serde_json::from_str::<Value>(visible) {
            Ok(parsed) => (
                parsed["output"].as_str().unwrap_or("").to_string(),
                parsed["exit_code"].as_i64().and_then(|c| i32::try_from(c).ok()),
            ),
            Err(_) => (visible.to_string(), None),
        },
        _ if item["status"] == "failed" => (
            item["failureReason"].as_str().unwrap_or(visible).to_string(),
            None,
        ),
        _ => (visible.to_string(), None),
    }
}

/// The running steps of one Muse turn, keyed by `itemId`. Feeds one
/// notification at a time; `item/updated` and `item/delta` never change
/// anything visible because the final output comes from `item/completed`.
pub(crate) struct MuseSteps {
    cwd: Option<String>,
    open: HashMap<String, WorkStep>,
    seen: std::collections::HashSet<String>,
}

impl MuseSteps {
    pub(crate) fn new(cwd: Option<String>) -> Self {
        Self { cwd, open: HashMap::new(), seen: std::collections::HashSet::new() }
    }

    /// Fold one notification into steps. Returns the new or updated steps
    /// to report, if any. `method` is the JSON-RPC notification name and
    /// `params` its params.
    pub(crate) fn notice(&mut self, method: &str, params: &Value) -> Vec<WorkStep> {
        let item = &params["item"];
        if item["kind"] != "toolCall" {
            return Vec::new();
        }
        match method {
            "item/started" => {
                let Some(step) = muse_step(item, self.cwd.as_deref()) else {
                    return Vec::new();
                };
                // A repeated start, even for a finished step, is a duplicate.
                // Past the cap a new key is neither kept nor sent.
                if self.seen.contains(&step.key) || self.seen.len() >= STEPS_PER_REPLY_MAX {
                    return Vec::new();
                }
                self.seen.insert(step.key.clone());
                self.open.insert(step.key.clone(), step.clone());
                vec![step]
            }
            "item/completed" => {
                let key = match item["itemId"].as_str() {
                    Some(key) => key,
                    None => return Vec::new(),
                };
                if item["tool"] == "write_todos" {
                    return Vec::new();
                }
                match self.open.remove(key) {
                    Some(open) => {
                        let tool = item["tool"].as_str().unwrap_or("");
                        let (text, exit_code) = muse_output(tool, item);
                        let mut done = open;
                        done.output = output(&text);
                        done.exit_code = exit_code;
                        done.status = match item["status"].as_str() {
                            Some("failed") => StepStatus::Failed,
                            _ => StepStatus::Done,
                        };
                        vec![done]
                    }
                    None => Vec::new(),
                }
            }
            _ => Vec::new(),
        }
    }

    /// A `session/todoListChanged` notification's list, whole. A cancelled
    /// step stays in the list, marked as called off; unknown statuses are
    /// dropped.
    pub(crate) fn todos(params: &Value) -> Option<Vec<TodoItem>> {
        let items = params["items"].as_array()?;
        Some(
            items
                .iter()
                .filter_map(|t| {
                    Some(TodoItem {
                        text: t["text"].as_str()?.to_string(),
                        status: todo_status(t["status"].as_str()?)?,
                    })
                })
                .collect(),
        )
    }

    /// Close every still-running step with `status`: the turn is over, so
    /// nothing may be left spinning.
    pub(crate) fn finish(&mut self, status: StepStatus) -> Vec<WorkStep> {
        self.open
            .drain()
            .map(|(_, step)| WorkStep { status, ..step })
            .collect()
    }
}
