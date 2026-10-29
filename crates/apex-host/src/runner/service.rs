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
    #[serde(default)]
    pub checks: Vec<super::checks::ConfiguredCheck>,
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

    pub fn disable(&mut self, reason: String) { self.store.disable(reason); }

    pub fn is_available(&self) -> bool { self.store.is_available() }

    pub fn state(&self, room_id: &str) -> Result<Option<RunnerSnapshot>, String> {
        self.store.load(room_id)
    }

    pub fn replay(&self,request:&str,room:&str)->Result<Option<RunnerSnapshot>,String>{
        let receipt=self.store.receipt(request)?;
        if receipt.as_ref().is_some_and(|s|s.room_id!=room){return Err("request ID belongs to another room".into());}
        Ok(receipt)
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

        let id = format!("runner-{}-{}-{}", input.id, now_ms, expected+1);
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
            consecutive_unchanged: 0, in_flight: None, worker_index: 0, reply_seqs: vec![], checks: input.runner.checks, changed_paths: vec![], accounted: vec![], check_results: vec![], made_change: false,
        };

        validate_start(&snapshot).map_err(|e| e)?;

        match self.store.commit(snapshot.clone(), Some(expected), Some(input.request_id))? {
            CommitResult::Applied(s) => Ok(RunnerMutation::Applied(s)),
            CommitResult::Conflict(cur) => Ok(RunnerMutation::Conflict(Some(cur))),
            CommitResult::ConflictMissing => Ok(RunnerMutation::Conflict(None)),
        }
    }

    pub fn action(&self, input: RunnerActionInput, now_ms: u64) -> Result<RunnerMutation, String> {
        if let Some(receipt) = self.store.receipt(&input.request_id)? {
            if receipt.room_id == input.id { return Ok(RunnerMutation::Applied(receipt)); }
            return Err("request ID belongs to another room".into());
        }
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
                if !existing.is_terminal() { return Err("End the runner before dismissing".into()); }
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
                snap.deadline_at = snap.started_at.saturating_add(snap.limits.lifetime_ms);
                snap.revision += 1;
                if limit_reached(&snap,now_ms) {
                    snap.phase=RunnerPhase::Paused;snap.reason=RunnerReason::Limit;
                    snap.generation+=1;snap.in_flight=None;snap.next_run_at=None;
                }
                match self.store.commit(snap.clone(), Some(input.expected_revision), Some(input.request_id))? {
                    CommitResult::Applied(s) => return Ok(RunnerMutation::Applied(s)),
                    CommitResult::Conflict(cur) => return Ok(RunnerMutation::Conflict(Some(cur))),
                    CommitResult::ConflictMissing => return Ok(RunnerMutation::Conflict(None)),
                }
            }
            _ => return Err(format!("unknown action {}", input.action.action)),
        };

        if input.action.action == "resume" && limit_reached(&existing, now_ms) { return Err("Increase the exhausted limit before resuming".into()); }
        let mut transition = reduce(existing.clone(), event, now_ms).map_err(|e| format!("{:?}", e))?;
        transition.snapshot.revision = existing.revision + 1;
        if matches!(input.action.action.as_str(), "pause" | "end") {
            transition.snapshot.generation = existing.generation + 1;
            transition.snapshot.in_flight = None;
        }
        if input.action.action == "resume" && transition.snapshot.phase == RunnerPhase::Scheduled {
            transition.snapshot.next_run_at = Some(now_ms.saturating_add(existing.interval_seconds.unwrap_or(600) * 1000));
        }
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
                CommitResult::Applied(_s) => {
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
        let mut next = self.store.load(&dispatch.room_id)?.ok_or("no runner")?;
        if next.generation != dispatch.key.generation || next.id != dispatch.key.runner_id || next.is_terminal() || !matches!(next.phase, RunnerPhase::Running | RunnerPhase::Scheduled) || next.in_flight.is_some() {
            return Err("stale or ineligible dispatch".into());
        }
        if limit_reached(&next, now_ms) { self.pause_reason(&dispatch.room_id, RunnerReason::Limit, now_ms)?; return Err("runner limit reached".into()); }
        let previous = next.revision;
        next.in_flight = Some(dispatch.key.attempt_id.clone());
        next.made_change=false;
        next.phase = RunnerPhase::Running;
        next.next_run_at = None;
        next.usage.invocations += 1;
        next.usage.unknown_cost_turns += 1;
        if next.kind == RunnerKind::Goal || next.worker_index == 0 { next.usage.turns += 1; }
        next.usage.elapsed_ms = now_ms.saturating_sub(next.started_at).max(next.usage.elapsed_ms);
        next.revision += 1;
        self.save(next, previous)
    }

    fn save(&self, snapshot: RunnerSnapshot, expected: u64) -> Result<RunnerSnapshot, String> {
        match self.store.commit(snapshot, Some(expected), None)? {
            CommitResult::Applied(s) => Ok(s), _ => Err("runner revision changed".into()),
        }
    }

    pub fn record_check(&self,room:&str,key:&super::scheduler::RunnerAttemptKey,id:&str,passed:bool,output:&str)->Result<(),String>{
        let Some(mut s)=self.store.load(room)? else{return Ok(());};
        if s.id!=key.runner_id||s.generation!=key.generation||s.in_flight.as_deref()!=Some(key.attempt_id.as_str()){return Ok(());}
        let previous=s.revision;
        s.check_results.push(RunnerCheckResult{id:id.into(),attempt_id:key.attempt_id.clone(),passed,output:output.chars().take(4000).collect()});
        if s.check_results.len()>50{s.check_results.drain(..s.check_results.len()-50);}
        s.revision+=1;self.save(s,previous)?;Ok(())
    }

    pub fn record_usage(&self,room:&str,key:&super::scheduler::RunnerAttemptKey,worker:&str,cost:Option<u64>)->Result<(),String>{
        let Some(mut s)=self.store.load(room)? else{return Ok(());};
        let id=format!("{}:{}",key.attempt_id,worker);
        if s.id!=key.runner_id||s.generation!=key.generation||s.in_flight.as_deref()!=Some(key.attempt_id.as_str())||s.accounted.contains(&id){return Ok(());}
        let previous=s.revision;
        if let Some(cost)=cost{s.usage.cost_micros=Some(s.usage.cost_micros.unwrap_or(0).saturating_add(cost));s.usage.unknown_cost_turns=s.usage.unknown_cost_turns.saturating_sub(1);}
        s.accounted.push(id);s.revision+=1;self.save(s,previous)?;Ok(())
    }

    pub fn reissue_pending(&self,room:&str)->Result<(),String>{
        let Some(mut s)=self.store.load(room)? else{return Ok(());};
        if s.phase!=RunnerPhase::Waiting||s.in_flight.is_some(){return Ok(());}
        let previous=s.revision;
        s.phase=RunnerPhase::Running;s.reason=RunnerReason::None;s.pending_request_id=None;s.revision+=1;
        let cp=s.checkpoint.get_or_insert(RunnerCheckpoint{done:String::new(),next:String::new(),blocker:None,criteria:vec![]});
        cp.next="The previous approval or question was cancelled by Pause. It was NOT approved or answered. Re-present any unresolved need before taking the dependent action.".into();
        self.save(s,previous)?;Ok(())
    }

    pub fn note_change(&self,room:&str,key:&super::scheduler::RunnerAttemptKey,path:&str)->Result<(),String>{
        let Some(mut s)=self.store.load(room)? else{return Ok(());};
        if s.id!=key.runner_id||s.generation!=key.generation||s.in_flight.as_deref()!=Some(key.attempt_id.as_str()){return Ok(());}
        let previous=s.revision;if !s.changed_paths.iter().any(|p|p==path){s.changed_paths.push(path.into());}s.made_change=true;s.revision+=1;self.save(s,previous)?;Ok(())
    }

    pub fn reserve_checker(&self,room:&str,key:&super::scheduler::RunnerAttemptKey,time:u64)->Result<bool,String>{
        let Some(mut s)=self.store.load(room)? else{return Ok(false);};
        if s.id!=key.runner_id||s.generation!=key.generation||s.in_flight.as_deref()!=Some(key.attempt_id.as_str())||s.is_terminal()||time>=s.deadline_at||s.limits.max_cost_micros.zip(s.usage.cost_micros).is_some_and(|(cap,used)|used>=cap)||s.limits.max_invocations.is_some_and(|c|s.usage.invocations>=c){return Ok(false);}
        let previous=s.revision;s.usage.invocations+=1;s.usage.unknown_cost_turns+=1;s.revision+=1;self.save(s,previous)?;Ok(true)
    }

    pub fn remove(&self, room: &str) -> Result<(), String> { self.store.remove(room) }

    pub fn pause_reason(&self, room: &str, reason: RunnerReason, now_ms: u64) -> Result<(), String> {
        if let Some(mut s) = self.store.load(room)? {
            if s.is_terminal() { return Ok(()); }
            let previous = s.revision;
            s.phase = RunnerPhase::Paused; s.reason = reason; s.generation += 1; s.in_flight = None; s.next_run_at = None;
            s.usage.elapsed_ms = now_ms.saturating_sub(s.started_at).max(s.usage.elapsed_ms); s.revision += 1;
            self.save(s, previous)?;
        }
        Ok(())
    }

    /// Yield without a manual pause. Busy room reservations keep automation out
    /// until the human's accepted chain finishes.
    pub fn yield_to_human(&self, room: &str) -> Result<bool, String> {
        if !self.is_available() { return Ok(false); }
        let Some(mut s) = self.store.load(room)? else { return Ok(false); };
        if !matches!(s.phase, RunnerPhase::Running | RunnerPhase::Scheduled | RunnerPhase::Waiting) { return Ok(false); }
        let previous = s.revision;
        let interrupted = s.in_flight.take().is_some();
        s.generation += 1; s.revision += 1;
        if interrupted { s.worker_index = 0; s.phase = RunnerPhase::Running; s.pending_request_id = None; s.reason = RunnerReason::None; }
        self.save(s, previous)?;
        Ok(interrupted)
    }

    pub fn waiting(&self, room: &str, key:&super::scheduler::RunnerAttemptKey, request: Option<(String, RunnerReason)>) -> Result<(), String> {
        let Some(mut s) = self.store.load(room)? else { return Ok(()); };
        if s.is_terminal() || s.id!=key.runner_id || s.generation!=key.generation || s.in_flight.as_deref()!=Some(key.attempt_id.as_str()) { return Ok(()); }
        let previous = s.revision;
        if let Some((id, reason)) = request {
            s.pending_request_id = Some(id);
            if s.phase != RunnerPhase::Paused { s.phase = RunnerPhase::Waiting; s.reason = reason; }
        } else {
            s.pending_request_id = None;
            if s.phase == RunnerPhase::Waiting { s.phase = RunnerPhase::Running; s.reason = RunnerReason::None; }
        }
        s.revision += 1;
        self.save(s, previous)?;
        Ok(())
    }

    pub fn finish_attempt(&self, room: &str, key: &crate::runner::scheduler::RunnerAttemptKey, reply: &str, seq: Option<usize>, cost: Option<u64>, now: u64) -> Result<bool, String> {
        let Some(mut s) = self.store.load(room)? else { return Ok(false); };
        if s.is_terminal() || s.id != key.runner_id || s.generation != key.generation || s.in_flight.as_deref() != Some(key.attempt_id.as_str()) { return Ok(false); }
        let previous = s.revision;
        s.in_flight = None; s.pending_request_id = None; s.usage.elapsed_ms = now.saturating_sub(s.started_at).max(s.usage.elapsed_ms);
        let accounting_key=format!("{}:{}",key.attempt_id,s.workers[s.worker_index%s.workers.len()]);
        if !s.accounted.contains(&accounting_key) {
            if let Some(c) = cost { s.usage.cost_micros = Some(s.usage.cost_micros.unwrap_or(0).saturating_add(c));s.usage.unknown_cost_turns=s.usage.unknown_cost_turns.saturating_sub(1); }
            s.accounted.push(accounting_key);
        }
        if let Some(seq) = seq { s.reply_seqs.push(seq); }
        match super::report::parse_report(reply) {
            Err(_) => {
                s.phase=RunnerPhase::Paused;
                let lower=reply.to_lowercase();
                s.reason=if lower.contains("usage limit")||lower.contains("rate limit")||lower.contains("quota")||lower.contains("out of usage") {RunnerReason::ProviderUsage}else{RunnerReason::ProviderError};
                s.checkpoint.get_or_insert(RunnerCheckpoint{done:String::new(),next:String::new(),blocker:None,criteria:vec![]}).blocker=Some(format!("Provider error or invalid runner report: {}",reply).chars().take(2000).collect());
            }
            Ok(report) => {
                let cp = RunnerCheckpoint { done: report.done, next: report.next, blocker: report.blocker, criteria: report.criteria.into_iter().map(|c| RunnerCriteria { id: c.id, status: c.status, evidence: c.evidence }).collect() };
                let same = s.checkpoint.as_ref() == Some(&cp) && !s.made_change;
                s.consecutive_unchanged = if same { s.consecutive_unchanged + 1 } else { 0 };
                let satisfied = !cp.criteria.is_empty() && cp.criteria.iter().all(|c| c.status == "done" && !c.evidence.is_empty());
                s.checkpoint = Some(cp);
                if report.disposition == "blocked" { s.phase = RunnerPhase::Paused; s.reason = RunnerReason::Blocked; }
                else if report.disposition == "done" && !satisfied { s.phase = RunnerPhase::Paused; s.reason = RunnerReason::Blocked; }
                else if s.kind == RunnerKind::Goal && report.disposition == "done" {
                    // Checks and read-only checker run before this method receives
                    // an accepted candidate from the host.
                    s.phase = RunnerPhase::Completed; s.reason = RunnerReason::Completed; s.generation += 1;
                } else if s.kind == RunnerKind::Goal && s.consecutive_unchanged >= 2 { s.phase = RunnerPhase::Paused; s.reason = RunnerReason::Stuck; }
                else {
                    s.worker_index = (s.worker_index + 1) % s.workers.len();
                    if s.kind == RunnerKind::Loop && s.worker_index == 0 {
                        s.phase = RunnerPhase::Scheduled; s.next_run_at = Some(now.saturating_add(s.interval_seconds.unwrap_or(600)*1000));
                    } else { s.phase = RunnerPhase::Running; }
                }
            }
        }
        s.revision += 1; self.save(s, previous)?;
        Ok(true)
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
        next.in_flight = None;
        next.next_run_at = None;
        next.usage.elapsed_ms = now_ms.saturating_sub(next.started_at);
        let _ = self.store.commit(next, Some(existing.revision), None)?;
        Ok(())
    }
}

