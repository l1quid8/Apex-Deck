// SPDX-License-Identifier: Apache-2.0
//! `apex-daemon allow-root …`: the folders a paired phone may turn a chat into
//! a Work thread inside.
//!
//! Only the machine's own user runs this, on the machine. A Linux daemon has no
//! signed receipt to check for a phone's "Move to a Work thread", so this file
//! is the authorization: a phone may name a folder, but only inside one listed
//! here. The daemon reads it fresh on every move, so no restart is needed.

use std::path::PathBuf;

use apex_host::storage::Store;

use crate::paths;

pub const USAGE: &str = "\
usage: apex-daemon allow-root <folder>
       apex-daemon allow-root list
       apex-daemon allow-root remove <folder> [--data-dir PATH]

  <folder>         allow a phone to turn a chat into a Work thread in this
                   folder or any folder inside it (stored as a full path, so
                   add the folder you actually mean)
  list             show the folders allowed on this machine
  remove <folder>  stop allowing one
  --data-dir PATH  where chats and settings live (default: the desktop app's folder)

Nothing a phone sends can add a folder here. Only this command, run on the
machine, can.";

/// What `allow-root` was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowRootAction {
    Add(PathBuf),
    List,
    Remove(PathBuf),
    Help,
}

pub fn parse(args: &[String]) -> Result<AllowRootAction, String> {
    let Some(first) = args.first().map(String::as_str) else { return Ok(AllowRootAction::Help) };
    match first {
        "-h" | "--help" => Ok(AllowRootAction::Help),
        "list" => Ok(AllowRootAction::List),
        "remove" => match args.get(1) {
            Some(folder) => Ok(AllowRootAction::Remove(PathBuf::from(folder))),
            None => Err("remove needs a folder".into()),
        },
        folder => Ok(AllowRootAction::Add(PathBuf::from(folder))),
    }
}

pub fn run(data_dir: Option<PathBuf>, action: AllowRootAction) -> Result<(), String> {
    if action == AllowRootAction::Help {
        println!("{USAGE}");
        return Ok(());
    }
    let paths = paths::host_paths(data_dir)?;
    let store = Store::new(paths.data.join("saved-chats-v1"));
    match action {
        AllowRootAction::List => {
            let roots = store.promote_roots()?;
            if roots.roots.is_empty() {
                println!("No folders are allowed for phone moves on this machine.");
                println!("Add one with: apex-daemon allow-root <folder>");
                return Ok(());
            }
            println!("Folders a paired phone may turn a chat into a Work thread inside:");
            for root in roots.roots {
                println!("  {}", root.path);
            }
            Ok(())
        }
        AllowRootAction::Add(folder) => {
            let root = store.allow_promote_root(&folder)?;
            println!("Allowed phone moves into {}", root.path);
            println!("A paired phone can now turn a chat into a Work thread there, or in a folder inside it.");
            println!("Undo with: apex-daemon allow-root remove {}", root.path);
            Ok(())
        }
        AllowRootAction::Remove(folder) => {
            let shown = folder.display().to_string();
            if store.remove_promote_root(&folder)? {
                println!("No longer allowed: {shown}");
                Ok(())
            } else {
                Err(format!("{} wasn't on the allowed list. `apex-daemon allow-root list` shows the folders.", shown))
            }
        }
        AllowRootAction::Help => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reads_add_list_remove_and_help() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(parse(&args(&["/srv/projects"])), Ok(AllowRootAction::Add(PathBuf::from("/srv/projects"))));
        assert_eq!(parse(&args(&["list"])), Ok(AllowRootAction::List));
        assert_eq!(parse(&args(&["remove", "/srv/projects"])), Ok(AllowRootAction::Remove(PathBuf::from("/srv/projects"))));
        assert_eq!(parse(&args(&[])), Ok(AllowRootAction::Help));
        assert_eq!(parse(&args(&["--help"])), Ok(AllowRootAction::Help));
        assert_eq!(parse(&args(&["remove"])), Err("remove needs a folder".into()));
    }
}
