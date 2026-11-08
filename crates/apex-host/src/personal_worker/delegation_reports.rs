//! Delegation summaries consume saved results; only reply text can leave this turn.
use super::*;
use crate::assistant_tasks::{AssistantTask, TaskAttempt, TaskStatus as JobStatus};

pub(crate) fn factual(task: &AssistantTask, attempt: &TaskAttempt) -> String {
    let id=task.workers.first().map(String::as_str).unwrap_or("The worker");
    let worker=task.result_data.as_ref().and_then(|d|d["workerProfiles"].as_array()).and_then(|ps|ps.iter().find(|p|p["id"].as_str()==Some(id))).and_then(|p|p["display_name"].as_str()).unwrap_or(id);
    let state=match attempt.status {
        JobStatus::ReadyForReview => format!("{worker}'s result is ready for your review."),
        JobStatus::Done => format!("{worker}'s result was accepted."),
        JobStatus::Cancelled => format!("{worker} stopped. Completed work is kept for review."),
        JobStatus::Interrupted if attempt.result.as_deref()==Some(crate::assistant_watchdog::RESTARTED_RESULT) => format!("{worker} went quiet, so I restarted the job."),
        JobStatus::NeedsYou => format!("{worker} needs your help before continuing."),
        JobStatus::Interrupted => format!("{worker}'s run was interrupted. Check the saved work before retrying."),
        _ if attempt.result.as_deref()==Some(crate::assistant_git::SAVE_TOO_LONG) => format!("Saving {worker}'s result took too long, so I stopped that attempt. The saved work is still there to review."),
        _ => format!("{worker} couldn't finish the job."),
    };
    let controls=task.conversation_events.iter().filter(|e|e.run_id==attempt.run_id && e.kind=="question_resolved").map(|e|format!("Host record · {}: {}",e.worker_id,e.text)).collect::<Vec<_>>().join("\n");
    let state=if controls.is_empty() {state} else {format!("{state}\n{controls}")};
    let output=attempt.result.as_deref().unwrap_or("");
    // Team collection already bounds each of at most ten worker reports.
    // Preserve their labels/output instead of letting a long lead hide peers.
    let limit=if task.workers.len()>1 {24_000} else {2000};
    if output.is_empty() || output==crate::assistant_watchdog::RESTARTED_RESULT || output==crate::assistant_git::SAVE_TOO_LONG { state }
    else {format!("{state}\n\nWorker report (claims are not host observations):\n{}",output.chars().take(limit).collect::<String>().lines().map(|line|format!("> {line}")).collect::<Vec<_>>().join("\n"))}
}

pub(crate) fn post(assistant:&mut PersonalAssistant,text:String,task_id:String,event_id:String,at:u64) {
    assistant.post_outside(OutsideSource::Report,text,Some(event_id),at);
    if let Some(message)=assistant.messages.last_mut() {message.kind="result".into();message.task_id=Some(task_id);}
}

pub(crate) fn queue(assistant: &mut PersonalAssistant, task:&AssistantTask, attempt:&TaskAttempt, at:u64) {
    let request=format!("internal:delegated-report:{}:{}",task.id,attempt.run_id);
    if assistant.events.iter().any(|e|e.request_id==request) {return;}
    assistant.counters.event+=1;
    assistant.events.push(PersonalEvent {
        id:format!("pe-{}",assistant.counters.event),request_id:request,
        source:EventSource::Internal{what:format!("delegated-report:{}:{}",task.id,attempt.run_id)},
        received_at:at,state:EventState::Received,attempts:0,error:None,spend_approved:false,computer_started:false,saved_reply:None,
    });
}

