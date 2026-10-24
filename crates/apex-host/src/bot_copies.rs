//! Git snapshots and isolated worktrees for concurrent bot editing.

use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

pub const SHARED_SHORTCUT_PATHS: &[&str] = &["node_modules"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CopyState {
    Working,
    Folding,
    Reconciling { attempt: u8 },
    NeedsYou { reason: String },
    Folded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotCopy {
    pub thread: String,
    pub bot: String,
    pub root: PathBuf,
    pub work: PathBuf,
    pub base: String,
    pub state: CopyState,
}

static SNAPSHOT_INDEX_SEQ: AtomicU64 = AtomicU64::new(1);

struct TempIndexGuard(PathBuf);
impl Drop for TempIndexGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn run_git(
    root: &Path,
    envs: &[(&str, &std::ffi::OsStr)],
    args: &[&str],
) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    cmd.args(args);
    let out = cmd
        .output()
        .map_err(|e| format!("Could not run git {}: {e}", args.first().unwrap_or(&"")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "Git {} failed: {}",
            args.first().unwrap_or(&"command"),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

fn verify_git_repo(root: &Path) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("Cannot resolve path: {e}"))?;
    let toplevel_str = match run_git(&root, &[], &["rev-parse", "--show-toplevel"]) {
        Ok(s) => s,
        Err(_) => {
            let mut sub_repos = 0;
            if let Ok(entries) = std::fs::read_dir(&root) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() && entry.path().join(".git").exists() {
                        sub_repos += 1;
                    }
                }
            }
            if sub_repos > 1 {
                return Err("Folder contains several Git checkouts.".into());
            }
            return Err("The folder is not a Git repository.".into());
        }
    };
    let toplevel = std::fs::canonicalize(Path::new(&toplevel_str))
        .map_err(|e| format!("Cannot resolve git toplevel: {e}"))?;
    if toplevel != root {
        return Err("The folder is not a Git repository root.".into());
    }
    let mut nested_checkouts = 0;
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.file_name().map(|n| n == ".git").unwrap_or(false) {
                continue;
            }
            if path.is_dir() && (path.join(".git").exists() || path.join(".git").is_file()) {
                nested_checkouts += 1;
            }
        }
    }
    if nested_checkouts > 0 {
        return Err("Folder contains several Git checkouts.".into());
    }
    Ok(root)
}

