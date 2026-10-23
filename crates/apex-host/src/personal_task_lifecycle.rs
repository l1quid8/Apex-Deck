//! Host-owned task deletion. Cancellation is authoritative; restoration never dispatches.
use crate::{Host, personal::{EventSource, EventState, PersonalEvent}, assistant_tasks::TaskStatus as DelegatedStatus};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleInput {
    pub assistant_id: String,
    pub expected_revision: u64,
    pub action: String,
    #[serde(default)] pub task: Option<TaskRef>,
    #[serde(default)] pub expected_deleted: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRef { pub source: String, pub task_id: String, #[serde(default)] pub revision: Option<u64> }

impl Host {
    pub(crate) async fn personal_task_lifecycle(self: &Arc<Self>, input: LifecycleInput) -> Result<Value, String> {
        if !matches!(input.action.as_str(), "delete" | "restore" | "empty") { return Err("Unknown task lifecycle action.".into()); }
        let assistant = self.personal_get(&input.assistant_id)?;
        if assistant.host_id != self.local_host_id()? || assistant.revision != input.expected_revision { return Err("Assistant owner or revision changed. Refresh before acting.".into()); }
        let owner = crate::personal_workspace::AssistantRef {host_id: assistant.host_id.clone(), assistant_id: assistant.id.clone()};
        if input.action == "empty" {
            if input.task.is_some() || input.expected_deleted.is_empty() { return Err("Confirm the exact nonempty deleted task count.".into()); }
            // The personal document lock is always before the delegated ledger lock.
            let affected = self.change_assistant(&assistant.id, |record| {
                if record.revision != input.expected_revision { return Err("Assistant changed. Refresh deleted tasks.".into()); }
                let personal: Vec<_> = record.tasks.iter().filter(|task|task.deleted_at.is_some()).map(|task|task.id.clone()).collect();
                // Running local/remote operations must retain receipts until settlement.
                if record.tasks.iter().filter(|task|task.deleted_at.is_some()).any(|task|task.receipts.iter().any(|receipt|receipt.finished_at.is_none())) { return Err("Wait for cancelled operations to report their final receipt before emptying.".into()); }
                let delegated_tasks: Vec<_> = self.assistant_tasks.list(None).map_err(|e|e.to_string())?.into_iter().filter(|task|task.lineage.as_ref().is_some_and(|lineage|lineage.assistant == owner) && task.result_data.as_ref().is_some_and(|data|data["deletedAtMs"].is_number())).collect();
                let delegated: Vec<_> = delegated_tasks.iter().map(|task|task.id.clone()).collect();
                let exact: std::collections::BTreeSet<_> = personal.iter().map(|id|format!("personal:{id}")).chain(delegated.iter().map(|id|format!("delegated:{id}"))).collect();
                if exact != input.expected_deleted.iter().cloned().collect() || exact.len()!=input.expected_deleted.len() { return Err("Deleted tasks changed. Review the new exact count before emptying.".into()); }
                self.assistant_tasks.purge_deleted(&owner, &delegated).map_err(|e|e.to_string())?;
                // Preserve events/operation ids as authority receipts. No source event is
                // made received again, and ids are never reused by monotonic counters.
                let mut tombstones = record.extra.get("purgedTaskAuthority").and_then(Value::as_object).cloned().unwrap_or_default();
                for task in record.tasks.iter().filter(|task|personal.contains(&task.id)) {
                    let request_id = record.events.iter().find(|event|event.id == task.from_event).map(|event|event.request_id.clone());
                    tombstones.insert(task.id.clone(), json!({"requestId":request_id,"fromEvent":task.from_event,"operations":task.receipts.iter().map(|receipt|json!({"opId":receipt.op_id,"paramsHash":receipt.params_hash,"phase":receipt.phase})).collect::<Vec<_>>()}));
                }
                record.extra.insert("purgedTaskAuthority".into(), Value::Object(tombstones));
                record.tasks.retain(|task|!personal.contains(&task.id));
                record.messages.retain(|message|message.task_id.as_ref().is_none_or(|id| {
                    if personal.contains(id) || delegated.contains(id) { return false; }
                    // Older delegated updates used the immutable receipt tuple as taskId.
                    let legacy=serde_json::from_str::<Value>(id).ok();
                    !legacy.as_ref().and_then(Value::as_array).is_some_and(|parts| parts.len()==3 && delegated_tasks.iter().any(|task|parts[1].as_str()==Some(&task.id) && task.lineage.as_ref().is_some_and(|lineage|serde_json::to_value(&lineage.project).ok().as_ref()==Some(&parts[0]))))
                }));
                record.notices.retain(|notice|notice.task_id.as_ref().is_none_or(|id|!personal.contains(id) && !delegated.contains(id)));
                Ok(delegated_tasks.iter().map(|task|task.owner.workspace_id.clone()).collect::<std::collections::BTreeSet<_>>())
            })?;
            for workspace in affected { self.assistant_changed(&workspace); }
        } else {
            let target = input.task.as_ref().ok_or("Choose one task.")?;
            match target.source.as_str() {
                "personal" => {
                    let stopped = self.change_assistant(&assistant.id, |record| {
                        if record.revision != input.expected_revision { return Err("Assistant changed. Refresh before acting.".into()); }
                        let task = record.tasks.iter().find(|task|task.id == target.task_id).ok_or("Task not found for this assistant.")?;
                        if input.action == "restore" {
                            if task.deleted_at.is_none() { return Err("This task is not deleted.".into()); }
                            record.task_mut(&target.task_id).unwrap().deleted_at = None;
                            return Ok(vec![]);
                        }
                        let stop = if task.status.settled() { vec![] } else {
                            record.counters.event += 1;
                            let event = PersonalEvent { id: format!("pe-{}",record.counters.event), request_id: format!("lifecycle-delete:{}:{}",target.task_id,record.revision), source:EventSource::Cancel {task_id:target.task_id.clone()}, received_at:crate::personal::now(), state:EventState::Processing, attempts:0,error:None,spend_approved:false };
                            record.events.push(event.clone());
                            let stop = crate::personal_worker::apply_control(record, &event);
                            if record.events.iter().find(|saved|saved.id == event.id).is_some_and(|saved|saved.state == EventState::Failed) { return Err("Cancellation failed. The task was not deleted.".into()); }
                            stop
                        };
                        let task=record.task_mut(&target.task_id).ok_or("Task disappeared.")?;
                        if !task.status.settled() { return Err("Cancellation did not settle this task.".into()); }
                        task.deleted_at=Some(crate::personal::now()); Ok(stop)
                    })?;
                    for id in stopped { if let Some(signal)=self.personal_stops.lock().unwrap().get(&format!("{}:{id}",assistant.id)) {signal.notify_one();} }
                }
                "delegated" => {
                    let mut task = self.assistant_tasks.get(&target.task_id).map_err(|e|e.to_string())?.ok_or("Task not found.")?;
                    if !task.lineage.as_ref().is_some_and(|lineage|lineage.assistant == owner) { return Err("Task belongs to a different assistant or machine.".into()); }
                    if target.revision != Some(task.revision) { return Err("Task changed. Reopen it before deleting or restoring.".into()); }
                    if crate::assistant_service::has_pending_integration(&task) { return Err("Reconcile the interrupted project integration before deleting this task.".into()); }
                    if input.action == "delete" && !matches!(task.status, DelegatedStatus::Done | DelegatedStatus::Cancelled) && !(matches!(task.status, DelegatedStatus::Failed | DelegatedStatus::Interrupted) && !task.result_data.as_ref().is_some_and(|data|data["leaseHeld"] == true)) {
                        task = self.assistant_task_action(crate::assistant_service::AssistantActionInput {task_id:task.id.clone(),revision:task.revision,owner:task.owner.clone(),action:"cancel".into(),mode:None,text:None,destination:None,new_worker_profiles:vec![],checks:None,spend_limit_micros:None}).await?;
                    }
                    let _lock=self.assistant_apply.lock().await;
                    self.assistant_tasks.lifecycle(&task.id,task.revision,&task.owner,input.action=="restore").map_err(|e|e.to_string())?;
                    self.change_assistant(&assistant.id, |record| {
                        let revision=record.extra.get("taskLifecycleRevision").and_then(Value::as_u64).unwrap_or(0);
                        record.extra.insert("taskLifecycleRevision".into(),json!(revision.saturating_add(1))); Ok(())
                    })?;
                    self.assistant_changed(&task.owner.workspace_id);
                }
                _ => return Err("Unknown task source.".into()),
            }
        }
        Ok(json!({"assistant":self.personal_get(&assistant.id)?}))
    }
}
