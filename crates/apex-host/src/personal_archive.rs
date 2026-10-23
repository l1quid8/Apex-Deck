//! Reversible assistant removal keeps the durable record and all authority.
use crate::{Host, personal_settings::Changed};

impl Host {
    pub(crate) fn personal_archive(&self, id: &str, expected_revision: u64, archived: bool) -> Result<Changed, String> {
        let host_id=self.local_host_id()?;
        // The document lock also guards personal claims and delegated attempt
        // starts. Checks and the saved archive transition cannot be interleaved
        // with a new authoritative execution claim.
        self.change_assistant(id,|assistant| {
            if assistant.host_id!=host_id {return Err("This assistant belongs to another machine.".into());}
            if assistant.revision!=expected_revision {return Err("The assistant changed. Refresh before removing or restoring it.".into());}
            if archived {
                if assistant.archived_at.is_some(){return Ok(());}
                if assistant.tasks.iter().any(|task|!task.status.settled()||task.receipts.iter().any(|receipt|receipt.finished_at.is_none())) {return Err("Cancel unfinished tasks first and wait for their final operation receipts.".into());}
                if assistant.events.iter().any(|event|matches!(event.state,crate::personal::EventState::Received|crate::personal::EventState::Processing|crate::personal::EventState::Held)){return Err("Stop the pending reply or finish its request before removing this assistant.".into());}
                if assistant.schedules.iter().any(|schedule|schedule.status!=crate::personal::ScheduleStatus::Cancelled){return Err("Cancel active and proposed schedules before removing this assistant.".into());}
                let tasks=self.assistant_tasks.list(None).map_err(|error|error.to_string())?;
                for task in tasks.iter().filter(|task|task.lineage.as_ref().is_some_and(|lineage|lineage.assistant.host_id==assistant.host_id&&lineage.assistant.assistant_id==assistant.id)) {
                    let settled=matches!(task.status,crate::assistant_tasks::TaskStatus::Done|crate::assistant_tasks::TaskStatus::Cancelled|crate::assistant_tasks::TaskStatus::Failed|crate::assistant_tasks::TaskStatus::Interrupted);
                    if !settled||crate::assistant_service::has_pending_integration(task)||task.result_data.as_ref().is_some_and(|data|data["leaseHeld"]==true) {return Err("Cancel unfinished project tasks and reconcile pending project integration before removing this assistant.".into());}
                    if self.assistant_runs.lock().unwrap().get(&task.id).is_some_and(|run|!run.finished.load(std::sync::atomic::Ordering::Acquire)){return Err("Wait for the cancelled project task to stop before removing this assistant.".into());}
                }
                assistant.archived_at=Some(crate::personal::now());
            } else {
                if assistant.archived_at.is_none(){return Err("This assistant is not archived. Refresh its saved state.".into());}
                assistant.archived_at=None;
            }
            // Restore never resumes execution. The human can inspect the saved
            // tasks and use the existing explicit Resume control afterward.
            assistant.paused=true;
            Ok(())
        })?;
        Ok(Changed{assistant:self.personal_get(id)?})
    }
}

