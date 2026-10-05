//! One owner per data folder. The desktop app and the daemon both keep
//! chats and settings there, and two writers would corrupt them, so each
//! takes this lock first. The kernel lets go of it when the process dies.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, Write};
use std::path::Path;

/// Held while the process owns the data folder.
#[derive(Debug)]
pub struct DataLock {
    _file: File,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LockError {
    /// Another process owns the folder; `owner` is what it wrote about itself.
    Held { owner: String },
    Failed(String),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Held { owner } => write!(f, "the data folder is in use by {owner}"),
            LockError::Failed(why) => write!(f, "could not lock the data folder: {why}"),
        }
    }
}

/// The lock file inside a data folder.
pub const LOCK_FILE: &str = "owner.lock";

impl DataLock {
    /// Take the lock on `data`, describing this process as `owner` (say
    /// "apex-daemon serve (pid 12)") for anyone who finds it taken.
    pub fn acquire(data: &Path, owner: &str) -> Result<DataLock, LockError> {
        let failed = |e: std::io::Error| LockError::Failed(e.to_string());
        std::fs::create_dir_all(data).map_err(failed)?;
        let mut file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(data.join(LOCK_FILE)).map_err(failed)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                let mut owner = String::new();
                let _ = file.read_to_string(&mut owner);
                let owner = if owner.trim().is_empty() { "another program".to_string() } else { owner.trim().to_string() };
                return Err(LockError::Held { owner });
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(failed(e)),
        }
        file.set_len(0).map_err(failed)?;
        file.rewind().map_err(failed)?;
        file.write_all(owner.as_bytes()).map_err(failed)?;
        Ok(DataLock { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("apex-host-lock-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_second_owner_is_told_who_has_the_folder() {
        let data = folder("second");
        let first = DataLock::acquire(&data, "Apex Deck desktop app (pid 1)").unwrap();
        assert_eq!(DataLock::acquire(&data, "apex-daemon serve (pid 2)").unwrap_err(), LockError::Held { owner: "Apex Deck desktop app (pid 1)".into() });
        drop(first);
        let second = DataLock::acquire(&data, "apex-daemon serve (pid 2)").unwrap();
        assert_eq!(DataLock::acquire(&data, "x").unwrap_err(), LockError::Held { owner: "apex-daemon serve (pid 2)".into() });
        drop(second);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_shorter_owner_replaces_a_longer_one_completely() {
        let data = folder("shorter");
        drop(DataLock::acquire(&data, "a very long description of the first owner").unwrap());
        let _lock = DataLock::acquire(&data, "short").unwrap();
        assert_eq!(std::fs::read_to_string(data.join(LOCK_FILE)).unwrap(), "short");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn the_folder_is_made_if_missing() {
        let data = folder("missing").join("nested");
        assert!(DataLock::acquire(&data, "me").is_ok());
        let _ = std::fs::remove_dir_all(data.parent().unwrap());
    }
}
