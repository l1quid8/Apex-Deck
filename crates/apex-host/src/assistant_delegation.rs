//! Bridge verified human conversation into durable project work. Ask retains a
//! proposal; authenticated saved Full may queue within the existing grants.
//!
//! The validation lives in [`plan_delegation`], a pure function, so the rules
//! about which assistant may delegate what are testable without a host.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use serde_json::{json, Value};

use crate::personal::{PersonalEvent, EventSource};
use crate::assistant_tasks::{
    AssistantLineage, HandoffPreparation, TaskDestination, TaskMode, TaskOwner,
};
use crate::personal::PersonalAssistant;
use crate::personal_workspace::{AssistantRef, ProjectRef, ProjectTools};

/// Matches the handoff preparation limits so a delegation is never rejected
/// further down for a bound already checked here.
const MAX_BRIEF: usize = 16_000;
const MAX_CRITERIA: usize = 20;
const MAX_CRITERION: usize = 2_000;
const MAX_ID: usize = 200;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegationInput {
    pub assistant_id: String,
    pub project: ProjectRef,
    pub source_event_id: String,
    pub delegation_id: String,
    pub brief: String,
    pub destination: TaskDestination,
    pub mode: TaskMode,
    #[serde(default)]
    pub review_criteria: Vec<String>,
    pub expected_revision: u64,
}

/// Everything a delegation needs once its inputs are validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationPlan {
    pub owner: TaskOwner,
    pub lineage: AssistantLineage,
    pub preparation: HandoffPreparation,
}

/// The durable request key for one delegation.
///
/// Retries reuse the key, so `prepare_handoff` returns the original proposal
/// rather than a second one. The assistant is part of the key: two assistants
/// delegating inside one project stay distinguishable.
pub fn delegation_request_id(assistant: &AssistantRef, delegation_id: &str) -> String {
    format!("delegation:{:x}", Sha256::digest(serde_json::to_vec(&(assistant, delegation_id)).expect("serializable identity")))
}

fn same_project_path(left: &str, right: &str) -> bool {
    left == right || std::path::Path::new(left).canonicalize().ok().zip(std::path::Path::new(right).canonicalize().ok()).is_some_and(|(a,b)| a == b)
}

fn bounded_identifier(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed == value
        && value.len() <= MAX_ID
        && !value.chars().any(char::is_control)
}

fn standing_policy_hash(assistant: &PersonalAssistant) -> String {
    format!("{:x}",Sha256::digest(serde_json::to_vec(&(
        assistant.workspace_config_version,&assistant.profile,&assistant.projects,
        &assistant.allowed_folders,&assistant.machines,&assistant.privacy,&assistant.budget,
        assistant.utc_offset_minutes,
    )).expect("serializable assistant policy")))
}

fn standing_worker_hash(profiles: &[apex_core::ParticipantConfig], mode: TaskMode) -> String {
    let mut effective=profiles.to_vec();
    effective.sort_by_key(|profile|profile.id.to_string());
    for profile in &mut effective {profile.access=if mode==TaskMode::ReadOnly {apex_core::Access::Read} else {apex_core::Access::Full};}
    format!("{:x}",Sha256::digest(serde_json::to_vec(&effective).expect("serializable worker profiles")))
}

fn personal_cost_inflight(assistant: &PersonalAssistant, returned_event: Option<&str>) -> bool {
    assistant.events.iter().any(|event|event.state==crate::personal::EventState::Processing&&Some(event.id.as_str())!=returned_event)
        || assistant.tasks.iter().any(|task|task.kind==crate::personal::TaskKind::Helper&&task.status==crate::personal::TaskStatus::Running)
}

