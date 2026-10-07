//! The phones this daemon lets in from outside, what each may do, and the
//! ones revoked for good. A phone is known only by its iroh endpoint ID.
//!
//! Kept in `<data>/devices.json`, owner-only. Every change is written to disk
//! before it takes effect, so a revoke survives a crash or restart. A revoked
//! ID stays as a tombstone: adding it again needs `restore`, a local action.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::files;

pub const FILE: &str = "devices.json";

/// How many revokes a session may fall behind on before its receiver lags
/// (and it re-reads the registry instead).
pub const REVOKE_CAPACITY: usize = 16;

/// What a device may do, least first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    ReadOnly,
    Chat,
    Full,
}

impl Tier {
    pub fn parse(text: &str) -> Result<Tier, String> {
        serde_json::from_value(serde_json::Value::String(text.to_string())).map_err(|_| format!("{text} is not a tier; say read_only, chat or full"))
    }
}

/// Which threads (room IDs) a device may reach.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Threads {
    /// `"all"`.
    All(AllThreads),
    Only(Vec<String>),
}

/// The string `"all"`, and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllThreads {
    All,
}

impl Threads {
    pub const ALL: Threads = Threads::All(AllThreads::All);

    pub fn is_all(&self) -> bool {
        matches!(self, Threads::All(_))
    }

