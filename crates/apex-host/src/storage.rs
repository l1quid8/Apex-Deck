use std::path::{Path, PathBuf};
use std::sync::Mutex;

use apex_core::RoomSnapshot;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedRoom {
    pub cwd: Option<String>,
    pub snapshot: RoomSnapshot,
}

/// One card's saved settings: src/interactiveAnswers/contract.ts `AnswerEntry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnswerEntry {
    pub fingerprint: String,
    pub inputs: serde_json::Map<String, serde_json::Value>,
    pub revision: u64,
    pub at: u64,
}

/// The settings people chose on a thread's cards, by card key ("<seq>:<card id>").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnswersFile {
    pub version: u32,
    pub cards: std::collections::BTreeMap<String, AnswerEntry>,
}

/// What saving one card's settings did. Serialized as {"saved": …} or {"conflict": …}.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerSave {
    Saved(AnswerEntry),
    /// Another client saved first; nothing changed, and this is what it saved.
    Conflict(AnswerEntry),
}

/// The most cards one thread keeps settings for.
pub const MAX_SAVED_CARDS: usize = 500;

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

    /// The settings chosen on a thread's cards, beside its file: "<hex id>.answers.json".
    fn answers_path(&self, id: &str) -> PathBuf {
        self.room_path(id).with_extension("answers.json")
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
        let _guard = self.writes.lock().unwrap();
        self.write_held(path, data)
    }

    /// Write while the caller holds the write lock.
    fn write_held<T: Serialize>(&self, path: &Path, data: &T) -> Result<(), String> {
        use std::io::Write;
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

    /// Personal assistants: their conversations, events, tasks and receipts.
    pub fn personal(&self) -> Result<Option<crate::personal::PersonalDocument>, String> {
        self.read(&self.root.join("personal-assistants.json"))
    }

    pub fn save_personal(&self, document: &crate::personal::PersonalDocument) -> Result<(), String> {
        self.write(&self.root.join("personal-assistants.json"), document)
    }

    /// Which remote assistants may run commands on this machine, and where.
    pub fn personal_machine(&self) -> Result<Option<crate::personal_settings::MachineAllows>, String> {
        self.read(&self.root.join("personal-machine.json"))
    }

    pub fn save_personal_machine(&self, allows: &crate::personal_settings::MachineAllows) -> Result<(), String> {
        self.write(&self.root.join("personal-machine.json"), allows)
    }

    /// The folder every saved file lives in.
    pub fn folder(&self) -> &Path {
        &self.root
    }

    pub fn room(&self, id: &str) -> Result<Option<SavedRoom>, String> {
        self.read(&self.room_path(id))
    }

    pub fn save_room(&self, id: &str, room: &SavedRoom) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        let previous = self.room(id)?.map(|saved| saved.snapshot.transcript.len()).unwrap_or(0);
        self.write_held(&self.room_path(id), room)?;
        let upto = room.snapshot.transcript.len();
        if upto < previous || upto == 0 { self.prune_answers_held(id, upto)?; }
        Ok(())
    }

    /// Artifacts opened from a thread's replies. The frontend owns their shape (src/artifacts.ts).
    pub fn artifacts(&self, id: &str) -> Result<Option<serde_json::Value>, String> {
        self.read(&self.artifacts_path(id))
    }

    pub fn save_artifacts(&self, id: &str, artifacts: &serde_json::Value) -> Result<(), String> {
        self.write(&self.artifacts_path(id), artifacts)
    }

    /// The settings people chose on a thread's cards. None when there are none.
    pub fn answers(&self, id: &str) -> Result<Option<AnswersFile>, String> {
        self.read(&self.answers_path(id))
    }

    /// Save one card's settings when `revision` is still its saved revision,
    /// or nothing is saved under `key` yet. Otherwise nothing changes and the
    /// newer entry comes back. A file that can't be read is never written over.
    pub fn save_answer(&self, id: &str, key: &str, fingerprint: &str, inputs: serde_json::Map<String, serde_json::Value>, revision: u64, at: u64) -> Result<AnswerSave, String> {
        let _guard = self.writes.lock().unwrap();
        if let Some(room) = self.room(id)? {
            let seq = key.split_once(':').and_then(|(seq, _)| seq.parse::<usize>().ok());
            if seq.is_none_or(|seq| seq >= room.snapshot.transcript.len()) {
                return Err("This card's message no longer exists, so its settings weren't saved.".into());
            }
        }
        let path = self.answers_path(id);
        let mut file: AnswersFile = self.read(&path)?.unwrap_or(AnswersFile { version: 1, cards: Default::default() });
        let next = match file.cards.get(key) {
            Some(current) if current.revision != revision => return Ok(AnswerSave::Conflict(current.clone())),
            Some(current) => current.revision + 1,
            None if file.cards.len() >= MAX_SAVED_CARDS => return Err("This thread keeps settings for too many cards.".into()),
            None => 1,
        };
        let entry = AnswerEntry { fingerprint: fingerprint.to_string(), inputs, revision: next, at };
        file.cards.insert(key.to_string(), entry.clone());
        self.write_held(&path, &file)?;
        Ok(AnswerSave::Saved(entry))
    }

    fn prune_answers_held(&self, id: &str, upto: usize) -> Result<(), String> {
        let Some(mut file) = self.answers(id)? else { return Ok(()); };
        file.cards.retain(|key, _| key.split_once(':').and_then(|(seq, _)| seq.parse::<usize>().ok()).is_some_and(|seq| seq < upto));
        let path = self.answers_path(id);
        if file.cards.is_empty() {
            std::fs::remove_file(path).map_err(|error| error.to_string())
        } else { self.write_held(&path, &file) }
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
        // And the settings chosen on its cards.
        match std::fs::copy(self.answers_path(source), self.answers_path(target)) {
            Ok(_) => { self.prune_answers_held(target, fork.snapshot.transcript.len())?; }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not copy the thread's card settings: {e}")),
        }
        std::fs::File::open(parent).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())
    }

    /// Save a new room `id`. Refuses an id that already has a saved room, or
    /// only its artifacts or card settings: a failed move deletes what it made, and they're not.
    pub fn import_room(&self, id: &str, saved: &SavedRoom) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        let path = self.room_path(id);
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if [self.artifacts_path(id), self.answers_path(id)].iter().any(|leftover| std::fs::symlink_metadata(leftover).is_ok()) {
            return Err("a thread with that id already exists".into());
        }
        write_new(&path, saved)?;
        std::fs::File::open(parent).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())
    }

    pub fn delete_room(&self, id: &str) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        for path in [self.room_path(id), self.artifacts_path(id), self.answers_path(id)] {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Could not delete chat: {e}")),
            }
        }
        Ok(())
    }
}

