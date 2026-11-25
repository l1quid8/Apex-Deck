//! Task folders: one Deck-owned worktree per agent task, on its own branch made
//! from `origin/main`. `"$APEX_DECK_BIN" task start` makes one and moves the
//! agent's copy's changes into it. Deck never folds a task folder back into
//! the main folder; it removes it after the pull request merges.

use crate::bot_copies::{BotCopy, SHARED_SHORTCUT_PATHS};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(crate) const NOT_GITHUB: &str = "This thread's folder is not a Git checkout with a GitHub origin.";
const NAMING: &str = "Use a branch name like fix/paste-images: feat, fix, chore, docs, ci, refactor, test or perf, a slash, then lowercase letters, digits and dashes.";
const KINDS: [&str; 8] = ["feat", "fix", "chore", "docs", "ci", "refactor", "test", "perf"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskFolder {
    pub thread: String,
    pub agent: String,
    pub branch: String,
    /// The task folder, canonicalized.
    pub path: PathBuf,
    /// The GitHub repository, `owner/name`.
    pub repo: String,
    /// The checkout the folder was made from, canonicalized: where its
    /// worktree and branch are removed, and where a thread on a subfolder of
    /// it finds the matching subfolder.
    pub root: PathBuf,
}

/// How a task's pull request ended.
pub enum Close {
    Merged { head: String, result_oid: Option<String> },
    Abandoned,
    /// Merged, but the folder stays for this reason (its agent is working in it).
    Leave(String),
}
#[derive(Debug, PartialEq, Eq)]
pub enum Closed {
    Removed,
    Kept { path: PathBuf, why: String },
}

#[derive(Debug)]
pub struct Started {
    pub folder: TaskFolder,
    pub moved: bool,
    pub conflicts: Vec<String>,
    /// Why the agent's copy couldn't be put back to its base, so its changes
    /// may also fold back into the main folder.
    pub copy_left: Option<String>,
}

/// Saved as the user's own file beside the agent copies, not a protected
/// ledger: the root broker keeps only the ledgers it lists, and a task
/// folder record grants nothing (merging still needs the person's words).
#[derive(Clone, Default, Serialize, Deserialize)]
struct Ledger {
    version: u32,
    folders: Vec<TaskFolder>,
}

pub struct TaskBranches {
    path: PathBuf,
    cache: Mutex<Option<Ledger>>,
}

/// `feat|fix|chore|docs|ci|refactor|test|perf`, a slash, then 1 to 48
/// lowercase letters, digits and dashes, not starting with a dash.
fn valid_branch(name: &str) -> bool {
    let Some((kind, rest)) = name.split_once('/') else { return false };
    KINDS.contains(&kind)
        && (1..=48).contains(&rest.len())
        && rest.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Deck's own git: hooks, fsmonitor and the person's global config off.
fn git(data: &Path, cwd: &Path, writable: &[&Path], envs: &[(&str, &OsStr)], args: &[&str]) -> Result<String, String> {
    let mut cmd = crate::project_process::git_command(data, cwd)?;
    for folder in writable {
        cmd.writable(folder);
    }
    cmd.current_dir(cwd);
    for (key, value) in envs {
        cmd.env(key, value);
    }
    cmd.args(args);
    let out = cmd.output().map_err(|e| format!("Could not run git {}: {e}", args.first().unwrap_or(&"")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    } else {
        Err(format!("git {} failed: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// Git that talks to GitHub: the person's own config, so their credential
/// helper signs in, with hooks and fsmonitor still off.
fn git_remote(data: &Path, cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = crate::project_process::command_in(data, "git", cwd)?;
    cmd.args(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    if let Some(path) = crate::agents::login_path() {
        cmd.env("PATH", path);
    }
    let out = cmd.output().map_err(|e| format!("Could not run git {}: {e}", args.first().unwrap_or(&"")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    } else {
        Err(format!("git {} failed: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// A commit holding `copy`'s working tree (shortcut links left out) on top
/// of the copy's base, or `None` when the copy has no changes.
fn copy_changes(data: &Path, copy: &BotCopy) -> Result<Option<String>, String> {
    let tree = crate::bot_copies::snapshot_tree_id(data, &copy.work)?;
    let base_tree = git(data, &copy.work, &[&copy.work], &[], &["rev-parse", &format!("{}^{{tree}}", copy.base)])?;
    if tree == base_tree {
        return Ok(None);
    }
    let commit = git(data, &copy.work, &[&copy.work], &[], &[
        "-c", "user.name=Deck", "-c", "user.email=deck@localhost",
        "commit-tree", &tree, "-p", &copy.base, "-m", "Deck task start: the copy's changes",
    ])?;
    Ok(Some(commit))
}

/// Links the shortcut paths that exist in `root` into `folder`, and makes
/// git ignore the links (a `node_modules/` rule doesn't match a link).
fn link_shortcuts(data: &Path, root: &Path, folder: &Path) -> Result<(), String> {
    let common = PathBuf::from(git(data, folder, &[folder], &[], &["rev-parse", "--path-format=absolute", "--git-common-dir"])?);
    let exclude = common.join("info").join("exclude");
    let mut rules = std::fs::read_to_string(&exclude).unwrap_or_default();
    let before = rules.clone();
    for rel in SHARED_SHORTCUT_PATHS {
        let target = root.join(rel);
        if !target.is_dir() {
            continue;
        }
        crate::git_changes::link_dir(&target, &folder.join(rel))
            .map_err(|e| format!("Could not link {} into {}: {e}", target.display(), folder.display()))?;
        let rule = format!("/{rel}");
        if !rules.lines().any(|line| line.trim() == rule) {
            if !rules.is_empty() && !rules.ends_with('\n') {
                rules.push('\n');
            }
            rules.push_str(&rule);
            rules.push('\n');
        }
    }
    if rules != before {
        std::fs::create_dir_all(common.join("info")).map_err(|e| format!("Could not write {}: {e}", exclude.display()))?;
        std::fs::write(&exclude, rules).map_err(|e| format!("Could not write {}: {e}", exclude.display()))?;
    }
    Ok(())
}

/// Puts the copy back to its base, keeping its shortcut links, so its
/// fold has nothing to bring back.
fn reset_copy(data: &Path, copy: &BotCopy) -> Result<(), String> {
    git(data, &copy.work, &[&copy.work], &[], &["checkout", "-q", "--force", "--detach", &copy.base])?;
    let mut clean = vec!["clean", "-fdq"];
    for rel in SHARED_SHORTCUT_PATHS {
        clean.extend(["-e", rel]);
    }
    git(data, &copy.work, &[&copy.work], &[], &clean)?;
    Ok(())
}

impl TaskBranches {
    pub fn new(data: &Path) -> Self {
        Self { path: data.join("task-branches-v1.json"), cache: Mutex::new(None) }
    }

    fn edit<T>(&self, f: impl FnOnce(&mut Vec<TaskFolder>) -> Result<T, String>) -> Result<T, String> {
        let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
        if cache.is_none() {
            let saved = crate::plain_file::read::<Ledger>(&self.path)?.unwrap_or(Ledger { version: 1, folders: Vec::new() });
            if saved.version != 1 {
                return Err(format!("{} is from a newer Deck (version {}).", self.path.display(), saved.version));
            }
            *cache = Some(saved);
        }
        let current = cache.as_ref().unwrap();
        let mut next = current.clone();
        let result = f(&mut next.folders)?;
        if current.folders != next.folders {
            if let Err(e) = crate::plain_file::save(&self.path, &next) {
                *cache = None;
                return Err(e);
            }
            *cache = Some(next);
        }
        Ok(result)
    }

    /// Drops the saved record and returns `Ok(None)` if `folder.path` no longer exists.
    pub fn get(&self, thread: &str, agent: &str) -> Result<Option<TaskFolder>, String> {
        self.edit(|folders| {
            let Some(at) = folders.iter().position(|f| f.thread == thread && f.agent == agent) else { return Ok(None) };
            if folders[at].path.is_dir() {
                return Ok(Some(folders[at].clone()));
            }
            folders.remove(at);
            Ok(None)
        })
    }

    /// Always drops the record; removes the folder and branch only when nothing
    /// in them is missing from the merge.
    pub fn close(&self, data: &Path, thread: &str, agent: &str, why: Close) -> Result<Closed, String> {
        let folder = self.get(thread, agent)?;
        self.edit(|folders| {
            folders.retain(|f| !(f.thread == thread && f.agent == agent));
            Ok(())
        })?;
        let Some(folder) = folder else { return Ok(Closed::Removed) };
        let kept = |why: String| Ok(Closed::Kept { path: folder.path.clone(), why });
        let (head, result_oid) = match why {
            Close::Abandoned => return kept("the pull request was closed without merging".into()),
            Close::Leave(why) => return kept(why),
            Close::Merged { head, result_oid } => (head, result_oid),
        };
        let path = &folder.path;
        let read = |args: &[&str]| git(data, path, &[path], &[], args);
        let clean = read(&["status", "--porcelain"]).is_ok_and(|status| {
            status.lines().all(|line| SHARED_SHORTCUT_PATHS.contains(&line.get(3..).unwrap_or("").trim_end_matches('/')))
        });
        // At the merged head, or contained in the merge (GitHub's "Update branch" made a newer head).
        let at = read(&["rev-parse", "HEAD"]).unwrap_or_default();
        let contained = at == head || result_oid.as_deref().is_some_and(|merge| read(&["merge-base", "--is-ancestor", &at, merge]).is_ok());
        if !(clean && contained) {
            return kept("it has changes the pull request doesn't contain".into());
        }
        // The links go first, so removing the folder can never reach what they point to.
        for rel in SHARED_SHORTCUT_PATHS {
            let link = path.join(rel);
            if std::fs::symlink_metadata(&link).is_ok_and(|meta| meta.file_type().is_symlink()) {
                // A Windows junction is a directory entry; a Unix link is a file.
                #[cfg(windows)]
                let removed = std::fs::remove_dir(&link).or_else(|_| std::fs::remove_file(&link));
                #[cfg(not(windows))]
                let removed = std::fs::remove_file(&link);
                if let Err(e) = removed {
                    return kept(format!("Deck couldn't unlink {rel}: {e}"));
                }
            }
        }
        let external = crate::assistant_git::external_path(path);
        if let Err(e) = git(data, &folder.root, &[path], &[], &["worktree", "remove", "--force", &external.to_string_lossy()]) {
            return kept(format!("Deck couldn't remove it: {e}"));
        }
        let _ = crate::project_process::prune_worktrees(data, &folder.root);
        // `-D`: when the Mac's main wasn't updated, git doesn't know the branch is merged.
        // The folder is gone either way; a branch name left behind is harmless.
        if let Err(e) = git(data, &folder.root, &[], &[], &["branch", "-D", &folder.branch]) {
            eprintln!("[apex-deck] task branch {} stays: {e}", folder.branch);
        }
        Ok(Closed::Removed)
    }

    /// `root` is the thread's checkout; `copy` is the agent's active copy, if any.
    pub fn start(&self, data: &Path, root: &Path, copy: Option<&BotCopy>, thread: &str, agent: &str, branch: &str) -> Result<Started, String> {
        if !valid_branch(branch) {
            return Err(NAMING.into());
        }
        if let Some(have) = self.get(thread, agent)? {
            return Err(format!("You already have a task branch in this thread: {} in {}.", have.branch, crate::assistant_git::external_path(&have.path).display()));
        }
        let top = git(data, root, &[], &[], &["rev-parse", "--show-toplevel"]).map_err(|_| NOT_GITHUB.to_string())?;
        let top = std::fs::canonicalize(&top).map_err(|e| format!("Cannot resolve {top}: {e}"))?;
        let push = git(data, &top, &[], &[], &["remote", "get-url", "--push", "origin"]).map_err(|_| NOT_GITHUB.to_string())?;
        let repo = crate::thread_git::repository(&push).map_err(|_| NOT_GITHUB.to_string())?;
        let parent = crate::bot_copies::worktrees_dir(data, &top);
        let name = branch.replace('/', "-");
        let path = parent.join(&name);
        if std::fs::symlink_metadata(&path).is_ok() {
            return Err(format!("A folder named {name} already exists in {}. Pick another name.", parent.display()));
        }
        let taken = || Err(format!("{branch} already exists. Pick another name."));
        if git(data, &top, &[], &[], &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok() {
            return taken();
        }
        if !git_remote(data, &top, &["ls-remote", "--heads", "origin", &format!("refs/heads/{branch}")])?.is_empty() {
            return taken();
        }
        // Taken before anything changes, so a refusal below leaves the copy as it was.
        let changes = copy.map(|copy| copy_changes(data, copy)).transpose()?.flatten();
        git_remote(data, &top, &["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"])?;
        // `git worktree add` fills an empty folder, and the jail can only show
        // one that already exists, so the folder is made first.
        std::fs::create_dir_all(&path).map_err(|e| format!("Could not create {}: {e}", path.display()))?;
        let made = (|| -> Result<Started, String> {
            let external = crate::assistant_git::external_path(&path);
            let folder_arg = external.to_str().ok_or("The folder's path is not valid UTF-8.")?;
            git(data, &top, &[&path], &[], &["worktree", "add", "-q", "--no-track", "-b", branch, folder_arg, "origin/main"])?;
            let mut conflicts = Vec::new();
            if let Some(commit) = &changes {
                let picked = git(data, &path, &[&path], &[], &["-c", "user.name=Deck", "-c", "user.email=deck@localhost", "cherry-pick", "--no-commit", commit]);
                if let Err(why) = picked {
                    conflicts = git(data, &path, &[&path], &[], &["diff", "--name-only", "--diff-filter=U"])?.lines().map(str::to_owned).collect();
                    if conflicts.is_empty() {
                        return Err(why);
                    }
                }
                // Both a clean pick and a conflicted one leave MERGE_MSG and
                // AUTO_MERGE behind; this keeps the staged changes and markers.
                git(data, &path, &[&path], &[], &["cherry-pick", "--quit"])?;
            }
            link_shortcuts(data, &top, &path)?;
            let path = std::fs::canonicalize(&path).map_err(|e| format!("Cannot resolve {}: {e}", path.display()))?;
            let folder = TaskFolder { thread: thread.into(), agent: agent.into(), branch: branch.into(), path, repo, root: top.clone() };
            Ok(Started { folder, moved: changes.is_some(), conflicts, copy_left: None })
        })();
        let started = match made {
            Ok(started) => started,
            Err(why) => {
                let external = crate::assistant_git::external_path(&path);
                let _ = git(data, &top, &[&path], &[], &["worktree", "remove", "--force", &external.to_string_lossy()]);
                let _ = std::fs::remove_dir_all(&path);
                let _ = crate::project_process::prune_worktrees(data, &top);
                let _ = git(data, &top, &[], &[], &["branch", "-D", branch]);
                return Err(why);
            }
        };
        // Recorded before the copy is touched, so the folder is never orphaned.
        let folder = started.folder.clone();
        self.edit(|folders| {
            folders.retain(|f| !(f.thread == folder.thread && f.agent == folder.agent));
            folders.push(folder);
            Ok(())
        })?;
        let copy_left = match (copy, &changes) {
            (Some(copy), Some(_)) => reset_copy(data, copy).err(),
            _ => None,
        };
        Ok(Started { copy_left, ..started })
    }
}

/// A main checkout for tests whose `origin` fetches from a local bare
/// repository and pushes to GitHub (never reached), with `main` pushed.
/// The bare repository sits inside the checkout's own `.git`: on Linux,
/// Deck's git runs in a jail that sees the checkout and its `.git`, not the
/// rest of `/tmp`.
#[cfg(test)]
pub(crate) mod fixture {
    use super::*;
    use crate::project_process::{fixture_git_command, TestDataDir};

    pub(crate) fn git(cwd: &Path, args: &[&str]) -> String {
        let out = fixture_git_command().args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "git {args:?} in {}: {}", cwd.display(), String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }

    pub(crate) struct Repo {
        pub(crate) data: TestDataDir,
        root: TestDataDir,
        pub(crate) bare: PathBuf,
        pub(crate) store: TaskBranches,
    }
    impl Repo {
        pub(crate) fn new() -> Self {
            let (data, root) = (TestDataDir::new(), TestDataDir::new());
            let r = root.path();
            git(r, &["init", "-qb", "main"]);
            let bare = r.join(".git").join("github.git");
            git(r, &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
            git(r, &["config", "user.name", "Fixture"]);
            git(r, &["config", "user.email", "test@example.invalid"]);
            std::fs::write(r.join(".gitignore"), "node_modules/\n").unwrap();
            std::fs::write(r.join("shared.txt"), "a\n").unwrap();
            std::fs::create_dir_all(r.join("sub")).unwrap();
            std::fs::write(r.join("sub/inner.txt"), "inner\n").unwrap();
            git(r, &["add", "-A"]);
            git(r, &["commit", "-qm", "base"]);
            git(r, &["remote", "add", "origin", bare.to_str().unwrap()]);
            git(r, &["config", "remote.origin.pushurl", "https://github.com/test/repo.git"]);
            // Nothing in a test reaches GitHub: a merge worker's push fails here, locally.
            git(r, &["config", "http.proxy", "http://127.0.0.1:9"]);
            git(r, &["push", "-q", bare.to_str().unwrap(), "main:main"]);
            git(r, &["fetch", "-q", "origin"]);
            let store = TaskBranches::new(data.path());
            Self { data, root, bare, store }
        }
        pub(crate) fn root(&self) -> &Path { self.root.path() }
        /// Where Deck puts this checkout's copies and task folders.
        pub(crate) fn parent(&self) -> PathBuf {
            let root = std::fs::canonicalize(self.root()).unwrap();
            root.with_file_name(format!("{}-worktrees", root.file_name().unwrap().to_string_lossy()))
        }
        pub(crate) fn copy(&self, agent: &str) -> BotCopy {
            crate::bot_copies::create_copy(self.root(), self.data.path(), "t", agent).unwrap()
        }
        pub(crate) fn start(&self, copy: Option<&BotCopy>, agent: &str, branch: &str) -> Result<Started, String> {
            self.store.start(self.data.path(), self.root(), copy, "t", agent, branch)
        }
        /// Moves `main` on GitHub (the bare origin) without touching the checkout's `main`.
        pub(crate) fn advance_origin(&self, file: &str, text: &str) {
            let r = self.root();
            git(r, &["switch", "-qc", "upstream"]);
            std::fs::write(r.join(file), text).unwrap();
            git(r, &["commit", "-qam", "upstream change"]);
            git(r, &["push", "-q", self.bare.to_str().unwrap(), "upstream:main"]);
            git(r, &["switch", "-q", "main"]);
            git(r, &["branch", "-qD", "upstream"]);
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.parent());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::{git, Repo};
    use super::*;

    const NAMING: &str = "Use a branch name like fix/paste-images: feat, fix, chore, docs, ci, refactor, test or perf, a slash, then lowercase letters, digits and dashes.";

    /// `git status --porcelain` without the shared shortcut links.
    fn status(dir: &Path) -> Vec<String> {
        git(dir, &["status", "--porcelain"]).lines().filter(|l| !l.ends_with(" node_modules") && !l.ends_with(" node_modules/")).map(str::to_owned).collect()
    }
    fn no_pick_leftovers(folder: &Path) {
        let git_dir = PathBuf::from(git(folder, &["rev-parse", "--absolute-git-dir"]));
        for name in ["MERGE_MSG", "AUTO_MERGE", "CHERRY_PICK_HEAD"] {
            assert!(!git_dir.join(name).exists(), "{name} left in {}", git_dir.display());
        }
    }

    #[test]
    fn start_moves_only_this_agents_changes() {
        let repo = Repo::new();
        // Another agent's work, not folded or committed yet, is in the copy's base.
        std::fs::write(repo.root().join("other.txt"), "theirs\n").unwrap();
        let copy = repo.copy("a");
        std::fs::write(copy.work.join("mine.txt"), "mine\n").unwrap();
        let started = repo.start(Some(&copy), "a", "fix/paste-images").unwrap();
        let folder = &started.folder.path;
        assert_eq!(git(folder, &["diff", "--name-only", "origin/main"]), "mine.txt");
        assert_eq!(std::fs::read_to_string(folder.join("mine.txt")).unwrap(), "mine\n");
        assert!(!folder.join("other.txt").exists());
        no_pick_leftovers(folder);
        assert_eq!(*folder, std::fs::canonicalize(git(folder, &["rev-parse", "--show-toplevel"])).unwrap());
        assert_eq!(*folder, repo.parent().join("fix-paste-images"));
        assert_eq!(git(folder, &["symbolic-ref", "--short", "HEAD"]), "fix/paste-images");
        assert_eq!((started.moved, started.conflicts.len()), (true, 0));
        assert_eq!(started.folder.repo, "test/repo");
        // The copy is back to its base: nothing for the fold to bring back.
        assert_eq!(git(&copy.work, &["rev-parse", "HEAD"]), copy.base);
        assert!(status(&copy.work).is_empty(), "{:?}", status(&copy.work));
        assert!(!copy.work.join("mine.txt").exists());
        assert!(copy.work.join("other.txt").exists(), "the base keeps the other agent's file");
        assert_eq!(repo.store.get("t", "a").unwrap(), Some(started.folder.clone()));
        assert_eq!(repo.store.get("t", "b").unwrap(), None);
    }

    #[test]
    fn start_reports_conflicts_and_keeps_the_markers() {
        let repo = Repo::new();
        repo.advance_origin("shared.txt", "origin\n");
        let copy = repo.copy("a");
        std::fs::write(copy.work.join("shared.txt"), "mine\n").unwrap();
        let started = repo.start(Some(&copy), "a", "fix/paste-images").unwrap();
        assert_eq!(started.conflicts, vec!["shared.txt".to_string()]);
        assert!(started.moved);
        let text = std::fs::read_to_string(started.folder.path.join("shared.txt")).unwrap();
        assert!(text.contains("<<<<<<<") && text.contains("origin") && text.contains("mine"), "{text}");
        no_pick_leftovers(&started.folder.path);
        assert_eq!(git(&copy.work, &["rev-parse", "HEAD"]), copy.base);
        assert!(status(&copy.work).is_empty());
    }

    #[test]
    fn start_without_a_copy_moves_nothing() {
        let repo = Repo::new();
        repo.advance_origin("shared.txt", "newer\n");
        let started = repo.start(None, "a", "feat/alert-timer").unwrap();
        let folder = &started.folder.path;
        assert_eq!(git(folder, &["rev-parse", "HEAD"]), git(repo.root(), &["rev-parse", "origin/main"]));
        assert_eq!(std::fs::read_to_string(folder.join("shared.txt")).unwrap(), "newer\n", "made from GitHub's main, not the checkout's");
        assert!(status(folder).is_empty(), "{:?}", status(folder));
        assert_eq!((started.moved, started.conflicts.len()), (false, 0));
    }

    #[test]
    fn start_refuses_bad_names_existing_branches_and_folders() {
        let repo = Repo::new();
        for name in ["Fix/X", "fix", "fix/a b", "feature/x", "fix/", "fix/-x", "fix/a/b", "fix/a_b"] {
            assert_eq!(repo.start(None, "a", name).unwrap_err(), NAMING, "{name}");
        }
        git(repo.root(), &["branch", "fix/paste-images"]);
        assert_eq!(repo.start(None, "a", "fix/paste-images").unwrap_err(), "fix/paste-images already exists. Pick another name.");
        git(repo.root(), &["push", "-q", repo.bare.to_str().unwrap(), "main:refs/heads/fix/remote-only"]);
        assert_eq!(repo.start(None, "a", "fix/remote-only").unwrap_err(), "fix/remote-only already exists. Pick another name.");
        std::fs::create_dir_all(repo.parent().join("fix-taken")).unwrap();
        // The folder is named as git reports it, which on Windows mixes slashes.
        let taken = repo.start(None, "a", "fix/taken").unwrap_err();
        assert!(taken.starts_with("A folder named fix-taken already exists in ") && taken.ends_with("-worktrees. Pick another name."), "{taken}");
        assert_eq!(repo.store.get("t", "a").unwrap(), None, "nothing was started");
        // The type is part of the folder's name, so these two don't collide.
        let feat = repo.start(None, "a", "feat/paste-images").unwrap();
        let fix = repo.start(None, "b", "fix/other-images").unwrap();
        assert_eq!(feat.folder.path, repo.parent().join("feat-paste-images"));
        assert_ne!(feat.folder.path, fix.folder.path);
    }

    #[test]
    fn start_refuses_a_second_task_branch() {
        let repo = Repo::new();
        let first = repo.start(None, "a", "fix/one").unwrap();
        assert_eq!(
            repo.start(None, "a", "fix/two").unwrap_err(),
            format!("You already have a task branch in this thread: fix/one in {}.", crate::assistant_git::external_path(&first.folder.path).display())
        );
        assert!(!repo.parent().join("fix-two").exists());
    }

    #[test]
    fn a_deleted_task_folder_drops_its_stale_record() {
        let repo = Repo::new();
        let first = repo.start(None, "a", "fix/one").unwrap();
        std::fs::remove_dir_all(&first.folder.path).unwrap();
        assert_eq!(repo.store.get("t", "a").unwrap(), None);
        assert_eq!(TaskBranches::new(repo.data.path()).get("t", "a").unwrap(), None, "the record is gone from disk too");
        let again = repo.start(None, "a", "fix/two").unwrap();
        assert_eq!(repo.store.get("t", "a").unwrap(), Some(again.folder));
    }

    #[test]
    fn the_node_modules_link_is_ignored_and_missing_shortcuts_are_skipped() {
        let repo = Repo::new();
        std::fs::create_dir_all(repo.root().join("node_modules/pkg")).unwrap();
        std::fs::write(repo.root().join("node_modules/pkg/index.js"), "x").unwrap();
        let before = git(repo.root(), &["status", "--porcelain", "--ignored"]);
        let copy = repo.copy("a");
        std::fs::write(copy.work.join("mine.txt"), "mine\n").unwrap();
        let started = repo.start(Some(&copy), "a", "fix/linked").unwrap();
        let folder = &started.folder.path;
        assert!(folder.join("node_modules/pkg/index.js").exists(), "the shortcut is linked");
        assert_eq!(git(folder, &["status", "--porcelain"]), "A  mine.txt");
        git(folder, &["add", "-A"]);
        assert_eq!(git(folder, &["diff", "--cached", "--name-only", "origin/main"]), "mine.txt");
        assert_eq!(git(repo.root(), &["status", "--porcelain", "--ignored"]), before, "the main checkout's status is unchanged");

        let bare = Repo::new();
        let started = bare.start(None, "a", "fix/no-modules").unwrap();
        assert!(std::fs::symlink_metadata(started.folder.path.join("node_modules")).is_err(), "nothing to link");
        assert_eq!(git(&started.folder.path, &["status", "--porcelain"]), "");
    }

    #[tokio::test]
    async fn the_agents_task_folder_is_where_its_turns_run() {
        use apex_core::{CopyProvider, ParticipantId};
        let repo = Repo::new();
        let started = repo.start(None, "a", "fix/turns").unwrap();
        let copies = |thread_dir: PathBuf| crate::bot_copies::BotCopies::new(
            repo.data.path().to_path_buf(), "t".into(), thread_dir, Default::default(), std::sync::Arc::new(|_: apex_core::RoomEvent| {}), Default::default(),
        ).with_task_branches(std::sync::Arc::new(TaskBranches::new(repo.data.path())));
        // The turn runs, and is told it runs, in the folder as git takes it:
        // never Windows' \\?\ form, which git refuses.
        let plain = crate::assistant_git::external_path(&started.folder.path).into_owned();
        let grant = copies(repo.root().to_path_buf()).active_copy(&ParticipantId::new("a")).await.unwrap();
        assert_eq!(grant, apex_core::CopyGrant { path: plain.clone(), task_branch: Some("fix/turns".into()) });
        assert!(!grant.path.to_string_lossy().starts_with(r"\\?\"));
        // A thread on a subfolder starts in the same subfolder of the task folder.
        let grant = copies(repo.root().join("sub")).active_copy(&ParticipantId::new("a")).await.unwrap();
        assert_eq!(grant.path, plain.join("sub"));
        assert_eq!(copies(repo.root().to_path_buf()).active_copy(&ParticipantId::new("b")).await, None, "another agent has none");
        // Deleted outside Deck: the record goes, and the next turn is an ordinary one.
        std::fs::remove_dir_all(&started.folder.path).unwrap();
        assert_eq!(copies(repo.root().to_path_buf()).active_copy(&ParticipantId::new("a")).await, None);
        assert_eq!(repo.store.get("t", "a").unwrap(), None);
    }

    fn merged(repo: &Repo, agent: &str, head: &str, result_oid: Option<String>) -> Closed {
        repo.store.close(repo.data.path(), "t", agent, Close::Merged { head: head.into(), result_oid }).unwrap()
    }

    #[test]
    fn after_the_update_the_task_folder_and_branch_are_removed() {
        let repo = Repo::new();
        let folder = repo.start(None, "a", "fix/done").unwrap().folder.path;
        std::fs::create_dir_all(repo.root().join("node_modules")).unwrap();
        git(&folder, &["commit", "--allow-empty", "-qm", "the fix"]);
        let head = git(&folder, &["rev-parse", "HEAD"]);
        assert_eq!(merged(&repo, "a", &head, None), Closed::Removed);
        assert!(std::fs::symlink_metadata(&folder).is_err(), "the folder is gone");
        assert_eq!(git(repo.root(), &["branch", "--list", "fix/done"]), "", "the branch is gone");
        assert!(!git(repo.root(), &["worktree", "list"]).contains("fix-done"));
        assert_eq!(repo.store.get("t", "a").unwrap(), None);
        assert!(repo.root().join("node_modules").is_dir(), "the linked shortcut's target is untouched");
    }

    #[test]
    fn a_task_folder_whose_head_is_contained_in_the_merge_commit_is_removed() {
        // GitHub's "Update branch" merged main into the PR first: the merged head is newer than the folder.
        let repo = Repo::new();
        let folder = repo.start(None, "a", "fix/updated").unwrap().folder.path;
        git(&folder, &["commit", "--allow-empty", "-qm", "the fix"]);
        let mine = git(&folder, &["rev-parse", "HEAD"]);
        let tree = git(&folder, &["rev-parse", "HEAD^{tree}"]);
        let main = git(repo.root(), &["rev-parse", "origin/main"]);
        let updated = git(&folder, &["commit-tree", &tree, "-p", &mine, "-p", &main, "-m", "Merge main into fix/updated"]);
        let merge = git(&folder, &["commit-tree", &tree, "-p", &main, "-p", &updated, "-m", "Merge pull request #42"]);
        assert_eq!(merged(&repo, "a", &updated, Some(merge)), Closed::Removed);
        assert!(std::fs::symlink_metadata(&folder).is_err());
    }

    #[test]
    fn a_task_folder_with_changes_or_new_commits_is_kept() {
        let repo = Repo::new();
        let kept = |agent: &str, branch: &str, change: &dyn Fn(&Path)| {
            let folder = repo.start(None, agent, branch).unwrap().folder.path;
            git(&folder, &["commit", "--allow-empty", "-qm", "the fix"]);
            let head = git(&folder, &["rev-parse", "HEAD"]);
            change(&folder);
            let closed = merged(&repo, agent, &head, None);
            assert_eq!(closed, Closed::Kept { path: folder.clone(), why: "it has changes the pull request doesn't contain".into() }, "{branch}");
            assert!(folder.is_dir(), "{branch}: the folder stays");
            assert_eq!(git(repo.root(), &["branch", "--list", branch]), format!("+ {branch}"), "{branch}: the branch stays");
            assert_eq!(repo.store.get("t", agent).unwrap(), None, "{branch}: the record goes either way");
        };
        kept("a", "fix/dirty", &|folder| std::fs::write(folder.join("unsaved.txt"), "work in progress\n").unwrap());
        kept("b", "fix/later", &|folder| { git(folder, &["commit", "--allow-empty", "-qm", "after the PR"]); });
        // A pull request closed without merging keeps the folder too.
        let folder = repo.start(None, "c", "fix/closed").unwrap().folder.path;
        assert!(matches!(repo.store.close(repo.data.path(), "t", "c", Close::Abandoned).unwrap(), Closed::Kept { .. }));
        assert!(folder.is_dir());
        assert_eq!(repo.store.get("t", "c").unwrap(), None);
    }

    #[test]
    fn the_record_is_a_plain_file_beside_the_copies() {
        // Protected ledgers take only the names the root broker lists; this one is the user's own file.
        let repo = Repo::new();
        let started = repo.start(None, "a", "fix/plain").unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(repo.data.path().join("task-branches-v1.json")).unwrap()).unwrap();
        assert_eq!(saved["version"], 1);
        assert_eq!(saved["folders"][0]["branch"], "fix/plain");
        assert_eq!(saved["folders"][0]["path"].as_str(), started.folder.path.to_str());
        assert!(!crate::authority_file::fixture_path(&repo.data.path().join("task-branches-v1.json")).exists());
        assert_eq!(TaskBranches::new(repo.data.path()).get("t", "a").unwrap(), Some(started.folder), "read back after a restart");
    }

    #[cfg(unix)]
    #[test]
    fn a_copy_that_cannot_be_emptied_keeps_the_task_folder_recorded() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Repo::new();
        let copy = repo.copy("a");
        std::fs::write(copy.work.join("sub/inner.txt"), "mine\n").unwrap();
        // Git can't write the restored file back into a read-only folder.
        std::fs::set_permissions(copy.work.join("sub"), std::fs::Permissions::from_mode(0o555)).unwrap();
        let started = repo.start(Some(&copy), "a", "fix/stuck-copy");
        std::fs::set_permissions(copy.work.join("sub"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = started.unwrap();
        assert!(started.copy_left.is_some(), "the agent is told its copy still holds the changes");
        assert_eq!(std::fs::read_to_string(started.folder.path.join("sub/inner.txt")).unwrap(), "mine\n");
        assert_eq!(repo.store.get("t", "a").unwrap(), Some(started.folder), "the folder is recorded, not orphaned");
    }

    #[test]
    fn a_folder_git_cannot_remove_is_kept_and_says_why() {
        let repo = Repo::new();
        let folder = repo.start(None, "a", "fix/locked").unwrap().folder.path;
        git(&folder, &["commit", "--allow-empty", "-qm", "the fix"]);
        let head = git(&folder, &["rev-parse", "HEAD"]);
        git(repo.root(), &["worktree", "lock", "--reason", "in use", folder.to_str().unwrap()]);
        let closed = merged(&repo, "a", &head, None);
        let Closed::Kept { path, why } = closed else { panic!("removed a locked worktree") };
        assert_eq!(path, folder);
        assert!(why.starts_with("Deck couldn't remove it: "), "{why}");
        assert!(folder.is_dir());
        assert_eq!(repo.store.get("t", "a").unwrap(), None);
        git(repo.root(), &["worktree", "unlock", folder.to_str().unwrap()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_shortcut_link_that_cannot_be_removed_keeps_the_folder() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Repo::new();
        std::fs::create_dir_all(repo.root().join("node_modules/pkg")).unwrap();
        let folder = repo.start(None, "a", "fix/linked-shut").unwrap().folder.path;
        git(&folder, &["commit", "--allow-empty", "-qm", "the fix"]);
        let head = git(&folder, &["rev-parse", "HEAD"]);
        // Removing anything in a read-only folder fails, so the link stays.
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
        let closed = merged(&repo, "a", &head, None);
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
        let Closed::Kept { why, .. } = closed else { panic!("removed the folder around a link it couldn't remove") };
        assert!(why.starts_with("Deck couldn't unlink node_modules: "), "{why}");
        assert!(repo.root().join("node_modules/pkg").is_dir(), "the linked folder is untouched");
    }
}
