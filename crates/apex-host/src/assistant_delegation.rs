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

/// Conservative shared boundary for model-proposed work and routing drafts.
/// A question phrased as an action request ("Can you fix ...?") can authorize
/// work; requests for explanation/status and quoted instructions cannot.
pub(crate) fn human_requests_work(text: &str) -> bool {
    let normalized = text.trim().to_lowercase();
    if !crate::assistant_conversation::direct_imperative(text)
        && !["research ","perform ","inspect ","delegate "].iter().any(|prefix|normalized.starts_with(prefix)) { return false; }
    let mut action = normalized.as_str();
    loop {
        let next = ["please ", "can you ", "i need you to ", "help me ", "help "]
            .into_iter().find_map(|prefix| action.strip_prefix(prefix));
        match next { Some(next) => action = next.trim_start(), None => break }
    }
    if action.is_empty() || action.starts_with(['"', '\'', '`', '“', '‘', '>']) { return false; }
    if ["tell me ", "explain ", "summarize ", "describe ", "what ", "why ", "how ",
        "is ", "are ", "did ", "does ", "do you ", "have you ", "if ", "suppose ",
        "imagine ", "don't ", "do not ", "never ", "wait ", "stop", "cancel", "update me "]
        .iter().any(|prefix| action.starts_with(prefix)) { return false; }
    ["clean up ", "check ", "do ", "handle ", "take ", "work ", "fix ", "review ",
        "build ", "implement ", "run ", "investigate ", "make ", "ask ", "assign ", "send ",
        "inspect ", "research ", "perform ", "create ", "finish ", "repair ", "edit ", "change ", "update ",
        "add ", "remove ", "delete ", "write ", "design ", "test ", "delegate "]
        .iter().any(|prefix|action.starts_with(prefix))
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

fn check_handoff_source(assistant:&PersonalAssistant, task:&crate::assistant_tasks::AssistantTask) -> Result<(),String> {
    let Some(lineage)=&task.lineage else {return Ok(())};
    let stopped=format!("reply-stop:{}",lineage.source_event_id);
    if assistant.events.iter().any(|event|matches!(&event.source,EventSource::Internal {what} if what==&stopped)) {
        return Err("The originating assistant reply was stopped.".into());
    }
    let source=assistant.events.iter().find(|event|event.id==lineage.source_event_id);
    if source.is_some_and(|event|event.state==crate::personal::EventState::Failed) {
        return Err("The originating assistant reply stopped or failed.".into());
    }
    if let Some(gate)=&task.announcement_gate {
        let source=source.ok_or("The saved handoff source is unavailable.")?;
        let receipt=assistant.announcement_receipts.get(&gate.announcement_id).ok_or("The handoff announcement is not published.")?;
        if source.state!=crate::personal::EventState::Done
            || gate.assistant_id!=assistant.id || gate.source_event_id!=source.id
            || gate.released_at_ms.is_none() || receipt.task_id!=task.id
            || gate.message_id.as_deref()!=Some(receipt.message_id.as_str())
            || !matches!(&source.source,EventSource::Human {text,..} if text==&task.original_request)
            || !source.saved_reply.as_ref().is_some_and(|reply|reply.delegations.iter().any(|saved| saved.announcement_id==gate.announcement_id && saved.delegation_id==lineage.delegation_id)) {
            return Err("The task no longer matches its published handoff source.".into());
        }
    }
    Ok(())
}

/// Validate a delegation and turn it into a handoff preparation.
///
/// `event` is the assistant's own record of the user plan this work came from.
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
    plan_delegation_internal(assistant,input,event,owner,monitor_revision,false)
}

