//! Lower-writable folder taint and Full-gate acceptance.
//! Single copy used by both apex-host and apex-adapters per Task 6.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const FILE: &str = "folder-trust.json";
const REFUSAL: &str = "This folder has agents with lower access writing to it. A Full agent here can run code they wrote, now or later, as you.";
// A daemon owns its data folder; this also serializes all room/adapter tasks
// within that owner, across the entire read-modify-persist transaction.
static STORE_WRITES: Mutex<()> = Mutex::new(());
static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

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
    load_store_checked(data).unwrap_or_default()
}

fn load_store_checked(data: &Path) -> Result<Store, String> {
    let path = data_path(data);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Store::default()),
        Err(e) => return Err(format!("could not read folder trust: {e}")),
    };
    serde_json::from_slice(&bytes).map_err(|e| format!("could not read folder trust: {e}"))
}

fn save_store(data: &Path, store: &Store) -> Result<(), String> {
    let path = data_path(data);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}-{}", std::process::id(), NEXT_WRITE.fetch_add(1, Ordering::Relaxed)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&tmp).map_err(|e| format!("could not create trust store: {e}"))?;
    let saved = (|| {
        file.write_all(format!("{text}\n").as_bytes()).map_err(|e| format!("could not write trust store: {e}"))?;
        file.sync_all().map_err(|e| format!("could not sync trust store: {e}"))?;
        drop(file);
        std::fs::rename(&tmp, &path).map_err(|e| format!("could not commit trust store: {e}"))?;
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            std::fs::File::open(parent).and_then(|directory| directory.sync_all())
                .map_err(|e| format!("could not sync folder trust directory: {e}"))?;
        }
        Ok(())
    })();
    if saved.is_err() { let _ = std::fs::remove_file(&tmp); }
    saved
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

/// Acceptance covers only the accepted folder and its descendants. Unlike
/// taint, it cannot flow upwards to expose a separately tainted sibling.
fn covers(accepted: &Path, folder: &Path) -> bool {
    match (std::fs::canonicalize(accepted), std::fs::canonicalize(folder)) {
        (Ok(accepted), Ok(folder)) => folder.starts_with(accepted),
        _ => false,
    }
}

/// Record a lower-writable folder as tainted, before its jail starts. Sync to disk.
pub fn mark_tainted(data: &Path, folder: &Path) -> Result<(), String> {
    let _write = STORE_WRITES.lock().map_err(|_| "folder trust writes are unavailable")?;
    let resolved = canonical_or_original(folder);
    let mut store = load_store_checked(data)?;
    if store.tainted.iter().any(|t| t == &resolved) {
        return Ok(());
    }
    store.tainted.push(resolved);
    let mut seen = HashSet::new();
    store.tainted.retain(|p| seen.insert(p.clone()));
    save_store(data, &store)
}

pub fn tainted_folders(data: &Path) -> Vec<PathBuf> {
    load_store(data).tainted
}

pub fn is_tainted(data: &Path, folder: &Path) -> bool {
    is_tainted_checked(data, folder).unwrap_or(true)
}

pub fn is_tainted_checked(data: &Path, folder: &Path) -> Result<bool, String> {
    let store = load_store_checked(data)?;
    Ok(store.tainted.iter().any(|t| overlaps(t, folder)))
}

pub fn is_accepted(data: &Path, folder: &Path) -> bool {
    load_store_checked(data).is_ok_and(|store| store.accepted.iter().any(|a| covers(&a.path, folder)))
}

pub fn list_accepted(data: &Path) -> Vec<(PathBuf, Option<String>, u64)> {
    load_store(data).accepted.into_iter().map(|a| (a.path, a.who, a.when_ms)).collect()
}

pub fn accept(data: &Path, folder: &Path, who: Option<String>) -> Result<(), String> {
    let _write = STORE_WRITES.lock().map_err(|_| "folder trust writes are unavailable")?;
    let resolved = canonical_or_original(folder);
    let mut store = load_store_checked(data)?;
    if !store.accepted.iter().any(|a| a.path == resolved) {
        store.accepted.push(Accepted { path: resolved, who, when_ms: now_ms() });
    }
    save_store(data, &store)
}

