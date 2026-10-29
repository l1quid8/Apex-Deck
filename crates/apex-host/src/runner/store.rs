use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::runner::model::{RunnerSnapshot, SCHEMA_VERSION};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RunnerDocument {
    #[serde(default)]
    runners: HashMap<String, RunnerSnapshot>,
    #[serde(default)]
    receipts: HashMap<String, RunnerSnapshot>, // requestId -> snapshot result
}

pub struct RunnerStore {
    path: PathBuf,
}

impl RunnerStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { path: data_dir.join("room-runners-v1.json") }
    }

    fn read_doc(&self) -> Result<RunnerDocument, String> {
        match crate::authority_file::read(&self.path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RunnerDocument::default()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write_doc(&self, doc: &RunnerDocument) -> Result<(), String> {
        let bytes = serde_json::to_vec(doc).map_err(|e| e.to_string())?;
        crate::authority_file::write(&self.path, &bytes).map_err(|e| e.to_string())
    }

    pub fn load(&self, room_id: &str) -> Result<Option<RunnerSnapshot>, String> {
        let doc = self.read_doc()?;
        Ok(doc.runners.get(room_id).cloned())
    }

    pub fn load_all(&self) -> Result<HashMap<String, RunnerSnapshot>, String> {
        Ok(self.read_doc()?.runners)
    }

    /// Attempt to commit snapshot if expected revision matches (compare-and-set)
    /// expected_revision None means create only if absent or terminal
    pub fn commit(&self, snapshot: RunnerSnapshot, expected_revision: Option<u64>, request_id: Option<String>) -> Result<CommitResult, String> {
        let mut doc = self.read_doc()?;
        let room_id = snapshot.room_id.clone();

        // Idempotency: if request_id exists, return its receipt
        if let Some(req) = &request_id {
            if let Some(receipt) = doc.receipts.get(req) {
                if receipt.room_id == room_id {
                    return Ok(CommitResult::Applied(receipt.clone()));
                }
            }
        }

        if let Some(exp) = expected_revision {
            if let Some(existing) = doc.runners.get(&room_id) {
                if existing.revision != exp {
                    return Ok(CommitResult::Conflict(existing.clone()));
                }
            } else if exp != 0 {
                // expecting revision but none exists
                return Ok(CommitResult::ConflictMissing);
            }
        }

        // Validate schema version
        if snapshot.schema_version != SCHEMA_VERSION {
            return Err(format!("unsupported schemaVersion {}", snapshot.schema_version));
        }

        doc.runners.insert(room_id.clone(), snapshot.clone());
        if let Some(req) = request_id {
            doc.receipts.insert(req, snapshot.clone());
        }
        self.write_doc(&doc)?;
        Ok(CommitResult::Applied(snapshot))
    }

    pub fn remove(&self, room_id: &str) -> Result<(), String> {
        let mut doc = self.read_doc()?;
        doc.runners.remove(room_id);
        self.write_doc(&doc)
    }

    // For recovery: restore paused with recovery reason
    pub fn recover_paused(&self, _now_ms: u64) -> Result<Vec<RunnerSnapshot>, String> {
        let mut doc = self.read_doc()?;
        let mut recovered = Vec::new();
        let mut changed = false;
        for snap in doc.runners.values_mut() {
            if !snap.is_terminal() {
                // Recovery path: if running/scheduled/waiting, set paused recovery
                if snap.reason != crate::runner::model::RunnerReason::Recovery {
                    snap.phase = crate::runner::model::RunnerPhase::Paused;
                    snap.reason = crate::runner::model::RunnerReason::Recovery;
                    snap.revision += 1;
                    snap.generation += 1; snap.in_flight = None;
                    recovered.push(snap.clone());
                    changed = true;
                }
            }
        }
        if changed {
            self.write_doc(&doc)?;
        }
        Ok(recovered)
    }

    pub fn receipt(&self, request_id: &str) -> Result<Option<RunnerSnapshot>, String> {
        Ok(self.read_doc()?.receipts.get(request_id).cloned())
    }
}

#[derive(Debug, Clone)]
pub enum CommitResult {
    Applied(RunnerSnapshot),
    Conflict(RunnerSnapshot),
    ConflictMissing,
}