fn plan_delegation_internal(assistant:&PersonalAssistant,input:&DelegationInput,event:&PersonalEvent,owner:TaskOwner,monitor_revision:u64,explicit_ui:bool) -> Result<DelegationPlan,String> {
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
    if !explicit_ui && !human_requests_work(text) { return Err("Only an explicit human action request may delegate new work.".into()); }
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
    // The owner tuple is the event's own, so the task keeps the user context
    // it came from. It is verified above, not constructed speculatively.

    let preparation = HandoffPreparation {
        request_id: delegation_request_id(&reference, &input.delegation_id),
        batch_id: input.delegation_id.clone(),
        owner: owner.clone(),
        revision: monitor_revision,
        // The user's words, kept verbatim. The brief is the assistant's
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
    pub(crate) fn saved_handoff_profiles(&self) -> Result<Vec<apex_core::ParticipantConfig>, String> {
        Ok(self.session()?.and_then(|session| session.profiles).unwrap_or_default().into_iter()
            .filter_map(|value| serde_json::from_value::<apex_core::ParticipantConfig>(value).ok())
            .filter(crate::assistant_service::task_worker_eligible).collect())
    }

    /// Resolve only host-saved workers, in the user's selected order. Profile
    /// library order must never silently choose another lead.
    pub(crate) fn selected_handoff_profiles(&self, destination: &TaskDestination, owner: &TaskOwner) -> Result<Vec<apex_core::ParticipantConfig>, String> {
        if destination.workers.is_empty() || destination.workers.len() > 10
            || destination.workers.iter().any(|id| !bounded_identifier(id))
            || destination.workers.iter().collect::<std::collections::HashSet<_>>().len() != destination.workers.len() {
            return Err("Choose between 1 and 10 distinct saved workers.".into());
        }
        let available = if destination.new_thread {
            if destination.thread_id.is_some() { return Err("A new thread cannot also select an existing chat.".into()); }
            if destination.new_thread_title.as_ref().is_some_and(|title| title.trim().is_empty() || title.len() > 200 || title.chars().any(char::is_control)) {
                return Err("Give the new thread a title of up to 200 characters.".into());
            }
            self.saved_handoff_profiles()?
        } else {
            if destination.new_thread_title.is_some() { return Err("A saved destination cannot have a new-thread title.".into()); }
            let id = destination.thread_id.as_deref().filter(|id| bounded_identifier(id)).ok_or("Choose a saved project chat.")?;
            let room = self.store().room(id)?.ok_or("The destination chat is unavailable.")?;
            if !room.cwd.as_deref().is_some_and(|cwd| same_project_path(cwd, &owner.cwd)) {
                return Err("Handoff destination is outside the assigned project.".into());
            }
            room.snapshot.participants
        };
        destination.workers.iter().map(|id| {
            let mut matches = available.iter().filter(|profile| profile.id.to_string() == *id);
            let selected = matches.next().cloned().ok_or_else(|| format!("Saved worker `{id}` is unavailable."))?;
            if matches.next().is_some() { return Err(format!("Saved worker `{id}` is ambiguous.")); }
            Ok(selected)
        }).collect()
    }

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
        if task.attempts.is_empty() && task.destination.as_ref().is_some_and(|destination| destination.new_thread) {
            return self.selected_handoff_profiles(task.destination.as_ref().unwrap(), &task.owner);
        }
        let id = task.execution_thread_id.as_deref().or_else(|| task.destination.as_ref().and_then(|d|d.thread_id.as_deref())).ok_or("Delegated worker destination is unavailable.")?;
        let profiles = match self.handle(id) {
            Ok(handle) => handle.checkpoint.lock().unwrap().snapshot.participants.clone(),
            Err(_) => self.store().room(id)?.ok_or("Delegated worker destination is unavailable.")?.snapshot.participants,
        };
        task.workers.iter().map(|id| profiles.iter().find(|profile|profile.id.to_string()==*id).cloned().ok_or_else(||"A delegated worker is no longer available.".to_owned())).collect()
    }

    pub(crate) fn validate_delegated_worker_profiles(&self, lineage: &AssistantLineage, profiles: &[apex_core::ParticipantConfig]) -> Result<(), String> {
        let document = self.store().personal()?.unwrap_or_default();
        let assistant = document.assistants.iter().find(|a|a.id == lineage.assistant.assistant_id && a.host_id == lineage.assistant.host_id).ok_or("The owning assistant is unavailable.")?;
        for profile in profiles {
            if let Some(reason) = crate::personal_worker::endpoint_refusal(assistant, profile) { return Err(reason); }
        }
        Ok(())
    }

    pub(crate) fn validate_delegated_source(&self, task:&crate::assistant_tasks::AssistantTask) -> Result<(),String> {
        let Some(lineage)=&task.lineage else {return Ok(())};
        self.change_personal(|assistants| {
            let assistant=assistants.iter().find(|assistant|assistant.id==lineage.assistant.assistant_id && assistant.host_id==lineage.assistant.host_id).ok_or("The owning assistant is unavailable.")?;
            check_handoff_source(assistant,task)
        })
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
                check_handoff_source(assistant,task)?;
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
                    if attempt.status==crate::assistant_tasks::TaskStatus::ReadyForReview {
                        crate::personal_worker::delegation_reports::queue(assistant, &task, attempt, crate::personal::now());
                    } else {
                        // Interventions and failures are timely factual updates;
                        // final findings alone use optional model synthesis.
                        let text=crate::personal_worker::delegation_reports::factual(&task,attempt);
                        crate::personal_worker::delegation_reports::post(assistant,text,task.id.clone(),lineage.source_event_id.clone(),crate::personal::now());
                    }
                    assistant.revision += 1;
                }
            }
            Ok(())
        })
    }

    /// Delegated tasks belong to a project's coordinator. A project without one
    /// is connected here, with no checks, using the path the app saved for it.
    pub(crate) fn project_coordinator(&self, project: &ProjectRef) -> Result<crate::monitor::ProjectMonitor, String> {
        if let Some(monitor) = self.monitor_get(&project.workspace_id)? { return Ok(monitor); }
        let workspaces = self.session()?.and_then(|session| session.workspaces).unwrap_or_default();
        let saved = workspaces.iter().find(|ws| ws["id"].as_str() == Some(&project.workspace_id)).ok_or("Project assignment is unavailable.")?;
        let cwd = saved["path"].as_str().unwrap_or(&project.cwd).to_owned();
        let host_id = saved["hostId"].as_str().unwrap_or("local").to_owned();
        self.monitor_connect(project.workspace_id.clone(), cwd, host_id)
    }

    /// The explicit delegation form supplies its own human authorization. Keep
    /// that event Done so the personal model never also processes the brief.
    /// Retries keep the same event and the ordinary delegation receipt.
    pub(crate) fn personal_project_delegate_ui(self: &std::sync::Arc<Self>, input: DelegationInput) -> Result<Value, String> {
        self.personal_project_ui_internal(input, false)
    }

    /// Quick task entry always leaves a durable proposal for separate approval.
    pub(crate) fn personal_project_propose_ui(self: &std::sync::Arc<Self>, input: DelegationInput) -> Result<Value, String> {
        self.personal_project_ui_internal(input, true)
    }

    fn personal_project_ui_internal(self: &std::sync::Arc<Self>, mut input: DelegationInput, force_proposal: bool) -> Result<Value, String> {
        if !input.source_event_id.is_empty() { return Err("UI delegation records its own human request.".into()); }
        let assistant = self.personal_get(&input.assistant_id)?;
        let binding = assistant.projects.iter().find(|b| b.project == input.project).ok_or("Project is not assigned.")?;
        if self.validate_project_binding(&assistant, binding.clone())?.project != input.project { return Err("Project path is no longer canonical.".into()); }
        let monitor = self.project_coordinator(&input.project)?;
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
            let event = PersonalEvent { id:event_id.clone(),request_id:request_id.clone(),source:EventSource::Human {text:input.brief.clone(), view_context:None},received_at:crate::personal::now(),state:crate::personal::EventState::Done,attempts:0,error:None,spend_approved:false,computer_started:false, saved_reply: None };
            draft.post("human", "chat", input.brief.clone(), None, Some(event_id.clone()), event.received_at);
            draft.events.push(event.clone());
            let mut checked = input.clone(); checked.source_event_id=event_id.clone();
            plan_delegation_internal(&draft, &checked, &event, owner.clone(), monitor.revision, true)?;
            *current = draft;
            Ok(event_id)
        })?;
        input.source_event_id=event_id;
        input.expected_revision=self.personal_get(&input.assistant_id)?.revision;
        let receipt=self.prepare_personal_delegation_scoped(input,None,force_proposal,None,true)?;
        if !force_proposal && receipt["standingTrust"]==true {self.redispatch_recovered_queued()?;}
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
        self.prepare_personal_delegation_internal(input,None,false,None)
    }

    /// A model reply's actual cost is recorded once with the completed reply.
    /// Reserve after that pending debit without inserting a duplicate cost or
    /// changing the user's saved daily limit before the reply is committed.
    pub(crate) fn prepare_personal_delegation_with_reply_cost(&self, input: DelegationInput, pending_actual_micros: u64) -> Result<Value, String> {
        self.prepare_personal_delegation_internal(input,Some(pending_actual_micros),false,None)
    }

    /// Recovery must use the private source record's captured coordinator
    /// identity, including a crash before the first project child was saved.
    pub(crate) fn prepare_personal_delegation_with_preparation(&self, input: DelegationInput, pending_cost: Option<u64>, owner: TaskOwner, revision: u64) -> Result<Value, String> {
        self.prepare_personal_delegation_internal(input,pending_cost,false,Some((owner,revision)))
    }

    fn prepare_personal_delegation_internal(&self, input: DelegationInput, returned_reply_cost: Option<u64>, force_proposal: bool, preparation: Option<(TaskOwner,u64)>) -> Result<Value, String> {
        self.prepare_personal_delegation_scoped(input,returned_reply_cost,force_proposal,preparation,false)
    }

    fn prepare_personal_delegation_scoped(&self, input: DelegationInput, returned_reply_cost: Option<u64>, force_proposal: bool, preparation: Option<(TaskOwner,u64)>, explicit_ui: bool) -> Result<Value, String> {
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
            if preparation.as_ref().is_some_and(|(owner,revision)| owner != &saved.owner || *revision != saved.revision) {
                return Err("Delegation retry cannot replace its captured preparation owner or revision.".into());
            }
            if force_proposal && task.result_data.as_ref().is_some_and(|data|data["standingTrust"]==true) {
                return Err("This delegation ID already belongs to executable standing-authority work. Use a new proposal ID.".into());
            }
            return Ok(json!({"taskId":task.id,"project":lineage.project,"lineage":lineage,"status":task.status,"receiptId":saved.request_id,"standingTrust":task.result_data.as_ref().is_some_and(|data|data["standingTrust"]==true)}));
        }
        let event = assistant.events.iter().find(|e| e.id == input.source_event_id).ok_or("That source event is not owned by this assistant.")?;
        let frozen = event.saved_reply.as_ref().and_then(|reply| reply.delegations.iter().find(|saved| saved.delegation_id == input.delegation_id));
        if let Some(saved) = frozen {
            if saved.request_id != delegation_request_id(&reference, &input.delegation_id)
                || saved.project != input.project || saved.brief != input.brief || saved.destination != input.destination
                || saved.mode != input.mode || saved.review_criteria != input.review_criteria
                || preparation.as_ref().is_some_and(|(owner,revision)| owner != &saved.owner || *revision != saved.revision) {
                return Err("Delegation no longer matches its saved preparation.".into());
            }
        } else if preparation.is_some() {
            return Err("The frozen delegation preparation is unavailable.".into());
        }
        let force_proposal = force_proposal || frozen.is_some_and(|saved| !saved.standing_allowed);
        // Validate the original human authorization before connecting anything.
        // A frozen new coordinator reserves its identity in the private source
        // record; no project metadata exists before that durable save.
        let preflight_owner = frozen.map(|saved|saved.owner.clone()).unwrap_or(TaskOwner {
            workspace_id:input.project.workspace_id.clone(),cwd:input.project.cwd.clone(),host_id:input.project.host_id.clone(),conversation_id:"pending".into(),
        });
        plan_delegation_internal(assistant,&input,event,preflight_owner,frozen.map(|saved|saved.revision).unwrap_or(1),explicit_ui)?;
        let monitor = if let Some(existing)=self.monitor_get(&input.project.workspace_id)? { existing }
        else if let Some(saved)=frozen {
            if saved.owner.conversation_id!=format!("apex-agent-{}-{}",input.project.workspace_id,input.source_event_id) || saved.revision!=1 {
                return Err("The saved project coordinator is unavailable. Reconfirm the handoff.".into());
            }
            self.change_monitors(|monitors| {
                if let Some(existing)=monitors.iter().find(|monitor|monitor.workspace_id==input.project.workspace_id) {return Ok(existing.clone());}
                let monitor=crate::monitor::ProjectMonitor::connected(saved.owner.workspace_id.clone(),saved.owner.conversation_id.clone(),saved.owner.cwd.clone(),saved.owner.host_id.clone(),crate::personal::now());
                monitors.push(monitor.clone());
                Ok(monitor)
            })?
        } else { self.project_coordinator(&input.project)? };
        let live_owner = TaskOwner { workspace_id:monitor.workspace_id.clone(), cwd:monitor.cwd.clone(), host_id:monitor.host_id.clone(), conversation_id:monitor.conversation_id.clone() };
        let (owner,revision) = frozen.map(|saved|(saved.owner.clone(),saved.revision)).unwrap_or((live_owner.clone(),monitor.revision));
        if owner != live_owner { return Err("The saved project coordinator was replaced. Reconfirm the handoff.".into()); }
        let mut plan = plan_delegation_internal(assistant, &input, event, owner, revision, explicit_ui)?;
        let gate = frozen.map(|saved| crate::assistant_tasks::AnnouncementGate {
            announcement_id:saved.announcement_id.clone(), assistant_id:assistant.id.clone(),
            source_event_id:event.id.clone(), message_id:None, released_at_ms:None,
        });
        let profiles = self.selected_handoff_profiles(&input.destination, &plan.owner)?;
        let mut contexts = Vec::new();
        for profile in profiles.iter().take(1) {
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
            plan_delegation_internal(current, &input, source, plan.owner.clone(), plan.preparation.revision, explicit_ui)?;
            // A concurrent normal delegation may have saved this receipt while context loaded.
            // Recheck while holding the shared admission lock before proposal-only preparation.
            if force_proposal && self.assistant_tasks.handoff_for_request(&plan.preparation.request_id).map_err(|e|e.to_string())?.is_some_and(|(_, task)|task.result_data.as_ref().is_some_and(|data|data["standingTrust"]==true)) {
                return Err("This delegation ID already belongs to executable standing-authority work. Use a new proposal ID.".into());
            }
            let returned_event=returned_reply_cost.map(|_|input.source_event_id.as_str());
            let mut authority=if force_proposal {None} else {standing_authority(current,&input.project,&profiles,input.mode,returned_event)?};
            if let Some(authority)=authority.as_mut() {
                authority.remaining_budget_micros=authority.remaining_budget_micros.map(|remaining|remaining.saturating_sub(returned_reply_cost.unwrap_or(0)));
            }
            self.prepare_project_handoff_authorized_gated(plan.preparation.clone(),authority,gate.clone())
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
        let input = DelegationInput { assistant_id:"a".into(), project:ProjectRef {host_id:"h".into(),workspace_id:"w".into(),cwd:"/repo".into()},source_event_id:"e".into(), delegation_id:"d".into(),brief:"Fix login".into(),destination:TaskDestination {thread_id:Some("chat".into()),workers:vec!["coder".into()],new_thread: false, new_thread_title: None},mode:TaskMode::Isolated,review_criteria:vec![],expected_revision:4 };
        let owner = TaskOwner {workspace_id:"w".into(),cwd:"/repo".into(),host_id:"h".into(),conversation_id:"monitor".into()};
        (assistant,input,owner)
    }
    #[test]
    fn archived_assistant_cannot_prepare_a_new_project_task() {
        let (mut assistant,input,owner)=fixture();assistant.archived_at=Some(10);
        assert!(plan_delegation(&assistant,&input,&assistant.events[0],owner,9).is_err());
    }
    #[test]
    fn model_delegation_cannot_turn_a_status_question_into_work() {
        for text in ["What is the worker doing?", "Please explain the previous result", "Can you tell me whether the build passed?", "Please give me a status update", "Please update me on progress", "Please show me the current status", "\"Please fix login\"", "If I asked you to fix login, what would happen?"] {
            let (mut assistant,input,owner)=fixture();
            assistant.events[0].source=EventSource::Human {text:text.into(),view_context:None};
            assistant.messages[0].text=text.into();
            assert!(plan_delegation(&assistant,&input,&assistant.events[0],owner,9).is_err(), "{text}");
        }
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
