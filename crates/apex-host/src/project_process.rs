//! One function for every project-folder spawn, per Task 8.
//! Tainted automatic operations are refused until an Edits jail can be established.
//! Also provides a source-scanning guard: no raw `Command::new("git")` outside this module.

use std::path::{Path, PathBuf};
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
               "-c", "core.attributesFile=", "-c", "diff.external=",
               // A jail sees only its own worktrees, so an automatic gc there
               // would prune every other one; `prune_worktrees` does it instead.
               "-c", "gc.worktreePruneExpire=never"]);
}

/// Drop the registrations of `root`'s repository whose worktree folder is gone.
///
/// On Linux every project Git runs in a jail that shows only its own folders,
/// so `git worktree prune` there would see every other worktree — bot copies,
/// task checkouts, the person's own — as missing and forget them all. The
/// registry is read here instead, with the host's view of what exists. Locked
/// entries and ones whose record can't be read are left alone.
pub fn prune_worktrees(data: &Path, root: &Path) -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        let out = git_command(data, root)?.args(["worktree", "prune"]).output().map_err(|e| e.to_string())?;
        return if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()) };
    }
    let Some(common) = git_common_dir(root) else { return Ok(()) };
    let registry = common.join("worktrees");
    if !std::fs::symlink_metadata(&registry).is_ok_and(|meta| meta.is_dir()) { return Ok(()); }
    for entry in std::fs::read_dir(&registry).map_err(|e| e.to_string())?.flatten() {
        // `file_type` doesn't follow links: a planted link is never entered.
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) { continue; }
        let admin = entry.path();
        if std::fs::symlink_metadata(admin.join("locked")).is_ok() { continue; }
        let Ok(gitdir) = std::fs::read_to_string(admin.join("gitdir")) else { continue };
        let gitdir = gitdir.trim();
        if gitdir.is_empty() { continue; }
        let pointer = Path::new(gitdir);
        let pointer = if pointer.is_absolute() { pointer.to_path_buf() } else { admin.join(pointer) };
        if std::fs::symlink_metadata(&pointer).is_err() {
            std::fs::remove_dir_all(&admin).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The shared `.git` of the repository holding `folder`, read from disk: the
/// nearest `.git` folder above it, or the one a linked worktree's pointer names
/// when that folder names the checkout back.
fn git_common_dir(folder: &Path) -> Option<PathBuf> {
    let folder = folder.canonicalize().ok()?;
    for top in folder.ancestors() {
        let dot = top.join(".git");
        let Ok(meta) = std::fs::symlink_metadata(&dot) else { continue };
        if meta.is_dir() { return dot.canonicalize().ok(); }
        #[cfg(unix)]
        if meta.is_file() { return apex_adapters::linux_jail::linked_git_common(top); }
        return None;
    }
    None
}

/// Reserved for checkpoints, which independently isolate all Git inputs.
pub(crate) fn isolated_git_command() -> Command {
    let mut cmd = Command::new("git");
    harden_git(&mut cmd);
    cmd
}

#[cfg(test)]
pub(crate) fn fixture_git_command() -> Command { isolated_git_command() }

/// Protected host state for a fixture, kept outside its mounted project folders.
#[cfg(test)]
pub(crate) struct TestDataDir(std::path::PathBuf);

#[cfg(test)]
impl TestDataDir {
    pub(crate) fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!("apex-test-data-{}-{}-{}", std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    pub(crate) fn path(&self) -> &Path { &self.0 }
}

#[cfg(test)]
impl Drop for TestDataDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

/// Resolve a jailed fixture's PID before checking it from the host namespace.
#[cfg(all(test, unix))]
pub(crate) fn fixture_host_pid(project: &Path, pid: i32) -> Option<i32> {
    #[cfg(target_os = "linux")]
    {
        let project = project.canonicalize().unwrap();
        let mut found = std::fs::read_dir("/proc").unwrap().flatten().filter_map(|entry| {
            let host_pid: i32 = entry.file_name().to_str()?.parse().ok()?;
            if std::fs::read_link(entry.path().join("cwd")).ok()? != project { return None; }
            let status = std::fs::read_to_string(entry.path().join("status")).ok()?;
            let namespace_pids: Vec<i32> = status.lines().find_map(|line| line.strip_prefix("NSpid:"))?
                .split_whitespace().filter_map(|value| value.parse().ok()).collect();
            (namespace_pids.last() == Some(&pid)).then_some(host_pid)
        });
        let pid = found.next();
        assert!(found.next().is_none(), "fixture PID must identify exactly one jailed process");
        pid
    }
    #[cfg(not(target_os = "linux"))]
    { let _ = project; Some(pid) }
}

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

    #[tokio::test]
    async fn project_operations_propagate_unreadable_trust_before_launch() {
        let t = tmp();
        let data = t.0.join("data");
        let project = t.0.join("project");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(data.join("folder-trust.json"), "invalid").unwrap();

        let expected = check_project(&data, &project).unwrap_err();
        assert_eq!(crate::git_changes::status(&data, &project).unwrap_err(), expected);

        let shell = crate::project_check::run_check(&data, &project, "echo ok").await;
        assert_eq!(shell, crate::project_check::CheckResult::Fail { output_tail: expected.clone() });

        let check = crate::runner::checks::ConfiguredCheck {
            id: "verify".into(), argv: vec!["missing-check-program".into()], timeout_ms: None,
        };
        let process_dir = data.join("processes");
        let error = crate::runner::checks::prepare_check(&data, &check, &project, &process_dir)
            .err().expect("runner must consult folder trust before spawning");
        assert_eq!(error, expected);
        assert!(!process_dir.exists());
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
