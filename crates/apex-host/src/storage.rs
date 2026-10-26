use std::path::{Path, PathBuf};
use std::sync::Mutex;

use apex_core::work_steps::{ReplySteps, StepKind};
use apex_core::{ParticipantId, RoomSnapshot};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

/// Flush through the writable handle that produced the replacement. Windows
/// requires write access for `sync_all`; reopening with `File::open` is read-only.
pub(crate) fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Persist directory entries on Unix after creating or replacing a file.
/// Windows does not support the regular-file directory open/fsync pattern;
/// callers still flush the writable file before completing the operation.
pub(crate) fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    return std::fs::File::open(path)?.sync_all();
    #[cfg(not(unix))] {
        let _ = path;
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedRoom {
    pub cwd: Option<String>,
    pub snapshot: RoomSnapshot,
    #[serde(default)]
    pub mounts: Vec<MountBoundary>,
}

/// Permission-bearing snapshot fields live separately from editable transcript data.
#[derive(Clone,Serialize,Deserialize)]
struct RoomAuthority {
    #[serde(default, skip_serializing_if = "apex_core::RoomKind::is_work")]
    kind: apex_core::RoomKind,
    cwd:Option<String>,participants:Vec<apex_core::ParticipantConfig>,options:apex_core::RoomOptions,
    allowed:Vec<apex_core::AllowedRule>,plan:bool,
    #[serde(default)] mounts:Vec<MountBoundary>,
    /// Set when this manifest was created from a pre-provenance room file. Never verified.
    #[serde(default, skip_serializing_if = "Option::is_none")] legacy:Option<crate::legacy_import::LegacyMarker>,
}

/// Destination when a chat room is moved to another paired machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMovedTo {
    pub host: String,
    pub room: String,
}

/// Machine-owned catalog metadata for a chat room or promoted work room.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRoomMeta {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promoted_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promoted_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<ChatMovedTo>,
    /// The `requestId` of the promote that made `promotedTo`, so a retried
    /// move returns that Work thread and a different request is refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promote_request: Option<String>,
    /// Promote requests the phone gave up on with `chat_promote_abandon`. A
    /// delayed copy of one of these is refused, so it can't land after the
    /// person started a different move.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub abandoned_promotes: Vec<String>,
    /// The saved profile each bot was made from, by bot id. A bot's id can be
    /// a copy's alias ("claude-2"), so moving a chat needs both.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub profiles: std::collections::BTreeMap<String, String>,
}

/// One row returned by `chat_list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatListEntry {
    pub id: String,
    pub kind: apex_core::RoomKind,
    pub title: String,
    pub participants: Vec<apex_core::ParticipantConfig>,
    pub updated_at: u64,
    pub archived: bool,
    pub cwd: Option<String>,
    pub folder_name: Option<String>,
    pub promoted_from: Option<String>,
    pub promoted_to: Option<String>,
    pub moved_to: Option<ChatMovedTo>,
    /// Bot id to saved profile id, as in `ChatRoomMeta::profiles`.
    #[serde(default)]
    pub profiles: std::collections::BTreeMap<String, String>,
}

/// The folders a paired phone may turn a chat into a Work thread inside. Only
/// `apex-daemon allow-root`, run by the machine's own user, writes this file;
/// the daemon only ever reads it, so a new folder works without a restart.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromoteRoots {
    pub version: u32,
    pub roots: Vec<PromoteRoot>,
}

/// One allowed folder, stored canonical, with when it was allowed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteRoot {
    pub path: String,
    pub added_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MountBoundary {
    pub seq: usize,
    #[serde(default, rename = "changeCount")]
    pub change_count: Option<usize>,
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
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

/// One reply's place in a thread's steps file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepsIndexEntry {
    pub by: ParticipantId,
    /// Every step, helpers' own steps included.
    pub count: usize,
    pub helpers: usize,
    /// Where the reply's line starts in "<hex id>.steps.jsonl", and its length without the newline.
    pub offset: u64,
    pub len: u64,
}