pub fn limit_reached(s: &RunnerSnapshot, now: u64) -> bool {
    now >= s.deadline_at || s.usage.elapsed_ms >= s.limits.lifetime_ms
        || s.limits.max_invocations.is_some_and(|cap| s.usage.invocations >= cap)
        || (s.kind == RunnerKind::Goal || s.worker_index == 0) && s.limits.max_turns.is_some_and(|cap| s.usage.turns >= cap)
        || s.limits.max_cost_micros.zip(s.usage.cost_micros).is_some_and(|(cap, used)| used >= cap)
}

#[cfg(test)]
mod regression_tests {
    use super::*;
    #[test]
    fn invalidating_a_reserved_attempt_releases_it_and_rejects_its_reply() {
        let root=std::env::temp_dir().join(format!("runner-invalidate-{}",std::process::id()));
        let _=std::fs::remove_dir_all(&root);std::fs::create_dir_all(&root).unwrap();
        let service=RunnerService::new(root.clone());
        service.start(RunnerStartInput{id:"r".into(),request_id:"start".into(),expected_room_revision:None,runner:RunnerStartPayload{schema_version:1,kind:RunnerKind::Goal,objective:Some("result".into()),prompt:None,interval_seconds:None,workers:vec!["w".into()],checker:None,limits:RunnerLimits::default_limits(),checks:vec![]}},1000).unwrap();
        let dispatch=service.reconcile("r",super::super::scheduler::RunnerWake::Timer,1000).unwrap().unwrap();
        service.reserve_dispatch(&dispatch,1000).unwrap();service.invalidate("r",1100).unwrap();
        let s=service.state("r").unwrap().unwrap();assert!(s.in_flight.is_none(),"configuration pause must release retired reservation");
        assert!(!service.finish_attempt("r",&dispatch.key,"old reply",None,None,1200).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
}