fn standing_authority(assistant: &PersonalAssistant, project: &ProjectRef, profiles: &[apex_core::ParticipantConfig], mode: TaskMode, returned_event: Option<&str>) -> Result<Option<crate::assistant_tasks::StandingHandoffAuthority>,String> {
    if !crate::personal::permissions::full_access(assistant)
        || !assistant.projects.iter().any(|binding|binding.project==*project&&binding.tools==ProjectTools::Full) {return Ok(None)}
    if assistant.paused || assistant.archived_at.is_some() {return Err("The owning assistant is paused or archived.".into())}
    if assistant.budget.daily_limit_micros.is_some() && personal_cost_inflight(assistant,returned_event) {
        return Err("Waiting for the current assistant reply or helper to finish and record its cost before reserving the daily budget.".into())
    }
    for profile in profiles {
        if let Some(reason)=crate::personal_worker::endpoint_refusal(assistant,profile) {return Err(reason)}
        if assistant.budget.daily_limit_micros.is_some() && !assistant.budget.unknown_cost_ok
            && matches!(profile.backend,apex_core::Backend::OpenAiCompatible{..}) {
            return Err("This worker may not report cost. Allow unknown cost in Settings before delegating within a daily budget.".into())
        }
    }
    let now=crate::personal::now();
    let remaining=assistant.budget.daily_limit_micros.map(|limit|limit.saturating_sub(assistant.spent_today(now)));
    if remaining==Some(0) {return Err("Today's daily budget is exhausted. Change the budget before delegating.".into())}
    Ok(Some(crate::assistant_tasks::StandingHandoffAuthority {
        policy_hash:standing_policy_hash(assistant),worker_hash:standing_worker_hash(profiles,mode),
        budget_day:assistant.local_day_start(now),remaining_budget_micros:remaining,
        unknown_cost_accepted:assistant.budget.unknown_cost_ok,
    }))
}

fn check_standing_delegation(host: &crate::host::Host, assistant: &PersonalAssistant, task: &crate::assistant_tasks::AssistantTask, profiles: &[apex_core::ParticipantConfig]) -> Result<(),String> {
    let Some(data)=task.result_data.as_ref().filter(|data|data["standingTrust"]==true) else {return Ok(())};
    let lineage=task.lineage.as_ref().ok_or("Standing delegation lineage is unavailable.")?;
    let authority=standing_authority(assistant,&lineage.project,profiles,task.mode,None)?.ok_or("The saved Full authority for this delegated task is no longer active.")?;
    let binding=assistant.projects.iter().find(|binding|binding.project==lineage.project).ok_or("Project delegation is no longer enabled.")?;
    if host.validate_project_binding(assistant,binding.clone())?.project!=lineage.project {return Err("Project identity changed.".into())}
    if assistant.events.iter().any(|event|event.id==lineage.source_event_id&&event.state==crate::personal::EventState::Failed) {return Err("The originating conversation request was stopped or failed.".into())}
    if data["standingTrustPolicy"].as_str()!=Some(authority.policy_hash.as_str()) || data["standingWorkerHash"].as_str()!=Some(authority.worker_hash.as_str()) {
        return Err("The saved authority or worker configuration changed. This queued delegation is no longer authorized.".into())
    }
    if let Some(available)=authority.remaining_budget_micros {
        if data["budgetDay"].as_u64()!=Some(authority.budget_day) || !host.assistant_tasks.standing_budget_available(task,authority.budget_day,available) {
            return Err("This delegated task no longer fits the current daily budget.".into())
        }
    }
    Ok(())
}

