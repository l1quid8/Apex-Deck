use crate::authority_file::VersionedDocument;
use crate::runner::model::{RunnerSnapshot, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RunnerDocument {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    runners: HashMap<String, RunnerSnapshot>,
    #[serde(default)]
    receipts: HashMap<String, RunnerSnapshot>, // requestId -> snapshot result
}

impl VersionedDocument for RunnerDocument {
    const FIRST_VERSION: u32 = 0;
    const MIGRATIONS: &'static [crate::authority_file::Migration] = &[|bytes| {
        let mut document: RunnerDocument = serde_json::from_slice(bytes)?;
        document.version = 1;
        serde_json::to_vec(&document)
    }];
}

pub struct RunnerStore {
    path: PathBuf,
    unavailable: Option<String>,
    // The admitted host exclusively owns this ledger for its lifetime, like
    // the assistant task store. Countdown/state polls must not reauthenticate
    // and transfer the entire protected document through the broker each time.
    document: Mutex<Option<RunnerDocument>>,
}

impl RunnerStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            path: data_dir.join("room-runners-v1.json"),
            unavailable: None,
            document: Mutex::new(None),
        }
    }

    pub fn disable(&mut self, reason: String) {
        self.unavailable = Some(format!(
            "Goals and loops unavailable until host restart: {reason}"
        ));
    }

    pub fn is_available(&self) -> bool {
        self.unavailable.is_none()
    }

    fn with_doc<T>(
        &self,
        operation: impl FnOnce(&mut RunnerDocument) -> Result<T, String>,
    ) -> Result<T, String> {
        if let Some(reason) = &self.unavailable {
            return Err(reason.clone());
        }
        let mut cached = self.document.lock().map_err(|e| e.to_string())?;
        if cached.is_none() {
            *cached = Some(match RunnerDocument::read_from(&self.path) {
                Ok(document) => document,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => RunnerDocument { version: 1, ..Default::default() },
                Err(e) => return Err(e.to_string()),
            });
        }
        let result = operation(cached.as_mut().expect("document loaded"));
        if result.is_err() {
            // The helper may have committed before its reply was lost. A
            // fresh protected read recovers both the document and its broker
            // CAS revision; never continue from an uncertain cached state.
            *cached = None;
        }
        result
    }

    fn write_doc(&self, doc: &RunnerDocument) -> Result<(), String> {
        doc.write_to(&self.path).map_err(|e| e.to_string())
    }

    pub fn load(&self, room_id: &str) -> Result<Option<RunnerSnapshot>, String> {
        self.with_doc(|doc| Ok(doc.runners.get(room_id).cloned()))
    }

    pub fn load_all(&self) -> Result<HashMap<String, RunnerSnapshot>, String> {
        self.with_doc(|doc| Ok(doc.runners.clone()))
    }

    /// Attempt to commit snapshot if expected revision matches (compare-and-set)
    /// expected_revision None means create only if absent or terminal
    pub fn commit(
        &self,
        snapshot: RunnerSnapshot,
        expected_revision: Option<u64>,
        request_id: Option<String>,
    ) -> Result<CommitResult, String> {
        self.with_doc(|current| {
            let mut doc = current.clone();
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
                return Err(format!(
                    "unsupported schemaVersion {}",
                    snapshot.schema_version
                ));
            }

            doc.runners.insert(room_id.clone(), snapshot.clone());
            if let Some(req) = request_id {
                doc.receipts.insert(req, snapshot.clone());
            }
            self.write_doc(&doc)?;
            *current = doc;
            Ok(CommitResult::Applied(snapshot))
        })
    }

    pub fn remove(&self, room_id: &str) -> Result<(), String> {
        self.with_doc(|current| {
            let mut doc = current.clone();
            doc.runners.remove(room_id);
            self.write_doc(&doc)?;
            *current = doc;
            Ok(())
        })
    }

    // For recovery: restore paused with recovery reason
    pub fn recover_paused(&self, _now_ms: u64) -> Result<Vec<RunnerSnapshot>, String> {
        self.with_doc(|current| {
            let mut doc = current.clone();
            let mut recovered = Vec::new();
            let mut changed = false;
            for snap in doc.runners.values_mut() {
                if !snap.is_terminal() {
                    // Recovery path: if running/scheduled/waiting, set paused recovery
                    if snap.reason != crate::runner::model::RunnerReason::Recovery {
                        snap.phase = crate::runner::model::RunnerPhase::Paused;
                        snap.reason = crate::runner::model::RunnerReason::Recovery;
                        snap.revision += 1;
                        snap.generation += 1;
                        snap.in_flight = None;
                        recovered.push(snap.clone());
                        changed = true;
                    }
                }
            }
            if changed {
                self.write_doc(&doc)?;
                *current = doc;
            }
            Ok(recovered)
        })
    }

    pub fn receipt(&self, request_id: &str) -> Result<Option<RunnerSnapshot>, String> {
        self.with_doc(|doc| Ok(doc.receipts.get(request_id).cloned()))
    }
}

