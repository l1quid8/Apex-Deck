//! Lower-writable folder taint and Full-gate acceptance.
//! Single copy used by both apex-host and apex-adapters per Task 6.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const FILE: &str = "folder-trust.json";
const REFUSAL: &str = "This folder has bots with lower access writing to it. A Full bot here can run code they wrote, now or later, as you.";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Accepted {
    path: PathBuf,
    who: Option<String>,
    when_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Store {
    #[serde(default)]
    tainted: Vec<PathBuf>,
    #[serde(default)]
    accepted: Vec<Accepted>,
}

fn data_path(data: &Path) -> PathBuf {
    data.join(FILE)
}

fn load_store(data: &Path) -> Store {
    let path = data_path(data);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Store::default(),
        Err(_) => return Store::default(),
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save_store(data: &Path, store: &Store) -> Result<(), String> {
    let path = data_path(data);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, format!("{text}\n")).map_err(|e| format!("could not write trust store: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("could not commit trust store: {e}"))?;
    Ok(())
}

fn canonical_or_original(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn overlaps(a: &Path, b: &Path) -> bool {
    let ca = canonical_or_original(a);
    let cb = canonical_or_original(b);
    if ca == cb {
        return true;
    }
    ca.starts_with(&cb) || cb.starts_with(&ca)
}

/// Record a lower-writable folder as tainted, before its jail starts. Sync to disk.
pub fn mark_tainted(data: &Path, folder: &Path) -> Result<(), String> {
    let resolved = canonical_or_original(folder);
    let mut store = load_store(data);
    if store.tainted.iter().any(|t| t == &resolved) {
        return Ok(());
    }
    store.tainted.push(resolved);
    let mut seen = HashSet::new();
    store.tainted.retain(|p| seen.insert(p.clone()));
    save_store(data, &store)?;
    #[cfg(unix)]
    {
        if let Some(parent) = data_path(data).parent() {
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
    }
    Ok(())
}

pub fn tainted_folders(data: &Path) -> Vec<PathBuf> {
    load_store(data).tainted
}

pub fn is_tainted(data: &Path, folder: &Path) -> bool {
    let store = load_store(data);
    store.tainted.iter().any(|t| overlaps(t, folder))
}

pub fn is_accepted(data: &Path, folder: &Path) -> bool {
    let store = load_store(data);
    store.accepted.iter().any(|a| overlaps(&a.path, folder))
}

pub fn list_accepted(data: &Path) -> Vec<(PathBuf, Option<String>, u64)> {
    load_store(data).accepted.into_iter().map(|a| (a.path, a.who, a.when_ms)).collect()
}

pub fn accept(data: &Path, folder: &Path, who: Option<String>) -> Result<(), String> {
    let resolved = canonical_or_original(folder);
    let mut store = load_store(data);
    if !store.accepted.iter().any(|a| a.path == resolved) {
        store.accepted.push(Accepted { path: resolved, who, when_ms: now_ms() });
    }
    save_store(data, &store)
}

pub fn withdraw(data: &Path, folder: &Path) -> Result<(), String> {
    let resolved = canonical_or_original(folder);
    let mut store = load_store(data);
    store.accepted.retain(|a| !overlaps(&a.path, &resolved));
    save_store(data, &store)
}

pub fn check_full_allowed(data: &Path, folder: &Path) -> Result<(), String> {
    let store = load_store(data);
    let tainted = store.tainted.iter().any(|t| overlaps(t, folder));
    if !tainted {
        return Ok(());
    }
    let accepted = store.accepted.iter().any(|a| overlaps(&a.path, folder));
    if accepted {
        Ok(())
    } else {
        Err(REFUSAL.into())
    }
}

pub fn refusal_message() -> &'static str {
    REFUSAL
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Tmp(PathBuf);
    impl Drop for Tmp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    fn tmp() -> Tmp {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("folder-trust-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }

    #[test]
    fn mark_and_check_and_overlap() {
        let t = tmp();
        let data = &t.0;
        let folder = data.join("proj");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(!is_tainted(data, &folder));
        mark_tainted(data, &folder).unwrap();
        assert!(is_tainted(data, &folder));
        let child = folder.join("sub");
        std::fs::create_dir_all(&child).unwrap();
        assert!(is_tainted(data, &child));
        assert!(check_full_allowed(data, &child).is_err());
        accept(data, &folder, Some("human".into())).unwrap();
        assert!(is_accepted(data, &child));
        assert!(check_full_allowed(data, &child).is_ok());
        withdraw(data, &folder).unwrap();
        assert!(!is_accepted(data, &folder));
    }
}
