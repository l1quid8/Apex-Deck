//! Stable service-owned lock files plus live host-held Windows file locks.
use crate::{io, verify, windows, Signed, DOMAIN};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};
static OWNERS: OnceLock<Mutex<HashMap<PathBuf, Weak<ScopeGuard>>>> = OnceLock::new();
#[derive(Debug)]
pub enum HostOwnershipError {
    Held(String),
    Unavailable(String),
}
impl std::fmt::Display for HostOwnershipError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Held(s) => write!(f, "Protected host ownership is held: {s}"),
            Self::Unavailable(s) => write!(f, "Protected host ownership unavailable: {s}"),
        }
    }
}
impl std::error::Error for HostOwnershipError {}
#[derive(Debug)]
pub struct HostOwnership {
    _scopes: Vec<Arc<ScopeGuard>>,
}
#[derive(Debug)]
pub(crate) struct ScopeGuard {
    _file: File,
}
pub(crate) fn lock_path(sid: &str, folder: &str) -> Result<PathBuf, String> {
    Ok(windows::host_locks(sid)?.join(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(0u32, folder)).map_err(|e| e.to_string())?)
    )))
}
impl HostOwnership {
    pub fn acquire(data_dir: &Path) -> Result<Self, HostOwnershipError> {
        let run = || -> Result<Self, HostOwnershipError> {
            std::fs::create_dir_all(data_dir.join("saved-chats-v1"))
                .map_err(|e| HostOwnershipError::Unavailable(e.to_string()))?;
            let mut registry = OWNERS.get_or_init(Default::default).lock().map_err(|_| {
                HostOwnershipError::Unavailable("Ownership registry poisoned".into())
            })?;
            registry.retain(|_, guard| guard.strong_count() != 0);
            let mut scopes: Vec<(PathBuf, Arc<ScopeGuard>)> = Vec::new();
            for path in [data_dir.to_owned(), data_dir.join("saved-chats-v1")] {
                let canonical = path
                    .canonicalize()
                    .map_err(|e| HostOwnershipError::Unavailable(e.to_string()))?;
                if scopes.iter().any(|(old, _)| old == &canonical) {
                    continue;
                }
                if registry.get(&canonical).and_then(Weak::upgrade).is_some() {
                    return Err(HostOwnershipError::Held(canonical.display().to_string()));
                }
                let prepare = || -> Result<File, String> {
                    let folder = windows::folder(&canonical)?;
                    let nonce = io::challenge()?;
                    let response =
                        io::exchange(&json!({"op":"host_lock","dataDir":folder,"nonce":nonce}))?;
                    let signed: Signed =
                        serde_json::from_value(response).map_err(|e| e.to_string())?;
                    let ack = verify(&io::root_file(&windows::public_path()?)?, &signed)?;
                    if ack
                        != json!({"domain":DOMAIN,"kind":"hostLock","uid":0,"dataDir":folder,"nonce":nonce})
                    {
                        return Err("Host ownership binding mismatch".into());
                    }
                    windows::open_protected(&lock_path(&windows::current_sid()?, &folder)?)
                };
                let file = prepare().map_err(HostOwnershipError::Unavailable)?;
                match file.try_lock() {
                    Ok(()) => (),
                    Err(std::fs::TryLockError::WouldBlock) => {
                        return Err(HostOwnershipError::Held(canonical.display().to_string()))
                    }
                    Err(error) => return Err(HostOwnershipError::Unavailable(error.to_string())),
                }
                scopes.push((canonical, Arc::new(ScopeGuard { _file: file })));
            }
            for (path, guard) in &scopes {
                registry.insert(path.clone(), Arc::downgrade(guard));
            }
            Ok(Self {
                _scopes: scopes.into_iter().map(|(_, guard)| guard).collect(),
            })
        };
        run()
    }
}
pub(crate) fn require(folder: &Path) -> Result<Arc<ScopeGuard>, String> {
    OWNERS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Ownership registry poisoned".to_owned())?
        .get(folder)
        .and_then(Weak::upgrade)
        .ok_or_else(|| "Host does not own this protected provenance scope".into())
}
pub fn prepare_host_lock(
    _uid: u32,
    _folder: &str,
    _nonce: &str,
    _trusted_daemon: bool,
) -> Result<Value, String> {
    Err("Windows locks require authenticated service admission".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unowned_windows_scope_refuses_reads_and_receipts() {
        let root = std::env::temp_dir().join(format!("apex-win-unowned-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(io::document(&root, "room-authority-v1.json", None)
            .unwrap_err()
            .contains("Host does not own"));
        assert!(io::consume(
            &Signed {
                payload: String::new(),
                signature: String::new()
            },
            &root
        )
        .unwrap_err()
        .contains("Host does not own"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