pub fn withdraw(data: &Path, folder: &Path) -> Result<(), String> {
    let _write = STORE_WRITES.lock().map_err(|_| "folder trust writes are unavailable")?;
    let resolved = canonical_or_original(folder);
    let mut store = load_store_checked(data)?;
    store.accepted.retain(|a| !overlaps(&a.path, &resolved));
    save_store(data, &store)
}

pub fn check_full_allowed(data: &Path, folder: &Path) -> Result<(), String> {
    let store = load_store_checked(data)?;
    let tainted = store.tainted.iter().any(|t| overlaps(t, folder));
    if !tainted {
        return Ok(());
    }
    let accepted = store.accepted.iter().any(|a| covers(&a.path, folder));
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

    #[test]
    fn accepting_child_does_not_authorize_parent_or_tainted_sibling() {
        let t = tmp();
        let repo = t.0.join("repo");
        let safe = repo.join("safe");
        let evil = repo.join("evil");
        std::fs::create_dir_all(&safe).unwrap();
        std::fs::create_dir_all(&evil).unwrap();
        mark_tainted(&t.0, &evil).unwrap();
        accept(&t.0, &safe, Some("user".into())).unwrap();

        assert!(!is_accepted(&t.0, &repo), "acceptance must cover the entire execution folder");
        assert!(check_full_allowed(&t.0, &repo).is_err());
        assert!(check_full_allowed(&t.0, &evil).is_err());
        assert!(check_full_allowed(&t.0, &safe).is_ok());
        accept(&t.0, &repo, Some("user".into())).unwrap();
        assert!(check_full_allowed(&t.0, &repo).is_ok());
        assert!(check_full_allowed(&t.0, &evil).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn accepted_alias_covers_descendants_but_never_its_parent() {
        let t = tmp();
        let repo = t.0.join("repo");
        let child = repo.join("child");
        let descendant = child.join("nested");
        std::fs::create_dir_all(&descendant).unwrap();
        let alias = t.0.join("alias");
        std::os::unix::fs::symlink(&child, &alias).unwrap();
        mark_tainted(&t.0, &repo).unwrap();
        accept(&t.0, &alias, Some("user".into())).unwrap();

        assert!(check_full_allowed(&t.0, &descendant).is_ok());
        assert!(is_accepted(&t.0, &child));
        assert!(!is_accepted(&t.0, &repo));
        assert!(check_full_allowed(&t.0, &repo).is_err());
    }

    #[test]
    fn unreadable_trust_store_does_not_authorize_full_execution() {
        let t = tmp();
        let folder = t.0.join("project");
        std::fs::create_dir_all(&folder).unwrap();
        mark_tainted(&t.0, &folder).unwrap();
        std::fs::write(data_path(&t.0), b"{incomplete").unwrap();
        assert!(check_full_allowed(&t.0, &folder).is_err());
        assert!(!is_accepted(&t.0, &folder));
    }

    #[test]
    fn concurrent_taint_writers_preserve_every_record() {
        let t = tmp();
        let data = t.0.join("data");
        let folders: Vec<_> = (0..16).map(|i| {
            let folder = t.0.join(format!("project-{i}"));
            std::fs::create_dir_all(&folder).unwrap();
            folder
        }).collect();
        let ready = std::sync::Arc::new(std::sync::Barrier::new(folders.len()));
        std::thread::scope(|scope| {
            let writers: Vec<_> = folders.iter().map(|folder| {
                let ready = ready.clone();
                let data = &data;
                scope.spawn(move || { ready.wait(); mark_tainted(data, folder) })
            }).collect();
            for writer in writers { writer.join().unwrap().unwrap(); }
        });
        assert_eq!(tainted_folders(&data).len(), 16, "a concurrent update must never discard a taint record");
        for folder in folders { assert!(check_full_allowed(&data, &folder).is_err()); }
    }
}
