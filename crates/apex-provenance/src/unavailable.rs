//! A platform without the protected broker has no authority, including ownership.
use std::path::Path;

const UNAVAILABLE: &str = "Protected provenance authority is not supported on this platform";

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
    _unavailable: std::convert::Infallible,
}

impl HostOwnership {
    pub fn acquire(_data_dir: &Path) -> Result<Self, HostOwnershipError> {
        Err(HostOwnershipError::Unavailable(UNAVAILABLE.into()))
    }
}

pub fn prepare_host_lock(
    _uid: u32,
    _folder: &str,
    _nonce: &str,
    _trusted_daemon: bool,
) -> Result<serde_json::Value, String> {
    Err(UNAVAILABLE.into())
}

pub mod io {
    use super::{Path, UNAVAILABLE};
    use crate::{ProtectedDocument, Receipt, Signed};
    use serde_json::Value;

    pub fn root_file(_path: &Path) -> Result<Vec<u8>, String> {
        Err(UNAVAILABLE.into())
    }

    pub fn root_file_limit(_path: &Path, _limit: usize) -> Result<Vec<u8>, String> {
        Err(UNAVAILABLE.into())
    }

    pub fn consume(_signed: &Signed, _data_dir: &Path) -> Result<Receipt, String> {
        Err(UNAVAILABLE.into())
    }

    pub fn document(
        _data_dir: &Path,
        _name: &str,
        _write: Option<(u64, Value)>,
    ) -> Result<ProtectedDocument, String> {
        Err(UNAVAILABLE.into())
    }

    pub fn finish(_data_dir: &Path, _key_id: &str, _error: Option<&str>) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Signed;
    use std::{path::Path, sync::atomic::{AtomicU64, Ordering}};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn unsupported_ownership_does_not_create_host_directories() {
        let path = std::env::temp_dir().join(format!(
            "apex-unavailable-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let result = HostOwnership::acquire(&path);
        let created = path.exists();
        if created {
            std::fs::remove_dir_all(&path).unwrap();
        }
        assert!(!created, "unsupported authority created a host scope");
        assert!(matches!(result, Err(HostOwnershipError::Unavailable(_))));
    }

    #[test]
    fn unsupported_authority_refuses_every_operation_before_inspecting_inputs() {
        let path = Path::new("missing-protected-scope");
        let signed = Signed { payload: String::new(), signature: String::new() };
        let errors = [
            io::root_file(path).unwrap_err(),
            io::root_file_limit(path, 1).unwrap_err(),
            io::consume(&signed, path).unwrap_err(),
            io::document(path, "assistant-tasks-v1.json", None).unwrap_err(),
            io::document(path, "assistant-tasks-v1.json", Some((0, serde_json::json!({})))).unwrap_err(),
            io::finish(path, "receipt", None).unwrap_err(),
            prepare_host_lock(0, "invalid", "invalid", true).unwrap_err(),
        ];
        for error in errors {
            assert!(error.contains("not supported on this platform"), "{error}");
        }
    }
}
