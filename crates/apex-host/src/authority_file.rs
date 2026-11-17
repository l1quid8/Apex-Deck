//! These are authority-bearing ledgers, not ordinary editable project files.
//! Mac production reads/writes only the root broker. Existing user JSON is
//! retained untouched and is NEVER auto-certified as a trusted migration.
//!
//! Unenrolled Linux scopes retain their existing owner-only plain files. A
//! root-owned availability marker closes enrolled scopes to plain-file fallback;
//! signed broker responses and lifetime host ownership govern protected IO.
//! The marker grants no command authority and never imports legacy JSON.
#[cfg(not(test))]
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use std::{io, path::Path};
#[cfg(all(not(test), target_os = "linux"))]
use std::{
    collections::HashSet,
};
#[cfg(not(test))]
static REVISIONS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();

pub(crate) type Migration = fn(&[u8]) -> serde_json::Result<Vec<u8>>;

#[derive(serde::Deserialize)]
struct DocumentHeader {
    #[serde(default)]
    version: u32,
}

pub(crate) fn decode_versioned<T: serde::de::DeserializeOwned>(
    mut bytes: Vec<u8>, first_version: u32, migrations: &[Migration],
) -> io::Result<T> {
    let mut version = serde_json::from_slice::<DocumentHeader>(&bytes)?.version;
    let migrations = version.checked_sub(first_version)
        .and_then(|index| migrations.get(index as usize..))
        .ok_or_else(|| io::Error::new(
            io::ErrorKind::InvalidData, format!("Unsupported document version {version}"),
        ))?;
    for migrate in migrations {
        bytes = migrate(&bytes)?;
        version += 1;
        if serde_json::from_slice::<DocumentHeader>(&bytes)?.version != version {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid document migration"));
        }
    }
    Ok(serde_json::from_slice(&bytes)?)
}

/// Protected JSON documents keep their existing top-level fields. Each migration
/// maps one stored version to the next. A missing version denotes version zero.
/// Reads migrate in memory so an inspection never rewrites the ledger. The
/// owning store persists the current schema with its next successful mutation.
pub(crate) trait VersionedDocument: serde::Serialize + serde::de::DeserializeOwned {
    const FIRST_VERSION: u32 = 1;
    const MIGRATIONS: &'static [Migration] = &[];
    const PRETTY: bool = false;

    fn decode(bytes: Vec<u8>) -> io::Result<Self> {
        decode_versioned(bytes, Self::FIRST_VERSION, Self::MIGRATIONS)
    }

    fn read_from(path: &Path) -> io::Result<Self> {
        Self::decode(read(path)?)
    }

