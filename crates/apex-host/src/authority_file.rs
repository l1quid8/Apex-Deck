//! These are authority-bearing ledgers, not ordinary editable project files.
//! Production reads/writes only the root broker. Existing user JSON is retained
//! untouched and is NEVER auto-certified as a trusted migration.
#[cfg(not(test))]
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use std::{io, path::Path};
#[cfg(not(test))]
static REVISIONS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();

#[cfg(any(test, feature = "test-support"))]
fn local_read(path: &Path) -> io::Result<Vec<u8>> {
    std::fs::read(path)
}
#[cfg(test)]
pub(crate) fn read(path: &Path) -> io::Result<Vec<u8>> {
    local_read(path)
}
#[cfg(any(test, feature = "test-support"))]
fn local_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("authority-{}.pending", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(temp, path)?;
    std::fs::File::open(path.parent().unwrap())?.sync_all()
}
#[cfg(test)]
pub(crate) fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    local_write(path, bytes)
}
#[cfg(not(test))]
fn error(e: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, e)
}
#[cfg(not(test))]
fn scope(path: &Path) -> io::Result<(PathBuf, String)> {
    let parent = path
        .parent()
        .ok_or_else(|| error("Ledger has no parent".into()))?;
    std::fs::create_dir_all(parent)?;
    Ok((
        parent.canonicalize()?,
        path.file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| error("Invalid ledger name".into()))?
            .into(),
    ))
}
#[cfg(not(test))]
pub(crate) fn read(path: &Path) -> io::Result<Vec<u8>> {
    #[cfg(feature = "test-support")]
    if crate::test_support::isolated(path) {
        return local_read(path);
    }
    let (folder, name) = scope(path)?;
    let doc = apex_provenance::io::document(&folder, &name, None).map_err(error)?;
    REVISIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| error("Ledger lock poisoned".into()))?
        .insert(folder.join(name), doc.revision);
    if doc.value.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "No protected ledger exists. Legacy user JSON has not been certified.",
        ));
    }
    serde_json::to_vec(&doc.value).map_err(|e| error(e.to_string()))
}
#[cfg(not(test))]
pub(crate) fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    #[cfg(feature = "test-support")]
    if crate::test_support::isolated(path) {
        return local_write(path, bytes);
    }
    let (folder, name) = scope(path)?;
    // A production host owns one instance per data directory (daemon DataLock).
    // The broker additionally rejects writes from another daemon's stale read.
    let mut revisions = REVISIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| error("Ledger lock poisoned".into()))?;
    let revision = *revisions
        .get(&folder.join(&name))
        .ok_or_else(|| error("Protected ledger must be read before it is changed".into()))?;
    let value = serde_json::from_slice(bytes).map_err(|e| error(e.to_string()))?;
    let result =
        apex_provenance::io::document(&folder, &name, Some((revision, value))).map_err(error)?;
    revisions.insert(folder.join(name), result.revision);
    Ok(())
}
