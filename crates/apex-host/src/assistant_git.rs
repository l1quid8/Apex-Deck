//! Git snapshots and verified task integration without touching the primary index.

use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(1);
const MAX_NEW_FILE: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub commit: String,
    pub tree: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub index_hash: Option<String>,
    pub root: PathBuf,
    pub exclusions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationPlan {
    pub task_id: String,
    pub root: PathBuf,
    pub current_snapshot: GitSnapshot,
    pub merged_commit: String,
    pub scratch_path: PathBuf,
    pub changed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyJournal {
    version: u32,
    task_id: String,
    phase: String,
    completed_paths: Vec<String>,
    merged_commit: String,
}

pub fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    run_git(root, None, args, None).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}
fn run_git(
    root: &Path,
    index: Option<&Path>,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not run Git: {e}"))?;
    if let Some(input) = input {
        child
            .stdin
            .take()
            .ok_or("Git stdin missing")?
            .write_all(input)
            .map_err(|e| e.to_string())?;
    }
    let result = child.wait_with_output().map_err(|e| e.to_string())?;
    if result.status.success() {
        Ok(result.stdout)
    } else {
        Err(format!(
            "Git {} failed: {}",
            args.first().unwrap_or(&"command"),
            String::from_utf8_lossy(&result.stderr).trim()
        ))
    }
}
pub fn checkout_root(cwd: &Path) -> Result<PathBuf, String> {
    let root = git(cwd, &["rev-parse", "--show-toplevel"]).map_err(|_| {
        "Delegated editing requires a Git checkout. Observation remains available.".to_string()
    })?;
    std::fs::canonicalize(root.trim()).map_err(|e| e.to_string())
}
fn optional_git(root: &Path, args: &[&str]) -> Option<String> {
    git(root, args)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}
fn index_hash(root: &Path) -> Option<String> {
    let path = optional_git(root, &["rev-parse", "--git-path", "index"])?;
    optional_git(root, &["hash-object", &path])
}
fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
fn secret_name(path: &str) -> bool {
    let name = Path::new(path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if [
        ".example",
        ".sample",
        ".template",
        ".example.local",
        ".sample.local",
    ]
    .iter()
    .any(|suffix| name.ends_with(suffix))
    {
        return false;
    }
    name.starts_with(".env")
        || name.starts_with("id_")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || matches!(
            name.as_str(),
            "credentials.json"
                | "credentials.yaml"
                | "credentials.yml"
        )
}
struct TemporaryIndex(PathBuf);
impl Drop for TemporaryIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("lock"));
    }
}

