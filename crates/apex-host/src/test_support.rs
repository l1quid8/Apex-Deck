//! Opt-in dependency-test fixtures. Production construction remains broker-only.
//! No wire command, environment variable or CLI option calls this module.
use crate::{Host, HostPaths};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
static ROOTS: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();
pub fn isolated_host_assuming_verified_ui(
    paths: HostPaths,
    runtime: tokio::runtime::Handle,
) -> Arc<Host> {
    std::fs::create_dir_all(&paths.data).unwrap();
    let root = paths.data.canonicalize().unwrap();
    let temporary = std::env::temp_dir().canonicalize().unwrap();
    assert!(
        root.starts_with(&temporary) && root != temporary,
        "Isolated fixtures must use their own temporary directory"
    );
    ROOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(root);
    Host::new(paths, runtime)
}
pub(crate) fn isolated(path: &Path) -> bool {
    // Resolve the nearest existing ancestor; filenames need not exist yet.
    let mut base = path;
    while !base.exists() {
        let Some(parent) = base.parent() else {
            return false;
        };
        base = parent;
    }
    let Ok(base) = base.canonicalize() else {
        return false;
    };
    ROOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .iter()
        .any(|root| base.starts_with(root))
}
