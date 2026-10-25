//! Worktrees tab integration for bot copies and project checks.
use crate::{
    bot_copies::{self, BotCopy, CopyState},
    project_check,
    storage::Store,
    worktrees::{self, CopyInfo, WorktreeList},
};
use std::{path::Path, process::Command};

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
fn same(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}
fn valid_copy(data: &Path, copy: &BotCopy) -> bool {
    let valid = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    };
    valid(&copy.thread)
        && valid(&copy.bot)
        && copy.work
            == data
                .join("bot-copies")
                .join(&copy.thread)
                .join(&copy.bot)
                .join("work")
}
pub fn list(root: &Path, data: &Path) -> Result<WorktreeList, String> {
    let mut listing = worktrees::list(root, &data.join("apex-agent/tasks"))?;
    let copies = bot_copies::load_copies(data);
    for row in &mut listing.items {
        if let Some(copy) = copies
            .iter()
            .find(|c| valid_copy(data, c) && same(Path::new(&row.path), &c.work))
        {
            let (state, reason) = match &copy.state {
                CopyState::Working => ("working", None),
                CopyState::Folding => ("folding", None),
                CopyState::Reconciling { .. } => ("reconciling", None),
                CopyState::NeedsYou { reason } => ("needs_you", Some(reason.clone())),
                CopyState::Folded => ("folded", None),
            };
            row.copy = Some(CopyInfo {
                bot: copy.bot.clone(),
                thread_title: copy.thread.clone(),
                state: state.into(),
                reason,
            });
            // Count against the hidden base, even if the bot committed its edits.
            row.changes = bot_copies::snapshot_tree_id(&copy.work)
                .ok()
                .and_then(|tree| {
                    git(
                        &copy.work,
                        &[
                            "diff-tree",
                            "-r",
                            "--no-commit-id",
                            "--name-only",
                            "-z",
                            &copy.base,
                            &tree,
                        ],
                    )
                    .ok()
                })
                .map(|out| out.split(|b| *b == 0).filter(|p| !p.is_empty()).count() as u32);
        }
    }
    listing.check_command = project_check::resolve_check(data, Path::new(&listing.root));
    Ok(listing)
}
pub fn label_copies(listing: &mut WorktreeList, store: &Store) {
    let session = store.session().ok().flatten();
    for row in &mut listing.items {
        let Some(info) = &mut row.copy else { continue };
        if let Ok(Some(room)) = store.room(&info.thread_title) {
            if let Some(bot) = room
                .snapshot
                .participants
                .iter()
                .find(|p| p.id.as_str() == info.bot)
            {
                info.bot = bot.display_name.clone();
            }
        }
        if let Some(title) = session
            .as_ref()
            .and_then(|s| s.get("panes"))
            .and_then(|p| p.as_array())
            .and_then(|panes| {
                panes
                    .iter()
                    .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(&info.thread_title))
            })
            .and_then(|p| p.get("title"))
            .and_then(|v| v.as_str())
        {
            info.thread_title = title.into();
        }
    }
}
/// Discard is explicit, confirmed, and limited to stalled copies of this repository.
pub fn remove(root: &Path, target: &Path, force: bool, data: &Path) -> Result<(), String> {
    let listing = list(root, data)?;
    if !listing
        .items
        .iter()
        .any(|r| same(Path::new(&r.path), target))
    {
        return Err("That folder is not a worktree for this project.".into());
    }
    let copy = bot_copies::load_copies(data)
        .into_iter()
        .find(|c| valid_copy(data, c) && same(&c.work, target));
    let Some(copy) = copy else {
        if target.starts_with(data.join("bot-copies")) {
            return Err("Copy metadata is missing; the folder has been kept.".into());
        }
        return worktrees::remove(root, target, force, &data.join("apex-agent/tasks"));
    };
    if !matches!(copy.state, CopyState::NeedsYou { .. }) {
        return Err("Deck manages this active bot copy. Wait until it needs you.".into());
    }
    if !force {
        return Err("has-changes:Discard this copy and all its changes?".into());
    }
    if std::fs::symlink_metadata(&copy.work).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("The copy folder was replaced.".into());
    }
    git(
        root,
        &[
            "worktree",
            "remove",
            "--force",
            "--force",
            copy.work.to_str().ok_or("Invalid copy path")?,
        ],
    )?;
    git(
        root,
        &[
            "update-ref",
            "-d",
            &format!("refs/apex-copies/{}/{}/base", copy.thread, copy.bot),
        ],
    )?;
    std::fs::remove_dir_all(copy.work.parent().ok_or("Invalid copy path")?)
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn set_check(root: &Path, data: &Path, cmd: Option<String>) -> Result<(), String> {
    let listing = worktrees::list(root, &data.join("apex-agent/tasks"))?;
    project_check::save_check(
        data,
        Path::new(&listing.root),
        cmd.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::bot_copies::{create_copy, save_state, CopyState};
    use std::{fs, path::PathBuf, process::Command};
    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let tmp = std::env::temp_dir().join(format!(
            "apex-copy-ui-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let root = tmp.join("repo");
        let data = tmp.join("data");
        fs::create_dir_all(&root).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.com"],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success());
        }
        fs::write(root.join("seed"), "seed").unwrap();
        for args in [vec!["add", "seed"], vec!["commit", "-m", "seed"]] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success());
        }
        (tmp, root, data)
    }
    #[test]
    fn parse_list_marks_bot_copies() {
        let (tmp, root, data) = fixture();
        let copy = create_copy(&root, &data, "thread", "forge").unwrap();
        fs::write(copy.work.join("changed"), "new").unwrap();
        let rows = list(&root, &data).unwrap();
        let row = rows
            .items
            .iter()
            .find(|r| same(Path::new(&r.path), &copy.work))
            .unwrap();
        let info = row.copy.as_ref().unwrap();
        assert_eq!(info.bot, "forge");
        assert_eq!(info.thread_title, "thread");
        assert_eq!(info.state, "working");
        assert_eq!(row.changes, Some(1));
        fs::remove_dir_all(tmp).unwrap();
    }
    #[test]
    fn saved_check_is_shown_and_empty_disables_guess() {
        let (tmp, root, data) = fixture();
        fs::write(root.join("Cargo.toml"), "[package]").unwrap();
        assert_eq!(
            list(&root, &data).unwrap().check_command.as_deref(),
            Some("cargo check")
        );
        set_check(&root, &data, Some(" npm test ".into())).unwrap();
        assert_eq!(
            list(&root, &data).unwrap().check_command.as_deref(),
            Some("npm test")
        );
        set_check(&root, &data, Some("  ".into())).unwrap();
        assert_eq!(crate::project_check::saved_check(&data, &root), Some(None));
        assert_eq!(list(&root, &data).unwrap().check_command, None);
        fs::remove_dir_all(tmp).unwrap();
    }
    #[test]
    fn remove_refuses_working_copy() {
        let (tmp, root, data) = fixture();
        let copy = create_copy(&root, &data, "thread", "forge").unwrap();
        assert!(remove(&root, &copy.work, true, &data)
            .unwrap_err()
            .contains("active"));
        assert!(copy.work.exists());
        assert_eq!(crate::bot_copies::load_copies(&data).len(), 1);
        assert!(
            worktrees::remove(&root, &copy.work, true, &data.join("apex-agent/tasks")).is_err()
        );
        assert!(
            worktrees::forget(&root, &copy.work, true, &data.join("apex-agent/tasks")).is_err()
        );
        fs::remove_dir_all(tmp).unwrap();
    }
    #[test]
    fn remove_allows_needs_you_copy() {
        let (tmp, root, data) = fixture();
        let mut copy = create_copy(&root, &data, "thread", "forge").unwrap();
        copy.state = CopyState::NeedsYou {
            reason: "clash".into(),
        };
        save_state(&data, &copy).unwrap();
        fs::write(copy.work.join("unsaved"), "keep until confirmed").unwrap();
        assert!(remove(&root, &copy.work, false, &data)
            .unwrap_err()
            .starts_with("has-changes:"));
        assert!(copy.work.exists());
        remove(&root, &copy.work, true, &data).unwrap();
        assert!(!copy.work.exists());
        assert!(crate::bot_copies::load_copies(&data).is_empty());
        fs::remove_dir_all(tmp).unwrap();
    }
}