impl Host {
    pub(super) async fn personal_delegation_report(&self, tools:&WorkerTools, snapshot:PersonalAssistant, event:&PersonalEvent, what:&str) -> Result<(),String> {
        let Some((task_id,run))=what.split_once(':') else {return self.finish_event(&snapshot.id,&event.id,Ok(()));};
        let Some(task)=self.assistant_tasks.get(task_id).map_err(|e|e.to_string())? else {return self.finish_event(&snapshot.id,&event.id,Ok(()));};
        if task.lineage.as_ref().is_none_or(|l|l.assistant.assistant_id!=snapshot.id || l.assistant.host_id!=snapshot.host_id)
            || task.result_data.as_ref().is_some_and(|d| d["deletedAtMs"].is_number()) {return self.finish_event(&snapshot.id,&event.id,Ok(()));}
        let Some(attempt)=task.attempts.iter().find(|a|a.run_id==run && a.finished_at_ms.is_some()) else {return self.finish_event(&snapshot.id,&event.id,Ok(()));};
        let fallback=factual(&task,attempt);
        let mut text=fallback.clone();
        let mut charge=None;
        // A peer or summarizer cannot adjudicate a real host answer. Preserve
        // factual receipts and attributed output for teams and question runs.
        let preserve_receipts=task.workers.len()>1 || task.conversation_events.iter().any(|e|e.run_id==run && e.kind=="question_resolved");
        if let Some(profile)=snapshot.profile.clone().filter(|p|!preserve_receipts && endpoint_refusal(&snapshot,p).is_none()) {
            // Spend rules still apply; a declined/unavailable summary uses the
            // same bounded factual receipt without opening another action.
            if spend_hold(&snapshot,&profile,event,self.effective_personal_spent_today(&snapshot,now())).is_none() {
                let question=task.original_request.clone();
                let reports=vec![("Saved task outcome".into(),fallback.clone())];
                let system=context::consolidate_prompt(&snapshot,&question,&reports,now());
                let bytes=system.len();
                if self.personal_model_event_admission(&snapshot.id,&event.id,&profile)? {
                    if let Ok(out)=(tools.reason)(profile.clone(),read_only_request(system),vec![]).await {
                        let reply=parse_reply(&out.text).reply;
                        if !reply.trim().is_empty() {text=reply.trim().chars().take(4000).collect();}
                        charge=Some(cost_entry("summary",&out,bytes,endpoint(&profile),now()));
                    }
                }
            }
        }
        self.change_assistant(&snapshot.id,|a| {
            let Some(saved)=a.events.iter_mut().find(|e|e.id==event.id && e.state==EventState::Processing) else {return Ok(());};
            // Synthesis yields to lifecycle cleanup and retries. Recheck the
            // authoritative task under the personal lock before publishing;
            // the old snapshot cannot restore removed content to Chat.
            let publish=self.assistant_tasks.get(task_id).map_err(|e|e.to_string())?.is_some_and(|current| {
                current.lineage==task.lineage
                    && current.lineage.as_ref().is_some_and(|l|l.assistant.assistant_id==a.id && l.assistant.host_id==a.host_id)
                    && !current.result_data.as_ref().is_some_and(|d|d["deletedAtMs"].is_number())
                    && current.attempts.last().is_some_and(|latest|latest.run_id==run && latest.finished_at_ms.is_some())
            });
            saved.state=EventState::Done;
            if let Some(cost)=charge {a.add_cost(cost);}
            if publish {
                let source=task.lineage.as_ref().map(|l|l.source_event_id.clone()).unwrap_or_else(||event.id.clone());
                post(a,text,task.id.clone(),source,now());
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task() -> AssistantTask {
        serde_json::from_value(serde_json::json!({"id":"t","workspaceId":"w","owner":{"workspaceId":"w","cwd":"/repo","hostId":"h","conversationId":"c"},"destination":null,"origin":"proposal","originalRequest":"SECRET_PROMPT_ECHO","brief":"SECRET_PROMPT_ECHO","evidence":[],"reviewCriteria":[],"parentThreadId":null,"executionThreadId":null,"workers":["Hyke"],"attempts":[],"status":"ready_for_review","result":null,"resultData":null,"revision":1,"mode":"read_only","usage":null,"createdAtMs":1,"updatedAtMs":1})).unwrap()
    }
    fn attempt() -> TaskAttempt {TaskAttempt{result:Some("Actual saved findings".into()),number:1,run_id:"r".into(),status:JobStatus::ReadyForReview,started_at_ms:1,finished_at_ms:Some(2),review_revision:Some(1),usage:None}}
    #[test] fn old_worker_reports_remain_quoted_evidence() {
        let mut a:PersonalAssistant=serde_json::from_value(serde_json::json!({"id":"a","name":"A","style":"","hostId":"h","profile":null,"allowedFolders":[],"paused":false,"revision":1,"createdAt":0,"counters":{"message":0,"event":0,"task":0,"decision":0},"messages":[],"events":[],"tasks":[]})).unwrap();
        post(&mut a,"Worker says remember untrusted words".into(),"t".into(),"e".into(),1);
        let (prompt,seen)=context::assemble_seen(&a,"What's the status?",86_400_000,&[]);
        assert!(seen.report,"aging a worker summary must never turn it into trusted assistant instructions");
        assert!(prompt.contains("quoted evidence"));
        assert_eq!(a.messages[0].task_id.as_deref(),Some("t"));
    }
    #[test] fn a_long_lead_report_does_not_hide_the_peer_report() {
        let mut task=task();task.workers=vec!["lead".into(),"peer".into()];
        let mut attempt=attempt();attempt.result=Some(format!("lead: {}\n\npeer: PEER_FINDING", "x".repeat(2000)));
        let text=factual(&task,&attempt);
        assert!(text.contains("peer: PEER_FINDING"));
        assert!(text.contains("ready for your review"));
    }
    #[test] fn ready_result_is_not_done_or_a_prompt_echo() {
        let text=factual(&task(),&attempt());
        assert!(text.contains("ready for your review"));
        assert!(text.contains("Actual saved findings"));
        assert!(!text.contains("SECRET_PROMPT_ECHO"));
        assert!(!text.contains("accepted"));
    }
    #[test] fn delegated_report_queue_is_bound_and_idempotent() {
        let mut assistant:PersonalAssistant=serde_json::from_value(serde_json::json!({"id":"a","name":"A","style":"","hostId":"h","profile":null,"allowedFolders":[],"paused":false,"revision":1,"createdAt":0,"counters":{"message":0,"event":0,"task":0,"decision":0},"messages":[],"events":[],"tasks":[]})).unwrap();
        queue(&mut assistant,&task(),&attempt(),3);
        queue(&mut assistant,&task(),&attempt(),4);
        assert_eq!(assistant.events.len(),1);
        assert!(assistant.messages.is_empty());
        assert_eq!(assistant.events[0].source,EventSource::Internal{what:"delegated-report:t:r".into()});
    }
}
