//! Reading the event streams coding agents print in their machine-readable
//! modes.
//!
//! In plain text mode a tool prints only its final answer, and only when it
//! is done. In its event mode it prints one JSON object per line as things
//! happen: pieces of the answer, each tool it uses, the token count, and a
//! proper error when the turn fails. This module turns those lines into the
//! few things the chat needs.
//!
//! The formats belong to the tools and can change, so the reader takes only
//! the fields it recognises and ignores the rest. A line that is not JSON is
//! kept as ordinary text, which means a tool that prints a plain answer
//! still works.

use std::collections::HashMap;

use apex_core::{ActionKind, FileChange, ProposedAction};
use serde_json::Value;

/// How a tool's standard output should be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutputFormat {
    /// Everything printed is the reply.
    Text,
    /// Claude Code with `--output-format stream-json`.
    ClaudeStream,
    /// Codex with `exec --json`. Messages arrive whole, one event each.
    CodexJson,
    /// Codex's app server, which is driven by requests and reports the
    /// reply piece by piece. See `codex_server.rs` for the conversation.
    CodexServer,
}

/// Something to show while a turn is running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Step {
    /// A piece of the reply.
    Text(String),
    /// What the tool is doing right now, such as reading a file.
    Activity(String),
    /// A file the tool has just changed.
    Change(FileChange),
}

/// What a finished stream amounted to.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Outcome {
    /// The reply. Empty if the tool gave none.
    pub text: String,
    /// The tool's own explanation of a failed turn.
    pub error: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

/// Longest activity line shown in the chat.
const MAX_ACTIVITY: usize = 120;

pub(crate) struct EventReader {
    format: OutputFormat,
    /// The workspace folder, so file paths can be shown relative to it.
    cwd: Option<String>,
    /// Bytes of a line that has not ended yet.
    partial: String,
    /// Everything streamed as reply text so far.
    streamed: String,
    /// The reply as the tool states it at the end of the turn.
    final_text: Option<String>,
    /// Where the current message of the reply starts in `streamed`.
    message_start: usize,
    /// True once this message's text has arrived piece by piece, so the
    /// complete copy that follows is not shown twice.
    pieces_seen: bool,
    last_activity: Option<String>,
    /// The message item whose text is arriving piece by piece.
    current_item: Option<String>,
    /// True once the tool has said the turn is over.
    turn_over: bool,
    /// Edits that have been proposed but not yet reported as done, by the
    /// id the tool gave them.
    edits: HashMap<String, Vec<FileChange>>,
    failure: Option<String>,
    /// The last error event. Tools also report retries this way, so it only
    /// counts if the turn ends without a reply.
    last_error: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

impl EventReader {
    pub(crate) fn new(format: OutputFormat, cwd: Option<String>) -> Self {
        Self {
            format,
            cwd,
            partial: String::new(),
            streamed: String::new(),
            final_text: None,
            message_start: 0,
            pieces_seen: false,
            last_activity: None,
            current_item: None,
            turn_over: false,
            edits: HashMap::new(),
            failure: None,
            last_error: None,
            input_tokens: None,
            output_tokens: None,
        }
    }

    /// Add output and return what it produced.
    pub(crate) fn push(&mut self, text: &str) -> Vec<Step> {
        if self.format == OutputFormat::Text {
            self.streamed.push_str(text);
            return if text.is_empty() { Vec::new() } else { vec![Step::Text(text.to_string())] };
        }
        self.partial.push_str(text);
        let mut steps = Vec::new();
        while let Some(end) = self.partial.find('\n') {
            let line: String = self.partial.drain(..=end).collect();
            self.line(line.trim_end_matches(['\n', '\r']), &mut steps);
        }
        steps
    }

    /// The stream has ended; handle a last line with no newline after it.
    pub(crate) fn finish(&mut self) -> Vec<Step> {
        let mut steps = Vec::new();
        let rest = std::mem::take(&mut self.partial);
        if !rest.trim().is_empty() {
            self.line(rest.trim_end_matches('\r'), &mut steps);
        }
        steps
    }

    pub(crate) fn outcome(self) -> Outcome {
        let text = self.final_text.filter(|t| !t.trim().is_empty()).unwrap_or(self.streamed);
        let has_reply = !text.trim().is_empty();
        Outcome {
            error: self.failure.or(if has_reply { None } else { self.last_error }),
            text,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
        }
    }

    /// True once the tool has reported the end of the turn. Only the app
    /// server says so; the other formats end when the program exits.
    pub(crate) fn turn_over(&self) -> bool {
        self.turn_over
    }

    /// Everything shown as reply text so far.
    pub(crate) fn streamed(&self) -> &str {
        &self.streamed
    }

    fn say(&mut self, text: &str, steps: &mut Vec<Step>) {
        if !text.is_empty() {
            self.streamed.push_str(text);
            steps.push(Step::Text(text.to_string()));
        }
    }