pub fn snapshot_tree(root: &Path) -> Result<String, String> {
    let root = verify_git_repo(root)?;
    let git_dir_str = run_git(&root, &[], &["rev-parse", "--absolute-git-dir"])?;
    let git_dir = PathBuf::from(git_dir_str.trim());

    let temp_index = git_dir.join(format!(
        "apex-copy-index-{}-{}",
        std::process::id(),
        SNAPSHOT_INDEX_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _guard = TempIndexGuard(temp_index.clone());

    let real_index = git_dir.join("index");
    if real_index.exists() {
        std::fs::copy(&real_index, &temp_index)
            .map_err(|e| format!("Could not seed temporary index from real index: {e}"))?;
    } else {
        run_git(
            &root,
            &[("GIT_INDEX_FILE", temp_index.as_os_str())],
            &["read-tree", "--empty"],
        )?;
    }

    let mut add_args = vec!["add", "-A", "--", "."];
    let mut excludes = Vec::new();
    for path in SHARED_SHORTCUT_PATHS {
        excludes.push(format!(":(exclude){path}"));
    }
    for exc in &excludes {
        add_args.push(exc.as_str());
    }
    run_git(
        &root,
        &[("GIT_INDEX_FILE", temp_index.as_os_str())],
        &add_args,
    )?;

    let tree = run_git(
        &root,
        &[("GIT_INDEX_FILE", temp_index.as_os_str())],
        &["write-tree"],
    )?;

    let head_commit = run_git(&root, &[], &["rev-parse", "--verify", "HEAD"]).ok();
    let commit = if let Some(head) = head_commit {
        run_git(
            &root,
            &[],
            &["commit-tree", &tree, "-p", &head, "-m", "Deck bot copy snapshot"],
        )?
    } else {
        run_git(
            &root,
            &[],
            &["commit-tree", &tree, "-m", "Deck bot copy snapshot"],
        )?
    };

    Ok(commit)
}

fn validate_identifier(name: &str, kind: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err(format!("Invalid {kind} name: cannot be empty, '.' or '..'"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!(
            "Invalid {kind} name: only letters, digits, '-', '_' and '.' are allowed"
        ));
    }
    Ok(())
}

fn cleanup_copy_artifacts(root: &Path, data: &Path, thread: &str, bot: &str, work: &Path) {
    let work_str = work.to_str().unwrap_or_default();
    let _ = run_git(root, &[], &["worktree", "remove", "--force", work_str]);
    let _ = run_git(root, &[], &["worktree", "prune"]);
    if work.exists() {
        let _ = std::fs::remove_dir_all(work);
    }

    let ref_name = format!("refs/apex-copies/{thread}/{bot}/base");
    let _ = run_git(root, &[], &["update-ref", "-d", &ref_name]);

    let bot_dir = data.join("bot-copies").join(thread).join(bot);
    let _ = std::fs::remove_dir_all(&bot_dir);

    let thread_dir = data.join("bot-copies").join(thread);
    if let Ok(mut entries) = std::fs::read_dir(&thread_dir) {
        if entries.next().is_none() {
            let _ = std::fs::remove_dir(&thread_dir);
        }
    }
}

pub fn create_copy(root: &Path, data: &Path, thread: &str, bot: &str) -> Result<BotCopy, String> {
    validate_identifier(thread, "thread")?;
    validate_identifier(bot, "bot")?;

    let root = verify_git_repo(root)?;

    let copy_dir = data.join("bot-copies").join(thread).join(bot);
    let work = copy_dir.join("work");
    let copy_json = copy_dir.join("copy.json");

    if work.exists() || copy_json.exists() {
        return Err("this bot already has a copy".into());
    }

    let base = snapshot_tree(&root)?;

    let ref_name = format!("refs/apex-copies/{thread}/{bot}/base");

    let res = (|| -> Result<BotCopy, String> {
        std::fs::create_dir_all(&copy_dir)
            .map_err(|e| format!("Could not create bot copy directory: {e}"))?;

        run_git(&root, &[], &["update-ref", &ref_name, &base])?;

        let work_str = work.to_str().ok_or("Invalid UTF-8 in worktree path")?;
        run_git(
            &root,
            &[],
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "worktree",
                "add",
                "--detach",
                "--lock",
                work_str,
                &base,
            ],
        )?;

        for rel in SHARED_SHORTCUT_PATHS {
            let target = root.join(rel);
            let link = work.join(rel);
            if link.exists() || link.is_symlink() {
                let _ = std::fs::remove_file(&link);
                let _ = std::fs::remove_dir_all(&link);
            }
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&target, &link).map_err(|e| {
                    format!(
                        "Could not symlink {} to {}: {e}",
                        target.display(),
                        link.display()
                    )
                })?;
            }
        }

        let copy = BotCopy {
            thread: thread.to_string(),
            bot: bot.to_string(),
            root: root.clone(),
            work: work.clone(),
            base,
            state: CopyState::Working,
        };
        save_state(data, &copy)?;
        Ok(copy)
    })();

    match res {
        Ok(copy) => Ok(copy),
        Err(err) => {
            cleanup_copy_artifacts(&root, data, thread, bot, &work);
            Err(err)
        }
    }
}

pub fn save_state(data: &Path, copy: &BotCopy) -> Result<(), String> {
    let copy_dir = data.join("bot-copies").join(&copy.thread).join(&copy.bot);
    std::fs::create_dir_all(&copy_dir)
        .map_err(|e| format!("Could not create copy directory: {e}"))?;
    let json_path = copy_dir.join("copy.json");
    let temp_json = copy_dir.join(format!("copy.json.tmp-{}", std::process::id()));
    let serialized = serde_json::to_string_pretty(copy)
        .map_err(|e| format!("Could not serialize copy state: {e}"))?;
    std::fs::write(&temp_json, serialized)
        .map_err(|e| format!("Could not write copy state: {e}"))?;
    std::fs::rename(&temp_json, &json_path)
        .map_err(|e| format!("Could not commit copy state: {e}"))?;
    Ok(())
}

pub fn load_copies(data: &Path) -> Vec<BotCopy> {
    let base_dir = data.join("bot-copies");
    let mut copies = Vec::new();
    let thread_entries = match std::fs::read_dir(&base_dir) {
        Ok(entries) => entries,
        Err(_) => return copies,
    };
    for thread_entry in thread_entries.flatten() {
        if !thread_entry.path().is_dir() {
            continue;
        }
        let bot_entries = match std::fs::read_dir(thread_entry.path()) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for bot_entry in bot_entries.flatten() {
            if !bot_entry.path().is_dir() {
                continue;
            }
            let json_path = bot_entry.path().join("copy.json");
            if let Ok(bytes) = std::fs::read(&json_path) {
                if let Ok(copy) = serde_json::from_slice::<BotCopy>(&bytes) {
                    copies.push(copy);
                }
            }
        }
    }
    copies
}

