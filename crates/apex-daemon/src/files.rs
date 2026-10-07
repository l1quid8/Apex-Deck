//! Files only this user may read, written so a reader never sees half of one.

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// Write `contents` to `path` with mode 0600, by writing a temporary file
/// beside it and renaming it into place. The folder is synced after the
/// rename, so a crash right after this returns can't undo it.
pub fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    write_private_then(path, contents, sync_folder)
}

/// `write_private`, with what syncs the folder after the rename passed in.
fn write_private_then(path: &Path, contents: &str, sync: impl FnOnce(&Path) -> std::io::Result<()>) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let write = || -> std::io::Result<()> {
        let _ = std::fs::remove_file(&temporary);
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        sync(path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new(".")))
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        format!("could not write {}: {e}", path.display())
    })
}

/// Make a folder's entries (a rename into it) durable.
fn sync_folder(folder: &Path) -> std::io::Result<()> {
    std::fs::File::open(folder)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("apex-daemon-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_folder_is_synced_after_the_file_is_in_place() {
        let dir = folder("sync");
        let path = dir.join("devices.json");
        let mut synced = None;
        write_private_then(&path, "new", |folder| {
            synced = Some((folder.to_path_buf(), std::fs::read_to_string(&path).unwrap()));
            Ok(())
        })
        .unwrap();
        assert_eq!(synced, Some((dir.clone(), "new".to_string())));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_write_leaves_no_temporary_file() {
        let dir = folder("fail");
        let path = dir.join("devices.json");
        let error = write_private_then(&path, "new", |_| Err(std::io::Error::other("disk gone"))).unwrap_err();
        assert!(error.contains("disk gone"), "{error}");
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).filter(|n| n.to_string_lossy().contains("tmp-")).collect();
        assert!(left.is_empty(), "{left:?}");
        // A rename that fails (the target is a folder) leaves none either.
        std::fs::create_dir_all(dir.join("taken")).unwrap();
        std::fs::write(dir.join("taken/x"), "").unwrap();
        assert!(write_private(&dir.join("taken"), "x").is_err());
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).filter(|n| n.to_string_lossy().contains("tmp-")).collect();
        assert!(left.is_empty(), "{left:?}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
