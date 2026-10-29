use std::path::PathBuf;
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
            consecutive_unchanged: 0,
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

    /// Host-owned reconciliation: consumes wake cause, returns optional dispatch.
    /// Persists state transitions before dispatch reservation.
    pub fn reconcile(&self, room_id: &str, cause: crate::runner::scheduler::RunnerWake, now_ms: u64) -> Result<Option<crate::runner::scheduler::Dispatch>, String> {
        // Load current snapshot
        let Some(snapshot) = self.store.load(room_id)? else {
            return Ok(None);
        };
        // Evaluate
        let eval = crate::runner::scheduler::eval_dispatch(&snapshot, &cause, now_ms)?;
        // Persist snapshot if changed
        if eval.snapshot.revision != snapshot.revision || eval.snapshot.phase != snapshot.phase || eval.snapshot.reason != snapshot.reason || eval.snapshot.next_run_at != snapshot.next_run_at || eval.snapshot.pending_request_id != snapshot.pending_request_id {
            // Commit with expected revision = previous
            match self.store.commit(eval.snapshot.clone(), Some(snapshot.revision), None)? {
                CommitResult::Applied(s) => {
                    // Return dispatch based on new snapshot, but need to ensure we use updated snapshot for dispatch eligibility
                    // If eval already produced dispatch, we keep it; else re-eval with new snapshot? For simplicity, return eval dispatch
                    return Ok(eval.dispatch);
                }
                CommitResult::Conflict(cur) => {
                    // Conflict: retry once with current
                    let retry_eval = crate::runner::scheduler::eval_dispatch(&cur, &cause, now_ms)?;
                    if retry_eval.snapshot.revision != cur.revision {
                        self.store.commit(retry_eval.snapshot.clone(), Some(cur.revision), None)?;
                    }
                    return Ok(retry_eval.dispatch);
                }
                CommitResult::ConflictMissing => return Ok(None),
            }
        }
        Ok(eval.dispatch)
    }

    /// Reservation before dispatch: increments invocation count and persists.
    /// Called just before provider call, with lock held only for file write (no await).
    pub fn reserve_dispatch(&self, dispatch: &crate::runner::scheduler::Dispatch, now_ms: u64) -> Result<RunnerSnapshot, String> {
        let existing = self.store.load(&dispatch.room_id)?.ok_or("no runner")?;
        if existing.generation != dispatch.key.generation || existing.id != dispatch.key.runner_id {
            return Err("stale generation".into());
        }
        // Reserve
        let mut next = existing.clone();
        next.usage.invocations += 1;
        next.usage.elapsed_ms = now_ms.saturating_sub(next.started_at);
        next.revision += 1;
        // For goal, also count as turn attempt? Plan says reserve invocation/turn before dispatch
        if next.kind == RunnerKind::Goal {
            // Reserve turn? We count turns on completion, but also reserve invocations.
        }
        match self.store.commit(next.clone(), Some(existing.revision), None)? {
            CommitResult::Applied(s) => Ok(s),
            CommitResult::Conflict(cur) => Err(format!("conflict on reserve: expected {} got {}", existing.revision, cur.revision)),
            CommitResult::ConflictMissing => Err("runner missing on reserve".into()),
        }
    }

    /// Apply completion result from provider turn
    pub fn complete_turn(&self, room_id: &str, attempt: crate::runner::scheduler::RunnerAttemptKey, checkpoint: RunnerCheckpoint, cost_micros: Option<u64>, now_ms: u64) -> Result<Option<crate::runner::scheduler::Dispatch>, String> {
        let wake = crate::runner::scheduler::RunnerWake::TurnCompleted {
            room_id: room_id.to_string(),
            attempt_id: attempt.attempt_id,
            generation: attempt.generation,
            cost_micros,
            checkpoint,
        };
        self.reconcile(room_id, wake, now_ms)
    }

    pub fn complete_turn_from_report(&self, room_id: &str, attempt: crate::runner::scheduler::RunnerAttemptKey, reply_text: &str, cost_micros: Option<u64>, now_ms: u64) -> Result<(Option<crate::runner::scheduler::Dispatch>, Option<String>), String> {
        // Parse strict report
        match crate::runner::report::parse_report(reply_text) {
            Ok(report) => {
                let checkpoint = RunnerCheckpoint {
                    done: report.done.clone(),
                    next: report.next.clone(),
                    blocker: report.blocker.clone(),
                    criteria: report.criteria.iter().map(|c| RunnerCriteria { id: c.id.clone(), status: c.status.clone(), evidence: c.evidence.clone() }).collect(),
                };
                // Handle disposition
                if report.disposition == "blocked" {
                    // Pause as blocked
                    let existing = self.store.load(room_id)?.ok_or("no runner")?;
                    let next = crate::runner::model::reduce(existing.clone(), RunnerEvent::Failed { reason: RunnerReason::Blocked }, now_ms).map_err(|e| format!("{:?}", e))?.snapshot;
                    self.store.commit(next.clone(), Some(existing.revision), None)?;
                    return Ok((None, Some("blocked".into())));
                }
                if report.disposition == "done" {
                    // Verification: for now, if any criteria failed, pause
                    if report.criteria.iter().any(|c| c.status == "failed") {
                        let existing = self.store.load(room_id)?.ok_or("no runner")?;
                        let mut next = existing.clone();
                        next.phase = RunnerPhase::Paused;
                        next.reason = RunnerReason::Blocked;
                        next.revision += 1;
                        next.checkpoint = Some(checkpoint.clone());
                        self.store.commit(next, Some(existing.revision), None)?;
                        return Ok((None, Some("criteria failed".into())));
                    }
                    // If done and criteria all done, mark completed after storing checkpoint
                    let dispatch = self.complete_turn(room_id, attempt.clone(), checkpoint, cost_micros, now_ms)?;
                    // Then also complete
                    if let Some(snap) = self.store.load(room_id)? {
                        if snap.phase == RunnerPhase::Running {
                            let trans = crate::runner::model::reduce(snap.clone(), RunnerEvent::Completed, now_ms).map_err(|e| format!("{:?}", e))?;
                            self.store.commit(trans.snapshot, Some(snap.revision), None)?;
                        }
                    }
                    return Ok((dispatch, Some("completed".into())));
                }
                // working
                let dispatch = self.complete_turn(room_id, attempt, checkpoint, cost_micros, now_ms)?;
                Ok((dispatch, Some("working".into())))
            }
            Err(e) => {
                // Missing/malformed structured report pauses as provider_error
                let existing = self.store.load(room_id)?.ok_or("no runner")?;
                let mut next = existing.clone();
                next.phase = RunnerPhase::Paused;
                next.reason = RunnerReason::ProviderError;
                next.revision += 1;
                self.store.commit(next, Some(existing.revision), None)?;
                Ok((None, Some(format!("report error: {:?}", e))))
            }
        }
    }

    pub fn complete_loop_run(&self, room_id: &str, attempt: crate::runner::scheduler::RunnerAttemptKey, cost_micros: Option<u64>, now_ms: u64) -> Result<Option<crate::runner::scheduler::Dispatch>, String> {
        let wake = crate::runner::scheduler::RunnerWake::LoopRunCompleted {
            room_id: room_id.to_string(),
            attempt_id: attempt.attempt_id,
            generation: attempt.generation,
            cost_micros,
        };
        self.reconcile(room_id, wake, now_ms)
    }

    pub fn notify_human_message(&self, room_id: &str, now_ms: u64) -> Result<(), String> {
        let wake = crate::runner::scheduler::RunnerWake::HumanMessage { room_id: room_id.to_string() };
        self.reconcile(room_id, wake, now_ms)?;
        Ok(())
    }

    pub fn notify_stop(&self, room_id: &str, now_ms: u64) -> Result<(), String> {
        let wake = crate::runner::scheduler::RunnerWake::Stop { room_id: room_id.to_string() };
        self.reconcile(room_id, wake, now_ms)?;
        Ok(())
    }

    pub fn notify_waiting(&self, room_id: &str, request_id: String, reason: RunnerReason, now_ms: u64) -> Result<(), String> {
        let wake = crate::runner::scheduler::RunnerWake::Waiting { room_id: room_id.to_string(), request_id, reason };
        self.reconcile(room_id, wake, now_ms)?;
        Ok(())
    }

    pub fn invalidate(&self, room_id: &str, now_ms: u64) -> Result<(), String> {
        let Some(existing) = self.store.load(room_id)? else { return Ok(()); };
        if existing.is_terminal() { return Ok(()); }
        let mut next = existing.clone();
        next.generation += 1;
        next.phase = RunnerPhase::Paused;
        next.reason = RunnerReason::Configuration;
        next.revision += 1;
        next.pending_request_id = None;
        next.next_run_at = None;
        next.usage.elapsed_ms = now_ms.saturating_sub(next.started_at);
        let _ = self.store.commit(next, Some(existing.revision), None)?;
        Ok(())
    }
}