    /// Record what the tool is doing, unless it is what was just recorded.
    fn doing(&mut self, line: String, steps: &mut Vec<Step>) {
        let line = clip(&line, MAX_ACTIVITY);
        if self.last_activity.as_deref() != Some(line.as_str()) {
            self.last_activity = Some(line.clone());
            steps.push(Step::Activity(line));
        }
    }

    /// Start a new message of the reply, set apart from the one before it.
    fn new_message(&mut self, steps: &mut Vec<Step>) {
        if !self.streamed.is_empty() && !self.streamed.ends_with("\n\n") {
            let gap = if self.streamed.ends_with('\n') { "\n" } else { "\n\n" };
            self.say(gap, steps);
        }
        self.message_start = self.streamed.len();
        self.pieces_seen = false;
    }

    fn line(&mut self, line: &str, steps: &mut Vec<Step>) {
        if line.trim().is_empty() {
            return;
        }
        let event = match serde_json::from_str::<Value>(line) {
            Ok(value) if value.is_object() => value,
            // Not an event: the tool printed ordinary text.
            _ => {
                let text = format!("{line}\n");
                return self.say(&text, steps);
            }
        };
        match self.format {
            OutputFormat::ClaudeStream => self.claude(&event, steps),
            OutputFormat::CodexJson => self.codex(&event, steps),
            OutputFormat::CodexServer => self.codex_server(&event, steps),
            OutputFormat::Text => {}
        }
    }

    // ------------------------------------------------------------ Claude Code

    fn claude(&mut self, event: &Value, steps: &mut Vec<Step>) {
        // Work done by a helper agent is reported with the id of the tool
        // call that started it. Its text is not part of this reply.
        let own = event.get("parent_tool_use_id").map_or(true, Value::is_null);
        match event["type"].as_str() {
            Some("stream_event") if own => {
                let inner = &event["event"];
                match inner["type"].as_str() {
                    Some("message_start") => self.new_message(steps),
                    Some("content_block_delta") if inner["delta"]["type"] == "text_delta" => {
                        if let Some(text) = inner["delta"]["text"].as_str() {
                            self.pieces_seen = true;
                            self.say(text, steps);
                        }
                    }
                    _ => {}
                }
            }
            Some("assistant") => {
                let Some(blocks) = event["message"]["content"].as_array() else { return };
                for block in blocks {
                    match block["type"].as_str() {
                        Some("tool_use") => {
                            let name = block["name"].as_str().unwrap_or("a tool");
                            let line = self.claude_activity(name, &block["input"]);
                            self.doing(line, steps);
                            // Kept until the tool reports whether the edit
                            // went through; a refused edit changed nothing.
                            let changes = self.claude_changes(name, &block["input"]);
                            if let (Some(id), false) = (block["id"].as_str(), changes.is_empty()) {
                                self.edits.insert(id.to_string(), changes);
                            }
                        }
                        // Without piece-by-piece output the complete message
                        // is the first we see of this text.
                        Some("text") if own && !self.pieces_seen => {
                            if let Some(text) = block["text"].as_str() {
                                if self.streamed.len() > self.message_start {
                                    self.new_message(steps);
                                }
                                self.say(text, steps);
                            }
                        }
                        _ => {}
                    }
                }
            }
            // The outcome of a tool call comes back as a message from "user".
            Some("user") => {
                let Some(blocks) = event["message"]["content"].as_array() else { return };
                for block in blocks.iter().filter(|b| b["type"] == "tool_result") {
                    let done = block["tool_use_id"].as_str().and_then(|id| self.edits.remove(id));
                    if let (Some(changes), false) = (done, block["is_error"].as_bool().unwrap_or(false)) {
                        steps.extend(changes.into_iter().map(Step::Change));
                    }
                }
            }
            Some("result") => {
                self.turn_over = true;
                let text = event["result"].as_str().map(str::to_string);
                if event["is_error"].as_bool().unwrap_or(false) {
                    let listed = event["errors"].as_array().map(|errors| {
                        errors.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" | ")
                    });
                    self.failure = text
                        .filter(|t| !t.trim().is_empty())
                        .or(listed.filter(|l| !l.is_empty()))
                        .or_else(|| Some("the turn ended with an error".to_string()));
                } else {
                    self.final_text = text;
                }
                let usage = &event["usage"];
                let count = |key: &str| usage[key].as_u64();
                if let Some(input) = count("input_tokens") {
                    // Cached input is still input the model was given.
                    let cached = count("cache_creation_input_tokens").unwrap_or(0)
                        + count("cache_read_input_tokens").unwrap_or(0);
                    self.input_tokens = Some(input + cached);
                }
                self.output_tokens = count("output_tokens").or(self.output_tokens);
            }
            _ => {}
        }
    }

