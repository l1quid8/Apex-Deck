//! Live Git actions for the top-bar menu. Thread snapshots are never commit inputs.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub root: String,
    pub head: String,
    pub tree: String,
    pub branch: Option<String>,
    pub target: Option<String>,
    pub target_head: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<File>,
    pub checks_passed: bool,
    pub clean: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub path: String,
    pub added: usize,
    pub removed: usize,
    pub patch: String,
    pub staged_only: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Commit {
        expected: State,
        paths: Vec<String>,
        message: String,
    },
    Checks {
        expected: State,
    },
    Pr {
        expected: State,
    },
    Merge {
        expected: State,
    },
}
#[derive(Serialize)]
pub struct Outcome {
    pub state: State,
    pub message: String,
}

fn git(cwd: &Path, index: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .args([
            "--literal-pathspecs",
            "-c",
            "core.quotePath=false",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args);
    command.env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null());
    if let Some(path) = crate::agents::login_path() {
        command.env("PATH", path);
    }
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let out = command
        .output()
        .map_err(|e| format!("Could not run Git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
/// What was checked out at a path: its head commit, and the commit it is
/// being compared against.
type CheckedOut = (String, Option<String>);

fn checks() -> &'static Mutex<HashMap<String, CheckedOut>> {
    static CHECKS: OnceLock<Mutex<HashMap<String, CheckedOut>>> = OnceLock::new();
    CHECKS.get_or_init(Default::default)
}
fn remember_check(state: &State) {
    checks().lock().unwrap().insert(
        state.root.clone(),
        (state.head.clone(), state.target_head.clone()),
    );
}
fn root(cwd: &Path) -> Result<PathBuf, String> {
    Ok(PathBuf::from(
        git(cwd, None, &["rev-parse", "--show-toplevel"])?.trim(),
    ))
}
pub fn status(cwd: &Path) -> Result<State, String> {
    let root = root(cwd)?;
    let head = git(&root, None, &["rev-parse", "--verify", "HEAD"])
        .map_err(|_| "Create the repository's first commit before using Git actions.".to_string())?
        .trim()
        .to_string();
    let branch = git(&root, None, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string());
    let default = git(
        &root,
        None,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .ok()
    .and_then(|s| s.trim().strip_prefix("origin/").map(String::from));
    let target = default
        .into_iter()
        .chain(["main".into(), "master".into()])
        .find(|b| {
            git(
                &root,
                None,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{b}"),
                ],
            )
            .is_ok()
        });
    let target_head = target
        .as_ref()
        .and_then(|b| git(&root, None, &["rev-parse", &format!("refs/heads/{b}")]).ok())
        .map(|s| s.trim().to_string());
    let (ahead, behind) = if let Some(base) = &target_head {
        let counts = git(
            &root,
            None,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{head}...{base}"),
            ],
        )?;
        let mut counts = counts
            .split_whitespace()
            .map(|s| s.parse::<usize>().unwrap_or(0));
        (counts.next().unwrap_or(0), counts.next().unwrap_or(0))
    } else {
        (0, 0)
    };
    // Build from HEAD rather than the real index: assume-unchanged and
    // skip-worktree flags must never conceal changed bytes from this review.
    let snapshot = private_index();
    git(&root, Some(&snapshot.0), &["read-tree", &head])?;
    git(&root, Some(&snapshot.0), &["add", "-A", "--", "."])?;
    let tree = git(&root, Some(&snapshot.0), &["write-tree"])?
        .trim()
        .to_string();
    let patch = git(
        &root,
        None,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            &head,
            &tree,
        ],
    )?;
    let patches = crate::changes::split_patch(&patch)
        .into_iter()
        .collect::<HashMap<_, _>>();
    // NUL-delimited names preserve tabs, newlines and non-ASCII filenames.
    let stats = git(
        &root,
        None,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--numstat",
            "-z",
            &head,
            &tree,
        ],
    )?;
    let mut files = Vec::new();
    for row in stats.split('\0').filter(|r| !r.is_empty()) {
        let parts = row.splitn(3, '\t').collect::<Vec<_>>();
        if parts.len() != 3 {
            continue;
        }
        let path = parts[2].to_string();
        let patch = match patches.get(&path) {
            Some(p) => p.clone(),
            None => git(
                &root,
                None,
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--no-renames",
                    &head,
                    &tree,
                    "--",
                    &path,
                ],
            )?,
        };
        files.push(File {
            path,
            added: parts[0].parse().unwrap_or(0),
            removed: parts[1].parse().unwrap_or(0),
            patch,
            staged_only: false,
        });
    }
    let staged = git(
        &root,
        None,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--numstat",
            "-z",
        ],
    )?;
    for row in staged.split('\0').filter(|r| !r.is_empty()) {
        let parts = row.splitn(3, '\t').collect::<Vec<_>>();
        if parts.len() != 3 || files.iter().any(|f| f.path == parts[2]) {
            continue;
        }
        let path = parts[2].to_string();
        let patch = git(
            &root,
            None,
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--no-renames",
                "--",
                &path,
            ],
        )?;
        files.push(File {
            path,
            added: parts[0].parse().unwrap_or(0),
            removed: parts[1].parse().unwrap_or(0),
            patch,
            staged_only: true,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    // Staged changes whose working copy matches HEAD must still block merge.
    let clean = files.is_empty()
        && git(
            &root,
            None,
            &["status", "--porcelain", "--untracked-files=all"],
        )?
        .is_empty();
    let key = root.to_string_lossy().to_string();
    // A passed check is a property of (head, targetHead), not of tree cleanliness:
    // touching an unrelated file after checks pass must not revoke them.
    let checks_passed =
        checks().lock().unwrap().get(&key) == Some(&(head.clone(), target_head.clone()));
    Ok(State {
        root: key,
        head,
        tree,
        branch,
        target,
        target_head,
        ahead,
        behind,
        files,
        checks_passed,
        clean,
    })
}
fn current(cwd: &Path, expected: &State) -> Result<State, String> {
    let now = status(cwd)?;
    if now.root != expected.root
        || now.head != expected.head
        || now.tree != expected.tree
        || now.branch != expected.branch
        || now.target_head != expected.target_head
        || now.target != expected.target
    {
        return Err("Git state changed. Review the refreshed files and try again.".into());
    }
    Ok(now)
}
fn link_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(from, to)
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(from, to).is_ok() {
            return Ok(());
        }
        // Directory junctions need no elevation, unlike symlinks.
        let out = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(to)
            .arg(from)
            .output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ))
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (from, to);
        Err(std::io::Error::other(
            "Linking folders is not supported on this platform.",
        ))
    }
}
/// One commit checked out into a scratch folder. Checks must read the commit and
/// never the working tree: otherwise an uncommitted edit could make a broken
/// commit look green, and the pass would be remembered for that commit.
struct HeadCheckout {
    root: PathBuf,
    dir: PathBuf,
}
impl HeadCheckout {
    fn new(root: &Path, head: &str) -> Result<Self, String> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "apex-checks-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.to_string_lossy().to_string();
        git(
            root,
            None,
            &["worktree", "add", "--detach", "--force", &path, head],
        )?;
        let checkout = Self {
            root: root.to_path_buf(),
            dir,
        };
        checkout.link_dependencies()?;
        Ok(checkout)
    }
    /// A commit carries source, not installed packages, so borrow the live
    /// node_modules instead of reinstalling it for every check.
    fn link_dependencies(&self) -> Result<(), String> {
        let modules = self.root.join("node_modules");
        if !modules.is_dir() {
            return Ok(());
        }
        let link = self.dir.join("node_modules");
        if link.exists() {
            return Ok(());
        }
        link_dir(&modules, &link).map_err(|e| {
            format!(
                "Checks need node_modules from {} inside an isolated checkout of the commit, and that link failed: {e}",
                modules.display()
            )
        })
    }
}
impl Drop for HeadCheckout {
    fn drop(&mut self) {
        let dir = self.dir.to_string_lossy().to_string();
        let _ = git(
            &self.root,
            None,
            &["worktree", "remove", "--force", &dir],
        );
        let _ = std::fs::remove_dir_all(&self.dir);
        let _ = git(&self.root, None, &["worktree", "prune"]);
    }
}
struct PrivateIndex(PathBuf);
fn private_index() -> PrivateIndex {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    PrivateIndex(
        std::env::temp_dir().join(format!(
            "apex-menu-index-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )),
    )
}
impl Drop for PrivateIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("lock"));
    }
}
fn commit(cwd: &Path, expected: &State, paths: &[String], message: &str) -> Result<String, String> {
    let now = current(cwd, expected)?;
    if message.trim().is_empty() || message.len() > 4096 {
        return Err("Enter a commit message (up to 4096 bytes).".into());
    }
    if now.branch.is_none() {
        return Err("Check out a branch before committing.".into());
    }
    let available = now
        .files
        .iter()
        .filter(|f| !f.staged_only)
        .map(|f| f.path.as_str())
        .collect::<HashSet<_>>();
    if paths.is_empty()
        || paths.iter().any(|p| {
            !available.contains(p.as_str())
                || Path::new(p).is_absolute()
                || Path::new(p)
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
        })
    {
        return Err("Select current changed files from this repository.".into());
    }
    let index = private_index();
    let root = Path::new(&now.root);
    git(root, Some(&index.0), &["read-tree", &now.head])?;
    // Copy the reviewed blobs, not another read of working files. A concurrent
    // edit after validation can stay dirty but cannot enter this commit.
    let source = format!("--source={}", now.tree);
    let mut args = vec!["restore", "--staged", source.as_str(), "--"];
    args.extend(paths.iter().map(String::as_str));
    git(root, Some(&index.0), &args)?;
    // Validate once more after preparing the index; hooks still run normally.
    current(cwd, expected)?;
    git(root, Some(&index.0), &["commit", "-m", message.trim()])?;
    let mut reset = vec!["reset", "-q", "HEAD", "--"];
    reset.extend(paths.iter().map(String::as_str));
    if let Err(e) = git(root, None, &reset) {
        return Ok(format!(
            "Committed. The selected files' staging area could not be refreshed: {e}"
        ));
    }
    Ok(format!(
        "Committed {} file{}.",
        paths.len(),
        if paths.len() == 1 { "" } else { "s" }
    ))
}
fn branch_ready(now: &State) -> Result<(&str, &str), String> {
    let branch = now.branch.as_deref().ok_or("Check out a branch first.")?;
    let target = now
        .target
        .as_deref()
        .ok_or("No local main or master target branch was found.")?;
    if branch == target || now.ahead == 0 {
        return Err("No branch commits to merge or publish.".into());
    }
    Ok((branch, target))
}
fn target_checked_out_elsewhere(root: &Path, target: &str) -> bool {
    let Ok(list) = git(root, None, &["worktree", "list", "--porcelain"]) else {
        return true;
    };
    let wanted = format!("branch refs/heads/{target}");
    list.lines().any(|line| line.trim() == wanted)
}
fn merge(cwd: &Path, expected: &State) -> Result<String, String> {
    let now = current(cwd, expected)?;
    let (branch, target) = branch_ready(&now)?;
    let root = Path::new(&now.root);
    if !now.checks_passed {
        return Err("Run checks on the latest commit first.".into());
    }
    if now.behind > 0 {
        return Err("Update this branch from its target, then run checks again.".into());
    }
    let old_target = now
        .target_head
        .as_deref()
        .ok_or("No local main or master target branch was found.")?;
    // Fast-forward by ref only: behind == 0 makes target an ancestor of head, so
    // advancing the ref is the whole merge. No branch switch over a dirty tree and
    // no stash, so uncommitted files are never touched.
    if git(
        root,
        None,
        &["merge-base", "--is-ancestor", old_target, &now.head],
    )
    .is_err()
    {
        return Err("Update this branch from its target, then run checks again.".into());
    }
    if target_checked_out_elsewhere(root, target) {
        return Err(format!(
            "{target} is checked out in another worktree. Merge there instead."
        ));
    }
    git(
        root,
        None,
        &[
            "update-ref",
            &format!("refs/heads/{target}"),
            &now.head,
            old_target,
        ],
    )?;
    // Both branches now point at the same commit, so switching changes only the
    // HEAD symref; working files and the index are left exactly as they are.
    if let Err(error) = git(root, None, &["switch", target]) {
        let _ = git(
            root,
            None,
            &[
                "update-ref",
                &format!("refs/heads/{target}"),
                old_target,
                &now.head,
            ],
        );
        return Err(error);
    }
    match git(root, None, &["branch", "-d", "--", branch]) {
        Ok(_) => Ok(format!("Merged into {target} and deleted {branch}.")),
        Err(e) => Ok(format!(
            "Merged into {target}. Branch {branch} was retained: {e}"
        )),
    }
}
async fn run(cwd: &Path, program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1");
    if let Some(path) = crate::agents::login_path() {
        command.env("PATH", path);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(300), command.output())
        .await
        .map_err(|_| format!("{program} timed out after 5 minutes."))?
        .map_err(|e| format!("{program}: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!("{program} failed:\n{stdout}\n{stderr}"));
    }
    Ok(stdout.trim().to_string())
}
/// The type check the card runs, unchanged from what the merge rules expect.
const TYPECHECK: [&str; 4] = ["npx", "--no-install", "tsc", "--noEmit"];
fn short(head: &str) -> &str {
    head.get(..7).unwrap_or(head)
}
/// Runs `command` in a throwaway checkout of the commit under review, then records
/// the pass against that commit. The working tree is never an input, so unrelated
/// uncommitted work can neither block checks nor vouch for untested code.
async fn check_commit(cwd: &Path, expected: &State, command: &[&str]) -> Result<String, String> {
    let work = cwd.to_path_buf();
    let before = expected.clone();
    let now = tokio::task::spawn_blocking(move || current(&work, &before))
        .await
        .map_err(|e| e.to_string())??;
    checks().lock().unwrap().remove(&now.root);
    let root = PathBuf::from(&now.root);
    let head = now.head.clone();
    let checkout = tokio::task::spawn_blocking(move || HeadCheckout::new(&root, &head))
        .await
        .map_err(|e| e.to_string())??;
    let (program, args) = command.split_first().ok_or("No check command was given.")?;
    let outcome = run(&checkout.dir, program, args).await;
    drop(checkout);
    outcome.map_err(|e| {
        format!(
            "TypeScript checks failed on commit {} in an isolated checkout of HEAD; uncommitted files are not part of it.\n{e}",
            short(&now.head)
        )
    })?;
    let work = cwd.to_path_buf();
    let checked = now.clone();
    tokio::task::spawn_blocking(move || {
        current(&work, &checked)?;
        remember_check(&checked);
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(format!(
        "TypeScript checks passed on commit {} in an isolated checkout of HEAD; uncommitted files are not part of it.",
        short(&now.head)
    ))
}
pub async fn perform(cwd: PathBuf, action: Action) -> Result<Outcome, String> {
    let message = match action {
        Action::Commit {
            expected,
            paths,
            message,
        } => {
            let work = cwd.clone();
            tokio::task::spawn_blocking(move || commit(&work, &expected, &paths, &message))
                .await
                .map_err(|e| e.to_string())??
        }
        Action::Merge { expected } => {
            let work = cwd.clone();
            tokio::task::spawn_blocking(move || merge(&work, &expected))
                .await
                .map_err(|e| e.to_string())??
        }
        Action::Checks { expected } => check_commit(&cwd, &expected, &TYPECHECK).await?,
        Action::Pr { expected } => {
            let work = cwd.clone();
            let now = tokio::task::spawn_blocking(move || current(&work, &expected))
                .await
                .map_err(|e| e.to_string())??;
            let (branch, target) = branch_ready(&now)?;
            // Check CLI authentication before publishing any commits.
            run(Path::new(&now.root), "gh", &["auth", "status"]).await?;
            run(
                Path::new(&now.root),
                "git",
                &[
                    "push",
                    "--set-upstream",
                    "origin",
                    &format!("{}:refs/heads/{branch}", now.head),
                ],
            )
            .await?;
            let existing = run(
                Path::new(&now.root),
                "gh",
                &[
                    "pr",
                    "list",
                    "--head",
                    branch,
                    "--base",
                    target,
                    "--state",
                    "open",
                    "--json",
                    "url",
                    "--jq",
                    ".[0].url // empty",
                ],
            )
            .await?;
            if existing.is_empty() {
                let url = run(
                    Path::new(&now.root),
                    "gh",
                    &["pr", "create", "--head", branch, "--base", target, "--fill"],
                )
                .await?;
                format!("Created PR: {url}")
            } else {
                format!("PR: {existing}")
            }
        }
    };
    let state = tokio::task::spawn_blocking(move || status(&cwd))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Outcome { state, message })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    struct Repo(PathBuf);
    impl Repo {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "apex-git-menu-{}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let repo = Self(root);
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.name", "Fixture"]);
            repo.git(&["config", "user.email", "fixture@localhost"]);
            repo.write("one.txt", "one\n");
            repo.write("two.txt", "two\n");
            repo.git(&["add", "."]);
            repo.git(&["commit", "-qm", "initial"]);
            repo.git(&["switch", "-qc", "feat/test"]);
            repo
        }
        fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{:?}: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        fn write(&self, path: &str, text: &str) {
            std::fs::write(self.0.join(path), text).unwrap();
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn live_status_includes_untracked_deleted_and_staged_files() {
        let r = Repo::new();
        r.write("new file.txt", "new\n");
        std::fs::remove_file(r.0.join("one.txt")).unwrap();
        r.write("two.txt", "changed\n");
        r.git(&["add", "two.txt"]);
        let state = status(&r.0).unwrap();
        assert_eq!(state.branch.as_deref(), Some("feat/test"));
        assert_eq!(state.target.as_deref(), Some("main"));
        assert_eq!(
            state
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["new file.txt", "one.txt", "two.txt"]
        );
    }

    #[test]
    fn index_flags_cannot_hide_unreviewed_selected_contents() {
        let r = Repo::new();
        r.write("one.txt", "reviewed\n");
        r.git(&["add", "one.txt"]);
        r.git(&["update-index", "--assume-unchanged", "one.txt"]);
        let reviewed = status(&r.0).unwrap();
        r.write("one.txt", "unreviewed\n");
        assert!(commit(&r.0, &reviewed, &["one.txt".into()], "must reject").is_err());
        assert_eq!(r.git(&["show", "HEAD:one.txt"]), "one");
    }

    #[test]
    fn unusual_names_and_staged_only_changes_remain_visible() {
        let r = Repo::new();
        r.write("tab\tand\nnewline.txt", "new\n");
        r.write("one.txt", "staged\n");
        r.git(&["add", "one.txt"]);
        r.write("one.txt", "one\n");
        let state = status(&r.0).unwrap();
        assert!(!state.clean);
        assert!(state
            .files
            .iter()
            .any(|f| f.path == "tab\tand\nnewline.txt"));
        assert!(state
            .files
            .iter()
            .any(|f| f.path == "one.txt" && f.staged_only));
        assert!(commit(&r.0, &state, &["one.txt".into()], "staged only").is_err());
    }

    #[test]
    fn selected_commit_excludes_and_preserves_unrelated_staging() {
        let r = Repo::new();
        r.write("one.txt", "selected\n");
        r.write("two.txt", "staged\n");
        r.git(&["add", "two.txt"]);
        r.write("new file.txt", "new\n");
        let before = status(&r.0).unwrap();
        commit(
            &r.0,
            &before,
            &["one.txt".into(), "new file.txt".into()],
            "selected files",
        )
        .unwrap();
        assert_eq!(r.git(&["show", "HEAD:two.txt"]), "two");
        assert_eq!(r.git(&["diff", "--cached", "--name-only"]), "two.txt");
        assert_eq!(r.git(&["show", "HEAD:one.txt"]), "selected");
        assert_eq!(status(&r.0).unwrap().files.len(), 1);
    }

    #[test]
    fn stale_tree_and_invalid_paths_are_rejected_before_commit() {
        let r = Repo::new();
        r.write("one.txt", "reviewed\n");
        let before = status(&r.0).unwrap();
        r.write("one.txt", "unreviewed\n");
        assert!(commit(&r.0, &before, &["one.txt".into()], "stale").is_err());
        let now = status(&r.0).unwrap();
        for path in ["../escape", ":(glob)**", "/tmp/file", "two.txt"] {
            assert!(commit(&r.0, &now, &[path.into()], "invalid").is_err());
        }
        assert_eq!(r.git(&["log", "-1", "--format=%s"]), "initial");
    }

    #[test]
    fn merge_fast_forwards_with_dirty_files_and_host_verified_current_check() {
        let r = Repo::new();
        r.write("one.txt", "changed\n");
        assert!(merge(&r.0, &status(&r.0).unwrap()).is_err());
        r.git(&["add", "."]);
        r.git(&["commit", "-qm", "feature"]);
        assert!(merge(&r.0, &status(&r.0).unwrap()).is_err());
        let checked = status(&r.0).unwrap();
        remember_check(&checked);
        assert!(status(&r.0).unwrap().checks_passed);
        // Unrelated dirty work after checks pass neither revokes them nor blocks
        // the merge; a stale snapshot is still rejected before anything moves.
        r.write("two.txt", "later\n");
        assert!(status(&r.0).unwrap().checks_passed);
        assert!(merge(&r.0, &checked).is_err());
        merge(&r.0, &status(&r.0).unwrap()).unwrap();
        assert_eq!(r.git(&["branch", "--show-current"]), "main");
        assert!(!r
            .git(&["branch", "--list", "feat/test"])
            .contains("feat/test"));
        assert_eq!(r.git(&["show", "HEAD:one.txt"]), "changed");
        assert_eq!(r.git(&["show", "HEAD:two.txt"]), "two");
        assert_eq!(
            std::fs::read_to_string(r.0.join("two.txt")).unwrap(),
            "later\n",
            "uncommitted file survives the merge untouched"
        );
    }

    #[test]
    fn merge_leaves_the_target_alone_while_another_worktree_holds_it() {
        let r = Repo::new();
        r.write("one.txt", "feature\n");
        r.git(&["commit", "-qam", "feature"]);
        let checked = status(&r.0).unwrap();
        remember_check(&checked);
        let main_before = r.git(&["rev-parse", "refs/heads/main"]);
        let sibling = r.0.with_extension("sibling");
        r.git(&["worktree", "add", "-q", sibling.to_str().unwrap(), "main"]);
        let error = merge(&r.0, &checked).unwrap_err();
        assert!(error.contains("checked out in another worktree"), "{error}");
        assert_eq!(
            r.git(&["rev-parse", "refs/heads/main"]),
            main_before,
            "a branch another worktree has checked out must not move"
        );
        let sibling_status = Command::new("git")
            .arg("-C")
            .arg(&sibling)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(
            sibling_status.stdout.is_empty(),
            "the other worktree is left exactly as it was"
        );
        r.git(&["worktree", "remove", "--force", sibling.to_str().unwrap()]);
    }

    #[test]
    fn merge_restores_the_target_when_the_follow_up_switch_fails() {
        let r = Repo::new();
        r.write("one.txt", "feature\n");
        r.git(&["commit", "-qam", "feature"]);
        let checked = status(&r.0).unwrap();
        remember_check(&checked);
        let main_before = r.git(&["rev-parse", "refs/heads/main"]);
        // A held index lock fails the switch that follows the ref update, which is
        // the same recovery path a worktree checked out mid-merge would take.
        let lock = r.0.join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let error = merge(&r.0, &checked).unwrap_err();
        std::fs::remove_file(&lock).unwrap();
        assert!(!error.is_empty());
        assert_eq!(
            r.git(&["rev-parse", "refs/heads/main"]),
            main_before,
            "the target is rolled back to where it started"
        );
        assert_eq!(
            r.git(&["branch", "--show-current"]),
            "feat/test",
            "no half-switched checkout"
        );
        assert!(r.git(&["branch", "--list", "feat/test"]).contains("feat/test"));
    }

    #[test]
    fn checks_reuse_installed_dependencies_in_a_scratch_checkout() {
        let r = Repo::new();
        std::fs::create_dir_all(r.0.join("node_modules/typescript")).unwrap();
        r.write("node_modules/typescript/marker.txt", "installed\n");
        let head = status(&r.0).unwrap().head;
        let checkout = HeadCheckout::new(&r.0, &head).unwrap();
        assert_eq!(
            std::fs::read_to_string(checkout.dir.join("node_modules/typescript/marker.txt")).unwrap(),
            "installed\n"
        );
        assert_eq!(
            std::fs::read_to_string(checkout.dir.join("one.txt")).unwrap(),
            "one\n"
        );
        let dir = checkout.dir.clone();
        drop(checkout);
        assert!(!dir.exists(), "the scratch checkout is removed");
    }

    #[tokio::test]
    async fn checks_read_the_commit_so_a_dirty_fix_cannot_green_light_it() {
        let r = Repo::new();
        // The commit is broken; the repair exists only in the working tree.
        r.write("one.txt", "BROKEN\n");
        r.git(&["commit", "-qam", "broken"]);
        r.write("one.txt", "FIXED\n");
        let probe = ["sh", "-c", "test \"$(cat one.txt)\" = FIXED"];
        let dirty = status(&r.0).unwrap();
        assert!(check_commit(&r.0, &dirty, &probe).await.is_err());
        assert!(
            !status(&r.0).unwrap().checks_passed,
            "an uncommitted fix must not record a pass for the broken commit"
        );
        // Isolation leaves the user's checkout and their uncommitted file alone.
        assert_eq!(
            std::fs::read_to_string(r.0.join("one.txt")).unwrap(),
            "FIXED\n"
        );
        assert_eq!(
            r.git(&["status", "--porcelain", "--untracked-files=all"]),
            "M one.txt"
        );
        r.git(&["commit", "-qam", "fixed"]);
        let fixed = status(&r.0).unwrap();
        assert!(check_commit(&r.0, &fixed, &probe).await.is_ok());
        let after = status(&r.0).unwrap();
        assert!(after.checks_passed);
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }

    #[test]
    fn changed_target_invalidates_checks_and_detached_head_cannot_merge() {
        let r = Repo::new();
        r.write("one.txt", "feature\n");
        r.git(&["commit", "-am", "feature"]);
        let checked = status(&r.0).unwrap();
        remember_check(&checked);
        r.git(&["update-ref", "refs/heads/main", &checked.head]);
        assert!(!status(&r.0).unwrap().checks_passed);
        assert!(merge(&r.0, &checked).is_err());
        r.git(&["checkout", "--detach"]);
        assert_eq!(status(&r.0).unwrap().branch, None);
    }
}