/// Create the host-owned data directory and remove group/other access.
pub(crate) fn prepare_private_root(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("Could not create private data folder: {e}"))?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Could not make private data folder private: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{Room, RoomOptions};

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!("apex-deck-storage-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()))
    }

    #[cfg(unix)]
    #[test]
    fn prepare_private_root_removes_group_and_other_access() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        prepare_private_root(&root).unwrap();
        assert_eq!(std::fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn participant_speed_survives_store_reopen_and_default_clears_it() {
        let root = temp();
        for backend in [
            serde_json::json!({"kind":"agent","tool":"codex","model":"gpt-6-sol"}),
            serde_json::json!({"kind":"agent","tool":"claude_code","model":"opus"}),
            serde_json::json!({"kind":"open_ai_compatible","base_url":"https://api.openai.com/v1","model":"gpt-6-sol","api_key_env":null}),
        ] {
            for speed in [Some(apex_core::Speed::Fast), Some(apex_core::Speed::Standard), None] {
                let mut participant: apex_core::ParticipantConfig = serde_json::from_value(serde_json::json!({
                    "id":"speed-test","display_name":"Speed test","persona":"","access":"read","effort":null,"backend":backend
                })).unwrap();
                participant.speed = speed;
                let mut snapshot = Room::new(vec![], RoomOptions::default()).snapshot();
                snapshot.participants.push(participant);
                Store::new(root.clone()).save_room("speed", &SavedRoom { cwd: None, snapshot }).unwrap();
                let reopened = Store::new(root.clone()).room("speed").unwrap().unwrap();
                assert_eq!(reopened.snapshot.participants[0].speed, speed);
            }
        }
        std::fs::remove_dir_all(root).unwrap();
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

    #[tokio::test]
    async fn card_settings_save_by_revision_follow_forks_and_go_with_their_thread() {
        let root = temp();
        let store = Store::new(root.clone());
        assert!(store.answers("chat-1").unwrap().is_none());
        let inputs = |budget: u64| serde_json::json!({ "budget": budget, "priority": "ease" }).as_object().unwrap().clone();
        let AnswerSave::Saved(first) = store.save_answer("chat-1", "3:hosting", "0a1b2c3d", inputs(100), 0, 5).unwrap() else { panic!("the first save was refused") };
        assert_eq!((first.revision, first.at), (1, 5));
        assert!(matches!(store.save_answer("chat-1", "3:hosting", "0a1b2c3d", inputs(150), 1, 6).unwrap(), AnswerSave::Saved(AnswerEntry { revision: 2, .. })));
        // A save made from revision 1 doesn't overwrite revision 2.
        let AnswerSave::Conflict(newer) = store.save_answer("chat-1", "3:hosting", "0a1b2c3d", inputs(999), 1, 7).unwrap() else { panic!("a stale save was kept") };
        assert_eq!((newer.revision, newer.inputs["budget"].as_u64()), (2, Some(150)));

        let mut room = Room::new(vec![], RoomOptions::default());
        for _ in 0..4 { room.post_human("saved", &|_| {}).await; }
        store.save_room("chat-1", &SavedRoom { cwd: None, snapshot: room.snapshot() }).unwrap();
        store.fork_room("chat-1", "chat-2", None, None).unwrap();
        assert_eq!(store.answers("chat-2").unwrap(), store.answers("chat-1").unwrap());

        store.delete_room("chat-1").unwrap();
        assert!(store.answers("chat-1").unwrap().is_none());
        assert!(store.answers("chat-2").unwrap().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn removed_messages_do_not_keep_card_settings_or_use_a_forks_capacity() {
        let root = temp();
        let store = Store::new(root.clone());
        let mut room = Room::new(vec![], RoomOptions::default());
        for _ in 0..3 { room.post_human("message", &|_| {}).await; }
        store.save_room("source", &SavedRoom { cwd: None, snapshot: room.snapshot() }).unwrap();
        for seq in 0..3 { store.save_answer("source", &format!("{seq}:hosting"), "0a1b2c3d", serde_json::Map::new(), 0, 0).unwrap(); }
        store.fork_room("source", "short", Some(1), None).unwrap();
        assert_eq!(store.answers("short").unwrap().unwrap().cards.len(), 1);
        room.rewind(1);
        store.save_room("source", &SavedRoom { cwd: None, snapshot: room.snapshot() }).unwrap();
        assert_eq!(store.answers("source").unwrap().unwrap().cards.len(), 1);
        assert!(store.save_answer("source", "2:hosting", "0a1b2c3d", serde_json::Map::new(), 0, 0).is_err(), "late settings for a removed message stay removed");
        room.clear();
        store.save_room("source", &SavedRoom { cwd: None, snapshot: room.snapshot() }).unwrap();
        assert!(store.answers("source").unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_damaged_card_settings_file_is_reported_and_never_written_over() {
        let root = temp();
        let store = Store::new(root.clone());
        store.save_answer("chat-1", "1:a", "0a1b2c3d", serde_json::Map::new(), 0, 0).unwrap();
        let path = store.answers_path("chat-1");
        std::fs::write(&path, "broken").unwrap();
        assert!(store.answers("chat-1").is_err());
        assert!(store.save_answer("chat-1", "1:a", "0a1b2c3d", serde_json::Map::new(), 1, 0).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
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
