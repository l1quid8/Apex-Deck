//! Which coding agents can be launched in a pane.
//!
//! The table below is the single place to add or rename a tool. The program
//! names are the commands these tools are commonly installed under; if yours
//! differs, change it here.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;

pub struct KnownAgent {
    pub key: &'static str,
    pub label: &'static str,
    pub program: &'static str,
}

pub const KNOWN_AGENTS: &[KnownAgent] = &[
    KnownAgent { key: "claude", label: "Claude Code", program: "claude" },
    KnownAgent { key: "codex", label: "Codex", program: "codex" },
    KnownAgent { key: "gemini", label: "Gemini CLI", program: "gemini" },
    KnownAgent { key: "cursor", label: "Cursor Agent", program: "cursor-agent" },
    KnownAgent { key: "copilot", label: "GitHub Copilot", program: "copilot" },
    KnownAgent { key: "grok", label: "Grok", program: "grok" },
    KnownAgent { key: "opencode", label: "OpenCode", program: "opencode" },
    KnownAgent { key: "aider", label: "Aider", program: "aider" },
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentInfo {
    pub key: String,
    pub label: String,
    pub program: String,
    pub found: bool,
}

/// The user's shell, used both to find tools and to launch them. Desktop
/// apps on macOS do not inherit the PATH set in shell startup files, so
/// going through the shell is the reliable way to see what the user sees in
/// their own terminal.
pub fn user_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".to_string())
    }
}

/// True if `shell` understands `-l -i -c` and `command -v`.
fn is_posix_like(shell: &str) -> bool {
    matches!(
        Path::new(shell).file_name().and_then(|n| n.to_str()),
        Some("zsh" | "bash" | "sh" | "dash" | "ksh")
    )
}

/// Is `program` an executable file in one of the directories in `path`?
pub fn on_path(program: &str, path: &str) -> bool {
    let extensions: &[&str] = if cfg!(windows) { &["", ".exe", ".cmd", ".bat"] } else { &[""] };
    std::env::split_paths(path).any(|dir| {
        extensions.iter().any(|ext| {
            let candidate = dir.join(format!("{program}{ext}"));
            is_executable(&candidate)
        })
    })
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Ask the user's login shell which of `programs` it can find. Returns the
/// names it found, or `None` if the shell could not be asked in time.
fn probe_with_shell(shell: &str, programs: &[&str]) -> Option<Vec<String>> {
    if !is_posix_like(shell) {
        return None;
    }
    // Program names come from the table above, never from user input.
    let script = format!(
        "for p in {}; do command -v \"$p\" >/dev/null 2>&1 && echo \"APEXFOUND:$p\"; done",
        programs.join(" ")
    );
    let text = run_with_deadline(
        Command::new(shell)
            .args(["-l", "-i", "-c", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    )?;
    Some(
        text.lines()
            .filter_map(|line| line.trim().strip_prefix("APEXFOUND:"))
            .map(str::to_string)
            .collect(),
    )
}

/// The PATH the user's own terminal has, read once from their login shell.
/// `None` if the shell could not be asked; callers then keep the app's PATH.
pub fn login_path() -> Option<String> {
    static CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| read_login_path(&user_shell())).clone()
}

fn read_login_path(shell: &str) -> Option<String> {
    if !is_posix_like(shell) {
        return None;
    }
    let output = run_with_deadline(
        Command::new(shell)
            .args(["-l", "-i", "-c", "echo \"APEXPATH:$PATH\""])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    )?;
    output
        .lines()
        .filter_map(|line| line.trim().strip_prefix("APEXPATH:"))
        .next_back()
        .map(str::to_string)
        .filter(|path| !path.is_empty())
}

/// Run a command and return what it printed, giving up after five seconds
/// because shell startup files can hang.
fn run_with_deadline(command: &mut Command) -> Option<String> {
    let mut child = command.spawn().ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Report which known agents are installed.
pub fn detect() -> Vec<AgentInfo> {
    let programs: Vec<&str> = KNOWN_AGENTS.iter().map(|a| a.program).collect();
    let from_shell = probe_with_shell(&user_shell(), &programs).unwrap_or_default();
    let path = std::env::var("PATH").unwrap_or_default();

    KNOWN_AGENTS
        .iter()
        .map(|agent| AgentInfo {
            key: agent.key.to_string(),
            label: agent.label.to_string(),
            program: agent.program.to_string(),
            found: from_shell.iter().any(|p| p == agent.program) || on_path(agent.program, &path),
        })
        .collect()
}

/// The command line that starts `program` the way the user's own terminal
/// would: through their login shell, so PATH and environment match.
/// `None` for `program` means a plain interactive shell.
pub fn launch_command(program: Option<&str>) -> (String, Vec<String>) {
    let shell = user_shell();
    match program {
        None if cfg!(windows) => (shell, vec![]),
        None => (shell, vec!["-l".to_string()]),
        Some(program) if cfg!(windows) => (shell, vec!["/C".to_string(), program.to_string()]),
        Some(program) if is_posix_like(&shell) => {
            (shell, vec!["-l".to_string(), "-i".to_string(), "-c".to_string(), program.to_string()])
        }
        Some(program) => (program.to_string(), vec![]),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn on_path_finds_executables_and_ignores_plain_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("apex-deck-agents-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tool = dir.join("mytool");
        let notes = dir.join("notes");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        std::fs::write(&notes, "text").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&notes, std::fs::Permissions::from_mode(0o644)).unwrap();

        let path = dir.to_string_lossy().into_owned();
        assert!(on_path("mytool", &path));
        assert!(!on_path("notes", &path));
        assert!(!on_path("missing", &path));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn shell_probe_reports_only_programs_that_exist() {
        let found = probe_with_shell("/bin/sh", &["sh", "apex-deck-no-such-program"]).unwrap();
        assert_eq!(found, vec!["sh".to_string()]);
    }

    #[test]
    fn login_path_is_read_from_the_shell() {
        let path = read_login_path("/bin/sh").unwrap();
        assert!(path.split(':').any(|dir| dir == "/usr/bin" || dir == "/bin"), "{path}");
        assert!(read_login_path("/usr/bin/fish").is_none());
    }

    #[test]
    fn shells_we_do_not_know_are_not_probed() {
        assert!(probe_with_shell("/usr/bin/fish", &["sh"]).is_none());
    }
}