/// Validate a delegation and turn it into a handoff preparation.
///
/// `event` is the assistant's own record of the human plan this work came from.
/// It is the only proof of origin, so it is checked field by field: the same
/// project, the same host, not imported history, and not a request this
/// machine never answered.
pub fn plan_delegation(
    assistant: &PersonalAssistant,
    input: &DelegationInput,
    event: &PersonalEvent,
    owner: TaskOwner,
    monitor_revision: u64,
) -> Result<DelegationPlan, String> {
    if assistant.archived_at.is_some(){return Err("This assistant is archived. Restore it before proposing work.".into());}
    if !bounded_identifier(&input.delegation_id) {
        return Err("A delegation needs an ID of up to 200 characters.".into());
    }
    if !bounded_identifier(&input.source_event_id) {
        return Err("A delegation needs a source event ID of up to 200 characters.".into());
    }
    if !matches!(input.mode, TaskMode::Isolated | TaskMode::ReadOnly) {
        return Err("Proposed work starts isolated or read-only.".into());
    }
    if assistant.workspace_config_version.is_some() && assistant.profile.as_ref().is_some_and(|p| p.access == apex_core::Access::Read) && input.mode != TaskMode::ReadOnly {
        return Err("This assistant's saved Project tools access is read-only.".into());
    }
    if input.brief.trim().is_empty() || input.brief.len() > MAX_BRIEF {
        return Err("Give the proposal a brief of up to 16,000 characters.".into());
    }
    if input.review_criteria.len() > MAX_CRITERIA
        || input.review_criteria.iter().any(|line| line.trim().is_empty() || line.len() > MAX_CRITERION)
    {
        return Err("Review criteria must be up to 20 non-empty lines of 2,000 characters.".into());
    }

    // The assistant must still be the one the plan belongs to.
    if input.expected_revision != assistant.revision {
        return Err("This assistant changed since the plan was read. Open it again.".into());
    }
    if input.project.host_id != assistant.host_id {
        return Err("An assistant can only delegate to projects on its own machine.".into());
    }
    let binding = assistant
        .projects
        .iter()
        .find(|binding| binding.project == input.project)
        .ok_or("That project is not connected to this assistant.")?;
    if binding.tools == ProjectTools::Off {
        return Err("Project tools are off for this assistant, so it cannot propose work there.".into());
    }

    if input.assistant_id != assistant.id || !assistant.events.iter().any(|own| own == event) {
        return Err("That source event belongs to another assistant.".into());
    }
    if event.id != input.source_event_id {
        return Err("That source event does not match the delegation.".into());
    }
    if event.state == crate::personal::EventState::Failed { return Err("A stopped or failed reply cannot propose project work.".into()); }
    let EventSource::Human { text, .. } = &event.source else {
        return Err("Only a human conversation event may propose work.".into());
    };
    if !assistant.messages.iter().any(|m| m.role == "human" && m.event_id.as_deref() == Some(event.id.as_str()) && m.legacy.is_none() && m.text == *text) {
        return Err("Only a verified human conversation message may propose new project work.".into());
    }
    if text.trim().is_empty() || owner.workspace_id != input.project.workspace_id || !same_project_path(&owner.cwd, &input.project.cwd) {
        return Err("That plan event belongs to a different project.".into());
    }
    let reference = AssistantRef { host_id: assistant.host_id.clone(), assistant_id: assistant.id.clone() };
    let lineage = AssistantLineage {
        assistant: reference.clone(),
        project: input.project.clone(),
        source_event_id: input.source_event_id.clone(),
        delegation_id: input.delegation_id.clone(),
    };
    // The owner tuple is the event's own, so the task keeps the human context
    // it came from. It is verified above, not constructed speculatively.

    let preparation = HandoffPreparation {
        request_id: delegation_request_id(&reference, &input.delegation_id),
        batch_id: input.delegation_id.clone(),
        owner: owner.clone(),
        revision: monitor_revision,
        // The human's words, kept verbatim. The brief is the assistant's
        // restatement and never replaces it.
        original_request: text.clone(),
        brief: input.brief.clone(),
        destination: input.destination.clone(),
        mode: input.mode,
        review_criteria: input.review_criteria.clone(),
        lineage: Some(lineage.clone()),
        context: None,
    };
    Ok(DelegationPlan { owner, lineage, preparation })
}

impl crate::host::Host {
    /// Admission includes outstanding delegated reservations and settled worker
    /// usage without copying it into the assistant's own provider-cost ledger.
    pub(crate) fn effective_personal_spent_today(&self, assistant: &PersonalAssistant, at: u64) -> u64 {
        let reference=AssistantRef {host_id:assistant.host_id.clone(),assistant_id:assistant.id.clone()};
        assistant.spent_today(at).saturating_add(self.assistant_tasks.standing_spent_or_reserved(&reference,assistant.local_day_start(at)))
    }

    pub(crate) fn validate_standing_delegation(&self, task: &crate::assistant_tasks::AssistantTask) -> Result<(),String> {
        if task.result_data.as_ref().is_none_or(|data|data["standingTrust"]!=true) {return Ok(())}
        let lineage=task.lineage.as_ref().ok_or("Standing delegation lineage is unavailable.")?;
        let profiles=self.delegated_worker_profiles(task)?;
        self.change_personal(|assistants| {
            let assistant=assistants.iter().find(|assistant|assistant.id==lineage.assistant.assistant_id&&assistant.host_id==lineage.assistant.host_id).ok_or("The owning assistant is unavailable.")?;
            check_standing_delegation(self,assistant,task,&profiles)
        })
    }

