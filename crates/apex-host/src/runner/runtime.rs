//! Host-owned continuation. Clients never drive timers or provider dispatch.
use super::*;
use crate::runner::{model::*, service::*, scheduler::{RunnerWake}};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }

impl Host {
    pub(crate) async fn runner_note(&self,room:&str,handle:&RoomHandle,note:&str)->Result<(),String>{
        if handle.room.lock().await.transcript().iter().any(|m|m.text==note){return Ok(());}
        let error=Mutex::new(None);
        handle.room.lock().await.append_assistant_note(note.to_string(),&self.turn_sink(room,handle,&error));
        checkpoint_room(handle,&self.store,room).await?;
        if let Some(error)=error.into_inner().unwrap(){return Err(error);}Ok(())
    }

    pub(crate) fn invalidate_room_runner(&self,room:&str)->Result<(),String>{
        let service=self.runner_service.lock().unwrap();
        let current=service.state(room)?;
        let running=current.as_ref().is_some_and(|s|!s.is_terminal()&&s.in_flight.is_some());
        service.invalidate(room,now())?;
        if running {if let Ok(handle)=self.handle(room){handle.runtime.stop(None);handle.approvals.reject_all();}}
        drop(service);self.runner_changed(room);Ok(())
    }

    pub(crate) fn runner_gate(&self, room: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.runner_gates.lock().unwrap().entry(room.into()).or_default().clone()
    }

    pub(crate) fn runner_changed(&self, room: &str) {
        if let Ok(snapshot) = self.runner_service.lock().unwrap().state(room) {
            self.events.emit(crate::events::HostEvent::RoomRunnerChanged { room: room.into(), snapshot });
        }
    }

