//! Where `/export` writes: the Downloads folder, never over an existing file.

use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

/// Only plain, visible file names may be written inside the export folder.
pub fn safe_file_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', '\0']) {
        return Err("that is not a usable file name".into());
    }
    Ok(name.to_string())
}

fn numbered_name(name: &str, number: u64) -> String {
    if number == 1 {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem, format!(".{ext}")),
        None => (name, String::new()),
    };
    format!("{stem} ({number}){ext}")
}

/// Reserve and write a unique path atomically, retrying collisions without
/// opening or overwriting existing files, including during concurrent exports.
pub fn write_export(dir: &Path, name: &str, contents: &str) -> Result<PathBuf, String> {
    let name = safe_file_name(name)?;
    for number in 1..=u64::MAX {
        let path = dir.join(numbered_name(&name, number));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(contents.as_bytes())
                    .map_err(|e| format!("Could not save the export: {e}"))?;
                return Ok(path);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not save the export: {error}")),
        }
    }
    Err("Could not find an unused export file name".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "apex-export-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn names_that_could_leave_the_folder_are_refused() {
        for name in ["../x.md", "a/b.md", "a\\b.md", ".hidden", "  ", "a\0b.md"] {
            assert!(safe_file_name(name).is_err());
        }
        assert_eq!(
            safe_file_name(" Thread 2026-10-03.md ").unwrap(),
            "Thread 2026-10-03.md"
        );
    }

    #[test]
    fn existing_files_are_never_overwritten() {
        let dir = temp_dir();
        std::fs::write(dir.join("t.md"), "a").unwrap();
        std::fs::write(dir.join("t (2).md"), "b").unwrap();
        assert_eq!(
            write_export(&dir, "t.md", "c").unwrap(),
            dir.join("t (3).md")
        );
        assert_eq!(std::fs::read_to_string(dir.join("t.md")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(dir.join("t (2).md")).unwrap(), "b");
        assert_eq!(std::fs::read_to_string(dir.join("t (3).md")).unwrap(), "c");
        assert_eq!(write_export(&dir, "new", "d").unwrap(), dir.join("new"));
        assert_eq!(write_export(&dir, "new", "e").unwrap(), dir.join("new (2)"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_exports_reserve_distinct_files() {
        let dir = temp_dir();
        let threads: Vec<_> = (0..8)
            .map(|n| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    let text = n.to_string();
                    let path = write_export(&dir, "t.json", &text).unwrap();
                    (path, text)
                })
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        let paths: std::collections::HashSet<_> = results.iter().map(|(p, _)| p).collect();
        assert_eq!(paths.len(), 8);
        for (path, text) in results {
            assert_eq!(std::fs::read_to_string(path).unwrap(), text);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