    pub(crate) fn cancel_invalid_standing_queue(&self, task: &crate::assistant_tasks::AssistantTask, reason: &str) -> Result<(),String> {
        if task.result_data.as_ref().is_none_or(|data|data["standingTrust"]!=true) {return Ok(())}
        let profiles=self.delegated_worker_profiles(task).unwrap_or_default();
        self.change_personal(|assistants| {
            let current=self.assistant_tasks.get(&task.id).map_err(|e|e.to_string())?.ok_or("Task unavailable.")?;
            if current.status!=crate::assistant_tasks::TaskStatus::Queued || !current.attempts.is_empty() || current.control.desired_state!=crate::assistant_tasks::DesiredState::Running {return Ok(())}
            if let Some(assistant)=current.lineage.as_ref().and_then(|lineage|assistants.iter().find(|assistant|assistant.id==lineage.assistant.assistant_id&&assistant.host_id==lineage.assistant.host_id)) {
                if assistant.paused {return Ok(())}
                if assistant.budget.daily_limit_micros.is_some() && personal_cost_inflight(assistant,None) {
                    self.assistant_tasks.hold_standing_queue(&current,"Waiting for the current assistant reply or helper to finish and record its cost before launch.").map_err(|e|e.to_string())?;
                    return Ok(())
                }
                if check_standing_delegation(self,assistant,&current,&profiles).is_ok() {return Ok(())}
            }
            self.assistant_tasks.transition(&current.id,current.revision,&current.owner,crate::assistant_tasks::TaskStatus::Cancelled,Some(format!("Delegation cancelled before launch: {reason}"))).map_err(|e|e.to_string())?;
            Ok(())
        })
    }
    pub(crate) fn delegated_worker_profiles(&self, task: &crate::assistant_tasks::AssistantTask) -> Result<Vec<apex_core::ParticipantConfig>, String> {
        let id = task.execution_thread_id.as_deref().or_else(|| task.destination.as_ref().and_then(|d|d.thread_id.as_deref())).ok_or("Delegated worker destination is unavailable.")?;
        let profiles = match self.handle(id) {
            Ok(handle) => handle.checkpoint.lock().unwrap().snapshot.participants.clone(),
            Err(_) => self.store().room(id)?.ok_or("Delegated worker destination is unavailable.")?.snapshot.participants,
        };
        let selected: Vec<_> = profiles.into_iter().filter(|p|task.workers.contains(&p.id.to_string())).collect();
        if selected.len() != task.workers.len() { return Err("A delegated worker is no longer available.".into()); }
        Ok(selected)
    }

    pub(crate) fn validate_delegated_worker_profiles(&self, lineage: &AssistantLineage, profiles: &[apex_core::ParticipantConfig]) -> Result<(), String> {
        let document = self.store().personal()?.unwrap_or_default();
        let assistant = document.assistants.iter().find(|a|a.id == lineage.assistant.assistant_id && a.host_id == lineage.assistant.host_id).ok_or("The owning assistant is unavailable.")?;
        for profile in profiles {
            if let Some(reason) = crate::personal_worker::endpoint_refusal(assistant, profile) { return Err(reason); }
        }
        Ok(())
    }

    pub(crate) fn validate_delegated_task(&self, lineage: &AssistantLineage, require_running: bool) -> Result<(), String> {
        self.change_personal(|assistants| {
            let assistant = assistants.iter().find(|a| a.id == lineage.assistant.assistant_id && a.host_id == lineage.assistant.host_id).ok_or("The owning assistant is unavailable.")?;
            if assistant.archived_at.is_some(){return Err("The owning assistant is archived.".into());}
            if require_running && assistant.paused { return Err("The owning assistant is paused.".into()); }
            let binding = assistant.projects.iter().find(|b| b.project == lineage.project && b.tools != ProjectTools::Off).ok_or("Project delegation is no longer enabled.")?;
            let checked = self.validate_project_binding(assistant, binding.clone())?;
            if checked.project != lineage.project { return Err("Project identity changed.".into()); }
            Ok(())
        })
    }

