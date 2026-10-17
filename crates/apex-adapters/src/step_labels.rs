// Task 4 wires these label helpers into the event parser.
#![allow(dead_code)]
//! Pure helpers that turn a raw shell command into a short, readable step label.

use apex_core::work_steps::StepKind;
use serde_json::Value;

/// "cd /x/y && git status" -> (Some("/x/y"), "git status").
/// Handles `cd "<p>" &&`, `cd '<p>' &&` and `cd <p>;`. Only a leading cd.
pub(crate) fn split_cd(command: &str) -> (Option<&str>, &str) {
    let trimmed = command.trim_start();
    let Some(rest) = trimmed.strip_prefix("cd") else {
        return (None, command);
    };
    if !rest.starts_with(char::is_whitespace) {
        return (None, command);
    }
    let rest = rest.trim_start();
    let (dir, after) = match rest.chars().next() {
        Some(q @ ('"' | '\'')) => {
            let inner = &rest[1..];
            match inner.find(q) {
                Some(end) => (&inner[..end], &inner[end + 1..]),
                None => return (None, command),
            }
        }
        Some(_) => {
            let end = rest
                .find(|c: char| c.is_whitespace() || c == ';' || c == '&')
                .unwrap_or(rest.len());
            (&rest[..end], &rest[end..])
        }
        None => return (None, command),
    };
    if dir.is_empty() {
        return (None, command);
    }
    let after = after.trim_start();
    if let Some(tail) = after.strip_prefix("&&") {
        (Some(dir), tail.trim_start())
    } else if let Some(tail) = after.strip_prefix(';') {
        (Some(dir), tail.trim_start())
    } else {
        (None, command)
    }
}

/// "/bin/zsh -lc 'git status'" -> "git status"; same for bash/sh, -c/-lc,
/// single or double quotes. Anything else is returned unchanged.
pub(crate) fn unwrap_shell(command: &str) -> String {
    let trimmed = command.trim();
    let mut parts = trimmed.splitn(3, char::is_whitespace);
    let (Some(shell), Some(flag), Some(body)) = (parts.next(), parts.next(), parts.next()) else {
        return command.to_string();
    };
    let name = shell.rsplit('/').next().unwrap_or(shell);
    if !matches!(name, "zsh" | "bash" | "sh") || !matches!(flag, "-c" | "-lc") {
        return command.to_string();
    }
    let body = body.trim();
    for q in ['\'', '"'] {
        if body.len() >= 2 && body.starts_with(q) && body.ends_with(q) {
            return body[1..body.len() - 1].to_string();
        }
    }
    command.to_string()
}

