//! One policy per host data directory, shared by API and CLI adapters.
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}};

pub(crate) struct Policy {
    enabled: AtomicBool,
    stopped: tokio::sync::watch::Sender<u64>,
}

impl Policy {
    fn new(enabled: bool) -> Self {
        Self { enabled: AtomicBool::new(enabled), stopped: tokio::sync::watch::channel(0).0 }
    }
    pub fn enabled(&self) -> bool { self.enabled.load(Ordering::SeqCst) }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> { self.stopped.subscribe() }
    fn set(&self, enabled: bool) {
        if self.enabled.swap(enabled, Ordering::SeqCst) && !enabled {
            // An Off transition remains observable even if Auto follows it
            // before a suspended approval gets polled again.
            self.stopped.send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        }
    }
}

pub(crate) fn policy(data: Option<&Path>) -> Arc<Policy> {
    static HOSTS: OnceLock<Mutex<HashMap<PathBuf, Arc<Policy>>>> = OnceLock::new();
    let Some(data) = data else { return Arc::new(Policy::new(true)); };
    let mut hosts = HOSTS.get_or_init(Default::default).lock().unwrap();
    hosts.entry(data.to_path_buf()).or_insert_with(|| {
        let saved = std::fs::read(data.join("saved-chats-v1/settings.json")).ok()
            .and_then(|text| serde_json::from_slice::<serde_json::Value>(&text).ok());
        Arc::new(Policy::new(saved.as_ref().and_then(|s| s["apexCodeMode"].as_str()) != Some("off")))
    }).clone()
}

/// Called only after the host has successfully persisted its global settings.
pub fn set_code_mode_enabled(data: &Path, enabled: bool) {
    policy(Some(data)).set(enabled);
}
