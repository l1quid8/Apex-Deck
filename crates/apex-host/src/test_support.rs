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
/// Where an isolated fixture keeps the protected document for `ledger`, so a
/// test can tell it apart from legacy user JSON at `ledger` itself.
pub fn protected_fixture_path(ledger: &Path) -> PathBuf {
    crate::authority_file::fixture_path(ledger)
}
pub fn isolated(path: &Path) -> bool {
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

/// An explicitly registered, in-process image adapter. Only verified temporary
/// hosts can register one; compiling test support does not register anything.
/// No wire command, environment variable or user CLI option reaches this seam.
pub struct DeterministicAvatarAdapter {
    calls: std::sync::atomic::AtomicUsize,
}
impl DeterministicAvatarAdapter {
    pub fn calls(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub(crate) fn generate(
        &self,
        owner: &crate::assistant_avatar::Owner,
        generation: &str,
        prompt: &str,
    ) -> Result<Vec<u8>, String> {
        use sha2::{Digest, Sha256};
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let hash = Sha256::digest(
            serde_json::to_vec(&(owner, generation, prompt)).map_err(|e| e.to_string())?,
        );
        let mut pixels = image::RgbImage::new(64, 64);
        for (x, y, pixel) in pixels.enumerate_pixels_mut() {
            let index = ((x / 8 + y / 8) % 8) as usize;
            *pixel = image::Rgb([hash[index], hash[index + 8], hash[index + 16]]);
        }
        let mut out = std::io::Cursor::new(vec![]);
        image::DynamicImage::ImageRgb8(pixels)
            .write_to(&mut out, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(out.into_inner())
    }
}
static IMAGE_ADAPTERS: OnceLock<
    Mutex<std::collections::HashMap<PathBuf, Arc<DeterministicAvatarAdapter>>>,
> = OnceLock::new();
pub fn register_deterministic_avatar_adapter(
    host: &Host,
) -> Result<Arc<DeterministicAvatarAdapter>, String> {
    if !isolated(host.data_dir()) {
        return Err(
            "Deterministic images require an explicitly verified temporary fixture host.".into(),
        );
    }
    let root = host.data_dir().canonicalize().map_err(|e| e.to_string())?;
    let mut adapters = IMAGE_ADAPTERS.get_or_init(Default::default).lock().unwrap();
    Ok(adapters
        .entry(root)
        .or_insert_with(|| {
            Arc::new(DeterministicAvatarAdapter {
                calls: std::sync::atomic::AtomicUsize::new(0),
            })
        })
        .clone())
}
pub(crate) fn deterministic_avatar_adapter(host: &Host) -> Option<Arc<DeterministicAvatarAdapter>> {
    if !isolated(host.data_dir()) {
        return None;
    }
    let root = host.data_dir().canonicalize().ok()?;
    IMAGE_ADAPTERS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .get(&root)
        .cloned()
}
