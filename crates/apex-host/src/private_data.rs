//! User-private data roots and newly created secret files.
//!
//! Preparing a Windows root changes that directory only. Existing child ACLs
//! are preserved; this is not a repair operation for an arbitrary data tree.

#[cfg(not(windows))]
use std::path::Path;

#[cfg(windows)]
#[path = "private_data/windows.rs"]
mod windows;

#[cfg(windows)]
pub use windows::{create_private_dir, create_private_file, prepare};

/// Create the host data root and remove group/other access on Unix.
#[cfg(not(windows))]
pub fn prepare(data: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(data, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Create a new directory only the current user can open. Refuses a path that
/// already exists, so a pre-planted folder or link is never reused.
#[cfg(not(windows))]
pub fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        // Set at creation so there is no window with wider permissions.
        builder.mode(0o700);
    }
    builder.create(path)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn private_dir_is_owner_only_and_refuses_existing_paths() {
        use std::os::unix::fs::PermissionsExt;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let parent = std::env::temp_dir().join(format!(
            "apx-private-dir-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&parent).unwrap();
        let path = parent.join("scratch");
        create_private_dir(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode & 0o077, 0, "group/other must have no access, got {mode:o}");
        assert_eq!(
            create_private_dir(&path).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        std::os::unix::fs::symlink(&parent, parent.join("link")).unwrap();
        assert!(create_private_dir(&parent.join("link")).is_err());
        std::fs::remove_dir_all(parent).unwrap();
    }
}
