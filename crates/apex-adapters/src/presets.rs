//! Command lines for the coding agents Apex Deck knows how to run.
//!
//! Each agent is started once per turn in its non-interactive mode. The
//! conversation is written to its standard input and its output is the
//! reply. The flags below are the ones each tool documents for that mode;
//! if a tool changes its flags, this is the only place to update.

use apex_core::{Access, AgentTool};

use crate::events::OutputFormat;

/// The instruction given to tools that need a prompt argument in addition
/// to standard input.
const STDIN_INSTRUCTION: &str =
    "Reply to the group chat conversation given on standard input. Follow the instructions at the top of it.";

/// How to read what `tool` prints when run with the flags below. Claude
/// Code, Codex and Grok are run in their event modes, which report the reply
/// as it is written, each tool used, token counts and a proper error. Grok's
/// event mode is the same as Claude Code's.
pub(crate) fn output_format(tool: AgentTool) -> OutputFormat {
    match tool {
        AgentTool::ClaudeCode => OutputFormat::ClaudeStream,
        AgentTool::Codex => OutputFormat::CodexJson,
        AgentTool::Gemini => OutputFormat::Text,
        AgentTool::Grok => OutputFormat::ClaudeStream,
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

/// The program and arguments that run `tool` for one turn.
///
/// `access` is turned into the tool's own permission flags where the tool
/// has them, so "read only" is enforced by the tool and not just requested
/// in the prompt.
pub fn agent_command(
    tool: AgentTool,
    model: Option<&str>,
    effort: Option<&str>,
    access: Access,
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
                // Without a way to ask for approval, edits and commands are
                // refused anyway; denying the tools makes that explicit.
                Access::Read => push(&["--disallowedTools", "Edit,Write,NotebookEdit,Bash"]),
                // A two-way conversation in which each edit and command is
                // put to the person first; see claude_session.rs.
                Access::Ask => push(&["--permission-mode", "default"]),
                Access::Edits => push(&["--permission-mode", "acceptEdits"]),
                Access::Full => push(&["--permission-mode", "bypassPermissions"]),
            }
            push(&["--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--settings", r#"{"permissions":{"ask":["mcp__*"]}}"#]);
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
            if let Some(model) = model {
                push(&["--model", model]);
            }
            if let Some(dir) = READABLE.get() {
                push(&["--include-directories", dir]);
            }
            // Access is only stated in the prompt for Gemini, and it has no
            // effort flag, so neither is passed.
            push(&["-p", STDIN_INSTRUCTION]);
            "gemini"
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
    };
    (program.to_string(), args)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(args.contains(&"bypassPermissions".to_string()));
    }

    #[test]
    fn configured_mcp_servers_and_plugins_are_not_disabled() {
        for tool in [AgentTool::ClaudeCode, AgentTool::Codex, AgentTool::Gemini, AgentTool::Grok] {
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
    fn claude_code_commands() {
        assert_eq!(
            line(AgentTool::ClaudeCode, None, Access::Read),
            "claude -p --output-format stream-json --verbose --include-partial-messages --disallowedTools Edit,Write,NotebookEdit,Bash"
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
        assert_eq!(program, "gemini");
        assert_eq!(args, ["--model", "some-model", "-p", STDIN_INSTRUCTION]);
        let (_, args) = agent_command(AgentTool::Gemini, None, None, Access::Full);
        assert_eq!(args, ["-p", STDIN_INSTRUCTION]);
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
        assert_eq!(&claude[..claude.len() - 6], &["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "opus", "--effort", "xhigh", "--disallowedTools", "Edit,Write,NotebookEdit,Bash"]);

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