    fn claude_activity(&self, tool: &str, input: &Value) -> String {
        let field = |key: &str| input[key].as_str().map(str::trim).filter(|s| !s.is_empty());
        let path = || field("file_path").or(field("notebook_path")).or(field("path")).map(|p| self.short_path(p));
        let line = match tool {
            "Read" => path().map(|p| format!("Reading {p}")),
            "Edit" | "MultiEdit" | "NotebookEdit" => path().map(|p| format!("Editing {p}")),
            "Write" => path().map(|p| format!("Writing {p}")),
            "Bash" => field("command").map(|c| format!("Running: {}", one_line(c))),
            "Grep" => field("pattern").map(|p| format!("Searching for {p}")),
            "Glob" => field("pattern").map(|p| format!("Looking for files matching {p}")),
            "WebFetch" => field("url").map(|u| format!("Fetching {u}")),
            "WebSearch" => field("query").map(|q| format!("Searching the web for {q}")),
            "Task" | "Agent" => field("description").map(|d| format!("Starting a helper: {d}")),
            _ => None,
        };
        line.unwrap_or_else(|| format!("Using {tool}"))
    }

    /// The file changes a Claude Code tool call would make. Empty for tools
    /// that do not change files.
    fn claude_changes(&self, tool: &str, input: &Value) -> Vec<FileChange> {
        let text = |value: &Value| value.as_str().unwrap_or("").to_string();
        let Some(path) = input["file_path"].as_str().or(input["notebook_path"].as_str()) else { return Vec::new() };
        let path = self.short_path(path);
        let diff = match tool {
            "Edit" => replaced(&text(&input["old_string"]), &text(&input["new_string"])),
            "MultiEdit" => input["edits"]
                .as_array()
                .map(|edits| {
                    edits.iter().map(|e| replaced(&text(&e["old_string"]), &text(&e["new_string"]))).collect::<Vec<_>>().join("@@\n")
                })
                .unwrap_or_default(),
            // What was in the file before is not reported, so a written
            // file is shown as all new.
            "Write" => replaced("", &text(&input["content"])),
            "NotebookEdit" => replaced("", &text(&input["new_source"])),
            _ => return Vec::new(),
        };
        vec![FileChange::new(path, diff)]
    }

    /// What a Claude Code permission request is asking for, in a form the
    /// person can judge.
    pub(crate) fn claude_action(&self, tool: &str, input: &Value) -> ProposedAction {
        let changes = self.claude_changes(tool, input);
        if let Some(change) = changes.first() {
            let verb = if tool == "Write" { "Write" } else { "Edit" };
            return ProposedAction {
                kind: ActionKind::Edit,
                title: format!("{verb} {}", change.path),
                detail: changes.iter().map(|c| c.diff.as_str()).collect::<Vec<_>>().join("\n"),
            };
        }
        if tool == "Bash" {
            let command = input["command"].as_str().unwrap_or("").to_string();
            return ProposedAction { kind: ActionKind::Command, title: "Run a command".to_string(), detail: command };
        }
        let detail = serde_json::to_string_pretty(input).unwrap_or_default();
        ProposedAction { kind: ActionKind::Other, title: self.claude_activity(tool, input), detail }
    }

    // ------------------------------------------------------------------ Codex

    fn codex(&mut self, event: &Value, steps: &mut Vec<Step>) {
        let kind = event["type"].as_str().unwrap_or("");
        let item = &event["item"];
        match (kind, item["type"].as_str()) {
            ("item.completed", Some("agent_message")) => {
                if let Some(text) = item["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    self.new_message(steps);
                    self.say(text, steps);
                    // Codex's answer is its last message; earlier ones are
                    // notes on what it is about to do.
                    self.final_text = Some(text.to_string());
                }
            }
            ("item.started", Some("command_execution")) => {
                if let Some(command) = item["command"].as_str() {
                    self.doing(format!("Running: {}", one_line(command)), steps);
                }
            }
            // Reported when the edit starts, when it lands, or both; the
            // repeat is dropped where activity is recorded.
            ("item.started" | "item.completed", Some("file_change")) => {
                self.editing(&item["changes"], steps);
                // This mode names the files that changed but not what changed in them.
                if kind == "item.completed" && item["status"] == "completed" {
                    steps.extend(self.changes_in(&item["changes"]).into_iter().map(Step::Change));
                }
            }
            ("item.started", Some("web_search")) => {
                let query = item["query"].as_str().map(str::trim).filter(|q| !q.is_empty());
                self.doing(query.map_or("Searching the web".to_string(), |q| format!("Searching the web for {q}")), steps);
            }
            ("item.started", Some("mcp_tool_call")) => {
                let server = item["server"].as_str().unwrap_or("a connected tool");
                let tool = item["tool"].as_str().unwrap_or("");
                self.doing(format!("Using {server} {tool}").trim().to_string(), steps);
            }
            ("item.completed", Some("error")) => {
                self.last_error = item["message"].as_str().map(str::to_string).or(self.last_error.take());
            }
            ("turn.completed", _) => {
                let usage = &event["usage"];
                self.input_tokens = usage["input_tokens"].as_u64().or(self.input_tokens);
                self.output_tokens = usage["output_tokens"].as_u64().or(self.output_tokens);
            }
            ("turn.failed", _) => {
                let message = event["error"]["message"].as_str().unwrap_or("the turn failed");
                self.failure = Some(message.to_string());
            }
            ("error", _) => {
                self.last_error = event["message"].as_str().map(str::to_string).or(self.last_error.take());
            }
            _ => {}
        }
    }

