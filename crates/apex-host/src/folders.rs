//! Looking through folders on the host, for the folder picker a window shows
//! when the host is on another machine and this Mac's file dialog can't look.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The most names one listing sends; a bigger folder is cut short.
pub const MAX_ENTRIES: usize = 2000;

/// What is in one folder, folders first, each sorted by name.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Folder {
    /// The folder's full path, with links and `..` resolved.
    pub path: String,
    /// The folder it is in; `None` at the top.
    pub parent: Option<String>,
    pub folders: Vec<String>,
    pub files: Vec<String>,
    /// Set when there were more than `MAX_ENTRIES` and the rest were left out.
    pub truncated: bool,
}

/// List the folder at `path`, or at `home` when there is none. A leading `~`
/// is `home` too.
pub fn list(path: Option<&str>, home: Option<PathBuf>) -> Result<Folder, String> {
    let typed = path.map(str::trim).unwrap_or_default();
    let home = || home.clone().unwrap_or_else(|| PathBuf::from("/"));
    let wanted = if typed.is_empty() || typed == "~" {
        home()
    } else if let Some(rest) = typed.strip_prefix("~/") {
        home().join(rest)
    } else if Path::new(typed).is_absolute() {
        PathBuf::from(typed)
    } else {
        return Err("Use a full path, starting with / or ~.".into());
    };
    let shown = wanted.to_string_lossy().into_owned();
    let dir = std::fs::canonicalize(&wanted).map_err(|e| unreadable(&shown, e))?;
    if !dir.is_dir() {
        return Err(format!("{shown} is a file, not a folder."));
    }
    let mut folders = Vec::new();
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| unreadable(&shown, e))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // A link counts as what it points at.
        let is_dir = entry.file_type().is_ok_and(|t| t.is_dir() || (t.is_symlink() && entry.path().is_dir()));
        if is_dir { folders.push(name) } else { files.push(name) }
    }
    let by_name = |a: &String, b: &String| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b));
    folders.sort_by(by_name);
    files.sort_by(by_name);
    let truncated = folders.len() + files.len() > MAX_ENTRIES;
    folders.truncate(MAX_ENTRIES);
    files.truncate(MAX_ENTRIES - folders.len());
    Ok(Folder {
        path: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        folders,
        files,
        truncated,
    })
}

fn unreadable(path: &str, error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => format!("Nothing is at {path}."),
        std::io::ErrorKind::PermissionDenied => format!("You don't have permission to open {path}."),
        _ => format!("Could not open {path}: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("apex-folders-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for folder in ["b-src", "A-docs", ".git"] {
            std::fs::create_dir_all(dir.join(folder)).unwrap();
        }
        std::fs::write(dir.join("readme.md"), "x").unwrap();
        std::fs::write(dir.join("Cargo.toml"), "x").unwrap();
        dir
    }

    fn text(path: &std::path::Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_folder_lists_its_folders_and_files_by_name() {
        let dir = fixture("list");
        let folder = list(Some(&text(&dir)), None).unwrap();
        assert_eq!(folder.path, text(&dir));
        assert_eq!(folder.parent, dir.parent().map(text));
        assert_eq!(folder.folders, vec![".git", "A-docs", "b-src"]);
        assert_eq!(folder.files, vec!["Cargo.toml", "readme.md"]);
        assert!(!folder.truncated);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_link_to_a_folder_is_a_folder() {
        let dir = fixture("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("b-src"), dir.join("linked")).unwrap();
        #[cfg(unix)]
        assert!(list(Some(&text(&dir)), None).unwrap().folders.contains(&"linked".to_string()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn no_path_or_a_tilde_starts_at_home() {
        let dir = fixture("home");
        assert_eq!(list(None, Some(dir.clone())).unwrap().path, text(&dir));
        assert_eq!(list(Some("  "), Some(dir.clone())).unwrap().path, text(&dir));
        assert_eq!(list(Some("~"), Some(dir.clone())).unwrap().path, text(&dir));
        assert_eq!(list(Some("~/b-src"), Some(dir.clone())).unwrap().path, text(&dir.join("b-src")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dot_dot_is_resolved_and_the_root_has_no_parent() {
        let dir = fixture("dots");
        assert_eq!(list(Some(&format!("{}/b-src/..", text(&dir))), None).unwrap().path, text(&dir));
        assert_eq!(list(Some("/"), None).unwrap().parent, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_paths_files_and_relative_paths_are_plain_errors() {
        let dir = fixture("errors");
        let missing = text(&dir.join("nope"));
        assert_eq!(list(Some(&missing), None).unwrap_err(), format!("Nothing is at {missing}."));
        let file = text(&dir.join("readme.md"));
        assert_eq!(list(Some(&file), None).unwrap_err(), format!("{file} is a file, not a folder."));
        assert_eq!(list(Some("src"), None).unwrap_err(), "Use a full path, starting with / or ~.");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_huge_folder_is_cut_short_and_says_so() {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("apex-folders-huge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for n in 0..MAX_ENTRIES + 5 {
            std::fs::write(dir.join(format!("f{n:05}")), "").unwrap();
        }
        let folder = list(Some(&text(&dir)), None).unwrap();
        assert_eq!(folder.files.len(), MAX_ENTRIES);
        assert!(folder.truncated);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
