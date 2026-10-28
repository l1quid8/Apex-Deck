//! Git snapshots and isolated worktrees for concurrent bot editing.

use apex_core::{CopyProvider, Message, ParticipantId, RoomEvent, Speaker};
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, Mutex},
};

pub const SHARED_SHORTCUT_PATHS: &[&str] = &["node_modules"];

fn file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    { std::os::unix::fs::symlink(target, link) }
    #[cfg(windows)]
    {
        let _ = (target, link);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Git symlink materialization is not supported on Windows",
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CopyState {
    Working,
    Folding,
    Reconciling {
        attempt: u8,
        #[serde(default)]
        files: Vec<String>,
    },
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
    /// The bot's display name, for notes. Older copies have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
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
        if *k == "GIT_INDEX_FILE" {
            cmd.env(k, crate::assistant_git::external_path(Path::new(v)).as_os_str());
        } else {
            cmd.env(k, v);
        }
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

pub fn snapshot_tree_and_id(root: &Path) -> Result<(String, String), String> {
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
        // Git uses the index timestamp to decide whether matching cached file
        // stats could hide a same-size edit. Linux's fs::copy gives the copy
        // a newer timestamp, which incorrectly makes those entries look clean.
        let modified = std::fs::metadata(&real_index).and_then(|m| m.modified())
            .map_err(|e| format!("Could not read real index timestamp: {e}"))?;
        std::fs::copy(&real_index, &temp_index)
            .map_err(|e| format!("Could not seed temporary index from real index: {e}"))?;
        std::fs::OpenOptions::new().write(true).open(&temp_index)
            .and_then(|file| file.set_times(std::fs::FileTimes::new().set_modified(modified)))
            .map_err(|e| format!("Could not preserve temporary index timestamp: {e}"))?;
    } else {
        run_git(
            &root,
            &[("GIT_INDEX_FILE", temp_index.as_os_str())],
            &["read-tree", "--empty"],
        )?;
    }

    // An exclude pathspec makes `git add` refuse outright when the path is
    // also ignored, so add everything and then drop the shared paths.
    run_git(
        &root,
        &[("GIT_INDEX_FILE", temp_index.as_os_str())],
        &["add", "-A", "--", "."],
    )?;
    let mut rm_args = vec!["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--"];
    rm_args.extend_from_slice(SHARED_SHORTCUT_PATHS);
    run_git(
        &root,
        &[("GIT_INDEX_FILE", temp_index.as_os_str())],
        &rm_args,
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

    Ok((commit, tree))
}

pub fn snapshot_tree(root: &Path) -> Result<String, String> {
    snapshot_tree_and_id(root).map(|(commit, _)| commit)
}

pub fn snapshot_tree_id(root: &Path) -> Result<String, String> {
    snapshot_tree_and_id(root).map(|(_, tree)| tree)
}

pub(crate) fn validate_identifier(name: &str, kind: &str) -> Result<(), String> {
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
    let work_path = crate::assistant_git::external_path(work);
    let work_str = work_path.to_str().unwrap_or_default();
    let _ = run_git(root, &[], &["worktree", "unlock", work_str]);
    let _ = run_git(root, &[], &["worktree", "remove", "--force", "--force", work_str]);
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

        let work_path = crate::assistant_git::external_path(&work);
        let work_str = work_path.to_str().ok_or("Invalid UTF-8 in worktree path")?;
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
            crate::git_changes::link_dir(&target, &link).map_err(|e| {
                format!("Could not link {} to {}: {e}", target.display(), link.display())
            })?;
        }

        let copy = BotCopy {
            thread: thread.to_string(),
            bot: bot.to_string(),
            root: root.clone(),
            work: work.clone(),
            base,
            state: CopyState::Working,
            name: None,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FoldOutcome {
    Clean {
        files: Vec<String>,
        ignored_skipped: Vec<String>,
    },
    Conflicts {
        files: Vec<String>,
    },
    MainMoved,
}

#[derive(Debug, Clone)]
struct DiffEntry {
    old_mode: String,
    new_mode: String,
    old_sha: String,
    new_sha: String,
    status: char,
    #[allow(dead_code)]
    path: String,
}

#[cfg(windows)]
fn check_windows_materialization<'a>(
    entries: impl IntoIterator<Item = (&'a String, &'a DiffEntry)>,
) -> Result<(), String> {
    // Git mode 120000 does not record whether a link targets a directory.
    // Refuse before any destination writes rather than create a broken Windows
    // file link, or remove an existing destination before discovering this.
    for (path, entry) in entries {
        if entry.new_mode == "120000"
            && !SHARED_SHORTCUT_PATHS.contains(&path.as_str())
            && !path.starts_with("node_modules/")
        {
            return Err(format!(
                "Git symlink materialization is not supported on Windows: {path}"
            ));
        }
    }
    Ok(())
}

fn diff_trees(
    repo: &Path,
    commit_a: &str,
    commit_b: &str,
) -> Result<std::collections::HashMap<String, DiffEntry>, String> {
    let mut map = std::collections::HashMap::new();
    let mut cmd = Command::new("git");
    cmd.current_dir(repo);
    cmd.args(["diff-tree", "-r", "--raw", "--no-renames", "-z", commit_a, commit_b]);
    let out = cmd
        .output()
        .map_err(|e| format!("Could not run git diff-tree: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git diff-tree failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let stdout = out.stdout;
    let mut i = 0;
    while i < stdout.len() {
        let next_null = match stdout[i..].iter().position(|&b| b == 0) {
            Some(pos) => i + pos,
            None => break,
        };
        let header_bytes = &stdout[i..next_null];
        i = next_null + 1;
        if header_bytes.is_empty() {
            continue;
        }
        let header_str = String::from_utf8_lossy(header_bytes);
        let header_str = header_str.trim();
        if !header_str.starts_with(':') {
            continue;
        }
        let path_null = match stdout[i..].iter().position(|&b| b == 0) {
            Some(pos) => i + pos,
            None => break,
        };
        let path_bytes = &stdout[i..path_null];
        i = path_null + 1;
        let path = String::from_utf8_lossy(path_bytes).to_string();

        let parts: Vec<&str> = header_str[1..].split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        let old_mode = parts[0].to_string();
        let new_mode = parts[1].to_string();
        let old_sha = parts[2].to_string();
        let new_sha = parts[3].to_string();
        let status = parts[4].chars().next().unwrap_or('M');

        map.insert(
            path.clone(),
            DiffEntry {
                old_mode,
                new_mode,
                old_sha,
                new_sha,
                status,
                path,
            },
        );
    }
    Ok(map)
}

fn get_blob(repo: &Path, sha: &str) -> Result<Vec<u8>, String> {
    if sha.chars().all(|c| c == '0') {
        return Ok(Vec::new());
    }
    let mut cmd = Command::new("git");
    cmd.current_dir(repo);
    cmd.args(["cat-file", "-p", sha]);
    let out = cmd
        .output()
        .map_err(|e| format!("Could not run git cat-file: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(format!(
            "git cat-file failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

fn is_binary(bytes: &[u8]) -> bool {
    let check_len = bytes.len().min(8000);
    bytes[..check_len].contains(&0)
}

fn get_ignored_new_in_work(root: &Path, work: &Path) -> Vec<String> {
    let mut skipped = Vec::new();
    let out = match Command::new("git")
        .current_dir(work)
        .args(["status", "--ignored", "--porcelain", "-z"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return skipped,
    };
    let stdout = out.stdout;
    let mut i = 0;
    while i < stdout.len() {
        let next_null = match stdout[i..].iter().position(|&b| b == 0) {
            Some(pos) => i + pos,
            None => break,
        };
        let entry_bytes = &stdout[i..next_null];
        i = next_null + 1;
        if entry_bytes.len() < 3 {
            continue;
        }
        let prefix = &entry_bytes[..3];
        if prefix == b"!! " {
            let rel_bytes = &entry_bytes[3..];
            let rel = String::from_utf8_lossy(rel_bytes);
            let rel = rel.trim_end_matches('/');
            if SHARED_SHORTCUT_PATHS.contains(&rel) || rel.starts_with("node_modules") {
                continue;
            }
            if !root.join(rel).exists() {
                skipped.push(rel.to_string());
            }
        }
    }
    skipped.sort();
    skipped.dedup();
    skipped
}

fn check_unresolved_markers(work: &Path, files_to_check: &[String]) -> Vec<String> {
    let mut still_conflicted = Vec::new();
    for f in files_to_check {
        let target = work.join(f);
        if let Ok(bytes) = std::fs::read(&target) {
            let s = String::from_utf8_lossy(&bytes);
            let has_marker = s.lines().any(|line| {
                line.starts_with("<<<<<<< ")
                    || line.starts_with("=======")
                    || line.starts_with(">>>>>>> ")
            });
            if has_marker {
                still_conflicted.push(f.clone());
            }
        }
    }
    still_conflicted.sort();
    still_conflicted.dedup();
    still_conflicted
}

pub fn merge_main_into_copy(copy: &BotCopy) -> Result<FoldOutcome, String> {
    let root = verify_git_repo(&copy.root)?;
    let work = &copy.work;
    let base_ref = format!("refs/apex-copies/{}/{}/base", copy.thread, copy.bot);
    let base = match run_git(&root, &[], &["rev-parse", "--verify", &base_ref]) {
        Ok(s) => s,
        Err(_) => copy.base.clone(),
    };

    let mut files_to_check: Vec<String> = Vec::new();
    if let CopyState::Reconciling { files: ref cf, .. } = copy.state {
        files_to_check.extend(cf.clone());
    }

    let m_commit = snapshot_tree(&root)?;
    let c_commit = snapshot_tree(work)?;

    let diff_m = diff_trees(&root, &base, &m_commit)?;
    let diff_c = diff_trees(&root, &base, &c_commit)?;

    if diff_m.is_empty() {
        let diff_after = diff_trees(&root, &m_commit, &c_commit)?;
        let mut files: Vec<String> = diff_after
            .into_keys()
            .filter(|f| !SHARED_SHORTCUT_PATHS.contains(&f.as_str()) && !f.starts_with("node_modules/"))
            .collect();
        files.sort();
        files.dedup();

        let still_conflicted = check_unresolved_markers(work, &files_to_check);
        if !still_conflicted.is_empty() {
            return Ok(FoldOutcome::Conflicts { files: still_conflicted });
        }

        return Ok(FoldOutcome::Clean {
            files,
            ignored_skipped: get_ignored_new_in_work(&root, work),
        });
    }

    #[cfg(windows)]
    check_windows_materialization(diff_m.iter().filter(|(path, _)| !diff_c.contains_key(*path)))?;

    let mut all_paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for p in diff_m.keys() {
        all_paths.insert(p.clone());
    }
    for p in diff_c.keys() {
        all_paths.insert(p.clone());
    }

    let mut conflicts = Vec::new();

    for path in &all_paths {
        if SHARED_SHORTCUT_PATHS.contains(&path.as_str()) || path.starts_with("node_modules/") {
            continue;
        }
        let m_opt = diff_m.get(path);
        let c_opt = diff_c.get(path);

        if let (Some(m), None) = (m_opt, c_opt) {
            if m.old_mode == "160000" || m.new_mode == "160000" {
                continue;
            }
            let target = work.join(path);
            if m.status == 'D' {
                if target.exists() || target.is_symlink() {
                    std::fs::remove_file(&target)
                        .map_err(|e| format!("Could not remove {}: {e}", target.display()))?;
                }
            } else {
                let bytes = get_blob(&root, &m.new_sha)?;
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Could not create dir: {e}"))?;
                }
                if target.exists() || target.is_symlink() {
                    std::fs::remove_file(&target)
                        .map_err(|e| format!("Could not remove existing {}: {e}", target.display()))?;
                }
                if m.new_mode == "120000" {
                    let link_target = String::from_utf8(bytes).map_err(|e| {
                        format!("Invalid utf-8 in symlink {}: {e}", target.display())
                    })?;
                    file_symlink(Path::new(&link_target), &target)
                        .map_err(|e| format!("Could not symlink {}: {e}", target.display()))?;
                } else {
                    std::fs::write(&target, bytes)
                        .map_err(|e| format!("Could not write {}: {e}", target.display()))?;
                    #[cfg(unix)]
                    if m.new_mode == "100755" {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(
                            &target,
                            std::fs::Permissions::from_mode(0o755),
                        )
                        .map_err(|e| {
                            format!("Could not set permissions on {}: {e}", target.display())
                        })?;
                    }
                }
            }
        } else if let (None, Some(_c)) = (m_opt, c_opt) {
            continue;
        } else if let (Some(m), Some(c)) = (m_opt, c_opt) {
            if m.old_mode == "160000"
                || m.new_mode == "160000"
                || c.old_mode == "160000"
                || c.new_mode == "160000"
            {
                continue;
            }
            if m.new_sha == c.new_sha && m.new_mode == c.new_mode {
                continue;
            }
            if m.status == 'D' || c.status == 'D' {
                conflicts.push(path.clone());
                continue;
            }
            // Links and file-type changes never go through a text merge: writing
            // the merged text would follow the link and overwrite its target.
            if [c.old_mode.as_str(), c.new_mode.as_str(), m.new_mode.as_str()]
                .iter()
                .any(|mode| !mode.starts_with("100"))
            {
                conflicts.push(path.clone());
                continue;
            }

            let c_bytes = get_blob(&root, &c.new_sha)?;
            let m_bytes = get_blob(&root, &m.new_sha)?;
            let base_bytes = get_blob(&root, &c.old_sha)?;

            if is_binary(&c_bytes) || is_binary(&m_bytes) || is_binary(&base_bytes) {
                conflicts.push(path.clone());
                continue;
            }

            let temp_dir = std::env::temp_dir().join(format!(
                "apex-merge-{}-{}",
                std::process::id(),
                SNAPSHOT_INDEX_SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::create_dir_all(&temp_dir);
            let c_file = temp_dir.join("c");
            let base_file = temp_dir.join("base");
            let m_file = temp_dir.join("m");
            std::fs::write(&c_file, &c_bytes)
                .map_err(|e| format!("Could not write temp c: {e}"))?;
            std::fs::write(&base_file, &base_bytes)
                .map_err(|e| format!("Could not write temp base: {e}"))?;
            std::fs::write(&m_file, &m_bytes)
                .map_err(|e| format!("Could not write temp m: {e}"))?;

            let res = Command::new("git")
                .args(["merge-file", "-p", "-L", "copy", "-L", "base", "-L", "main"])
                .arg(&c_file)
                .arg(&base_file)
                .arg(&m_file)
                .output()
                .map_err(|e| format!("Could not run git merge-file: {e}"))?;

            let _ = std::fs::remove_dir_all(&temp_dir);

            let target = work.join(path);
            if target.is_symlink() {
                conflicts.push(path.clone());
                continue;
            }
            if let Some(parent) = target.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&target, &res.stdout)
                .map_err(|e| format!("Could not write merged file {}: {e}", target.display()))?;

            if res.status.code() != Some(0) {
                conflicts.push(path.clone());
            }
        }
    }

    // <data>/bot-copies/<thread>/<bot>/work, so four levels up is <data>.
    // Update base ref to M: work has now received M's changes (cleanly or with conflict markers)
    run_git(&root, &[], &["update-ref", &base_ref, &m_commit])?;

    if let Some(data_dir) = work.parent().and_then(|p| p.parent()).and_then(|p| p.parent()).and_then(|p| p.parent()) {
        let mut updated = copy.clone();
        updated.base = m_commit.clone();
        save_state(data_dir, &updated)?;
    }

    if !conflicts.is_empty() {
        conflicts.sort();
        conflicts.dedup();
        return Ok(FoldOutcome::Conflicts { files: conflicts });
    }

    let c_prime = snapshot_tree(work)?;
    let diff_after = diff_trees(&root, &m_commit, &c_prime)?;
    let mut files: Vec<String> = diff_after
        .keys()
        .filter(|p| !SHARED_SHORTCUT_PATHS.contains(&p.as_str()) && !p.starts_with("node_modules/"))
        .cloned()
        .collect();
    files.sort();

    let still_conflicted = check_unresolved_markers(work, &files_to_check);
    if !still_conflicted.is_empty() {
        return Ok(FoldOutcome::Conflicts { files: still_conflicted });
    }

    let ignored_skipped = get_ignored_new_in_work(&root, work);

    Ok(FoldOutcome::Clean {
        files,
        ignored_skipped,
    })
}

pub fn apply_copy_to_main(copy: &BotCopy) -> Result<FoldOutcome, String> {
    let root = verify_git_repo(&copy.root)?;
    let work = &copy.work;

    let base_ref = format!("refs/apex-copies/{}/{}/base", copy.thread, copy.bot);
    let expected_tree = run_git(
        &root,
        &[],
        &["rev-parse", "--verify", &format!("{base_ref}^{{tree}}")],
    )?;
    let current_main_tree = snapshot_tree_id(&root)?;
    if current_main_tree != expected_tree {
        return Ok(FoldOutcome::MainMoved);
    }

    let base = run_git(&root, &[], &["rev-parse", "--verify", &base_ref])?;
    let c_prime = snapshot_tree(work)?;
    let diff = diff_trees(&root, &base, &c_prime)?;

    #[cfg(windows)]
    check_windows_materialization(&diff)?;

    let mut files = Vec::new();

    for (path, entry) in &diff {
        if SHARED_SHORTCUT_PATHS.contains(&path.as_str()) || path.starts_with("node_modules/") {
            continue;
        }
        if entry.old_mode == "160000" || entry.new_mode == "160000" {
            continue;
        }
        let target = root.join(path);
        if entry.status == 'D' {
            if target.exists() || target.is_symlink() {
                std::fs::remove_file(&target)
                    .map_err(|e| format!("Could not remove file {}: {e}", target.display()))?;
            }
            files.push(path.clone());
        } else {
            let bytes = get_blob(&root, &entry.new_sha)?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Could not create parent dir: {e}"))?;
            }
            let temp_name = format!(
                "{}.tmp-fold-{}-{}",
                target
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("file"),
                std::process::id(),
                SNAPSHOT_INDEX_SEQ.fetch_add(1, Ordering::Relaxed)
            );
            let tmp = target.with_file_name(temp_name);
            if tmp.exists() || tmp.is_symlink() {
                let _ = std::fs::remove_file(&tmp);
            }
            if entry.new_mode == "120000" {
                let link_target = String::from_utf8(bytes).map_err(|e| {
                    format!("Invalid utf-8 in symlink {}: {e}", target.display())
                })?;
                file_symlink(Path::new(&link_target), &tmp).map_err(|e| {
                    format!("Could not create symlink at {}: {e}", tmp.display())
                })?;
            } else {
                std::fs::write(&tmp, bytes)
                    .map_err(|e| format!("Could not write to {}: {e}", tmp.display()))?;
                #[cfg(unix)]
                if entry.new_mode == "100755" {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(
                        &tmp,
                        std::fs::Permissions::from_mode(0o755),
                    )
                    .map_err(|e| format!("Could not set permissions on {}: {e}", tmp.display()))?;
                }
            }
            std::fs::rename(&tmp, &target).map_err(|e| {
                format!(
                    "Could not rename {} to {}: {e}",
                    tmp.display(),
                    target.display()
                )
            })?;
            files.push(path.clone());
        }
    }

    files.sort();
    files.dedup();
    let ignored_skipped = get_ignored_new_in_work(&root, work);

    Ok(FoldOutcome::Clean {
        files,
        ignored_skipped,
    })
}

pub fn human_note_line(bot: &str, files: &[String], reason: &str) -> String {
    let reason = reason.trim_end().trim_end_matches('.');
    if files.is_empty() {
        format!("{bot}'s changes couldn't be folded in ({reason}). Its copy is kept in the Worktrees tab.")
    } else {
        format!("{bot}'s changes to {} couldn't be folded in ({reason}). Its copy is kept in the Worktrees tab.", files.join(", "))
    }
}

pub type ReconcileStarter = Arc<
    dyn Fn(String, ParticipantId, String) -> BoxFuture<'static, Result<(), String>> + Send + Sync,
>;

pub fn recover_unfolded_copies(data: &Path) -> Vec<BotCopy> {
    load_copies(data)
        .into_iter()
        .filter(|c| matches!(c.state, CopyState::Working | CopyState::Folding | CopyState::Reconciling { .. }))
        .collect()
}

async fn wait_for_quiet_main(root: &Path, quiet_duration: std::time::Duration) -> Result<(), String> {
    let mut last_tree = tokio::task::spawn_blocking({
        let root = root.to_path_buf();
        move || snapshot_tree_id(&root)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut quiet_start = tokio::time::Instant::now();

    while quiet_start.elapsed() < quiet_duration {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let current_tree = tokio::task::spawn_blocking({
            let root = root.to_path_buf();
            move || snapshot_tree_id(&root)
        })
        .await
        .map_err(|e| e.to_string())??;
        if current_tree != last_tree {
            last_tree = current_tree;
            quiet_start = tokio::time::Instant::now();
        }
    }
    Ok(())
}

pub struct FoldTask {
    pub thread: String,
    pub copy: BotCopy,
    pub editor_handle: Arc<Mutex<Option<ParticipantId>>>,
    pub event_sink: Arc<dyn Fn(RoomEvent) + Send + Sync>,
    pub reconcile: Option<ReconcileStarter>,
}

pub struct FoldQueue {
    queues: Mutex<HashMap<PathBuf, VecDeque<FoldTask>>>,
    workers: Mutex<HashSet<PathBuf>>,
    data: PathBuf,
    quiet_duration: std::time::Duration,
    reconcile: Mutex<Option<ReconcileStarter>>,
}

impl Default for FoldQueue {
    fn default() -> Self {
        Self {
            queues: Mutex::default(),
            workers: Mutex::default(),
            data: PathBuf::new(),
            quiet_duration: std::time::Duration::from_secs(2),
            reconcile: Mutex::default(),
        }
    }
}

impl FoldQueue {
    pub fn new(data: PathBuf) -> Self {
        Self {
            queues: Mutex::default(),
            workers: Mutex::default(),
            data,
            quiet_duration: std::time::Duration::from_secs(2),
            reconcile: Mutex::default(),
        }
    }

    pub fn set_reconcile(&self, starter: ReconcileStarter) {
        *self.reconcile.lock().unwrap() = Some(starter);
    }

    pub fn with_quiet_duration(mut self, d: std::time::Duration) -> Self {
        self.quiet_duration = d;
        self
    }

    pub fn enqueue(self: &Arc<Self>, task: FoldTask) {
        let root = task.copy.root.clone();
        let key = crate::assistant_git::checkout_root(&root)
            .unwrap_or_else(|_| std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone()));
        {
            let mut queues = self.queues.lock().unwrap();
            queues.entry(key.clone()).or_default().push_back(task);
        }
        self.spawn_worker_if_needed(key);
    }

    fn spawn_worker_if_needed(self: &Arc<Self>, key: PathBuf) {
        let mut workers = self.workers.lock().unwrap();
        if workers.contains(&key) {
            return;
        }
        workers.insert(key.clone());
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.run_worker(key).await;
        });
    }

    async fn run_worker(&self, key: PathBuf) {
        loop {
            let task = {
                let mut queues = self.queues.lock().unwrap();
                let q = queues.get_mut(&key);
                match q.and_then(|q| q.pop_front()) {
                    Some(t) => t,
                    None => {
                        self.workers.lock().unwrap().remove(&key);
                        break;
                    }
                }
            };
            self.process_task(task).await;
        }
    }

    fn mark_needs_you(&self, copy: &BotCopy, task: &FoldTask, reason: &str, files: &[String]) {
        let mut updated = copy.clone();
        updated.state = CopyState::NeedsYou {
            reason: reason.to_string(),
        };
        if let Err(e) = save_state(&self.data, &updated) {
            eprintln!("bot copy {}/{}: could not save its Needs you state: {e}", copy.thread, copy.bot);
        }
        let note = human_note_line(copy.name.as_deref().unwrap_or(&copy.bot), files, reason);
        (task.event_sink)(RoomEvent::MessageAdded {
            message: Message { late_reply_from: None, origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None,
                servers: Vec::new(),
                seq: 0,
                speaker: Speaker::Bot(ParticipantId::new("deck")),
                text: note,
                at: None,
            },
        });
    }

    async fn send_back(
        &self,
        copy: &BotCopy,
        task: &FoldTask,
        reason: &str,
        msg: String,
        files: &[String],
    ) {
        let current_attempt = match &copy.state {
            CopyState::Reconciling { attempt, .. } => *attempt,
            _ => 0,
        };
        let next_attempt = current_attempt + 1;
        if next_attempt > 2 {
            self.mark_needs_you(copy, task, reason, files);
            return;
        }
        let mut updated = copy.clone();
        updated.state = CopyState::Reconciling {
            attempt: next_attempt,
            files: files.to_vec(),
        };
        if let Err(e) = save_state(&self.data, &updated) {
            self.mark_needs_you(copy, task, &format!("could not save copy state: {e}"), files);
            return;
        }

        let reconcile = task.reconcile.clone().or_else(|| self.reconcile.lock().unwrap().clone());
        if let Some(starter) = reconcile {
            let bot_id = ParticipantId::new(&copy.bot);
            if let Err(e) = (starter)(task.thread.clone(), bot_id, msg).await {
                self.mark_needs_you(copy, task, &format!("could not start reconcile turn: {e}"), files);
            }
        } else {
            self.mark_needs_you(copy, task, "no reconcile starter available", files);
        }
    }

    async fn process_task(&self, task: FoldTask) {
        let fold_owner = ParticipantId::new("deck-fold");
        loop {
            {
                let mut held = task.editor_handle.lock().unwrap();
                if held.is_none() {
                    *held = Some(fold_owner.clone());
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        struct ReleaseGuard(Arc<Mutex<Option<ParticipantId>>>);
        impl Drop for ReleaseGuard {
            fn drop(&mut self) {
                let mut held = self.0.lock().unwrap();
                if *held == Some(ParticipantId::new("deck-fold")) {
                    *held = None;
                }
            }
        }
        let _guard = ReleaseGuard(Arc::clone(&task.editor_handle));

        let copy = task.copy.clone();
        let mut retries = 0;
        loop {
            let copy_clone = copy.clone();
            let merge_outcome = match tokio::task::spawn_blocking(move || merge_main_into_copy(&copy_clone)).await {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => {
                    self.mark_needs_you(&copy, &task, &e, &[]);
                    break;
                }
                Err(e) => {
                    self.mark_needs_you(&copy, &task, &e.to_string(), &[]);
                    break;
                }
            };
            match merge_outcome {
                FoldOutcome::Clean { .. } => {
                    let check_cmd = crate::project_check::resolve_check(&self.data, &copy.root);
                    if let Some(cmd) = check_cmd {
                        if let Some(output) = crate::project_check::check_blames_copy(&copy.root, &copy.work, &cmd).await {
                            let msg = format!(
                                "The project check ({cmd}) fails with your changes but passes without them:\n{output}"
                            );
                            self.send_back(&copy, &task, "project check failed", msg, &[]).await;
                            break;
                        }
                    }
                    let copy_clone = copy.clone();
                    let apply_res = tokio::task::spawn_blocking(move || apply_copy_to_main(&copy_clone)).await;
                    match apply_res {
                        Ok(Ok(FoldOutcome::Clean { files: applied, .. })) => {
                            let mut finished = copy.clone();
                            finished.state = CopyState::Folded;
                            let _ = save_state(&self.data, &finished);
                            let data_clone = self.data.clone();
                            let copy_clone = copy.clone();
                            let _ = tokio::task::spawn_blocking(move || remove_copy(&data_clone, &copy_clone)).await;
                            for f in applied {
                                (task.event_sink)(RoomEvent::Changed {
                                    id: ParticipantId::new(&copy.bot),
                                    change: apex_core::FileChange::new(&f, ""),
                                });
                            }
                            break;
                        }
                        Ok(Ok(FoldOutcome::MainMoved)) => {
                            retries += 1;
                            if retries > 3 {
                                self.mark_needs_you(&copy, &task, "main folder kept moving", &[]);
                                break;
                            }
                            if let Err(e) = wait_for_quiet_main(&copy.root, self.quiet_duration).await {
                                self.mark_needs_you(&copy, &task, &e, &[]);
                                break;
                            }
                            continue;
                        }
                        Ok(Ok(FoldOutcome::Conflicts { files })) => {
                            let msg = format!(
                                "Your changes clash with work already in the main folder. Fix {} in your copy (conflict markers are in the files), then end your turn.",
                                files.join(", ")
                            );
                            self.send_back(&copy, &task, "merge conflicts", msg, &files).await;
                            break;
                        }
                        Ok(Err(e)) => {
                            self.mark_needs_you(&copy, &task, &e, &[]);
                            break;
                        }
                        Err(e) => {
                            self.mark_needs_you(&copy, &task, &e.to_string(), &[]);
                            break;
                        }
                    }
                }
                FoldOutcome::Conflicts { files } => {
                    let msg = format!(
                        "Your changes clash with work already in the main folder. Fix {} in your copy (conflict markers are in the files), then end your turn.",
                        files.join(", ")
                    );
                    self.send_back(&copy, &task, "merge conflicts", msg, &files).await;
                    break;
                }
                FoldOutcome::MainMoved => {
                    retries += 1;
                    if retries > 3 {
                        self.mark_needs_you(&copy, &task, "main folder kept moving", &[]);
                        break;
                    }
                    if let Err(e) = wait_for_quiet_main(&copy.root, self.quiet_duration).await {
                        self.mark_needs_you(&copy, &task, &e, &[]);
                        break;
                    }
                    continue;
                }
            }
        }
    }

    pub fn is_idle(&self) -> bool {
        let workers = self.workers.lock().unwrap();
        let queues = self.queues.lock().unwrap();
        workers.is_empty() && queues.values().all(|q| q.is_empty())
    }

    pub async fn wait_idle(&self) {
        while !self.is_idle() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }
}

pub struct BotCopies {
    data: PathBuf,
    thread: String,
    root: PathBuf,
    editor_handle: Arc<Mutex<Option<ParticipantId>>>,
    event_sink: Arc<dyn Fn(RoomEvent) + Send + Sync>,
    queue: Arc<FoldQueue>,
    active: Mutex<HashMap<ParticipantId, BotCopy>>,
    name_of: Option<Arc<dyn Fn(&ParticipantId) -> Option<String> + Send + Sync>>,
}

impl BotCopies {
    pub fn new(
        data: PathBuf,
        thread: String,
        root: PathBuf,
        editor_handle: Arc<Mutex<Option<ParticipantId>>>,
        event_sink: Arc<dyn Fn(RoomEvent) + Send + Sync>,
        queue: Arc<FoldQueue>,
    ) -> Self {
        Self {
            data,
            thread,
            root,
            editor_handle,
            event_sink,
            queue,
            active: Mutex::default(),
            name_of: None,
        }
    }

    /// Looks up a bot's display name for the notes a fold posts.
    pub fn with_names(mut self, name_of: Arc<dyn Fn(&ParticipantId) -> Option<String> + Send + Sync>) -> Self {
        self.name_of = Some(name_of);
        self
    }
}

impl CopyProvider for BotCopies {
    fn active_copy<'a>(&'a self, id: &'a ParticipantId) -> BoxFuture<'a, Option<PathBuf>> {
        Box::pin(async move {
            {
                let active = self.active.lock().unwrap();
                if let Some(c) = active.get(id) {
                    return Some(c.work.clone());
                }
            }
            let existing = {
                let copies = load_copies(&self.data);
                copies
                    .into_iter()
                    .find(|c| c.thread == self.thread && c.bot == id.as_str())
            };
            if let Some(copy) = existing {
                if matches!(
                    copy.state,
                    CopyState::Working | CopyState::Folding | CopyState::Reconciling { .. }
                ) {
                    self.active.lock().unwrap().insert(id.clone(), copy.clone());
                    return Some(copy.work);
                }
            }
            None
        })
    }

    fn copy_for<'a>(&'a self, id: &'a ParticipantId) -> BoxFuture<'a, Result<PathBuf, String>> {
        Box::pin(async move {
            {
                let active = self.active.lock().unwrap();
                if let Some(c) = active.get(id) {
                    return Ok(c.work.clone());
                }
            }
            let existing = {
                let copies = load_copies(&self.data);
                copies
                    .into_iter()
                    .find(|c| c.thread == self.thread && c.bot == id.as_str())
            };
            if let Some(copy) = existing {
                if matches!(
                    copy.state,
                    CopyState::Working | CopyState::Folding | CopyState::Reconciling { .. }
                ) {
                    self.active.lock().unwrap().insert(id.clone(), copy.clone());
                    return Ok(copy.work);
                }
            }
            let root = self.root.clone();
            let data = self.data.clone();
            let thread = self.thread.clone();
            let bot = id.as_str().to_string();
            let name = self.name_of.as_ref().and_then(|f| f(id));
            let copy = tokio::task::spawn_blocking(move || {
                let mut copy = create_copy(&root, &data, &thread, &bot)?;
                if name.is_some() {
                    copy.name = name;
                    save_state(&data, &copy)?;
                }
                Ok::<_, String>(copy)
            })
            .await
            .map_err(|e| e.to_string())??;
            self.active.lock().unwrap().insert(id.clone(), copy.clone());
            Ok(copy.work)
        })
    }

    fn turn_finished<'a>(&'a self, id: &'a ParticipantId, _cancelled: bool) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let copy = self.active.lock().unwrap().remove(id);
            if let Some(mut copy) = copy {
                if !matches!(copy.state, CopyState::Reconciling { .. }) {
                    copy.state = CopyState::Folding;
                    let _ = save_state(&self.data, &copy);
                }
                let task = FoldTask {
                    thread: self.thread.clone(),
                    copy,
                    editor_handle: Arc::clone(&self.editor_handle),
                    event_sink: Arc::clone(&self.event_sink),
                    reconcile: None,
                };
                self.queue.enqueue(task);
            }
        })
    }
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
    fn copy_works_when_project_has_ignored_node_modules_folder() {
        let (_tmp, root, data) = init_repo("nm-real-dir");
        fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        run(&["add", ".gitignore"]);
        run(&["commit", "-m", "ignore node_modules with slash"]);
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();

        let commit = snapshot_tree(&root).unwrap();
        let listing = run_git(&root, &[], &["ls-tree", "-r", "--name-only", &commit]).unwrap();
        assert!(!listing.lines().any(|l| l.starts_with("node_modules")), "{listing}");

        let copy = create_copy(&root, &data, "t1", "bot-a").unwrap();
        let shared = copy.work.join("node_modules");
        assert!(fs::read_link(&shared).is_ok(), "shared dependencies must be a link or junction");
        assert_eq!(fs::canonicalize(&shared).unwrap(), fs::canonicalize(root.join("node_modules")).unwrap());
        assert_eq!(fs::read_to_string(shared.join("pkg/index.js")).unwrap(), "x");
    }

    #[test]
    fn human_note_uses_name_and_never_doubles_the_full_stop() {
        assert_eq!(
            human_note_line("Beta", &[], "Folder contains several Git checkouts."),
            "Beta's changes couldn't be folded in (Folder contains several Git checkouts). Its copy is kept in the Worktrees tab."
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
    fn snapshot_rehashes_same_size_edits_when_the_index_is_racy_clean() {
        let (_tmp, root, _data) = init_repo("snapshot-racy-clean");
        run_git(&root, &[], &["config", "core.trustctime", "false"]).unwrap();
        run_git(&root, &[], &["config", "core.checkstat", "minimal"]).unwrap();
        let cached_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let set_modified = |path: &Path| {
            fs::OpenOptions::new().write(true).open(path).unwrap()
                .set_times(fs::FileTimes::new().set_modified(cached_time)).unwrap();
        };
        let file = root.join("seed.txt");
        fs::write(&file, "old\n").unwrap();
        set_modified(&file);
        run_git(&root, &[], &["add", "seed.txt"]).unwrap();
        run_git(&root, &[], &["commit", "-m", "cache old contents"]).unwrap();

        // Git must rehash this entry: its cached stat still matches, but the
        // original index timestamp marks it as potentially racy clean.
        fs::write(&file, "new\n").unwrap();
        set_modified(&file);
        let index = root.join(".git/index");
        set_modified(&index);
        let original_index = fs::read(&index).unwrap();
        let original_mtime = fs::metadata(&index).unwrap().modified().unwrap();

        let (commit, _) = snapshot_tree_and_id(&root).unwrap();
        let contents = run_git(&root, &[], &["show", &format!("{commit}:seed.txt")]).unwrap();
        assert_eq!(contents, "new", "the snapshot must include changed bytes");
        assert_eq!(fs::read(&index).unwrap(), original_index, "the real index bytes changed");
        assert_eq!(fs::metadata(&index).unwrap().modified().unwrap(), original_mtime, "the real index timestamp changed");
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
        let listed_worktree = wt_list.lines().find_map(|line| {
            let path = line.strip_prefix("worktree ")?;
            (fs::canonicalize(path).ok().as_ref() == Some(&work_canonical)).then_some(path)
        });
        assert!(
            listed_worktree.is_some(),
            "Worktree list does not contain work dir: {wt_list}"
        );
        assert!(wt_list.contains("locked"), "Worktree is not marked locked");

        // Verify work/node_modules is a symlink pointing to root/node_modules
        let work_nm = copy.work.join("node_modules");
        assert!(fs::read_link(&work_nm).is_ok(), "work/node_modules is not a link or junction");
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
    fn remove_locked_copy_succeeds_and_unregisters_worktree() {
        let (_tmp, root, data) = init_repo("remove-locked");
        let copy = create_copy(&root, &data, "thread-locked", "bot-locked").unwrap();
        // create_copy creates the worktree with --lock
        let out = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["worktree", "list", "--porcelain"])
            .output()
            .unwrap();
        let list_before = String::from_utf8_lossy(&out.stdout);
        assert!(list_before.contains("locked"), "Worktree should be listed as locked: {list_before}");

        remove_copy(&data, &copy).unwrap();

        let out = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["worktree", "list", "--porcelain"])
            .output()
            .unwrap();
        let list_after = String::from_utf8_lossy(&out.stdout);
        assert!(
            !list_after.contains("bot-locked"),
            "Worktree should no longer be registered in git: {list_after}"
        );
        assert!(!copy.work.exists(), "Worktree directory should be deleted");
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

    #[test]
    fn fold_different_files_clean() {
        let (_tmp, root, data) = init_repo("fold-diff");
        fs::write(root.join("a.txt"), "a content").unwrap();
        fs::write(root.join("b.txt"), "b content").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "add a and b"]);

        let copy = create_copy(&root, &data, "t-diff", "b-diff").unwrap();

        fs::write(copy.work.join("a.txt"), "a modified by bot").unwrap();
        fs::write(root.join("b.txt"), "b modified by human").unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        match outcome {
            FoldOutcome::Clean { files, .. } => {
                assert_eq!(files, vec!["a.txt".to_string()]);
            }
            other => panic!("Expected Clean, got {:?}", other),
        }

        let apply_outcome = apply_copy_to_main(&copy).unwrap();
        assert!(matches!(apply_outcome, FoldOutcome::Clean { .. }));

        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "a modified by bot");
        assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "b modified by human");
    }

    #[test]
    fn fold_same_file_different_lines_clean() {
        let (_tmp, root, data) = init_repo("fold-diff-lines");
        let initial = "line 1\nline 2\nline 3\nline 4\nline 5\n";
        fs::write(root.join("file.txt"), initial).unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "initial lines"]);

        let copy = create_copy(&root, &data, "t-lines", "b-lines").unwrap();

        fs::write(copy.work.join("file.txt"), "line 1 - bot\nline 2\nline 3\nline 4\nline 5\n").unwrap();
        fs::write(root.join("file.txt"), "line 1\nline 2\nline 3\nline 4\nline 5 - human\n").unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        assert!(matches!(outcome, FoldOutcome::Clean { .. }));

        let apply = apply_copy_to_main(&copy).unwrap();
        assert!(matches!(apply, FoldOutcome::Clean { .. }));

        let merged = fs::read_to_string(root.join("file.txt")).unwrap();
        assert!(merged.contains("line 1 - bot"));
        assert!(merged.contains("line 5 - human"));
    }

    #[test]
    fn fold_same_lines_conflict_leaves_markers_in_copy_only() {
        let (_tmp, root, data) = init_repo("fold-conflict");
        fs::write(root.join("file.txt"), "original line\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "base"]);

        let copy = create_copy(&root, &data, "t-conf", "b-conf").unwrap();

        fs::write(copy.work.join("file.txt"), "bot line\n").unwrap();
        fs::write(root.join("file.txt"), "human line\n").unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        match outcome {
            FoldOutcome::Conflicts { files } => {
                assert!(files.contains(&"file.txt".to_string()));
            }
            other => panic!("Expected Conflicts, got {:?}", other),
        }

        let copy_content = fs::read_to_string(copy.work.join("file.txt")).unwrap();
        assert!(copy_content.contains("<<<<<<< copy"));
        assert!(copy_content.contains(">>>>>>> main"));

        let root_content = fs::read_to_string(root.join("file.txt")).unwrap();
        assert_eq!(root_content, "human line\n");

        // The moved base is saved in the copy's own copy.json, not a stray folder.
        let saved = load_copies(&data).into_iter().find(|c| c.bot == "b-conf").unwrap();
        assert_ne!(saved.base, copy.base);
        assert!(!data.join("bot-copies").join("bot-copies").exists());
    }

    #[test]
    fn fold_edit_vs_delete_conflict() {
        let (_tmp, root, data) = init_repo("fold-edit-del");
        fs::write(root.join("file.txt"), "content\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "base"]);

        let copy = create_copy(&root, &data, "t-ed", "b-ed").unwrap();

        fs::write(copy.work.join("file.txt"), "edited by bot\n").unwrap();
        fs::remove_file(root.join("file.txt")).unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        match outcome {
            FoldOutcome::Conflicts { files } => {
                assert!(files.contains(&"file.txt".to_string()));
            }
            other => panic!("Expected Conflicts, got {:?}", other),
        }
    }

    #[test]
    fn fold_new_file_both_identical_clean() {
        let (_tmp, root, data) = init_repo("fold-same-new");
        let copy = create_copy(&root, &data, "t-ident", "b-ident").unwrap();

        fs::write(copy.work.join("new.txt"), "identical\n").unwrap();
        fs::write(root.join("new.txt"), "identical\n").unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        assert!(matches!(outcome, FoldOutcome::Clean { .. }));

        let apply = apply_copy_to_main(&copy).unwrap();
        assert!(matches!(apply, FoldOutcome::Clean { .. }));

        assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(), "identical\n");
    }

    #[test]
    fn fold_binary_both_changed_conflict() {
        let (_tmp, root, data) = init_repo("fold-bin");
        fs::write(root.join("data.bin"), [0u8, 1, 2, 0, 4]).unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "bin"]);

        let copy = create_copy(&root, &data, "t-bin", "b-bin").unwrap();

        fs::write(copy.work.join("data.bin"), [0u8, 1, 99, 0, 4]).unwrap();
        fs::write(root.join("data.bin"), [0u8, 1, 88, 0, 4]).unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        match outcome {
            FoldOutcome::Conflicts { files } => {
                assert!(files.contains(&"data.bin".to_string()));
            }
            other => panic!("Expected Conflicts, got {:?}", other),
        }
    }

    #[test]
    fn fold_keeps_human_edit_made_in_main_meanwhile() {
        let (_tmp, root, data) = init_repo("fold-human-keeps");
        fs::write(root.join("bot.txt"), "bot base\n").unwrap();
        fs::write(root.join("human.txt"), "human base\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "base"]);

        let copy = create_copy(&root, &data, "t-keep", "b-keep").unwrap();

        fs::write(copy.work.join("bot.txt"), "bot changed\n").unwrap();
        fs::write(root.join("human.txt"), "human changed\n").unwrap();
        fs::write(root.join("human2.txt"), "human added\n").unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        assert!(matches!(outcome, FoldOutcome::Clean { .. }));

        let apply = apply_copy_to_main(&copy).unwrap();
        assert!(matches!(apply, FoldOutcome::Clean { .. }));

        assert_eq!(fs::read_to_string(root.join("bot.txt")).unwrap(), "bot changed\n");
        assert_eq!(fs::read_to_string(root.join("human.txt")).unwrap(), "human changed\n");
        assert_eq!(fs::read_to_string(root.join("human2.txt")).unwrap(), "human added\n");
    }

    #[test]
    fn fold_after_bot_commits_and_switches_branch_in_copy() {
        let (_tmp, root, data) = init_repo("fold-branch");
        let copy = create_copy(&root, &data, "t-br", "b-br").unwrap();

        let run_copy = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&copy.work).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run_copy(&["checkout", "-b", "bot-branch"]);
        fs::write(copy.work.join("feature.txt"), "feature by bot\n").unwrap();
        run_copy(&["add", "."]);
        run_copy(&["commit", "-m", "bot feature commit"]);

        let outcome = merge_main_into_copy(&copy).unwrap();
        assert!(matches!(outcome, FoldOutcome::Clean { .. }));

        let apply = apply_copy_to_main(&copy).unwrap();
        assert!(matches!(apply, FoldOutcome::Clean { .. }));

        let current_branch = run_git(&root, &[], &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(current_branch, "main");
        assert_eq!(fs::read_to_string(root.join("feature.txt")).unwrap(), "feature by bot\n");
    }

    #[test]
    fn fold_reports_ignored_files_not_copied() {
        let (_tmp, root, data) = init_repo("fold-ignored");
        fs::write(root.join(".gitignore"), ".env\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "add gitignore"]);

        let copy = create_copy(&root, &data, "t-ign", "b-ign").unwrap();

        fs::write(copy.work.join(".env"), "SECRET=true\n").unwrap();
        fs::write(copy.work.join("allowed.txt"), "allowed\n").unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        match outcome {
            FoldOutcome::Clean { ignored_skipped, .. } => {
                assert!(ignored_skipped.contains(&".env".to_string()));
            }
            other => panic!("Expected Clean, got {:?}", other),
        }

        let apply = apply_copy_to_main(&copy).unwrap();
        match apply {
            FoldOutcome::Clean { ignored_skipped, .. } => {
                assert!(ignored_skipped.contains(&".env".to_string()));
            }
            other => panic!("Expected Clean, got {:?}", other),
        }

        assert!(!root.join(".env").exists(), ".env was unexpectedly copied to root");
        assert_eq!(fs::read_to_string(root.join("allowed.txt")).unwrap(), "allowed\n");
    }

    #[test]
    fn apply_returns_main_moved_when_main_changed_after_merge() {
        let (_tmp, root, data) = init_repo("fold-main-moved");
        let copy = create_copy(&root, &data, "t-mov", "b-mov").unwrap();

        fs::write(copy.work.join("bot.txt"), "bot edit\n").unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        assert!(matches!(outcome, FoldOutcome::Clean { .. }));

        // Main moves after merge
        fs::write(root.join("new_main.txt"), "main edit\n").unwrap();

        let apply = apply_copy_to_main(&copy).unwrap();
        assert_eq!(apply, FoldOutcome::MainMoved);
    }

    #[test]
    fn apply_touches_only_changed_paths() {
        let (_tmp, root, data) = init_repo("fold-mtime");
        fs::write(root.join("untouched.txt"), "untouched\n").unwrap();
        fs::write(root.join("changed.txt"), "orig\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "init"]);

        let mtime_before = fs::metadata(root.join("untouched.txt")).unwrap().modified().unwrap();

        let copy = create_copy(&root, &data, "t-mtime", "b-mtime").unwrap();

        std::thread::sleep(std::time::Duration::from_millis(50));
        fs::write(copy.work.join("changed.txt"), "changed\n").unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        assert!(matches!(outcome, FoldOutcome::Clean { .. }));

        let apply = apply_copy_to_main(&copy).unwrap();
        assert!(matches!(apply, FoldOutcome::Clean { .. }));

        let mtime_after = fs::metadata(root.join("untouched.txt")).unwrap().modified().unwrap();
        assert_eq!(mtime_before, mtime_after, "untouched.txt mtime changed");
        assert_eq!(fs::read_to_string(root.join("changed.txt")).unwrap(), "changed\n");
    }

    #[test]
    fn fold_never_writes_over_shared_paths() {
        let (_tmp, root, data) = init_repo("fold-shared-nm");
        let pkg_dir = root.join("node_modules");
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(pkg_dir.join("pkg.txt"), "root pkg\n").unwrap();

        let copy = create_copy(&root, &data, "t-nm", "b-nm").unwrap();
        assert!(fs::read_link(copy.work.join("node_modules")).is_ok());

        fs::write(copy.work.join("file.txt"), "normal file\n").unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        assert!(matches!(outcome, FoldOutcome::Clean { .. }));

        let apply = apply_copy_to_main(&copy).unwrap();
        assert!(matches!(apply, FoldOutcome::Clean { .. }));

        assert!(root.join("node_modules").is_dir());
        assert!(!root.join("node_modules").is_symlink());
        assert_eq!(
            fs::read_to_string(root.join("node_modules").join("pkg.txt")).unwrap(),
            "root pkg\n"
        );
    }

    #[test]
    fn fold_handles_unusual_file_names() {
        let (_tmp, root, data) = init_repo("fold-unusual-names");
        let copy = create_copy(&root, &data, "t-unusual", "b-unusual").unwrap();

        fs::write(copy.work.join("café.txt"), "cafe content\n").unwrap();
        fs::write(copy.work.join(" lead.txt"), "lead content\n").unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        match outcome {
            FoldOutcome::Clean { files, .. } => {
                assert!(files.contains(&"café.txt".to_string()));
                assert!(files.contains(&" lead.txt".to_string()));
            }
            other => panic!("Expected Clean, got {:?}", other),
        }

        let apply = apply_copy_to_main(&copy).unwrap();
        assert!(matches!(apply, FoldOutcome::Clean { .. }));

        assert_eq!(
            fs::read_to_string(root.join("café.txt")).unwrap(),
            "cafe content\n"
        );
        assert_eq!(
            fs::read_to_string(root.join(" lead.txt")).unwrap(),
            "lead content\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn fold_keeps_symlinks_as_links() {
        let (_tmp, root, data) = init_repo("fold-symlinks");
        let copy = create_copy(&root, &data, "t-symlink", "b-symlink").unwrap();

        fs::write(copy.work.join("real.txt"), "real file content\n").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(Path::new("real.txt"), copy.work.join("link_working.txt"))
                .unwrap();
            std::os::unix::fs::symlink(
                Path::new("non_existent.txt"),
                copy.work.join("link_dangling.txt"),
            )
            .unwrap();
        }

        let outcome = merge_main_into_copy(&copy).unwrap();
        assert!(matches!(outcome, FoldOutcome::Clean { .. }));

        let apply = apply_copy_to_main(&copy).unwrap();
        assert!(matches!(apply, FoldOutcome::Clean { .. }));

        let link_working = root.join("link_working.txt");
        let link_dangling = root.join("link_dangling.txt");

        assert!(
            link_working.is_symlink(),
            "working link in root is not a symlink"
        );
        assert!(
            link_dangling.is_symlink(),
            "dangling link in root is not a symlink"
        );
        assert_eq!(
            fs::read_link(&link_working).unwrap(),
            PathBuf::from("real.txt")
        );
        assert_eq!(
            fs::read_link(&link_dangling).unwrap(),
            PathBuf::from("non_existent.txt")
        );
    }

    fn stage_directory_link_without_symlink_privileges(repo: &Path) {
        run_git(repo, &[], &["config", "core.symlinks", "false"]).unwrap();
        fs::write(repo.join("z-link"), "target-dir").unwrap();
        let blob = run_git(repo, &[], &["hash-object", "-w", "--", "z-link"]).unwrap();
        run_git(repo, &[], &["update-index", "--add", "--cacheinfo", "120000", &blob, "z-link"]).unwrap();
        let snapshot = snapshot_tree(repo).unwrap();
        let entry = run_git(repo, &[], &["ls-tree", &snapshot, "--", "z-link"]).unwrap();
        assert!(entry.starts_with("120000 "), "fixture lost symlink mode: {entry}");
    }

    #[test]
    fn snapshots_preserve_git_symlink_mode_without_os_symlink_privileges() {
        let (_tmp, root, _data) = init_repo("link-index-mode");
        fs::create_dir(root.join("target-dir")).unwrap();
        stage_directory_link_without_symlink_privileges(&root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_merge_refuses_directory_links_before_replacing_any_files() {
        let (_tmp, root, data) = init_repo("merge-directory-link");
        fs::create_dir(root.join("target-dir")).unwrap();
        fs::write(root.join("target-dir/payload.txt"), "target payload").unwrap();
        fs::write(root.join("z-link"), "existing file").unwrap();
        fs::write(root.join("a.txt"), "before").unwrap();
        let copy = create_copy(&root, &data, "thread", "bot").unwrap();
        fs::write(root.join("a.txt"), "after").unwrap();
        stage_directory_link_without_symlink_privileges(&root);

        let error = merge_main_into_copy(&copy).unwrap_err();
        assert!(error.contains("symlink materialization is not supported on Windows"), "{error}");
        assert_eq!(fs::read(copy.work.join("z-link")).unwrap(), b"existing file");
        assert_eq!(fs::read(copy.work.join("a.txt")).unwrap(), b"before");
        assert_eq!(fs::read(copy.work.join("target-dir/payload.txt")).unwrap(), b"target payload");
    }

    #[cfg(windows)]
    #[test]
    fn windows_apply_refuses_directory_links_before_replacing_any_files() {
        let (_tmp, root, data) = init_repo("apply-directory-link");
        fs::create_dir(root.join("target-dir")).unwrap();
        fs::write(root.join("target-dir/payload.txt"), "target payload").unwrap();
        fs::write(root.join("z-link"), "existing file").unwrap();
        fs::write(root.join("a.txt"), "before").unwrap();
        let copy = create_copy(&root, &data, "thread", "bot").unwrap();
        fs::write(copy.work.join("a.txt"), "after").unwrap();
        stage_directory_link_without_symlink_privileges(&copy.work);

        let error = apply_copy_to_main(&copy).unwrap_err();
        assert!(error.contains("symlink materialization is not supported on Windows"), "{error}");
        assert_eq!(fs::read(root.join("z-link")).unwrap(), b"existing file");
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"before");
        assert_eq!(fs::read(root.join("target-dir/payload.txt")).unwrap(), b"target payload");
    }

    #[cfg(unix)]
    #[test]
    fn fold_never_writes_through_a_symlink_both_sides_changed() {
        let (tmp, root, data) = init_repo("fold-link-both");
        let outside_a = tmp.path().join("outside-a.txt");
        let outside_b = tmp.path().join("outside-b.txt");
        fs::write(&outside_a, "outside a\n").unwrap();
        fs::write(&outside_b, "outside b\n").unwrap();
        std::os::unix::fs::symlink(&outside_a, root.join("link")).unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "link"]);

        let copy = create_copy(&root, &data, "t-link-both", "b-link-both").unwrap();
        fs::remove_file(copy.work.join("link")).unwrap();
        std::os::unix::fs::symlink(&outside_b, copy.work.join("link")).unwrap();
        fs::remove_file(root.join("link")).unwrap();
        std::os::unix::fs::symlink(Path::new("elsewhere"), root.join("link")).unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        match outcome {
            FoldOutcome::Conflicts { files } => assert_eq!(files, vec!["link".to_string()]),
            other => panic!("Expected Conflicts, got {:?}", other),
        }
        assert_eq!(fs::read_to_string(&outside_a).unwrap(), "outside a\n");
        assert_eq!(fs::read_to_string(&outside_b).unwrap(), "outside b\n");
        assert_eq!(fs::read_link(copy.work.join("link")).unwrap(), outside_b);
        assert_eq!(fs::read_link(root.join("link")).unwrap(), PathBuf::from("elsewhere"));
    }

    #[cfg(unix)]
    #[test]
    fn fold_treats_file_type_change_as_conflict() {
        let (tmp, root, data) = init_repo("fold-type-change");
        let outside = tmp.path().join("outside.txt");
        fs::write(&outside, "outside\n").unwrap();
        fs::write(root.join("f.txt"), "one\ntwo\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "file"]);

        let copy = create_copy(&root, &data, "t-type", "b-type").unwrap();
        fs::remove_file(copy.work.join("f.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, copy.work.join("f.txt")).unwrap();
        fs::write(root.join("f.txt"), "one\ntwo changed\n").unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        match outcome {
            FoldOutcome::Conflicts { files } => assert_eq!(files, vec!["f.txt".to_string()]),
            other => panic!("Expected Conflicts, got {:?}", other),
        }
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside\n");
        assert_eq!(fs::read_link(copy.work.join("f.txt")).unwrap(), outside);
        assert_eq!(fs::read_to_string(root.join("f.txt")).unwrap(), "one\ntwo changed\n");
    }

    #[tokio::test]
    async fn two_writers_same_thread_both_land_in_main() {
        let (_tmp, root, data) = init_repo("two-writers-land");
        let fold_queue = Arc::new(FoldQueue::new(data.clone()));

        struct FileWriterBot {
            id: ParticipantId,
            root: PathBuf,
            file: String,
            content: String,
        }
        #[async_trait::async_trait]
        impl apex_core::Participant for FileWriterBot {
            fn config(&self) -> &apex_core::ParticipantConfig {
                Box::leak(Box::new(apex_core::ParticipantConfig {
                    id: self.id.clone(),
                    display_name: self.id.as_str().to_string(),
                    backend: apex_core::Backend::Scripted { lines: vec![] },
                    persona: String::new(),
                    access: apex_core::Access::Full,
                    effort: None,
                    speed: None,
                    voice: None,
                    appearance: None,
                    media: None,
                }))
            }
            async fn respond(
                &self,
                request: apex_core::TurnRequest,
                _: apex_core::DeltaSink<'_>,
            ) -> Result<apex_core::Reply, apex_core::ParticipantError> {
                let write_dir = request.cwd.unwrap_or_else(|| self.root.clone());
                fs::write(write_dir.join(&self.file), &self.content).unwrap();
                Ok(apex_core::Reply::text("done"))
            }
        }

        struct HoldFirstUntilSecondStarts {
            tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
            rx: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
        }
        impl apex_core::TurnStartHook for HoldFirstUntilSecondStarts {
            fn before_turn<'a>(&'a self, id: &'a ParticipantId) -> futures::future::BoxFuture<'a, ()> {
                Box::pin(async move {
                    if id.as_str() == "A" {
                        let rx = self.rx.lock().unwrap().take();
                        if let Some(rx) = rx {
                            let _ = rx.await;
                        }
                    } else if id.as_str() == "B" {
                        let tx = self.tx.lock().unwrap().take();
                        if let Some(tx) = tx {
                            let _ = tx.send(());
                        }
                    }
                })
            }
        }

        let (tx, rx) = tokio::sync::oneshot::channel();
        let bot_a = Arc::new(FileWriterBot {
            id: ParticipantId::new("A"),
            root: root.clone(),
            file: "a.txt".into(),
            content: "content a from bot A\n".into(),
        });
        let bot_b = Arc::new(FileWriterBot {
            id: ParticipantId::new("B"),
            root: root.clone(),
            file: "b.txt".into(),
            content: "content b from bot B\n".into(),
        });

        let room = apex_core::Room::new(
            vec![bot_a, bot_b],
            apex_core::RoomOptions { policy: apex_core::TurnPolicy::Everyone, max_bot_hops: Some(0) },
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let sink = Arc::new(move |event| sink_events.lock().unwrap().push(event));

        let mut concurrent = apex_core::ConcurrentRoom::new(room)
            .with_turn_start(Arc::new(HoldFirstUntilSecondStarts {
                tx: Mutex::new(Some(tx)),
                rx: Mutex::new(Some(rx)),
            }));
        let bot_copies = Arc::new(BotCopies::new(
            data.clone(),
            "thread-two-writers".into(),
            root.clone(),
            concurrent.editor_handle(),
            sink.clone(),
            Arc::clone(&fold_queue),
        ));
        concurrent = concurrent.with_copies(bot_copies);

        let s = move |e| (sink)(e);
        let batch = concurrent.begin_post("start", None, &s).await.unwrap();
        concurrent.run(batch, &s).await;

        fold_queue.wait_idle().await;

        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "content a from bot A\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("b.txt")).unwrap(),
            "content b from bot B\n"
        );
        assert!(load_copies(&data).is_empty(), "Copy was not removed after fold");
    }

    #[tokio::test]
    async fn fold_waits_for_main_editor_to_finish() {
        let (_tmp, root, data) = init_repo("fold-waits-editor");
        let fold_queue = Arc::new(FoldQueue::new(data.clone()));

        let (a_hold_tx, a_hold_rx) = tokio::sync::oneshot::channel();
        let a_hold_rx = Arc::new(tokio::sync::Mutex::new(Some(a_hold_rx)));

        let (b_started_tx, b_started_rx) = tokio::sync::oneshot::channel();
        let b_started_tx = Arc::new(Mutex::new(Some(b_started_tx)));

        struct WaitingBotA {
            rx: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>>,
        }
        #[async_trait::async_trait]
        impl apex_core::Participant for WaitingBotA {
            fn config(&self) -> &apex_core::ParticipantConfig {
                Box::leak(Box::new(apex_core::ParticipantConfig {
                    id: ParticipantId::new("A"),
                    display_name: "A".into(),
                    backend: apex_core::Backend::Scripted { lines: vec![] },
                    persona: String::new(),
                    access: apex_core::Access::Full,
                    effort: None,
                    speed: None,
                    voice: None,
                    appearance: None,
                    media: None,
                }))
            }
            async fn respond(
                &self,
                _: apex_core::TurnRequest,
                _: apex_core::DeltaSink<'_>,
            ) -> Result<apex_core::Reply, apex_core::ParticipantError> {
                let rx = self.rx.lock().await.take();
                if let Some(rx) = rx {
                    let _ = rx.await;
                }
                Ok(apex_core::Reply::text("done A"))
            }
        }

        struct FastBotB {
            file: String,
            content: String,
            started: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
        }
        #[async_trait::async_trait]
        impl apex_core::Participant for FastBotB {
            fn config(&self) -> &apex_core::ParticipantConfig {
                Box::leak(Box::new(apex_core::ParticipantConfig {
                    id: ParticipantId::new("B"),
                    display_name: "B".into(),
                    backend: apex_core::Backend::Scripted { lines: vec![] },
                    persona: String::new(),
                    access: apex_core::Access::Full,
                    effort: None,
                    speed: None,
                    voice: None,
                    appearance: None,
                    media: None,
                }))
            }
            async fn respond(
                &self,
                request: apex_core::TurnRequest,
                _: apex_core::DeltaSink<'_>,
            ) -> Result<apex_core::Reply, apex_core::ParticipantError> {
                let write_dir = request.cwd.expect("B should have received a copy cwd");
                fs::write(write_dir.join(&self.file), &self.content).unwrap();
                let started = self.started.lock().unwrap().take();
                if let Some(tx) = started {
                    let _ = tx.send(());
                }
                Ok(apex_core::Reply::text("done B"))
            }
        }

        let bot_a = Arc::new(WaitingBotA { rx: a_hold_rx });
        let bot_b = Arc::new(FastBotB {
            file: "b_folded.txt".into(),
            content: "folded content\n".into(),
            started: b_started_tx,
        });

        let room = apex_core::Room::new(
            vec![bot_a, bot_b],
            apex_core::RoomOptions { policy: apex_core::TurnPolicy::Everyone, max_bot_hops: Some(0) },
        );
        let sink = Arc::new(|_| {});
        let mut concurrent = apex_core::ConcurrentRoom::new(room);
        let bot_copies = Arc::new(BotCopies::new(
            data.clone(),
            "thread-waits".into(),
            root.clone(),
            concurrent.editor_handle(),
            sink.clone(),
            Arc::clone(&fold_queue),
        ));
        concurrent = concurrent.with_copies(bot_copies);

        let s = move |e| (sink)(e);
        let batch = concurrent.begin_post("start", None, &s).await.unwrap();
        let handle = tokio::spawn(async move {
            concurrent.run(batch, &s).await;
        });

        // Wait until B has finished writing its file and ended its turn
        let _ = b_started_rx.await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // While A is still holding the editor, B's fold should not have applied to main yet
        assert!(
            !root.join("b_folded.txt").exists(),
            "B's file was applied to main before A released the editor slot"
        );

        // Now release A so it finishes its turn and releases the editor slot
        let _ = a_hold_tx.send(());
        let _ = handle.await;

        fold_queue.wait_idle().await;

        // Now B's fold must have been applied to main
        assert!(
            root.join("b_folded.txt").exists(),
            "B's file was not applied after editor was released"
        );
        assert_eq!(
            fs::read_to_string(root.join("b_folded.txt")).unwrap(),
            "folded content\n"
        );
    }

    #[tokio::test]
    async fn fold_error_marks_needs_you_and_tells_the_chat() {
        let (_tmp, root, data) = init_repo("fold-err");
        let copy = create_copy(&root, &data, "t1", "bot1").unwrap();
        // Make merge fail by deleting the worktree directory
        fs::remove_dir_all(&copy.work).unwrap();

        let fold_queue = Arc::new(FoldQueue::new(data.clone()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let ev_sink = {
            let ev = Arc::clone(&events);
            Arc::new(move |e| ev.lock().unwrap().push(e))
        };
        let task = FoldTask {
            thread: "t1".into(),
            copy: copy.clone(),
            editor_handle: Arc::new(Mutex::new(None)),
            event_sink: ev_sink,
            reconcile: None,
        };
        fold_queue.enqueue(task);
        fold_queue.wait_idle().await;

        let copies = load_copies(&data);
        assert_eq!(copies.len(), 1);
        match &copies[0].state {
            CopyState::NeedsYou { reason } => {
                assert!(!reason.is_empty(), "reason should not be empty");
            }
            s => panic!("expected NeedsYou state, got {:?}", s),
        }

        let evs = events.lock().unwrap();
        let note = evs.iter().find(|e| matches!(e, RoomEvent::MessageAdded { .. }));
        assert!(note.is_some(), "chat line was not posted");
        if let Some(RoomEvent::MessageAdded { message }) = note {
            assert!(message.text.contains("bot1"));
            assert!(message.text.contains("Worktrees tab"));
        }
    }

    #[tokio::test]
    async fn fold_retries_after_main_goes_quiet() {
        let (_tmp, root, data) = init_repo("fold-quiet");
        let copy = create_copy(&root, &data, "t-quiet", "bot-q").unwrap();
        fs::write(copy.work.join("from_copy.txt"), "copy content").unwrap();

        // Spawn a background task that keeps writing to main's seed.txt every 100ms for ~1s
        let root_bg = root.clone();
        let bg_handle = tokio::spawn(async move {
            for i in 0..10 {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                fs::write(root_bg.join("seed.txt"), format!("bg edit {i}\n")).unwrap();
            }
        });

        // Use a fold queue with quiet duration 500ms so the test runs promptly
        let fold_queue = Arc::new(
            FoldQueue::new(data.clone()).with_quiet_duration(std::time::Duration::from_millis(500)),
        );
        let task = FoldTask {
            thread: "t-quiet".into(),
            copy,
            editor_handle: Arc::new(Mutex::new(None)),
            event_sink: Arc::new(|_| {}),
            reconcile: None,
        };
        fold_queue.enqueue(task);

        let _ = bg_handle.await;
        fold_queue.wait_idle().await;

        assert!(
            root.join("from_copy.txt").exists(),
            "from_copy.txt was not folded into main"
        );
        assert_eq!(
            fs::read_to_string(root.join("from_copy.txt")).unwrap(),
            "copy content"
        );
        let seed = fs::read_to_string(root.join("seed.txt")).unwrap();
        assert!(seed.starts_with("bg edit"), "human edit in seed.txt was lost");
    }

    #[tokio::test]
    async fn clash_starts_reconcile_turn_for_second_bot_only() {
        let (_tmp, root, data) = init_repo("clash-reconcile");
        fs::write(root.join("seed.txt"), "line 1\nline 2\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "seed.txt"]);
        run(&["commit", "-m", "seed base"]);

        let copy = create_copy(&root, &data, "thread-clash", "bot2").unwrap();
        fs::write(copy.work.join("seed.txt"), "line 1 bot2\nline 2\n").unwrap();

        // Main is modified concurrently
        fs::write(root.join("seed.txt"), "line 1 human\nline 2\n").unwrap();

        let reconcile_calls = Arc::new(Mutex::new(Vec::new()));
        let reconcile_mock: ReconcileStarter = {
            let calls = Arc::clone(&reconcile_calls);
            Arc::new(move |thread, bot, msg| {
                let calls = Arc::clone(&calls);
                Box::pin(async move {
                    calls.lock().unwrap().push((thread, bot, msg));
                    Ok(())
                })
            })
        };

        let fold_queue = Arc::new(FoldQueue::new(data.clone()));
        let task = FoldTask {
            thread: "thread-clash".into(),
            copy: copy.clone(),
            editor_handle: Arc::new(Mutex::new(None)),
            event_sink: Arc::new(|_| {}),
            reconcile: Some(reconcile_mock),
        };
        fold_queue.enqueue(task);
        fold_queue.wait_idle().await;

        let calls = reconcile_calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "reconcile should be started once");
        assert_eq!(calls[0].0, "thread-clash");
        assert_eq!(calls[0].1.as_str(), "bot2");
        assert!(calls[0].2.contains("Your changes clash with work already in the main folder. Fix seed.txt in your copy (conflict markers are in the files), then end your turn."));

        let copies = load_copies(&data);
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].state, CopyState::Reconciling { attempt: 1, files: vec!["seed.txt".to_string()] });
        // Markers left in the copy only
        let copy_seed = fs::read_to_string(copy.work.join("seed.txt")).unwrap();
        assert!(copy_seed.contains("<<<<<<<"), "copy should have conflict markers");
        let main_seed = fs::read_to_string(root.join("seed.txt")).unwrap();
        assert_eq!(main_seed, "line 1 human\nline 2\n", "main should remain untouched");
    }

    #[tokio::test]
    async fn reconciled_copy_folds_on_retry() {
        let (_tmp, root, data) = init_repo("clash-fix-retry");
        fs::write(root.join("seed.txt"), "line 1\nline 2\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "seed.txt"]);
        run(&["commit", "-m", "seed base"]);

        let copy = create_copy(&root, &data, "t-fix", "bot-fix").unwrap();
        fs::write(copy.work.join("seed.txt"), "line 1 bot\nline 2\n").unwrap();
        fs::write(root.join("seed.txt"), "line 1 human\nline 2\n").unwrap();

        let fold_queue = Arc::new(FoldQueue::new(data.clone()));
        let queue_clone = Arc::clone(&fold_queue);
        let copy_work = copy.work.clone();
        let data_clone = data.clone();
        let reconcile_starter: ReconcileStarter = Arc::new(move |thread, bot, _msg| {
            let copy_work = copy_work.clone();
            let data_clone = data_clone.clone();
            let queue = Arc::clone(&queue_clone);
            Box::pin(async move {
                // Bot resolves the conflict in copy
                fs::write(copy_work.join("seed.txt"), "line 1 resolved\nline 2\n").unwrap();
                let mut c = load_copies(&data_clone).into_iter().find(|c| c.thread == thread && c.bot == bot.as_str()).unwrap();
                c.state = CopyState::Folding;
                save_state(&data_clone, &c).unwrap();
                queue.enqueue(FoldTask {
                    thread,
                    copy: c,
                    editor_handle: Arc::new(Mutex::new(None)),
                    event_sink: Arc::new(|_| {}),
                    reconcile: None,
                });
                Ok(())
            })
        });

        fold_queue.enqueue(FoldTask {
            thread: "t-fix".into(),
            copy,
            editor_handle: Arc::new(Mutex::new(None)),
            event_sink: Arc::new(|_| {}),
            reconcile: Some(reconcile_starter),
        });
        fold_queue.wait_idle().await;

        let main_seed = fs::read_to_string(root.join("seed.txt")).unwrap();
        assert_eq!(main_seed, "line 1 resolved\nline 2\n");
        assert!(load_copies(&data).is_empty(), "clean fold removes the copy");
    }

    #[tokio::test]
    async fn two_failed_reconciles_post_one_note_and_keep_copy() {
        let (_tmp, root, data) = init_repo("clash-two-failed");
        fs::write(root.join("seed.txt"), "line 1\nline 2\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "seed.txt"]);
        run(&["commit", "-m", "seed base"]);

        let copy = create_copy(&root, &data, "t-fail2", "bot-fail").unwrap();
        fs::write(copy.work.join("seed.txt"), "line 1 bot\nline 2\n").unwrap();
        fs::write(root.join("seed.txt"), "line 1 human\nline 2\n").unwrap();

        let fold_queue = Arc::new(FoldQueue::new(data.clone()));
        let queue_clone = Arc::clone(&fold_queue);
        let data_clone = data.clone();
        let attempts_seen = Arc::new(Mutex::new(0));
        let attempts_cb = Arc::clone(&attempts_seen);

        let events = Arc::new(Mutex::new(Vec::new()));
        let ev_sink = {
            let ev = Arc::clone(&events);
            Arc::new(move |e| ev.lock().unwrap().push(e))
        };
        let ev_sink_cb = Arc::clone(&ev_sink);

        let reconcile_starter: ReconcileStarter = Arc::new(move |thread, bot, _msg| {
            let data_clone = data_clone.clone();
            let queue = Arc::clone(&queue_clone);
            let attempts_cb = Arc::clone(&attempts_cb);
            let ev_sink = Arc::clone(&ev_sink_cb);
            Box::pin(async move {
                *attempts_cb.lock().unwrap() += 1;
                // Bot does NOT fix the conflict, just re-queues turn finished
                let c = load_copies(&data_clone).into_iter().find(|c| c.thread == thread && c.bot == bot.as_str()).unwrap();
                queue.enqueue(FoldTask {
                    thread,
                    copy: c,
                    editor_handle: Arc::new(Mutex::new(None)),
                    event_sink: ev_sink,
                    reconcile: None,
                });
                Ok(())
            })
        });
        fold_queue.set_reconcile(reconcile_starter);

        fold_queue.enqueue(FoldTask {
            thread: "t-fail2".into(),
            copy: copy.clone(),
            editor_handle: Arc::new(Mutex::new(None)),
            event_sink: ev_sink,
            reconcile: None,
        });
        fold_queue.wait_idle().await;

        assert_eq!(*attempts_seen.lock().unwrap(), 2, "reconcile should run exactly twice");

        let copies = load_copies(&data);
        assert_eq!(copies.len(), 1, "copy must be kept");
        match &copies[0].state {
            CopyState::NeedsYou { reason } => {
                assert_eq!(reason, "merge conflicts");
            }
            s => panic!("expected NeedsYou state, got {:?}", s),
        }
        assert!(copy.work.exists(), "copy work folder must still exist");

        let evs = events.lock().unwrap();
        let notes: Vec<_> = evs.iter().filter(|e| matches!(e, RoomEvent::MessageAdded { .. })).collect();
        assert_eq!(notes.len(), 1, "exactly one human note must be posted");
        if let RoomEvent::MessageAdded { message } = notes[0] {
            assert_eq!(
                message.text,
                "bot-fail's changes to seed.txt couldn't be folded in (merge conflicts). Its copy is kept in the Worktrees tab."
            );
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn check_failure_keeps_copy_posts_one_note_and_stops_repairing() {
        let (_tmp, root, data) = init_repo("fold-check-fail");
        // A saved check that passes in the main folder and fails once the bot's file is in its copy.
        crate::project_check::save_check(&data, &root, Some("test ! -e broken.flag".into()))
            .unwrap();

        let mut copy = create_copy(&root, &data, "t-check", "null").unwrap();
        copy.name = Some("Null".into());
        fs::write(
            copy.work.join("broken.flag"),
            "the change that breaks the check",
        )
        .unwrap();

        let fold_queue = Arc::new(FoldQueue::new(data.clone()));
        let queue_clone = Arc::clone(&fold_queue);
        let data_clone = data.clone();
        let attempts_seen = Arc::new(Mutex::new(0));
        let attempts_cb = Arc::clone(&attempts_seen);

        let events = Arc::new(Mutex::new(Vec::new()));
        let ev_sink = {
            let ev = Arc::clone(&events);
            Arc::new(move |e| ev.lock().unwrap().push(e))
        };
        let ev_sink_cb = Arc::clone(&ev_sink);

        let reconcile_starter: ReconcileStarter = Arc::new(move |thread, bot, _msg| {
            let data_clone = data_clone.clone();
            let queue = Arc::clone(&queue_clone);
            let attempts_cb = Arc::clone(&attempts_cb);
            let ev_sink = Arc::clone(&ev_sink_cb);
            Box::pin(async move {
                *attempts_cb.lock().unwrap() += 1;
                // The bot answers without fixing the check, so the fold is attempted again.
                let c = load_copies(&data_clone)
                    .into_iter()
                    .find(|c| c.thread == thread && c.bot == bot.as_str())
                    .unwrap();
                queue.enqueue(FoldTask {
                    thread,
                    copy: c,
                    editor_handle: Arc::new(Mutex::new(None)),
                    event_sink: ev_sink,
                    reconcile: None,
                });
                Ok(())
            })
        });
        fold_queue.set_reconcile(reconcile_starter);

        fold_queue.enqueue(FoldTask {
            thread: "t-check".into(),
            copy: copy.clone(),
            editor_handle: Arc::new(Mutex::new(None)),
            event_sink: ev_sink,
            reconcile: None,
        });
        fold_queue.wait_idle().await;

        assert_eq!(
            *attempts_seen.lock().unwrap(),
            2,
            "a failing check is sent back twice, then kept"
        );

        let copies = load_copies(&data);
        assert_eq!(copies.len(), 1, "the copy is kept so its work is not lost");
        match &copies[0].state {
            CopyState::NeedsYou { reason } => assert_eq!(reason, "project check failed"),
            s => panic!("expected NeedsYou state, got {s:?}"),
        }
        assert!(copy.work.exists(), "the kept copy stays on disk");
        assert!(
            !root.join("broken.flag").exists(),
            "a change that fails the check must not be folded into main"
        );

        let evs = events.lock().unwrap();
        let notes: Vec<_> = evs
            .iter()
            .filter_map(|e| match e {
                RoomEvent::MessageAdded { message } => Some(message.text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            notes,
            vec![
                "Null's changes couldn't be folded in (project check failed). Its copy is kept in the Worktrees tab."
                    .to_string()
            ],
            "exactly one Deck note names the check as the reason"
        );
    }

    #[tokio::test]
    async fn clean_fold_is_quiet_and_removes_the_copy() {
        let (_tmp, root, data) = init_repo("fold-silent");
        // Checks keep running with no setup: a passing saved check folds straight through.
        crate::project_check::save_check(&data, &root, Some("git status".into())).unwrap();

        let copy = create_copy(&root, &data, "t-silent", "bot-silent").unwrap();
        fs::write(copy.work.join("from_copy.txt"), "copy content").unwrap();

        let fold_queue = Arc::new(FoldQueue::new(data.clone()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let ev_sink = {
            let ev = Arc::clone(&events);
            Arc::new(move |e| ev.lock().unwrap().push(e))
        };
        fold_queue.enqueue(FoldTask {
            thread: "t-silent".into(),
            copy: copy.clone(),
            editor_handle: Arc::new(Mutex::new(None)),
            event_sink: ev_sink,
            reconcile: None,
        });
        fold_queue.wait_idle().await;

        assert_eq!(
            fs::read_to_string(root.join("from_copy.txt")).unwrap(),
            "copy content"
        );
        assert!(
            load_copies(&data).is_empty(),
            "a folded copy leaves no row behind"
        );
        assert!(
            !copy.work.exists(),
            "the copy folder is removed after a clean fold"
        );

        let evs = events.lock().unwrap();
        assert!(
            !evs.iter()
                .any(|e| matches!(e, RoomEvent::MessageAdded { .. })),
            "a successful fold-back posts no chat message"
        );
        assert!(
            evs.iter().any(|e| matches!(e, RoomEvent::Changed { .. })),
            "folded files still reach the chat"
        );
    }

    #[tokio::test]
    async fn restart_requeues_unfolded_copies() {
        let (_tmp, root, data) = init_repo("restart-requeue");
        let copy1 = create_copy(&root, &data, "t1", "bot1").unwrap();
        fs::write(copy1.work.join("c1.txt"), "c1 content").unwrap();

        let copy2 = create_copy(&root, &data, "t2", "bot2").unwrap();
        let mut c2 = copy2;
        c2.state = CopyState::NeedsYou { reason: "prior error".into() };
        save_state(&data, &c2).unwrap();

        let unrecovered = recover_unfolded_copies(&data);
        assert_eq!(unrecovered.len(), 1, "only unfolded copy should be recovered");
        assert_eq!(unrecovered[0].bot, "bot1");

        let fold_queue = Arc::new(FoldQueue::new(data.clone()));
        fold_queue.enqueue(FoldTask {
            thread: unrecovered[0].thread.clone(),
            copy: unrecovered[0].clone(),
            editor_handle: Arc::new(Mutex::new(None)),
            event_sink: Arc::new(|_| {}),
            reconcile: None,
        });
        fold_queue.wait_idle().await;

        assert!(root.join("c1.txt").exists(), "c1.txt should have folded after restart");
        assert_eq!(fs::read_to_string(root.join("c1.txt")).unwrap(), "c1 content");
    }

    #[tokio::test]
    async fn restart_mid_apply_never_half_writes() {
        let (_tmp, root, data) = init_repo("restart-atomic");
        fs::write(root.join("f1.txt"), "f1 orig").unwrap();
        fs::write(root.join("f2.txt"), "f2 orig").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "f1.txt", "f2.txt"]);
        run(&["commit", "-m", "init files"]);

        let copy = create_copy(&root, &data, "t-atomic", "bot-atomic").unwrap();
        fs::write(copy.work.join("f1.txt"), "f1 new").unwrap();
        fs::write(copy.work.join("f2.txt"), "f2 new").unwrap();

        // Perform merge only
        let merge_outcome = merge_main_into_copy(&copy).unwrap();
        assert!(matches!(merge_outcome, FoldOutcome::Clean { .. }));

        // Simulate kill before apply: main is completely untouched
        assert_eq!(fs::read_to_string(root.join("f1.txt")).unwrap(), "f1 orig");
        assert_eq!(fs::read_to_string(root.join("f2.txt")).unwrap(), "f2 orig");

        // Now daemon restarts and performs fold
        let fold_queue = Arc::new(FoldQueue::new(data.clone()));
        fold_queue.enqueue(FoldTask {
            thread: "t-atomic".into(),
            copy,
            editor_handle: Arc::new(Mutex::new(None)),
            event_sink: Arc::new(|_| {}),
            reconcile: None,
        });
        fold_queue.wait_idle().await;

        // Both files cleanly updated in main, never a half-applied state
        assert_eq!(fs::read_to_string(root.join("f1.txt")).unwrap(), "f1 new");
        assert_eq!(fs::read_to_string(root.join("f2.txt")).unwrap(), "f2 new");
    }

    #[test]
    fn fold_never_applies_markers_after_main_moves() {
        let (_tmp, root, data) = init_repo("fold-markers-main-moves");
        fs::write(root.join("seed.txt"), "line 1\nline 2\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "seed.txt"]);
        run(&["commit", "-m", "seed base"]);

        let copy = create_copy(&root, &data, "t-markers", "bot-markers").unwrap();
        fs::write(copy.work.join("seed.txt"), "line 1 bot\nline 2\n").unwrap();
        fs::write(root.join("seed.txt"), "line 1 human\nline 2\n").unwrap();

        // First fold: this clashes and writes conflict markers to copy's seed.txt
        let outcome = merge_main_into_copy(&copy).unwrap();
        assert!(matches!(outcome, FoldOutcome::Conflicts { .. }));

        // Now update copy state to Reconciling with the clashed file
        let mut copy_reconciling = copy.clone();
        copy_reconciling.state = CopyState::Reconciling {
            attempt: 1,
            files: vec!["seed.txt".to_string()],
        };
        save_state(&data, &copy_reconciling).unwrap();

        // Main now moves by modifying a completely DIFFERENT file
        fs::write(root.join("other.txt"), "other content created by human\n").unwrap();

        // Merge main into copy again (takes the slow path because other.txt changed in main)
        // With conflict markers still in seed.txt, this MUST NOT report Clean
        let outcome2 = merge_main_into_copy(&copy_reconciling).unwrap();
        match outcome2 {
            FoldOutcome::Conflicts { files } => {
                assert!(files.contains(&"seed.txt".to_string()));
            }
            other => panic!("Expected Conflicts because seed.txt still has markers, got {:?}", other),
        }

        // Apply to main must never put conflict markers into main
        let main_seed = fs::read_to_string(root.join("seed.txt")).unwrap();
        assert!(!main_seed.contains("<<<<<<<"), "main should never contain conflict markers");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fifty_folds_do_not_leak_file_descriptors() {
        // /dev/fd measures this entire process, including other tests' sockets
        // and runtimes. Measure in a child running only this exact test.
        const CHILD_MARKER: &str = "APEX_DECK_FOLD_FD_TEST_CHILD";
        if std::env::var_os(CHILD_MARKER).is_none() {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "bot_copies::tests::fifty_folds_do_not_leak_file_descriptors",
                    "--test-threads=1",
                    "--nocapture",
                ])
                .env(CHILD_MARKER, "1")
                .output()
                .expect("the isolated fold descriptor test starts");
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                output.status.success() && stdout.contains("running 1 test"),
                "isolated fold descriptor test exited {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
                output.status,
            );
            return;
        }
        let (_tmp, root, data) = init_repo("fold-leak-check");
        fs::write(root.join("seed.txt"), "seed\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "init"]);

        fn count_fds() -> usize {
            std::fs::read_dir("/dev/fd").map(|d| d.count()).unwrap_or(0)
        }

        let fold_queue = Arc::new(FoldQueue::new(data.clone()).with_quiet_duration(std::time::Duration::from_millis(10)));
        let editor_handle = Arc::new(Mutex::new(None));

        // Warm up run
        let copy = create_copy(&root, &data, "t-leak", "bot-0").unwrap();
        fs::write(copy.work.join("file-0.txt"), "content 0\n").unwrap();
        fold_queue.enqueue(FoldTask {
            thread: "t-leak".into(),
            copy,
            editor_handle: Arc::clone(&editor_handle),
            event_sink: Arc::new(|_| {}),
            reconcile: None,
        });
        fold_queue.wait_idle().await;

        let initial_fds = count_fds();

        for i in 1..=50 {
            let bot_name = format!("bot-{i}");
            let copy = create_copy(&root, &data, "t-leak", &bot_name).unwrap();
            fs::write(copy.work.join(format!("file-{i}.txt")), format!("content {i}\n")).unwrap();
            fold_queue.enqueue(FoldTask {
                thread: "t-leak".into(),
                copy,
                editor_handle: Arc::clone(&editor_handle),
                event_sink: Arc::new(|_| {}),
                reconcile: None,
            });
            fold_queue.wait_idle().await;
        }

        let final_fds = count_fds();
        assert!(
            final_fds <= initial_fds + 5,
            "FDs climbed from {initial_fds} to {final_fds}"
        );
    }

    #[test]
    fn fold_allows_marker_text_in_files_that_never_clashed() {
        let (_tmp, root, data) = init_repo("fold-marker-text-clean");
        fs::write(root.join("seed.txt"), "seed\n").unwrap();
        let run = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(out.status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-m", "init"]);

        let copy = create_copy(&root, &data, "t-doc", "bot-doc").unwrap();
        let doc_content = "// This doc explains conflicts: <<<<<<< copy is a marker\n// along with =======\n// and >>>>>>> main\n";
        fs::write(copy.work.join("doc.txt"), doc_content).unwrap();

        let outcome = merge_main_into_copy(&copy).unwrap();
        match outcome {
            FoldOutcome::Clean { files, .. } => {
                assert_eq!(files, vec!["doc.txt".to_string()]);
            }
            other => panic!("Expected Clean, got {:?}", other),
        }
    }
}
