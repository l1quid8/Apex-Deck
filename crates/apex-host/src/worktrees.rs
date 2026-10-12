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
pub fn list(project: &Path, task_dir: &Path) -> Result<WorktreeList, String> {
    let root = git(project, &["rev-parse".into(), "--show-toplevel".into()])
        .map_err(|_| "This folder isn't a Git repository.".to_string())?
        .trim()
        .to_string();
    let raw = git(
        Path::new(&root),
        &[
            "worktree".into(),
            "list".into(),
            "--porcelain".into(),
            "-z".into(),
        ],
    )?;
    let task_root = fs_canonical(task_dir).unwrap_or_else(|| task_dir.to_path_buf());
    let mut items = parse_list(&raw, &task_root);
    for item in items.iter_mut().filter(|w| !w.prunable).take(50) {
        item.changes = git(
            Path::new(&root),
            &[
                "-C".into(),
                item.path.clone(),
                "status".into(),
                "--porcelain".into(),
            ],
        )
        .ok()
        .map(|s| s.lines().count().min(u32::MAX as usize) as u32);
    }
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
    let current = list(project, Path::new("/__apexagent_task_dir_unavailable__"))?;
    let main = current
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
    let state = list(project, task_dir)?;
    let target = fs_canonical(target).unwrap_or_else(|| target.to_path_buf());
    let row = state
        .items
        .iter()
        .find(|w| {
            fs_canonical(Path::new(&w.path)).unwrap_or_else(|| PathBuf::from(&w.path)) == target
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
pub fn prune(project: &Path) -> Result<(), String> {
    git(project, &["worktree".into(), "prune".into()]).map(|_| ())
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
}
