use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub main: bool,
    pub locked: bool,
    pub prunable: bool,
    pub changes: Option<u32>,
    pub task: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeList {
    pub root: String,
    pub items: Vec<Worktree>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRequest {
    pub branch: String,
    pub new_branch: bool,
    pub base: Option<String>,
    pub folder: Option<String>,
}

fn git(project: &Path, args: &[String]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(project)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Could not run Git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}
fn arg(s: impl AsRef<std::ffi::OsStr>) -> String {
    s.as_ref().to_string_lossy().into_owned()
}
fn parse_list(raw: &str, task_dir: &Path) -> Vec<Worktree> {
    let mut records: Vec<Vec<&str>> = Vec::new();
    let mut current = Vec::new();
    for field in raw.split('\0').filter(|field| !field.is_empty()) {
        if field.starts_with("worktree ") && !current.is_empty() {
            records.push(std::mem::take(&mut current));
        }
        current.push(field);
    }
    if !current.is_empty() {
        records.push(current);
    }
    records
        .into_iter()
        .enumerate()
        .filter_map(|(index, fields)| {
            let mut path = None;
            let mut head = None;
            let mut branch = None;
            let mut locked = false;
            let mut prunable = false;
            for field in fields {
                if let Some(v) = field.strip_prefix("worktree ") {
                    path = Some(v.to_string());
                } else if let Some(v) = field.strip_prefix("HEAD ") {
                    head = Some(v.to_string());
                } else if let Some(v) = field.strip_prefix("branch refs/heads/") {
                    branch = Some(v.to_string());
                } else if field == "locked" || field.starts_with("locked ") {
                    locked = true;
                } else if field == "prunable" || field.starts_with("prunable ") {
                    prunable = true;
                }
            }
            let path = path?;
            let task = Path::new(&path).starts_with(task_dir);
            Some(Worktree {
                path,
                head,
                branch,
                main: index == 0,
                locked,
                prunable,
                changes: None,
                task,
            })
        })
        .collect()
}
/// A repository the tab manages: the folder to run Git in, and its worktrees, main first.
struct Repo {
    dir: PathBuf,
    items: Vec<Worktree>,
}
/// The repository holding `project`. A project folder that isn't in one, such as a
/// folder of checkouts, gets every repository checked out directly inside it; the one
/// with the most checkouts there comes first and takes new worktrees.
fn repos(project: &Path, task_dir: &Path) -> Result<(String, Vec<Repo>), String> {
    let task_root = fs_canonical(task_dir).unwrap_or_else(|| task_dir.to_path_buf());
    let worktrees = |dir: &Path| {
        git(
            dir,
            &[
                "worktree".into(),
                "list".into(),
                "--porcelain".into(),
                "-z".into(),
            ],
        )
        .map(|raw| parse_list(&raw, &task_root))
    };
    let (root, mut repos) = match git(project, &["rev-parse".into(), "--show-toplevel".into()]) {
        Ok(root) => {
            let root = root.trim().to_string();
            let items = worktrees(Path::new(&root))?;
            (root, vec![Repo { dir: project.to_path_buf(), items }])
        }
        Err(_) => {
            let repos: Vec<Repo> = child_repos(project)
                .into_iter()
                .filter_map(|checkout| {
                    let items = worktrees(&checkout).ok()?;
                    // Git runs in the main checkout, so a new branch starts from its HEAD.
                    let dir = items
                        .first()
                        .map(|main| PathBuf::from(&main.path))
                        .filter(|main| main.is_dir())
                        .unwrap_or(checkout);
                    Some(Repo { dir, items })
                })
                .collect();
            let root = repos
                .first()
                .ok_or("This folder isn't a Git repository.")?
                .dir
                .to_string_lossy()
                .into_owned();
            (root, repos)
        }
    };
    for item in repos
        .iter_mut()
        .flat_map(|repo| repo.items.iter_mut())
        .filter(|w| !w.prunable)
        .take(50)
    {
        item.changes = git(Path::new(&item.path), &["status".into(), "--porcelain".into()])
            .ok()
            .map(|s| s.lines().count().min(u32::MAX as usize) as u32);
    }
    Ok((root, repos))
}
/// One checkout per repository checked out directly inside `folder`, the repository
/// with the most checkouts there first. Hidden folders and symlinks are skipped, so
/// nothing outside `folder` is reached.
fn child_repos(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut found: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
    let children = entries
        .flatten()
        .filter(|entry| {
            !entry.file_name().to_string_lossy().starts_with('.')
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
        })
        .take(256);
    for entry in children {
        let path = entry.path();
        let Ok(out) = git(
            &path,
            &[
                "rev-parse".into(),
                "--path-format=absolute".into(),
                "--show-toplevel".into(),
                "--git-common-dir".into(),
            ],
        ) else {
            continue;
        };
        let mut lines = out.lines();
        let (Some(top), Some(common)) = (lines.next(), lines.next()) else {
            continue;
        };
        match (fs_canonical(Path::new(top)), fs_canonical(&path)) {
            (Some(top), Some(path)) if top == path => {}
            _ => continue,
        }
        let common = fs_canonical(Path::new(common)).unwrap_or_else(|| PathBuf::from(common));
        match found.iter_mut().find(|(known, _)| *known == common) {
            Some((_, checkouts)) => checkouts.push(path),
            None => found.push((common, vec![path])),
        }
    }
    found.iter_mut().for_each(|(_, checkouts)| checkouts.sort());
    found.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.1[0].cmp(&b.1[0])));
    found
        .into_iter()
        .map(|(_, mut checkouts)| checkouts.swap_remove(0))
        .collect()
}
pub fn list(project: &Path, task_dir: &Path) -> Result<WorktreeList, String> {
    let (root, repos) = repos(project, task_dir)?;
    let items = repos.into_iter().flat_map(|repo| repo.items).collect();
    Ok(WorktreeList { root, items })
}
pub fn add(project: &Path, req: AddRequest) -> Result<Worktree, String> {
    let branch = req.branch.trim();
    if branch.is_empty()
        || !git(
            project,
            &["check-ref-format".into(), "--branch".into(), branch.into()],
        )
        .is_ok()
    {
        return Err("Enter a valid branch name.".into());
    }
    let (_, repos) = repos(project, Path::new("/__apexagent_task_dir_unavailable__"))?;
    let repo = repos.first().ok_or("Git did not report a main worktree.")?;
    let project = repo.dir.as_path();
    let main = repo
        .items
        .first()
        .ok_or("Git did not report a main worktree.")?;
    let main_path = Path::new(&main.path);
    let parent = main_path.parent().unwrap_or(main_path);
    let name = main_path.file_name().unwrap_or_default().to_string_lossy();
    let default = parent
        .join(format!("{name}-worktrees"))
        .join(branch.replace('/', "-"));
    let folder = req.folder.map(PathBuf::from).unwrap_or(default);
    if std::fs::symlink_metadata(&folder).is_ok() {
        return Err("That folder already exists.".into());
    }
    let folder_arg = arg(&folder);
    if req.new_branch {
        let mut args = vec![
            "worktree".into(),
            "add".into(),
            "-b".into(),
            branch.into(),
            "--".into(),
            folder_arg,
        ];
        if let Some(base) = req.base.filter(|s| !s.trim().is_empty()) {
            let verified = git(
                project,
                &[
                    "rev-parse".into(),
                    "--verify".into(),
                    "--end-of-options".into(),
                    format!("{}^{{commit}}", base),
                ],
            )?;
            args.push(verified.trim().to_string());
        }
        git(project, &args)?;
    } else {
        git(
            project,
            &[
                "rev-parse".into(),
                "--verify".into(),
                "--end-of-options".into(),
                format!("refs/heads/{branch}^{{commit}}"),
            ],
        )?;
        git(
            project,
            &[
                "worktree".into(),
                "add".into(),
                "--".into(),
                folder_arg,
                branch.into(),
            ],
        )?;
    }
    let raw = git(
        project,
        &[
            "worktree".into(),
            "list".into(),
            "--porcelain".into(),
            "-z".into(),
        ],
    )?;
    let mut row = parse_list(&raw, Path::new("/__apexagent_task_dir_unavailable__"))
        .into_iter()
        .find(|w| fs_canonical(Path::new(&w.path)) == fs_canonical(&folder))
        .ok_or("Git added the worktree but did not report it.")?;
    row.changes = Some(0);
    Ok(row)
}
pub fn remove(project: &Path, target: &Path, force: bool, task_dir: &Path) -> Result<(), String> {
    let (_, repos) = repos(project, task_dir)?;
    if std::fs::symlink_metadata(target).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("The worktree folder was replaced.".into());
    }
    let target = fs_canonical(target).unwrap_or_else(|| target.to_path_buf());
    let (project, row) = repos
        .iter()
        .find_map(|repo| {
            repo.items
                .iter()
                .find(|w| {
                    fs_canonical(Path::new(&w.path)).unwrap_or_else(|| PathBuf::from(&w.path))
                        == target
                })
                .map(|row| (repo.dir.as_path(), row))
        })
        .ok_or("That folder is not a worktree for this project.")?;
    if row.main {
        return Err("The main checkout can't be removed here.".into());
    }
    if row.task {
        return Err("ApexAgent manages this worktree.".into());
    }
    let mut args = vec!["worktree".into(), "remove".into()];
    if force {
        args.push("--force".into());
    }
    args.push("--".into());
    args.push(arg(target));
    git(project, &args).map(|_| ()).map_err(|error| {
        if !force && (error.contains("modified or untracked") || error.contains("local changes")) {
            format!("has-changes:{error}")
        } else {
            error
        }
    })
}