    fn read_optional(path: &Path) -> io::Result<Option<Self>> {
        match Self::read_from(path) {
            Ok(doc) => Ok(Some(doc)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn write_to(&self, path: &Path) -> io::Result<()> {
        self.write_checked(path, |_| Ok(()))
    }

    fn write_checked(&self, path: &Path, check: impl FnOnce(&[u8]) -> io::Result<()>) -> io::Result<()> {
        let bytes = if Self::PRETTY {
            serde_json::to_vec_pretty(self)?
        } else {
            serde_json::to_vec(self)?
        };
        check(&bytes)?;
        write(path, &bytes)
    }
}

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
    tests::record_read(path);
    local_read(path)
}
#[cfg(any(test, feature = "test-support"))]
fn local_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    atomic_write(&fixture_path(path), bytes)
}
/// Replace `path` in one rename, owner-only, synced to disk.
#[cfg(any(test, feature = "test-support", target_os = "linux"))]
fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
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
    tests::record_write(path);
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
    #[cfg(target_os = "linux")]
    if plain(path) { return plain_read(path); }
    let (folder, name) = scope(path)?;
    let gate = crate::authority_reads::for_document(&folder.join(&name))?;
    gate.read(|| {
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
    })
}
#[cfg(not(test))]
pub(crate) fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    #[cfg(feature = "test-support")]
    if crate::test_support::isolated(path) {
        return local_write(path, bytes);
    }
    #[cfg(target_os = "linux")]
    if plain(path) { return plain_write(path, bytes); }
    let (folder, name) = scope(path)?;
    let gate = crate::authority_reads::for_document(&folder.join(&name))?;
    let _exclusive = gate.write()?;
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
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    thread_local! {
        static READS: std::cell::RefCell<Option<Vec<std::path::PathBuf>>> = const { std::cell::RefCell::new(None) };
        static WRITES: std::cell::RefCell<Option<Vec<std::path::PathBuf>>> = const { std::cell::RefCell::new(None) };
    }

    pub(crate) fn record_write(path: &Path) {
        WRITES.with(|writes| {
            if let Some(writes) = writes.borrow_mut().as_mut() { writes.push(path.to_path_buf()); }
        });
    }

    pub(crate) fn track_writes<T>(f: impl FnOnce() -> T) -> (T, Vec<std::path::PathBuf>) {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) { WRITES.with(|writes| { writes.borrow_mut().take(); }); }
        }
        WRITES.with(|writes| assert!(writes.borrow_mut().replace(vec![]).is_none()));
        let _reset = Reset;
        let result = f();
        let writes = WRITES.with(|writes| writes.borrow_mut().take().unwrap());
        (result, writes)
    }

    pub(crate) fn record_read(path: &Path) {
        READS.with(|reads| {
            if let Some(reads) = reads.borrow_mut().as_mut() { reads.push(path.to_path_buf()); }
        });
    }

    pub(crate) fn track_reads<T>(f: impl FnOnce() -> T) -> (T, Vec<std::path::PathBuf>) {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) { READS.with(|reads| { reads.borrow_mut().take(); }); }
        }
        READS.with(|reads| assert!(reads.borrow_mut().replace(vec![]).is_none()));
        let _reset = Reset;
        let result = f();
        let reads = READS.with(|reads| reads.borrow_mut().take().unwrap());
        (result, reads)
    }

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
/// True when `path` is a Linux production ledger kept as a plain file. Unit
/// tests and registered fixtures keep the Mac rules on every platform.
pub(crate) fn plain(path: &Path) -> bool {
    #[cfg(any(test, not(target_os = "linux")))]
    {
        let _ = path;
        false
    }
    #[cfg(all(not(test), target_os = "linux"))]
    {
        #[cfg(feature = "test-support")]
        if crate::test_support::isolated(path) {
            return false;
        }
        // Existing Linux callers may pass relative data folders. Resolve them
        // without erasing symlink/ancestor evidence used by enrollment pins.
        std::path::absolute(path).ok()
            .and_then(|path| apex_provenance::linux_registration::protected_scope(&path).ok())
            .is_some_and(|protected| !protected)
    }
}
#[cfg(all(not(test), target_os = "linux"))]
fn plain_read(path: &Path) -> io::Result<Vec<u8>> {
    let bytes = std::fs::read(path)?;
    // A fresh read reopens a ledger closed by an earlier failed start.
    if let Ok(mut closed) = CLOSED.get_or_init(Default::default).lock() {
        closed.remove(path);
    }
    Ok(bytes)
}
/// Plain ledgers whose store started empty because they could not be read.
/// Writing one would replace the records it failed to read.
#[cfg(all(not(test), target_os = "linux"))]
static CLOSED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
#[cfg(all(not(test), target_os = "linux"))]
fn plain_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let closed = CLOSED.get_or_init(Default::default).lock()
        .map_err(|_| io::Error::other("Ledger lock poisoned"))?;
    if closed.contains(path) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied,
            "This ledger could not be read, so it stays closed to writes until the host restarts."));
    }
    atomic_write(path, bytes)
}
/// Keep an empty fallback store from writing over a plain ledger it could not
/// read. The Mac broker already refuses writes to a ledger never read.
pub(crate) fn close(path: &Path) {
    #[cfg(all(not(test), target_os = "linux"))]
    if plain(path) {
        if let Ok(mut closed) = CLOSED.get_or_init(Default::default).lock() {
            closed.insert(path.to_path_buf());
        }
    }
    let _ = path;
}