#[cfg(test)]
mod tests {
    use crate::{Host, HostPaths};
    use serde_json::json;
    use std::sync::Arc;
    static FIXTURE:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
    fn fixture() -> (std::path::PathBuf, Arc<Host>, String) {
        let root=std::env::temp_dir().join(format!("assistant-archive-{}-{}-{}",std::process::id(),FIXTURE.fetch_add(1,std::sync::atomic::Ordering::SeqCst),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let host=Host::new(HostPaths{data:root.join("data"),downloads:None},tokio::runtime::Handle::current());
        std::fs::write(root.join("data/host-id"),"owner").unwrap();
        let assistant=host.personal_create(serde_json::from_value(json!({"name":"Kept assistant","style":"Precise","folder":root.join("project"),"profile":{"id":"profile","display_name":"Model","backend":{"kind":"open_ai_compatible","base_url":"http://127.0.0.1:1/v1","model":"text"},"access":"ask"}})).unwrap()).unwrap();
        host.personal_memory_add(&assistant.id,"Keep this note").unwrap();
        (root,host,assistant.id)
    }
    #[tokio::test]
    async fn archive_roundtrip_is_durable_revision_bound_and_retains_identity_history_and_notes() {
        let (root,host,id)=fixture();let before=host.personal_get(&id).unwrap();
        assert!(host.personal_archive(&id,before.revision-1,true).is_err());
        let removed=host.personal_archive(&id,before.revision,true).unwrap().assistant;
        assert!(removed.archived_at.is_some());assert!(removed.paused);assert_eq!(removed.revision,before.revision+1);
        assert_eq!(removed.messages,before.messages);assert_eq!(removed.facts,before.facts);assert_eq!(removed.projects,before.projects);assert_eq!(removed.profile,before.profile);assert_eq!(removed.allowed_folders,before.allowed_folders);
        assert!(host.personal_send(&id,"archived-request","Do work").is_err());assert!(host.personal_pause(&id,"archived-resume",false).is_err());
        let reopened=Host::new(HostPaths{data:root.join("data"),downloads:None},tokio::runtime::Handle::current());let saved=reopened.personal_get(&id).unwrap();assert_eq!(saved.archived_at,removed.archived_at);
        let restored=reopened.personal_archive(&id,saved.revision,false).unwrap().assistant;assert_eq!(restored.id,id);assert_eq!(restored.archived_at,None);assert!(restored.paused);assert_eq!(restored.facts,before.facts);assert_eq!(restored.tasks,before.tasks);assert!(restored.events.is_empty());
        let _=std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn archive_blocks_pending_tasks_events_and_schedules_without_mutating_them() {
        let (root,host,id)=fixture();let original=host.personal_get(&id).unwrap();
        for (field,items) in [
          ("tasks",json!([{"id":"pt-1","goal":"Pending","completionCriteria":[],"targetHost":"owner","status":"queued","fromEvent":"pe-1","maxAttempts":3,"createdAt":1,"updatedAt":1}])),
          ("events",json!([{"id":"pe-1","requestId":"pending","source":{"kind":"human","text":"Question"},"receivedAt":1,"state":"received","attempts":0}])),
          ("schedules",json!([{"id":"s-1","goal":"Scheduled","argv":["true"],"status":"active","createdAt":1,"runs":0,"paramsHash":"hash"}]))
        ] {
          let mut value=serde_json::to_value(&original).unwrap();value[field]=items;
          let record:crate::personal::PersonalAssistant=serde_json::from_value(value).unwrap();host.store().save_personal(&serde_json::from_value(json!({"version":1,"assistants":[record]})).unwrap()).unwrap();
          let before=serde_json::to_value(host.personal_get(&id).unwrap()).unwrap();let error=host.personal_archive(&id,original.revision,true).err().unwrap();assert!(error.contains("Cancel")||error.contains("reply"),"{field}: {error}");
          assert_eq!(serde_json::to_value(host.personal_get(&id).unwrap()).unwrap(),before);
        }
        let _=std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn archived_records_never_claim_pending_events_or_tick_schedules() {
        let (root,host,id)=fixture();host.personal_send(&id,"pending-before-archive","Question").unwrap();
        host.change_assistant(&id,|assistant|{assistant.archived_at=Some(10);assistant.paused=true;assistant.schedules.push(serde_json::from_value(json!({"id":"s-1","goal":"Scheduled","argv":["true"],"everyMs":1000,"nextAt":1,"status":"active","createdAt":1,"runs":0,"paramsHash":"hash"})).unwrap());Ok(())}).unwrap();
        let before=serde_json::to_value(host.personal_get(&id).unwrap()).unwrap();
        assert!(host.personal_claim(&crate::personal_worker::WorkerTools::real(),&std::collections::HashSet::new(),10,10).unwrap().is_empty());host.personal_tick(10000).unwrap();assert_eq!(serde_json::to_value(host.personal_get(&id).unwrap()).unwrap(),before);let _=std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn archive_requires_own_project_tasks_to_be_cancelled_and_keeps_their_ledger() {
        let (root,host,id)=fixture();let assistant=host.personal_get(&id).unwrap();
        let input=|host_id:&str,request:&str|serde_json::from_value(json!({"requestId":request,"batchId":"archive-test","owner":{"workspaceId":"w","cwd":root.join("project"),"hostId":host_id,"conversationId":"monitor"},"revision":1,"originalRequest":"Inspect","brief":"Inspect","destination":{"threadId":"chat","workers":["worker"],"newThread":false},"mode":"read_only","reviewCriteria":[],"lineage":{"assistant":{"hostId":host_id,"assistantId":id},"project":{"hostId":host_id,"workspaceId":"w","cwd":root.join("project")},"sourceEventId":"human","delegationId":request}})).unwrap();
        host.assistant_tasks.prepare_handoff(input("another-host","unrelated")).unwrap();
        let own=host.assistant_tasks.prepare_handoff(input("owner","owned")).unwrap();
        assert!(host.personal_archive(&id,assistant.revision,true).err().unwrap().contains("project tasks"));assert_eq!(host.personal_get(&id).unwrap().archived_at,None);
        let cancelled=host.assistant_tasks.transition(&own.id,own.revision,&own.owner,crate::assistant_tasks::TaskStatus::Cancelled,None).unwrap();
        let removed=host.personal_archive(&id,assistant.revision,true).unwrap().assistant;assert!(removed.archived_at.is_some());assert_eq!(host.assistant_tasks.get(&own.id).unwrap().unwrap(),cancelled);let _=std::fs::remove_dir_all(root);
    }
    #[tokio::test]
    async fn archive_refuses_another_host_and_untrusted_command_routes() {
        let (root,host,id)=fixture();let assistant=host.personal_get(&id).unwrap();std::fs::write(root.join("data/host-id"),"changed-owner").unwrap();assert!(host.personal_archive(&id,assistant.revision,true).is_err());
        let command=crate::Command::from_json(json!({"cmd":"personal_archive","args":{"assistantId":id,"expectedRevision":assistant.revision,"archived":true}})).unwrap();assert!(host.call(command).await.is_err());let _=std::fs::remove_dir_all(root);
    }
}
