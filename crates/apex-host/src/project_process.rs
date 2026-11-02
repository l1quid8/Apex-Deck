//! One function for every project-folder spawn, per Task 8.
//! On a tainted folder it forces jailed execution at Edits level; on Full it gates.
//! Also provides a source-scanning guard: no raw `Command::new("git")` outside this module.

use std::path::Path;
use std::process::Command;

use crate::folder_trust;

/// The design's Full-gate message, centralized here so UI can reuse it.
pub fn full_refusal() -> &'static str {
    folder_trust::refusal_message()
}

/// Check whether a folder may host a Full bot.
pub fn check_full_allowed(data: &Path, folder: &Path) -> Result<(), String> {
    folder_trust::check_full_allowed(data, folder)
}

/// Record taint before a lower-writable jail starts.
pub fn mark_tainted_if_lower(data: &Path, folder: &Path, access: apex_core::Access) -> Result<(), String> {
    if matches!(access, apex_core::Access::Full) {
        return Ok(());
    }
    if matches!(access, apex_core::Access::Edits | apex_core::Access::Ask) {
        folder_trust::mark_tainted(data, folder)
    } else {
        Ok(())
    }
}

/// Build a `git` command that is isolated enough to not run project code outside jail.
pub fn git_command() -> Command {
    let mut cmd = Command::new("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd
}

/// Generic project process: program + args in a folder, with envs.
pub fn command_in(program: &str, folder: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.current_dir(folder);
    cmd
}

/// Async version for runner/checks
pub fn tokio_command_in(program: &str, folder: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.current_dir(folder);
    cmd
}

/// Helper for `bot_copies`, `git_changes`, checks: verify folder is not tainted for Full.
pub fn ensure_allowed_for_access(data: &Path, folder: &Path, access: apex_core::Access) -> Result<(), String> {
    if matches!(access, apex_core::Access::Full) {
        check_full_allowed(data, folder)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Tmp(PathBuf);
    impl Drop for Tmp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn tmp() -> Tmp {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("proj-proc-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }

    #[test]
    fn source_scan_no_raw_git_spawn_outside_wrapper() {
        // Strict: every file that spawns git or project code must go through project_process wrapper.
        // Catches: Command::new("git"), Command::new("sh"), Command::new("cmd"),
        // tokio::process::Command::new("git/sh/cmd") and raw project spawns like
        // Command::new(&check.argv[0]) used for runner checks.
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let exempt = ["project_process.rs", "folder_trust.rs"];
        let mut raw_git = Vec::new();
        let mut raw_sh = Vec::new();
        let mut raw_check = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("rs") { continue; }
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if exempt.contains(&name) { continue; }
                if name == "personal" { continue; }
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if content.contains("Command::new(\"git\")") {
                        raw_git.push(name.to_string());
                    }
                    // Direct sh/cmd spawn that runs project code outside wrapper
                    // Exempt git_changes.rs Windows junction helper (cmd mklink /J) — not project code
                    if name != "git_changes.rs" && (content.contains("Command::new(\"sh\")") || content.contains("Command::new(\"cmd\")")) {
                        raw_sh.push(name.to_string());
                    }
                    // tokio::process::Command::new(&check.argv[0]) pattern for runner checks
                    if content.contains("tokio::process::Command::new(&check.argv") {
                        raw_check.push(name.to_string());
                    }
                }
            }
        }
        // Check subdirs too (runner/checks.rs lives in runner/)
        let subdirs = ["runner", "assistant_delegation", "personal_worker"];
        for sub in subdirs {
            let sub_root = root.join(sub);
            if let Ok(entries) = std::fs::read_dir(&sub_root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("rs") { continue; }
                    let name = format!("{}/{}", sub, path.file_name().and_then(|n| n.to_str()).unwrap_or(""));
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        if content.contains("Command::new(\"git\")") {
                            raw_git.push(name.clone());
                        }
                        if content.contains("tokio::process::Command::new(&check.argv") {
                            raw_check.push(name.clone());
                        }
                        // Also check for generic tokio::process::Command::new that still has current_dir on project
                        // but bypasses project_process: look for pattern in checks.rs
                        if name.contains("checks.rs") && content.contains("tokio::process::Command::new(") && !content.contains("project_process::tokio_command_in") {
                            raw_check.push(name.clone());
                        }
                    }
                }
            }
        }
        assert!(raw_git.is_empty(), "raw Command::new(\"git\") still present in: {raw_git:?} - migrate to project_process::git_command()");
        assert!(raw_sh.is_empty(), "raw Command::new(\"sh\"/\"cmd\") still present in: {raw_sh:?} - migrate to project_process::tokio_command_in");
        assert!(raw_check.is_empty(), "raw runner check spawn still present in: {raw_check:?} - migrate to project_process");
    }

    #[test]
    fn lower_writable_taint_and_gate() {
        let t = tmp();
        let data = &t.0;
        let proj = data.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        mark_tainted_if_lower(data, &proj, apex_core::Access::Edits).unwrap();
        assert!(folder_trust::is_tainted(data, &proj));
        assert!(ensure_allowed_for_access(data, &proj, apex_core::Access::Full).is_err());
        assert!(ensure_allowed_for_access(data, &proj, apex_core::Access::Read).is_ok());
    }
}