    // ------------------------------------------------------- Codex app server

    /// One notification from `codex app-server`. Replies to our own
    /// requests are handled by the caller and never reach this.
    fn codex_server(&mut self, message: &Value, steps: &mut Vec<Step>) {
        let params = &message["params"];
        let item = &params["item"];
        let kind = item["type"].as_str();
        match message["method"].as_str() {
            Some("item/agentMessage/delta") => {
                let id = params["itemId"].as_str().unwrap_or("");
                if self.current_item.as_deref() != Some(id) {
                    self.new_message(steps);
                    self.current_item = Some(id.to_string());
                }
                if let Some(text) = params["delta"].as_str() {
                    self.pieces_seen = true;
                    self.say(text, steps);
                }
            }
            Some("item/started") => match kind {
                Some("commandExecution") => {
                    if let Some(command) = item["command"].as_str() {
                        self.doing(format!("Running: {}", one_line(command)), steps);
                    }
                }
                Some("fileChange") => {
                    self.editing(&item["changes"], steps);
                    // Kept so that a request to approve this edit, which
                    // names only the item, can show what the edit is.
                    if let Some(id) = item["id"].as_str() {
                        self.edits.insert(id.to_string(), self.changes_in(&item["changes"]));
                    }
                }
                Some("webSearch") => {
                    let query = item["query"].as_str().map(str::trim).filter(|q| !q.is_empty());
                    self.doing(query.map_or("Searching the web".to_string(), |q| format!("Searching the web for {q}")), steps);
                }
                Some("mcpToolCall") => {
                    let server = item["server"].as_str().unwrap_or("a connected tool");
                    let tool = item["tool"].as_str().unwrap_or("");
                    self.doing(format!("Using {server} {tool}").trim().to_string(), steps);
                }
                Some("reasoning") => self.doing("Thinking".to_string(), steps),
                _ => {}
            },
            Some("item/completed") => match kind {
                Some("agentMessage") => {
                    let Some(text) = item["text"].as_str().filter(|t| !t.trim().is_empty()) else { return };
                    // If the pieces never came, the whole message is the
                    // first we see of it.
                    let id = item["id"].as_str().unwrap_or("");
                    if !(self.pieces_seen && self.current_item.as_deref() == Some(id)) {
                        self.new_message(steps);
                        self.say(text, steps);
                    }
                    self.current_item = None;
                    self.final_text = Some(text.to_string());
                }
                Some("fileChange") => {
                    self.editing(&item["changes"], steps);
                    if let Some(id) = item["id"].as_str() {
                        self.edits.remove(id);
                    }
                    // A declined or failed edit changed nothing.
                    if item["status"] == "completed" {
                        steps.extend(self.changes_in(&item["changes"]).into_iter().map(Step::Change));
                    }
                }
                _ => {}
            },
            Some("thread/tokenUsage/updated") => {
                // One thread is one turn here, so the thread total is the
                // turn's total.
                let total = &params["tokenUsage"]["total"];
                self.input_tokens = total["inputTokens"].as_u64().or(self.input_tokens);
                self.output_tokens = total["outputTokens"].as_u64().or(self.output_tokens);
            }
            Some("error") => {
                // Retries are reported as errors too; only the last word counts.
                if !params["willRetry"].as_bool().unwrap_or(false) {
                    self.last_error = server_error(&params["error"]).or(self.last_error.take());
                }
            }
            Some("turn/completed") => {
                self.turn_over = true;
                match params["turn"]["status"].as_str() {
                    Some("failed") => {
                        self.failure = server_error(&params["turn"]["error"])
                            .or(self.last_error.take())
                            .or_else(|| Some("the turn failed".to_string()));
                    }
                    Some("interrupted") => self.failure = Some("the turn was interrupted".to_string()),
                    _ => {}
                }
            }
            _ => {}
        }
    }