    /// Shares the personal pause lock with the durable attempt claim. A saved
    /// pause cannot slip between the last owner check and a new worker start.
    pub(crate) fn begin_delegated_attempt(&self, task: &crate::assistant_tasks::AssistantTask, owner: &TaskOwner) -> Result<(crate::assistant_tasks::AssistantTask, String), String> {
        if let Some(lineage) = &task.lineage {
            let profiles = self.delegated_worker_profiles(task)?;
            self.change_personal(|assistants| {
                let assistant = assistants.iter().find(|a| a.id == lineage.assistant.assistant_id && a.host_id == lineage.assistant.host_id).ok_or("The owning assistant is unavailable.")?;
                if assistant.archived_at.is_some(){return Err("The owning assistant is archived.".into());}
                if assistant.paused { return Err("The owning assistant is paused.".into()); }
                if assistant.workspace_config_version.is_some() && assistant.profile.as_ref().is_some_and(|p| p.access == apex_core::Access::Read) && task.mode != TaskMode::ReadOnly { return Err("This assistant now has read-only Project tools access.".into()); }
                if !assistant.projects.iter().any(|b|b.project == lineage.project && b.tools != ProjectTools::Off) { return Err("Project tools are disabled for this assistant.".into()); }
                for profile in &profiles {
                    if let Some(reason) = crate::personal_worker::endpoint_refusal(assistant, profile) { return Err(reason); }
                }
                check_standing_delegation(self,assistant,task,&profiles)?;
                self.assistant_tasks.begin_attempt(&task.id,task.revision,owner).map_err(|e|e.to_string())
            })
        } else { self.assistant_tasks.begin_attempt(&task.id,task.revision,owner).map_err(|e|e.to_string()) }
    }

    /// Result and permanent receipt share one atomic personal-store save.
    pub(crate) fn reconcile_delegation_results(&self) -> Result<(), String> {
        let tasks = self.assistant_tasks.list(None).map_err(|e|e.to_string())?;
        self.change_personal(|assistants| {
            for snapshot in &tasks {
                // Recheck under the personal lock so a deletion/purge that won
                // the race cannot leak a stale worker update back into Chat.
                let Some(task) = self.assistant_tasks.get(&snapshot.id).map_err(|e|e.to_string())? else { continue };
                if task.result_data.as_ref().is_some_and(|data|data["deletedAtMs"].is_number()) { continue; }
                let Some(lineage) = &task.lineage else { continue };
                let Some(assistant) = assistants.iter_mut().find(|a| a.id == lineage.assistant.assistant_id && a.host_id == lineage.assistant.host_id) else { continue };
                for attempt in task.attempts.iter().filter(|a| a.finished_at_ms.is_some()) {
                    let receipt = serde_json::to_string(&(&lineage.project, &task.id, &attempt.run_id)).map_err(|e| e.to_string())?;
                    if !assistant.delegated_result_receipts.insert(receipt.clone()) { continue; }
                    let label = if attempt.status == crate::assistant_tasks::TaskStatus::Interrupted && attempt.result.as_deref() == Some(crate::assistant_watchdog::RESTARTED_RESULT) { crate::assistant_watchdog::RESTARTED_LABEL } else { match attempt.status { crate::assistant_tasks::TaskStatus::Done => "Result available", crate::assistant_tasks::TaskStatus::ReadyForReview => "Result ready for your review", crate::assistant_tasks::TaskStatus::Cancelled => "Task cancelled", _ => "Task needs your attention" } };
                    let brief: String = task.brief.chars().take(140).collect();
                    assistant.post("assistant", "result", format!("{label}: {brief}"), Some(task.id.clone()), Some(lineage.source_event_id.clone()), crate::personal::now());
                    assistant.revision += 1;
                }
            }
            Ok(())
        })
    }