#[derive(Debug, Clone)]
pub enum CommitResult {
    Applied(RunnerSnapshot),
    Conflict(RunnerSnapshot),
    ConflictMissing,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unversioned_runner_and_receipt_survive_upgrade_and_restart() {
        let root = crate::project_process::TestDataDir::new();
        let store = RunnerStore::new(root.path().to_owned());
        let snapshot = serde_json::json!({
            "schemaVersion":1,"id":"r","roomId":"room","revision":2,"generation":2,
            "kind":"loop","phase":"ended","reason":"human",
            "limits":crate::runner::RunnerLimits::default_limits(),
            "usage":crate::runner::RunnerUsage::default(),"startedAt":1000,"deadlineAt":10000
        });
        let old = serde_json::to_vec(&serde_json::json!({
            "runners": {"room": snapshot}, "receipts": {"request": snapshot}
        })).unwrap();
        crate::authority_file::write(&store.path, &old).unwrap();
        let receipt = store.receipt("request").unwrap().unwrap();
        assert_eq!(store.load("room").unwrap().unwrap(), receipt);
        assert_eq!(crate::authority_file::read(&store.path).unwrap(), old);

        let mut updated = receipt.clone();
        updated.revision += 1;
        assert!(matches!(store.commit(updated.clone(), Some(2), None).unwrap(), CommitResult::Applied(_)));
        let saved: serde_json::Value = serde_json::from_slice(&crate::authority_file::read(&store.path).unwrap()).unwrap();
        assert_eq!(saved["version"], 1);
        let reopened = RunnerStore::new(root.path().to_owned());
        assert_eq!(reopened.receipt("request").unwrap().unwrap(), receipt);
        assert_eq!(reopened.load("room").unwrap().unwrap(), updated);
    }

    #[test]
    fn unsupported_runner_document_stays_untouched() {
        let root = crate::project_process::TestDataDir::new();
        let store = RunnerStore::new(root.path().to_owned());
        for bytes in [br#"{"version":2}"#.as_slice(), br#"{"version":null}"#, br#"{"runners":false}"#] {
            crate::authority_file::write(&store.path, bytes).unwrap();
            assert!(store.remove("room").is_err());
            assert_eq!(crate::authority_file::read(&store.path).unwrap(), bytes);
        }
    }

    #[test]
    fn uncertain_write_reloads_durable_state_before_serving_or_changing_it() {
        let root =
            std::env::temp_dir().join(format!("runner-uncertain-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let store = RunnerStore::new(root.clone());
        assert!(store.load("room").unwrap().is_none());
        let ended: RunnerSnapshot = serde_json::from_value(serde_json::json!({
            "schemaVersion":1,"id":"r","roomId":"room","revision":2,"generation":2,
            "kind":"loop","phase":"ended","reason":"human",
            "limits":crate::runner::RunnerLimits::default_limits(),
            "usage":crate::runner::RunnerUsage::default(),"startedAt":1000,"deadlineAt":10000
        }))
        .unwrap();
        let error = store
            .with_doc(|current| {
                let mut committed = current.clone();
                committed.runners.insert("room".into(), ended.clone());
                // The helper saves before it sends its signed acknowledgement.
                // Model an EOF after that durable save, with the old cache intact.
                store.write_doc(&committed)?;
                Err::<(), String>("helper response lost after commit".into())
            })
            .unwrap_err();
        assert_eq!(error, "helper response lost after commit");
        assert_eq!(store.load("room").unwrap().unwrap(), ended);
        let mut replacement = ended;
        replacement.revision = 3;
        replacement.generation = 3;
        assert!(matches!(
            store.commit(replacement, Some(2), None).unwrap(),
            CommitResult::Applied(_)
        ));
        assert_eq!(
            RunnerStore::new(root.clone())
                .load("room")
                .unwrap()
                .unwrap()
                .revision,
            3
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
