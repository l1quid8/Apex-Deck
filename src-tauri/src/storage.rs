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

    pub fn room(&self, id: &str) -> Result<Option<SavedRoom>, String> {
        self.read(&self.room_path(id))
    }

    pub fn save_room(&self, id: &str, room: &SavedRoom) -> Result<(), String> {
        self.write(&self.room_path(id), room)
    }

    pub fn delete_room(&self, id: &str) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        match std::fs::remove_file(self.room_path(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Could not delete chat: {e}")),
        }
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

    #[test]
    fn corrupted_session_is_reported_and_preserved() {
        let root = temp();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("session.json"), "broken saved file").unwrap();
        assert!(Store::new(root.clone()).session().is_err());
        assert_eq!(std::fs::read_to_string(root.join("session.json")).unwrap(), "broken saved file");
        std::fs::remove_dir_all(root).unwrap();
    }
}