/// Unregister only the selected worktree, retaining its working files.
/// A separate command prevents older hosts from interpreting Prune as deletion.
pub fn forget(project: &Path, target: &Path, force: bool, task_dir: &Path) -> Result<(), String> {
    let (_, repos) = repos(project, task_dir)?;
    let (project, row) = repos.iter()
        .find_map(|repo| repo.items.iter().find(|w| Path::new(&w.path) == target).map(|row| (repo.dir.as_path(), row)))
        .ok_or("That folder is not a worktree for this project.")?;
    if row.main { return Err("The main checkout can't be removed here.".into()); }
    if row.task { return Err("ApexAgent manages this worktree.".into()); }
    if row.locked { return Err("Unlock this worktree before pruning it.".into()); }
    if !force && row.changes.unwrap_or(0) > 0 {
        return Err("has-changes:Unregister this worktree and keep its files?".into());
    }
    if let Ok(meta) = std::fs::symlink_metadata(target) {
        if !meta.is_dir() || meta.file_type().is_symlink() { return Err("The worktree folder was replaced.".into()); }
    }
    let common = git(project, &["rev-parse".into(), "--path-format=absolute".into(), "--git-common-dir".into()])?;
    let registry = Path::new(common.trim()).join("worktrees");
    let entries = std::fs::read_dir(&registry).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() { continue; }
        let admin = entry.path();
        let gitdir = std::fs::read_to_string(admin.join("gitdir")).map_err(|e| e.to_string())?;
        if Path::new(gitdir.trim()) != target.join(".git") { continue; }
        if admin.join("locked").exists() { return Err("Unlock this worktree before pruning it.".into()); }
        let pointer = target.join(".git");
        if let Ok(meta) = std::fs::symlink_metadata(&pointer) {
            if !meta.is_file() || meta.file_type().is_symlink() { return Err("The worktree Git pointer was replaced.".into()); }
            let contents = std::fs::read_to_string(&pointer).map_err(|e| e.to_string())?;
            if contents.trim().strip_prefix("gitdir: ").map(Path::new) != Some(admin.as_path()) {
                return Err("The worktree Git pointer was replaced.".into());
            }
            std::fs::remove_file(pointer).map_err(|e| e.to_string())?;
        }
        std::fs::remove_dir_all(admin).map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("Could not find the selected worktree registration.".into())
}
pub fn prune(project: &Path) -> Result<(), String> {
    if git(project, &["rev-parse".into(), "--show-toplevel".into()]).is_ok() {
        return git(project, &["worktree".into(), "prune".into()]).map(|_| ());
    }
    let checkouts = child_repos(project);
    if checkouts.is_empty() {
        return Err("This folder isn't a Git repository.".into());
    }
    for checkout in checkouts {
        git(&checkout, &["worktree".into(), "prune".into()])?;
    }
    Ok(())
}
fn fs_canonical(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            use std::sync::atomic::{AtomicUsize, Ordering};
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "apex-worktrees-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
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
    fn repo() -> (Temp, PathBuf, PathBuf) {
        let temp = Temp::new();
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
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        fs::write(root.join("seed"), "seed").unwrap();
        run(&["add", "seed"]);
        run(&["commit", "-m", "seed"]);
        let tasks = temp.path().join("agent-data");
        (temp, root, tasks)
    }
    #[test]
    fn list_and_add_new_and_existing_branch() {
        let (_tmp, root, tasks) = repo();
        let first = add(
            &root,
            AddRequest {
                branch: "feature/one".into(),
                new_branch: true,
                base: Some("HEAD".into()),
                folder: None,
            },
        )
        .unwrap();
        assert_eq!(first.branch.as_deref(), Some("feature/one"));
        let rows = list(&root, &tasks).unwrap();
        assert_eq!(rows.items.len(), 2);
        assert!(rows.items[0].main);
        remove(&root, Path::new(&first.path), false, &tasks).unwrap();
        git(&root, &["branch".into(), "feature/two".into()]).unwrap();
        let second = add(
            &root,
            AddRequest {
                branch: "feature/two".into(),
                new_branch: false,
                base: None,
                folder: Some(
                    root.parent()
                        .unwrap()
                        .join("existing")
                        .to_string_lossy()
                        .to_string(),
                ),
            },
        )
        .unwrap();
        assert_eq!(second.branch.as_deref(), Some("feature/two"));
    }
    #[test]
    fn validates_branch_and_folder() {
        let (_tmp, root, _) = repo();
        assert!(add(
            &root,
            AddRequest {
                branch: "bad name".into(),
                new_branch: true,
                base: None,
                folder: None
            }
        )
        .is_err());
        fs::create_dir(root.parent().unwrap().join("taken")).unwrap();
        assert!(add(
            &root,
            AddRequest {
                branch: "okay".into(),
                new_branch: true,
                base: None,
                folder: Some(
                    root.parent()
                        .unwrap()
                        .join("taken")
                        .to_string_lossy()
                        .to_string()
                )
            }
        )
        .unwrap_err()
        .contains("already exists"));
    }
    #[test]
    fn removes_clean_and_requires_force_for_dirty() {
        let (_tmp, root, tasks) = repo();
        let wt = add(
            &root,
            AddRequest {
                branch: "dirty".into(),
                new_branch: true,
                base: None,
                folder: None,
            },
        )
        .unwrap();
        fs::write(Path::new(&wt.path).join("untracked"), "x").unwrap();
        assert!(remove(&root, Path::new(&wt.path), false, &tasks)
            .unwrap_err()
            .starts_with("has-changes:"));
        remove(&root, Path::new(&wt.path), true, &tasks).unwrap();
        assert!(remove(&root, &root, false, &tasks)
            .unwrap_err()
            .contains("main checkout"));
    }
    #[test]
    fn prune_one_keeps_files_and_only_unregisters_selected() {
        let (_tmp, root, tasks) = repo();
        let wt = add(&root, AddRequest { branch: "keep-files".into(), new_branch: true, base: None, folder: None }).unwrap();
        let other = add(&root, AddRequest { branch: "keep-registration".into(), new_branch: true, base: None, folder: None }).unwrap();
        fs::write(Path::new(&wt.path).join("notes"), "unsaved work").unwrap();
        forget(&root, Path::new(&wt.path), true, &tasks).unwrap();
        assert_eq!(fs::read_to_string(Path::new(&wt.path).join("notes")).unwrap(), "unsaved work");
        assert_eq!(fs::read_to_string(Path::new(&wt.path).join("seed")).unwrap(), "seed");
        let rows = list(&root, &tasks).unwrap();
        assert!(!rows.items.iter().any(|r| r.path == wt.path));
        assert!(rows.items.iter().any(|r| r.path == other.path));
    }
    #[test]
    fn prune_one_protects_locked_main_and_task_worktrees() {
        let (_tmp, root, tasks) = repo();
        let wt = add(&root, AddRequest { branch: "prune-locked".into(), new_branch: true, base: None, folder: None }).unwrap();
        git(&root, &["worktree".into(), "lock".into(), wt.path.clone()]).unwrap();
        assert!(forget(&root, Path::new(&wt.path), true, &tasks).is_err());
        assert!(forget(&root, &root, true, &tasks).is_err());
        assert_eq!(fs::read_to_string(Path::new(&wt.path).join("seed")).unwrap(), "seed");
        let task = add(&root, AddRequest { branch: "prune-task".into(), new_branch: true, base: None, folder: Some(tasks.join("job").to_string_lossy().into_owned()) }).unwrap();
        assert!(forget(&root, Path::new(&task.path), true, &tasks).is_err());
        assert!(Path::new(&task.path).exists());
    }
    #[test]
    fn prune_one_missing_does_not_prune_other_missing_worktrees() {
        let (_tmp, root, tasks) = repo();
        let wt = add(&root, AddRequest { branch: "missing-one".into(), new_branch: true, base: None, folder: None }).unwrap();
        let other = add(&root, AddRequest { branch: "missing-two".into(), new_branch: true, base: None, folder: None }).unwrap();
        fs::remove_dir_all(&wt.path).unwrap();
        fs::remove_dir_all(&other.path).unwrap();
        forget(&root, Path::new(&wt.path), false, &tasks).unwrap();
        let rows = list(&root, &tasks).unwrap();
        assert!(!rows.items.iter().any(|r| r.path == wt.path));
        assert!(rows.items.iter().any(|r| r.path == other.path));
    }
    #[test]
    fn delete_removes_folder_and_unregisters() {
        let (_tmp, root, tasks) = repo();
        let wt = add(
            &root,
            AddRequest {
                branch: "gone".into(),
                new_branch: true,
                base: None,
                folder: None,
            },
        )
        .unwrap();
        assert!(Path::new(&wt.path).exists());
        remove(&root, Path::new(&wt.path), false, &tasks).unwrap();
        assert!(!Path::new(&wt.path).exists());
        assert!(!list(&root, &tasks)
            .unwrap()
            .items
            .iter()
            .any(|w| w.path == wt.path));
    }
    #[test]
    fn delete_requires_force_for_dirty_and_protects_main_and_task() {
        let (_tmp, root, tasks) = repo();
        let wt = add(
            &root,
            AddRequest {
                branch: "messy".into(),
                new_branch: true,
                base: None,
                folder: None,
            },
        )
        .unwrap();
        fs::write(Path::new(&wt.path).join("untracked"), "x").unwrap();
        assert!(remove(&root, Path::new(&wt.path), false, &tasks)
            .unwrap_err()
            .starts_with("has-changes:"));
        assert!(Path::new(&wt.path).exists());
        remove(&root, Path::new(&wt.path), true, &tasks).unwrap();
        assert!(!Path::new(&wt.path).exists());
        assert!(remove(&root, &root, true, &tasks)
            .unwrap_err()
            .contains("main checkout"));
    }
    #[test]
    fn delete_respects_locked_worktrees_even_with_force() {
        let (_tmp, root, tasks) = repo();
        let wt = add(&root, AddRequest {
            branch: "locked".into(), new_branch: true, base: None, folder: None,
        }).unwrap();
        git(&root, &["worktree".into(), "lock".into(), wt.path.clone()]).unwrap();
        assert!(remove(&root, Path::new(&wt.path), true, &tasks).is_err());
        assert_eq!(fs::read_to_string(Path::new(&wt.path).join("seed")).unwrap(), "seed");
        assert!(list(&root, &tasks).unwrap().items.iter().any(|w| w.path == wt.path && w.locked));
    }
    #[cfg(unix)]
    #[test]
    fn delete_does_not_follow_a_replaced_worktree_symlink() {
        let (tmp, root, tasks) = repo();
        let wt = add(&root, AddRequest {
            branch: "replaced".into(), new_branch: true, base: None, folder: None,
        }).unwrap();
        let elsewhere = tmp.path().join("unrelated");
        fs::create_dir(&elsewhere).unwrap();
        fs::write(elsewhere.join("keep"), "unrelated work").unwrap();
        fs::remove_dir_all(&wt.path).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &wt.path).unwrap();
        assert!(remove(&root, Path::new(&wt.path), false, &tasks).is_err());
        assert_eq!(fs::read_to_string(elsewhere.join("keep")).unwrap(), "unrelated work");
    }
    #[test]
    fn protects_task_and_prunes_missing() {
        let (_tmp, root, tasks) = repo();
        fs::create_dir_all(&tasks).unwrap();
        let wt = add(
            &root,
            AddRequest {
                branch: "task".into(),
                new_branch: true,
                base: None,
                folder: Some(tasks.join("task-1").to_string_lossy().to_string()),
            },
        )
        .unwrap();
        assert!(remove(&root, Path::new(&wt.path), true, &tasks)
            .unwrap_err()
            .contains("ApexAgent"));
        let outside = add(
            &root,
            AddRequest {
                branch: "missing".into(),
                new_branch: true,
                base: None,
                folder: None,
            },
        )
        .unwrap();
        fs::remove_dir_all(&outside.path).unwrap();
        prune(&root).unwrap();
        assert!(!list(&root, &tasks)
            .unwrap()
            .items
            .iter()
            .any(|w| w.prunable));
    }
    fn init(root: &Path) {
        fs::create_dir_all(root).unwrap();
        let run = |args: &[&str]| {
            git(root, &args.iter().map(|a| a.to_string()).collect::<Vec<_>>()).unwrap();
        };
        run(&["init", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        fs::write(root.join("seed"), "seed").unwrap();
        run(&["add", "seed"]);
        run(&["commit", "-m", "seed"]);
    }
    fn branch_at(branch: &str, folder: PathBuf) -> AddRequest {
        AddRequest {
            branch: branch.into(),
            new_branch: true,
            base: None,
            folder: Some(folder.to_string_lossy().into_owned()),
        }
    }
    fn real(path: PathBuf) -> String {
        fs_canonical(&path).unwrap().to_string_lossy().into_owned()
    }
    #[test]
    fn folder_of_checkouts_lists_each_repository_once() {
        let temp = Temp::new();
        let parent = temp.path().join("projects");
        let tasks = temp.path().join("agent-data");
        init(&parent.join("app"));
        init(&parent.join("tool"));
        init(&parent.join(".hidden"));
        fs::create_dir_all(parent.join("notes")).unwrap();
        add(&parent.join("app"), branch_at("feature", parent.join("app-feature"))).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(parent.join("tool"), parent.join("tool-link")).unwrap();
        let rows = list(&parent, &tasks).unwrap();
        let shown: Vec<(&str, bool)> = rows.items.iter().map(|w| (w.path.as_str(), w.main)).collect();
        let (app, feature, tool) = (real(parent.join("app")), real(parent.join("app-feature")), real(parent.join("tool")));
        assert_eq!(shown, vec![(app.as_str(), true), (feature.as_str(), false), (tool.as_str(), true)]);
        assert_eq!(rows.root, app);
        assert!(rows.items.iter().all(|w| w.changes == Some(0)));
    }
    #[test]
    fn folder_of_checkouts_routes_changes_to_the_owning_repository() {
        let temp = Temp::new();
        let parent = temp.path().join("projects");
        let tasks = temp.path().join("agent-data");
        let (app, tool) = (parent.join("app"), parent.join("tool"));
        init(&app);
        init(&tool);
        // Two of app's checkouts are in the folder, so new worktrees go to app.
        add(&app, branch_at("second", parent.join("app-second"))).unwrap();
        let added = add(&parent, branch_at("from-folder", temp.path().join("app-new"))).unwrap();
        assert!(list(&app, &tasks).unwrap().items.iter().any(|w| w.path == added.path));
        assert!(git(&tool, &["rev-parse".into(), "--verify".into(), "refs/heads/from-folder".into()]).is_err());

        let outside = add(&tool, branch_at("outside", temp.path().join("tool-outside"))).unwrap();
        assert!(list(&parent, &tasks).unwrap().items.iter().any(|w| w.path == outside.path));
        remove(&parent, Path::new(&outside.path), false, &tasks).unwrap();
        assert!(!Path::new(&outside.path).exists());
        assert!(remove(&parent, &tool, false, &tasks).unwrap_err().contains("main checkout"));

        let gone = add(&tool, branch_at("gone", temp.path().join("tool-gone"))).unwrap();
        let missing = add(&app, branch_at("missing", temp.path().join("app-missing"))).unwrap();
        fs::remove_dir_all(&gone.path).unwrap();
        fs::remove_dir_all(&missing.path).unwrap();
        forget(&parent, Path::new(&gone.path), false, &tasks).unwrap();
        let rows = list(&parent, &tasks).unwrap();
        assert!(!rows.items.iter().any(|w| w.path == gone.path));
        assert!(rows.items.iter().any(|w| w.path == missing.path && w.prunable));
        prune(&parent).unwrap();
        assert!(!list(&parent, &tasks).unwrap().items.iter().any(|w| w.prunable));
    }
    #[test]
    fn folder_without_checkouts_is_not_a_repository() {
        let temp = Temp::new();
        let folder = temp.path().join("empty");
        fs::create_dir_all(folder.join("notes")).unwrap();
        assert_eq!(list(&folder, &temp.path().join("agent-data")).unwrap_err(), "This folder isn't a Git repository.");
        assert!(prune(&folder).is_err());
    }
}