pub fn remove_copy(data: &Path, copy: &BotCopy) -> Result<(), String> {
    cleanup_copy_artifacts(&copy.root, data, &copy.thread, &copy.bot, &copy.work);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Temp(PathBuf);
    impl Temp {
        fn new(name: &str) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "apex-bot-copies-{}-{}-{}",
                name,
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn init_repo(name: &str) -> (Temp, PathBuf, PathBuf) {
        let temp = Temp::new(name);
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        fs::write(root.join("seed.txt"), "seed").unwrap();
        run(&["add", "seed.txt"]);
        run(&["commit", "-m", "initial seed"]);
        let data = temp.path().join("deck-data");
        fs::create_dir_all(&data).unwrap();
        (temp, root, data)
    }

    #[test]
    fn copy_snapshot_never_contains_node_modules_symlink() {
        let (_tmp, root, _data) = init_repo("nm-symlink");
        fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        run(&["add", ".gitignore"]);
        run(&["commit", "-m", "ignore node_modules with slash"]);

        // Create target folder and symlink named node_modules
        let external_dir = _tmp.path().join("shared-packages");
        fs::create_dir_all(&external_dir).unwrap();
        fs::write(external_dir.join("package.json"), "{}").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&external_dir, root.join("node_modules")).unwrap();

        let commit = snapshot_tree(&root).unwrap();
        let tree_listing = run_git(&root, &[], &["ls-tree", "--name-only", &commit]).unwrap();
        assert!(
            !tree_listing.lines().any(|l| l.trim() == "node_modules"),
            "Snapshot tree unexpectedly contained node_modules: {tree_listing}"
        );
    }

    #[test]
    fn snapshot_includes_uncommitted_and_untracked_but_not_ignored() {
        let (_tmp, root, _data) = init_repo("snapshot-content");
        fs::write(root.join(".gitignore"), "ignored.log\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", ".gitignore"]);
        run(&["commit", "-m", "add gitignore"]);

        // Unstaged modification
        fs::write(root.join("seed.txt"), "modified seed").unwrap();

        // Staged addition
        fs::write(root.join("staged.txt"), "staged file").unwrap();
        run(&["add", "staged.txt"]);

        // Untracked file
        fs::write(root.join("untracked.txt"), "untracked file").unwrap();

        // Ignored file
        fs::write(root.join("ignored.log"), "should not be snapshotted").unwrap();

        let commit = snapshot_tree(&root).unwrap();

        let show = |path: &str| run_git(&root, &[], &["show", &format!("{commit}:{path}")]);
        assert_eq!(show("seed.txt").unwrap(), "modified seed");
        assert_eq!(show("staged.txt").unwrap(), "staged file");
        assert_eq!(show("untracked.txt").unwrap(), "untracked file");
        assert!(show("ignored.log").is_err());
    }

    #[test]
    fn snapshot_leaves_index_head_and_status_untouched() {
        let (_tmp, root, _data) = init_repo("snapshot-untouched");
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };

        // Staged addition and unstaged modification
        fs::write(root.join("staged.txt"), "staged").unwrap();
        run(&["add", "staged.txt"]);
        fs::write(root.join("seed.txt"), "unstaged change").unwrap();
        fs::write(root.join("untracked.txt"), "untracked").unwrap();

        let index_path = root.join(".git").join("index");
        let index_bytes_before = fs::read(&index_path).unwrap();
        let head_before = run(&["rev-parse", "HEAD"]);
        let status_before = run(&["status", "--porcelain=v2"]);
        let stash_before = run(&["stash", "list"]);

        let _commit = snapshot_tree(&root).unwrap();

        let index_bytes_after = fs::read(&index_path).unwrap();
        let head_after = run(&["rev-parse", "HEAD"]);
        let status_after = run(&["status", "--porcelain=v2"]);
        let stash_after = run(&["stash", "list"]);

        assert_eq!(index_bytes_before, index_bytes_after, "Index file changed");
        assert_eq!(head_before, head_after, "HEAD changed");
        assert_eq!(status_before, status_after, "git status changed");
        assert_eq!(stash_before, stash_after, "stash list changed");
    }

    #[test]
    fn create_copy_is_locked_detached_worktree_with_shared_node_modules() {
        let (_tmp, root, data) = init_repo("worktree-copy");
        let root_nm = root.join("node_modules");
        fs::create_dir_all(&root_nm).unwrap();
        fs::write(root_nm.join("pkg.txt"), "installed package").unwrap();

        let copy = create_copy(&root, &data, "thread-abc", "bot-123").unwrap();
        assert_eq!(copy.thread, "thread-abc");
        assert_eq!(copy.bot, "bot-123");
        assert_eq!(copy.state, CopyState::Working);

        // Verify git worktree list --porcelain
        let wt_list = run_git(&root, &[], &["worktree", "list", "--porcelain"]).unwrap();
        let work_canonical = fs::canonicalize(&copy.work).unwrap();
        let work_str = work_canonical.to_str().unwrap();
        assert!(
            wt_list.contains(work_str),
            "Worktree list does not contain work dir: {wt_list}"
        );
        assert!(wt_list.contains("locked"), "Worktree is not marked locked");

        // Verify work/node_modules is a symlink pointing to root/node_modules
        let work_nm = copy.work.join("node_modules");
        assert!(work_nm.is_symlink(), "work/node_modules is not a symlink");
        let link_target = fs::read_link(&work_nm).unwrap();
        assert_eq!(
            fs::canonicalize(link_target).unwrap(),
            fs::canonicalize(&root_nm).unwrap()
        );
    }

    #[test]
    fn create_copy_refuses_non_git_folder() {
        let temp = Temp::new("non-git");
        let plain_dir = temp.path().join("plain");
        fs::create_dir_all(&plain_dir).unwrap();
        let data = temp.path().join("deck-data");
        fs::create_dir_all(&data).unwrap();

        let err = create_copy(&plain_dir, &data, "t", "b").unwrap_err();
        assert!(err.contains("not a Git repository"), "Unexpected error: {err}");

        // Folder with several checkouts
        let multi_dir = temp.path().join("multi");
        fs::create_dir_all(multi_dir.join("repo1").join(".git")).unwrap();
        fs::create_dir_all(multi_dir.join("repo2").join(".git")).unwrap();
        let err_multi = create_copy(&multi_dir, &data, "t", "b").unwrap_err();
        assert!(
            err_multi.contains("several Git checkouts"),
            "Unexpected error: {err_multi}"
        );
    }

    #[test]
    fn remove_copy_deletes_folder_ref_and_registration() {
        let (_tmp, root, data) = init_repo("remove-copy");
        let copy = create_copy(&root, &data, "thread-del", "bot-del").unwrap();

        let copies_before = load_copies(&data);
        assert_eq!(copies_before.len(), 1);
        assert!(copy.work.exists());

        let ref_name = format!("refs/apex-copies/{}/{}/base", copy.thread, copy.bot);
        assert!(run_git(&root, &[], &["rev-parse", "--verify", &ref_name]).is_ok());

        remove_copy(&data, &copy).unwrap();

        let copies_after = load_copies(&data);
        assert!(copies_after.is_empty(), "Copies list not empty after remove");
        assert!(!copy.work.exists(), "Worktree directory still exists");
        assert!(
            run_git(&root, &[], &["rev-parse", "--verify", &ref_name]).is_err(),
            "Ref was not deleted"
        );
    }

    #[test]
    fn create_copy_refuses_when_a_copy_already_exists() {
        let (_tmp, root, data) = init_repo("existing-copy");
        let copy = create_copy(&root, &data, "thread-dup", "bot-dup").unwrap();

        let work_file = copy.work.join("in_progress.txt");
        fs::write(&work_file, "unsaved work in copy").unwrap();

        let err = create_copy(&root, &data, "thread-dup", "bot-dup").unwrap_err();
        assert!(
            err.contains("already has a copy"),
            "Expected already has a copy error, got: {err}"
        );

        assert!(
            work_file.exists(),
            "Work file was wiped when second create_copy was called"
        );
        assert_eq!(
            fs::read_to_string(&work_file).unwrap(),
            "unsaved work in copy"
        );
    }

    #[test]
    fn create_copy_rejects_unsafe_names() {
        let (_tmp, root, data) = init_repo("unsafe-names");

        for bad in &["", ".", "..", "../foo", "foo/bar", "a b", "a*b", "a?b"] {
            assert!(
                create_copy(&root, &data, bad, "bot1").is_err(),
                "Expected error for thread name: {bad:?}"
            );
            assert!(
                create_copy(&root, &data, "thread1", bad).is_err(),
                "Expected error for bot name: {bad:?}"
            );
        }
    }

    #[test]
    fn create_copy_ignores_post_checkout_hook() {
        let (_tmp, root, data) = init_repo("hook-check");
        let hooks_dir = root.join(".git").join("hooks");
        fs::create_dir_all(&hooks_dir).unwrap();
        let hook_marker = root.join("hook_ran.txt");
        let hook_script = format!("#!/bin/sh\ntouch \"{}\"\n", hook_marker.display());
        let hook_file = hooks_dir.join("post-checkout");
        fs::write(&hook_file, hook_script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook_file, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let _copy = create_copy(&root, &data, "thread-hook", "bot-hook").unwrap();
        assert!(
            !hook_marker.exists(),
            "post-checkout hook was run during worktree add"
        );
    }
}