/// The folder note: None when `dir` is the room folder; else its last path part.
pub(crate) fn folder_note(dir: &str, cwd: Option<&str>) -> Option<String> {
    let dir = dir.trim_end_matches('/');
    if let Some(cwd) = cwd {
        if cwd.trim_end_matches('/') == dir {
            return None;
        }
    }
    dir.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn last_part(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

/// Codex: label and kind from `commandActions`, falling back to the unwrapped command.
pub(crate) fn codex_label(
    command: &str,
    actions: &Value,
    short: &dyn Fn(&str) -> String,
) -> (StepKind, String) {
    let fallback = || (StepKind::Command, short(&unwrap_shell(command)));
    let Some(list) = actions.as_array().filter(|l| !l.is_empty()) else {
        return fallback();
    };
    let kinds: Vec<&str> = list
        .iter()
        .map(|a| a.get("type").and_then(Value::as_str).unwrap_or("unknown"))
        .collect();
    if kinds.iter().any(|k| !matches!(*k, "read" | "search" | "listFiles")) {
        return fallback();
    }
    let text = |a: &Value, key: &str| {
        a.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    if kinds.iter().all(|k| *k == "read") {
        let names: Vec<String> = list
            .iter()
            .filter_map(|a| text(a, "name").or_else(|| text(a, "path").map(|p| last_part(&p).to_string())))
            .collect();
        if names.is_empty() {
            return fallback();
        }
        let mut label = format!("Read {}", names.iter().take(3).cloned().collect::<Vec<_>>().join(", "));
        if names.len() > 3 {
            label.push_str(&format!(" +{} more", names.len() - 3));
        }
        return (StepKind::Read, label);
    }
    if list.len() == 1 && kinds[0] == "search" {
        let a = &list[0];
        let Some(query) = text(a, "query") else {
            return fallback();
        };
        let label = match text(a, "path") {
            Some(path) => format!("Search {query} in {path}"),
            None => format!("Search {query}"),
        };
        return (StepKind::Search, label);
    }
    if list.len() == 1 && kinds[0] == "listFiles" {
        let path = text(&list[0], "path").unwrap_or_else(|| ".".to_string());
        return (StepKind::List, format!("List {path}"));
    }
    (StepKind::Read, format!("Explored {} files", list.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn same(s: &str) -> String {
        s.to_string()
    }

    #[test]
    fn split_cd_plain() {
        assert_eq!(split_cd("cd /x/y && git status"), (Some("/x/y"), "git status"));
    }

    #[test]
    fn split_cd_quoted_path_with_spaces() {
        assert_eq!(split_cd("cd \"/x/my dir\" && ls"), (Some("/x/my dir"), "ls"));
        assert_eq!(split_cd("cd '/x/my dir' && ls"), (Some("/x/my dir"), "ls"));
    }

    #[test]
    fn split_cd_semicolon() {
        assert_eq!(split_cd("cd /x/y; git status"), (Some("/x/y"), "git status"));
    }

    #[test]
    fn split_cd_leaves_mid_command_cd_alone() {
        assert_eq!(split_cd("git status && cd x"), (None, "git status && cd x"));
        assert_eq!(split_cd("cdrom --eject"), (None, "cdrom --eject"));
    }

    #[test]
    fn unwrap_zsh_lc_single_quotes() {
        assert_eq!(unwrap_shell("/bin/zsh -lc 'git status'"), "git status");
        assert_eq!(unwrap_shell("/bin/zsh -lc 'rg \"needle\" /tmp/probe3'"), "rg \"needle\" /tmp/probe3");
        assert_eq!(unwrap_shell("bash -c \"ls -la\""), "ls -la");
    }

    #[test]
    fn unwrap_leaves_plain_command() {
        assert_eq!(unwrap_shell("git status"), "git status");
        assert_eq!(unwrap_shell("python -c 'print(1)'"), "python -c 'print(1)'");
    }

    #[test]
    fn folder_note_none_for_room_folder() {
        assert_eq!(folder_note("/work/project", Some("/work/project/")), None);
    }

    #[test]
    fn folder_note_last_part() {
        assert_eq!(
            folder_note("/Users/x/Downloads/apex-deck-worktrees/ios-sim-upgrade", Some("/Users/x/Downloads/apex-deck")),
            Some("ios-sim-upgrade".to_string())
        );
    }

    #[test]
    fn codex_reads_list_names() {
        let one = json!([{"type":"read","command":"cat /tmp/probe3/b.txt","name":"b.txt","path":"/tmp/probe3/b.txt"}]);
        assert_eq!(codex_label("x", &one, &same), (StepKind::Read, "Read b.txt".to_string()));
        let many = json!([
            {"type":"read","command":"c","name":"a.rs","path":"/p/a.rs"},
            {"type":"read","command":"c","path":"/p/b.rs"},
            {"type":"read","command":"c","name":"c.rs","path":"/p/c.rs"},
            {"type":"read","command":"c","name":"d.rs","path":"/p/d.rs"},
            {"type":"read","command":"c","name":"e.rs","path":"/p/e.rs"}
        ]);
        assert_eq!(
            codex_label("x", &many, &same),
            (StepKind::Read, "Read a.rs, b.rs, c.rs +2 more".to_string())
        );
    }

    #[test]
    fn codex_search_with_path() {
        let a = json!([{"type":"search","command":"rg needle /tmp/probe3","query":"needle","path":"probe3"}]);
        assert_eq!(codex_label("x", &a, &same), (StepKind::Search, "Search needle in probe3".to_string()));
        let b = json!([{"type":"search","command":"rg needle","query":"needle"}]);
        assert_eq!(codex_label("x", &b, &same), (StepKind::Search, "Search needle".to_string()));
    }

    #[test]
    fn codex_list_and_mixed() {
        let l = json!([{"type":"listFiles","command":"ls /tmp/probe3/sub","path":"sub"}]);
        assert_eq!(codex_label("x", &l, &same), (StepKind::List, "List sub".to_string()));
        let l = json!([{"type":"listFiles","command":"ls"}]);
        assert_eq!(codex_label("x", &l, &same), (StepKind::List, "List .".to_string()));
        let m = json!([
            {"type":"read","command":"c","name":"a","path":"/a"},
            {"type":"search","command":"c","query":"q","path":"p"}
        ]);
        assert_eq!(codex_label("x", &m, &same), (StepKind::Read, "Explored 2 files".to_string()));
    }

    #[test]
    fn codex_unknown_falls_back() {
        let u = json!([{"type":"unknown","command":"git status"}]);
        assert_eq!(
            codex_label("/bin/zsh -lc 'git status'", &u, &same),
            (StepKind::Command, "git status".to_string())
        );
        assert_eq!(codex_label("git status", &json!(null), &same).0, StepKind::Command);
        assert_eq!(codex_label("git status", &json!([]), &same).0, StepKind::Command);
    }
}
