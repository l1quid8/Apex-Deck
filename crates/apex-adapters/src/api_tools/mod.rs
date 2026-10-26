//! Tools for bots reached through an OpenAI-style API.
//!
//! Coding agents (Claude Code, Codex and the rest) bring their own tools.
//! A bot that is only an HTTP endpoint brings none, so Deck lends it a set:
//! a shell, files, search, web pages and the person's MCP servers. Every
//! call is checked against the bot's access level and the thread's Plan
//! switch the way the agents' own permission settings are, and anything
//! the level says to ask about goes to the person as an approval card.
//!
//! | Access          | Read and search | Edit files          | Run commands | Risky MCP tools |
//! |-----------------|-----------------|---------------------|--------------|-----------------|
//! | Read only, Plan | yes             | no                  | no           | ask (no in Plan)|
//! | Ask first       | yes             | ask                 | ask          | ask             |
//! | Can edit files  | yes             | yes (outside: ask)  | ask          | ask             |
//! | Full access     | yes             | yes                 | yes          | ask             |
//!
//! Reading outside the project and its attachments, and fetching a web
//! page, ask below Full access.

pub(crate) mod files;
pub(crate) mod mcp_client;
pub(crate) mod shell;
pub(crate) mod web;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use apex_core::work_steps::{cut_detail, cut_output, StepKind, StepStatus, TodoItem, TodoStatus, WorkStep};
use apex_core::{Access, ActionKind, Approver, FileChange, Progress, ProgressSink, ProposedAction, Question, QuestionOption};
use serde_json::{json, Value};

use crate::owned_process::Registry;

/// Most characters of one tool result given back to the model.
pub(crate) const RESULT_MAX: usize = 30_000;
/// Longest a command may run before it is stopped, unless it asks for less.
const COMMAND_DEFAULT: Duration = Duration::from_secs(120);
const COMMAND_MAX: Duration = Duration::from_secs(600);
/// Longest an MCP call may take, unless it asks for less.
const MCP_DEFAULT: Duration = Duration::from_secs(120);

/// What a bot's tools work with. Lives as long as the bot: its MCP servers
/// keep running between replies.
pub(crate) struct ToolBox {
    pub roots: files::Roots,
    pub env: shell::Env,
    /// Commands the bot runs. Stop ends them all.
    pub processes: Registry,
    pub mcp: mcp_client::Pool,
}

impl ToolBox {
    pub fn new(context: &crate::BuildContext) -> Self {
        let mut readable: Vec<PathBuf> = context.attachment_roots.clone();
        readable.extend(context.temp.clone());
        if let Some(dir) = crate::presets::readable_dir() {
            readable.push(PathBuf::from(dir));
        }
        Self {
            roots: files::Roots::new(context.cwd.as_deref(), &readable),
            env: shell::Env {
                cwd: context.cwd.clone(),
                path: context.path.clone(),
                temp: context.temp.clone(),
                cargo_target_dir: context.cargo_target_dir.clone(),
            },
            processes: Registry::new(context.process_registry.clone()),
            mcp: mcp_client::Pool::default(),
        }
    }
}

/// One tool call the model made.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ToolCall {
    pub id: String,
    pub name: String,
    /// The arguments as the model wrote them: JSON, possibly broken.
    pub arguments: String,
    /// What else the server put on the call (Gemini's thought signature),
    /// as JSON, to be sent back with it unchanged.
    pub extra: Option<String>,
}

fn tool(name: &str, description: &str, parameters: Value) -> Value {
    json!({"type": "function", "function": {"name": name, "description": description, "parameters": parameters}})
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type": "object", "properties": properties, "required": required, "additionalProperties": false})
}

/// The tools of one turn, and what the turn may do with them.
pub(crate) struct Turn<'a> {
    tools: &'a ToolBox,
    /// What this turn may do now. Leaving Plan mode raises it to `own`.
    access: Access,
    plan: bool,
    /// The bot's own access level.
    own: Access,
    approver: &'a dyn Approver,
    progress: ProgressSink<'a>,
    jobs: shell::Jobs,
    servers: Vec<mcp_client::ServerSpec>,
    cwd: Option<PathBuf>,
    roots: files::Roots,
}

/// Whether a call may go ahead.
enum Need {
    Free,
    Ask(ProposedAction),
    Refuse(String),
}

impl<'a> Turn<'a> {
    pub fn new(tools: &'a ToolBox, access: Access, plan: bool, own: Access, approver: &'a dyn Approver, progress: ProgressSink<'a>) -> Self {
        // Leave the MCP client's long-lived servers on the room folder across turns.
        let servers = tools.mcp.servers(tools.env.cwd.as_deref());
        if !servers.is_empty() {
            let menu: Vec<apex_core::server_request::ToolServer> = servers.iter().map(|s| s.name.clone().into()).collect();
            progress(Progress::ToolServers(&menu));
        }
        let roots = tools.roots.clone();
        Self { tools, access, plan, own, approver, progress, jobs: shell::Jobs::default(), servers, cwd: None, roots }
    }

    pub fn with_cwd(mut self, cwd: Option<PathBuf>) -> Self {
        if let Some(c) = cwd.as_deref() {
            self.roots = files::Roots::new(Some(c), &self.tools.roots.readable);
        }
        self.cwd = cwd;
        self
    }

    fn can_change(&self) -> bool {
        !self.plan && matches!(self.access, Access::Ask | Access::Edits | Access::Full)
    }