/// A snapshot of the *working* files, including unstaged edits and safe new
/// files. A separate index leaves the user's staging byte-for-byte intact.
/// Private refs are retained locally; this module never pushes them.
pub fn capture(cwd: &Path, task: &str, purpose: &str) -> Result<GitSnapshot, String> {
    if !safe_component(task) || !safe_component(purpose) {
        return Err("Invalid task snapshot identity.".into());
    }
    let root = checkout_root(cwd)?;
    let head = optional_git(&root, &["rev-parse", "--verify", "HEAD"]);
    let branch = optional_git(&root, &["symbolic-ref", "-q", "HEAD"]);
    let original_index = index_hash(&root);
    let staged_additions = if head.is_some() {
        run_git(
            &root,
            None,
            &[
                "diff",
                "--cached",
                "--diff-filter=A",
                "--name-only",
                "-z",
                "HEAD",
            ],
            None,
        )?
    } else {
        run_git(&root, None, &["ls-files", "--cached", "-z"], None)?
    };
    let git_dir = git(&root, &["rev-parse", "--absolute-git-dir"])?;
    let index = TemporaryIndex(Path::new(git_dir.trim()).join(format!(
        "apex-index-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    run_git(
        &root,
        Some(&index.0),
        &["read-tree", head.as_deref().unwrap_or("--empty")],
        None,
    )?;
    run_git(&root, Some(&index.0), &["add", "-u", "--", "."], None)?;
    let mut staged_paths = Vec::new();
    for path in staged_additions
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
    {
        let path = std::str::from_utf8(path)
            .map_err(|_| {
                "A staged path has a non-UTF-8 path; rename it before delegating.".to_string()
            })?
            .to_string();
        if std::fs::symlink_metadata(root.join(&path)).is_ok() {
            staged_paths.push(path);
        }
    }
    for batch in staged_paths.chunks(100) {
        let mut args = vec!["add", "--"];
        let literals: Vec<_> = batch.iter().map(|p| format!(":(literal){p}")).collect();
        args.extend(literals.iter().map(String::as_str));
        run_git(&root, Some(&index.0), &args, None)?;
    }
    let untracked = run_git(
        &root,
        None,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        None,
    )?;
    // Projects may extend secret exclusions using ordinary gitignore patterns.
    // This policy affects new files only; tracked files are always captured.
    let policy_path = root.join(".apex-agent-exclude");
    let policy = match std::fs::symlink_metadata(&policy_path) {
        Ok(meta) if meta.is_file() && meta.len() <= 64 * 1024 => Some(std::fs::read(&policy_path).map_err(|e| e.to_string())?),
        Ok(_) => return Err(".apex-agent-exclude must be a regular file under 64 KiB.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let policy_included = if policy.is_some() {
        Some(run_git(&root, None, &["ls-files", "--others", "--exclude-standard", "--exclude-from=.apex-agent-exclude", "-z"], None)?
            .split(|b| *b == 0).filter(|path| !path.is_empty()).map(Vec::from).collect::<std::collections::HashSet<_>>())
    } else { None };
    let mut included = Vec::new();
    let mut exclusions = Vec::new();
    for path in untracked.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        let path = std::str::from_utf8(path)
            .map_err(|_| {
                "A new file has a non-UTF-8 path; rename it before delegating.".to_string()
            })?
            .to_string();
        let metadata = std::fs::symlink_metadata(root.join(&path))
            .map_err(|e| format!("Could not inspect {path}: {e}"))?;
        if secret_name(&path) || (metadata.is_file() && metadata.len() > MAX_NEW_FILE)
            || policy_included.as_ref().is_some_and(|included| !included.contains(path.as_bytes())) {
            exclusions.push(path);
        } else {
            included.push(path);
        }
    }
    for batch in included.chunks(100) {
        let mut args = vec!["add", "--"];
        let literals: Vec<_> = batch.iter().map(|p| format!(":(literal){p}")).collect();
        args.extend(literals.iter().map(String::as_str));
        run_git(&root, Some(&index.0), &args, None)?;
    }
    let tree = String::from_utf8_lossy(&run_git(&root, Some(&index.0), &["write-tree"], None)?)
        .trim()
        .to_string();
    if !run_git(
        &root,
        Some(&index.0),
        &["diff-files", "--name-only", "-z"],
        None,
    )?
    .is_empty()
        || head != optional_git(&root, &["rev-parse", "--verify", "HEAD"])
        || branch != optional_git(&root, &["symbolic-ref", "-q", "HEAD"])
        || original_index != index_hash(&root)
        || policy != std::fs::read(&policy_path).ok()
        || untracked
            != run_git(
                &root,
                None,
                &["ls-files", "--others", "--exclude-standard", "-z"],
                None,
            )?
    {
        return Err(
            "The checkout changed while capturing the task. Retry after edits settle.".into(),
        );
    }
    let mut args = vec![
        "-c",
        "user.name=ApexAgent",
        "-c",
        "user.email=apexagent@localhost",
        "commit-tree",
        &tree,
    ];
    if let Some(head) = &head {
        args.extend(["-p", head]);
    }
    let commit = String::from_utf8_lossy(&run_git(
        &root,
        None,
        &args,
        Some(format!("ApexAgent {task} {purpose}\n").as_bytes()),
    )?)
    .trim()
    .to_string();
    git(
        &root,
        &[
            "update-ref",
            // Every captured commit stays reachable across attempts and GC.
            &format!("refs/apex/tasks/{task}/snapshots/{commit}"),
            &commit,
        ],
    )?;
    git(&root, &["update-ref", &format!("refs/apex/tasks/{task}/{purpose}"), &commit])?;
    exclusions.sort();
    Ok(GitSnapshot {
        commit,
        tree,
        head,
        branch,
        index_hash: original_index,
        root,
        exclusions,
    })
}

/// Freeze the task's complete working tree as its immutable review result.
pub fn capture_result(worktree: &Path, task_id: &str) -> Result<GitSnapshot, String> {
    capture(worktree, task_id, "result")
}

pub fn review_diff(root: &Path, baseline: &str, result: &str) -> Result<String, String> {
    git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--binary",
            "--find-renames",
            baseline,
            result,
            "--",
        ],
    )
}

pub(crate) fn task_dir(data_dir: &Path, task_id: &str) -> Result<PathBuf, String> {
    if !safe_component(task_id) {
        return Err("Invalid task id.".into());
    }
    let base = data_dir.join("apex-agent").join("tasks").join(task_id);
    for directory in [data_dir.join("apex-agent"), data_dir.join("apex-agent/tasks"), base.clone()] {
        match std::fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err("Task data directories cannot be symlinks.".into()),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(format!("Could not inspect owned task data: {error}")),
        }
    }
    Ok(base)
}

fn task_base(root: &Path, data_dir: &Path, task_id: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let data = std::fs::canonicalize(data_dir).map_err(|e| e.to_string())?;
    if data.starts_with(root) {
        return Err("Task data and worktrees must be stored outside the project checkout.".into());
    }
    task_dir(&data, task_id)
}

