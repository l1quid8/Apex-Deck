//! Command lines for the coding agents Apex Deck knows how to run.
//!
//! Each agent is started once per turn in its non-interactive mode. The
//! conversation is written to its standard input and its output is the
//! reply. The flags below are the ones each tool documents for that mode;
//! if a tool changes its flags, this is the only place to update.

use apex_core::{Access, AgentTool, Speed};

use crate::events::OutputFormat;

/// The instruction given to tools that need a prompt argument in addition
/// to standard input.
const STDIN_INSTRUCTION: &str =
    "Reply to the group chat conversation given on standard input. Follow the instructions at the top of it.";

/// How to read what `tool` prints when run with the flags below. Claude
/// Code, Codex, Grok and Antigravity are run in their event modes, which report
/// the reply as it is written, each tool used, token counts and a proper error.
pub(crate) fn output_format(tool: AgentTool, program: &str) -> OutputFormat {
    match tool {
        AgentTool::ClaudeCode => OutputFormat::ClaudeStream,
        AgentTool::Codex => OutputFormat::CodexJson,
        AgentTool::Gemini => {
            if program == "gemini" {
                OutputFormat::Text
            } else {
                OutputFormat::AntigravityStream
            }
        }
        AgentTool::Grok => OutputFormat::ClaudeStream,
        // Muse runs only through its session host (`muse_server.rs`).
        AgentTool::Muse => OutputFormat::Text,
    }
}

/// A model name with surrounding space removed; blank means the default.
pub(crate) fn clean_model(model: Option<&str>) -> Option<&str> {
    model.map(str::trim).filter(|m| !m.is_empty())
}

/// Effort levels are short words such as "low" or "xhigh". Anything else is
/// dropped so it cannot break the quoting of a config value.
pub(crate) fn clean_effort(effort: Option<&str>) -> Option<String> {
    effort
        .map(|e| e.trim().chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).collect())
        .filter(|e: &String| !e.is_empty())
}

static READABLE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// A folder every agent may read even though it is outside the workspace:
/// where the app keeps files attached in the chat. Set once at startup.
pub fn allow_reading(dir: &std::path::Path) {
    let _ = READABLE.set(dir.to_string_lossy().into_owned());
}

/// The folder set by `allow_reading`, if any.
pub(crate) fn readable_dir() -> Option<&'static str> {
    READABLE.get().map(String::as_str)
}

/// The program and arguments that run `tool` for one turn.
///
/// `access` is turned into the tool's own permission flags where the tool
/// has them, so "read only" is enforced by the tool and not just requested
/// in the prompt.
/// Codex's name for a speed: its "Fast" tier is `priority`, and `default`
/// is standard even when the person's config.toml picks priority.
pub(crate) fn codex_service_tier(speed: Speed) -> &'static str {
    match speed {
        Speed::Standard => "default",
        Speed::Fast => "priority",
    }
}

/// The chat as the one stream-json message agy reads on standard input
/// with `--input-format stream-json`.
pub(crate) fn agy_stdin_line(prompt: &str) -> String {
    let mut line = serde_json::json!({ "event": "user", "message": { "role": "user", "content": prompt } }).to_string();
    line.push('\n');
    line
}

pub(crate) fn resolve_gemini_program(path: Option<&str>) -> &'static str {
    let check_path = |p_str: &str| -> Option<&'static str> {
        for dir in std::env::split_paths(p_str) {
            for candidate in ["agy", "gemini", "antigravity"] {
                #[cfg(windows)]
                if crate::executable::on_path(candidate, &std::env::join_paths([&dir]).ok()?.to_string_lossy()) {
                    return Some(candidate);
                }
                #[cfg(not(windows))]
                let p = dir.join(candidate);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(m) = std::fs::metadata(&p) {
                        if m.is_file() && m.permissions().mode() & 0o111 != 0 {
                            return Some(candidate);
                        }
                    }
                }
                #[cfg(not(any(unix, windows)))]
                {
                    if p.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    };

    if let Some(p) = path {
        if let Some(cand) = check_path(p) {
            return cand;
        }
    }
    if let Ok(p) = std::env::var("PATH") {
        if let Some(cand) = check_path(&p) {
            return cand;
        }
    }
    "gemini"
}