    pub fn includes(&self, room: &str) -> bool {
        match self {
            Threads::All(_) => true,
            Threads::Only(rooms) => rooms.iter().any(|r| r == room),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub endpoint_id: String,
    pub label: String,
    pub tier: Tier,
    pub threads: Threads,
    /// ms since the epoch.
    pub added_at: u64,
    pub last_seen: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revoked {
    pub endpoint_id: String,
    pub revoked_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registry {
    pub version: u32,
    pub devices: Vec<Device>,
    pub revoked: Vec<Revoked>,
}

impl Default for Registry {
    fn default() -> Self {
        Registry { version: 1, devices: Vec::new(), revoked: Vec::new() }
    }
}

impl Registry {
    fn is_revoked(&self, id: &str) -> bool {
        self.revoked.iter().any(|r| r.endpoint_id == id)
    }
}

/// The registry, shared by every session.
pub struct Devices {
    path: PathBuf,
    /// `Err` when `devices.json` couldn't be read: every device is refused
    /// and nothing is written, rather than forget a revoke.
    state: Mutex<Result<Registry, String>>,
    revoked: broadcast::Sender<String>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// An endpoint ID is 64 lowercase hex characters.
pub fn check_id(id: &str) -> Result<(), String> {
    if id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(())
    } else {
        Err(format!("{id} is not an endpoint ID (64 lowercase hex characters)"))
    }
}

impl Devices {
    /// Read `<data>/devices.json`; a missing file is an empty registry.
    pub fn open(data: &Path) -> Devices {
        let path = data.join(FILE);
        let state = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<Registry>(&text).map_err(|e| format!("{} could not be read ({e}); remote devices are refused until it's fixed", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Registry::default()),
            Err(e) => Err(format!("{} could not be read ({e}); remote devices are refused until it's fixed", path.display())),
        };
        if let Err(why) = &state {
            eprintln!("apex-daemon: {why}");
        }
        Devices { path, state: Mutex::new(state), revoked: broadcast::channel(REVOKE_CAPACITY).0 }
    }

    /// The device with this ID, if it's listed and not revoked.
    pub fn get(&self, id: &str) -> Option<Device> {
        let state = self.state.lock().unwrap();
        let registry = state.as_ref().ok()?;
        if registry.is_revoked(id) {
            return None;
        }
        registry.devices.iter().find(|d| d.endpoint_id == id).cloned()
    }

    /// Everything, for `devices_list`.
    pub fn list(&self) -> Result<Registry, String> {
        self.state.lock().unwrap().clone()
    }

    /// Hear about every revoke from now on. A fast path only: the registry is
    /// the authority.
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.revoked.subscribe()
    }

    /// Change the registry: `change` edits a copy, the copy is written, and
    /// only then does it replace what sessions see.
    fn change<T>(&self, change: impl FnOnce(&mut Registry) -> Result<T, String>) -> Result<T, String> {
        let mut state = self.state.lock().unwrap();
        let current = state.as_ref().map_err(Clone::clone)?;
        let mut next = current.clone();
        let result = change(&mut next)?;
        let text = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
        files::write_private(&self.path, &format!("{text}\n"))?;
        *state = Ok(next);
        Ok(result)
    }

    /// Add a device. A revoked ID is refused unless `restore`, which lifts
    /// its tombstone.
    pub fn add(&self, id: &str, label: &str, tier: Tier, threads: Threads, restore: bool) -> Result<Device, String> {
        check_id(id)?;
        self.change(|registry| {
            if registry.is_revoked(id) {
                if !restore {
                    return Err(format!("{id} was revoked; add it again with restore to let it back in"));
                }
                registry.revoked.retain(|r| r.endpoint_id != id);
            }
            if registry.devices.iter().any(|d| d.endpoint_id == id) {
                return Err(format!("{id} is already paired"));
            }
            let device = Device { endpoint_id: id.to_string(), label: label.to_string(), tier, threads, added_at: now_ms(), last_seen: None };
            registry.devices.push(device.clone());
            Ok(device)
        })
    }

    pub fn set_tier(&self, id: &str, tier: Tier) -> Result<Device, String> {
        self.edit(id, |device| device.tier = tier)
    }

    pub fn set_threads(&self, id: &str, threads: Threads) -> Result<Device, String> {
        self.edit(id, |device| device.threads = threads)
    }

    /// Note that a device just connected.
    pub fn seen(&self, id: &str) -> Result<Device, String> {
        self.edit(id, |device| device.last_seen = Some(now_ms()))
    }

    fn edit(&self, id: &str, edit: impl FnOnce(&mut Device)) -> Result<Device, String> {
        self.change(|registry| {
            if registry.is_revoked(id) {
                return Err(format!("{id} was revoked"));
            }
            let device = registry.devices.iter_mut().find(|d| d.endpoint_id == id).ok_or_else(|| format!("no paired device {id}"))?;
            edit(device);
            Ok(device.clone())
        })
    }

    /// Revoke for good: written to disk first, then every session holding
    /// this ID is told to close.
    pub fn revoke(&self, id: &str) -> Result<(), String> {
        check_id(id)?;
        self.change(|registry| {
            registry.devices.retain(|d| d.endpoint_id != id);
            if !registry.is_revoked(id) {
                registry.revoked.push(Revoked { endpoint_id: id.to_string(), revoked_at: now_ms() });
            }
            Ok(())
        })?;
        // No sessions listening is not an error.
        let _ = self.revoked.send(id.to_string());
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn id(n: u8) -> String {
        format!("{n:02x}").repeat(32)
    }

    pub struct Folder(pub PathBuf);
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub fn folder() -> Folder {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("apex-daemon-devices-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Folder(dir)
    }

    #[test]
    fn a_missing_file_is_an_empty_registry() {
        let data = folder();
        let devices = Devices::open(&data.0);
        assert_eq!(devices.list(), Ok(Registry::default()));
        assert_eq!(devices.get(&id(1)), None);
    }

    #[test]
    fn devices_tiers_and_revokes_survive_a_restart() {
        let data = folder();
        let devices = Devices::open(&data.0);
        devices.add(&id(1), "Phone", Tier::Chat, Threads::ALL, false).unwrap();
        devices.add(&id(2), "Tablet", Tier::ReadOnly, Threads::Only(vec!["r1".into()]), false).unwrap();
        devices.set_tier(&id(1), Tier::Full).unwrap();
        devices.revoke(&id(2)).unwrap();

        let again = Devices::open(&data.0);
        let phone = again.get(&id(1)).unwrap();
        assert_eq!((phone.label.as_str(), phone.tier, phone.threads), ("Phone", Tier::Full, Threads::ALL));
        assert_eq!(again.get(&id(2)), None);
        assert_eq!(again.list().unwrap().revoked.iter().map(|r| r.endpoint_id.clone()).collect::<Vec<_>>(), vec![id(2)]);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(data.0.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn the_file_keeps_the_documented_shape() {
        let data = folder();
        let devices = Devices::open(&data.0);
        devices.add(&id(1), "Phone", Tier::Chat, Threads::ALL, false).unwrap();
        devices.add(&id(2), "Tab", Tier::ReadOnly, Threads::Only(vec!["r1".into()]), false).unwrap();
        devices.revoke(&id(2)).unwrap();
        let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(data.0.join(FILE)).unwrap()).unwrap();
        assert_eq!(saved["version"], 1);
        assert_eq!(saved["devices"][0]["endpointId"], id(1));
        assert_eq!(saved["devices"][0]["tier"], "chat");
        assert_eq!(saved["devices"][0]["threads"], "all");
        assert_eq!(saved["devices"][0]["lastSeen"], serde_json::Value::Null);
        assert_eq!(saved["revoked"][0]["endpointId"], id(2));
        assert!(saved["revoked"][0]["revokedAt"].as_u64().unwrap() > 0);
        let limited: Device = serde_json::from_value(serde_json::json!({ "endpointId": id(3), "label": "x", "tier": "full", "threads": ["a", "b"], "addedAt": 1, "lastSeen": null })).unwrap();
        assert_eq!(limited.threads, Threads::Only(vec!["a".into(), "b".into()]));
        assert!(serde_json::from_value::<Threads>(serde_json::json!("some")).is_err());
    }

    #[test]
    fn a_revoked_id_comes_back_only_with_restore() {
        let data = folder();
        let devices = Devices::open(&data.0);
        devices.add(&id(1), "Phone", Tier::Chat, Threads::ALL, false).unwrap();
        devices.revoke(&id(1)).unwrap();
        assert!(devices.add(&id(1), "Phone", Tier::Chat, Threads::ALL, false).unwrap_err().contains("revoked"));
        assert!(devices.set_tier(&id(1), Tier::Full).is_err());
        assert_eq!(devices.get(&id(1)), None);
        devices.add(&id(1), "Phone", Tier::ReadOnly, Threads::ALL, true).unwrap();
        assert_eq!(devices.get(&id(1)).unwrap().tier, Tier::ReadOnly);
        assert!(devices.list().unwrap().revoked.is_empty());
    }

    #[test]
    fn a_revoke_is_on_disk_before_sessions_hear_it() {
        let data = folder();
        let devices = std::sync::Arc::new(Devices::open(&data.0));
        devices.add(&id(1), "Phone", Tier::Chat, Threads::ALL, false).unwrap();
        let mut heard = devices.subscribe();
        devices.revoke(&id(1)).unwrap();
        assert_eq!(heard.try_recv().unwrap(), id(1));
        let saved = Devices::open(&data.0).list().unwrap();
        assert!(saved.devices.is_empty());
        assert_eq!(saved.revoked[0].endpoint_id, id(1));
    }

    #[test]
    fn mistakes_are_refused() {
        let data = folder();
        let devices = Devices::open(&data.0);
        assert!(devices.add("ABC", "x", Tier::Chat, Threads::ALL, false).unwrap_err().contains("endpoint ID"));
        assert!(devices.add(&id(0xab).to_uppercase(), "x", Tier::Chat, Threads::ALL, false).is_err());
        devices.add(&id(1), "x", Tier::Chat, Threads::ALL, false).unwrap();
        assert!(devices.add(&id(1), "x", Tier::Chat, Threads::ALL, false).unwrap_err().contains("already"));
        assert!(devices.set_tier(&id(9), Tier::Full).unwrap_err().contains("no paired device"));
        assert_eq!(Tier::parse("full"), Ok(Tier::Full));
        assert!(Tier::parse("admin").is_err());
    }

    #[test]
    fn an_unreadable_file_refuses_every_device_and_is_never_overwritten() {
        let data = folder();
        std::fs::write(data.0.join(FILE), "{ not json").unwrap();
        let devices = Devices::open(&data.0);
        assert_eq!(devices.get(&id(1)), None);
        assert!(devices.add(&id(1), "x", Tier::Chat, Threads::ALL, false).is_err());
        assert_eq!(std::fs::read_to_string(data.0.join(FILE)).unwrap(), "{ not json");
    }
}
