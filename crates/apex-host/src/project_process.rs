//! One function for every project-folder spawn, per Task 8.
//! Tainted automatic operations are refused until an Edits jail can be established.
//! Also provides a source-scanning guard: no raw `Command::new("git")` outside this module.

use std::path::Path;
use std::process::Command;

use crate::folder_trust;
mod command;
pub use command::{ProjectCommand, ProjectAsyncCommand, ProjectChild, prepare};

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

fn inherited_git_envs() -> Vec<String> {
    std::env::vars().filter_map(|(k,_)| if k.starts_with("GIT_") { Some(k) } else { None }).collect()
}

/// Automatic project operations never inherit Full acceptance. Until this
/// boundary can establish the complete Edits jail (including its lifetime and
/// proxy), refuse tainted folders instead of launching an ordinary host process.
pub(crate) fn check_project(data: &Path, folder: &Path) -> Result<(), String> {
    if apex_core::folder_trust::is_tainted_checked(data, folder)? && !cfg!(target_os = "linux") {
        return Err("Automatic project operation refused: this folder is lower-writable and an Edits jail is unavailable for this operation.".into());
    }
    Ok(())
}

/// Common Git environment and defensive flags. These flags supplement the
/// taint boundary; they do not make arbitrary project filters or scripts safe.
/// Kept crate-private for the separate byte-isolated checkpoint implementation.
fn harden_git(cmd: &mut Command) {
    for key in inherited_git_envs() { cmd.env_remove(key); }
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .env("GIT_ATTR_NOSYSTEM", "1")
        .args(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
               "-c", "core.attributesFile=", "-c", "diff.external="]);
}

/// Reserved for checkpoints, which independently isolate all Git inputs.
pub(crate) fn isolated_git_command() -> Command {
    let mut cmd = Command::new("git");
    harden_git(&mut cmd);
    cmd
}

#[cfg(test)]
pub(crate) fn fixture_git_command() -> Command { isolated_git_command() }

/// Construct Git only after checking the host's protected data-folder taint.
pub fn git_command(data: &Path, folder: &Path) -> Result<ProjectCommand, String> {
    check_project(data, folder)?;
    let mut cmd = isolated_git_command();
    cmd.current_dir(folder);
    Ok(ProjectCommand::new(cmd, data, folder))
}

pub fn command_in(data: &Path, program: &str, folder: &Path) -> Result<ProjectCommand, String> {
    check_project(data, folder)?;
    let mut cmd = Command::new(program);
    cmd.current_dir(folder);
    for key in inherited_git_envs() { cmd.env_remove(key); }
    Ok(ProjectCommand::new(cmd, data, folder))
}

pub fn tokio_command_in(data: &Path, program: &str, folder: &Path) -> Result<ProjectAsyncCommand, String> {
    Ok(ProjectAsyncCommand::new(command_in(data, program, folder)?))
}

/// Carry the protected data context into blocking project work without lending
/// a request-local reference to the worker thread.
pub(crate) fn spawn_blocking<T, F>(data: &Path, work: F) -> tokio::task::JoinHandle<T>
where T: Send + 'static, F: FnOnce(&Path) -> T + Send + 'static {
    let data = data.to_path_buf();
    tokio::task::spawn_blocking(move || work(&data))
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
                    if content.contains("Command::new(\"git\")") || (name != "checkpoints.rs" && content.contains("project_process::isolated_git_command(")) {
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

    #[test]
    #[cfg(unix)]
    fn command_constructed_clean_cannot_run_after_folder_is_tainted() {
        let t = tmp();
        let data = t.0.join("data");
        let project = t.0.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let marker = data.join("escaped-after-construction");
        let mut command = command_in(&data, "sh", &project).unwrap();
        command.args(["-c", &format!("printf escaped > '{}'", marker.display())]);
        folder_trust::mark_tainted(&data, &project).unwrap();
        let result = command.output();
        assert!(result.is_err() || !result.unwrap().status.success(), "constructed-clean command escaped after taint");
        assert!(!marker.exists(), "project command wrote protected data after taint");
    }

    #[test]
    fn all_project_builders_refuse_accepted_taint_and_invalid_trust_data() {
        let t = tmp();
        let data = t.0.join("data");
        let project = t.0.join("project");
        std::fs::create_dir_all(&project).unwrap();
        folder_trust::mark_tainted(&data, &project).unwrap();
        folder_trust::accept(&data, &project, None).unwrap();
        if !cfg!(target_os = "linux") {
            assert!(git_command(&data, &project).is_err());
            assert!(command_in(&data, "git", &project).is_err());
            assert!(tokio_command_in(&data, "git", &project).is_err());
        }
        std::fs::write(data.join("folder-trust.json"), "invalid").unwrap();
        assert!(git_command(&data, &project).is_err());
        assert!(command_in(&data, "git", &project).is_err());
        assert!(tokio_command_in(&data, "git", &project).is_err());
    }

    #[test]
    fn git_command_disables_fsmonitor_without_caller_flags() {
        // Planted files test per Task 8 Lower-writable design
        let t = tmp();
        let repo = t.0.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        // init repo with isolated git
        let mut init = std::process::Command::new("git");
        init.arg("-C").arg(&repo).arg("init").env("GIT_CONFIG_NOSYSTEM","1").env("GIT_CONFIG_GLOBAL","/dev/null").output().unwrap();
        let marker = t.0.join("evil-ran");
        let evil_script = t.0.join("evil.sh");
        std::fs::write(&evil_script, format!("#!/bin/sh\ntouch {}\n", marker.display())).unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let mut p = std::fs::metadata(&evil_script).unwrap().permissions(); p.set_mode(0o755); std::fs::set_permissions(&evil_script, p).unwrap(); }
        let mut cfg = std::process::Command::new("git");
        cfg.arg("-C").arg(&repo).args(["config", "core.fsmonitor", evil_script.to_string_lossy().as_ref()]).env("GIT_CONFIG_NOSYSTEM","1").env("GIT_CONFIG_GLOBAL","/dev/null").output().unwrap();
        let hooks_dir = repo.join(".git/hooks");
        std::fs::create_dir_all(&hooks_dir).unwrap();
        let hook = hooks_dir.join("post-checkout");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch {}\n", marker.display())).unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let mut p = std::fs::metadata(&hook).unwrap().permissions(); p.set_mode(0o755); std::fs::set_permissions(&hook, p).unwrap(); }
        for mut cmd in [git_command(&t.0.join("data"), &repo).unwrap()] {
            cmd.args(["--literal-pathspecs", "status", "--porcelain"]);
            let out = cmd.output().expect("git status");
            assert!(out.status.success(), "git status failed: {}", String::from_utf8_lossy(&out.stderr));
            assert!(!marker.exists(), "planted fsmonitor ran: {}", String::from_utf8_lossy(&out.stderr));
        }
    }
}