    /// The edit a Codex approval request refers to, as a diff of every
    /// file in it. `None` if that item was never announced.
    pub(crate) fn pending_edit(&self, item: &str) -> Option<(String, String)> {
        let changes = self.edits.get(item)?;
        let title = match changes.as_slice() {
            [one] => format!("Edit {}", one.path),
            many => format!("Edit {} files", many.len()),
        };
        let detail = changes.iter().map(|c| format!("{}\n{}", c.path, c.diff)).collect::<Vec<_>>().join("\n");
        Some((title, detail))
    }

    /// The files in a Codex `changes` list, each with its diff if given.
    fn changes_in(&self, changes: &Value) -> Vec<FileChange> {
        changes
            .as_array()
            .map(|changes| {
                changes
                    .iter()
                    .filter_map(|c| Some(FileChange::new(self.short_path(c["path"].as_str()?), c["diff"].as_str().unwrap_or(""))))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn editing(&mut self, changes: &Value, steps: &mut Vec<Step>) {
        let paths: Vec<String> = changes
            .as_array()
            .map(|changes| changes.iter().filter_map(|c| c["path"].as_str()).map(|p| self.short_path(p)).collect())
            .unwrap_or_default();
        if !paths.is_empty() {
            self.doing(format!("Editing {}", paths.join(", ")), steps);
        }
    }

    /// `path` relative to the workspace folder when it is inside it.
    fn short_path(&self, path: &str) -> String {
        let inside = self.cwd.as_deref().and_then(|cwd| {
            let rest = path.strip_prefix(cwd.trim_end_matches('/'))?;
            rest.strip_prefix('/').filter(|r| !r.is_empty())
        });
        inside.unwrap_or(path).to_string()
    }
}

/// The message of an app server error, with its detail when the message
/// alone says little (a retry notice, for example).
fn server_error(error: &Value) -> Option<String> {
    let message = error["message"].as_str().map(str::trim).filter(|m| !m.is_empty())?;
    match error["additionalDetails"].as_str().map(str::trim).filter(|d| !d.is_empty()) {
        Some(detail) => Some(format!("{message} ({detail})")),
        None => Some(message.to_string()),
    }
}

/// A replacement of `old` by `new`, as diff lines: each line of `old` with
/// a `-` in front, then each line of `new` with a `+`.
fn replaced(old: &str, new: &str) -> String {
    let mut out = String::new();
    for line in old.lines() {
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    for line in new.lines() {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// A command on one line, for display.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let head: String = text.chars().take(max).collect();
        format!("{head}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(format: OutputFormat, chunks: &[&str]) -> (Vec<Step>, Outcome) {
        let mut reader = EventReader::new(format, Some("/work/project".into()));
        let mut steps = Vec::new();
        for chunk in chunks {
            steps.extend(reader.push(chunk));
        }
        steps.extend(reader.finish());
        (steps, reader.outcome())
    }

    fn text(steps: &[Step]) -> String {
        steps.iter().filter_map(|s| if let Step::Text(t) = s { Some(t.as_str()) } else { None }).collect()
    }

    fn activity(steps: &[Step]) -> Vec<&str> {
        steps.iter().filter_map(|s| if let Step::Activity(a) = s { Some(a.as_str()) } else { None }).collect()
    }

    // The shapes below follow what Claude Code 2.1 and Codex 0.160 print.
    const CLAUDE_TURN: &str = r#"{"type":"system","subtype":"init","model":"claude-sonnet-5-5"}
{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant"}},"parent_tool_use_id":null}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Read"}},"parent_tool_use_id":null}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\""}},"parent_tool_use_id":null}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/work/project/src/notes.txt"}}]},"parent_tool_use_id":null}
{"type":"user","message":{"content":[{"type":"tool_result","content":"hello"}]}}
{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant"}},"parent_tool_use_id":null}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"It says "}},"parent_tool_use_id":null}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello."}},"parent_tool_use_id":null}
{"type":"assistant","message":{"content":[{"type":"text","text":"It says hello."}]},"parent_tool_use_id":null}
{"type":"result","subtype":"success","is_error":false,"result":"It says hello.","usage":{"input_tokens":4,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":12}}
"#;

    #[test]
    fn claude_text_is_streamed_once_with_activity_and_usage() {
        let (steps, outcome) = read(OutputFormat::ClaudeStream, &[CLAUDE_TURN]);
        assert_eq!(text(&steps), "It says hello.");
        assert_eq!(activity(&steps), ["Reading src/notes.txt"]);
        assert_eq!(
            outcome,
            Outcome { text: "It says hello.".into(), error: None, input_tokens: Some(1104), output_tokens: Some(12) }
        );
    }

    #[test]
    fn events_split_across_chunks_are_put_back_together() {
        let (a, b) = CLAUDE_TURN.split_at(CLAUDE_TURN.len() / 2 + 7);
        let (steps, outcome) = read(OutputFormat::ClaudeStream, &[a, b.trim_end()]);
        assert_eq!(text(&steps), "It says hello.");
        assert_eq!(outcome.text, "It says hello.");
        assert_eq!(outcome.output_tokens, Some(12));
    }

    #[test]
    fn claude_text_before_and_after_a_tool_is_shown_as_separate_paragraphs() {
        let stream = r#"{"type":"stream_event","event":{"type":"message_start"}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Let me look."}}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Let me look."},{"type":"tool_use","name":"Bash","input":{"command":"ls\n  -la"}}]}}
{"type":"stream_event","event":{"type":"message_start"}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Two files."}}}
{"type":"result","is_error":false,"result":"Two files."}
"#;
        let (steps, outcome) = read(OutputFormat::ClaudeStream, &[stream]);
        assert_eq!(text(&steps), "Let me look.\n\nTwo files.");
        assert_eq!(activity(&steps), ["Running: ls -la"]);
        // The reply kept in the conversation is the answer, not the lead-in.
        assert_eq!(outcome.text, "Two files.");
    }

    #[test]
    fn claude_without_piece_by_piece_output_still_shows_the_text() {
        let stream = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hi there."}]}}
{"type":"result","is_error":false,"result":"Hi there."}"#;
        let (steps, outcome) = read(OutputFormat::ClaudeStream, &[stream]);
        assert_eq!(text(&steps), "Hi there.");
        assert_eq!(outcome.text, "Hi there.");
    }

    #[test]
    fn a_helper_agents_text_is_not_part_of_the_reply() {
        let stream = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"helper thinking"}},"parent_tool_use_id":"toolu_1"}
{"type":"assistant","message":{"content":[{"type":"text","text":"helper says"},{"type":"tool_use","name":"Grep","input":{"pattern":"TODO"}}]},"parent_tool_use_id":"toolu_1"}
{"type":"result","is_error":false,"result":"Done."}"#;
        let (steps, outcome) = read(OutputFormat::ClaudeStream, &[stream]);
        assert_eq!(text(&steps), "");
        assert_eq!(activity(&steps), ["Searching for TODO"]);
        assert_eq!(outcome.text, "Done.");
    }

    #[test]
    fn claude_failure_is_the_tools_own_message() {
        let stream = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"There's an issue with the selected model (m)."}]}}
{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"result":"There's an issue with the selected model (m)."}"#;
        let (_, outcome) = read(OutputFormat::ClaudeStream, &[stream]);
        assert_eq!(outcome.error.as_deref(), Some("There's an issue with the selected model (m)."));
    }

    #[test]
    fn codex_messages_commands_and_usage_are_read() {
        let stream = r#"{"type":"thread.started","thread_id":"t"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I'll check the tests."}}
{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"bash -lc 'cargo test'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"bash -lc 'cargo test'","aggregated_output":"ok","exit_code":0,"status":"completed"}}
{"type":"item.started","item":{"id":"item_3","type":"file_change","changes":[{"path":"/work/project/src/lib.rs","kind":"update"}],"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"file_change","changes":[{"path":"/work/project/src/lib.rs","kind":"update"}],"status":"completed"}}
{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"All tests pass."}}
{"type":"turn.completed","usage":{"input_tokens":900,"cached_input_tokens":300,"output_tokens":40,"reasoning_output_tokens":10}}
"#;
        let (steps, outcome) = read(OutputFormat::CodexJson, &[stream]);
        assert_eq!(text(&steps), "I'll check the tests.\n\nAll tests pass.");
        assert_eq!(activity(&steps), ["Running: bash -lc 'cargo test'", "Editing src/lib.rs"]);
        assert_eq!(changes(&steps), [("src/lib.rs", 0, 0)]);
        assert_eq!(
            outcome,
            Outcome { text: "All tests pass.".into(), error: None, input_tokens: Some(900), output_tokens: Some(40) }
        );
    }

    #[test]
    fn codex_retries_are_not_failures_but_a_failed_turn_is() {
        let retried = r#"{"type":"error","message":"Reconnecting... 2/5 (timeout)"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Here."}}
{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}"#;
        let (_, outcome) = read(OutputFormat::CodexJson, &[retried]);
        assert_eq!(outcome.error, None);
        assert_eq!(outcome.text, "Here.");

        let failed = r#"{"type":"error","message":"Reconnecting... 5/5 (unexpected status 401 Unauthorized)"}
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer"}}"#;
        let (_, outcome) = read(OutputFormat::CodexJson, &[failed]);
        assert_eq!(outcome.error.as_deref(), Some("unexpected status 401 Unauthorized: Missing bearer"));

        let only_errors = r#"{"type":"error","message":"model not supported"}"#;
        let (_, outcome) = read(OutputFormat::CodexJson, &[only_errors]);
        assert_eq!(outcome.error.as_deref(), Some("model not supported"));
    }

    #[test]
    fn codex_server_text_arrives_in_pieces_with_activity_usage_and_an_end() {
        let stream = r#"{"method":"turn/started","params":{"threadId":"t","turn":{"id":"u","status":"inProgress"}}}
{"method":"item/started","params":{"item":{"type":"userMessage","id":"i0","content":[{"type":"text","text":"hi"}]},"threadId":"t","turnId":"u"}}
{"method":"item/started","params":{"item":{"type":"reasoning","id":"i1","summary":[],"content":[]},"threadId":"t","turnId":"u"}}
{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"u","itemId":"i2","delta":"I'll check "}}
{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"u","itemId":"i2","delta":"the tests."}}
{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"i2","text":"I'll check the tests.","phase":"commentary"},"threadId":"t","turnId":"u"}}
{"method":"item/started","params":{"item":{"type":"commandExecution","id":"i3","command":"cargo test","status":"inProgress"},"threadId":"t","turnId":"u"}}
{"method":"item/commandExecution/outputDelta","params":{"itemId":"i3","delta":"ok"}}
{"method":"item/started","params":{"item":{"type":"fileChange","id":"i4","changes":[{"path":"/work/project/src/lib.rs","kind":"update","diff":""}],"status":"inProgress"},"threadId":"t","turnId":"u"}}
{"method":"item/completed","params":{"item":{"type":"fileChange","id":"i4","changes":[{"path":"/work/project/src/lib.rs","kind":"update","diff":""}],"status":"completed"},"threadId":"t","turnId":"u"}}
{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"u","itemId":"i5","delta":"All pass."}}
{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"i5","text":"All pass.","phase":"final_answer"},"threadId":"t","turnId":"u"}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"t","turnId":"u","tokenUsage":{"last":{"inputTokens":10,"outputTokens":2},"total":{"inputTokens":700,"cachedInputTokens":200,"outputTokens":30,"reasoningOutputTokens":5,"totalTokens":730}}}}
"#;
        let mut reader = EventReader::new(OutputFormat::CodexServer, Some("/work/project".into()));
        let mut steps = reader.push(stream);
        assert!(!reader.turn_over());
        steps.extend(reader.push(
            "{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"t\",\"turn\":{\"id\":\"u\",\"status\":\"completed\",\"error\":null}}}\n",
        ));
        assert!(reader.turn_over());
        assert_eq!(text(&steps), "I'll check the tests.\n\nAll pass.");
        assert_eq!(activity(&steps), ["Thinking", "Running: cargo test", "Editing src/lib.rs"]);
        assert_eq!(changes(&steps), [("src/lib.rs", 0, 0)]);
        assert_eq!(
            reader.outcome(),
            Outcome { text: "All pass.".into(), error: None, input_tokens: Some(700), output_tokens: Some(30) }
        );
    }

    #[test]
    fn codex_server_message_without_pieces_is_shown_whole() {
        let stream = r#"{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"i1","text":"Hello."}}}
{"method":"turn/completed","params":{"turn":{"status":"completed"}}}"#;
        let (steps, outcome) = read(OutputFormat::CodexServer, &[stream]);
        assert_eq!(text(&steps), "Hello.");
        assert_eq!(outcome.text, "Hello.");
    }

    #[test]
    fn codex_server_retries_are_ignored_and_a_failed_turn_gives_the_reason() {
        let stream = r#"{"method":"error","params":{"error":{"message":"Reconnecting... 2/5","additionalDetails":"unexpected status 401 Unauthorized"},"willRetry":true}}
{"method":"error","params":{"error":{"message":"unexpected status 401 Unauthorized: Missing bearer","additionalDetails":null},"willRetry":false}}
{"method":"turn/completed","params":{"turn":{"status":"failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer"}}}}"#;
        let mut reader = EventReader::new(OutputFormat::CodexServer, None);
        reader.push(stream);
        reader.finish();
        assert!(reader.turn_over());
        assert_eq!(reader.outcome().error.as_deref(), Some("unexpected status 401 Unauthorized: Missing bearer"));
    }

    fn changes(steps: &[Step]) -> Vec<(&str, usize, usize)> {
        steps
            .iter()
            .filter_map(|s| if let Step::Change(c) = s { Some((c.path.as_str(), c.added, c.removed)) } else { None })
            .collect()
    }

    #[test]
    fn claude_edits_are_reported_once_they_succeed_and_not_when_refused() {
        let stream = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/work/project/a.txt","old_string":"hi\nthere","new_string":"hello"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Write","input":{"file_path":"/work/project/b.txt","content":"one\ntwo\n"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"The user rejected this action.","is_error":true}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"Read","input":{"file_path":"/work/project/c.txt"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t3","content":"x"}]}}
{"type":"result","is_error":false,"result":"Done."}
"#;
        let mut reader = EventReader::new(OutputFormat::ClaudeStream, Some("/work/project".into()));
        let steps = reader.push(stream);
        assert_eq!(changes(&steps), [("a.txt", 1, 2)]);
        let Some(Step::Change(change)) = steps.iter().find(|s| matches!(s, Step::Change(_))) else { panic!() };
        assert_eq!(change.diff, "-hi\n-there\n+hello\n");
        assert!(reader.turn_over());
    }

    #[test]
    fn claude_permission_requests_are_described_for_a_person() {
        let reader = EventReader::new(OutputFormat::ClaudeStream, Some("/work/project".into()));
        let edit = reader.claude_action("Edit", &serde_json::json!({"file_path":"/work/project/a.txt","old_string":"hi","new_string":"hello"}));
        assert_eq!(edit, ProposedAction { kind: ActionKind::Edit, title: "Edit a.txt".into(), detail: "-hi\n+hello\n".into() });
        let write = reader.claude_action("Write", &serde_json::json!({"file_path":"/work/project/new.txt","content":"x"}));
        assert_eq!((write.kind, write.title.as_str(), write.detail.as_str()), (ActionKind::Edit, "Write new.txt", "+x\n"));
        let run = reader.claude_action("Bash", &serde_json::json!({"command":"rm -rf build","description":"clean"}));
        assert_eq!(run, ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: "rm -rf build".into() });
        let other = reader.claude_action("WebFetch", &serde_json::json!({"url":"https://example.com"}));
        assert_eq!((other.kind, other.title.as_str()), (ActionKind::Other, "Fetching https://example.com"));
        assert!(other.detail.contains("example.com"));
    }

    #[test]
    fn codex_server_edits_can_be_shown_for_approval_and_count_only_when_applied() {
        let started = r#"{"method":"item/started","params":{"item":{"type":"fileChange","id":"i4","changes":[{"path":"/work/project/src/lib.rs","kind":"update","diff":"@@ -1 +1 @@\n-old\n+new\n"}],"status":"inProgress"}}}
"#;
        let mut reader = EventReader::new(OutputFormat::CodexServer, Some("/work/project".into()));
        assert!(changes(&reader.push(started)).is_empty());
        assert_eq!(reader.pending_edit("i4"), Some(("Edit src/lib.rs".into(), "src/lib.rs\n@@ -1 +1 @@\n-old\n+new\n".into())));
        assert_eq!(reader.pending_edit("nope"), None);

        let declined = r#"{"method":"item/completed","params":{"item":{"type":"fileChange","id":"i4","changes":[{"path":"/work/project/src/lib.rs","kind":"update","diff":"@@ -1 +1 @@\n-old\n+new\n"}],"status":"declined"}}}
"#;
        assert!(changes(&reader.push(declined)).is_empty());
        assert_eq!(reader.pending_edit("i4"), None);

        let applied = declined.replace("declined", "completed").replace("i4", "i5");
        assert_eq!(changes(&reader.push(&applied)), [("src/lib.rs", 1, 1)]);
    }

    #[test]
    fn output_that_is_not_events_is_kept_as_plain_text() {
        for format in [OutputFormat::ClaudeStream, OutputFormat::CodexJson] {
            let (steps, outcome) = read(format, &["Hello\nthere", "\n", "[1, 2]\n", "last"]);
            assert_eq!(text(&steps), "Hello\nthere\n[1, 2]\nlast\n");
            assert_eq!(outcome.text, "Hello\nthere\n[1, 2]\nlast\n");
            assert_eq!(outcome.error, None);
        }
    }

    #[test]
    fn text_format_passes_everything_through() {
        let (steps, outcome) = read(OutputFormat::Text, &["{\"type\":", "\"result\"}\n"]);
        assert_eq!(text(&steps), "{\"type\":\"result\"}\n");
        assert_eq!(outcome.text, "{\"type\":\"result\"}\n");
    }

    #[test]
    fn long_activity_is_cut_and_unknown_tools_are_named() {
        let command = "x".repeat(500);
        let stream = format!(
            "{}\n{}\n",
            serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":command}}]}}),
            serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__db__query","input":{}}]}}),
        );
        let (steps, _) = read(OutputFormat::ClaudeStream, &[&stream]);
        let lines = activity(&steps);
        assert_eq!(lines[0].chars().count(), MAX_ACTIVITY + 1);
        assert_eq!(lines[1], "Using mcp__db__query");
    }

    #[test]
    fn paths_outside_the_workspace_are_shown_in_full() {
        let reader = EventReader::new(OutputFormat::ClaudeStream, Some("/work/project/".into()));
        assert_eq!(reader.short_path("/work/project/a/b.rs"), "a/b.rs");
        assert_eq!(reader.short_path("/work/project-two/a.rs"), "/work/project-two/a.rs");
        assert_eq!(reader.short_path("/work/project"), "/work/project");
        assert_eq!(reader.short_path("relative.rs"), "relative.rs");
    }
}