    /// The explicit delegation form supplies its own human authorization. Keep
    /// that event Done so the personal model never also processes the brief.
    /// Retries keep the same event and the ordinary delegation receipt.
    pub(crate) fn personal_project_delegate_ui(self: &std::sync::Arc<Self>, mut input: DelegationInput) -> Result<Value, String> {
        if !input.source_event_id.is_empty() { return Err("UI delegation records its own human request.".into()); }
        let assistant = self.personal_get(&input.assistant_id)?;
        let binding = assistant.projects.iter().find(|b| b.project == input.project).ok_or("Project is not assigned.")?;
        if self.validate_project_binding(&assistant, binding.clone())?.project != input.project { return Err("Project path is no longer canonical.".into()); }
        let monitor = self.monitor_get(&input.project.workspace_id)?.ok_or("Project assignment is unavailable.")?;
        let owner = TaskOwner { workspace_id:monitor.workspace_id.clone(),cwd:monitor.cwd.clone(),host_id:monitor.host_id.clone(),conversation_id:monitor.conversation_id.clone() };
        let request_id = format!("ui-delegation:{}", input.delegation_id);
        let event_id = self.change_assistant(&input.assistant_id, |current| {
            if let Some(event) = current.events.iter().find(|event| event.request_id == request_id) {
                if event.source != (EventSource::Human {text:input.brief.clone(), view_context:None}) || event.state != crate::personal::EventState::Done { return Err("Delegation ID already belongs to another human request.".into()); }
                return Ok(event.id.clone());
            }
            if current.revision != input.expected_revision { return Err("This assistant changed since the plan was read. Open it again.".into()); }
            let mut draft = current.clone();
            draft.counters.event += 1;
            let event_id = format!("pe-{}", draft.counters.event);
            let event = PersonalEvent { id:event_id.clone(),request_id:request_id.clone(),source:EventSource::Human {text:input.brief.clone(), view_context:None},received_at:crate::personal::now(),state:crate::personal::EventState::Done,attempts:0,error:None,spend_approved:false,computer_started:false };
            draft.post("human", "chat", input.brief.clone(), None, Some(event_id.clone()), event.received_at);
            draft.events.push(event.clone());
            let mut checked = input.clone(); checked.source_event_id=event_id.clone();
            plan_delegation(&draft, &checked, &event, owner.clone(), monitor.revision)?;
            *current = draft;
            Ok(event_id)
        })?;
        input.source_event_id=event_id;
        input.expected_revision=self.personal_get(&input.assistant_id)?.revision;
        let receipt=self.prepare_personal_delegation(input)?;
        if receipt["standingTrust"]==true {self.redispatch_recovered_queued()?;}
        Ok(receipt)
    }

    /// A saved Full handoff can start immediately; Ask keeps its proposal.
    pub async fn personal_project_delegate(
        self: &std::sync::Arc<Self>,
        input: DelegationInput,
    ) -> Result<Value, String> {
        let receipt=self.prepare_personal_delegation(input)?;
        if receipt["standingTrust"]==true {self.redispatch_recovered_queued()?;}
        Ok(receipt)
    }

    pub(crate) fn prepare_personal_delegation(&self, input: DelegationInput) -> Result<Value, String> {
        self.prepare_personal_delegation_internal(input,None)
    }

    /// A model reply's actual cost is recorded once with the completed reply.
    /// Reserve after that pending debit without inserting a duplicate cost or
    /// changing the human's saved daily limit before the reply is committed.
    pub(crate) fn prepare_personal_delegation_with_reply_cost(&self, input: DelegationInput, pending_actual_micros: u64) -> Result<Value, String> {
        self.prepare_personal_delegation_internal(input,Some(pending_actual_micros))
    }

