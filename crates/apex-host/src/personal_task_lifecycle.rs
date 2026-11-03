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
    #[serde(default)] pub tasks: Vec<TaskRef>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRef { pub source: String, pub task_id: String, #[serde(default)] pub revision: Option<u64> }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectLifecycleInput {
    pub task_id: String,
    pub revision: u64,
    pub owner: crate::assistant_tasks::TaskOwner,
    pub action: String,
}

impl Host {
    pub(crate) async fn project_task_lifecycle(self: &Arc<Self>, input: ProjectLifecycleInput) -> Result<Value, String> {
        if input.action != "purge" { return Err("Unknown project task lifecycle action.".into()); }
        let task = self.assistant_tasks.get(&input.task_id).map_err(|e| e.to_string())?.ok_or("Task not found.")?;
        if task.owner != input.owner || task.revision != input.revision {
            return Err("Task ownership or revision changed. Refresh before deleting.".into());
        }
        // Linked rows may be opened from Project tasks as well as Alfred. Use
        // the same personal lock and cleanup so task status lines disappear on
        // both surfaces. An orphaned lineage still permits exact owner cleanup.
        if let Some(lineage) = &task.lineage {
            if let Some(assistant) = self.personal_list()?.into_iter().find(|assistant| assistant.id == lineage.assistant.assistant_id && assistant.host_id == lineage.assistant.host_id) {
                self.personal_task_lifecycle(LifecycleInput {
                    assistant_id: assistant.id, expected_revision: assistant.revision,
                    action: "purge".into(), task: None, expected_deleted: vec![],
                    tasks: vec![TaskRef { source: "delegated".into(), task_id: input.task_id.clone(), revision: Some(input.revision) }],
                }).await?;
                return Ok(json!({"purgedTaskIds": [input.task_id]}));
            }
        }
        let _apply = self.assistant_apply.lock().await;
        if self.assistant_runs.lock().unwrap().contains_key(&input.task_id) {
            return Err("Wait for the final worker receipt before deleting.".into());
        }
        if self.checkout_gate(std::path::Path::new(&input.owner.cwd)).owner().as_deref() == Some(&input.task_id) {
            return Err("Wait for the task's checkout reservation to be released before deleting.".into());
        }
        self.assistant_tasks.purge_exact(&[(input.task_id.clone(), input.revision, input.owner.clone())], None).map_err(|e| e.to_string())?;
        self.assistant_changed(&input.owner.workspace_id);
        Ok(json!({"purgedTaskIds": [input.task_id]}))
    }