    pub(crate) fn ensure_runner(self: &Arc<Self>, room: String) {
        if !self.runner_workers.lock().unwrap().insert(room.clone()) { return; }
        let weak = Arc::downgrade(self);
        self.runtime.spawn(async move {
            let anchor = (now(), Instant::now());
            tokio::time::sleep(Duration::from_millis(100)).await;
            loop {
                let Some(host) = weak.upgrade() else { break; };
                // Monotonic elapsed time prevents a backwards clock from extending
                // this process's original deadline. Forward wall jumps expire it.
                let time = now().max(anchor.0.saturating_add(anchor.1.elapsed().as_millis() as u64));
                match host.runner_tick(&room, time).await {
                    Ok(true) => {},
                    Ok(false) => {
                        host.runner_workers.lock().unwrap().remove(&room);
                        let replacement=host.runner_service.lock().unwrap().state(&room).ok().flatten().is_some_and(|s|!s.is_terminal());
                        if replacement { host.ensure_runner(room.clone()); }
                        break;
                    },
                    Err(error) => {
                        let _ = host.runner_service.lock().unwrap().pause_reason(&room, RunnerReason::Storage, time);
                        host.room_event(&room, RoomEvent::Failed { id: ParticipantId::new("runner"), error });
                        host.runner_changed(&room);
                    }
                }
                drop(host);
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        });
    }

    async fn runner_tick(&self, room: &str, time: u64) -> Result<bool, String> {
        let gate = self.runner_gate(room);
        let guard = gate.lock().await;
        let Some(mut snapshot) = self.runner_service.lock().unwrap().state(room)? else { return Ok(false); };
        if snapshot.is_terminal() { return Ok(false); }
        if limit_reached(&snapshot, time) {
            if snapshot.reason != RunnerReason::Limit {
                self.runner_service.lock().unwrap().pause_reason(room, RunnerReason::Limit, time)?;
                if let Ok(handle) = self.handle(room) { handle.runtime.stop(None); handle.approvals.reject_all(); }
                self.runner_changed(room);
            }
            return Ok(true);
        }
        if snapshot.phase==RunnerPhase::Waiting&&snapshot.in_flight.is_none() {
            let handle=self.handle(room)?;
            if !handle.has_pending_human_waits() {
                self.runner_service.lock().unwrap().reissue_pending(room)?;
                snapshot=self.runner_service.lock().unwrap().state(room)?.ok_or("runner removed")?;
            }
        }
        if !matches!(snapshot.phase, RunnerPhase::Running | RunnerPhase::Scheduled) || snapshot.in_flight.is_some() { return Ok(true); }
        let handle = self.handle(room)?;
        if handle.deleted.load(Ordering::SeqCst) { return Ok(false); }
        if handle.busy() || handle.has_pending_human_waits() { return Ok(true); }
        let configs = handle.room.lock().await.configs();
        if snapshot.workers.iter().chain(snapshot.checker.iter()).any(|id| !configs.iter().any(|p| p.id.as_str() == id)) {
            self.runner_service.lock().unwrap().pause_reason(room, RunnerReason::Configuration, time)?;
            self.runner_changed(room); return Ok(true);
        }
        let dispatch = self.runner_service.lock().unwrap().reconcile(room, if snapshot.phase == RunnerPhase::Running { RunnerWake::Manual { room_id: room.into() } } else { RunnerWake::Timer }, time)?;
        let Some(mut dispatch) = dispatch else { return Ok(true); };
        dispatch.key.attempt_id = format!("{}-{}-{}", snapshot.id, snapshot.generation, snapshot.revision);
        let reserved = self.runner_service.lock().unwrap().reserve_dispatch(&dispatch, time)?;
        let worker = &reserved.workers[reserved.worker_index % reserved.workers.len()];
        let context = runner_context(&reserved);
        let batch = handle.runtime.begin_turn(vec![ParticipantId::new(worker)], Some(0)).await?.with_runner_context(context, false);
        let current=self.runner_service.lock().unwrap().state(room)?;
        if !current.is_some_and(|s|s.id==dispatch.key.runner_id&&s.generation==dispatch.key.generation&&s.in_flight.as_deref()==Some(dispatch.key.attempt_id.as_str())) { drop(batch);return Ok(true); }
        handle.observation_revision.fetch_add(1, Ordering::SeqCst);
        let before = handle.room.lock().await.transcript().len();
        self.runner_changed(room);
        // Reservation and batch acceptance are atomic against human send. Release
        // the gate before any provider work, approvals or cancellation waits.
        drop(guard);
        let events = Mutex::new((None, None));
        let error = Mutex::new(None);
        let sink = self.turn_sink(room, &handle, &error);
        let key = dispatch.key.clone();
        let observed = |event: RoomEvent| {
            match &event {
                RoomEvent::Changed { change,.. } => { if let Err(why)=self.runner_service.lock().unwrap().note_change(room,&key,&change.path){*error.lock().unwrap()=Some(why);handle.runtime.stop(None);} },
                RoomEvent::Usage { id,cost_micros, .. } => {
                    events.lock().unwrap().0 = *cost_micros;
                    if let Err(why)=self.runner_service.lock().unwrap().record_usage(room,&key,id.as_str(),*cost_micros){*error.lock().unwrap()=Some(why);handle.runtime.stop(None);}
                },
                RoomEvent::Failed { error, .. } => events.lock().unwrap().1 = Some(error.clone()),
                RoomEvent::ApprovalRequested { request, .. } => { if let Err(why)=self.runner_service.lock().unwrap().waiting(room,&key,Some((request.clone(),RunnerReason::Approval))){*error.lock().unwrap()=Some(why);handle.runtime.stop(None);} self.runner_changed(room); },
                RoomEvent::QuestionRequested { request, .. } => { if let Err(why)=self.runner_service.lock().unwrap().waiting(room,&key,Some((request.clone(),RunnerReason::Question))){*error.lock().unwrap()=Some(why);handle.runtime.stop(None);} self.runner_changed(room); },
                RoomEvent::ApprovalResolved { .. } | RoomEvent::QuestionResolved { .. } => { if let Err(why)=self.runner_service.lock().unwrap().waiting(room,&key,None){*error.lock().unwrap()=Some(why);handle.runtime.stop(None);} self.runner_changed(room); },
                _ => {},
            }
            sink(event);
        };
        let run = handle.runtime.run(batch, &observed);
        tokio::pin!(run);
        tokio::select! {
            _ = &mut run => {},
            cancelled_at = self.runner_cancelled(room,&key) => {
                // Invalidators already canceled their own work before accepting
                // a human/replacement batch. Never stop that newer batch here.
                self.expire_runner_attempt(room,&handle,&key,worker,cancelled_at)?;
                run.await;
            }
        }
        checkpoint_room(&handle, &self.store, room).await?;
        if let Some(error) = error.lock().unwrap().clone() { return Err(error); }
        let reply = { let current = handle.room.lock().await;
            current.transcript().iter().skip(before).rev().find(|m| matches!(&m.speaker, apex_core::Speaker::Bot(id) if id.as_str() == worker)).map(|m| (m.seq, m.text.clone()))
        };
        let cost = events.lock().unwrap().0;
        let provider_error=events.lock().unwrap().1.clone();
        let (seq, mut text) = reply.map(|(seq, text)| (Some(seq), text)).unwrap_or((None, String::new()));
        if let Some(error)=provider_error {text=error;}
        if (reserved.kind==RunnerKind::Goal||reserved.worker_index+1==reserved.workers.len()) && crate::runner::report::parse_report(&text).is_ok_and(|r|r.disposition=="done") {
            text = self.verify_runner_candidate(room,&handle,&reserved,&key,text,&observed).await?;
        }
        let accepted = self.runner_service.lock().unwrap().finish_attempt(room, &key, &text, seq, cost, now())?;
        if accepted {
            let current=self.runner_service.lock().unwrap().state(room)?;
            if let Some(s)=current.filter(|s|s.is_terminal()) {
                let summary=format!("{} finished · {} {} · {} calls · {}.\n{}\n{}",if s.kind==RunnerKind::Goal{"Goal"}else{"Loop"},s.usage.turns,if s.kind==RunnerKind::Goal{"turns"}else{"runs"},s.usage.invocations,if s.usage.unknown_cost_turns>0{"Cost unavailable".into()}else{s.usage.cost_micros.map(|c|format!("${:.2}",c as f64/1e6)).unwrap_or("Cost unavailable".into())},s.checkpoint.as_ref().map(|c|c.done.as_str()).unwrap_or(""),format!("Completion is reported evidence unless configured checks or a checker confirmed it. Review runner changes for attributable files. [Runner {} completed]",s.id));
                self.runner_note(room,&handle,&summary).await?;
            }
            self.runner_changed(room);
        }
        self.room_event(room, RoomEvent::Idle);
        Ok(true)
    }
    async fn verify_runner_candidate(&self, room:&str, handle:&RoomHandle, snapshot:&RunnerSnapshot, key:&crate::runner::scheduler::RunnerAttemptKey, text:String, sink:&(dyn Fn(RoomEvent)+Send+Sync)) -> Result<String,String> {
        use crate::runner::{checks::{prepare_check,VerificationResult},report::parse_report};
        let mut report=parse_report(&text).map_err(|_|"Invalid candidate report")?;
        let worker=ParticipantId::new(&snapshot.workers[snapshot.worker_index%snapshot.workers.len()]);
        let access=handle.room.lock().await.configs().into_iter().find(|p|p.id==worker).ok_or("Worker removed")?.access;
        if !self.runner_current(room,key) {return Ok(text);}
        for check in &snapshot.checks {
            let action=apex_core::ProposedAction {kind:apex_core::ActionKind::Command,title:format!("Run goal check: {}",check.id),detail:serde_json::to_string(&check.argv).map_err(|e|e.to_string())?,expires_at:None,risky:false};
            let allowed=match access {
                apex_core::Access::Full=>true,
                apex_core::Access::Read=>false,
                _=>{
                    tokio::select! {
                        decision=apex_core::decide_room_action(&handle.approvals,&worker,sink,action)=>decision.approved(),
                        _=self.runner_cancelled(room,key)=>false,
                    }
                }
            };
            let result=if !allowed { "Check requires command permission".into() } else {
                let cwd=handle.context.cwd.as_deref().ok_or("Checks require a room folder")?;
                let gate=self.runner_gate(room);let guard=gate.lock().await;
                let prepared={
                    // Synchronous launch and Stop's state invalidation share this
                    // lock; after Stop is accepted no stale command can spawn.
                    let service=self.runner_service.lock().unwrap();
                    if !service.state(room)?.is_some_and(|s|s.id==key.runner_id&&s.generation==key.generation&&s.in_flight.as_deref()==Some(key.attempt_id.as_str())&&!s.is_terminal()&&now()<s.deadline_at) {return Ok(text);}
                    prepare_check(check,cwd,&self.paths.data.join("runner-processes"))?
                };
                drop(guard);
                match prepared.finish(async {self.runner_cancelled(room,key).await;}).await? {
                    VerificationResult::Passed{output}=>{self.runner_service.lock().unwrap().record_check(room,key,&check.id,true,&format!("Exit 0. {}",output))?;continue;},
                    VerificationResult::Failed{exit,output}=>format!("Check {} failed (exit {}): {}",check.id,exit,output),
                    _=>format!("Check {} timed out or was cancelled",check.id),
                }
            };
            self.runner_service.lock().unwrap().record_check(room,key,&check.id,false,&result)?;
            report.disposition="blocked".into();report.blocker=Some(result.chars().take(2000).collect());break;
        }
        if report.disposition=="done" {
            if let Some(checker)=&snapshot.checker {
                let eligible=self.runner_service.lock().unwrap().reserve_checker(room,key,now())?;
                if !eligible {report.disposition="blocked".into();report.blocker=Some("Checker invocation limit reached".into());}
                else {
                    let gate=self.runner_gate(room);let guard=gate.lock().await;
                    if !self.runner_current(room,key) {return Ok(text);}
                    let batch=handle.runtime.begin_turn(vec![ParticipantId::new(checker)],Some(0)).await?.with_runner_context(format!("{}\nYou are the read-only checker. Evaluate the previous worker's claim against the objective and criteria. Return done only with evidence that all criteria are met; otherwise blocked. You cannot change files or run write actions.",runner_context(snapshot)),true);
                    if !self.runner_current(room,key) {drop(batch);return Ok(text);}
                    drop(guard);
                    let before=handle.room.lock().await.transcript().len();
                    let run=handle.runtime.run(batch,sink);tokio::pin!(run);
                    tokio::select!{_= &mut run=>{},cancelled_at=self.runner_cancelled(room,key)=>{self.expire_runner_attempt(room,handle,key,checker,cancelled_at)?;run.await;}}
                    let reply={let r=handle.room.lock().await;r.transcript().iter().skip(before).rev().find(|m|matches!(&m.speaker,apex_core::Speaker::Bot(id) if id.as_str()==checker)).map(|m|m.text.clone()).unwrap_or_default()};
                    if !parse_report(&reply).is_ok_and(|r|r.disposition=="done"&&!r.criteria.is_empty()&&r.criteria.iter().all(|c|c.status=="done"&&!c.evidence.is_empty())) {
                        report.disposition="blocked".into();report.blocker=Some("The checker did not confirm completion. Review its reply.".into());
                    }
                }
            }
        }
        Ok(format!("{}\n```apex-runner\n{}\n```",text.split("```apex-runner").next().unwrap_or(""),serde_json::to_string(&report).map_err(|e|e.to_string())?))
    }

    fn expire_runner_attempt(&self,room:&str,handle:&RoomHandle,key:&crate::runner::scheduler::RunnerAttemptKey,worker:&str,time:u64)->Result<(),String>{
        let service=self.runner_service.lock().unwrap();
        let current=service.state(room)?;
        if current.is_some_and(|s|s.id==key.runner_id&&s.generation==key.generation&&s.in_flight.as_deref()==Some(key.attempt_id.as_str())&&!s.is_terminal()&&time>=s.deadline_at) {
            service.pause_reason(room,RunnerReason::Limit,time)?;
            handle.runtime.stop(Some(&ParticipantId::new(worker)));
            handle.approvals.reject_for(&ParticipantId::new(worker));
        }
        Ok(())
    }

    fn runner_current(&self,room:&str,key:&crate::runner::scheduler::RunnerAttemptKey)->bool{
        self.runner_service.lock().unwrap().state(room).ok().flatten().is_some_and(|s|s.id==key.runner_id&&s.generation==key.generation&&s.in_flight.as_deref()==Some(key.attempt_id.as_str())&&!s.is_terminal()&&now()<s.deadline_at)
    }

    async fn runner_cancelled(&self,room:&str,key:&crate::runner::scheduler::RunnerAttemptKey)->u64{
        let anchor=(now(),Instant::now());
        loop {
            let time=now().max(anchor.0.saturating_add(anchor.1.elapsed().as_millis() as u64));
            let valid=self.runner_service.lock().unwrap().state(room).ok().flatten().is_some_and(|s|s.id==key.runner_id&&s.generation==key.generation&&s.in_flight.as_deref()==Some(key.attempt_id.as_str())&&!s.is_terminal()&&time<s.deadline_at);
            if !valid{return time;}
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    }

}

fn runner_context(s: &RunnerSnapshot) -> String {
    format!("You are working on a bounded {} owned by Deck. Objective: {}\nLatest checkpoint: {}\nWork on the next concrete step. Do not start another autonomous runner or prompt other bots. Respect the room's permissions and the human's instructions. End your final reply with exactly one top-level fenced apex-runner JSON report, version 1. Required fields: version (1), disposition (working|done|blocked), done (string), next (string), blocker (string or null), criteria (array of {{id, status (pending|done|failed), evidence (string array)}}). Use real evidence; completion without independent checks is reported completion only. Example:\n```apex-runner\n{{\"version\":1,\"disposition\":\"working\",\"done\":\"one concrete result\",\"next\":\"next step\",\"blocker\":null,\"criteria\":[{{\"id\":\"objective\",\"status\":\"pending\",\"evidence\":[]}}]}}\n```", if s.kind == RunnerKind::Goal { "goal" } else { "loop run" }, s.objective.as_deref().or(s.prompt.as_deref()).unwrap_or(""), serde_json::to_string(&s.checkpoint).unwrap_or_default())
}