/// Create or reopen the task's detached worker checkout at its captured baseline.
pub fn prepare_worktree(
    snapshot: &GitSnapshot,
    task_id: &str,
    data_dir: &Path,
) -> Result<PathBuf, String> {
    let root = checkout_root(&snapshot.root)?;
    if root != snapshot.root || !safe_component(task_id) {
        return Err("Invalid task checkout or id.".into());
    }
    if run_git(
        &root,
        None,
        &["cat-file", "-e", &format!("{}^{{commit}}", snapshot.commit)],
        None,
    )
    .is_err()
    {
        return Err("The task baseline commit is unavailable.".into());
    }
    let worker_parent = task_base(&root, data_dir, task_id)?;
    std::fs::create_dir_all(&worker_parent).map_err(|e| e.to_string())?;
    let path = std::fs::canonicalize(&worker_parent)
        .map_err(|e| e.to_string())?
        .join("worktree");
    if path.exists() {
        let existing = checkout_root(&path)?;
        let head = git(&existing, &["rev-parse", "HEAD"])?;
        if std::fs::canonicalize(&path).ok().as_ref() == Some(&existing)
            && head.trim() == snapshot.commit
        {
            return Ok(path);
        }
        return Err("The task worktree path already belongs to another checkout.".into());
    }
    git(
        &root,
        &[
            "worktree",
            "add",
            "--detach",
            path.to_str().ok_or("Non-UTF-8 worktree path")?,
            &snapshot.commit,
        ],
    )?;
    Ok(path)
}

