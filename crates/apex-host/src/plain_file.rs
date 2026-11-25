//! The user's own JSON records in the data folder, for state that grants
//! nothing (which task folder an agent works in, which cards were dismissed).
//! They stay out of the protected store: its root broker keeps only the
//! ledgers it lists and refuses any other name, even a read.

use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;

/// The saved record, or `None` when there is none yet.
pub(crate) fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| format!("Could not read {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// Replaces the file in one rename, so a crash leaves the old record or the
/// new one. Callers hold their own lock, so one temporary name per process is enough.
pub(crate) fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = path.with_file_name(format!("{name}.tmp-{}", std::process::id()));
    std::fs::write(&temp, bytes).map_err(|e| format!("Could not write {}: {e}", temp.display()))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Could not save {}: {e}", path.display())
    })
}