    async fn purge_personal_tasks(self: &Arc<Self>, assistant_id: &str, owner: &crate::personal_workspace::AssistantRef, input: &LifecycleInput) -> Result<Value, String> {
        if input.tasks.is_empty() || input.task.is_some() || !input.expected_deleted.is_empty() {
            return Err("Confirm the exact nonempty task selection.".into());
        }
        let mut selected = std::collections::BTreeSet::new();
        for target in &input.tasks {
            if !matches!(target.source.as_str(), "personal" | "delegated" | "schedule") || !selected.insert((target.source.clone(), target.task_id.clone())) {
                return Err("Choose distinct personal, delegated or scheduled tasks.".into());
            }
        }
        let _apply = self.assistant_apply.lock().await;
        let affected = self.change_assistant(assistant_id, |record| {
            if record.revision != input.expected_revision || record.host_id != owner.host_id {
                return Err("Assistant owner or revision changed. Refresh before deleting.".into());
            }
            let mut personal = Vec::new();
            let mut schedules = Vec::new();
            let mut delegated_tasks = Vec::new();
            for target in &input.tasks {
                if target.source == "personal" {
                    let task = record.tasks.iter().find(|task| task.id == target.task_id).ok_or("Task not found for this assistant.")?;
                    if !task.status.settled() || task.receipts.iter().any(|receipt| receipt.finished_at.is_none()) || self.personal_stops.lock().unwrap().contains_key(&format!("{assistant_id}:{}",task.id)) {
                        return Err("Wait for the task and final receipt to settle before deleting.".into());
                    }
                    personal.push(task.id.clone());
                } else if target.source == "schedule" {
                    let schedule = record.schedules.iter().find(|schedule| schedule.id == target.task_id).ok_or("Schedule not found for this assistant.")?;
                    if schedule.status != crate::personal::ScheduleStatus::Cancelled {
                        return Err("Cancel this schedule before deleting it.".into());
                    }
                    if record.tasks.iter().filter(|task| task.schedule_id.as_deref() == Some(schedule.id.as_str()) || schedule.last_task_id.as_deref() == Some(task.id.as_str())).any(|task| !task.status.settled() || task.receipts.iter().any(|receipt| receipt.finished_at.is_none()) || self.personal_stops.lock().unwrap().contains_key(&format!("{assistant_id}:{}", task.id))) {
                        return Err("Wait for scheduled work and its final receipt to settle before deleting this schedule.".into());
                    }
                    schedules.push(schedule.id.clone());
                } else {
                    let task = self.assistant_tasks.get(&target.task_id).map_err(|e| e.to_string())?.ok_or("Task not found.")?;
                    if !task.lineage.as_ref().is_some_and(|lineage| &lineage.assistant == owner) {
                        return Err("Task belongs to a different assistant or machine.".into());
                    }
                    if target.revision != Some(task.revision) { return Err("Task changed. Refresh before deleting.".into()); }
                    delegated_tasks.push(task);
                }
            }
            if delegated_tasks.iter().any(|task| self.checkout_gate(std::path::Path::new(&task.owner.cwd)).owner().as_deref() == Some(&task.id)) {
                return Err("Wait for the task's checkout reservation to be released before deleting.".into());
            }
            if delegated_tasks.iter().any(|task| self.assistant_runs.lock().unwrap().contains_key(&task.id)) {
                return Err("Wait for the final worker receipt before deleting.".into());
            }
            if !delegated_tasks.is_empty() {
                self.assistant_tasks.purge_exact(&delegated_tasks.iter().map(|task| (task.id.clone(), task.revision, task.owner.clone())).collect::<Vec<_>>(), Some(owner)).map_err(|e|e.to_string())?;
            }
            let mut tombstones = record.extra.get("purgedTaskAuthority").and_then(Value::as_object).cloned().unwrap_or_default();
            for task in record.tasks.iter().filter(|task| personal.contains(&task.id)) {
                let request_id = record.events.iter().find(|event| event.id == task.from_event).map(|event| event.request_id.clone());
                tombstones.insert(task.id.clone(), json!({"requestId":request_id,"fromEvent":task.from_event,"operations":task.receipts.iter().map(|receipt| json!({"opId":receipt.op_id,"paramsHash":receipt.params_hash,"phase":receipt.phase})).collect::<Vec<_>>()}));
            }
            record.extra.insert("purgedTaskAuthority".into(), Value::Object(tombstones));
            if !schedules.is_empty() {
                let mut authority = record.extra.get("purgedScheduleAuthority").and_then(Value::as_object).cloned().unwrap_or_default();
                for schedule in record.schedules.iter().filter(|schedule| schedules.contains(&schedule.id)) {
                    authority.insert(schedule.id.clone(), json!({"paramsHash":schedule.params_hash,"createdAt":schedule.created_at,"lastTaskId":schedule.last_task_id,"runs":schedule.runs}));
                }
                record.extra.insert("purgedScheduleAuthority".into(), Value::Object(authority));
                record.schedules.retain(|schedule| !schedules.contains(&schedule.id));
            }
            record.tasks.retain(|task| !personal.contains(&task.id));
            record.messages.retain(|message| message.task_id.as_ref().is_none_or(|id| {
                if personal.contains(id) || schedules.contains(id) || delegated_tasks.iter().any(|task| &task.id == id) { return false; }
                let legacy = serde_json::from_str::<Value>(id).ok();
                !legacy.as_ref().and_then(Value::as_array).is_some_and(|parts| parts.len() == 3 && delegated_tasks.iter().any(|task| parts[1].as_str() == Some(&task.id) && task.lineage.as_ref().is_some_and(|lineage| serde_json::to_value(&lineage.project).ok().as_ref() == Some(&parts[0]))))
            }));
            record.notices.retain(|notice| notice.task_id.as_ref().is_none_or(|id| !personal.contains(id) && !schedules.contains(id) && !delegated_tasks.iter().any(|task| &task.id == id)));
            Ok(delegated_tasks.iter().map(|task| task.owner.workspace_id.clone()).collect::<std::collections::BTreeSet<_>>())
        })?;
        for workspace in affected { self.assistant_changed(&workspace); }
        Ok(json!({"assistant": self.personal_get(assistant_id)?}))
    }

    pub(crate) async fn personal_task_lifecycle(self: &Arc<Self>, input: LifecycleInput) -> Result<Value, String> {
        if !matches!(input.action.as_str(), "delete" | "restore" | "empty" | "purge") { return Err("Unknown task lifecycle action.".into()); }
        let assistant = self.personal_get(&input.assistant_id)?;
        if assistant.host_id != self.local_host_id()? || assistant.revision != input.expected_revision { return Err("Assistant owner or revision changed. Refresh before acting.".into()); }
        let owner = crate::personal_workspace::AssistantRef {host_id: assistant.host_id.clone(), assistant_id: assistant.id.clone()};
        if input.action == "purge" {
            return self.purge_personal_tasks(&assistant.id, &owner, &input).await;
        }
        if !input.tasks.is_empty() { return Err("Task selections are only accepted for purge.".into()); }
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
                            let event = PersonalEvent { id: format!("pe-{}",record.counters.event), request_id: format!("lifecycle-delete:{}:{}",target.task_id,record.revision), source:EventSource::Cancel {task_id:target.task_id.clone()}, received_at:crate::personal::now(), state:EventState::Processing, attempts:0,error:None,spend_approved:false,computer_started:false, saved_reply: None };
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