/// Merge a task result against a fresh capture of the primary working tree.
/// `git merge-tree` performs the merge in the object database, including
/// renames, binary blobs, executable modes and symlink entries.
pub fn stage_integration(
    primary: &Path,
    baseline: &GitSnapshot,
    result_commit: &str,
    task_id: &str,
    data_dir: &Path,
) -> Result<IntegrationPlan, String> {
    if !safe_component(task_id) {
        return Err("Invalid task id.".into());
    }
    let root = checkout_root(primary)?;
    if root != baseline.root {
        return Err("The task baseline belongs to a different checkout.".into());
    }
    if run_git(
        &root,
        None,
        &[
            "merge-base",
            "--is-ancestor",
            &baseline.commit,
            result_commit,
        ],
        None,
    )
    .is_err()
    {
        return Err("The task result is not based on its captured baseline.".into());
    }
    let current = capture(&root, task_id, "current")?;
    let output = git(
        &root,
        &[
            "merge-tree",
            "--write-tree",
            "--merge-base",
            &baseline.commit,
            &current.commit,
            result_commit,
        ],
    )
    .map_err(|e| format!("Task changes conflict with the current project: {e}"))?;
    let tree = output.lines().next().unwrap_or("").trim();
    if tree.len() != 40 && tree.len() != 64 {
        return Err("Git did not produce a merged tree.".into());
    }
    let merged_commit = String::from_utf8_lossy(&run_git(
        &root,
        None,
        &[
            "-c",
            "user.name=ApexAgent",
            "-c",
            "user.email=apexagent@localhost",
            "commit-tree",
            tree,
            "-p",
            &current.commit,
            "-p",
            result_commit,
        ],
        Some(format!("ApexAgent integration {task_id}\n").as_bytes()),
    )?)
    .trim()
    .to_string();
    git(
        &root,
        &[
            "update-ref",
            &format!("refs/apex/tasks/{task_id}/snapshots/{merged_commit}"),
            &merged_commit,
        ],
    )?;
    git(
        &root,
        &[
            "update-ref",
            &format!("refs/apex/tasks/{task_id}/merged"),
            &merged_commit,
        ],
    )?;
    let names = run_git(
        &root,
        None,
        &[
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            &current.tree,
            tree,
            "--",
        ],
        None,
    )?;
    let changed_paths = names
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| {
            std::str::from_utf8(p)
                .map(str::to_owned)
                .map_err(|_| "A changed path is not UTF-8; rename it before accepting.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let scratch_parent = task_base(&root, data_dir, task_id)?;
    std::fs::create_dir_all(&scratch_parent).map_err(|e| e.to_string())?;
    let scratch_path = std::fs::canonicalize(&scratch_parent)
        .map_err(|e| e.to_string())?
        .join("integration");
    if scratch_path.exists() {
        return Err("An integration scratch checkout already exists; reconcile or archive the earlier attempt first.".into());
    }
    git(
        &root,
        &[
            "worktree",
            "add",
            "--detach",
            scratch_path.to_str().ok_or("Non-UTF-8 scratch path")?,
            &merged_commit,
        ],
    )?;
    Ok(IntegrationPlan {
        task_id: task_id.to_owned(),
        root,
        current_snapshot: current,
        merged_commit,
        scratch_path,
        changed_paths,
    })
}

fn safe_relative(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Git returned an unsafe project path.".into());
    }
    Ok(p.to_path_buf())
}

#[cfg(unix)]
fn copy_entry(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let meta = std::fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(source).map_err(|e| e.to_string())?;
        if destination.exists() || std::fs::symlink_metadata(destination).is_ok() {
            std::fs::remove_file(destination).map_err(|e| e.to_string())?;
        }
        symlink(target, destination).map_err(|e| e.to_string())?;
    } else {
        // Replace a directory entry atomically; copying onto a symlink would
        // follow it and modify a file outside the project.
        let temporary = destination.with_extension(format!("apex-copy-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::copy(source, &temporary).map_err(|e| e.to_string())?;
        std::fs::set_permissions(
            &temporary,
            std::fs::Permissions::from_mode(meta.permissions().mode()),
        )
        .map_err(|e| e.to_string())?;
        std::fs::File::open(&temporary).and_then(|file|file.sync_all()).map_err(|e|e.to_string())?;
        std::fs::rename(&temporary, destination).map_err(|e|e.to_string())?;
    }
    Ok(())
}
#[cfg(not(unix))]
fn copy_entry(source: &Path, destination: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(source).map_err(|e| e.to_string())?;
        if destination.exists() {
            std::fs::remove_file(destination).map_err(|e| e.to_string())?;
        }
        std::os::windows::fs::symlink_file(target, destination).map_err(|e| e.to_string())?;
    } else {
        if std::fs::symlink_metadata(destination).is_ok() { std::fs::remove_file(destination).map_err(|e|e.to_string())?; }
        std::fs::copy(source, destination).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_journal(path: &Path, journal: &ApplyJournal) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension(format!("tmp-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    let bytes = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
    {
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(temp, path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() { std::fs::File::open(parent).and_then(|file|file.sync_all()).map_err(|e|e.to_string())?; }
    Ok(())
}

/// Revalidate the primary checkout, then materialize only merged working files.
/// The index and HEAD are never written by this function.
pub fn apply_integration(plan: &IntegrationPlan, journal_path: &Path) -> Result<(), String> {
    let now = capture(&plan.root, &plan.task_id, "apply-check")?;
    let expected = &plan.current_snapshot;
    if now.tree != expected.tree
        || now.head != expected.head
        || now.branch != expected.branch
        || now.index_hash != expected.index_hash
        || now.exclusions != expected.exclusions
    {
        return Err(
            "The project changed after review. Re-stage the integration before accepting.".into(),
        );
    }
    let scratch_root = checkout_root(&plan.scratch_path)?;
    if std::fs::canonicalize(&plan.scratch_path).ok().as_ref() != Some(&scratch_root)
        || git(&scratch_root, &["rev-parse", "HEAD"])?.trim() != plan.merged_commit
    {
        return Err(
            "The integration scratch checkout no longer matches the reviewed result.".into(),
        );
    }
    let scratch = capture(&scratch_root, &plan.task_id, "scratch-check")?;
    if scratch.tree != git(&plan.root, &["rev-parse", &format!("{}^{{tree}}", plan.merged_commit)])?.trim() {
        return Err("The integration scratch files changed after verification. Re-stage before accepting.".into());
    }
    let mut journal = ApplyJournal {
        version: 1,
        task_id: plan.task_id.clone(),
        phase: "applying".into(),
        completed_paths: Vec::new(),
        merged_commit: plan.merged_commit.clone(),
    };
    write_journal(journal_path, &journal)?;
    for path in plan
        .changed_paths
        .iter()
        .filter(|p| std::fs::symlink_metadata(plan.scratch_path.join(p)).is_err())
    {
        let relative = safe_relative(path)?;
        let to = plan.root.join(&relative);
        if std::fs::symlink_metadata(&to).is_ok() {
            if std::fs::symlink_metadata(&to)
                .map_err(|e| e.to_string())?
                .is_dir()
            {
                std::fs::remove_dir(&to).map_err(|e| {
                    format!("Cannot replace non-empty directory {}: {e}", to.display())
                })?;
            } else {
                std::fs::remove_file(&to).map_err(|e| e.to_string())?;
            }
        }
        journal.completed_paths.push(path.clone());
        write_journal(journal_path, &journal)?;
    }
    for path in plan
        .changed_paths
        .iter()
        .filter(|p| std::fs::symlink_metadata(plan.scratch_path.join(p)).is_ok())
    {
        let relative = safe_relative(path)?;
        let from = plan.scratch_path.join(&relative);
        let to = plan.root.join(&relative);
        let mut parent = to.parent();
        while let Some(dir) = parent {
            if dir == plan.root {
                break;
            }
            if let Ok(meta) = std::fs::symlink_metadata(dir) {
                if !meta.is_dir() {
                    let rel = dir
                        .strip_prefix(&plan.root)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .into_owned();
                    if !plan.changed_paths.iter().any(|p| p == &rel) {
                        return Err(format!(
                            "Refusing to replace unrelated path {}",
                            dir.display()
                        ));
                    }
                    std::fs::remove_file(dir).map_err(|e| e.to_string())?;
                }
            }
            parent = dir.parent();
        }
        if std::fs::symlink_metadata(&to)
            .map(|m| m.is_dir())
            .unwrap_or(false)
        {
            std::fs::remove_dir(&to)
                .map_err(|e| format!("Cannot replace non-empty directory {}: {e}", to.display()))?;
        }
        copy_entry(&from, &to)?;
        journal.completed_paths.push(path.clone());
        write_journal(journal_path, &journal)?;
    }
    let applied = capture(&plan.root, &plan.task_id, "applied-check")?;
    let expected_tree = git(
        &plan.root,
        &["rev-parse", &format!("{}^{{tree}}", plan.merged_commit)],
    )?;
    if applied.tree != expected_tree.trim() {
        return Err("The applied working files do not match the verified integration tree. The task remains recoverable for review.".into());
    }
    journal.phase = "applied".into();
    write_journal(journal_path, &journal)
}

/// Roll back a partially materialized accept to the captured current working
/// tree. The caller must hold the same project apply lease used by apply.
pub fn reconcile_interrupted_apply(
    plan: &IntegrationPlan,
    journal_path: &Path,
) -> Result<(), String> {
    let bytes = std::fs::read(journal_path).map_err(|e| e.to_string())?;
    let mut journal: ApplyJournal = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if journal.version != 1
        || journal.task_id != plan.task_id
        || journal.merged_commit != plan.merged_commit
    {
        return Err("The apply journal does not match this task revision.".into());
    }
    if journal.phase == "applied" || journal.phase == "reconciled" {
        return Ok(());
    }
    if journal.phase != "applying" {
        return Err("The apply journal has an unknown phase.".into());
    }
    let now = capture(&plan.root, &plan.task_id, "reconcile-check")?;
    if now.head != plan.current_snapshot.head
        || now.branch != plan.current_snapshot.branch
        || now.index_hash != plan.current_snapshot.index_hash
    {
        return Err("The checkout branch or staging changed during interrupted apply; refusing automatic rollback.".into());
    }
    let difference = run_git(
        &plan.root,
        None,
        &[
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            &plan.current_snapshot.tree,
            &now.tree,
            "--",
        ],
        None,
    )?;
    let changed_now: Vec<String> = difference
        .split(|b| *b == 0)
        .filter(|b| !b.is_empty())
        .map(|b| {
            std::str::from_utf8(b)
                .map(str::to_owned)
                .map_err(|_| "A project path is not UTF-8.".to_string())
        })
        .collect::<Result<_, _>>()?;
    if changed_now
        .iter()
        .any(|path| !plan.changed_paths.contains(path))
    {
        return Err("Unrelated project files changed during interrupted apply; refusing automatic rollback.".into());
    }
    // A path touched by this task may also have been edited by a person after
    // the crash. Recover only an exact baseline or exact merged entry.
    for path in &plan.changed_paths {
        let entry = |tree: &str| run_git(&plan.root, None, &["ls-tree", "-z", tree, "--", path], None);
        let current = entry(&now.tree)?;
        if current != entry(&plan.current_snapshot.tree)? && current != entry(&plan.merged_commit)? {
            return Err(format!("{} changed after interrupted apply; refusing to overwrite that edit.", path));
        }
    }
    let recovery_path = plan
        .scratch_path
        .parent()
        .ok_or("Invalid scratch path")?
        .join("recovery");
    if !recovery_path.exists() {
        std::fs::create_dir_all(recovery_path.parent().ok_or("Invalid recovery path")?)
            .map_err(|e| e.to_string())?;
        git(
            &plan.root,
            &[
                "worktree",
                "add",
                "--detach",
                recovery_path.to_str().ok_or("Non-UTF-8 recovery path")?,
                &plan.current_snapshot.commit,
            ],
        )?;
    }
    let recovery_root = checkout_root(&recovery_path)?;
    if git(&recovery_root, &["rev-parse", "HEAD"])?.trim() != plan.current_snapshot.commit {
        return Err(
            "The interrupted-apply recovery checkout does not match the captured project state."
                .into(),
        );
    }
    let mut paths = plan.changed_paths.clone();
    paths.sort_by_key(|p| std::cmp::Reverse(p.len()));
    for path in &paths {
        let relative = safe_relative(path)?;
        let destination = plan.root.join(&relative);
        if let Ok(meta) = std::fs::symlink_metadata(&destination) {
            if meta.is_dir() {
                std::fs::remove_dir(&destination).map_err(|e| {
                    format!(
                        "Cannot reconcile non-empty directory {}: {e}",
                        destination.display()
                    )
                })?;
            } else {
                std::fs::remove_file(&destination).map_err(|e| e.to_string())?;
            }
        }
    }
    for path in &plan.changed_paths {
        let relative = safe_relative(path)?;
        let source = recovery_path.join(&relative);
        if std::fs::symlink_metadata(&source).is_ok() {
            let mut parent = plan.root.join(&relative).parent().map(Path::to_path_buf);
            while let Some(dir) = parent {
                if dir == plan.root {
                    break;
                }
                if let Ok(meta) = std::fs::symlink_metadata(&dir) {
                    if !meta.is_dir() {
                        let rel = dir
                            .strip_prefix(&plan.root)
                            .map_err(|e| e.to_string())?
                            .to_string_lossy()
                            .into_owned();
                        if !plan.changed_paths.contains(&rel) {
                            return Err(format!(
                                "Refusing to replace unrelated path {}",
                                dir.display()
                            ));
                        }
                        std::fs::remove_file(&dir).map_err(|e| e.to_string())?;
                    }
                }
                parent = dir.parent().map(Path::to_path_buf);
            }
            copy_entry(&source, &plan.root.join(&relative))?;
        }
    }
    git(
        &plan.root,
        &[
            "worktree",
            "remove",
            "--force",
            recovery_path.to_str().ok_or("Non-UTF-8 recovery path")?,
        ],
    )?;
    journal.phase = "reconciled".into();
    write_journal(journal_path, &journal)
}

/// Remove a task's registered worktrees. Snapshot/result refs and task records stay intact.
pub fn archive_worktree(primary: &Path, task_id: &str, data_dir: &Path) -> Result<(), String> {
    let root = checkout_root(primary)?;
    if !data_dir.exists() {
        return Ok(());
    }
    let data = std::fs::canonicalize(data_dir).map_err(|e| e.to_string())?;
    if data.starts_with(&root) {
        return Err("Task data and worktrees must be stored outside the project checkout.".into());
    }
    let base = task_dir(&data, task_id)?;
    for name in ["integration", "worktree"] {
        let path = base.join(name);
        if !path.exists() {
            continue;
        }
        let actual = checkout_root(&path)?;
        if std::fs::canonicalize(&path).ok().as_ref() != Some(&actual) {
            return Err(format!(
                "Refusing to remove non-owned task path: {}",
                path.display()
            ));
        }
        git(
            &root,
            &[
                "worktree",
                "remove",
                "--force",
                path.to_str().ok_or("Non-UTF-8 worktree path")?,
            ],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn owned_task_paths_reject_symlinked_ancestors() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        let data = root.join("data");
        let outside = root.join("outside");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        for relative in ["apex-agent", "apex-agent/tasks", "apex-agent/tasks/fixture"] {
            let redirected = data.join(relative);
            std::fs::create_dir_all(redirected.parent().unwrap()).unwrap();
            symlink(&outside, &redirected).unwrap();
            assert!(task_dir(&data, "fixture").unwrap_err().contains("cannot be symlinks"));
            std::fs::remove_file(redirected).unwrap();
        }
        assert!(task_dir(&data, "fixture").unwrap().starts_with(&data));
        std::fs::remove_dir_all(root).unwrap();
    }
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "apex-assistant-git-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q"]).unwrap();
        std::fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&root, &["add", "tracked.txt"]).unwrap();
        git(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@localhost",
                "commit",
                "-qm",
                "base",
            ],
        )
        .unwrap();
        root
    }
    #[test]
    fn dirty_snapshot_captures_staged_unstaged_and_new_files_without_changing_index() {
        let root = fixture();
        std::fs::write(root.join("tracked.txt"), "staged\n").unwrap();
        git(&root, &["add", "tracked.txt"]).unwrap();
        std::fs::write(root.join("tracked.txt"), "working\n").unwrap();
        std::fs::write(root.join("staged-new.txt"), "staged new\n").unwrap();
        git(&root, &["add", "staged-new.txt"]).unwrap();
        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        std::fs::write(root.join(".env"), "SECRET=fixture\n").unwrap();
        std::fs::write(root.join(".env.example"), "EXAMPLE=placeholder\n").unwrap();
        std::fs::create_dir_all(root.join("private")).unwrap();
        std::fs::write(root.join("private/id_token"), "private credential\n").unwrap();
        std::fs::write(root.join(".envrc"), "private environment\n").unwrap();
        std::fs::write(root.join(".apex-agent-exclude"), "private/*.json\ntracked.txt\n").unwrap();
        std::fs::write(root.join("private/token.json"), "private credential\n").unwrap();
        let index = std::fs::read(root.join(".git/index")).unwrap();
        let snapshot = capture(&root, "fixture", "baseline").unwrap();
        assert_eq!(
            git(
                &root,
                &["show", &format!("{}:tracked.txt", snapshot.commit)]
            )
            .unwrap(),
            "working\n"
        );
        assert_eq!(
            git(&root, &["show", &format!("{}:new.txt", snapshot.commit)]).unwrap(),
            "new\n"
        );
        assert_eq!(
            git(
                &root,
                &["show", &format!("{}:staged-new.txt", snapshot.commit)]
            )
            .unwrap(),
            "staged new\n"
        );
        assert!(git(&root, &["show", &format!("{}:.env", snapshot.commit)]).is_err());
        assert!(git(
            &root,
            &["show", &format!("{}:.env.example", snapshot.commit)]
        )
        .is_ok());
        assert_eq!(snapshot.exclusions, vec![".env", ".envrc", "private/id_token", "private/token.json"]);
        assert_eq!(std::fs::read(root.join(".git/index")).unwrap(), index);
        assert_eq!(
            std::fs::read_to_string(root.join("tracked.txt")).unwrap(),
            "working\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn earlier_attempt_snapshots_remain_reachable_after_later_results_and_gc() {
        let root = fixture();
        std::fs::write(root.join("tracked.txt"), "first attempt\n").unwrap();
        let first = capture_result(&root, "durable-result").unwrap();
        std::fs::write(root.join("tracked.txt"), "second attempt\n").unwrap();
        let second = capture_result(&root, "durable-result").unwrap();
        assert_ne!(first.commit, second.commit);
        git(&root, &["reflog", "expire", "--expire=now", "--all"]).unwrap();
        git(&root, &["gc", "--prune=now"]).unwrap();
        assert_eq!(git(&root, &["show", &format!("{}:tracked.txt", first.commit)]).unwrap(), "first attempt\n");
        assert_eq!(git(&root, &["rev-parse", &format!("refs/apex/tasks/durable-result/snapshots/{}", first.commit)]).unwrap().trim(), first.commit);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn isolated_tasks_merge_sequentially_and_preserve_primary_index_and_human_edits() {
        let root = fixture();
        let data = root.parent().unwrap().join(format!(
            "apex-assistant-data-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&data).unwrap();
        let baseline = capture(&root, "task-a", "baseline").unwrap();
        let task_a = prepare_worktree(&baseline, "task-a", &data).unwrap();
        std::fs::write(task_a.join("tracked.txt"), "task A\n").unwrap();
        git(&task_a, &["add", "tracked.txt"]).unwrap();
        let result_a = capture_result(&task_a, "task-a").unwrap().commit;
        std::fs::write(root.join("human.txt"), "human\n").unwrap();
        git(&root, &["add", "human.txt"]).unwrap();
        let staged_index = std::fs::read(root.join(".git/index")).unwrap();
        let integration_a =
            stage_integration(&root, &baseline, &result_a, "task-a", &data).unwrap();
        apply_integration(&integration_a, &data.join("task-a-apply.json")).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("tracked.txt")).unwrap(),
            "task A\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("human.txt")).unwrap(),
            "human\n"
        );
        assert_eq!(
            std::fs::read(root.join(".git/index")).unwrap(),
            staged_index
        );

        let baseline_b = capture(&root, "task-b", "baseline").unwrap();
        let task_b = prepare_worktree(&baseline_b, "task-b", &data).unwrap();
        std::fs::write(task_b.join("second.txt"), "task B\n").unwrap();
        git(&task_b, &["add", "second.txt"]).unwrap();
        let result_b = capture_result(&task_b, "task-b").unwrap().commit;
        let integration_b =
            stage_integration(&root, &baseline_b, &result_b, "task-b", &data).unwrap();
        assert!(
            integration_b
                .changed_paths
                .contains(&"second.txt".to_string()),
            "{:?}",
            integration_b.changed_paths
        );
        apply_integration(&integration_b, &data.join("task-b-apply.json")).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("tracked.txt")).unwrap(),
            "task A\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("second.txt")).unwrap(),
            "task B\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("human.txt")).unwrap(),
            "human\n"
        );
        assert_eq!(
            std::fs::read(root.join(".git/index")).unwrap(),
            staged_index
        );
        archive_worktree(&root, "task-a", &data).unwrap();
        archive_worktree(&root, "task-b", &data).unwrap();
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn conflicting_task_result_is_rejected_without_writing_primary_files() {
        let root = fixture();
        let data = root.parent().unwrap().join(format!(
            "apex-assistant-data-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&data).unwrap();
        let baseline = capture(&root, "task-conflict", "baseline").unwrap();
        let task = prepare_worktree(&baseline, "task-conflict", &data).unwrap();
        std::fs::write(task.join("tracked.txt"), "worker\n").unwrap();
        git(&task, &["add", "tracked.txt"]).unwrap();
        let result = capture_result(&task, "task-conflict").unwrap().commit;
        std::fs::write(root.join("tracked.txt"), "human\n").unwrap();
        let before = std::fs::read(root.join("tracked.txt")).unwrap();
        assert!(stage_integration(&root, &baseline, &result, "task-conflict", &data).is_err());
        assert_eq!(std::fs::read(root.join("tracked.txt")).unwrap(), before);
        archive_worktree(&root, "task-conflict", &data).unwrap();
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn integration_preserves_rename_binary_executable_mode_symlink_add_and_delete() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = fixture();
        std::fs::write(root.join("old name.bin"), [0, 255, 1, 2]).unwrap();
        std::fs::write(root.join("remove.txt"), "remove\n").unwrap();
        git(&root, &["add", "old name.bin", "remove.txt"]).unwrap();
        git(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@localhost",
                "commit",
                "-qm",
                "extra baseline",
            ],
        )
        .unwrap();
        let data = root.parent().unwrap().join(format!(
            "apex-assistant-data-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&data).unwrap();
        let baseline = capture(&root, "task-types", "baseline").unwrap();
        let task = prepare_worktree(&baseline, "task-types", &data).unwrap();
        std::fs::rename(task.join("old name.bin"), task.join("renamed.bin")).unwrap();
        std::fs::write(task.join("renamed.bin"), [9, 0, 255, 3]).unwrap();
        std::fs::set_permissions(
            task.join("renamed.bin"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        std::fs::remove_file(task.join("remove.txt")).unwrap();
        symlink("renamed.bin", task.join("link.bin")).unwrap();
        git(&task, &["add", "-A"]).unwrap();
        let result = capture_result(&task, "task-types").unwrap().commit;
        let plan = stage_integration(&root, &baseline, &result, "task-types", &data).unwrap();
        assert!(
            plan.changed_paths.contains(&"renamed.bin".to_string()),
            "{:?}",
            plan.changed_paths
        );
        apply_integration(&plan, &data.join("task-types-apply.json")).unwrap();
        assert!(!root.join("old name.bin").exists());
        assert!(!root.join("remove.txt").exists());
        assert_eq!(
            std::fs::read(root.join("renamed.bin")).unwrap(),
            [9, 0, 255, 3]
        );
        assert_eq!(
            std::fs::metadata(root.join("renamed.bin"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0o111
        );
        assert_eq!(
            std::fs::read_link(root.join("link.bin")).unwrap(),
            PathBuf::from("renamed.bin")
        );
        archive_worktree(&root, "task-types", &data).unwrap();
        assert!(!task.exists());
        assert!(!plan.scratch_path.exists());
        assert!(run_git(
            &root,
            None,
            &["cat-file", "-e", &format!("{}^{{commit}}", result)],
            None
        )
        .is_ok());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn stale_apply_does_not_overwrite_an_edit_made_after_review() {
        let root = fixture();
        let data = root.parent().unwrap().join(format!(
            "apex-assistant-data-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&data).unwrap();
        let baseline = capture(&root, "task-stale", "baseline").unwrap();
        let task = prepare_worktree(&baseline, "task-stale", &data).unwrap();
        std::fs::write(task.join("tracked.txt"), "worker\n").unwrap();
        git(&task, &["add", "tracked.txt"]).unwrap();
        let result = capture_result(&task, "task-stale").unwrap().commit;
        let plan = stage_integration(&root, &baseline, &result, "task-stale", &data).unwrap();
        std::fs::write(root.join("tracked.txt"), "new human edit\n").unwrap();
        let index = std::fs::read(root.join(".git/index")).unwrap();
        assert!(apply_integration(&plan, &data.join("stale.json")).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("tracked.txt")).unwrap(),
            "new human edit\n"
        );
        assert_eq!(std::fs::read(root.join(".git/index")).unwrap(), index);
        let _ = archive_worktree(&root, "task-stale", &data);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn interrupted_apply_can_restore_its_captured_working_tree() {
        let root = fixture();
        let data = root.parent().unwrap().join(format!(
            "apex-assistant-data-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&data).unwrap();
        let baseline = capture(&root, "task-recover", "baseline").unwrap();
        let task = prepare_worktree(&baseline, "task-recover", &data).unwrap();
        std::fs::write(task.join("tracked.txt"), "worker result\n").unwrap();
        git(&task, &["add", "tracked.txt"]).unwrap();
        let result = capture_result(&task, "task-recover").unwrap().commit;
        let plan = stage_integration(&root, &baseline, &result, "task-recover", &data).unwrap();
        std::fs::write(root.join("tracked.txt"), "worker result\n").unwrap();
        let journal_path = data.join("recover.json");
        write_journal(
            &journal_path,
            &ApplyJournal {
                version: 1,
                task_id: "task-recover".into(),
                phase: "applying".into(),
                completed_paths: vec!["tracked.txt".into()],
                merged_commit: plan.merged_commit.clone(),
            },
        )
        .unwrap();
        reconcile_interrupted_apply(&plan, &journal_path).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("tracked.txt")).unwrap(),
            "base\n"
        );
        let journal: ApplyJournal =
            serde_json::from_slice(&std::fs::read(journal_path).unwrap()).unwrap();
        assert_eq!(journal.phase, "reconciled");
        // An edit made after a crash on a task-touched path is human work too.
        write_journal(&data.join("recover-human.json"), &ApplyJournal { version: 1, task_id: "task-recover".into(), phase: "applying".into(), completed_paths: vec![], merged_commit: plan.merged_commit.clone() }).unwrap();
        std::fs::write(root.join("tracked.txt"), "human edited after crash\n").unwrap();
        assert!(reconcile_interrupted_apply(&plan, &data.join("recover-human.json")).is_err());
        assert_eq!(std::fs::read_to_string(root.join("tracked.txt")).unwrap(), "human edited after crash\n");
        let _ = archive_worktree(&root, "task-recover", &data);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_symlink_does_not_write_through_it() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        let outside = root.with_extension("outside");
        std::fs::write(&outside, "human outside data\n").unwrap();
        let destination = root.join("linked");
        symlink(&outside, &destination).unwrap();
        let source = root.join("source");
        std::fs::write(&source, "task result\n").unwrap();
        copy_entry(&source, &destination).unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "human outside data\n");
        assert!(!std::fs::symlink_metadata(&destination).unwrap().file_type().is_symlink());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_file(outside).unwrap();
    }
}