/// The replies a thread has saved steps for, by reply seq.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepsIndex {
    pub version: u32,
    pub replies: std::collections::BTreeMap<usize, StepsIndexEntry>,
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

    /// The folder Deck keeps its own files in, so a promotion can refuse it
    /// as a project folder.
    pub fn root(&self) -> &std::path::Path {
        &self.root
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

    /// The steps behind a thread's replies, one `ReplySteps` per line: "<hex id>.steps.jsonl".
    fn steps_path(&self, id: &str) -> PathBuf {
        self.room_path(id).with_extension("steps.jsonl")
    }

    /// Where each reply's steps are in the steps file: "<hex id>.steps.index.json".
    fn steps_index_path(&self, id: &str) -> PathBuf {
        self.room_path(id).with_extension("steps.index.json")
    }

    /// Every file that belongs to a thread.
    fn thread_paths(&self, id: &str) -> [PathBuf; 5] {
        [self.room_path(id), self.artifacts_path(id), self.answers_path(id), self.steps_path(id), self.steps_index_path(id)]
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
        let bytes = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
        self.write_bytes_held(path, &bytes)
    }

    fn write_bytes_held(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temp = path.with_extension("tmp");
        let result = (|| -> std::io::Result<()> {
            write_synced(&temp, bytes)?;
            std::fs::rename(&temp, path)?;
            sync_directory(parent)?;
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
        let path=self.root.join("personal-assistants.json");
        match crate::authority_file::read(&path){
            Ok(bytes)=>serde_json::from_slice(&bytes).map(Some).map_err(|e|e.to_string()),
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(None),
            Err(e)=>Err(e.to_string()),
        }
    }

    pub fn save_personal(&self, document: &crate::personal::PersonalDocument) -> Result<(), String> {
        let bytes=serde_json::to_vec(document).map_err(|e|e.to_string())?;
        crate::authority_file::write(&self.root.join("personal-assistants.json"),&bytes).map_err(|e|e.to_string())
    }

    /// Which remote assistants may run commands on this machine, and where.
    pub fn personal_machine(&self) -> Result<Option<crate::personal_settings::MachineAllows>, String> {
        match crate::authority_file::read(&self.root.join("personal-machine.json")) {
            Ok(bytes)=>serde_json::from_slice(&bytes).map(Some).map_err(|e|e.to_string()),
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(None),Err(e)=>Err(e.to_string()),
        }
    }

    pub fn save_personal_machine(&self, allows: &crate::personal_settings::MachineAllows) -> Result<(), String> {
        crate::authority_file::write(&self.root.join("personal-machine.json"),&serde_json::to_vec(allows).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
    }

    /// The folder every saved file lives in.
    pub fn folder(&self) -> &Path {
        &self.root
    }

    pub fn room(&self, id: &str) -> Result<Option<SavedRoom>, String> {
        let Some(mut room):Option<SavedRoom>=self.read(&self.room_path(id))? else{return Ok(None)};
        let authority=self.room_authorities()?;
        // Linux keeps the manifest as a plain file beside the room, so it is no
        // more trusted than the room file itself. A room saved before the
        // manifest existed keeps its own settings there, as it did before.
        if crate::authority_file::plain(&self.root)&&!authority.contains_key(id){return Ok(Some(room));}
        let trusted:RoomAuthority=serde_json::from_value(authority.get(id).cloned().ok_or("This legacy room has no verified authority manifest. It requires explicit reauthorization; its original file was preserved.")?).map_err(|e|e.to_string())?;
        room.snapshot.kind=trusted.kind;
        room.cwd=trusted.cwd;
        room.snapshot.participants=trusted.participants;
        room.snapshot.options=trusted.options;
        room.snapshot.allowed=trusted.allowed;
        room.snapshot.plan=trusted.plan;
        room.mounts=trusted.mounts;
        Ok(Some(room))
    }

    pub(crate) fn room_ids(&self) -> Result<Vec<String>, String> {
        let entries = match std::fs::read_dir(self.root.join("rooms")) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(error) => return Err(format!("Could not enumerate saved chats: {error}")),
        };
        let mut ids = vec![];
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            if let Some(id) = entry.file_name().to_str().and_then(room_id_from_file) { ids.push(id); }
        }
        ids.sort();
        Ok(ids)
    }

    /// Provider processes never resume. Finish recovery durably before the
    /// host starts any worker or accepts a command, including unopened rooms.
    pub(crate) fn interrupt_client_messages(&self) -> Result<(), String> {
        for id in self.room_ids()? {
            let Some(raw): Option<SavedRoom> = self.read(&self.room_path(&id))? else { continue; };
            if !raw.snapshot.client_messages.values().any(|record| record.state == apex_core::ClientMessageState::Running) { continue; }
            let mut saved = self.room(&id)?.ok_or("Saved chat disappeared during recovery")?;
            for record in saved.snapshot.client_messages.values_mut() {
                if record.state == apex_core::ClientMessageState::Running { record.state = apex_core::ClientMessageState::Interrupted; }
            }
            self.save_room(&id, &saved)?;
        }
        Ok(())
    }

    pub(crate) fn imported_chat(&self, move_id: &str) -> Result<Option<(String, SavedRoom)>, String> {
        for id in self.room_ids()? {
            let Some(raw): Option<SavedRoom> = self.read(&self.room_path(&id))? else { continue; };
            if raw.snapshot.import_move_id.as_deref() != Some(move_id) { continue; }
            let saved = self.room(&id)?.ok_or("Imported chat disappeared")?;
            if !saved.snapshot.kind.is_chat() { return Err("This move does not belong to a chat room".into()); }
            return Ok(Some((id, saved)));
        }
        Ok(None)
    }
    fn room_authorities(&self)->Result<serde_json::Map<String,serde_json::Value>,String>{
        let path=self.root.join("room-authority-v1.json");
        match crate::authority_file::read(&path){
            Ok(bytes)=>serde_json::from_slice(&bytes).map_err(|e|e.to_string()),
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(Default::default()),
            Err(e)=>Err(e.to_string()),
        }
    }
    fn save_room_authority(&self,id:&str,room:&SavedRoom)->Result<(),String>{
        let mut authorities=self.room_authorities()?;
        if let Some(existing) = authorities.get(id) {
            let previous_kind: apex_core::RoomKind = existing.get("kind").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            if previous_kind.is_chat() && !room.snapshot.kind.is_chat() {
                return Err("A talk-only chat room cannot be converted into a Work thread in place.".into());
            }
        }
        // A room restored from legacy data keeps saying so after later saves.
        let legacy=authorities.get(id).and_then(|entry|entry.get("legacy")).and_then(|marker|serde_json::from_value(marker.clone()).ok());
        let manifest=RoomAuthority{kind:room.snapshot.kind,cwd:room.cwd.clone(),participants:room.snapshot.participants.clone(),options:room.snapshot.options.clone(),allowed:room.snapshot.allowed.clone(),plan:room.snapshot.plan,mounts:room.mounts.clone(),legacy};
        authorities.insert(id.into(),serde_json::to_value(manifest).map_err(|e|e.to_string())?);
        crate::authority_file::write(&self.root.join("room-authority-v1.json"),&serde_json::to_vec(&authorities).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
    }

    /// A room's import label comes only from its protected authority manifest.
    pub(crate) fn room_legacy(&self, id: &str) -> Result<Option<crate::legacy_import::LegacyMarker>, String> {
        let Some(entry) = self.room_authorities()?.remove(id) else { return Ok(None); };
        let authority: RoomAuthority = serde_json::from_value(entry).map_err(|e| e.to_string())?;
        Ok(authority.legacy)
    }

    /// The ids that already have a protected manifest, with any legacy marker.
    pub(crate) fn room_authority_marks(&self) -> Result<std::collections::BTreeMap<String, Option<crate::legacy_import::LegacyMarker>>, String> {
        Ok(self.room_authorities()?.into_iter().map(|(id, entry)| {
            let marker = entry.get("legacy").and_then(|marker| serde_json::from_value(marker.clone()).ok());
            (id, marker)
        }).collect())
    }

    /// Create manifests for legacy rooms in one compare-and-swap. Rooms are
    /// deduplicated by id: one with a legacy-restored manifest was imported
    /// before, and one with any other manifest keeps it.
    pub(crate) fn import_legacy_room_authorities(&self, rooms: Vec<LegacyRoom>, marker: &crate::legacy_import::LegacyMarker) -> Result<LegacyRoomOutcome, String> {
        let _guard = self.writes.lock().unwrap();
        let mut authorities = self.room_authorities()?;
        let mut outcome = LegacyRoomOutcome { imported: vec![], already: vec![], skipped: vec![], skipped_participants: vec![] };
        for room in rooms {
            outcome.skipped_participants.extend(room.omitted_commands.iter().map(|p| format!("participant:{}/{}", room.id, p.id)));
            match authorities.get(&room.id) {
                Some(entry) if entry.get("legacy").is_some_and(|m| !m.is_null()) => outcome.already.push(room.id),
                Some(_) => outcome.skipped.push(room.id),
                None => {
                    let mut legacy = marker.clone();
                    legacy.original_id = Some(room.id.clone());
                    let manifest = RoomAuthority { legacy: Some(legacy), ..room.authority };
                    authorities.insert(room.id.clone(), serde_json::to_value(manifest).map_err(|e| e.to_string())?);
                    outcome.imported.push(room.id);
                }
            }
        }
        if outcome.imported.is_empty() { return Ok(outcome); }
        let bytes = serde_json::to_vec(&authorities).map_err(|e| e.to_string())?;
        if bytes.len() > crate::legacy_import::DOCUMENT_BUDGET {
            return Err("Importing these rooms would exceed the protected document limit. Nothing was written.".into());
        }
        crate::authority_file::write(&self.root.join("room-authority-v1.json"), &bytes).map_err(|e| e.to_string())?;
        Ok(outcome)
    }

    /// A worktree cannot be removed while any saved chat still points at it.
    pub fn checkout_in_use(&self, target: &Path) -> Result<bool, String> {
        let target = target.canonicalize().unwrap_or_else(|_| target.to_path_buf());
        let entries = match std::fs::read_dir(self.root.join("rooms")) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if path.extension().is_none_or(|ext| ext != "json") || stem.is_empty() || !stem.bytes().all(|b| b.is_ascii_hexdigit()) { continue; }
            let Some(saved): Option<SavedRoom> = self.read(&path)? else { continue; };
            if saved.cwd.as_ref().is_some_and(|cwd| Path::new(cwd).canonicalize().unwrap_or_else(|_| PathBuf::from(cwd)) == target) { return Ok(true); }
        }
        Ok(false)
    }

    pub fn save_room(&self, id: &str, room: &SavedRoom) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        let previous = self.room(id)?.map(|saved| saved.snapshot.transcript.len()).unwrap_or(0);
        // Invariant: the manifest never claims permissions the saved room didn't get.
        // `room()` takes permission fields from the manifest and the transcript from
        // the room file, so the room file goes first (a newer file under an older
        // manifest is safe). If the manifest write then fails, the previous room file
        // bytes are put back so a failed save leaves both files as they were.
        let room_path = self.room_path(id);
        let before = match std::fs::read(&room_path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("Could not read saved data: {e}")),
        };
        self.write_held(&room_path, room)?;
        if let Err(why) = self.save_room_authority(id,room) {
            let restored = match &before {
                Some(bytes) => self.write_bytes_held(&room_path, bytes),
                None => std::fs::remove_file(&room_path).map_err(|e| e.to_string()),
            };
            return Err(match restored {
                Ok(()) => why,
                Err(undo) => format!("{why} (and the previous chat file could not be restored: {undo})"),
            });
        }
        let upto = room.snapshot.transcript.len();
        if upto < previous || upto == 0 {
            self.prune_answers_held(id, upto)?;
            // Steps are extra: a damaged steps file never stops the thread saving.
            if let Err(why) = self.copy_steps_held(id, id, upto) { eprintln!("[apex-deck] could not prune saved steps for {id}: {why}"); }
        }
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

    /// Where each reply's saved steps are. None when the thread has none.
    pub fn steps_index(&self, id: &str) -> Result<Option<StepsIndex>, String> {
        self.read(&self.steps_index_path(id))
    }

    /// The steps saved for the reply at `seq`, if any.
    pub fn steps(&self, id: &str, seq: usize) -> Result<Option<ReplySteps>, String> {
        let Some(index) = self.steps_index(id)? else { return Ok(None); };
        let Some(entry) = index.replies.get(&seq) else { return Ok(None); };
        let record: ReplySteps = serde_json::from_slice(&self.steps_line(id, entry)?).map_err(|e| format!("Could not read saved steps: {e}"))?;
        if record.seq != seq { return Err("Could not read saved steps: the steps file and its index disagree".into()); }
        Ok(Some(record))
    }

    fn steps_line(&self, id: &str, entry: &StepsIndexEntry) -> Result<Vec<u8>, String> {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(self.steps_path(id)).map_err(|e| format!("Could not read saved steps: {e}"))?;
        let mut bytes = vec![0; entry.len as usize];
        file.seek(SeekFrom::Start(entry.offset)).and_then(|_| file.read_exact(&mut bytes)).map_err(|e| format!("Could not read saved steps: {e}"))?;
        Ok(bytes)
    }

    /// Append one reply's steps, then point the index at them. A reply
    /// saved again at the same seq replaces the earlier record. An index
    /// that can't be read is never written over.
    pub fn save_steps(&self, id: &str, record: &ReplySteps) -> Result<(), String> {
        use std::io::Write;
        let _guard = self.writes.lock().unwrap();
        let index_path = self.steps_index_path(id);
        let mut index: StepsIndex = self.read(&index_path)?.unwrap_or(StepsIndex { version: 1, replies: Default::default() });
        let mut line = serde_json::to_vec(record).map_err(|e| e.to_string())?;
        let len = line.len() as u64;
        line.push(b'\n');
        let path = self.steps_path(id);
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let offset = (|| -> std::io::Result<u64> {
            let mut options = std::fs::OpenOptions::new();
            options.append(true).create(true);
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&path)?;
            let offset = file.metadata()?.len();
            file.write_all(&line)?;
            file.sync_all()?;
            Ok(offset)
        })().map_err(|e| format!("Could not save steps: {e}"))?;
        index.replies.insert(record.seq, steps_entry(record, offset, len));
        self.write_held(&index_path, &index)
    }

    /// Save `source`'s steps for replies before `upto` as `target`'s,
    /// rewriting both files. With no reply left, both files are removed.
    fn copy_steps_held(&self, source: &str, target: &str, upto: usize) -> Result<(), String> {
        let Some(index) = self.steps_index(source)? else { return Ok(()); };
        if source == target && index.replies.keys().all(|seq| *seq < upto) { return Ok(()); }
        let mut kept = StepsIndex { version: 1, replies: Default::default() };
        let mut lines = Vec::new();
        for (seq, entry) in index.replies.range(..upto) {
            let line = self.steps_line(source, entry)?;
            kept.replies.insert(*seq, StepsIndexEntry { offset: lines.len() as u64, len: line.len() as u64, ..entry.clone() });
            lines.extend_from_slice(&line);
            lines.push(b'\n');
        }
        if kept.replies.is_empty() {
            for path in [self.steps_index_path(target), self.steps_path(target)] {
                match std::fs::remove_file(path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("Could not remove saved steps: {e}")),
                }
            }
            return Ok(());
        }
        self.write_bytes_held(&self.steps_path(target), &lines)?;
        self.write_held(&self.steps_index_path(target), &kept)
    }

    /// Reserve a new room id while serializing writes; never overwrite a thread.
    pub fn fork_room(&self, source: &str, target: &str, upto: Option<usize>, cwd: Option<String>) -> Result<(), String> {
        self.fork_room_with_snapshot_transform(source, target, upto, cwd, |_| Ok(()))
    }

    /// Transform a trusted saved fork before reserving its durable snapshot.
    /// Used by the host to copy owned attachments without trusting imported paths.
    pub(crate) fn fork_room_with_snapshot_transform(
        &self, source: &str, target: &str, upto: Option<usize>, cwd: Option<String>,
        transform: impl FnOnce(&mut RoomSnapshot) -> Result<(), String>,
    ) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        let saved = self.room(source)?.ok_or("send a message before forking this thread")?;
        let path = self.room_path(target);
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if std::fs::symlink_metadata(&path).is_ok() {
            return Err("Could not save fork: a thread with that id already exists".into());
        }
        let snapshot = saved.snapshot.fork(upto.unwrap_or(saved.snapshot.transcript.len()));
        let mounts = if cwd == saved.cwd {
            saved.mounts.iter().map(|mount| {
                let mut boundary = mount.clone();
                // The fork keeps its current folder even when its history ends before a switch.
                boundary.seq = boundary.seq.min(snapshot.transcript.len());
                boundary.change_count = boundary.change_count.map(|count| count.min(snapshot.changes.len()));
                boundary
            }).collect()
        } else { vec![] };
        let mut fork = SavedRoom { mounts, cwd, snapshot };
        transform(&mut fork.snapshot)?;
        self.save_room_authority(target,&fork)?;
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
        // And the steps behind its replies, which never stop a fork.
        if let Err(why) = self.copy_steps_held(source, target, fork.snapshot.transcript.len()) {
            eprintln!("[apex-deck] could not copy saved steps from {source} to {target}: {why}");
        }
        sync_directory(parent).map_err(|e| e.to_string())
    }

    /// Save a new room `id`. Refuses an id that already has a saved room, or
    /// only its artifacts, card settings or steps: a failed move deletes what it made, and they're not.
    pub fn import_room(&self, id: &str, saved: &SavedRoom) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        let path = self.room_path(id);
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if self.thread_paths(id)[1..].iter().any(|leftover| std::fs::symlink_metadata(leftover).is_ok()) {
            return Err("a thread with that id already exists".into());
        }
        if std::fs::symlink_metadata(&path).is_ok(){return Err("a thread with that id already exists".into());}
        self.save_room_authority(id,saved)?;
        write_new(&path, saved)?;
        sync_directory(parent).map_err(|e| e.to_string())
    }

    /// Give up on one promote request for good. Under the same write lock as
    /// `promote_chat`, so either the move already happened (its Work room id
    /// is returned) or it never will: the request id is saved as abandoned and
    /// any copy still on its way is refused.
    pub(crate) fn abandon_promote(&self, source: &str, request_id: &str) -> Result<Option<String>, String> {
        let _guard = self.writes.lock().unwrap();
        let mut metas = self.chat_metas_held()?;
        let mut chat = metas.remove(source).unwrap_or_default();
        if let Some(to) = chat.promoted_to.clone() {
            return Ok(Some(to));
        }
        if !chat.abandoned_promotes.iter().any(|gone| gone == request_id) {
            chat.abandoned_promotes.push(request_id.to_owned());
            // Only the newest few matter: a phone keeps one unconfirmed move per chat.
            let extra = chat.abandoned_promotes.len().saturating_sub(32);
            chat.abandoned_promotes.drain(..extra);
        }
        metas.insert(source.to_owned(), chat);
        self.write_held(&self.root.join("chat-meta-v1.json"), &metas)?;
        Ok(None)
    }

    /// Write a promoted Work room and point the chat at it under one write
    /// lock: either the Work room exists and the chat links to it, or nothing
    /// changed. Returns the Work room the chat already pointed at when this
    /// replays a move already made with the same request.
    pub(crate) fn promote_chat(
        &self,
        source: &str,
        target: &str,
        work: &SavedRoom,
        request_id: Option<&str>,
        title: &str,
    ) -> Result<Option<String>, String> {
        let _guard = self.writes.lock().unwrap();
        let mut metas = self.chat_metas_held()?;
        let mut chat = metas.remove(source).unwrap_or_default();
        if request_id.is_some_and(|id| chat.abandoned_promotes.iter().any(|gone| gone == id)) {
            return Err("This move was cancelled on the phone. Start it again.".into());
        }
        if let Some(to) = chat.promoted_to.clone() {
            let name = metas
                .get(&to)
                .map(|meta| meta.title.trim().to_owned())
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| to.clone());
            return if to == target && chat.promote_request.as_deref() == request_id {
                Ok(Some(to))
            } else {
                Err(format!("Already moved to {name}"))
            };
        }
        let path = self.room_path(target);
        let parent = path.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        if self.thread_paths(target).iter().any(|leftover| std::fs::symlink_metadata(leftover).is_ok()) {
            return Err("a thread with that id already exists".into());
        }
        self.save_room_authority(target, work)?;
        if let Err(why) = write_new(&path, work) {
            let _ = self.forget_authority_held(target);
            return Err(why);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        chat.promoted_to = Some(target.to_owned());
        chat.promote_request = request_id.map(str::to_owned);
        chat.updated_at = chat.updated_at.max(now);
        let work_meta = ChatRoomMeta {
            title: title.trim().to_owned(),
            updated_at: now,
            promoted_from: Some(source.to_owned()),
            profiles: work.snapshot.import_profiles.iter().map(|(id, profile)| (id.clone(), profile.clone())).collect(),
            ..Default::default()
        };
        metas.insert(source.to_owned(), chat);
        metas.insert(target.to_owned(), work_meta);
        if let Err(why) = self.write_held(&self.root.join("chat-meta-v1.json"), &metas) {
            // The room is on disk but the chat doesn't link to it: undo it so a
            // retry can create the same thread again.
            for leftover in self.thread_paths(target) {
                let _ = std::fs::remove_file(leftover);
            }
            let _ = self.forget_authority_held(target);
            return Err(why);
        }
        sync_directory(&parent).map_err(|e| e.to_string())?;
        Ok(None)
    }

    /// Drop one room's authority entry; the caller already holds the write lock.
    fn forget_authority_held(&self, id: &str) -> Result<(), String> {
        let mut authorities = self.room_authorities()?;
        if authorities.remove(id).is_some() {
            crate::authority_file::write(
                &self.root.join("room-authority-v1.json"),
                &serde_json::to_vec(&authorities).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn promote_roots_path(&self) -> PathBuf {
        self.root.join("promote-roots-v1.json")
    }

    /// The folders this machine allows a phone to turn a chat into a Work
    /// thread inside. Empty when nothing was allowed, or the file is missing.
    pub fn promote_roots(&self) -> Result<PromoteRoots, String> {
        Ok(self.read::<PromoteRoots>(&self.promote_roots_path())?.unwrap_or_default())
    }

    /// Allow one folder, and the folders inside it, for phone promotions.
    /// Adding a folder that is already allowed returns the existing entry.
    pub fn allow_promote_root(&self, folder: &Path) -> Result<PromoteRoot, String> {
        let real = canonical_folder(folder)?;
        let ours = std::fs::canonicalize(&self.root).unwrap_or_else(|_| self.root.clone());
        if real.starts_with(&ours) {
            return Err("That folder belongs to Deck. Choose a project folder.".into());
        }
        let _guard = self.writes.lock().unwrap();
        let mut roots = self.read::<PromoteRoots>(&self.promote_roots_path())?.unwrap_or_default();
        if let Some(existing) = roots.roots.iter().find(|root| Path::new(&root.path) == real) {
            return Ok(existing.clone());
        }
        let added = PromoteRoot { path: real.to_string_lossy().into_owned(), added_at: now_ms() };
        roots.roots.push(added.clone());
        roots.version = 1;
        self.write_held(&self.promote_roots_path(), &roots)?;
        Ok(added)
    }

    /// Stop allowing one folder. Returns whether it was on the list.
    pub fn remove_promote_root(&self, folder: &Path) -> Result<bool, String> {
        let real = canonical_folder(folder)?;
        let _guard = self.writes.lock().unwrap();
        let mut roots = self.read::<PromoteRoots>(&self.promote_roots_path())?.unwrap_or_default();
        let before = roots.roots.len();
        roots.roots.retain(|root| Path::new(&root.path) != real);
        if roots.roots.len() == before {
            return Ok(false);
        }
        self.write_held(&self.promote_roots_path(), &roots)?;
        Ok(true)
    }

    /// The allowed folder that contains `folder`, if any. This is the whole
    /// authorization behind a phone's "Move to a Work thread": the phone can
    /// pick a folder, but only inside one the machine's own user listed.
    pub fn promote_root_covering(&self, folder: &Path) -> Result<Option<PromoteRoot>, String> {
        let real = canonical_folder(folder)?;
        Ok(self.promote_roots()?.roots.into_iter().find(|root| real.starts_with(Path::new(&root.path))))
    }

    pub fn delete_room(&self, id: &str) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        let mut authorities=self.room_authorities()?;
        authorities.remove(id);
        crate::authority_file::write(&self.root.join("room-authority-v1.json"),&serde_json::to_vec(&authorities).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        let mut metas = self.chat_metas_held()?;
        if metas.remove(id).is_some() {
            self.write_held(&self.root.join("chat-meta-v1.json"), &metas)?;
        }
        for path in self.thread_paths(id) {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Could not delete chat: {e}")),
            }
        }
        Ok(())
    }

    fn chat_metas_held(&self) -> Result< std::collections::BTreeMap<String, ChatRoomMeta>, String> {
        Ok(self.read(&self.root.join("chat-meta-v1.json"))?.unwrap_or_default())
    }

    pub fn chat_meta(&self, id: &str) -> Result<Option<ChatRoomMeta>, String> {
        Ok(self.chat_metas_held()?.remove(id))
    }

    pub fn save_chat_meta(&self, id: &str, meta: &ChatRoomMeta) -> Result<(), String> {
        let _guard = self.writes.lock().unwrap();
        let mut metas = self.chat_metas_held()?;
        metas.insert(id.into(), meta.clone());
        self.write_held(&self.root.join("chat-meta-v1.json"), &metas)
    }

    pub fn update_chat_meta(
        &self,
        id: &str,
        f: impl FnOnce(&mut ChatRoomMeta),
    ) -> Result<ChatRoomMeta, String> {
        let _guard = self.writes.lock().unwrap();
        let mut metas = self.chat_metas_held()?;
        let mut meta = metas.remove(id).unwrap_or_default();
        f(&mut meta);
        metas.insert(id.into(), meta.clone());
        self.write_held(&self.root.join("chat-meta-v1.json"), &metas)?;
        Ok(meta)
    }

    /// Every saved chat room or promoted work room with an entry in `chat-meta-v1.json`.
    pub fn chat_list(&self) -> Result<Vec<ChatListEntry>, String> {
        let metas = self.chat_metas_held()?;
        let authorities = self.room_authorities()?;
        let mut candidate_ids: std::collections::BTreeSet<String> = metas.keys().cloned().collect();
        for (id, entry) in &authorities {
            let kind: apex_core::RoomKind = entry
                .get("kind")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            if kind.is_chat() {
                candidate_ids.insert(id.clone());
            }
        }
        if let Ok(entries) = std::fs::read_dir(self.root.join("rooms")) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if let Some(id) = room_id_from_file(name) {
                        candidate_ids.insert(id);
                    }
                }
            }
        }
        let mut out = Vec::new();
        for id in candidate_ids {
            let meta = metas.get(&id).cloned();
            let saved = match self.room(&id) {
                Ok(Some(saved)) => saved,
                Ok(None) | Err(_) => continue,
            };
            if !saved.snapshot.kind.is_chat() && meta.is_none() {
                continue;
            }
            let meta = meta.unwrap_or_default();
            let last_msg_at = saved
                .snapshot
                .transcript
                .iter()
                .filter_map(|m| m.at)
                .max()
                .unwrap_or(0);
            let updated_at = meta.updated_at.max(last_msg_at);
            let title = if meta.title.trim().is_empty() {
                "New chat".to_string()
            } else {
                meta.title
            };
            let folder_name = saved
                .cwd
                .as_deref()
                .and_then(|p| Path::new(p).file_name())
                .and_then(|n| n.to_str())
                .map(str::to_owned);
            let mut profiles = meta.profiles;
            profiles.extend(saved.snapshot.import_profiles);
            profiles.retain(|alias, _| saved.snapshot.participants.iter().any(|bot| bot.id.as_str() == alias));
            let participants = saved
                .snapshot
                .participants
                .into_iter()
                .map(|mut p| {
                    if let apex_core::Backend::OpenAiCompatible { ref mut api_key_env, .. } = p.backend {
                        *api_key_env = None;
                    }
                    p
                })
                .collect();
            out.push(ChatListEntry {
                id,
                kind: saved.snapshot.kind,
                title,
                participants,
                updated_at,
                archived: meta.archived,
                cwd: saved.cwd,
                folder_name,
                promoted_from: meta.promoted_from,
                promoted_to: meta.promoted_to,
                moved_to: meta.moved_to,
                profiles,
            });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }
}

