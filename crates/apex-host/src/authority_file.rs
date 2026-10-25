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

/// Where the local fixture keeps a protected document. Production keeps it in
/// the root broker, never at the user-owned path, and legacy user JSON stays at
/// that path untouched. The fixture models the same separation so tests can
/// tell a legacy original from the protected ledger.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn fixture_path(path: &Path) -> std::path::PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".protected-fixture");
    path.with_file_name(name)
}
#[cfg(any(test, feature = "test-support"))]
fn local_read(path: &Path) -> io::Result<Vec<u8>> {
    std::fs::read(fixture_path(path))
}
#[cfg(test)]
pub(crate) fn read(path: &Path) -> io::Result<Vec<u8>> {
    local_read(path)
}
#[cfg(any(test, feature = "test-support"))]
fn local_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let path = &fixture_path(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("authority-{}.pending", std::process::id()));
    let result = (|| -> io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)?;
        #[cfg(unix)]
        std::fs::File::open(path.parent().unwrap())?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        // A failed write must not leave an uncommitted temp file behind.
        let _ = std::fs::remove_file(&temp);
    }
    result
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
    // Protected host ownership holds stable root-owned kernel locks across the
    // host lifetime. The broker also rejects writes from a stale revision.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn fixture_updates_replace_protected_document_without_touching_legacy_file() {
        let dir = std::env::temp_dir().join(format!(
            "apex-authority-file-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("assistant-tasks-v1.json");
        std::fs::write(&path, b"legacy").unwrap();
        write(&path, b"first").unwrap();
        write(&path, b"replacement").unwrap();
        assert_eq!(read(&path).unwrap(), b"replacement");
        assert_eq!(std::fs::read(&path).unwrap(), b"legacy");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(fixture_path(&path)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
