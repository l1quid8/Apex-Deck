use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use crate::runner::store::{RunnerStore, CommitResult};
use crate::runner::model::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerStartInput {
    pub id: String, // room id
    pub request_id: String,
    pub expected_room_revision: Option<u64>,
    pub runner: RunnerStartPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerStartPayload {
    pub schema_version: u32,
    pub kind: RunnerKind,
    pub objective: Option<String>,
    pub prompt: Option<String>,
    pub interval_seconds: Option<u64>,
    pub workers: Vec<String>,
    pub checker: Option<String>,
    pub limits: RunnerLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerActionInput {
    pub id: String, // room id
    pub runner_id: String,
    pub expected_revision: u64,
    pub request_id: String,
    pub action: RunnerActionPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerActionPayload {
    pub action: String, // pause|resume|end|update_limits|dismiss
    pub limits: Option<RunnerLimits>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunnerMutation {
    #[serde(rename = "applied")]
    Applied(RunnerSnapshot),
    #[serde(rename = "conflict")]
    Conflict(Option<RunnerSnapshot>),
}

pub struct RunnerService {
    store: RunnerStore,
    // Track mutations receipts in memory to avoid reading file repeatedly? store already handles.
}

impl RunnerService {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { store: RunnerStore::new(data_dir) }
    }

    pub fn state(&self, room_id: &str) -> Result<Option<RunnerSnapshot>, String> {
        self.store.load(room_id)
    }

    pub fn start(&self, input: RunnerStartInput, now_ms: u64) -> Result<RunnerMutation, String> {
        if input.runner.schema_version != SCHEMA_VERSION {
            return Err(format!("unsupported schemaVersion {}", input.runner.schema_version));
        }
        input.runner.limits.validate()?;

        // Idempotency first
        if let Some(receipt) = self.store.receipt(&input.request_id)? {
            if receipt.room_id == input.id {
                return Ok(RunnerMutation::Applied(receipt));
            }
        }

        // Check existing runner active
        let existing = self.store.load(&input.id)?;
        if let Some(ref ex) = existing {
            if ex.is_active() && !ex.dismissed {
                return Ok(RunnerMutation::Conflict(Some(ex.clone())));
            }
        }

        let expected = existing.as_ref().map(|s| s.revision).unwrap_or(0);

        // If caller provided expected_room_revision, we ignore for now; plan says use room revision compare-and-set
        // but we implement runner revision CAS only.

        let id = format!("runner-{}-{}", input.id, now_ms);
        let deadline = now_ms + input.runner.limits.lifetime_ms;
        let is_loop = input.runner.kind == RunnerKind::Loop;
        let next_run = if is_loop {
            Some(now_ms) // immediate first run
        } else { None };

        let snapshot = RunnerSnapshot {
            schema_version: SCHEMA_VERSION,
            id,
            room_id: input.id.clone(),
            revision: expected + 1,
            generation: existing.map(|e| e.generation + 1).unwrap_or(1),
            kind: input.runner.kind.clone(),
            phase: if is_loop { RunnerPhase::Scheduled } else { RunnerPhase::Running },
            reason: RunnerReason::None,
            objective: input.runner.objective,
            prompt: input.runner.prompt,
            interval_seconds: input.runner.interval_seconds,
            workers: input.runner.workers.clone(),
            checker: input.runner.checker,
            checkpoint: None,
            limits: input.runner.limits.clone(),
            usage: RunnerUsage { turns: 0, invocations: 0, cost_micros: None, unknown_cost_turns: 0, elapsed_ms: 0 },
            started_at: now_ms,
            deadline_at: deadline,
            next_run_at: next_run,
            pending_request_id: None,
            dismissed: false,
        };

        validate_start(&snapshot).map_err(|e| e)?;

        match self.store.commit(snapshot.clone(), Some(expected), Some(input.request_id))? {
            CommitResult::Applied(s) => Ok(RunnerMutation::Applied(s)),
            CommitResult::Conflict(cur) => Ok(RunnerMutation::Conflict(Some(cur))),
            CommitResult::ConflictMissing => Ok(RunnerMutation::Conflict(None)),
        }
    }

    pub fn action(&self, input: RunnerActionInput, now_ms: u64) -> Result<RunnerMutation, String> {
        let existing = self.store.load(&input.id)?.ok_or("no runner".to_string())?;
        if existing.id != input.runner_id {
            return Ok(RunnerMutation::Conflict(Some(existing)));
        }
        if existing.revision != input.expected_revision {
            return Ok(RunnerMutation::Conflict(Some(existing)));
        }

        // check request id idempotency
        if let Some(receipt) = self.store.receipt(&input.request_id)? {
            if receipt.room_id == input.id {
                return Ok(RunnerMutation::Applied(receipt));
            }
        }

        let event = match input.action.action.as_str() {
            "pause" => RunnerEvent::Pause { reason: RunnerReason::Human },
            "resume" => RunnerEvent::Resume,
            "end" => RunnerEvent::End { reason: RunnerReason::Human },
            "dismiss" => {
                // dismiss clears presentation but keeps terminal; if not terminal, treat as end?
                let mut snap = existing.clone();
                snap.dismissed = true;
                snap.revision += 1;
                match self.store.commit(snap.clone(), Some(input.expected_revision), Some(input.request_id))? {
                    CommitResult::Applied(s) => return Ok(RunnerMutation::Applied(s)),
                    CommitResult::Conflict(cur) => return Ok(RunnerMutation::Conflict(Some(cur))),
                    CommitResult::ConflictMissing => return Ok(RunnerMutation::Conflict(None)),
                }
            }
            "update_limits" => {
                let new_limits = input.action.limits.ok_or("limits required")?;
                new_limits.validate()?;
                let mut snap = existing.clone();
                snap.limits = new_limits;
                snap.revision += 1;
                // if lowering below usage, pause
                if let Some(max_turns) = snap.limits.max_turns {
                    if snap.usage.turns >= max_turns {
                        snap.phase = RunnerPhase::Paused;
                        snap.reason = RunnerReason::Limit;
                    }
                }
                match self.store.commit(snap.clone(), Some(input.expected_revision), Some(input.request_id))? {
                    CommitResult::Applied(s) => return Ok(RunnerMutation::Applied(s)),
                    CommitResult::Conflict(cur) => return Ok(RunnerMutation::Conflict(Some(cur))),
                    CommitResult::ConflictMissing => return Ok(RunnerMutation::Conflict(None)),
                }
            }
            _ => return Err(format!("unknown action {}", input.action.action)),
        };

        let transition = reduce(existing.clone(), event, now_ms).map_err(|e| format!("{:?}", e))?;
        match self.store.commit(transition.snapshot, Some(input.expected_revision), Some(input.request_id))? {
            CommitResult::Applied(s) => Ok(RunnerMutation::Applied(s)),
            CommitResult::Conflict(cur) => Ok(RunnerMutation::Conflict(Some(cur))),
            CommitResult::ConflictMissing => Ok(RunnerMutation::Conflict(None)),
        }
    }

    pub fn recover_paused(&self, now_ms: u64) -> Result<Vec<RunnerSnapshot>, String> {
        self.store.recover_paused(now_ms)
    }

    pub fn load_all(&self) -> Result<std::collections::HashMap<String, RunnerSnapshot>, String> {
        self.store.load_all()
    }
}