    fn prepare_personal_delegation_internal(&self, input: DelegationInput, returned_reply_cost: Option<u64>) -> Result<Value, String> {
        let assistants = self.store().personal()?.unwrap_or_default().assistants;
        let assistant = assistants
            .iter()
            .find(|assistant| assistant.id == input.assistant_id)
            .ok_or("That assistant is not on this machine.")?;
        let binding = assistant.projects.iter().find(|b| b.project == input.project).ok_or("Project is not assigned.")?;
        let checked = self.validate_project_binding(assistant, binding.clone())?;
        if checked.project != input.project { return Err("Project path is no longer canonical.".into()); }
        let reference = AssistantRef {host_id:assistant.host_id.clone(),assistant_id:assistant.id.clone()};
        if let Some((saved, task)) = self.assistant_tasks.handoff_for_request(&delegation_request_id(&reference, &input.delegation_id)).map_err(|e|e.to_string())? {
            let lineage = AssistantLineage {assistant:reference.clone(),project:input.project.clone(),source_event_id:input.source_event_id.clone(),delegation_id:input.delegation_id.clone()};
            if saved.lineage.as_ref() != Some(&lineage) || saved.brief != input.brief || saved.destination != input.destination || saved.mode != input.mode || saved.review_criteria != input.review_criteria {
                return Err("Delegation ID already belongs to a different proposal.".into());
            }
            return Ok(json!({"taskId":task.id,"project":lineage.project,"lineage":lineage,"status":task.status,"receiptId":saved.request_id,"standingTrust":task.result_data.as_ref().is_some_and(|data|data["standingTrust"]==true)}));
        }
        let event = assistant.events.iter().find(|e| e.id == input.source_event_id).ok_or("That source event is not owned by this assistant.")?;
        let monitor = self.monitor_get(&input.project.workspace_id)?.ok_or("Project assignment is unavailable.")?;
        let owner = TaskOwner { workspace_id:monitor.workspace_id.clone(), cwd:monitor.cwd.clone(), host_id:monitor.host_id.clone(), conversation_id:monitor.conversation_id.clone() };
        let mut plan = plan_delegation(assistant, &input, event, owner, monitor.revision)?;
        let destination = input.destination.thread_id.as_deref().ok_or("Choose a saved project chat.")?;
        let room = self.store().room(destination)?.ok_or("The destination chat is unavailable.")?;
        let profiles:Vec<_>=room.snapshot.participants.iter().filter(|profile|input.destination.workers.contains(&profile.id.to_string())).cloned().collect();
        let mut contexts = Vec::new();
        for profile in room.snapshot.participants.iter().filter(|p| input.destination.workers.contains(&p.id.to_string())).take(1) {
            let mut context = self.assemble_delegation_context(&reference, &input.project, &input.brief, profile)?;
            // A shared worker prompt contains only project evidence, not private assistant facts.
            context.notes.retain(|note| note.scope != "assistant");
            contexts.push(serde_json::to_value(context).map_err(|e|e.to_string())?);
        }
        plan.preparation.context = Some(json!(contexts));
        let response = self.change_personal(|assistants| {
            let current = assistants.iter().find(|a| a.id == input.assistant_id && a.host_id == reference.host_id).ok_or("Assistant is unavailable.")?;
            let source = current.events.iter().find(|e| e.id == input.source_event_id).ok_or("Source event is no longer available.")?;
            // Hold the personal pause/configuration lock through proposal save.
            plan_delegation(current, &input, source, plan.owner.clone(), plan.preparation.revision)?;
            let returned_event=returned_reply_cost.map(|_|input.source_event_id.as_str());
            let mut authority=standing_authority(current,&input.project,&profiles,input.mode,returned_event)?;
            if let Some(authority)=authority.as_mut() {
                authority.remaining_budget_micros=authority.remaining_budget_micros.map(|remaining|remaining.saturating_sub(returned_reply_cost.unwrap_or(0)));
            }
            self.prepare_project_handoff_authorized(plan.preparation.clone(),authority)
        })?;
        let task: crate::assistant_tasks::AssistantTask = serde_json::from_value(response["task"].clone()).map_err(|e|e.to_string())?;
        // A retry with the same delegation ID returns the original proposal, so
        // this is safe to emit again and does not depend on being first.
        self.assistant_changed(&plan.owner.workspace_id);
        Ok(json!({
            "taskId": task.id,
            "project": plan.lineage.project,
            "lineage": plan.lineage,
            "status": task.status,
            "receiptId": plan.preparation.request_id,
            "standingTrust":task.result_data.as_ref().is_some_and(|data|data["standingTrust"]==true),
        }))
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PersonalAssistant, DelegationInput, TaskOwner) {
        let mut assistant: PersonalAssistant = serde_json::from_value(json!({
            "id":"a", "name":"Ada", "style":"", "hostId":"h", "profile":null,
            "projects":[{"project":{"hostId":"h","workspaceId":"w","cwd":"/repo"},"tools":"full"}],
            "allowedFolders":["/repo"], "paused":false, "revision":4,"createdAt":1,
            "counters":{"message":0,"event":0,"task":0,"decision":0},"messages":[],"events":[],"tasks":[]
        })).unwrap();
        assistant.events.push(serde_json::from_value(json!({"id":"e","requestId":"human-request","source":{"kind":"human","text":"Please fix login"},"receivedAt":1,"state":"done"})).unwrap());
        assistant.post("human", "chat", "Please fix login".into(), None, Some("e".into()), 1);
        let input = DelegationInput { assistant_id:"a".into(), project:ProjectRef {host_id:"h".into(),workspace_id:"w".into(),cwd:"/repo".into()},source_event_id:"e".into(), delegation_id:"d".into(),brief:"Fix login".into(),destination:TaskDestination {thread_id:Some("chat".into()),workers:vec!["coder".into()],new_thread:false},mode:TaskMode::Isolated,review_criteria:vec![],expected_revision:4 };
        let owner = TaskOwner {workspace_id:"w".into(),cwd:"/repo".into(),host_id:"h".into(),conversation_id:"monitor".into()};
        (assistant,input,owner)
    }
    #[test]
    fn archived_assistant_cannot_prepare_a_new_project_task() {
        let (mut assistant,input,owner)=fixture();assistant.archived_at=Some(10);
        assert!(plan_delegation(&assistant,&input,&assistant.events[0],owner,9).is_err());
    }
    #[test]
    fn a_human_event_without_verified_personal_message_cannot_delegate() {
        let (mut assistant,input,owner)=fixture();
        assistant.messages.clear();
        assert!(plan_delegation(&assistant,&input,&assistant.events[0],owner,9).is_err());
    }

