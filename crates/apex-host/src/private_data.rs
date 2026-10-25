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
pub use windows::{create_private_file, prepare};

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