/// A pre-provenance room file, mapped to the manifest an import would create.
pub(crate) struct LegacyRoom {
    pub id: String,
    authority: RoomAuthority,
    pub omitted_commands: Vec<apex_core::ParticipantConfig>,
}

/// Room ids by what an import did with them.
pub(crate) struct LegacyRoomOutcome {
    pub imported: Vec<String>,
    /// Restored from legacy data by an earlier import; left as it is.
    pub already: Vec<String>,
    /// Already had a protected manifest of its own; left as it is.
    pub skipped: Vec<String>,
    pub skipped_participants: Vec<String>,
}

/// The folder switches that lead to `cwd`, walking back from it. A mount that
/// does not continue that chain could only have come from an edited file, so it
/// and everything before it is dropped: the missing-folder fallback picks from them.
pub(crate) fn own_lineage(cwd: Option<&str>, mounts: &[MountBoundary]) -> Vec<MountBoundary> {
    let Some(mut expected) = cwd.map(str::to_owned) else { return vec![] };
    let mut kept = vec![];
    for mount in mounts.iter().rev() {
        if mount.to != expected { break; }
        expected = mount.from.clone();
        kept.push(mount.clone());
    }
    kept.reverse();
    kept
}

/// Map one legacy room file: its folder, bots, options and plan switch are
/// kept; automatic access is reset, remembered permissions are left ungranted
/// and outside mounts dropped. Custom commands stay in the original snapshot:
/// arbitrary executables cannot be constrained by a participant's Ask setting.
/// Returns the room and how many permissions and mounts were left out.
pub(crate) fn plan_legacy_room(id: &str, bytes: &[u8]) -> Result<(LegacyRoom, usize, usize), String> {
    let mut saved: SavedRoom = serde_json::from_slice(bytes).map_err(|e| format!("The saved room could not be read: {e}"))?;
    let mounts = own_lineage(saved.cwd.as_deref(), &saved.mounts);
    let dropped = saved.mounts.len() - mounts.len();
    let allowed = saved.snapshot.allowed.len();
    let mut omitted_commands = vec![];
    saved.snapshot.participants.retain_mut(|participant| {
        if matches!(participant.backend, apex_core::Backend::Cli { .. }) {
            omitted_commands.push(participant.clone());
            return false;
        }
        if matches!(participant.access, apex_core::Access::Full | apex_core::Access::Edits) {
            participant.access = apex_core::Access::Ask;
        }
        true
    });
    let authority = RoomAuthority { kind: apex_core::RoomKind::Work, cwd: saved.cwd, participants: saved.snapshot.participants, options: saved.snapshot.options, allowed: vec![], plan: saved.snapshot.plan, mounts, legacy: None };
    Ok((LegacyRoom { id: id.into(), authority, omitted_commands }, allowed, dropped))
}

