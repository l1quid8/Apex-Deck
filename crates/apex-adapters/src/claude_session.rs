//! One chat turn with Claude Code that asks before it acts.
//!
//! In its ordinary print mode Claude Code is given a prompt and left to
//! run: anything that would need permission is simply refused. To ask the
//! person instead, it is started with `--input-format stream-json` and
//! `--permission-prompt-tool stdio`, which make it a two-way conversation
//! over standard input and output, one JSON message per line:
//!
//! 1. We send the prompt as a `user` message.
//! 2. Claude Code prints the same events as its one-way event mode (see
//!    `events.rs`). When a tool needs permission it also prints a
//!    `control_request` of subtype `can_use_tool` and waits.
//! 3. We answer with a `control_response` that allows or denies it.
//! 4. A `result` event ends the turn, and closing its input lets it exit.
//!
//! This is the protocol Anthropic's Agent SDK speaks to the same program.

use std::time::Duration;

use apex_core::{Access, ActionKind, Answer, Approver, Decision, Progress, ProgressSink, ProposedAction, Question, QuestionOption};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};

use crate::events::{EventReader, OutputFormat};
use crate::report;

pub(crate) fn user_message(prompt: &str) -> Value {
    json!({ "type": "user", "message": { "role": "user", "content": prompt } })
}

