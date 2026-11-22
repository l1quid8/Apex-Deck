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

/// Fill `host`'s saved chats with `threads` generated work threads of about
/// `bytes_each` bytes of message text each, plus a few assistant
/// conversations, for the search benchmark. The text is ordinary words from a
/// fixed seed; about one message in a hundred contains "installer". Returns
/// the bytes of message text written.
pub fn seed_search_store(host: &Arc<Host>, threads: usize, bytes_each: usize) -> u64 {
    const WORDS: &[&str] = &[
        "the", "build", "passed", "on", "main", "and", "review", "is", "open", "for", "release", "notes", "please", "check", "tests", "again", "after", "merge",
        "daemon", "phone", "thread", "agent", "sidebar", "panel", "fix", "branch", "commit", "signed", "package", "update", "works", "now", "error", "line",
        "file", "folder", "project", "machine", "paired", "settings", "voice", "library", "picture", "task", "note", "search", "result", "window", "pane",
    ];
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut written = 0u64;
    for thread in 0..threads {
        let mut transcript = Vec::new();
        let mut size = 0;
        while size < bytes_each {
            let mut text = String::new();
            let length = 200 + (next() % 600) as usize;
            while text.len() < length {
                text.push_str(WORDS[(next() % WORDS.len() as u64) as usize]);
                text.push(' ');
            }
            if next() % 100 == 0 {
                text.push_str("Try the installer on a clean Mac before signing off.");
            }
            size += text.len();
            let seq = transcript.len();
            let speaker = if seq % 2 == 0 { serde_json::json!({"kind": "human"}) } else { serde_json::json!({"kind": "bot", "id": "builder"}) };
            transcript.push(serde_json::from_value(serde_json::json!({"seq": seq, "speaker": speaker, "text": text, "at": 1_700_000_000_000u64 + (thread * 1000 + seq) as u64})).unwrap());
        }
        written += size as u64;
        let mut snapshot = apex_core::Room::new(vec![], apex_core::RoomOptions::default()).snapshot();
        snapshot.transcript = transcript;
        let id = format!("bench-{thread}");
        host.store().save_room(&id, &crate::storage::SavedRoom { cwd: Some("/work/bench".into()), mounts: vec![], snapshot }).unwrap();
        let mut meta = host.store().chat_meta(&id).unwrap().unwrap_or_default();
        meta.title = format!("Bench thread {thread}");
        host.store().save_chat_meta(&id, &meta).unwrap();
    }
    for ask in 0..20 {
        let owner = crate::assistant_tasks::TaskOwner { workspace_id: "ws".into(), cwd: "/work/bench".into(), host_id: "host".into(), conversation_id: format!("bench-conv-{ask}") };
        host.assistant_conversations.begin(crate::assistant_conversation::ConversationRequest {
            request_id: format!("bench-ask-{ask}"), owner, text: "Where is the installer log kept on the build machine?".into(), destination: None,
            new_worker_profiles: vec![], worker_profiles: vec![], threads: vec![], evidence: vec![], source_chats: vec![],
        }, false).unwrap();
    }
    written
}