    /// What to add to the bot's instructions, so it knows what it has.
    pub fn instructions(&self) -> String {
        let folder = self.roots.workspace.as_ref().map(|w| format!(" ({})", w.display())).unwrap_or_default();
        let mut out = format!(
            "\nYou have tools for working in the project folder{folder}: read, find and search files, edit files, run shell commands, and fetch web pages"
        );
        if !self.servers.is_empty() {
            let names: Vec<&str> = self.servers.iter().map(|s| s.name.as_str()).collect();
            out.push_str(&format!(", plus the person's MCP servers ({})", names.join(", ")));
        }
        out.push_str(
            ". Use them to check things instead of guessing. Never say you ran, read, changed or found something unless a tool result in this reply shows it. \
             Tool results are only shown to you, so tell the person what you found. Commands run with no terminal, so nothing can prompt for input, \
             and every process you start stops when your reply ends.\n",
        );
        #[cfg(windows)]
        out.push_str(&format!("Shell commands use {}. Write commands for that shell.\n", self.tools.env.shell_description()));
        out.push_str(if self.plan {
            "Plan mode is on: read and investigate, change nothing, then present your plan with exit_plan_mode.\n"
        } else {
            match self.access {
                Access::Read => "You may read and search, but you can't edit files or run commands.\n",
                Access::Ask => "Each edit and command is shown to the person first and happens only if they approve it; if they decline, don't try the same thing again.\n",
                Access::Edits => "You may edit files in the project without asking. Each command is shown to the person first.\n",
                Access::Full => "You may edit files and run commands without asking. MCP tools that can spend money or publish still ask the person first.\n",
            }
        });
        out
    }