#[cfg(all(test, windows))]
#[test]
fn windows_gemini_discovery_recognizes_npm_shims() {
    let root = std::env::temp_dir().join(format!("apx-gemini-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("agy.cmd"), "").unwrap();
    std::fs::write(root.join("gemini.cmd"), "").unwrap();
    let path = std::env::join_paths([&root]).unwrap().to_string_lossy().into_owned();
    assert_eq!(resolve_gemini_program(Some(&path)), "agy");
    std::fs::remove_file(root.join("agy.cmd")).unwrap();
    assert_eq!(resolve_gemini_program(Some(&path)), "gemini");
    std::fs::remove_dir_all(root).unwrap();
}

pub fn agent_command(
    tool: AgentTool,
    model: Option<&str>,
    effort: Option<&str>,
    access: Access,
) -> (String, Vec<String>) {
    agent_command_with(tool, model, effort, None, access, false)
}

/// `agent_command`, for a turn taken while the thread's Plan switch is on.
/// Claude Code then runs in its own planning mode; the other tools plan
/// under `access`, which the room has already made read-only.
pub fn agent_command_with(
    tool: AgentTool,
    model: Option<&str>,
    effort: Option<&str>,
    speed: Option<Speed>,
    access: Access,
    plan: bool,
) -> (String, Vec<String>) {
    agent_command_in(tool, model, effort, speed, access, plan, None)
}

pub fn agent_command_in(
    tool: AgentTool,
    model: Option<&str>,
    effort: Option<&str>,
    speed: Option<Speed>,
    access: Access,
    plan: bool,
    path: Option<&str>,
) -> (String, Vec<String>) {
    let model = clean_model(model);
    let effort = clean_effort(effort);
    let effort = effort.as_deref();
    let codex_effort = effort.map(|e| format!("model_reasoning_effort=\"{e}\""));
    let mut args: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| args.extend(items.iter().map(|s| s.to_string()));

    let program = match tool {
        AgentTool::ClaudeCode => {
            // Events as they happen. `--verbose` is required by the stream
            // format, and partial messages give the text piece by piece.
            push(&["-p"]);
            // `--add-dir` takes several folders, so it goes before an option
            // that ends the list.
            if let Some(dir) = READABLE.get() {
                push(&["--add-dir", dir]);
            }
            push(&["--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
            if let Some(model) = model {
                push(&["--model", model]);
            }
            if let Some(effort) = effort {
                push(&["--effort", effort]);
            }
            match access {
                // Claude's planning mode changes nothing until the person
                // agrees to start the work (claude_session.rs).
                _ if plan => push(&["--permission-mode", "plan"]),
                // Allow built-in reads outside the project without prompting,
                // retaining write/command denials and separate MCP approvals.
                Access::Read => push(&["--allowedTools", "Read,Glob,Grep", "--disallowedTools", "Edit,Write,NotebookEdit,Bash"]),
                // A two-way conversation in which each edit and command is
                // put to the person first; see claude_session.rs.
                Access::Ask => push(&["--permission-mode", "default"]),
                Access::Edits => push(&["--permission-mode", "acceptEdits"]),
                Access::Full => push(&["--permission-mode", "bypassPermissions"]),
            }
            // Fast mode must be asked for on the command line in print mode;
            // Claude's own saved fast setting does not apply there. The two
            // task tools are allowed outright in every access level: they
            // only keep the to-do list, and asking about each one would put a
            // question in front of the person for every step of the plan.
            let settings = match speed {
                Some(Speed::Fast) => {
                    r#"{"permissions":{"allow":["TaskCreate","TaskUpdate"],"ask":["mcp__*"]},"fastMode":true}"#
                }
                _ => r#"{"permissions":{"allow":["TaskCreate","TaskUpdate"],"ask":["mcp__*"]}}"#,
            };
            push(&["--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--settings", settings]);
            "claude"
        }
        AgentTool::Codex => {
            // Without this, Codex refuses to run in a folder that is not a
            // git repository it has been told to trust.
            // `--json` prints one event per line instead of only the answer.
            push(&["exec", "--skip-git-repo-check", "--json"]);
            if let Some(model) = model {
                push(&["--model", model]);
            }
            if let Some(setting) = codex_effort.as_deref() {
                // Config values are written as TOML, so the level is quoted.
                push(&["-c", setting]);
            }
            if let Some(tier) = speed.map(codex_service_tier) {
                push(&["-c", &format!("service_tier=\"{tier}\"")]);
            }
            push(&[
                "--sandbox",
                match access {
                    // `codex exec` has nobody to ask, so asking first is
                    // only possible through the app server. If that cannot
                    // be used, the safe reading of "ask first" is "do not".
                    Access::Read | Access::Ask => "read-only",
                    Access::Edits => "workspace-write",
                    Access::Full => "danger-full-access",
                },
            ]);
            // A lone dash tells Codex to read the prompt from standard input.
            push(&["-"]);
            "codex"
        }
        AgentTool::Gemini => {
            let program = resolve_gemini_program(path);
            if let Some(model) = model {
                push(&["--model", model]);
            }
            if let Some(effort) = effort {
                push(&["--effort", effort]);
            }
            if let Some(dir) = READABLE.get() {
                if program == "gemini" {
                    push(&["--include-directories", dir]);
                } else {
                    push(&["--add-dir", dir]);
                }
            }
            match access {
                Access::Read => {
                    if program != "gemini" {
                        push(&["--sandbox"]);
                    }
                }
                Access::Ask => {
                    if program != "gemini" {
                        push(&["--mode", "auto"]);
                    }
                }
                Access::Edits => {
                    if program != "gemini" {
                        push(&["--mode", "accept-edits"]);
                    }
                }
                Access::Full => {
                    if program != "gemini" {
                        push(&["--dangerously-skip-permissions"]);
                    }
                }
            }
            if program == "gemini" {
                push(&["-p", STDIN_INSTRUCTION]);
            } else {
                // agy 1.4 ignores plain standard input in `-p` mode, so the
                // chat goes in as one stream-json message (`agy_stdin_line`).
                push(&["--output-format", "stream-json", "--input-format", "stream-json"]);
            }
            program
        }
        AgentTool::Grok => {
            // Grok does not read piped input in its one-shot mode, but it
            // reads a prompt file, and standard input is one.
            push(&["--prompt-file", "/dev/stdin", "--output-format", "streaming-messages-json", "--include-partial-messages"]);
            if let Some(model) = model {
                push(&["--model", model]);
            }
            if let Some(effort) = effort {
                push(&["--effort", effort]);
            }
            if let Some(dir) = READABLE.get() {
                push(&["--allow", &format!("Read({dir}/**)")]);
            }
            // Deny rules win over any allow rule in the person's own Grok
            // settings. With nobody to ask, "ask first" means "do not".
            match access {
                Access::Read | Access::Ask => push(&["--deny", "Edit", "--deny", "Write", "--deny", "Bash"]),
                Access::Edits => push(&["--allow", "Edit", "--allow", "Write", "--deny", "Bash"]),
                Access::Full => push(&["--always-approve"]),
            }
            "grok"
        }
        AgentTool::Muse => {
            // A session host per turn; access is enforced by its flags and
            // the session's approval mode. See muse_server.rs.
            args = crate::muse_server::args(access, model);
            "muse"
        }
    };
    (program.to_string(), args)
}

#[cfg(test)]
mod tests {
    #[test]
    fn speed_reaches_claude_and_codex_only_when_chosen() {
        let settings = |args: &[String]| args[args.iter().position(|a| a == "--settings").unwrap() + 1].clone();
        let (_, fast) = agent_command_with(AgentTool::ClaudeCode, None, None, Some(Speed::Fast), Access::Read, false);
        assert!(settings(&fast).contains(r#""fastMode":true"#));
        for speed in [None, Some(Speed::Standard)] {
            let (_, args) = agent_command_with(AgentTool::ClaudeCode, None, None, speed, Access::Read, false);
            assert!(!settings(&args).contains("fastMode"));
        }
        let (_, codex) = agent_command_with(AgentTool::Codex, None, None, Some(Speed::Standard), Access::Read, false);
        assert!(codex.iter().any(|a| a == r#"service_tier="default""#));
        let (_, codex) = agent_command_with(AgentTool::Codex, None, None, None, Access::Read, false);
        assert!(!codex.iter().any(|a| a.starts_with("service_tier")));
        let (_, gemini) = agent_command_with(AgentTool::Gemini, None, None, Some(Speed::Fast), Access::Read, false);
        assert_eq!(gemini, agent_command(AgentTool::Gemini, None, None, Access::Read).1);
    }

    use super::*;

    #[test]
    fn a_planning_claude_starts_in_its_own_planning_mode() {
        let (_, plain) = agent_command_with(AgentTool::ClaudeCode, None, None, None, Access::Read, false);
        assert_eq!(plain, agent_command(AgentTool::ClaudeCode, None, None, Access::Read).1);
        let (program, planning) = agent_command_with(AgentTool::ClaudeCode, None, None, None, Access::Read, true);
        assert_eq!(program, "claude");
        let line = planning.join(" ");
        assert!(line.contains("--permission-mode plan"), "{line}");
        assert!(!line.contains("--disallowedTools"), "plan mode does the holding back: {line}");
        assert!(line.contains("--permission-prompt-tool stdio"), "it still asks Deck: {line}");
        let (_, gemini) = agent_command_with(AgentTool::Gemini, None, None, None, Access::Read, true);
        assert_eq!(gemini, agent_command(AgentTool::Gemini, None, None, Access::Read).1, "others plan read-only");
    }

    fn line(tool: AgentTool, model: Option<&str>, access: Access) -> String {
        let (program, mut args) = agent_command(tool, model, None, access);
        if tool == AgentTool::ClaudeCode { args.truncate(args.len() - 6); }
        format!("{program} {}", args.join(" "))
    }

    #[test]
    fn claude_mcp_approvals_have_a_two_way_channel_at_full_access() {
        let (_, args) = agent_command(AgentTool::ClaudeCode, None, None, Access::Full);
        assert!(args.windows(2).any(|a| a == ["--permission-prompt-tool", "stdio"]));
        assert!(args.windows(2).any(|a| a == ["--input-format", "stream-json"]));
        let settings = args.windows(2).find(|a| a[0] == "--settings").expect("MCP ask rule");
        let value: serde_json::Value = serde_json::from_str(&settings[1]).unwrap();
        assert_eq!(value["permissions"]["ask"], serde_json::json!(["mcp__*"]));
        assert_eq!(value["permissions"]["allow"], serde_json::json!(["TaskCreate", "TaskUpdate"]));
        assert!(args.contains(&"bypassPermissions".to_string()));
    }

    #[test]
    fn configured_mcp_servers_and_plugins_are_not_disabled() {
        for tool in [AgentTool::ClaudeCode, AgentTool::Codex, AgentTool::Gemini, AgentTool::Grok, AgentTool::Muse] {
            for access in [Access::Read, Access::Ask, Access::Edits, Access::Full] {
                let (_, args) = agent_command(tool, None, None, access);
                for arg in args {
                    assert!(!arg.contains("strict-mcp-config"), "unexpected MCP disable: {arg}");
                    assert!(!arg.contains("mcp_servers.") || !arg.contains("enabled=false"));
                    assert!(!arg.contains("features.plugins=false"));
                    assert!(!arg.contains("features.apps=false"));
                }
            }
        }
    }

    #[test]
    fn claude_read_only_allows_reads_without_bypassing_write_permissions() {
        let (_, args) = agent_command(AgentTool::ClaudeCode, None, None, Access::Read);
        assert!(args.windows(2).any(|a| a == ["--allowedTools", "Read,Glob,Grep"]));
        assert!(args.windows(2).any(|a| a == ["--disallowedTools", "Edit,Write,NotebookEdit,Bash"]));
        assert!(!args.iter().any(|a| a == "bypassPermissions"));
    }

    #[test]
    fn claude_code_commands() {
        assert_eq!(
            line(AgentTool::ClaudeCode, None, Access::Read),
            "claude -p --output-format stream-json --verbose --include-partial-messages --allowedTools Read,Glob,Grep --disallowedTools Edit,Write,NotebookEdit,Bash"
        );
        assert_eq!(
            line(AgentTool::ClaudeCode, Some("opus"), Access::Edits),
            "claude -p --output-format stream-json --verbose --include-partial-messages --model opus --permission-mode acceptEdits"
        );
        assert_eq!(
            line(AgentTool::ClaudeCode, Some("sonnet"), Access::Full),
            "claude -p --output-format stream-json --verbose --include-partial-messages --model sonnet --permission-mode bypassPermissions"
        );
    }

    #[test]
    fn asking_first_makes_claude_code_a_two_way_conversation_and_keeps_codex_exec_read_only() {
        assert_eq!(
            line(AgentTool::ClaudeCode, Some("opus"), Access::Ask),
            "claude -p --output-format stream-json --verbose --include-partial-messages --model opus --permission-mode default"
        );
        assert_eq!(line(AgentTool::Codex, None, Access::Ask), "codex exec --skip-git-repo-check --json --sandbox read-only -");
    }

    #[test]
    fn codex_commands() {
        assert_eq!(
            line(AgentTool::Codex, None, Access::Read),
            "codex exec --skip-git-repo-check --json --sandbox read-only -"
        );
        assert_eq!(
            line(AgentTool::Codex, Some("some-model"), Access::Edits),
            "codex exec --skip-git-repo-check --json --model some-model --sandbox workspace-write -"
        );
        assert_eq!(
            line(AgentTool::Codex, None, Access::Full),
            "codex exec --skip-git-repo-check --json --sandbox danger-full-access -"
        );
    }

    #[test]
    fn gemini_commands() {
        let (program, args) = agent_command(AgentTool::Gemini, Some("some-model"), Some("high"), Access::Read);
        assert!(program == "gemini" || program == "agy" || program == "antigravity");
        if program == "agy" || program == "antigravity" {
            assert_eq!(args, ["--model", "some-model", "--effort", "high", "--sandbox", "--output-format", "stream-json", "--input-format", "stream-json"]);
        } else {
            assert_eq!(args, ["--model", "some-model", "--effort", "high", "-p", STDIN_INSTRUCTION]);
        }
        let (_, args) = agent_command(AgentTool::Gemini, None, None, Access::Full);
        if program == "agy" || program == "antigravity" {
            assert_eq!(args, ["--dangerously-skip-permissions", "--output-format", "stream-json", "--input-format", "stream-json"]);
        } else {
            assert_eq!(args, ["-p", STDIN_INSTRUCTION]);
        }
    }

    #[test]
    fn agy_reads_the_chat_from_stdin_as_a_message() {
        let line = agy_stdin_line("[Human]: hi \"there\"\nsecond line");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1, "one NDJSON line");
        let value: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(value["event"], "user");
        assert_eq!(value["message"]["role"], "user");
        assert_eq!(value["message"]["content"], "[Human]: hi \"there\"\nsecond line");
    }

    #[test]
    fn grok_commands() {
        let stream = ["--prompt-file", "/dev/stdin", "--output-format", "streaming-messages-json", "--include-partial-messages"];
        let (program, args) = agent_command(AgentTool::Grok, Some("grok-4.7"), Some("high"), Access::Read);
        assert_eq!(program, "grok");
        assert_eq!(&args[..stream.len()], stream);
        assert_eq!(&args[stream.len()..], ["--model", "grok-4.7", "--effort", "high", "--deny", "Edit", "--deny", "Write", "--deny", "Bash"]);
        assert_eq!(line(AgentTool::Grok, None, Access::Ask), line(AgentTool::Grok, None, Access::Read));
        let (_, args) = agent_command(AgentTool::Grok, None, None, Access::Edits);
        assert_eq!(&args[stream.len()..], ["--allow", "Edit", "--allow", "Write", "--deny", "Bash"]);
        let (_, args) = agent_command(AgentTool::Grok, None, None, Access::Full);
        assert_eq!(&args[stream.len()..], ["--always-approve"]);
    }

    #[test]
    fn effort_is_passed_in_each_tools_own_way() {
        let (_, claude) = agent_command(AgentTool::ClaudeCode, Some("opus"), Some("xhigh"), Access::Read);
        assert_eq!(&claude[..claude.len() - 6], &["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "opus", "--effort", "xhigh", "--allowedTools", "Read,Glob,Grep", "--disallowedTools", "Edit,Write,NotebookEdit,Bash"]);

        let (_, codex) = agent_command(AgentTool::Codex, None, Some(" high "), Access::Read);
        assert_eq!(
            codex,
            ["exec", "--skip-git-repo-check", "--json", "-c", "model_reasoning_effort=\"high\"", "--sandbox", "read-only", "-"]
        );
    }

    #[test]
    fn effort_that_is_blank_or_not_a_plain_word_is_cleaned_or_dropped() {
        let (_, blank) = agent_command(AgentTool::Codex, None, Some("  "), Access::Read);
        assert!(!blank.contains(&"-c".to_string()));
        let (_, odd) = agent_command(AgentTool::Codex, None, Some("hi\"gh; x"), Access::Read);
        assert!(odd.contains(&"model_reasoning_effort=\"highx\"".to_string()), "{odd:?}");
    }

    #[test]
    fn a_blank_model_means_the_tools_default() {
        assert_eq!(
            line(AgentTool::ClaudeCode, Some("   "), Access::Edits),
            "claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode acceptEdits"
        );
    }
}