/// The room id a saved room file belongs to: "<hex id>.json".
pub(crate) fn room_id_from_file(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".json")?;
    if stem.is_empty() || stem.len() % 2 != 0 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    let bytes = (0..stem.len()).step_by(2).map(|i| u8::from_str_radix(&stem[i..i + 2], 16).ok()).collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}

fn steps_entry(record: &ReplySteps, offset: u64, len: u64) -> StepsIndexEntry {
    StepsIndexEntry {
        by: record.by.clone(),
        count: record.steps.len(),
        helpers: record.steps.iter().filter(|step| step.kind == StepKind::Helper).count(),
        offset,
        len,
    }
}

/// Create the host-owned data directory and remove group/other access.
pub(crate) fn prepare_private_root(root: &Path) -> Result<(), String> {
    crate::private_data::prepare(root).map_err(|e| format!("Could not prepare private data folder: {e}"))
}

/// A folder the way the machine sees it: a full path, resolved, and really a
/// folder. Both `allow-root` and the promotion check use this, so a grant and
/// a request can never disagree about `..`, `.` or a symlink.
fn canonical_folder(folder: &Path) -> Result<PathBuf, String> {
    if !folder.is_absolute() {
        return Err(format!("{} isn't a full path.", folder.display()));
    }
    let real = std::fs::canonicalize(folder).map_err(|_| format!("There's no folder at {}.", folder.display()))?;
    if !real.is_dir() {
        return Err(format!("{} isn't a folder.", folder.display()));
    }
    Ok(real)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Publish a complete, flushed room without replacing an existing thread.
/// A killed writer can leave a staging file, never a partial room JSON. Hard
/// linking within this directory provides atomic no-clobber publication on
/// Unix and Windows; unsupported filesystems fail without publishing a room.
fn write_new(path: &Path, saved: &SavedRoom) -> Result<(), String> {
    use std::io::Write;
    static NEXT_STAGE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let bytes = serde_json::to_vec_pretty(saved).map_err(|e| e.to_string())?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let (stage, mut file) = loop {
        let nonce = NEXT_STAGE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let stage = path.with_extension(format!("new-{}-{nonce}.tmp", std::process::id()));
        match options.open(&stage) {
            Ok(file) => break (stage, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not save: {error}")),
        }
    };
    let result = (|| -> std::io::Result<()> {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::hard_link(&stage, path)?;
        sync_directory(path.parent().unwrap())
    })();
    // On publication or sync failure, never unlink the destination: another
    // writer may own it, or our complete room may already be durable there.
    let _ = std::fs::remove_file(&stage);
    result.map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists { "a thread with that id already exists".into() } else { format!("Could not save: {error}") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{Room, RoomOptions};

    fn temp() -> PathBuf {
        // The clock alone can repeat across parallel tests, so tests would share and delete one folder.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        std::env::temp_dir().join(format!("apex-deck-storage-{}-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)))
    }

    #[test]
    fn promote_roots_are_stored_canonical_and_only_cover_their_own_tree() {
        let root = temp();
        let store = Store::new(root.join("saved-chats-v1"));
        let projects = root.join("projects");
        std::fs::create_dir_all(projects.join("denver")).unwrap();
        let allowed = store.allow_promote_root(&projects).unwrap();
        assert_eq!(allowed.path, std::fs::canonicalize(&projects).unwrap().to_string_lossy());
        // Allowing the same folder twice is still one grant.
        store.allow_promote_root(&projects).unwrap();
        assert_eq!(store.promote_roots().unwrap().roots.len(), 1);
        // A folder inside is covered; a sibling is not.
        assert!(store.promote_root_covering(&projects.join("denver")).unwrap().is_some());
        let sibling = root.join("somewhere-else");
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(store.promote_root_covering(&sibling).unwrap().is_none());
        // A folder that isn't there can be neither granted nor matched.
        assert!(store.allow_promote_root(&root.join("missing")).is_err());
        assert!(store.promote_root_covering(&root.join("missing")).is_err());
        // Removing it takes the grant away from everything inside.
        assert!(store.remove_promote_root(&projects).unwrap());
        assert!(!store.remove_promote_root(&projects).unwrap());
        assert!(store.promote_root_covering(&projects.join("denver")).unwrap().is_none());
        assert!(store.promote_roots().unwrap().roots.is_empty());
        // Deck's own folder is never a project folder.
        assert!(store.allow_promote_root(&root.join("saved-chats-v1")).is_err());
    }

    /// Run only in the crash-test child: the kernel terminates the writer in
    /// the middle of the real room-file write, without unwinding its cleanup.
    #[cfg(unix)]
    #[test]
    fn atomic_import_crash_writer_child() {
        let Some(root) = std::env::var_os("APEX_ATOMIC_IMPORT_CRASH_ROOT") else { return; };
        let store = Store::new(PathBuf::from(root).join("saved-chats-v1"));
        let mut snapshot = Room::new(vec![], RoomOptions::default()).with_kind(apex_core::RoomKind::Chat).snapshot();
        snapshot.import_move_id = Some("atomic-move".into());
        snapshot.import_skipped = vec![serde_json::json!({"participant":"test","reason":"x".repeat(16_384)})];
        let saved = SavedRoom { cwd: None, mounts: vec![], snapshot };
        std::fs::create_dir_all(store.root.join("rooms")).unwrap();
        store.save_room_authority("destination", &saved).unwrap();
        let limit = libc::rlimit { rlim_cur: 128, rlim_max: 128 };
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &limit) }, 0);
        unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_DFL); }
        let _ = write_new(&store.room_path("destination"), &saved);
        panic!("the kernel should terminate the oversized room write");
    }

    #[cfg(unix)]
    #[test]
    fn killed_import_writer_never_publishes_partial_room_and_retry_is_idempotent() {
        let root = temp();
        std::fs::create_dir_all(&root).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "storage::tests::atomic_import_crash_writer_child", "--nocapture"])
            .env("APEX_ATOMIC_IMPORT_CRASH_ROOT", &root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGXFSZ));
        let store = Store::new(root.join("saved-chats-v1"));
        assert!(!store.room_path("destination").exists(), "a killed writer must leave no partially published room");
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let host = crate::Host::try_new(crate::HostPaths { data: root.clone(), downloads: None }, runtime.handle().clone()).expect("partial staging files never block startup");
        let import = serde_json::json!({"cmd":"chat_import","args":{"id":"destination","moveId":"atomic-move","participants":[],"entries":[],"title":"Recovered"}});
        let imported = runtime.block_on(host.call_assuming_verified_ui_for_test(serde_json::from_value(import.clone()).unwrap())).unwrap();
        assert_eq!(imported["id"], "destination");
        drop(host);
        let host = crate::Host::try_new(crate::HostPaths { data: root.clone(), downloads: None }, runtime.handle().clone()).unwrap();
        let mut repeat = import;
        repeat["args"]["id"] = "other-destination".into();
        let imported = runtime.block_on(host.call_assuming_verified_ui_for_test(serde_json::from_value(repeat).unwrap())).unwrap();
        assert_eq!(imported["id"], "destination");
        assert!(store.room("other-destination").unwrap().is_none());
        let bytes = std::fs::read(store.room_path("destination")).unwrap();
        let saved = store.room("destination").unwrap().unwrap();
        assert!(store.import_room("destination", &saved).unwrap_err().contains("already exists"));
        let mut different = saved.clone();
        different.snapshot.import_move_id = Some("must-not-replace".into());
        assert!(write_new(&store.room_path("destination"), &different).unwrap_err().contains("already exists"));
        assert_eq!(std::fs::read(store.room_path("destination")).unwrap(), bytes);
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provenance_room_snapshot_cannot_forge_permissions_or_fallback_mounts() {
        let root=temp();let store=Store::new(root.clone());
        let saved=SavedRoom{cwd:Some("/trusted".into()),mounts:vec![],snapshot:Room::new(vec![],RoomOptions::default()).snapshot()};
        store.save_room("r",&saved).unwrap();
        let mut forged=saved.clone();forged.cwd=Some("/outside".into());
        forged.snapshot.plan=true;
        forged.snapshot.allowed.push(apex_core::AllowedRule{by:apex_core::ParticipantId::new("attacker"),kind:apex_core::ActionKind::Command,title:"Forged always allow".into(),what:"sh".into(),allowed_at:1,risky:false});
        forged.mounts.push(MountBoundary{seq:0,change_count:None,from:"/outside".into(),to:"/trusted".into(),note:None});
        std::fs::write(store.room_path("r"),serde_json::to_vec(&forged).unwrap()).unwrap();
        let reopened=Store::new(root.clone()).room("r").unwrap().unwrap();
        assert_eq!(reopened.cwd.as_deref(),Some("/trusted"));
        assert!(reopened.mounts.is_empty());assert!(!reopened.snapshot.plan);assert!(reopened.snapshot.allowed.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_room_file_write_leaves_the_manifest_and_room_as_they_were() {
        let root=temp();let store=Store::new(root.clone());
        let saved=SavedRoom{cwd:Some("/trusted".into()),mounts:vec![],snapshot:Room::new(vec![],RoomOptions::default()).snapshot()};
        store.save_room("r",&saved).unwrap();
        let manifest_before=store.room_authorities().unwrap();
        let room_before=std::fs::read(store.room_path("r")).unwrap();
        // A directory where the atomic writer opens its temporary file makes the room write fail.
        let blocker=store.room_path("r").with_extension("tmp");
        std::fs::create_dir(&blocker).unwrap();
        let mut moved=saved.clone();moved.cwd=Some("/elsewhere".into());
        assert!(store.save_room("r",&moved).is_err());
        std::fs::remove_dir(&blocker).unwrap();
        assert_eq!(store.room_authorities().unwrap(),manifest_before);
        assert_eq!(std::fs::read(store.room_path("r")).unwrap(),room_before);
        assert_eq!(store.room("r").unwrap().unwrap().cwd.as_deref(),Some("/trusted"));
        std::fs::remove_dir_all(root).unwrap();
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
                Store::new(root.clone()).save_room("speed", &SavedRoom { mounts: vec![], cwd: None, snapshot }).unwrap();
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
        let saved = SavedRoom { mounts: vec![], cwd: Some("/tmp".into()), snapshot: room.snapshot() };
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
        store.save_room("src", &SavedRoom { mounts: vec![], cwd: Some("/tmp".into()), snapshot: room.snapshot() }).unwrap();
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
        store.save_room("chat-1", &SavedRoom { mounts: vec![], cwd: None, snapshot: room.snapshot() }).unwrap();
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
        store.save_room("chat-1", &SavedRoom { mounts: vec![], cwd: None, snapshot: room.snapshot() }).unwrap();
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
        store.save_room("source", &SavedRoom { mounts: vec![], cwd: None, snapshot: room.snapshot() }).unwrap();
        for seq in 0..3 { store.save_answer("source", &format!("{seq}:hosting"), "0a1b2c3d", serde_json::Map::new(), 0, 0).unwrap(); }
        store.fork_room("source", "short", Some(1), None).unwrap();
        assert_eq!(store.answers("short").unwrap().unwrap().cards.len(), 1);
        room.rewind(1);
        store.save_room("source", &SavedRoom { mounts: vec![], cwd: None, snapshot: room.snapshot() }).unwrap();
        assert_eq!(store.answers("source").unwrap().unwrap().cards.len(), 1);
        assert!(store.save_answer("source", "2:hosting", "0a1b2c3d", serde_json::Map::new(), 0, 0).is_err(), "late settings for a removed message stay removed");
        room.clear();
        store.save_room("source", &SavedRoom { mounts: vec![], cwd: None, snapshot: room.snapshot() }).unwrap();
        assert!(store.answers("source").unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn reply_steps(by: &str, seq: usize, keys: &[&str]) -> apex_core::work_steps::ReplySteps {
        use apex_core::work_steps::{StepKind, StepStatus, WorkStep};
        let steps = keys.iter().map(|key| WorkStep {
            key: key.to_string(), parent: None, kind: if key.starts_with("helper") { StepKind::Helper } else { StepKind::Command },
            label: key.to_string(), folder: None, detail: String::new(), output: Some(format!("{key} output")),
            status: StepStatus::Done, exit_code: Some(0), duration_ms: Some(5), output_cut: false,
        }).collect();
        apex_core::work_steps::ReplySteps { by: apex_core::ParticipantId::new(by), seq, steps, todo: vec![], dropped: 0 }
    }

    async fn saved_room_with(store: &Store, id: &str, messages: usize) -> Room {
        let mut room = Room::new(vec![], RoomOptions::default());
        for _ in 0..messages { room.post_human("message", &|_| {}).await; }
        store.save_room(id, &SavedRoom { mounts: vec![], cwd: None, snapshot: room.snapshot() }).unwrap();
        room
    }

    #[test]
    fn steps_are_indexed_by_reply_and_read_back_whole() {
        let root = temp();
        let store = Store::new(root.clone());
        assert!(store.steps_index("chat-1").unwrap().is_none());
        assert!(store.steps("chat-1", 1).unwrap().is_none());
        let first = reply_steps("null", 1, &["a", "helper-1", "b"]);
        let second = reply_steps("jigga", 3, &["c"]);
        store.save_steps("chat-1", &first).unwrap();
        store.save_steps("chat-1", &second).unwrap();
        let index = Store::new(root.clone()).steps_index("chat-1").unwrap().unwrap();
        assert_eq!(index.version, 1);
        assert_eq!(index.replies.keys().copied().collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!((index.replies[&1].by.as_str(), index.replies[&1].count, index.replies[&1].helpers), ("null", 3, 1));
        assert_eq!(store.steps("chat-1", 1).unwrap().unwrap(), first);
        assert_eq!(store.steps("chat-1", 3).unwrap().unwrap(), second);
        assert!(store.steps("chat-1", 2).unwrap().is_none());
        let on_disk = serde_json::to_value(&index).unwrap();
        assert_eq!(on_disk["replies"]["1"]["count"], 3);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            for path in [store.steps_path("chat-1"), store.steps_index_path("chat-1")] {
                assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn truncate_and_fork_prune_steps() {
        let root = temp();
        let store = Store::new(root.clone());
        let mut room = saved_room_with(&store, "source", 4).await;
        store.save_steps("source", &reply_steps("null", 1, &["a"])).unwrap();
        store.save_steps("source", &reply_steps("null", 3, &["b", "c"])).unwrap();
        store.fork_room("source", "fork", Some(2), None).unwrap();
        let fork = store.steps_index("fork").unwrap().unwrap();
        assert_eq!(fork.replies.keys().copied().collect::<Vec<_>>(), vec![1]);
        assert_eq!(store.steps("fork", 1).unwrap().unwrap(), reply_steps("null", 1, &["a"]));
        assert_eq!(store.steps_index("source").unwrap().unwrap().replies.len(), 2, "the source keeps its own");

        room.rewind(2);
        store.save_room("source", &SavedRoom { mounts: vec![], cwd: None, snapshot: room.snapshot() }).unwrap();
        let source = store.steps_index("source").unwrap().unwrap();
        assert_eq!(source.replies.keys().copied().collect::<Vec<_>>(), vec![1]);
        assert_eq!(store.steps("source", 1).unwrap().unwrap(), reply_steps("null", 1, &["a"]));
        assert!(store.steps("source", 3).unwrap().is_none());
        // A later reply at a removed seq gets its own record.
        store.save_steps("source", &reply_steps("jigga", 3, &["d"])).unwrap();
        assert_eq!(store.steps("source", 3).unwrap().unwrap(), reply_steps("jigga", 3, &["d"]));

        room.clear();
        store.save_room("source", &SavedRoom { mounts: vec![], cwd: None, snapshot: room.snapshot() }).unwrap();
        assert!(store.steps_index("source").unwrap().is_none());
        assert!(!store.steps_path("source").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn steps_file_removed_with_room() {
        let root = temp();
        let store = Store::new(root.clone());
        saved_room_with(&store, "chat-1", 2).await;
        store.save_steps("chat-1", &reply_steps("null", 1, &["a"])).unwrap();
        store.delete_room("chat-1").unwrap();
        assert!(!store.steps_path("chat-1").exists());
        assert!(!store.steps_index_path("chat-1").exists());

        let saved = SavedRoom { mounts: vec![], cwd: None, snapshot: Room::new(vec![], RoomOptions::default()).snapshot() };
        store.save_steps("leftover", &reply_steps("null", 1, &["a"])).unwrap();
        std::fs::remove_file(store.steps_index_path("leftover")).unwrap();
        assert!(store.import_room("leftover", &saved).is_err(), "a leftover steps file keeps the id taken");
        assert!(store.room("leftover").unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_damaged_steps_index_is_reported_and_never_written_over() {
        let root = temp();
        let store = Store::new(root.clone());
        store.save_steps("chat-1", &reply_steps("null", 1, &["a"])).unwrap();
        let path = store.steps_index_path("chat-1");
        std::fs::write(&path, "broken").unwrap();
        assert!(store.steps_index("chat-1").is_err());
        assert!(store.save_steps("chat-1", &reply_steps("null", 2, &["b"])).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
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