    #[test]
    fn personal_human_origin_and_exact_assistant_are_required() {
        let (assistant, mut input, owner) = fixture();
        let plan = plan_delegation(&assistant,&input,&assistant.events[0],owner.clone(),9).unwrap();
        assert_eq!(plan.preparation.original_request,"Please fix login");
        assert_eq!(plan.preparation.revision,9);
        input.assistant_id="someone-else".into();
        assert!(plan_delegation(&assistant,&input,&assistant.events[0],owner,9).is_err());
    }
    #[test]
    fn internal_source_stale_revision_off_and_wrong_project_are_rejected() {
        let (mut assistant, input, owner) = fixture();
        assistant.events[0].source=EventSource::Internal {what:"model text".into()};
        assert!(plan_delegation(&assistant,&input,&assistant.events[0],owner.clone(),9).is_err());
        let (mut assistant, input, owner) = fixture();
        assistant.revision+=1;
        assert!(plan_delegation(&assistant,&input,&assistant.events[0],owner.clone(),9).is_err());
        assistant.revision=4;
        assistant.projects[0].tools=ProjectTools::Off;
        assert!(plan_delegation(&assistant,&input,&assistant.events[0],owner,9).is_err());
    }
    #[test]
    fn proposal_receipt_survives_restart_and_binds_lineage() {
        let (assistant, input, owner)=fixture();
        let plan=plan_delegation(&assistant,&input,&assistant.events[0],owner,9).unwrap();
        let path=std::env::temp_dir().join(format!("delegation-test-{}",std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        let ledger=path.join("tasks.json");
        let store=crate::assistant_tasks::AssistantTasks::open(&ledger).unwrap();
        let task=store.prepare_handoff(plan.preparation.clone()).unwrap();
        assert_eq!(task.status,crate::assistant_tasks::TaskStatus::Proposed);
        let reopened=crate::assistant_tasks::AssistantTasks::open(&ledger).unwrap();
        assert_eq!(reopened.prepare_handoff(plan.preparation.clone()).unwrap(),task);
        let mut changed=plan.preparation;
        changed.lineage.as_mut().unwrap().assistant.assistant_id="other".into();
        assert!(reopened.prepare_handoff(changed).is_err());
        assert!(reopened.begin_attempt(&task.id,task.revision,&task.owner).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }
}

#[cfg(test)]
#[path = "assistant_delegation/standing_tests.rs"]
mod standing_tests;