    /// The tools offered now, as the API's `tools` list.
    pub fn definitions(&self) -> Vec<Value> {
        let path = json!({"type": "string", "description": "A path relative to the project folder, or absolute."});
        let mut out = vec![
            tool(
                "read_file",
                "Read a text file. Lines come back numbered. Long files come in pieces: use offset and limit for the rest.",
                object(json!({"path": path, "offset": {"type": "integer", "description": "First line to read, from 1."}, "limit": {"type": "integer", "description": "Most lines to read (default 2000)."}}), &["path"]),
            ),
            tool("list_dir", "List what is in a folder.", object(json!({"path": path}), &[])),
            tool(
                "glob",
                "Find files by path pattern, newest first, skipping what .gitignore excludes. A pattern without '/' matches file names at any depth, e.g. '*.rs'; use '**' for deeper paths, e.g. 'src/**/test_*.py'.",
                object(json!({"pattern": {"type": "string"}, "path": {"type": "string", "description": "Folder to search in (default: the project)."}}), &["pattern"]),
            ),
            tool(
                "grep",
                "Search file contents with a regular expression, skipping what .gitignore excludes and binary files.",
                object(
                    json!({
                        "pattern": {"type": "string", "description": "A regular expression (Rust syntax)."},
                        "path": {"type": "string", "description": "File or folder to search (default: the project)."},
                        "glob": {"type": "string", "description": "Only files matching this pattern, e.g. '*.ts'."},
                        "output_mode": {"type": "string", "enum": ["files_with_matches", "content", "count"], "description": "Default: files_with_matches."},
                        "case_insensitive": {"type": "boolean"},
                        "context": {"type": "integer", "description": "Lines shown around each match in content mode."},
                        "max_results": {"type": "integer", "description": "Default 250."}
                    }),
                    &["pattern"],
                ),
            ),
            tool(
                "web_fetch",
                "Fetch a web page or file over http(s) and read it as text.",
                object(json!({"url": {"type": "string"}}), &["url"]),
            ),
            tool(
                "todo_write",
                "Keep a to-do list for a task with several steps, shown to the person. Send the whole list each time.",
                object(
                    json!({"todos": {"type": "array", "items": object(json!({"content": {"type": "string"}, "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}}), &["content", "status"])}}),
                    &["todos"],
                ),
            ),
            tool(
                "ask_user",
                "Ask the person one or more questions and wait for the answers. For choices only they can make; don't ask what you can find out yourself.",
                object(
                    json!({"questions": {"type": "array", "items": object(json!({
                        "question": {"type": "string"},
                        "header": {"type": "string", "description": "A short tag, a word or two."},
                        "options": {"type": "array", "items": object(json!({"label": {"type": "string"}, "description": {"type": "string"}}), &["label"])},
                        "multi_select": {"type": "boolean"}
                    }), &["question"])}}),
                    &["questions"],
                ),
            ),
        ];
        if self.can_change() {
            out.extend([
                tool(
                    "write_file",
                    "Create a file or replace all of it. Missing folders are made. For a change to part of an existing file, use edit_file.",
                    object(json!({"path": path, "content": {"type": "string"}}), &["path", "content"]),
                ),
                tool(
                    "edit_file",
                    "Replace exact text in a file. old_string must match the file exactly, spaces and line breaks included, and appear once unless replace_all is set. Read the file first.",
                    object(json!({"path": path, "old_string": {"type": "string"}, "new_string": {"type": "string"}, "replace_all": {"type": "boolean"}}), &["path", "old_string", "new_string"]),
                ),
                tool(
                    "run_command",
                    "Run a shell command in the project folder and get its output and exit code. Stops after timeout_seconds (default 120, at most 600). With background set, it keeps running while you work and you get a job id; read its output with job_output.",
                    object(json!({"command": {"type": "string"}, "timeout_seconds": {"type": "integer"}, "background": {"type": "boolean"}}), &["command"]),
                ),
                tool(
                    "job_output",
                    "New output from a background command since you last looked, and whether it has finished. wait_seconds (up to 600) waits for it to finish first.",
                    object(json!({"job_id": {"type": "string"}, "wait_seconds": {"type": "integer"}}), &["job_id"]),
                ),
                tool("job_stop", "Stop a background command and everything it started.", object(json!({"job_id": {"type": "string"}}), &["job_id"])),
            ]);
        }
        if !self.servers.is_empty() {
            let names: Vec<&str> = self.servers.iter().map(|s| s.name.as_str()).collect();
            let server = json!({"type": "string", "enum": names});
            out.extend([
                tool(
                    "mcp_list_tools",
                    "List an MCP server's tools with what each takes. Do this before calling a server's tool for the first time.",
                    object(json!({"server": server}), &["server"]),
                ),
                tool(
                    "mcp_call",
                    "Call a tool on an MCP server. Tools that can spend money, publish or change things ask the person first.",
                    object(json!({"server": server, "tool": {"type": "string"}, "arguments": {"type": "object"}, "timeout_seconds": {"type": "integer"}}), &["server", "tool"]),
                ),
            ]);
        }
        if self.plan {
            out.push(tool(
                "exit_plan_mode",
                "Show the person your plan and ask to start the work. If they agree, Plan mode ends and you carry the plan out.",
                object(json!({"plan": {"type": "string", "description": "The plan, in Markdown."}}), &["plan"]),
            ));
        }
        out
    }

    fn step(&self, call: &ToolCall, kind: StepKind, label: &str, detail: &str) -> WorkStep {
        let label: String = label.chars().take(120).collect();
        WorkStep {
            key: call.id.clone(),
            parent: None,
            kind,
            label,
            folder: None,
            detail: cut_detail(detail),
            output: None,
            status: StepStatus::Running,
            exit_code: None,
            duration_ms: None,
            output_cut: false,
        }
    }

    async fn allowed(&self, need: Need) -> Result<(), String> {
        match need {
            Need::Free => Ok(()),
            Need::Refuse(why) => Err(why),
            Need::Ask(action) => {
                (self.progress)(Progress::Activity(&format!("Waiting for approval: {}", action.title)));
                let title = action.title.clone();
                if self.approver.decide(action).await.approved() {
                    Ok(())
                } else {
                    Err(format!("The person declined: {title}. Don't try the same thing again; ask them, or find another way."))
                }
            }
        }
    }

    /// `what` is the tool and its pattern, such as `grep "key"`, so the card
    /// says what will be read and "Always allow" covers only that.
    fn read_need(&self, resolved: &files::Resolved, what: &str) -> Need {
        if resolved.readable || (self.access == Access::Full && !self.plan) {
            Need::Free
        } else {
            Need::Ask(ProposedAction {
                kind: ActionKind::Other,
                title: format!("{what} outside the project: {}", resolved.shown),
                detail: format!("{what} {}", resolved.path.display()),
                expires_at: None,
                risky: false,
            })
        }
    }

    fn change_need(&self, resolved: &files::Resolved, verb: &str, diff: &str) -> Need {
        if self.plan {
            return Need::Refuse("Plan mode is on, so nothing may be changed. Present the plan with exit_plan_mode.".into());
        }
        let card = || ProposedAction { kind: ActionKind::Edit, title: format!("{verb} {}", resolved.shown), detail: diff.to_string(), expires_at: None, risky: false };
        match self.access {
            Access::Read => Need::Refuse("This bot has read-only access, so it can't change files.".into()),
            Access::Ask => Need::Ask(card()),
            // Settings that start programs (MCP servers, Claude Code hooks,
            // git config) can turn an edit into a command, so they ask.
            Access::Edits if !resolved.inside || starts_programs(&resolved.path) => Need::Ask(card()),
            Access::Edits | Access::Full => Need::Free,
        }
    }

    fn command_need(&self, command: &str) -> Need {
        if self.plan {
            return Need::Refuse("Plan mode is on, so no commands may be run. Present the plan with exit_plan_mode.".into());
        }
        match self.access {
            Access::Read => Need::Refuse("This bot has read-only access, so it can't run commands.".into()),
            Access::Ask | Access::Edits => Need::Ask(ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: command.to_string(), expires_at: None, risky: false }),
            Access::Full => Need::Free,
        }
    }

    /// Carry out one call and give back what the model should be told.
    pub async fn run(&mut self, call: &ToolCall) -> String {
        let arguments: Value = if call.arguments.trim().is_empty() {
            json!({})
        } else {
            match serde_json::from_str(&call.arguments) {
                Ok(value @ Value::Object(_)) => value,
                Ok(_) => return "The arguments must be a JSON object. Send the call again.".into(),
                Err(e) => return format!("The arguments weren't valid JSON ({e}). Send the call again with a JSON object."),
            }
        };
        let started = Instant::now();
        let (mut step, outcome) = self.dispatch(call, &arguments).await;
        let (text, failed, code) = match outcome {
            Ok(Done { text, failed, code }) => (text, failed, code),
            Err(why) => (why, true, None),
        };
        step.status = if failed { StepStatus::Failed } else { StepStatus::Done };
        step.exit_code = code;
        step.duration_ms = Some(started.elapsed().as_millis() as u64);
        let shown = cut_output(&text);
        step.output_cut = shown.len() < text.len();
        step.output = Some(shown);
        (self.progress)(Progress::Work(&step));
        cut_result(&text)
    }

    async fn dispatch(&mut self, call: &ToolCall, args: &Value) -> (WorkStep, Result<Done, String>) {
        let s = |key: &str| args[key].as_str().unwrap_or("").to_string();
        match call.name.as_str() {
            "read_file" | "list_dir" | "glob" | "grep" => {
                let raw = s("path");
                let resolved = match self.roots.resolve(&raw) {
                    Ok(resolved) => resolved,
                    Err(why) => return (self.step(call, StepKind::Read, &call.name, &raw), Err(why)),
                };
                let (kind, label) = match call.name.as_str() {
                    "read_file" => (StepKind::Read, format!("Read {}", resolved.shown)),
                    "list_dir" => (StepKind::List, format!("List {}", resolved.shown)),
                    "glob" => (StepKind::Search, format!("Find {}", s("pattern"))),
                    _ => (StepKind::Search, format!("Search for {}", s("pattern"))),
                };
                let step = self.step(call, kind, &label, &args.to_string());
                (self.progress)(Progress::Work(&step));
                let what = match call.name.as_str() {
                    "read_file" => "Read".to_string(),
                    "list_dir" => "List".to_string(),
                    "glob" => format!("Find files matching {:?}", s("pattern")),
                    _ => format!("Search file contents for {:?}{}", s("pattern"), if args["output_mode"] == "content" { ", showing the lines" } else { "" }),
                };
                if let Err(why) = self.allowed(self.read_need(&resolved, &what)).await {
                    return (step, Err(why));
                }
                let path = resolved.path.clone();
                let name = call.name.clone();
                let args = args.clone();
                let shown = resolved.shown.clone();
                let result = tokio::task::spawn_blocking(move || match name.as_str() {
                    "read_file" => files::read(&path, args["offset"].as_u64(), args["limit"].as_u64()),
                    "list_dir" => files::list(&path),
                    "glob" => files::glob(&path, args["pattern"].as_str().unwrap_or("")),
                    _ => {
                        let mode = match args["output_mode"].as_str() {
                            Some("content") => files::GrepMode::Content,
                            Some("count") => files::GrepMode::Count,
                            _ => files::GrepMode::Files,
                        };
                        let grep = files::Grep {
                            pattern: args["pattern"].as_str().unwrap_or(""),
                            glob: args["glob"].as_str().filter(|g| !g.trim().is_empty()),
                            ignore_case: args["case_insensitive"] == true,
                            mode,
                            context: args["context"].as_u64().unwrap_or(0).min(20) as usize,
                            max: args["max_results"].as_u64().unwrap_or(250).clamp(1, 5_000) as usize,
                        };
                        files::grep(&path, &shown, &grep)
                    }
                })
                .await
                .unwrap_or_else(|e| Err(format!("The search failed: {e}")));
                (step, result.map(Done::text))
            }
            "write_file" | "edit_file" => self.change(call, args).await,
            "run_command" => self.command(call, args).await,
            "job_output" => {
                let id = s("job_id");
                let step = self.step(call, StepKind::Command, &format!("Check {id}"), &id);
                let wait = Duration::from_secs(args["wait_seconds"].as_u64().unwrap_or(0).min(600));
                if !wait.is_zero() {
                    (self.progress)(Progress::Work(&step));
                    (self.progress)(Progress::Activity(&format!("Waiting for {id}")));
                }
                let result = self.jobs.output(&id, wait).await.map(|(text, state, elapsed, command)| {
                    let (status, code) = match state {
                        shell::State::Running => (format!("still running after {}s", elapsed.as_secs()), None),
                        shell::State::Exited(code) => (format!("finished with exit code {}", code.map_or("unknown".into(), |c| c.to_string())), code),
                        shell::State::Stopped => ("stopped".to_string(), None),
                    };
                    let body = if text.is_empty() { "(no new output)".to_string() } else { text };
                    Done { text: format!("{id} (`{command}`): {status}.\n{body}"), failed: false, code }
                });
                (step, result)
            }
            "job_stop" => {
                let id = s("job_id");
                let step = self.step(call, StepKind::Command, &format!("Stop {id}"), &id);
                let result = self.jobs.stop(&id).await.map(|state| Done::text(format!("{id} is {}.", if state == shell::State::Running { "still stopping" } else { "stopped" })));
                (step, result)
            }
            "web_fetch" => {
                let url = s("url");
                let step = self.step(call, StepKind::Web, &format!("Fetch {url}"), &url);
                (self.progress)(Progress::Work(&step));
                let need = if self.access == Access::Full && !self.plan {
                    Need::Free
                } else {
                    Need::Ask(ProposedAction { kind: ActionKind::Other, title: format!("Fetch {url}"), detail: url.clone(), expires_at: None, risky: false })
                };
                if let Err(why) = self.allowed(need).await {
                    return (step, Err(why));
                }
                (step, web::fetch(&url).await.map(Done::text))
            }
            "mcp_list_tools" | "mcp_call" => self.mcp(call, args).await,
            "todo_write" => {
                let step = self.step(call, StepKind::Other, "Update the to-do list", "");
                let items: Vec<TodoItem> = args["todos"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| {
                        let text = t["content"].as_str().or(t["text"].as_str())?.trim().to_string();
                        let status = match t["status"].as_str() {
                            Some("completed") => TodoStatus::Completed,
                            Some("in_progress") => TodoStatus::InProgress,
                            _ => TodoStatus::Pending,
                        };
                        (!text.is_empty()).then_some(TodoItem { text, status })
                    })
                    .collect();
                (self.progress)(Progress::Todo(&items));
                (step, Ok(Done::text(format!("The to-do list has {} items.", items.len()))))
            }
            "ask_user" => {
                let step = self.step(call, StepKind::Other, "Ask the person", &args.to_string());
                let questions: Vec<Question> = args["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|q| Question {
                        header: q["header"].as_str().unwrap_or("").to_string(),
                        question: q["question"].as_str().unwrap_or("").to_string(),
                        options: q["options"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|o| QuestionOption { label: o["label"].as_str().unwrap_or("").to_string(), description: o["description"].as_str().unwrap_or("").to_string() })
                            .collect(),
                        multi_select: q["multi_select"] == true,
                    })
                    .collect();
                if questions.is_empty() {
                    return (step, Err("No questions were given.".into()));
                }
                (self.progress)(Progress::Activity("Waiting for your answer"));
                let asked: Vec<String> = questions.iter().map(|q| q.question.clone()).collect();
                let result = match self.approver.ask(questions).await {
                    apex_core::Answer::Answered(answers) => Ok(Done::text(
                        asked
                            .iter()
                            .zip(answers.iter().map(|a| a.join(", ")).chain(std::iter::repeat(String::new())))
                            .map(|(q, a)| format!("Q: {q}\nA: {}", if a.is_empty() { "(no answer)" } else { &a }))
                            .collect::<Vec<_>>()
                            .join("\n\n"),
                    )),
                    apex_core::Answer::Skipped => Err("The person skipped the questions. Carry on with your best judgement, or ask in your reply.".into()),
                };
                (step, result)
            }
            "exit_plan_mode" => {
                let plan = s("plan");
                let step = self.step(call, StepKind::Other, "Ask to start the work", &plan);
                if !self.plan {
                    return (step, Err("Plan mode isn't on.".into()));
                }
                if self.own == Access::Read {
                    return (step, Err("This bot has read-only access, so it can't start the work. Give the plan as your reply.".into()));
                }
                (self.progress)(Progress::Activity("Waiting for you: start the work?"));
                let action = ProposedAction { kind: ActionKind::Plan, title: "Start the work?".into(), detail: plan, expires_at: None, risky: false };
                if self.approver.decide(action).await.approved() {
                    self.plan = false;
                    self.access = self.own;
                    (step, Ok(Done::text("The person approved the plan. Plan mode is off; carry the plan out now.")))
                } else {
                    (step, Ok(Done::text("The person wants to keep planning. Change nothing; ask what to adjust, or refine the plan.")))
                }
            }
            other => (
                self.step(call, StepKind::Tool, other, &call.arguments),
                Err(format!("There is no tool called `{other}` here. Use one of the tools you were given.")),
            ),
        }
    }

    async fn change(&mut self, call: &ToolCall, args: &Value) -> (WorkStep, Result<Done, String>) {
        let raw = args["path"].as_str().unwrap_or("");
        let editing = call.name == "edit_file";
        let resolved = match self.roots.resolve(raw) {
            Ok(resolved) => resolved,
            Err(why) => return (self.step(call, StepKind::Edit, &call.name, raw), Err(why)),
        };
        let verb = if editing { "Edit" } else { "Write" };
        let step = self.step(call, StepKind::Edit, &format!("{verb} {}", resolved.shown), raw);
        (self.progress)(Progress::Work(&step));
        let path = resolved.path.clone();
        let before = match files::current(&path) {
            Ok(before) => before,
            Err(why) => return (step, Err(why)),
        };
        let after = if editing {
            let Some(text) = before.as_deref() else {
                return (step, Err(format!("{} doesn't exist. Use write_file to create it.", resolved.shown)));
            };
            match files::replace(text, args["old_string"].as_str().unwrap_or(""), args["new_string"].as_str().unwrap_or(""), args["replace_all"] == true) {
                Ok((after, _)) => after,
                Err(why) => return (step, Err(why)),
            }
        } else {
            args["content"].as_str().unwrap_or("").to_string()
        };
        let diff = files::diff(before.as_deref().unwrap_or(""), &after);
        if let Err(why) = self.allowed(self.change_need(&resolved, verb, &diff)).await {
            return (step, Err(why));
        }
        // Edited from what was read before asking: if the file moved on
        // while the person decided, start again rather than overwrite.
        match files::current(&path) {
            Ok(now) if now == before => {}
            Ok(_) => return (step, Err(format!("{} changed while waiting for approval. Read it again and redo the change.", resolved.shown))),
            Err(why) => return (step, Err(why)),
        }
        if let Err(why) = files::write(&path, &after) {
            return (step, Err(why));
        }
        let change = FileChange::new(resolved.shown.clone(), diff);
        (self.progress)(Progress::Change(&change));
        let done = match before {
            None => format!("Created {} ({} lines).", resolved.shown, after.lines().count()),
            Some(_) if editing => format!("Edited {}.", resolved.shown),
            Some(_) => format!("Replaced {} ({} lines).", resolved.shown, after.lines().count()),
        };
        (step, Ok(Done::text(done)))
    }

    async fn command(&mut self, call: &ToolCall, args: &Value) -> (WorkStep, Result<Done, String>) {
        let command = args["command"].as_str().unwrap_or("").trim().to_string();
        let label = command.split_whitespace().collect::<Vec<_>>().join(" ");
        let step = self.step(call, StepKind::Command, &label, &command);
        if command.is_empty() {
            return (step, Err("No command was given.".into()));
        }
        (self.progress)(Progress::Work(&step));
        if let Err(why) = self.allowed(self.command_need(&command)).await {
            return (step, Err(why));
        }
        let env = if let Some(cwd) = &self.cwd {
            let mut e = self.tools.env.clone();
            e.cwd = Some(cwd.clone());
            e
        } else {
            self.tools.env.clone()
        };
        if args["background"] == true {
            let result = self
                .jobs
                .start(&env, &self.tools.processes, &command)
                .map(|id| Done::text(format!("Started {id} in the background. Read its output with job_output; it stops when your reply ends.")));
            return (step, result);
        }
        let timeout = args["timeout_seconds"].as_u64().map(Duration::from_secs).unwrap_or(COMMAND_DEFAULT).clamp(Duration::from_secs(1), COMMAND_MAX);
        (self.progress)(Progress::Activity(&format!("Running {}", step.label)));
        let result = shell::run(&env, &self.tools.processes, &command, timeout).await.map(|finished| {
            let mut text = if finished.output.trim().is_empty() { "(no output)".to_string() } else { finished.output };
            if finished.timed_out {
                text.push_str(&format!("\n[stopped after {} seconds; use a longer timeout_seconds or background]", timeout.as_secs()));
            } else {
                text.push_str(&format!("\n[exit code {}]", finished.code.map_or("unknown".into(), |c| c.to_string())));
            }
            if finished.leftovers_stopped {
                text.push_str("\n[something it started kept running and was stopped; to keep a process running, use background]");
            }
            Done { text, failed: finished.timed_out || finished.code != Some(0), code: finished.code }
        });
        (step, result)
    }

    async fn mcp(&mut self, call: &ToolCall, args: &Value) -> (WorkStep, Result<Done, String>) {
        let name = args["server"].as_str().unwrap_or("").to_string();
        let tool_name = args["tool"].as_str().unwrap_or("").to_string();
        let listing = call.name == "mcp_list_tools";
        let label = if listing { format!("{name}: list tools") } else { format!("{name}: {tool_name}") };
        let step = self.step(call, StepKind::Tool, &label, &args.to_string());
        let Some(spec) = self.servers.iter().find(|s| s.name == name).cloned() else {
            let known: Vec<&str> = self.servers.iter().map(|s| s.name.as_str()).collect();
            return (step, Err(format!("There is no MCP server called `{name}`. The servers are: {}.", known.join(", "))));
        };
        (self.progress)(Progress::Work(&step));
        (self.progress)(Progress::Activity(&format!("Starting {name}")));
        let connection = match self.tools.mcp.connect(&spec, self.tools.env.cwd.as_deref(), self.tools.env.path.as_deref()).await {
            Ok(connection) => connection,
            Err(why) => return (step, Err(why)),
        };
        let tools = match connection.tools().await {
            Ok(tools) => tools,
            Err(why) => return (step, Err(why)),
        };
        if listing {
            let list: Vec<Value> = tools
                .iter()
                .map(|t| {
                    let description: String = t["description"].as_str().unwrap_or("").chars().take(600).collect();
                    let mut entry = json!({"name": t["name"], "description": description, "input": t["inputSchema"]});
                    if t["annotations"]["readOnlyHint"] == true {
                        entry["read_only"] = json!(true);
                    }
                    entry
                })
                .collect();
            return (step, Ok(Done::text(serde_json::to_string_pretty(&list).unwrap_or_default())));
        }
        let Some(definition) = tools.iter().find(|t| t["name"] == tool_name.as_str()) else {
            let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
            return (step, Err(format!("`{name}` has no tool called `{tool_name}`. Its tools are: {}.", names.join(", "))));
        };
        let arguments = if args["arguments"].is_object() { args["arguments"].clone() } else { json!({}) };
        let catalog = [json!({"name": name, "tools": {tool_name.clone(): definition}})];
        let risky = crate::mcp::catalog_approval(&catalog, &name, &tool_name).unwrap_or_else(|| crate::mcp::needs_approval(&tool_name));
        let need = if !risky {
            Need::Free
        } else if self.plan {
            Need::Refuse(format!("Plan mode is on, and `{tool_name}` could change things. Include it in the plan instead."))
        } else {
            let mut action = crate::mcp::action(&name, &tool_name, &arguments);
            action.risky = true;
            Need::Ask(action)
        };
        if let Err(why) = self.allowed(need).await {
            return (step, Err(why));
        }
        let timeout = args["timeout_seconds"].as_u64().map(Duration::from_secs).unwrap_or(MCP_DEFAULT).clamp(Duration::from_secs(1), COMMAND_MAX);
        (self.progress)(Progress::Activity(&label));
        let result = connection.call(&tool_name, arguments, timeout).await.map(|result| Done {
            text: if result.text.trim().is_empty() { "(no content)".into() } else { result.text },
            failed: result.is_error,
            code: None,
        });
        (step, result)
    }

    /// Stop whatever this turn left running.
    pub async fn finish(&mut self) {
        self.jobs.stop_all().await;
    }
}

/// A file whose contents can make Deck or another agent start a program.
fn starts_programs(path: &std::path::Path) -> bool {
    path.file_name().is_some_and(|n| n == ".mcp.json")
        || path.components().any(|c| matches!(c.as_os_str().to_str(), Some(".git" | ".claude" | ".codex" | ".vscode")))
}

/// What a call came to.
struct Done {
    text: String,
    failed: bool,
    code: Option<i32>,
}

impl Done {
    fn text(text: impl Into<String>) -> Self {
        Self { text: text.into(), failed: false, code: None }
    }
}

/// A tool result cut to what the model is given: the start and the end.
fn cut_result(text: &str) -> String {
    if text.chars().count() <= RESULT_MAX {
        return text.to_string();
    }
    let half = RESULT_MAX / 2;
    let head: String = text.chars().take(half).collect();
    let tail: String = {
        let chars: Vec<char> = text.chars().collect();
        chars[chars.len() - half..].iter().collect()
    };
    let cut = text.chars().count() - 2 * half;
    format!("{head}\n… {cut} characters cut …\n{tail}")
}

/// What a bot without tools is told, so it doesn't pretend.
pub(crate) const NO_TOOLS: &str = "\nYou have no tools in this chat: you can't read files, run commands or open links. \
If something needs checking, ask a bot that can (by its @handle) or give the person the exact command to run, \
and never describe results you haven't been shown.\n";

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{Decision, NoApprover};
    use std::sync::Mutex;

    struct Answers {
        decision: Decision,
        asked: Mutex<Vec<ProposedAction>>,
    }

    #[async_trait::async_trait]
    impl Approver for Answers {
        async fn decide(&self, action: ProposedAction) -> Decision {
            self.asked.lock().unwrap().push(action);
            self.decision
        }
    }

    fn approver(decision: Decision) -> Answers {
        Answers { decision, asked: Mutex::new(Vec::new()) }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apex-tools-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn toolbox(dir: &std::path::Path) -> ToolBox {
        ToolBox::new(&crate::BuildContext { cwd: Some(dir.to_path_buf()), ..Default::default() })
    }

    fn call(name: &str, arguments: Value) -> ToolCall {
        ToolCall { id: format!("call-{name}"), name: name.into(), arguments: arguments.to_string(), extra: None }
    }

    fn names(turn: &Turn<'_>) -> Vec<String> {
        turn.definitions().iter().map(|t| t["function"]["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn read_only_and_plan_turns_are_not_offered_changes() {
        let dir = scratch("offer");
        let tools = toolbox(&dir);
        let quiet = |_: Progress<'_>| {};
        let read = Turn::new(&tools, Access::Read, false, Access::Read, &NoApprover, &quiet);
        assert!(!names(&read).iter().any(|n| n == "write_file" || n == "run_command"));
        let full = Turn::new(&tools, Access::Full, false, Access::Full, &NoApprover, &quiet);
        assert!(names(&full).iter().any(|n| n == "run_command") && names(&full).iter().any(|n| n == "edit_file"));
        assert!(!names(&full).iter().any(|n| n == "exit_plan_mode"));
        let plan = Turn::new(&tools, Access::Read, true, Access::Full, &NoApprover, &quiet);
        assert!(names(&plan).iter().any(|n| n == "exit_plan_mode"));
        assert!(!names(&plan).iter().any(|n| n == "run_command"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn access_levels_decide_what_runs_asks_or_is_refused() {
        let dir = scratch("levels");
        let tools = toolbox(&dir);
        let steps = Mutex::new(Vec::<WorkStep>::new());
        let changes = Mutex::new(Vec::<FileChange>::new());
        let progress = |p: Progress<'_>| match p {
            Progress::Work(step) => steps.lock().unwrap().push(step.clone()),
            Progress::Change(change) => changes.lock().unwrap().push(change.clone()),
            _ => {}
        };

        // Read only: a write is refused without asking anyone.
        let nobody = approver(Decision::Approve);
        let mut read = Turn::new(&tools, Access::Read, false, Access::Read, &nobody, &progress);
        let out = read.run(&call("write_file", json!({"path": "a.txt", "content": "x"}))).await;
        assert!(out.contains("read-only"), "{out}");
        assert!(nobody.asked.lock().unwrap().is_empty() && !dir.join("a.txt").exists());

        // Ask first: the edit becomes a card; declining leaves the file alone.
        let no = approver(Decision::Reject);
        let mut ask = Turn::new(&tools, Access::Ask, false, Access::Ask, &no, &progress);
        let out = ask.run(&call("write_file", json!({"path": "a.txt", "content": "x\n"}))).await;
        assert!(out.contains("declined"), "{out}");
        assert_eq!(no.asked.lock().unwrap()[0].kind, ActionKind::Edit);
        assert_eq!(no.asked.lock().unwrap()[0].title, "Write a.txt");
        assert!(!dir.join("a.txt").exists());

        // Can edit files: edits inside go ahead, commands still ask.
        let yes = approver(Decision::Approve);
        let mut edits = Turn::new(&tools, Access::Edits, false, Access::Edits, &yes, &progress);
        assert!(edits.run(&call("write_file", json!({"path": "a.txt", "content": "one\ntwo\n"}))).await.contains("Created a.txt"));
        assert!(yes.asked.lock().unwrap().is_empty(), "no card for an edit inside the project");
        assert_eq!(changes.lock().unwrap().last().unwrap().path, "a.txt");
        let out = edits.run(&call("edit_file", json!({"path": "a.txt", "old_string": "two", "new_string": "2"}))).await;
        assert!(out.contains("Edited a.txt"), "{out}");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n2\n");
        #[cfg(unix)]
        {
            let out = edits.run(&call("run_command", json!({"command": "echo hi"}))).await;
            assert!(out.contains("hi") && out.contains("[exit code 0]"), "{out}");
            assert_eq!(yes.asked.lock().unwrap()[0].kind, ActionKind::Command);
            assert_eq!(yes.asked.lock().unwrap()[0].detail, "echo hi");
        }

        // Full access: commands run without a card; reads outside ask below Full.
        #[cfg(unix)]
        {
            let none = approver(Decision::Reject);
            let mut full = Turn::new(&tools, Access::Full, false, Access::Full, &none, &progress);
            let out = full.run(&call("run_command", json!({"command": "printf ok; exit 2"}))).await;
            assert!(out.contains("ok") && out.contains("[exit code 2]"), "{out}");
            assert!(none.asked.lock().unwrap().is_empty());
            let failed = steps.lock().unwrap().iter().rev().find(|s| s.kind == StepKind::Command).unwrap().clone();
            assert_eq!((failed.status, failed.exit_code), (StepStatus::Failed, Some(2)));
        }
        let outside = scratch("levels-outside");
        std::fs::write(outside.join("o.txt"), "far").unwrap();
        let no = approver(Decision::Reject);
        let mut read = Turn::new(&tools, Access::Read, false, Access::Read, &no, &progress);
        let out = read.run(&call("read_file", json!({"path": outside.join("o.txt").to_string_lossy()}))).await;
        assert!(out.contains("declined"), "{out}");
        assert!(no.asked.lock().unwrap()[0].title.starts_with("Read outside the project"));
        let out = read.run(&call("read_file", json!({"path": "a.txt"}))).await;
        assert!(out.contains("one"), "reading inside needs no card: {out}");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn settings_that_start_programs_ask_even_when_edits_are_free() {
        let dir = scratch("protected");
        let tools = toolbox(&dir);
        let quiet = |_: Progress<'_>| {};
        let no = approver(Decision::Reject);
        let mut edits = Turn::new(&tools, Access::Edits, false, Access::Edits, &no, &quiet);
        for path in [".mcp.json", ".claude/settings.json", ".git/config"] {
            let out = edits.run(&call("write_file", json!({"path": path, "content": "{}"}))).await;
            assert!(out.contains("declined"), "{path}: {out}");
            assert!(!dir.join(path).exists());
        }
        assert_eq!(no.asked.lock().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn leaving_plan_mode_asks_and_then_allows_the_bots_own_access() {
        let dir = scratch("plan");
        let tools = toolbox(&dir);
        let quiet = |_: Progress<'_>| {};
        let yes = approver(Decision::Approve);
        let mut turn = Turn::new(&tools, Access::Read, true, Access::Edits, &yes, &quiet);
        assert!(turn.run(&call("write_file", json!({"path": "p.txt", "content": "x"}))).await.contains("Plan mode is on"));
        let out = turn.run(&call("exit_plan_mode", json!({"plan": "1. Write p.txt"}))).await;
        assert!(out.contains("approved"), "{out}");
        assert_eq!(yes.asked.lock().unwrap()[0].kind, ActionKind::Plan);
        assert!(names(&turn).iter().any(|n| n == "write_file"));
        assert!(turn.run(&call("write_file", json!({"path": "p.txt", "content": "x"}))).await.contains("Created"));

        let mut read_only = Turn::new(&tools, Access::Read, true, Access::Read, &yes, &quiet);
        assert!(read_only.run(&call("exit_plan_mode", json!({"plan": "x"}))).await.contains("read-only"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn broken_arguments_and_unknown_tools_are_explained() {
        let dir = scratch("broken");
        let tools = toolbox(&dir);
        let quiet = |_: Progress<'_>| {};
        let mut turn = Turn::new(&tools, Access::Full, false, Access::Full, &NoApprover, &quiet);
        let bad = ToolCall { id: "1".into(), name: "read_file".into(), arguments: "{not json".into(), extra: None };
        assert!(turn.run(&bad).await.contains("weren't valid JSON"));
        assert!(turn.run(&call("fly", json!({}))).await.contains("no tool called `fly`"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn long_results_keep_their_start_and_end() {
        let text = format!("{}{}", "a".repeat(RESULT_MAX), "b".repeat(100));
        let cut = cut_result(&text);
        assert!(cut.starts_with('a') && cut.ends_with('b') && cut.contains("characters cut"));
    }

    #[tokio::test]
    async fn shell_tool_runs_in_request_cwd() {
        let dir_context = scratch("ctx");
        let dir_request = scratch("req");
        let tools = toolbox(&dir_context);
        let quiet = |_: Progress<'_>| {};
        let mut turn = Turn::new(&tools, Access::Full, false, Access::Full, &NoApprover, &quiet)
            .with_cwd(Some(dir_request.clone()));
        // Redirection works in Bash and PowerShell; inspect the actual file
        // instead of comparing native paths with MSYS's /c/... display paths.
        let command = "echo apex-cwd > .apex-cwd-check";
        let call = ToolCall { id: "1".into(), name: "run_command".into(), arguments: json!({"command": command}).to_string(), extra: None };
        let output = turn.run(&call).await;
        assert!(
            dir_request.join(".apex-cwd-check").is_file() && !dir_context.join(".apex-cwd-check").exists(),
            "expected {dir_request:?}, got {output}"
        );
        let _ = std::fs::remove_dir_all(dir_context);
        let _ = std::fs::remove_dir_all(dir_request);
    }
}