/// The answer to a permission request. An allowed tool must be given its
/// input back, which is where a client could change it; we pass it through.
pub(crate) fn permission_response(request_id: &Value, input: &Value, decision: Decision) -> Value {
    let response = match decision {
        Decision::Approve | Decision::ApproveAlways => json!({ "behavior": "allow", "updatedInput": input }),
        Decision::Reject => json!({ "behavior": "deny", "message": "The person reading the chat rejected this action." }),
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}

/// Claude's AskUserQuestion input, as questions for the person.
pub(crate) fn ask_user_questions(input: &Value) -> Vec<Question> {
    let text = |v: &Value| v.as_str().unwrap_or("").to_string();
    input["questions"].as_array().into_iter().flatten().map(|q| Question {
        header: text(&q["header"]),
        question: text(&q["question"]),
        options: q["options"].as_array().into_iter().flatten()
            .map(|o| QuestionOption { label: text(&o["label"]), description: text(&o["description"]) })
            .collect(),
        multi_select: q["multiSelect"].as_bool().unwrap_or(false),
    }).collect()
}

/// The answer to AskUserQuestion. Answered: allowed, with the answers added
/// to its input under each question's own text, several picks joined with
/// ", ". Skipped: denied with a message saying so.
pub(crate) fn question_response(request_id: &Value, input: &Value, answer: Answer) -> Value {
    let response = match answer {
        Answer::Answered(chosen) => {
            let mut answers = serde_json::Map::new();
            for (question, picked) in input["questions"].as_array().into_iter().flatten().zip(chosen) {
                if let Some(text) = question["question"].as_str() {
                    answers.insert(text.to_string(), json!(picked.join(", ")));
                }
            }
            let mut updated = if input.is_object() { input.clone() } else { json!({}) };
            updated["answers"] = Value::Object(answers);
            json!({ "behavior": "allow", "updatedInput": updated })
        }
        Answer::Skipped => json!({ "behavior": "deny", "message": "The person skipped this question." }),
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}

/// The answer to ExitPlanMode, Claude asking to start the work after
/// planning. Approved: allowed, and Claude's mode for the rest of the turn
/// goes back to what the bot's own access allows. Refused: Claude keeps
/// planning. A read-only bot can't start the work at all.
pub(crate) fn plan_exit_response(request_id: &Value, input: &Value, decision: Decision, own: Access) -> Value {
    let mode = match own {
        Access::Full => Some("bypassPermissions"),
        Access::Edits => Some("acceptEdits"),
        Access::Ask => Some("default"),
        Access::Read => None,
    };
    let response = match (decision.approved(), mode) {
        (_, None) => json!({ "behavior": "deny", "message": "This bot can only read, so it can't start the work. The person can hand your plan to another bot." }),
        (true, Some(mode)) => json!({
            "behavior": "allow",
            "updatedInput": input,
            "updatedPermissions": [{ "type": "setMode", "mode": mode, "destination": "session" }],
        }),
        (false, Some(_)) => json!({ "behavior": "deny", "message": "The person wants to keep planning." }),
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}

async fn send(stdin: &mut ChildStdin, message: &Value) -> std::io::Result<()> {
    let mut line = message.to_string();
    line.push('\n');
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

/// What the turn produced, or why it did not finish. The error text is the
/// program's error output, for the caller to summarise.
pub(crate) struct Finished {
    pub reader: EventReader,
    pub success: bool,
    pub status: String,
    pub stderr: String,
}

/// Run one turn. `child` must have been started with every standard
/// stream piped and the flags from `presets.rs` for ask-first access.
pub(crate) async fn run(
    mut child: Child,
    prompt: &str,
    cwd: Option<String>,
    on_progress: ProgressSink<'_>,
    approver: &dyn Approver,
    after_plan: Option<Access>,
) -> std::io::Result<Finished> {
    let mut stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");
    let errors = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });

    // A prompt larger than the pipe can hold would block here if the
    // program printed before reading it all; it reads its input first.
    send(&mut stdin, &user_message(prompt)).await?;

    let mut reader = EventReader::new(OutputFormat::ClaudeStream, cwd);
    let mut lines = BufReader::new(stdout).lines();
    while !reader.turn_over() {
        let Some(line) = lines.next_line().await? else { break };
        if let Ok(message) = serde_json::from_str::<Value>(&line) {
            if message["type"] == "system" && message["subtype"] == "init" {
                if let Some(servers) = message["mcp_servers"].as_array() {
                    let names: Vec<apex_core::server_request::ToolServer> = servers.iter().filter_map(|s| s["name"].as_str().map(|name| name.to_owned().into())).collect();
                    on_progress(Progress::ToolServers(&names));
                }
            }
            if message["type"] == "control_request" {
                let request = &message["request"];
                // Claude asks the person with AskUserQuestion in every access
                // mode, Full included (probed 2026-10-06). The questions go
                // out raw; the room cleans them for display, and the answers
                // come back matched by position.
                let reply = if request["subtype"] == "can_use_tool" && request["tool_name"] == "AskUserQuestion" {
                    on_progress(Progress::Activity("Waiting for your answer"));
                    let answer = approver.ask(ask_user_questions(&request["input"])).await;
                    question_response(&message["request_id"], &request["input"], answer)
                } else if let (true, Some(own)) = (request["subtype"] == "can_use_tool" && request["tool_name"] == "ExitPlanMode", after_plan) {
                    // Started by the Plan switch: Claude has a plan and asks
                    // to start the work. A read-only bot is refused unasked.
                    let decision = if own == Access::Read {
                        Decision::Reject
                    } else {
                        let plan = request["input"]["plan"].as_str().unwrap_or("").to_string();
                        on_progress(Progress::Activity("Waiting for you: start the work?"));
                        approver.decide(ProposedAction { kind: ActionKind::Plan, title: "Start the work?".into(), detail: plan, expires_at: None, risky: false }).await
                    };
                    plan_exit_response(&message["request_id"], &request["input"], decision, own)
                } else if request["subtype"] == "can_use_tool" {
                    let tool = request["tool_name"].as_str().unwrap_or("a tool");
                    let action = reader.claude_action(tool, &request["input"]);
                    let decision = match crate::mcp::claude_tool(tool) {
                        Some((_, name)) if !crate::mcp::needs_approval(name) => Decision::Approve,
                        _ => {
                            on_progress(Progress::Activity(&format!("Waiting for approval: {}", action.title)));
                            approver.decide(action).await
                        },
                    };
                    permission_response(&message["request_id"], &request["input"], decision)
                } else {
                    // Something else it wants from its host. Say so plainly
                    // rather than leave it waiting.
                    json!({ "type": "control_response", "response": {
                        "subtype": "error", "request_id": message["request_id"], "error": "Apex Deck does not support this request"
                    } })
                };
                send(&mut stdin, &reply).await?;
                continue;
            }
        }
        report(reader.push(&format!("{line}\n")), on_progress);
    }
    report(reader.finish(), on_progress);

    // With its input closed and the turn over, the program exits by itself.
    // Shutting down MCP servers, hooks or background shells can hold it
    // past the grace period; a turn that already ended is still a reply.
    drop(stdin);
    let (status, killed) = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(status) => (status?, false),
        Err(_) => {
            let _ = child.kill().await;
            (child.wait().await?, true)
        }
    };
    Ok(Finished {
        success: status.success() || (killed && reader.turn_over()),
        status: status.to_string(),
        stderr: errors.await.unwrap_or_default(),
        reader,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starting_the_work_hands_back_the_bots_own_access() {
        let input = json!({"plan": "1. Do it"});
        let response = |decision, own| plan_exit_response(&json!("p1"), &input, decision, own)["response"]["response"].clone();
        let mode = |own| response(Decision::Approve, own)["updatedPermissions"][0]["mode"].clone();
        assert_eq!(response(Decision::Approve, Access::Full)["behavior"], "allow");
        assert_eq!(response(Decision::Approve, Access::Full)["updatedInput"], input);
        assert_eq!(response(Decision::Approve, Access::Full)["updatedPermissions"][0], json!({"type": "setMode", "mode": "bypassPermissions", "destination": "session"}));
        assert_eq!(mode(Access::Edits), "acceptEdits");
        assert_eq!(mode(Access::Ask), "default");
        assert_eq!(response(Decision::Reject, Access::Full), json!({"behavior": "deny", "message": "The person wants to keep planning."}));
        assert_eq!(response(Decision::Approve, Access::Read)["behavior"], "deny", "a read-only bot never starts the work");
    }

    #[test]
    fn answers_go_back_under_each_questions_own_text() {
        use apex_core::Answer;
        let input = json!({"questions": [
            {"question": "Which colour?", "header": "Colour", "options": [{"label": "red", "description": "warm"}, {"label": "blue"}], "multiSelect": false},
            {"question": "Which fruit?", "header": "Fruit", "options": [{"label": "apple"}, {"label": "pear"}], "multiSelect": true}
        ]});
        let asked = ask_user_questions(&input);
        assert_eq!(asked.len(), 2);
        assert_eq!(asked[0].options[0].description, "warm");
        assert!(asked[1].multi_select);

        let reply = question_response(&json!("r1"), &input, Answer::Answered(vec![vec!["blue".into()], vec!["apple".into(), "pear".into()]]));
        let response = &reply["response"]["response"];
        assert_eq!(response["behavior"], "allow");
        assert_eq!(response["updatedInput"]["answers"], json!({"Which colour?": "blue", "Which fruit?": "apple, pear"}));
        assert_eq!(response["updatedInput"]["questions"], input["questions"], "the input goes back as it came");

        let skipped = question_response(&json!("r2"), &input, Answer::Skipped);
        assert_eq!(skipped["response"]["response"], json!({"behavior": "deny", "message": "The person skipped this question."}));
    }

    #[test]
    fn an_approval_returns_the_tools_input_and_a_refusal_says_why() {
        let input = json!({ "file_path": "a.txt", "content": "hi" });
        assert_eq!(
            permission_response(&json!("r1"), &input, Decision::Approve),
            json!({ "type": "control_response", "response": {
                "subtype": "success", "request_id": "r1", "response": { "behavior": "allow", "updatedInput": input }
            } })
        );
        let denied = permission_response(&json!("r2"), &input, Decision::Reject);
        assert_eq!(denied["response"]["response"]["behavior"], "deny");
        assert!(denied["response"]["response"]["message"].as_str().unwrap().contains("rejected"));
    }

    #[test]
    fn the_prompt_is_sent_as_a_user_message() {
        assert_eq!(user_message("hello"), json!({ "type": "user", "message": { "role": "user", "content": "hello" } }));
    }
}

/// Names of Claude's connected MCP servers, without running a turn.
pub async fn list_servers(cwd: Option<String>, path: Option<String>) -> Result<Vec<apex_core::server_request::ToolServer>, String> {
    let mut command = tokio::process::Command::new("claude");
    if let Some(path) = path { command.env("PATH", path); }
    command.args(["mcp", "list"]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    if let Some(cwd) = cwd { command.current_dir(cwd); }
    let output = command.output().await.map_err(|e| format!("Couldn't list Claude tool servers: {e}"))?;
    if !output.status.success() { return Err("Couldn't list Claude tool servers".into()); }
    Ok(crate::mcp::claude_connected(&String::from_utf8_lossy(&output.stdout)).into_iter().map(Into::into).collect())
}
