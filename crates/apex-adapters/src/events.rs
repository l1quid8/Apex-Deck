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

use std::collections::{HashMap, HashSet};

use apex_core::work_steps::{StepStatus, TodoItem, WorkStep, STEPS_PER_REPLY_MAX};
use apex_core::{
    ActionKind, AgentTool, ContextUse, FileChange, PlanUsage, PlanWindow, ProposedAction, ResetCredit, ResetCredits,
};
use serde_json::Value;

use crate::work_feed;

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
    /// Google Antigravity (`agy`) with `--output-format stream-json`.
    AntigravityStream,
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
    /// How full the context window was on the latest request.
    Context(ContextUse),
    /// How much of the account's plan is used.
    Plan(PlanUsage),
    /// A step of the work, new or updated by key.
    Work(WorkStep),
    /// The tool's to-do list, whole.
    Todo(Vec<TodoItem>),
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
    /// Cost reported by the tool, in millionths of a US dollar.
    pub cost_micros: Option<u64>,
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
    cost_micros: Option<u64>,
    /// Claude Code: the input of the turn's latest request and the model
    /// that took it. The context window is only named at the end.
    last_request: Option<(u64, String)>,
    /// Pictures the tool made and saved during the turn.
    images: Vec<String>,
    /// Claude Code: helper agents started in the background that have not
    /// reported back yet.
    helpers: usize,
    /// Codex app server: the reply's own thread. Helpers run in threads of
    /// their own on the same stream, and their events are not the reply.
    thread: Option<String>,
    /// Codex app server: the threads of helpers this thread started that
    /// have not finished yet.
    helper_threads: HashSet<String>,
    /// The reply so far, kept when a follow-up turn starts after helpers
    /// report back. The follow-up's text is added to it.
    earlier: Option<String>,
    /// Each work step as last reported, by key, so a result only fills in
    /// what it adds and an unchanged step is not reported again.
    work: HashMap<String, WorkStep>,
    /// Claude Code: to-do tool calls waiting for their result, by tool-use
    /// id, with the tool's name and input.
    todo_calls: HashMap<String, (String, Value)>,
    /// Claude Code: the to-do list built from `TaskCreate` / `TaskUpdate`,
    /// as (task id, item).
    tasks: Vec<(String, TodoItem)>,
    /// Claude Code: helper calls running in the background, by tool-use id.
    /// Their tool result is only a launch notice.
    background_calls: HashSet<String>,
    /// Claude Code: the tool-use id of each background helper, by task id.
    background_tasks: HashMap<String, String>,
    /// Codex app server: every helper thread this thread started, finished
    /// or not, so the helper's work is kept under it.
    known_helpers: HashSet<String>,
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
            cost_micros: None,
            last_request: None,
            images: Vec::new(),
            helpers: 0,
            thread: None,
            helper_threads: HashSet::new(),
            earlier: None,
            work: HashMap::new(),
            todo_calls: HashMap::new(),
            tasks: Vec::new(),
            background_calls: HashSet::new(),
            background_tasks: HashMap::new(),
            known_helpers: HashSet::new(),
        }
    }

    /// Add output and return what it produced.
    pub(crate) fn push(&mut self, text: &str) -> Vec<Step> {
        if self.format == OutputFormat::Text {
            self.streamed.push_str(text);
            return if text.is_empty() {
                Vec::new()
            } else {
                vec![Step::Text(text.to_string())]
            };
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
        let last = self.final_text.filter(|t| !t.trim().is_empty());
        let mut text = match (self.earlier, last) {
            (Some(earlier), Some(last)) => format!("{}\n\n{last}", earlier.trim_end()),
            (Some(earlier), None) => earlier,
            (None, Some(last)) => last,
            (None, None) => self.streamed,
        };
        attach_images(&mut text, &self.images);
        let has_reply = !text.trim().is_empty();
        Outcome {
            error: self
                .failure
                .or(if has_reply { None } else { self.last_error }),
            text,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cost_micros: self.cost_micros,
        }
    }

    /// True once the tool has reported the end of the turn. Only the app
    /// server says so; the other formats end when the program exits.
    pub(crate) fn turn_over(&self) -> bool {
        self.turn_over
    }

    /// True once the turn has failed, so nothing more will come of it.
    pub(crate) fn failed(&self) -> bool {
        self.failure.is_some()
    }

    /// Helper agents still working in the background. When one finishes,
    /// Claude Code starts a follow-up turn by itself to pass on what it
    /// found, as long as its input is still open. Codex does not, so Deck
    /// starts that turn once they are all done.
    pub(crate) fn helpers(&self) -> usize {
        match self.format {
            OutputFormat::CodexServer => self.helper_threads.len(),
            _ => self.helpers,
        }
    }

    /// Codex app server: read only this thread's events as the reply.
    pub(crate) fn own_thread(&mut self, thread: &str) {
        self.thread = Some(thread.to_string());
    }

    /// Keep reading after the turn ends, for the follow-up turn that passes
    /// on what the helpers found. Its reply is added to this one.
    pub(crate) fn await_follow_up(&mut self) {
        self.turn_over = false;
        if let Some(text) = self.final_text.take().filter(|t| !t.trim().is_empty()) {
            self.earlier = Some(match self.earlier.take() {
                Some(earlier) => format!("{}\n\n{text}", earlier.trim_end()),
                None => text,
            });
        }
    }

    /// Add a line of Deck's own to the end of the reply.
    pub(crate) fn add_note(&mut self, note: &str) {
        // After a follow-up, everything shown is already in `earlier`.
        let shown = if self.earlier.is_some() {
            String::new()
        } else {
            self.streamed.clone()
        };
        let text = self
            .final_text
            .take()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or(shown);
        self.final_text = Some(if text.trim().is_empty() {
            note.to_string()
        } else {
            format!("{}\n\n{note}", text.trim_end())
        });
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

    /// Report a work step unless it is what was last reported for its key.
    /// Past `STEPS_PER_REPLY_MAX` steps a new key is neither kept nor sent;
    /// the daemon would not keep it either.
    fn work_step(&mut self, step: WorkStep, steps: &mut Vec<Step>) {
        if !self.work.contains_key(&step.key) && self.work.len() >= STEPS_PER_REPLY_MAX {
            return;
        }
        if self.work.get(&step.key) != Some(&step) {
            self.work.insert(step.key.clone(), step.clone());
            steps.push(Step::Work(step));
        }
    }

    /// End a step that is still running.
    fn end_step(&mut self, key: &str, status: StepStatus, steps: &mut Vec<Step>) {
        if let Some(step) = self.work.get(key).filter(|s| s.status == StepStatus::Running) {
            let step = WorkStep { status, ..step.clone() };
            self.work_step(step, steps);
        }
    }

    /// Start a new message of the reply, set apart from the one before it.
    fn new_message(&mut self, steps: &mut Vec<Step>) {
        if !self.streamed.is_empty() && !self.streamed.ends_with("\n\n") {
            let gap = if self.streamed.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
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
            OutputFormat::AntigravityStream => self.antigravity(&event, steps),
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
                if own {
                    self.note_claude_request(&event["message"]);
                }
                let Some(blocks) = event["message"]["content"].as_array() else {
                    return;
                };
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
                            if let Some(id) = block["id"].as_str() {
                                let parent = event["parent_tool_use_id"].as_str();
                                self.claude_tool_use(id, parent, name, &block["input"], steps);
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
                let Some(blocks) = event["message"]["content"].as_array() else {
                    return;
                };
                for block in blocks.iter().filter(|b| b["type"] == "tool_result") {
                    let done = block["tool_use_id"]
                        .as_str()
                        .and_then(|id| self.edits.remove(id));
                    if let (Some(changes), false) =
                        (done, block["is_error"].as_bool().unwrap_or(false))
                    {
                        steps.extend(changes.into_iter().map(Step::Change));
                    }
                    if let Some(id) = block["tool_use_id"].as_str() {
                        self.claude_tool_result(id, block, &event["tool_use_result"], steps);
                    }
                }
            }
            Some("result") => {
                self.turn_over = true;
                let text = event["result"].as_str().map(str::to_string);
                if event["is_error"].as_bool().unwrap_or(false) {
                    let listed = event["errors"].as_array().map(|errors| {
                        errors
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" | ")
                    });
                    self.failure = text
                        .filter(|t| !t.trim().is_empty())
                        .or(listed.filter(|l| !l.is_empty()))
                        .or_else(|| Some("the turn ended with an error".to_string()));
                } else {
                    // A follow-up turn after helpers report back adds to
                    // the reply instead of replacing it.
                    self.final_text = match (self.final_text.take(), text) {
                        (Some(before), Some(after))
                            if !before.trim().is_empty() && !after.trim().is_empty() =>
                        {
                            Some(format!("{}\n\n{}", before.trim_end(), after))
                        }
                        (Some(before), Some(after)) if after.trim().is_empty() => Some(before),
                        (_, after) => after,
                    };
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
                // Each result reports the cumulative estimated cost for this CLI
                // conversation. A helper follow-up may emit another result;
                // retain its newer total rather than adding totals together.
                if let Some(cost) = usd_to_micros(&event["total_cost_usd"]) {
                    self.cost_micros = Some(cost);
                }
                if let Some(context) = self.claude_context(&event["modelUsage"]) {
                    steps.push(Step::Context(context));
                }
            }
            Some("system") if event["subtype"] == "background_tasks_changed" => {
                // Background shells (a dev server, say) can run for ever and
                // need no reply; only helper agents report back.
                self.helpers = event["tasks"].as_array().map_or(0, |tasks| {
                    tasks
                        .iter()
                        .filter(|t| {
                            t["task_type"]
                                .as_str()
                                .is_some_and(|kind| kind.contains("agent"))
                        })
                        .count()
                });
                // A background helper that has left the list is finished.
                let listed: HashSet<&str> = event["tasks"]
                    .as_array()
                    .map(|tasks| tasks.iter().filter_map(|t| t["task_id"].as_str()).collect())
                    .unwrap_or_default();
                let gone: Vec<String> = self
                    .background_tasks
                    .keys()
                    .filter(|task| !listed.contains(task.as_str()))
                    .cloned()
                    .collect();
                for task in gone {
                    if let Some(call) = self.background_tasks.remove(&task) {
                        self.background_calls.remove(&call);
                        self.end_step(&call, StepStatus::Done, steps);
                    }
                }
            }
            // Links a helper's task to the tool call that started it.
            Some("system") if event["subtype"] == "task_started" => {
                if let (Some(task), Some(call)) =
                    (event["task_id"].as_str(), event["tool_use_id"].as_str())
                {
                    if event["is_backgrounded"].as_bool() == Some(true)
                        || self.background_calls.contains(call)
                    {
                        self.background_calls.insert(call.to_string());
                        self.background_tasks.insert(task.to_string(), call.to_string());
                    }
                }
            }
            // A background helper reporting back.
            Some("system") if event["subtype"] == "task_notification" => {
                let Some(call) = event["task_id"]
                    .as_str()
                    .and_then(|task| self.background_tasks.remove(task))
                else {
                    return;
                };
                self.background_calls.remove(&call);
                let status = match event["status"].as_str() {
                    Some("completed") => StepStatus::Done,
                    Some("failed") => StepStatus::Failed,
                    _ => StepStatus::Stopped,
                };
                let summary = event["summary"].as_str().unwrap_or("");
                if let Some(step) = self.work.get(&call).filter(|s| s.status == StepStatus::Running) {
                    let step = if summary.is_empty() {
                        WorkStep { status, ..step.clone() }
                    } else {
                        work_feed::with_output(step.clone(), summary, status)
                    };
                    self.work_step(step, steps);
                }
            }
            Some("rate_limit_event") => {
                if let Some(plan) = claude_plan(&event["rate_limit_info"]) {
                    steps.push(Step::Plan(plan));
                }
            }
            _ => {}
        }
    }

    /// A Claude Code tool call: a work step, or a change to the to-do list.
    fn claude_tool_use(
        &mut self,
        id: &str,
        parent: Option<&str>,
        name: &str,
        input: &Value,
        steps: &mut Vec<Step>,
    ) {
        if work_feed::grok_todo_tool(name) {
            // The list arrives in the result; see `claude_tool_result`.
            self.todo_calls.insert(id.to_string(), (name.to_string(), input.clone()));
            return;
        }
        if work_feed::claude_todo_tool(name) {
            match name {
                // A helper's list would replace the bot's own.
                "TodoWrite" if parent.is_none() => steps.push(Step::Todo(work_feed::todo_write(input))),
                "TaskCreate" | "TaskUpdate" => {
                    self.todo_calls.insert(id.to_string(), (name.to_string(), input.clone()));
                }
                _ => {}
            }
            return;
        }
        if matches!(name, "Agent" | "Task") && input["run_in_background"].as_bool() == Some(true) {
            self.background_calls.insert(id.to_string());
        }
        let step = work_feed::claude_step(id, parent, name, input, self.cwd.as_deref());
        self.work_step(step, steps);
    }

    /// The result of a Claude Code tool call. `meta` is the event's
    /// `tool_use_result`, which says what id a new task got.
    fn claude_tool_result(&mut self, id: &str, block: &Value, meta: &Value, steps: &mut Vec<Step>) {
        let failed = block["is_error"].as_bool().unwrap_or(false);
        let text = work_feed::claude_result_text(&block["content"]);
        if let Some((tool, input)) = self.todo_calls.remove(id) {
            if work_feed::grok_todo_tool(&tool) {
                match work_feed::grok_todos(&text).filter(|_| !failed) {
                    Some(list) => steps.push(Step::Todo(list)),
                    // The list came back in a shape Deck doesn't know: show
                    // the call rather than drop it without a trace.
                    None => {
                        let step = work_feed::claude_step(id, None, &tool, &input, self.cwd.as_deref());
                        self.work_step(step, steps);
                    }
                }
                return;
            }
            if !failed && work_feed::fold_task(&mut self.tasks, &tool, &input, meta, &text) {
                steps.push(Step::Todo(self.tasks.iter().map(|(_, item)| item.clone()).collect()));
            }
            return;
        }
        let Some(step) = self.work.get(id).cloned() else {
            return;
        };
        let status = if failed {
            self.background_calls.remove(id);
            StepStatus::Failed
        } else if self.background_calls.contains(id) {
            // Only the launch notice; the helper is still at work.
            StepStatus::Running
        } else {
            StepStatus::Done
        };
        self.work_step(work_feed::with_output(step, &text, status), steps);
    }

    /// Remember what one request of the turn was given. The result's totals
    /// add up every request of a turn, so they overstate how full the
    /// window is; the last request alone says that.
    fn note_claude_request(&mut self, message: &Value) {
        let usage = &message["usage"];
        let Some(input) = usage["input_tokens"].as_u64() else {
            return;
        };
        let cached = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0)
            + usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
        let model = message["model"].as_str().unwrap_or("").to_string();
        self.last_request = Some((input + cached, model));
    }

    /// How full the window was on the turn's last request. The window is
    /// that of the model that took it, or of the only model used.
    fn claude_context(&self, models: &Value) -> Option<ContextUse> {
        let (used, model) = self.last_request.as_ref()?;
        let models = models.as_object()?;
        let entry = models.get(model).or_else(|| {
            if models.len() == 1 {
                models.values().next()
            } else {
                None
            }
        })?;
        let window = entry["contextWindow"].as_u64().filter(|w| *w > 0)?;
        Some(ContextUse {
            used_tokens: *used,
            window_tokens: window,
        })
    }

    fn claude_activity(&self, tool: &str, input: &Value) -> String {
        let field = |key: &str| input[key].as_str().map(str::trim).filter(|s| !s.is_empty());
        let path = || {
            field("file_path")
                .or(field("notebook_path"))
                .or(field("path"))
                .map(|p| self.short_path(p))
        };
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
        let Some(path) = input["file_path"]
            .as_str()
            .or(input["notebook_path"].as_str())
        else {
            return Vec::new();
        };
        let path = self.short_path(path);
        let diff = match tool {
            "Edit" => replaced(&text(&input["old_string"]), &text(&input["new_string"])),
            "MultiEdit" => input["edits"]
                .as_array()
                .map(|edits| {
                    edits
                        .iter()
                        .map(|e| replaced(&text(&e["old_string"]), &text(&e["new_string"])))
                        .collect::<Vec<_>>()
                        .join("@@\n")
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
        if let Some((server, name)) = crate::mcp::claude_tool(tool) {
            return crate::mcp::action(server, name, input);
        }
        let changes = self.claude_changes(tool, input);
        if let Some(change) = changes.first() {
            let verb = if tool == "Write" { "Write" } else { "Edit" };
            return ProposedAction {
                kind: ActionKind::Edit,
                title: format!("{verb} {}", change.path),
                detail: changes
                    .iter()
                    .map(|c| c.diff.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
                expires_at: None,
                risky: false,
            };
        }
        if tool == "Bash" {
            let command = input["command"].as_str().unwrap_or("").to_string();
            return ProposedAction {
                kind: ActionKind::Command,
                title: "Run a command".to_string(),
                detail: command,
                expires_at: None,
                risky: false,
            };
        }
        let detail = serde_json::to_string_pretty(input).unwrap_or_default();
        ProposedAction {
            kind: ActionKind::Other,
            title: self.claude_activity(tool, input),
            detail,
            expires_at: None,
            risky: false,
        }
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
                    steps.extend(
                        self.changes_in(&item["changes"])
                            .into_iter()
                            .map(Step::Change),
                    );
                }
            }
            ("item.started", Some("web_search")) => {
                let query = item["query"]
                    .as_str()
                    .map(str::trim)
                    .filter(|q| !q.is_empty());
                self.doing(
                    query.map_or("Searching the web".to_string(), |q| {
                        format!("Searching the web for {q}")
                    }),
                    steps,
                );
            }
            ("item.started", Some("mcp_tool_call")) => {
                let server = item["server"].as_str().unwrap_or("a connected tool");
                let tool = item["tool"].as_str().unwrap_or("");
                self.doing(format!("Using {server} {tool}").trim().to_string(), steps);
            }
            ("item.completed", Some("error")) => {
                self.last_error = item["message"]
                    .as_str()
                    .map(str::to_string)
                    .or(self.last_error.take());
            }
            ("turn.completed", _) => {
                let usage = &event["usage"];
                self.input_tokens = usage["input_tokens"].as_u64().or(self.input_tokens);
                self.output_tokens = usage["output_tokens"].as_u64().or(self.output_tokens);
            }
            ("turn.failed", _) => {
                let message = event["error"]["message"]
                    .as_str()
                    .unwrap_or("the turn failed");
                self.failure = Some(message.to_string());
            }
            ("error", _) => {
                self.last_error = event["message"]
                    .as_str()
                    .map(str::to_string)
                    .or(self.last_error.take());
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
        if let (Some(own), Some(from)) = (&self.thread, params["threadId"].as_str()) {
            if own != from {
                let from = from.to_string();
                // A helper's thread closing means it will not report back.
                if message["method"] == "thread/closed" {
                    self.helper_threads.remove(&from);
                    self.end_step(&from, StepStatus::Stopped, steps);
                }
                // A helper's work is kept under its box, but its messages,
                // usage and turn end are not this reply's.
                if self.known_helpers.contains(&from) {
                    self.codex_helper_event(&from, message, steps);
                }
                return;
            }
        }
        match message["method"].as_str() {
            Some(method @ ("item/started" | "item/completed")) => {
                let done = method == "item/completed";
                self.codex_item_step(item, None, done, steps);
                if kind == Some("subAgentActivity") {
                    self.codex_helper_box(item, steps);
                }
            }
            _ => {}
        }
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
                        self.edits
                            .insert(id.to_string(), self.changes_in(&item["changes"]));
                    }
                }
                Some("webSearch") => {
                    let query = item["query"]
                        .as_str()
                        .map(str::trim)
                        .filter(|q| !q.is_empty());
                    self.doing(
                        query.map_or("Searching the web".to_string(), |q| {
                            format!("Searching the web for {q}")
                        }),
                        steps,
                    );
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
                // A helper agent this thread started, or one finishing.
                Some("subAgentActivity") => {
                    let Some(helper) = item["agentThreadId"].as_str() else {
                        return;
                    };
                    match item["kind"].as_str() {
                        Some("started") => {
                            self.helper_threads.insert(helper.to_string());
                        }
                        Some("completed" | "interrupted") => {
                            self.helper_threads.remove(helper);
                        }
                        _ => {}
                    }
                }
                Some("agentMessage") => {
                    let Some(text) = item["text"].as_str().filter(|t| !t.trim().is_empty()) else {
                        return;
                    };
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
                // In planning mode Codex ends with its plan as an item of its
                // own (probe notes, 2026-10-06). It is the reply.
                Some("plan") => {
                    let Some(text) = item["text"].as_str().filter(|t| !t.trim().is_empty()) else {
                        return;
                    };
                    self.new_message(steps);
                    self.say(text, steps);
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
                        steps.extend(
                            self.changes_in(&item["changes"])
                                .into_iter()
                                .map(Step::Change),
                        );
                    }
                }
                // Generated pictures arrive as their own item, saved to disk.
                _ => {
                    if let Some(path) = item["savedPath"]
                        .as_str()
                        .filter(|_| item["status"] == "completed")
                    {
                        self.images.push(path.to_string());
                    }
                }
            },
            Some("thread/tokenUsage/updated") => {
                // One thread is one turn here, so the thread total is the
                // turn's total.
                let usage = &params["tokenUsage"];
                let total = &usage["total"];
                self.input_tokens = total["inputTokens"].as_u64().or(self.input_tokens);
                self.output_tokens = total["outputTokens"].as_u64().or(self.output_tokens);
                // How full the window is comes from the latest request, not the total.
                let last = &usage["last"];
                let used = last["totalTokens"].as_u64().or_else(|| {
                    Some(last["inputTokens"].as_u64()? + last["outputTokens"].as_u64().unwrap_or(0))
                });
                if let (Some(used), Some(window)) = (
                    used,
                    usage["modelContextWindow"].as_u64().filter(|w| *w > 0),
                ) {
                    steps.push(Step::Context(ContextUse {
                        used_tokens: used,
                        window_tokens: window,
                    }));
                }
            }
            Some("turn/plan/updated") => {
                steps.push(Step::Todo(work_feed::codex_plan(&params["plan"])));
            }
            Some("account/rateLimits/updated") => {
                // Updates are sparse: a window left out has not changed.
                if let Some(plan) = codex_plan(&params["rateLimits"], false) {
                    steps.push(Step::Plan(plan));
                }
            }
            Some("error") => {
                // Retries are reported as errors too; only the last word counts.
                if !params["willRetry"].as_bool().unwrap_or(false) {
                    self.last_error = server_error(&params["error"]).or(self.last_error.take());
                }
            }
            Some("turn/completed") => {
                self.turn_over = true;
                let failure = match params["turn"]["status"].as_str() {
                    Some("failed") => server_error(&params["turn"]["error"])
                        .or(self.last_error.take())
                        .or_else(|| Some("the turn failed".to_string())),
                    Some("interrupted") => Some("the turn was interrupted".to_string()),
                    _ => None,
                };
                // A follow-up after helpers that fails leaves the reply
                // already written, with a word on why nothing was added.
                match (failure, self.earlier.is_some()) {
                    (Some(why), true) => self.add_note(&format!(
                        "(Passing on what the helpers found failed: {why}.)"
                    )),
                    (failure, _) => self.failure = failure.or(self.failure.take()),
                }
            }
            _ => {}
        }
    }

    /// The step for a Codex item, if it is work. A completion keeps how the
    /// step was named when it started and adds the result, unless the start
    /// left the detail empty (a web search before its query is known) and
    /// the completion has it.
    fn codex_item_step(&mut self, item: &Value, parent: Option<&str>, done: bool, steps: &mut Vec<Step>) {
        let Some(mut step) = work_feed::codex_step(item, parent, self.cwd.as_deref(), done) else {
            return;
        };
        if let Some(started) = self.work.get(&step.key).filter(|_| done) {
            step.kind = started.kind;
            if !started.detail.is_empty() || step.detail.is_empty() {
                step.label = started.label.clone();
                step.detail = started.detail.clone();
            }
            step.folder = started.folder.clone();
            step.parent = started.parent.clone();
        }
        self.work_step(step, steps);
    }

    /// A `subAgentActivity` item: a helper starting or finishing.
    fn codex_helper_box(&mut self, item: &Value, steps: &mut Vec<Step>) {
        let Some(helper) = item["agentThreadId"].as_str() else {
            return;
        };
        match item["kind"].as_str() {
            Some("started") => {
                self.known_helpers.insert(helper.to_string());
                if !self.work.contains_key(helper) {
                    let step = work_feed::codex_helper_step(helper, item["agentPath"].as_str());
                    self.work_step(step, steps);
                }
            }
            Some("completed") => self.end_step(helper, StepStatus::Done, steps),
            Some("interrupted") => self.end_step(helper, StepStatus::Stopped, steps),
            _ => {}
        }
    }

    /// An event from a helper's own thread: its work steps, and how its
    /// turn ended. Nothing in it is reply text, usage or context.
    fn codex_helper_event(&mut self, helper: &str, message: &Value, steps: &mut Vec<Step>) {
        let params = &message["params"];
        match message["method"].as_str() {
            Some(method @ ("item/started" | "item/completed")) => {
                let done = method == "item/completed";
                self.codex_item_step(&params["item"], Some(helper), done, steps);
            }
            Some("turn/completed") => match params["turn"]["status"].as_str() {
                Some("failed") => self.end_step(helper, StepStatus::Failed, steps),
                Some("interrupted") => self.end_step(helper, StepStatus::Stopped, steps),
                _ => {}
            },
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
        let detail = changes
            .iter()
            .map(|c| format!("{}\n{}", c.path, c.diff))
            .collect::<Vec<_>>()
            .join("\n");
        Some((title, detail))
    }

    /// The files in a Codex `changes` list, each with its diff if given.
    fn changes_in(&self, changes: &Value) -> Vec<FileChange> {
        changes
            .as_array()
            .map(|changes| {
                changes
                    .iter()
                    .filter_map(|c| {
                        Some(FileChange::new(
                            self.short_path(c["path"].as_str()?),
                            c["diff"].as_str().unwrap_or(""),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn editing(&mut self, changes: &Value, steps: &mut Vec<Step>) {
        let paths: Vec<String> = changes
            .as_array()
            .map(|changes| {
                changes
                    .iter()
                    .filter_map(|c| c["path"].as_str())
                    .map(|p| self.short_path(p))
                    .collect()
            })
            .unwrap_or_default();
        if !paths.is_empty() {
            self.doing(format!("Editing {}", paths.join(", ")), steps);
        }
    }

    // ------------------------------------------------------------ Antigravity

    fn antigravity(&mut self, event: &Value, steps: &mut Vec<Step>) {
        match event["event"].as_str() {
            Some("step_update") => {
                let step = &event["step_update"];
                if let Some(delta) = step["text_delta"].as_str().filter(|s| !s.is_empty()) {
                    self.pieces_seen = true;
                    self.say(delta, steps);
                }
                match step["step_type"].as_str() {
                    Some("tool") => {
                        let tool_name = step["tool_name"]
                            .as_str()
                            .or_else(|| step["tool_info"]["name"].as_str())
                            .unwrap_or("tool");
                        let params = &step["tool_info"]["parameters"];
                        let state = step["state"].as_str();
                        if state == Some("ACTIVE") {
                            let activity = self.antigravity_activity(tool_name, params);
                            self.doing(activity, steps);
                            let changes = self.antigravity_changes(tool_name, params);
                            if let Some(id) = step["step_index"].as_u64().map(|n| n.to_string()) {
                                if !changes.is_empty() {
                                    self.edits.insert(id, changes);
                                }
                            }
                        } else if state == Some("DONE") {
                            if let Some(id) = step["step_index"].as_u64().map(|n| n.to_string()) {
                                if let Some(changes) = self.edits.remove(&id) {
                                    steps.extend(changes.into_iter().map(Step::Change));
                                }
                            }
                        }
                    }
                    Some("agent_response") => {
                        if let Some(usage) = step.get("usage") {
                            let input = usage["input_tokens"].as_u64().unwrap_or(0);
                            let cache = usage["cache_read_tokens"].as_u64().unwrap_or(0);
                            if input + cache > 0 {
                                self.last_request = Some((input + cache, String::new()));
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some("result") => {
                let res = &event["result"];
                self.turn_over = true;
                if res["status"].as_str() == Some("SUCCESS") {
                    if let Some(resp) = res["response"].as_str() {
                        if !self.pieces_seen || self.final_text.is_none() {
                            self.final_text = Some(resp.to_string());
                        }
                    }
                    if let Some(usage) = res.get("usage") {
                        if let Some(inp) = usage["input_tokens"].as_u64() {
                            self.input_tokens = Some(inp);
                        }
                        if let Some(out) = usage["output_tokens"].as_u64() {
                            self.output_tokens = Some(out);
                        }
                    }
                    let used = self.last_request.as_ref().map(|(t, _)| *t).or(self.input_tokens);
                    if let Some(used) = used {
                        steps.push(Step::Context(ContextUse {
                            used_tokens: used,
                            window_tokens: 1_000_000,
                        }));
                    }
                } else {
                    self.failure = res["error"]
                        .as_str()
                        .or_else(|| res["response"].as_str())
                        .map(str::to_string)
                        .or_else(|| Some("Antigravity turn failed".to_string()));
                }
            }
            _ => {}
        }
    }

    fn antigravity_activity(&self, tool: &str, params: &Value) -> String {
        let field = |key: &str| params[key].as_str().map(str::trim).filter(|s| !s.is_empty());
        let path = || field("AbsolutePath").or_else(|| field("TargetFile")).or_else(|| field("path")).map(|p| self.short_path(p));
        let line = match tool {
            "view_file" => path().map(|p| format!("Reading {p}")),
            "replace_file_content" | "multi_replace_file_content" | "sed_file" => path().map(|p| format!("Editing {p}")),
            "write_to_file" => path().map(|p| format!("Writing {p}")),
            "run_command" => field("CommandLine").map(|c| format!("Running: {}", one_line(c))),
            "grep_search" => field("query").map(|q| format!("Searching for {q}")),
            "find_by_name" => field("pattern").map(|p| format!("Looking for files matching {p}")),
            "search_web" => field("query").map(|q| format!("Searching the web for {q}")),
            "read_url_content" => field("Url").map(|u| format!("Fetching {u}")),
            "invoke_subagent" => Some("Starting a helper".to_string()),
            _ => None,
        };
        line.unwrap_or_else(|| format!("Using {tool}"))
    }

    fn antigravity_changes(&self, tool: &str, params: &Value) -> Vec<FileChange> {
        let text = |val: &Value| val.as_str().unwrap_or("").to_string();
        let Some(path) = params["TargetFile"].as_str().or_else(|| params["AbsolutePath"].as_str()) else {
            return Vec::new();
        };
        let path = self.short_path(path);
        let diff = match tool {
            "replace_file_content" => replaced(&text(&params["TargetContent"]), &text(&params["ReplacementContent"])),
            "write_to_file" => replaced("", &text(&params["CodeContent"])),
            _ => return Vec::new(),
        };
        vec![FileChange::new(path, diff)]
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

/// Convert a reported USD estimate to integer microdollars without accepting
/// negative, non-finite, or out-of-range values. Missing/invalid data stays
/// unknown; this deliberately does not estimate from token counts.
fn usd_to_micros(value: &Value) -> Option<u64> {
    let usd = value.as_f64()?;
    if !usd.is_finite() || usd < 0.0 {
        return None;
    }
    let micros = (usd * 1_000_000.0).round();
    // u64::MAX as f64 rounds up to 2^64, so a strict upper bound is needed
    // before Rust's float-to-int cast (which otherwise saturates).
    (micros.is_finite() && micros < 18_446_744_073_709_551_616.0)
        .then_some(micros as u64)
}

/// Claude Code's plan usage from a `rate_limit_event`. Utilization is a
/// fraction of the window. `None` when no window gives a figure.
pub(crate) fn claude_plan(info: &Value) -> Option<PlanUsage> {
    let minutes = |name: &str| match name {
        "five_hour" => Some(300),
        "seven_day" | "seven_day_opus" | "seven_day_sonnet" => Some(10_080),
        _ => None,
    };
    let window = |name: &str, value: &Value| {
        let used = value["utilization"].as_f64()?;
        Some(PlanWindow {
            name: name.to_string(),
            used_percent: (used * 100.0).round().clamp(0.0, 100.0) as u32,
            window_minutes: minutes(name),
            resets_at: value["resetsAt"].as_u64(),
        })
    };
    let mut windows: Vec<PlanWindow> = info["unifiedWindows"]
        .as_object()
        .map(|all| {
            all.iter()
                .filter_map(|(name, value)| window(name, value))
                .collect()
        })
        .unwrap_or_default();
    // Without the list of windows, the event may still give the one it is about.
    if windows.is_empty() {
        windows.extend(
            info["rateLimitType"]
                .as_str()
                .and_then(|name| window(name, info)),
        );
    }
    (!windows.is_empty()).then(|| PlanUsage {
        provider: AgentTool::ClaudeCode,
        windows,
        partial: false,
        reset_credits: None,
    })
}

/// Codex's plan usage from a rate limit snapshot. A missing window is
/// left out; with `partial` that means it has not changed.
pub(crate) fn codex_plan(snapshot: &Value, partial: bool) -> Option<PlanUsage> {
    if !snapshot.is_object() {
        return None;
    }
    let windows: Vec<PlanWindow> = ["primary", "secondary"]
        .iter()
        .filter_map(|name| {
            let window = &snapshot[*name];
            let used = window["usedPercent"].as_f64()?;
            Some(PlanWindow {
                name: name.to_string(),
                used_percent: used.round().clamp(0.0, 100.0) as u32,
                window_minutes: window["windowDurationMins"].as_u64(),
                resets_at: window["resetsAt"].as_u64(),
            })
        })
        .collect();
    if partial && windows.is_empty() {
        return None;
    }
    Some(PlanUsage {
        provider: AgentTool::Codex,
        windows,
        partial,
        reset_credits: None,
    })
}

/// The usage resets in an `account/rateLimits/read` answer
/// (`rateLimitResetCredits`), soonest to expire first. Only ones still
/// available that reset Codex's rate limits are kept. `None` when the answer didn't include them.
pub(crate) fn codex_reset_credits(summary: &Value) -> Option<ResetCredits> {
    let available = summary["availableCount"].as_u64()?;
    let mut credits: Vec<ResetCredit> = summary["credits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|credit| credit["status"].as_str().is_none_or(|status| status == "available"))
        .filter(|credit| credit["resetType"].as_str().is_none_or(|kind| kind == "codexRateLimits"))
        .filter_map(|credit| {
            Some(ResetCredit {
                id: credit["id"].as_str()?.to_string(),
                title: credit["title"].as_str().map(str::to_string),
                description: credit["description"].as_str().map(str::to_string),
                granted_at: credit["grantedAt"].as_u64().unwrap_or(0),
                expires_at: credit["expiresAt"].as_u64(),
            })
        })
        .collect();
    credits.sort_by_key(|credit| credit.expires_at.unwrap_or(u64::MAX));
    Some(ResetCredits { available, credits })
}

/// The message of an app server error, with its detail when the message
/// alone says little (a retry notice, for example).
fn server_error(error: &Value) -> Option<String> {
    let message = error["message"]
        .as_str()
        .map(str::trim)
        .filter(|m| !m.is_empty())?;
    match error["additionalDetails"]
        .as_str()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
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

/// Add a picture to a reply. The chat shows each `Attached image:` line as
/// a picture.
pub(crate) fn attach_images(text: &mut String, paths: &[String]) {
    for path in paths {
        text.push_str(&format!("\n\nAttached image: {path}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::work_steps::{StepKind, TodoStatus};
    use serde_json::json;

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
        steps
            .iter()
            .filter_map(|s| {
                if let Step::Text(t) = s {
                    Some(t.as_str())
                } else {
                    None
                }
            })
            .collect()
    }

    fn activity(steps: &[Step]) -> Vec<&str> {
        steps
            .iter()
            .filter_map(|s| {
                if let Step::Activity(a) = s {
                    Some(a.as_str())
                } else {
                    None
                }
            })
            .collect()
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
    fn mcp_approval_shows_exact_server_tool_and_complete_arguments() {
        let reader = EventReader::new(OutputFormat::ClaudeStream, None);
        let args = serde_json::json!({"quantity":"0.001", "nested":{"symbol":"ZEC"}});
        let action = reader.claude_action("mcp__Hyper_MCP__place_order", &args);
        assert_eq!(serde_json::to_value(action.kind).unwrap(), "tool");
        assert_eq!(action.title, "Hyper_MCP: place_order");
        assert_eq!(serde_json::from_str::<Value>(&action.detail).unwrap(), args);
    }

    #[test]
    fn claude_text_is_streamed_once_with_activity_and_usage() {
        let (steps, outcome) = read(OutputFormat::ClaudeStream, &[CLAUDE_TURN]);
        assert_eq!(text(&steps), "It says hello.");
        assert_eq!(activity(&steps), ["Reading src/notes.txt"]);
        assert_eq!(
            outcome,
            Outcome {
                text: "It says hello.".into(),
                error: None,
                input_tokens: Some(1104),
                output_tokens: Some(12),
                cost_micros: None
            }
        );
    }

    #[test]
    fn claude_reports_estimated_cost_as_microdollars() {
        let (_, priced) = read(
            OutputFormat::ClaudeStream,
            &[r#"{"type":"result","is_error":false,"result":"Done.","total_cost_usd":0.0123456}"#],
        );
        assert_eq!(priced.cost_micros, Some(12_346));

        let (_, free) = read(
            OutputFormat::ClaudeStream,
            &[r#"{"type":"result","is_error":false,"result":"Done.","total_cost_usd":0}"#],
        );
        assert_eq!(free.cost_micros, Some(0));
    }

    #[test]
    fn missing_or_invalid_claude_cost_stays_unknown() {
        for value in ["null", "-0.01", "1e100"] {
            let line = format!(
                r#"{{"type":"result","is_error":false,"result":"Done.","total_cost_usd":{value}}}"#
            );
            let (_, outcome) = read(OutputFormat::ClaudeStream, &[&line]);
            assert_eq!(outcome.cost_micros, None, "value: {value}");
        }
        let (_, absent) = read(
            OutputFormat::ClaudeStream,
            &[r#"{"type":"result","is_error":false,"result":"Done."}"#],
        );
        assert_eq!(absent.cost_micros, None);
    }

    #[test]
    fn claude_helper_follow_up_keeps_new_cumulative_cost_without_adding_results() {
        let mut reader = EventReader::new(OutputFormat::ClaudeStream, None);
        reader.push(
            r#"{"type":"result","is_error":false,"result":"First.","total_cost_usd":0.01}
"#,
        );
        reader.await_follow_up();
        reader.push(
            r#"{"type":"result","is_error":false,"result":"Second.","total_cost_usd":0.015}
"#,
        );
        assert_eq!(reader.outcome().cost_micros, Some(15_000));
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
        assert_eq!(
            outcome.error.as_deref(),
            Some("There's an issue with the selected model (m).")
        );
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
        assert_eq!(
            activity(&steps),
            ["Running: bash -lc 'cargo test'", "Editing src/lib.rs"]
        );
        assert_eq!(changes(&steps), [("src/lib.rs", 0, 0)]);
        assert_eq!(
            outcome,
            Outcome {
                text: "All tests pass.".into(),
                error: None,
                input_tokens: Some(900),
                output_tokens: Some(40),
                cost_micros: None
            }
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
        assert_eq!(
            outcome.error.as_deref(),
            Some("unexpected status 401 Unauthorized: Missing bearer")
        );

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
        assert_eq!(
            activity(&steps),
            ["Thinking", "Running: cargo test", "Editing src/lib.rs"]
        );
        assert_eq!(changes(&steps), [("src/lib.rs", 0, 0)]);
        assert_eq!(
            reader.outcome(),
            Outcome {
                text: "All pass.".into(),
                error: None,
                input_tokens: Some(700),
                output_tokens: Some(30),
                cost_micros: None
            }
        );
    }

    #[test]
    fn a_planning_codex_ends_with_its_plan_as_the_reply() {
        let stream = r#"{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"i1","text":"Looking around first.","phase":"commentary"}}}
{"method":"item/completed","params":{"item":{"type":"plan","id":"u-plan","text":"Create `colour.txt` containing `blue`.\n"}}}
{"method":"turn/completed","params":{"threadId":"t","turn":{"id":"u","status":"completed","error":null}}}
"#;
        let mut reader = EventReader::new(OutputFormat::CodexServer, None);
        let steps = reader.push(stream);
        assert_eq!(
            text(&steps),
            "Looking around first.\n\nCreate `colour.txt` containing `blue`.\n"
        );
        assert_eq!(
            reader.outcome().text,
            "Create `colour.txt` containing `blue`.\n"
        );
    }

    #[test]
    fn codex_helpers_are_counted_and_their_own_threads_are_not_the_reply() {
        let mut reader = EventReader::new(OutputFormat::CodexServer, None);
        reader.own_thread("T");
        let helper = |kind: &str, id: &str| {
            format!(
                r#"{{"method":"item/completed","params":{{"threadId":"T","item":{{"type":"subAgentActivity","id":"x","kind":"{kind}","agentThreadId":"{id}","agentPath":"/root/a"}}}}}}"#
            )
        };
        reader.push(&format!(
            "{}\n{}\n",
            helper("started", "H1"),
            helper("started", "H2")
        ));
        assert_eq!(reader.helpers(), 2);
        // A helper's own message and turn end are not this reply's.
        reader.push(concat!(
            r#"{"method":"item/completed","params":{"threadId":"H1","item":{"type":"agentMessage","id":"h","text":"PINEAPPLE"}}}"#, "\n",
            r#"{"method":"turn/completed","params":{"threadId":"H1","turn":{"status":"failed"}}}"#, "\n",
        ));
        assert!(!reader.turn_over() && !reader.failed());
        reader.push(&format!("{}\n", helper("completed", "H1")));
        reader.push(r#"{"method":"thread/closed","params":{"threadId":"H2"}}"#);
        reader.push("\n");
        assert_eq!(
            reader.helpers(),
            0,
            "a closed helper thread will not report back"
        );
        reader.push(concat!(
            r#"{"method":"item/completed","params":{"threadId":"T","item":{"type":"agentMessage","id":"m","text":"Launched."}}}"#, "\n",
            r#"{"method":"turn/completed","params":{"threadId":"T","turn":{"status":"completed"}}}"#, "\n",
        ));
        assert!(reader.turn_over());
        // A follow-up that fails keeps what was already written.
        reader.await_follow_up();
        reader.push(concat!(r#"{"method":"turn/completed","params":{"threadId":"T","turn":{"status":"interrupted"}}}"#, "\n"));
        let outcome = reader.outcome();
        assert_eq!(outcome.error, None);
        assert_eq!(
            outcome.text,
            "Launched.\n\n(Passing on what the helpers found failed: the turn was interrupted.)"
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
        assert_eq!(
            reader.outcome().error.as_deref(),
            Some("unexpected status 401 Unauthorized: Missing bearer")
        );
    }

    fn changes(steps: &[Step]) -> Vec<(&str, usize, usize)> {
        steps
            .iter()
            .filter_map(|s| {
                if let Step::Change(c) = s {
                    Some((c.path.as_str(), c.added, c.removed))
                } else {
                    None
                }
            })
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
        let Some(Step::Change(change)) = steps.iter().find(|s| matches!(s, Step::Change(_))) else {
            panic!()
        };
        assert_eq!(change.diff, "-hi\n-there\n+hello\n");
        assert!(reader.turn_over());
    }

    #[test]
    fn claude_permission_requests_are_described_for_a_person() {
        let reader = EventReader::new(OutputFormat::ClaudeStream, Some("/work/project".into()));
        let edit = reader.claude_action("Edit", &serde_json::json!({"file_path":"/work/project/a.txt","old_string":"hi","new_string":"hello"}));
        assert_eq!(
            edit,
            ProposedAction {
                kind: ActionKind::Edit,
                title: "Edit a.txt".into(),
                detail: "-hi\n+hello\n".into(),
                expires_at: None,
                risky: false
            }
        );
        let write = reader.claude_action(
            "Write",
            &serde_json::json!({"file_path":"/work/project/new.txt","content":"x"}),
        );
        assert_eq!(
            (write.kind, write.title.as_str(), write.detail.as_str()),
            (ActionKind::Edit, "Write new.txt", "+x\n")
        );
        let run = reader.claude_action(
            "Bash",
            &serde_json::json!({"command":"rm -rf build","description":"clean"}),
        );
        assert_eq!(
            run,
            ProposedAction {
                kind: ActionKind::Command,
                title: "Run a command".into(),
                detail: "rm -rf build".into(),
                expires_at: None,
                risky: false
            }
        );
        let other = reader.claude_action(
            "WebFetch",
            &serde_json::json!({"url":"https://example.com"}),
        );
        assert_eq!(
            (other.kind, other.title.as_str()),
            (ActionKind::Other, "Fetching https://example.com")
        );
        assert!(other.detail.contains("example.com"));
    }

    #[test]
    fn codex_server_edits_can_be_shown_for_approval_and_count_only_when_applied() {
        let started = r#"{"method":"item/started","params":{"item":{"type":"fileChange","id":"i4","changes":[{"path":"/work/project/src/lib.rs","kind":"update","diff":"@@ -1 +1 @@\n-old\n+new\n"}],"status":"inProgress"}}}
"#;
        let mut reader = EventReader::new(OutputFormat::CodexServer, Some("/work/project".into()));
        assert!(changes(&reader.push(started)).is_empty());
        assert_eq!(
            reader.pending_edit("i4"),
            Some((
                "Edit src/lib.rs".into(),
                "src/lib.rs\n@@ -1 +1 @@\n-old\n+new\n".into()
            ))
        );
        assert_eq!(reader.pending_edit("nope"), None);

        let declined = r#"{"method":"item/completed","params":{"item":{"type":"fileChange","id":"i4","changes":[{"path":"/work/project/src/lib.rs","kind":"update","diff":"@@ -1 +1 @@\n-old\n+new\n"}],"status":"declined"}}}
"#;
        assert!(changes(&reader.push(declined)).is_empty());
        assert_eq!(reader.pending_edit("i4"), None);

        let applied = declined
            .replace("declined", "completed")
            .replace("i4", "i5");
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
    fn codex_pictures_are_attached_to_the_reply() {
        let stream = r#"{"method":"item/completed","params":{"item":{"type":"imageGeneration","id":"i1","status":"completed","savedPath":"/tmp/apple.png"}}}
{"method":"item/completed","params":{"item":{"type":"imageGeneration","id":"i2","status":"failed","savedPath":"/tmp/pear.png"}}}
{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"i3","text":"Here it is."}}}
"#;
        let (_, outcome) = read(OutputFormat::CodexServer, &[stream]);
        assert_eq!(
            outcome.text,
            "Here it is.\n\nAttached image: /tmp/apple.png"
        );
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
        assert_eq!(
            reader.short_path("/work/project-two/a.rs"),
            "/work/project-two/a.rs"
        );
        assert_eq!(reader.short_path("/work/project"), "/work/project");
        assert_eq!(reader.short_path("relative.rs"), "relative.rs");
    }

    // ------------------------------------------------------------- meters

    fn meters(steps: &[Step]) -> (Vec<ContextUse>, Vec<PlanUsage>) {
        let context = steps
            .iter()
            .filter_map(|s| {
                if let Step::Context(c) = s {
                    Some(*c)
                } else {
                    None
                }
            })
            .collect();
        let plans = steps
            .iter()
            .filter_map(|s| {
                if let Step::Plan(p) = s {
                    Some(p.clone())
                } else {
                    None
                }
            })
            .collect();
        (context, plans)
    }

    fn window(name: &str, used: u32, minutes: Option<u64>, resets: Option<u64>) -> PlanWindow {
        PlanWindow {
            name: name.into(),
            used_percent: used,
            window_minutes: minutes,
            resets_at: resets,
        }
    }

    // Printed by Claude Code on this machine, trimmed to the fields read.
    const CLAUDE_RATE_LIMIT: &str = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791063000,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.65,"resetsAt":1791063000},"seven_day":{"utilization":0.58,"resetsAt":1791396000}}}}"#;

    #[test]
    fn claude_rate_limit_events_give_every_window_as_a_percent() {
        let (steps, _) = read(OutputFormat::ClaudeStream, &[CLAUDE_RATE_LIMIT, "\n"]);
        let (context, plans) = meters(&steps);
        assert!(context.is_empty());
        assert_eq!(
            plans,
            [PlanUsage {
                provider: AgentTool::ClaudeCode,
                windows: vec![
                    window("five_hour", 65, Some(300), Some(1791063000)),
                    window("seven_day", 58, Some(10_080), Some(1791396000)),
                ],
                partial: false,
                reset_credits: None,
            }]
        );
    }

    #[test]
    fn a_claude_rate_limit_event_without_figures_says_nothing() {
        let bare = json!({ "status": "allowed", "resetsAt": 1, "rateLimitType": "five_hour" });
        assert_eq!(claude_plan(&bare), None);
        assert_eq!(claude_plan(&Value::Null), None);
        // Only the window the event is about, when the list is missing.
        let single = json!({ "rateLimitType": "five_hour", "utilization": 0.2, "resetsAt": 9 });
        assert_eq!(
            claude_plan(&single).unwrap().windows,
            [window("five_hour", 20, Some(300), Some(9))]
        );
        // A window without a figure is left out; an unknown name has no length.
        let mixed = json!({ "unifiedWindows": { "five_hour": { "resetsAt": 1 }, "other": { "utilization": 1.0 } } });
        assert_eq!(
            claude_plan(&mixed).unwrap().windows,
            [window("other", 100, None, None)]
        );
    }

    #[test]
    fn claude_context_is_the_last_requests_input_against_its_models_window() {
        // Two requests in one turn. The result adds them up; the window is
        // filled by the last one only.
        let turn = r#"{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a"}}],"usage":{"input_tokens":9,"cache_creation_input_tokens":9750,"cache_read_input_tokens":16490,"output_tokens":4}},"parent_tool_use_id":null}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":20,"cache_creation_input_tokens":300,"cache_read_input_tokens":26240,"output_tokens":2}},"parent_tool_use_id":null}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"helper"}],"usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}},"parent_tool_use_id":"t1"}
{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":29,"cache_creation_input_tokens":10050,"cache_read_input_tokens":42730,"output_tokens":6},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":29,"outputTokens":6,"cacheReadInputTokens":42730,"cacheCreationInputTokens":10050,"contextWindow":200000,"maxOutputTokens":32000}}}
"#;
        let (steps, outcome) = read(OutputFormat::ClaudeStream, &[turn]);
        let (context, _) = meters(&steps);
        assert_eq!(
            context,
            [ContextUse {
                used_tokens: 26_560,
                window_tokens: 200_000
            }]
        );
        // The token totals still count the whole turn.
        assert_eq!(outcome.input_tokens, Some(52_809));
    }

    #[test]
    fn claude_context_is_unknown_without_a_window_or_a_request() {
        let no_window = r#"{"type":"assistant","message":{"model":"m","content":[],"usage":{"input_tokens":10}},"parent_tool_use_id":null}
{"type":"result","is_error":false,"result":"","modelUsage":{"m":{"inputTokens":10}}}
"#;
        assert!(meters(&read(OutputFormat::ClaudeStream, &[no_window]).0)
            .0
            .is_empty());
        let no_request = r#"{"type":"result","is_error":false,"result":"","modelUsage":{"m":{"contextWindow":200000}}}
"#;
        assert!(meters(&read(OutputFormat::ClaudeStream, &[no_request]).0)
            .0
            .is_empty());
        // Several models and none matching the request: no guess.
        let ambiguous = r#"{"type":"assistant","message":{"model":"x","content":[],"usage":{"input_tokens":10}},"parent_tool_use_id":null}
{"type":"result","is_error":false,"result":"","modelUsage":{"a":{"contextWindow":200000},"b":{"contextWindow":1000000}}}
"#;
        assert!(meters(&read(OutputFormat::ClaudeStream, &[ambiguous]).0)
            .0
            .is_empty());
        // One model under another name is the one that was used.
        let renamed = r#"{"type":"assistant","message":{"model":"x","content":[],"usage":{"input_tokens":10}},"parent_tool_use_id":null}
{"type":"result","is_error":false,"result":"","modelUsage":{"x[1m]":{"contextWindow":1000000}}}
"#;
        assert_eq!(
            meters(&read(OutputFormat::ClaudeStream, &[renamed]).0).0,
            [ContextUse {
                used_tokens: 10,
                window_tokens: 1_000_000
            }]
        );
    }

    // Answered by `codex app-server` on this machine.
    const CODEX_RATE_LIMITS: &str = r#"{"limitId":"codex","limitName":null,"primary":{"usedPercent":15,"windowDurationMins":10080,"resetsAt":1791580627},"secondary":null,"credits":{"hasCredits":false,"unlimited":false,"balance":"0"},"planType":"prolite","rateLimitReachedType":null}"#;

    #[test]
    fn codex_rate_limits_read_gives_the_windows_it_has() {
        let snapshot: Value = serde_json::from_str(CODEX_RATE_LIMITS).unwrap();
        assert_eq!(
            codex_plan(&snapshot, false),
            Some(PlanUsage {
                provider: AgentTool::Codex,
                windows: vec![window("primary", 15, Some(10_080), Some(1791580627))],
                partial: false,
                reset_credits: None
            })
        );
        let both = json!({ "primary": { "usedPercent": 40, "windowDurationMins": 300, "resetsAt": 5 }, "secondary": { "usedPercent": 19 } });
        assert_eq!(
            codex_plan(&both, false).unwrap().windows,
            [
                window("primary", 40, Some(300), Some(5)),
                window("secondary", 19, None, None)
            ]
        );
        // A full read with no windows says the plan reports none.
        assert_eq!(
            codex_plan(&json!({ "primary": null, "secondary": null }), false)
                .unwrap()
                .windows,
            []
        );
        assert_eq!(codex_plan(&Value::Null, false), None);
    }

    #[test]
    fn codex_reset_credits_are_the_available_ones_soonest_to_expire_first() {
        // The shape `codex app-server` 0.162 answers with.
        let summary = json!({ "availableCount": 3, "credits": [
            { "id": "late", "resetType": "codexRateLimits", "status": "available", "grantedAt": 1791417037, "expiresAt": 1794009037, "title": "Full reset", "description": "Thanks for using Codex!" },
            { "id": "used", "resetType": "codexRateLimits", "status": "redeemed", "grantedAt": 1790000000, "expiresAt": 1792000000, "title": null },
            { "id": "other", "resetType": "unknown", "status": "available", "grantedAt": 1790000000, "expiresAt": 1791000000 },
            { "id": "forever", "resetType": "codexRateLimits", "status": "available", "grantedAt": 1790000000, "expiresAt": null },
            { "id": "soon", "resetType": "codexRateLimits", "status": "available", "grantedAt": 1790710015, "expiresAt": 1793302015, "title": "Full reset" }
        ] });
        let credits = codex_reset_credits(&summary).unwrap();
        assert_eq!(credits.available, 3);
        assert_eq!(credits.credits.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["soon", "late", "forever"]);
        assert_eq!(credits.credits[0], ResetCredit { id: "soon".into(), title: Some("Full reset".into()), description: None, granted_at: 1790710015, expires_at: Some(1793302015) });
        // Only a count is known.
        assert_eq!(codex_reset_credits(&json!({ "availableCount": 1, "credits": null })), Some(ResetCredits { available: 1, credits: vec![] }));
        assert_eq!(codex_reset_credits(&Value::Null), None);
    }

    #[test]
    fn codex_rate_limit_updates_replace_the_snapshot_including_null_windows() {
        let update = format!("{{\"method\":\"account/rateLimits/updated\",\"params\":{{\"rateLimits\":{CODEX_RATE_LIMITS}}}}}\n");
        let empty = "{\"method\":\"account/rateLimits/updated\",\"params\":{\"rateLimits\":{\"primary\":null,\"secondary\":null}}}\n";
        let (steps, _) = read(OutputFormat::CodexServer, &[&update, empty]);
        let (_, plans) = meters(&steps);
        // Null windows clear previously known values; never retain a stale quota.
        assert_eq!(
            plans,
            [
                PlanUsage {
                    provider: AgentTool::Codex,
                    windows: vec![window("primary", 15, Some(10_080), Some(1791580627))],
                    partial: false,
                    reset_credits: None
                },
                PlanUsage {
                    provider: AgentTool::Codex,
                    windows: vec![],
                    partial: false,
                    reset_credits: None
                }
            ]
        );
    }

    #[test]
    fn codex_context_is_the_last_request_against_the_models_window() {
        let usage = r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"t","turnId":"u","tokenUsage":{"total":{"inputTokens":90000,"cachedInputTokens":60000,"outputTokens":900,"reasoningOutputTokens":300,"totalTokens":90900},"last":{"inputTokens":31000,"cachedInputTokens":30000,"outputTokens":400,"reasoningOutputTokens":100,"totalTokens":31400},"modelContextWindow":258400}}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"t","turnId":"u","tokenUsage":{"total":{"inputTokens":1,"outputTokens":1},"last":{"inputTokens":1,"outputTokens":1},"modelContextWindow":null}}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"t","turnId":"u","tokenUsage":{"total":{"inputTokens":1,"outputTokens":1},"last":{"inputTokens":500,"outputTokens":20},"modelContextWindow":1000}}}
"#;
        let (steps, outcome) = read(OutputFormat::CodexServer, &[usage]);
        let (context, _) = meters(&steps);
        // The middle update has no window and gives no figure; the last one
        // has no total and is added up from its parts.
        assert_eq!(
            context,
            [
                ContextUse {
                    used_tokens: 31_400,
                    window_tokens: 258_400
                },
                ContextUse {
                    used_tokens: 520,
                    window_tokens: 1000
                }
            ]
        );
        assert_eq!(outcome.input_tokens, Some(1));
    }

    #[test]
    fn antigravity_stream_reports_text_activity_changes_and_context() {
        let stream = r#"{"event":"step_update","step_update":{"step_index":0,"state":"ACTIVE","step_type":"agent_response","text_delta":"Let me check"}}
{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"agent_response","text_delta":" the file.\n","usage":{"input_tokens":12000,"output_tokens":50,"cache_read_tokens":1000,"total_tokens":13050}}}
{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"replace_file_content","tool_info":{"parameters":{"TargetFile":"/workspace/src/lib.rs","TargetContent":"old","ReplacementContent":"new"}}}}
{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"tool","tool_name":"replace_file_content","tool_info":{"parameters":{"TargetFile":"/workspace/src/lib.rs"}}}}
{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"Done!"}}
{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\n","usage":{"input_tokens":15000,"output_tokens":20,"cache_read_tokens":0,"total_tokens":15020}}}
{"event":"result","result":{"status":"SUCCESS","response":"Let me check the file.\nDone!\n","usage":{"input_tokens":27000,"output_tokens":70,"total_tokens":27070}}}
"#;
        let mut reader = EventReader::new(OutputFormat::AntigravityStream, Some("/workspace".into()));
        let steps = reader.push(stream);
        let outcome = reader.outcome();

        assert_eq!(outcome.text, "Let me check the file.\nDone!\n");
        assert_eq!(outcome.input_tokens, Some(27000));
        assert_eq!(outcome.output_tokens, Some(70));
        assert!(outcome.error.is_none());

        assert!(steps.iter().any(|s| matches!(s, Step::Activity(act) if act.contains("Editing src/lib.rs"))));
        assert!(steps.iter().any(|s| matches!(s, Step::Change(change) if change.path == "src/lib.rs")));

        let (contexts, _) = meters(&steps);
        assert_eq!(
            contexts,
            vec![ContextUse {
                used_tokens: 15_000,
                window_tokens: 1_000_000,
            }]
        );
    }

    // ------------------------------------------------------------ work steps
    //
    // Recorded from Claude Code 2.1.302 and codex-cli 0.162.1; see
    // tests/fixtures/work_steps/probe-notes.md.

    const CLAUDE_FIXTURE: &str = include_str!("../tests/fixtures/work_steps/claude_turn.jsonl");
    const CLAUDE_BACKGROUND: &str =
        include_str!("../tests/fixtures/work_steps/claude_background.jsonl");
    const CODEX_FIXTURE: &str = include_str!("../tests/fixtures/work_steps/codex_turn.jsonl");
    const CODEX_PLAN_ONLY: &str = include_str!("../tests/fixtures/work_steps/codex_plan_only.jsonl");
    const GROK_FIXTURE: &str = include_str!("../tests/fixtures/work_steps/grok_turn.jsonl");
    const CODEX_MAIN: &str = "01a14863-3c1a-76f2-a8b5-d5b52a9af162";
    const CODEX_HELPER: &str = "01a14863-5be9-75b1-ad9d-4cedc4b0b31d";

    /// Every `Work` step as it was last reported, in the order first seen.
    fn work(steps: &[Step]) -> Vec<WorkStep> {
        let mut out: Vec<WorkStep> = Vec::new();
        for step in steps {
            if let Step::Work(w) = step {
                match out.iter_mut().find(|o| o.key == w.key) {
                    Some(old) => *old = w.clone(),
                    None => out.push(w.clone()),
                }
            }
        }
        out
    }

    fn step<'a>(all: &'a [WorkStep], key: &str) -> &'a WorkStep {
        all.iter().find(|s| s.key == key).unwrap_or_else(|| panic!("no step {key}: {all:#?}"))
    }

    fn todos(steps: &[Step]) -> Vec<Vec<(String, TodoStatus)>> {
        steps
            .iter()
            .filter_map(|s| match s {
                Step::Todo(items) => {
                    Some(items.iter().map(|i| (i.text.clone(), i.status)).collect())
                }
                _ => None,
            })
            .collect()
    }

    fn claude_steps(stream: &str, cwd: &str) -> Vec<Step> {
        let mut reader = EventReader::new(OutputFormat::ClaudeStream, Some(cwd.into()));
        let mut steps = reader.push(stream);
        steps.extend(reader.finish());
        steps
    }

    fn codex_reader(cwd: &str) -> EventReader {
        let mut reader = EventReader::new(OutputFormat::CodexServer, Some(cwd.into()));
        reader.own_thread(CODEX_MAIN);
        reader
    }

    #[test]
    fn claude_fixture_steps_have_output_and_clean_labels() {
        let all = work(&claude_steps(CLAUDE_FIXTURE, "/tmp/probe1"));
        let ls = step(&all, "toolu_01EwDEgK7zs3Eu6JrA2YNM3M");
        assert_eq!((ls.kind, ls.label.as_str(), ls.folder.as_deref()), (StepKind::Command, "ls", None));
        assert_eq!(ls.detail, "cd /tmp/probe1 && ls");
        assert_eq!(ls.output.as_deref(), Some("a.txt\nh.txt"));
        let read = step(&all, "toolu_01BkEqwZ6MTA15AwLNLeksdR");
        assert_eq!((read.kind, read.label.as_str()), (StepKind::Read, "Read a.txt"));
        assert!(read.output.as_deref().unwrap().contains("beta needle gamma"));
        let failed = step(&all, "toolu_012siJY36jGo8iToMLgLn1zp");
        assert_eq!(failed.status, StepStatus::Failed);
        assert!(failed.output.as_deref().unwrap().contains("No such file"));
        let search = step(&all, "toolu_0154iNqTk1wwaX6ENeUtrEy6");
        assert_eq!((search.kind, search.label.as_str()), (StepKind::Tool, "ToolSearch select:Grep"));
        for s in &all {
            assert!(matches!(s.status, StepStatus::Done | StepStatus::Failed), "{s:?}");
            assert!(s.label.chars().count() <= 120, "{s:?}");
        }
        // Run outside the room folder, the folder is noted.
        let all = work(&claude_steps(CLAUDE_FIXTURE, "/work/other"));
        assert_eq!(step(&all, "toolu_01EwDEgK7zs3Eu6JrA2YNM3M").folder.as_deref(), Some("probe1"));
    }

    #[test]
    fn claude_helper_steps_hang_under_their_helper() {
        let agent = "toolu_01BUHf3htVv5zFV1QmHyiTVd";
        let all = work(&claude_steps(CLAUDE_FIXTURE, "/tmp/probe1"));
        let helper = step(&all, agent);
        assert_eq!(
            (helper.kind, helper.label.as_str(), helper.status, helper.parent.as_deref()),
            (StepKind::Helper, "Read h.txt and report", StepStatus::Done, None)
        );
        assert!(helper.output.as_deref().unwrap().contains("Subagent hand-back"));
        let read = step(&all, "toolu_01CnLaX8mL3u6vg54tJrzfXr");
        assert_eq!((read.label.as_str(), read.parent.as_deref()), ("Read h.txt", Some(agent)));
        assert_eq!(all.iter().filter(|s| s.parent.is_some()).count(), 1);
    }

    #[test]
    fn claude_todo_becomes_todo_not_a_step() {
        let steps = claude_steps(CLAUDE_FIXTURE, "/tmp/probe1");
        let one = "Read helper file via agent".to_string();
        let two = "Finish probe steps 1-5".to_string();
        assert_eq!(
            todos(&steps),
            [
                vec![(one.clone(), TodoStatus::Pending)],
                vec![(one.clone(), TodoStatus::Pending), (two.clone(), TodoStatus::Pending)],
                vec![(one.clone(), TodoStatus::Pending), (two.clone(), TodoStatus::Completed)],
                vec![(one, TodoStatus::Completed), (two, TodoStatus::Completed)],
            ]
        );
        let all = work(&steps);
        for key in ["toolu_011xQjbhXnzqKosxnVsusqQ4", "toolu_01T9tfNcug66Tfbegqtx1bCW", "toolu_01FiannS5P5LA6id63DwPW4x"] {
            assert!(all.iter().all(|s| s.key != key), "{key} became a step");
        }

        let write = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"TodoWrite","input":{"todos":[{"content":"Look","status":"completed","activeForm":"Looking"},{"content":"Fix","status":"in_progress","activeForm":"Fixing"},{"content":"Test","status":"pending","activeForm":"Testing"}]}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}
"#;
        let steps = claude_steps(write, "/w");
        assert_eq!(
            todos(&steps),
            [vec![
                ("Look".to_string(), TodoStatus::Completed),
                ("Fix".to_string(), TodoStatus::InProgress),
                ("Test".to_string(), TodoStatus::Pending),
            ]]
        );
        assert!(work(&steps).is_empty());
    }

    #[test]
    fn claude_task_tools_fold_into_todo() {
        // The id may only be in the result text; a refused call changes
        // nothing; TaskGet and TaskList are not steps either.
        let stream = r##"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"TaskCreate","input":{"subject":"Build","description":"d","activeForm":"Building"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c1","content":"Task #7 created successfully: Build"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c2","name":"TaskCreate","input":{"subject":"Nope"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c2","content":"failed","is_error":true}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"u1","name":"TaskUpdate","input":{"taskId":"7","status":"in_progress"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"u1","content":"Updated task #7 status"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"g1","name":"TaskList","input":{}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"g1","content":"#7 Build"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"g2","name":"TaskGet","input":{"taskId":"7"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"g2","content":"#7 Build"}]}}
"##;
        let steps = claude_steps(stream, "/w");
        assert_eq!(
            todos(&steps),
            [
                vec![("Build".to_string(), TodoStatus::Pending)],
                vec![("Build".to_string(), TodoStatus::InProgress)],
            ]
        );
        assert!(work(&steps).is_empty());
    }

    #[test]
    fn claude_background_helper_done_on_notification() {
        let agent = "toolu_01BE3XrCoJzmLMDPG1M9LAVq";
        let steps = claude_steps(CLAUDE_BACKGROUND, "/tmp/probe2");
        // The launch notice is kept as output, but the helper is still working.
        let launched = steps
            .iter()
            .filter_map(|s| match s {
                Step::Work(w) if w.key == agent && w.output.is_some() => Some(w),
                _ => None,
            })
            .next()
            .unwrap();
        assert_eq!(launched.status, StepStatus::Running);
        assert!(launched.output.as_deref().unwrap().contains("Async agent launched"));
        let all = work(&steps);
        let helper = step(&all, agent);
        assert_eq!((helper.kind, helper.status), (StepKind::Helper, StepStatus::Done));
        let read = step(&all, "toolu_01UXd4WqaaYxBNtJgvyJ8PPE");
        assert_eq!((read.parent.as_deref(), read.status), (Some(agent), StepStatus::Done));

        // Without the notification, leaving the background list ends it too.
        let quiet: String = CLAUDE_BACKGROUND
            .lines()
            .filter(|l| !l.contains("\"task_notification\""))
            .map(|l| format!("{l}\n"))
            .collect();
        let all = work(&claude_steps(&quiet, "/tmp/probe2"));
        assert_eq!(step(&all, agent).status, StepStatus::Done);
    }

    #[test]
    fn codex_fixture_reads_are_labelled_read() {
        let mut reader = codex_reader("/tmp/probe3");
        let all = work(&reader.push(CODEX_FIXTURE));
        let missing = step(&all, "exec-133dd8aa-f5fd-4217-ba52-86bceef8698b");
        assert_eq!(
            (missing.kind, missing.label.as_str(), missing.status, missing.exit_code),
            (StepKind::Read, "Read missing.txt", StepStatus::Failed, Some(1))
        );
        assert_eq!(missing.folder, None);
        let search = step(&all, "exec-e3818cc5-15e1-4f91-89da-7c312e926133");
        assert_eq!((search.kind, search.label.as_str()), (StepKind::Search, "Search needle in probe3"));
        let list = step(&all, "exec-05389622-bbaf-429b-bf1c-32cc7162e089");
        assert_eq!((list.kind, list.label.as_str()), (StepKind::List, "List sub"));
        let both = step(&all, "exec-89ef202e-1e20-4e75-95f0-896d906aba4b");
        assert_eq!(both.label, "cat /tmp/probe3/a.txt /tmp/probe3/b.txt");
        assert_eq!(both.detail, "cat /tmp/probe3/a.txt /tmp/probe3/b.txt");
        // Somewhere else, the folder is noted.
        let mut reader = codex_reader("/work/project");
        let all = work(&reader.push(CODEX_FIXTURE));
        assert_eq!(step(&all, "exec-133dd8aa-f5fd-4217-ba52-86bceef8698b").folder.as_deref(), Some("probe3"));
    }

    #[test]
    fn codex_command_output_exit_and_duration() {
        let mut reader = codex_reader("/tmp/probe3");
        let steps = reader.push(CODEX_FIXTURE);
        let git = "exec-052f7958-d13c-400a-b6d4-866af86bc587";
        let first = steps
            .iter()
            .find_map(|s| match s {
                Step::Work(w) if w.key == git => Some(w.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!((first.status, first.output.as_deref()), (StepStatus::Running, None));
        let all = work(&steps);
        let git = step(&all, git);
        assert_eq!(
            (git.kind, git.label.as_str(), git.status, git.exit_code, git.duration_ms),
            (StepKind::Command, "git status", StepStatus::Done, Some(0), Some(0))
        );
        assert!(git.output.as_deref().unwrap().starts_with("On branch main"));
        // Reasoning is not a step.
        assert!(all.iter().all(|s| s.kind != StepKind::Thinking));
    }

    #[test]
    fn codex_helper_steps_are_kept_and_parented() {
        let mut reader = codex_reader("/tmp/probe3");
        let (body, last) = CODEX_FIXTURE.trim_end().rsplit_once('\n').unwrap();
        let mut steps = reader.push(&format!("{body}\n"));
        // The helper's own turn end is not the end of this turn.
        assert!(!reader.turn_over());
        steps.extend(reader.push(&format!("{last}\n")));
        assert!(reader.turn_over());
        let all = work(&steps);
        let helper = step(&all, CODEX_HELPER);
        assert_eq!(
            (helper.kind, helper.label.as_str(), helper.status, helper.parent.as_deref()),
            (StepKind::Helper, "read_b", StepStatus::Done, None)
        );
        let read = step(&all, "exec-e5a16fd3-5427-4e31-9d78-5db46d96d369");
        assert_eq!(
            (read.label.as_str(), read.parent.as_deref(), read.status),
            ("Read b.txt", Some(CODEX_HELPER), StepStatus::Done)
        );
        assert_eq!(all.iter().filter(|s| s.parent.is_some()).count(), 1);
        assert!(!text(&steps).contains("Exact content"));
        assert!(!activity(&steps).contains(&"Running: /bin/zsh -lc 'cat /tmp/probe3/b.txt'"));
        assert_eq!(reader.outcome().text, "done");
    }

    #[test]
    fn codex_helper_box_fails_or_stops_with_its_thread() {
        let mut reader = EventReader::new(OutputFormat::CodexServer, None);
        reader.own_thread("T");
        let helper = |kind: &str, id: &str, path: &str| {
            format!(
                r#"{{"method":"item/completed","params":{{"threadId":"T","item":{{"type":"subAgentActivity","id":"x","kind":"{kind}","agentThreadId":"{id}","agentPath":"{path}"}}}}}}"#
            )
        };
        let mut steps = reader.push(&format!(
            "{}\n{}\n",
            helper("started", "H1", "/root/fix_tests"),
            helper("started", "H2", "/root/look")
        ));
        assert_eq!(step(&work(&steps), "H1").status, StepStatus::Running);
        steps.extend(reader.push(concat!(
            r#"{"method":"turn/completed","params":{"threadId":"H1","turn":{"status":"failed"}}}"#, "\n",
            r#"{"method":"turn/completed","params":{"threadId":"H2","turn":{"status":"interrupted"}}}"#, "\n",
        )));
        steps.extend(reader.push(&format!("{}\n", helper("completed", "H1", "/root/fix_tests"))));
        let all = work(&steps);
        assert_eq!((step(&all, "H1").label.as_str(), step(&all, "H1").status), ("fix_tests", StepStatus::Failed));
        assert_eq!(step(&all, "H2").status, StepStatus::Stopped);
        assert!(!reader.turn_over() && !reader.failed());
    }

    #[test]
    fn grok_todo_write_feeds_the_todo_list() {
        let steps = claude_steps(GROK_FIXTURE, "/tmp/probe");
        let lists = todos(&steps);
        assert_eq!(lists.len(), 4, "one list per todo_write result: {lists:?}");
        assert_eq!(
            lists[0],
            [
                ("Read a.txt".to_string(), TodoStatus::InProgress),
                ("Run ls sub".to_string(), TodoStatus::Pending),
                ("Run cat missing.txt".to_string(), TodoStatus::Pending),
                ("Search folder for alpha".to_string(), TodoStatus::Pending),
                ("Append 'probe' to a.txt".to_string(), TodoStatus::Pending),
                ("Start helper to count lines in a.txt".to_string(), TodoStatus::Pending),
            ]
        );
        // The later calls send only the items that changed; the result is
        // still the whole merged list.
        assert_eq!(lists[2][3].1, TodoStatus::Completed);
        assert!(lists[3].iter().all(|(_, status)| *status == TodoStatus::Completed), "{lists:?}");
        // The calls themselves are not work.
        assert!(work(&steps).iter().all(|s| !s.label.contains("todo_write")), "{:#?}", work(&steps));
    }

    #[test]
    fn a_todo_write_result_deck_cannot_read_still_shows_the_call() {
        let stream = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"todo_write","input":{"todos":[]}}]}}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Updated the todo list"}]}}"#,
            "\n",
        );
        let steps = claude_steps(stream, "/tmp/probe");
        assert!(todos(&steps).is_empty(), "no list to show: {steps:#?}");
        assert_eq!(work(&steps).len(), 1, "the call itself is shown: {steps:#?}");
    }

    #[test]
    fn codex_plan_updates_todo() {
        let mut reader = EventReader::new(OutputFormat::CodexServer, None);
        let lists = todos(&reader.push(CODEX_PLAN_ONLY));
        assert!(lists.len() >= 2, "{lists:?}");
        assert_eq!(
            lists[0],
            [
                ("read /tmp/probe3/a.txt".to_string(), TodoStatus::InProgress),
                ("ls /tmp/probe3".to_string(), TodoStatus::Pending),
                ("done".to_string(), TodoStatus::Pending),
            ]
        );
        assert_eq!(lists[1][0].1, TodoStatus::Completed);

        let mut reader = codex_reader("/tmp/probe3");
        let lists = todos(&reader.push(CODEX_FIXTURE));
        assert_eq!(lists.len(), 4);
        assert!(lists.last().unwrap().iter().all(|(_, s)| *s == TodoStatus::Completed), "{lists:?}");
    }

    #[test]
    fn codex_other_items_become_steps() {
        let stream = r#"{"method":"item/started","params":{"item":{"type":"reasoning","id":"r"}}}
{"method":"item/started","params":{"item":{"type":"fileChange","id":"f","changes":[{"path":"/work/project/src/lib.rs","kind":"update","diff":"-a\n+b\n"}],"status":"inProgress"}}}
{"method":"item/completed","params":{"item":{"type":"fileChange","id":"f","changes":[{"path":"/work/project/src/lib.rs","kind":"update","diff":"-a\n+b\n"}],"status":"declined"}}}
{"method":"item/started","params":{"item":{"type":"webSearch","id":"w","query":"rust serde"}}}
{"method":"item/completed","params":{"item":{"type":"webSearch","id":"w","query":"rust serde"}}}
{"method":"item/started","params":{"item":{"type":"mcpToolCall","id":"m","server":"db","tool":"query","arguments":{"sql":"select 1"},"status":"inProgress"}}}
{"method":"item/completed","params":{"item":{"type":"mcpToolCall","id":"m","server":"db","tool":"query","arguments":{"sql":"select 1"},"status":"failed","error":{"message":"no table"}}}}
"#;
        let (steps, _) = read(OutputFormat::CodexServer, &[stream]);
        let all = work(&steps);
        assert_eq!(all.len(), 3, "{all:#?}");
        let edit = step(&all, "f");
        assert_eq!((edit.kind, edit.label.as_str(), edit.status), (StepKind::Edit, "Edit lib.rs", StepStatus::Stopped));
        let web = step(&all, "w");
        assert_eq!((web.kind, web.status), (StepKind::Web, StepStatus::Done));
        assert!(web.label.contains("rust serde"));
        let tool = step(&all, "m");
        assert_eq!((tool.kind, tool.label.as_str(), tool.status), (StepKind::Tool, "db query", StepStatus::Failed));
        assert_eq!(tool.output.as_deref(), Some("no table"));
        // Activity lines are as before.
        assert_eq!(activity(&steps), ["Thinking", "Editing src/lib.rs", "Searching the web for rust serde", "Using db query"]);
    }

    #[test]
    fn codex_web_search_takes_the_query_from_its_completion() {
        let stream = r#"{"method":"item/started","params":{"item":{"type":"webSearch","id":"w","query":""}}}
{"method":"item/completed","params":{"item":{"type":"webSearch","id":"w","query":"rust serde"}}}
"#;
        let (steps, _) = read(OutputFormat::CodexServer, &[stream]);
        let web = step(&work(&steps), "w").clone();
        assert_eq!(web.label, "Search the web for rust serde");
        assert_eq!(web.detail, "rust serde");
        assert_eq!(web.status, StepStatus::Done);
    }

    #[test]
    fn steps_past_the_reply_limit_are_not_kept_or_sent() {
        let limit = apex_core::work_steps::STEPS_PER_REPLY_MAX;
        let mut stream = String::new();
        for n in 0..limit + 3 {
            stream.push_str(&format!(
                "{}\n",
                serde_json::json!({"method":"item/started","params":{"item":{"type":"webSearch","id":format!("w{n}"),"query":"q"}}})
            ));
        }
        // The last kept step still finishes.
        stream.push_str(&format!(
            "{}\n",
            serde_json::json!({"method":"item/completed","params":{"item":{"type":"webSearch","id":format!("w{}", limit - 1),"query":"q"}}})
        ));
        let mut reader = EventReader::new(OutputFormat::CodexServer, Some("/work/project".into()));
        let steps = reader.push(&stream);
        let all = work(&steps);
        assert_eq!(all.len(), limit);
        assert!(all.iter().all(|s| s.key != format!("w{limit}")));
        assert_eq!(step(&all, &format!("w{}", limit - 1)).status, StepStatus::Done);
        assert_eq!(reader.work.len(), limit);
    }

    #[test]
    fn long_labels_are_capped_at_120_characters() {
        let command = "é".repeat(500);
        let stream = format!(
            "{}\n",
            serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Bash","input":{"command":command}}]}})
        );
        let all = work(&claude_steps(&stream, "/w"));
        assert_eq!(all[0].label.chars().count(), 120);
        assert!(all[0].label.ends_with('…'));
        assert_eq!(all[0].detail, command);
    }

    #[test]
    fn activity_lines_unchanged() {
        let steps = claude_steps(CLAUDE_FIXTURE, "/tmp/probe1");
        assert_eq!(
            activity(&steps),
            [
                "Running: cd /tmp/probe1 && ls",
                "Reading a.txt",
                "Using ToolSearch",
                "Running: grep -rn \"needle\" /tmp/probe1",
                "Running: cat /tmp/probe1/nonexistent_file",
                "Using ToolSearch",
                "Using TaskCreate",
                "Using TaskUpdate",
                "Starting a helper: Read h.txt and report",
                "Reading h.txt",
                "Using TaskUpdate",
            ]
        );
        let steps = claude_steps(CLAUDE_BACKGROUND, "/tmp/probe1");
        assert_eq!(
            activity(&steps),
            ["Starting a helper: Read /tmp/probe2/h.txt and report", "Reading /tmp/probe2/h.txt"]
        );
        let mut reader = codex_reader("/tmp/probe1");
        assert_eq!(
            activity(&reader.push(CODEX_FIXTURE)),
            [
                "Running: /bin/zsh -lc 'cat /tmp/probe3/a.txt /tmp/probe3/b.txt'",
                "Running: /bin/zsh -lc 'rg \"needle\" /tmp/probe3'",
                "Running: /bin/zsh -lc 'ls /tmp/probe3/sub'",
                "Running: /bin/zsh -lc 'git status'",
                "Running: /bin/zsh -lc 'cat /tmp/probe3/missing.txt'",
            ]
        );
    }
}
