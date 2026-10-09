use std::path::{Path, PathBuf};
use std::sync::Mutex;

use apex_core::RoomSnapshot;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedRoom {
    pub cwd: Option<String>,
    pub snapshot: RoomSnapshot,
}

/// Serialize writes, flush the replacement, then atomically replace the old
/// document. A failed read is reported, never treated as an empty session.
pub struct Store {
    root: PathBuf,
    writes: Mutex<()>,
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Self { root, writes: Mutex::new(()) }
    }

    fn room_path(&self, id: &str) -> PathBuf {
        let name: String = id.bytes().map(|b| format!("{b:02x}")).collect();
        self.root.join("rooms").join(format!("{name}.json"))
    }

    /// A thread's artifacts, beside its file: "<hex id>.artifacts.json".
    fn artifacts_path(&self, id: &str) -> PathBuf {
        self.room_path(id).with_extension("artifacts.json")
    }

    fn read<T: DeserializeOwned>(&self, path: &Path) -> Result<Option<T>, String> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("Could not read saved data: {e}")),
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|e| format!("Could not read saved data: {e}"))
    }

    fn write<T: Serialize>(&self, path: &Path, data: &T) -> Result<(), String> {
        use std::io::Write;
        let _guard = self.writes.lock().unwrap();
        let bytes = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temp = path.with_extension("tmp");
        let result = (|| -> std::io::Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&temp, path)?;
            std::fs::File::open(parent)?.sync_all()?;
            Ok(())
        })();
        result.map_err(|e| format!("Could not save data: {e}"))
    }

    pub fn session(&self) -> Result<Option<serde_json::Value>, String> {
        self.read(&self.root.join("session.json"))
    }

    pub fn save_session(&self, session: &serde_json::Value) -> Result<(), String> {
        self.write(&self.root.join("session.json"), session)
    }

    /// App-wide settings, beside the session file. The host reads them as `documents::Settings`.
    pub fn settings(&self) -> Result<Option<serde_json::Value>, String> {
        self.read(&self.root.join("settings.json"))
    }

    pub fn save_settings(&self, settings: &serde_json::Value) -> Result<(), String> {
        self.write(&self.root.join("settings.json"), settings)
    }

    pub fn monitors(&self) -> Result<Option<crate::monitor::MonitorDocument>, String> {
        self.read(&self.root.join("monitor.json"))
    }

    pub fn save_monitors(&self, document: &crate::monitor::MonitorDocument) -> Result<(), String> {
        self.write(&self.root.join("monitor.json"), document)
    }

    /// The folder every saved file lives in.
    pub fn folder(&self) -> &Path {
        &self.root
    }

    pub fn room(&self, id: &str) -> Result<Option<SavedRoom>, String> {
        self.read(&self.room_path(id))
    }

    pub fn save_room(&self, id: &str, room: &SavedRoom) -> Result<(), String> {
        self.write(&self.room_path(id), room)
    }

    /// Artifacts opened from a thread's replies. The frontend owns their shape (src/artifacts.ts).
    pub fn artifacts(&self, id: &str) -> Result<Option<serde_json::Value>, String> {
        self.read(&self.artifacts_path(id))
    }

    pub fn save_artifacts(&self, id: &str, artifacts: &serde_json::Value) -> Result<(), String> {
        self.write(&self.artifacts_path(id), artifacts)
    }

    /// Reserve a new room id while serializing writes; never overwrite a thread.
    pub fn fork_room(&self, source: &str, target: &str, upto: Option<usize>, cwd: Option<String>) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        let saved = self.room(source)?.ok_or("send a message before forking this thread")?;
        let path = self.room_path(target);
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let fork = SavedRoom { cwd, snapshot: saved.snapshot.fork(upto.unwrap_or(saved.snapshot.transcript.len())) };
        write_new(&path, &fork).map_err(|e| e.replace("Could not save", "Could not save fork"))?;
        // A fork keeps the thread's artifacts. Copied directly: the write lock is already held.
        match std::fs::copy(self.artifacts_path(source), self.artifacts_path(target)) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not copy the thread's artifacts: {e}")),
        }
        std::fs::File::open(parent).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())
    }

    /// Save a new room `id`. Refuses an id that already has a saved room, or
    /// only its artifacts: a failed move deletes what it made, and they're not.
    pub fn import_room(&self, id: &str, saved: &SavedRoom) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        let path = self.room_path(id);
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if std::fs::symlink_metadata(self.artifacts_path(id)).is_ok() {
            return Err("a thread with that id already exists".into());
        }
        write_new(&path, saved)?;
        std::fs::File::open(parent).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())
    }

    pub fn delete_room(&self, id: &str) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        for path in [self.room_path(id), self.artifacts_path(id)] {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Could not delete chat: {e}")),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{Room, RoomOptions};

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!("apex-deck-storage-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()))
    }

    #[tokio::test]
    async fn restart_restores_session_and_messages_and_close_deletes_only_selected_chat() {
        let root = temp();
        let store = Store::new(root.clone());
        let session = serde_json::json!({"version":1,"workspaces":[{"id":"ws-1","name":"Project","path":"/tmp"}],"panes":[{"id":"chat-1","workspaceId":"ws-1","kind":"chat","title":"Group chat"}],"profiles":[],"section":"threads"});
        store.save_session(&session).unwrap();
        let mut room = Room::new(vec![], RoomOptions::default());
        room.post_human("Keep this after restart", &|_| {}).await;
        let saved = SavedRoom { cwd: Some("/tmp".into()), snapshot: room.snapshot() };
        store.save_room("chat-1", &saved).unwrap();
        store.save_room("chat-2", &saved).unwrap();
        drop(store);

        let reopened = Store::new(root.clone());
        assert_eq!(reopened.session().unwrap().unwrap()["panes"][0]["id"], "chat-1");
        assert_eq!(reopened.room("chat-1").unwrap().unwrap().snapshot.transcript[0].text, "Keep this after restart");
        reopened.delete_room("chat-1").unwrap();
        assert!(reopened.room("chat-1").unwrap().is_none());
        assert!(reopened.room("chat-2").unwrap().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn fork_reads_the_saved_copy_and_never_overwrites_targets() {
        let root = temp();
        let store = Store::new(root.clone());
        let mut room = Room::new(vec![], RoomOptions::default());
        room.post_human("saved", &|_| {}).await;
        store.save_room("src", &SavedRoom { cwd: Some("/tmp".into()), snapshot: room.snapshot() }).unwrap();
        // Live room changes are deliberately not saved.
        room.post_human("live only", &|_| {}).await;
        store.fork_room("src", "dst", None, Some("/tmp".into())).unwrap();
        let fork = store.room("dst").unwrap().unwrap();
        assert_eq!(fork.snapshot.transcript.len(), 1);
        assert_eq!(fork.snapshot.transcript[0].text, "saved");
        assert_eq!(fork.cwd.as_deref(), Some("/tmp"));
        assert!(store.fork_room("src", "dst", Some(0), None).is_err());
        assert_eq!(store.room("dst").unwrap().unwrap().snapshot.transcript.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn settings_are_saved_beside_the_session_and_kept_apart_from_it() {
        let root = temp();
        let store = Store::new(root.clone());
        assert!(store.settings().unwrap().is_none());
        store.save_session(&serde_json::json!({"version":1})).unwrap();
        store.save_settings(&serde_json::json!({"version":1,"terminal":{"fontSize":15}})).unwrap();
        let reopened = Store::new(root.clone());
        assert_eq!(reopened.settings().unwrap().unwrap()["terminal"]["fontSize"], 15);
        assert_eq!(reopened.session().unwrap().unwrap(), serde_json::json!({"version":1}));
        assert_eq!(reopened.folder(), root.as_path());
        std::fs::write(root.join("settings.json"), "broken").unwrap();
        assert!(reopened.settings().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn artifacts_live_beside_their_thread_follow_forks_and_go_with_it() {
        let root = temp();
        let store = Store::new(root.clone());
        assert!(store.artifacts("chat-1").unwrap().is_none());
        let artifacts = serde_json::json!({"version":1,"artifacts":[{"id":"a","title":"Page","kind":"html","versions":[{"source":"<p>hi</p>","by":"ada","seq":3,"at":1}]}]});
        store.save_artifacts("chat-1", &artifacts).unwrap();
        assert_eq!(Store::new(root.clone()).artifacts("chat-1").unwrap().unwrap(), artifacts);

        let mut room = Room::new(vec![], RoomOptions::default());
        room.post_human("saved", &|_| {}).await;
        store.save_room("chat-1", &SavedRoom { cwd: None, snapshot: room.snapshot() }).unwrap();
        store.fork_room("chat-1", "chat-2", None, None).unwrap();
        assert_eq!(store.artifacts("chat-2").unwrap().unwrap(), artifacts);

        store.delete_room("chat-1").unwrap();
        assert!(store.artifacts("chat-1").unwrap().is_none());
        assert!(store.artifacts("chat-2").unwrap().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_damaged_artifacts_file_is_reported_not_emptied() {
        let root = temp();
        let store = Store::new(root.clone());
        store.save_artifacts("chat-1", &serde_json::json!({"version":1,"artifacts":[]})).unwrap();
        let path = store.artifacts_path("chat-1");
        std::fs::write(&path, "broken").unwrap();
        assert!(store.artifacts("chat-1").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupted_session_is_reported_and_preserved() {
        let root = temp();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("session.json"), "broken saved file").unwrap();
        assert!(Store::new(root.clone()).session().is_err());
        assert_eq!(std::fs::read_to_string(root.join("session.json")).unwrap(), "broken saved file");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn monitors_round_trip_after_store_restart_and_corruption_is_reported() {
        let root = temp();
        let store = Store::new(root.clone());
        assert!(store.monitors().unwrap().is_none());
        let monitor = crate::monitor::ProjectMonitor::new(
            "ws".into(), "conversation".into(), "/repo".into(), "host".into(), "profile".into(),
            "Continue the task".into(), vec![], vec![], 1234,
        );
        let document = crate::monitor::MonitorDocument { version: 1, monitors: vec![monitor] };
        store.save_monitors(&document).unwrap();
        let reopened = Store::new(root.clone());
        assert_eq!(reopened.monitors().unwrap().unwrap().monitors[0].conversation_id, "conversation");
        std::fs::write(root.join("monitor.json"), "broken").unwrap();
        assert!(reopened.monitors().is_err());
        assert_eq!(std::fs::read_to_string(root.join("monitor.json")).unwrap(), "broken");
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Write a room file that must not exist yet, private to this user, flushed to disk.
fn write_new(path: &Path, saved: &SavedRoom) -> Result<(), String> {
    use std::io::Write;
    let bytes = serde_json::to_vec_pretty(saved).map_err(|e| e.to_string())?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { "a thread with that id already exists".into() } else { e.to_string() })?;
    if let Err(e) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(path);
        return Err(format!("Could not save: {e}"));
    }
    Ok(())
}
