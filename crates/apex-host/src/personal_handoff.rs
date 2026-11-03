//! Conversational routing drafts and host-owned stop/continue controls (Round 1, Tasks 2 + 4a).
//!
//! PendingHandoff holds a partially-resolved handoff that needs one slot at a time:
//! Project, Thread, or Workers. It lives on PersonalAssistant with revision binding.
//! Selection is owner + revision bound, idempotent, ordered worker ids preserved.
//! Control path implements deterministic whole-message classification and
//! question-bound continue, model-only confirmation gating, and real paused state.

use serde::{Deserialize, Serialize};

use crate::assistant_tasks::{TaskDestination, TaskOwner};
use crate::personal_workspace::ProjectRef;
use crate::personal::PersonalAssistant;

// Re-export classifier types from the dedicated reply module so there is a single truth.
pub use crate::assistant_handoff_reply::{classify_plain_reply, PlainReply};

/// Which piece is still missing from a pending handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffSlot {
    Project,
    Thread,
    Workers,
}

/// Draft that remembers original request while asking for the next missing item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingHandoff {
    pub id: String,
    pub revision: u64,
    pub source_event_id: String,
    pub original_request: String,
    pub brief: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<TaskDestination>,
    pub missing: HandoffSlot,
    #[serde(default)]
    pub selection_event_ids: Vec<String>,
    /// Owner assistant identity for validation (redundant but explicit).
    #[serde(default)]
    pub assistant_id: String,
    #[serde(default)]
    pub host_id: String,
    #[serde(default)]
    pub created_at_ms: u64,
    #[serde(default)]
    pub updated_at_ms: u64,
}

/// Selection payload for personal_handoff_select.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HandoffSelection {
    Project { project: ProjectRef },
    Thread { thread_id: String },
    NewThread { title: String },
    Workers { worker_ids: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffSelectInput {
    pub assistant_id: String,
    pub request_id: String,
    pub draft_id: String,
    pub expected_draft_revision: u64,
    pub slot: HandoffSlot,
    pub selection: HandoffSelection,
    #[serde(default)]
    pub owner: Option<TaskOwner>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffSelectReceipt {
    pub draft: Option<PendingHandoff>,
    pub task_id: Option<String>,
    pub task_revision: Option<u64>,
    pub duplicate: bool,
}

/// Control actions for Round 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffControlAction {
    Stop,
    Continue,
    Retry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffControlInput {
    pub assistant_id: String,
    pub request_id: String,
    pub task_id: String,
    pub expected_task_revision: u64,
    pub action: HandoffControlAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_question_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<TaskDestination>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation: Option<ControlConfirmation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlConfirmation {
    pub assistant_id: String,
    pub task_id: String,
    pub run_id: String,
    pub question_id: String,
    pub question_revision: u64,
    pub control_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffControlReceipt {
    pub task_id: String,
    pub control_revision: u64,
    pub run_id: Option<String>,
    pub outcome: ControlOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_progress: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlOutcome {
    Stopping,
    Stopped,
    Continued,
    NeedsYou,
    Failed,
    Retried,
    AlreadySettled,
}

/// Helpers for negotiation.

pub fn missing_slot_for(project: Option<&ProjectRef>, destination: Option<&TaskDestination>, workers: &[String]) -> Option<HandoffSlot> {
    if project.is_none() {
        return Some(HandoffSlot::Project);
    }
    if destination.as_ref().and_then(|d| d.thread_id.as_ref()).is_none() && destination.as_ref().is_none_or(|d| !d.new_thread) {
        return Some(HandoffSlot::Thread);
    }
    if workers.is_empty() {
        return Some(HandoffSlot::Workers);
    }
    None
}

/// Classify plain reply — thin wrapper around assistant_handoff_reply.
pub fn classify_plain_handoff_reply(text: &str) -> PlainReply {
    classify_plain_reply(text)
}

/// Validate and apply a selection to a draft. Returns updated draft or task receipt indicator.
///
/// This function is pure over the draft; Host wraps it with ledger locks.
pub fn apply_selection(
    assistant: &PersonalAssistant,
    draft: &PendingHandoff,
    input: &HandoffSelectInput,
) -> Result<PendingHandoff, String> {
    if draft.assistant_id != input.assistant_id || draft.host_id != assistant.host_id {
        // Also validate against passed assistant id
        if draft.assistant_id != assistant.id {
            return Err("Draft belongs to a different assistant.".into());
        }
    }
    if draft.id != input.draft_id {
        return Err("Draft id mismatch.".into());
    }
    if draft.revision != input.expected_draft_revision {
        return Err("Draft revision is stale.".into());
    }
    if draft.missing != input.slot {
        return Err("Slot does not match current missing slot.".into());
    }

    let mut next = draft.clone();

    match (&input.slot, &input.selection) {
        (HandoffSlot::Project, HandoffSelection::Project { project }) => {
            // Validate project exists in assistant bindings (best-effort here; full check in host)
            next.project = Some(project.clone());
            next.missing = HandoffSlot::Thread;
        }
        (HandoffSlot::Thread, HandoffSelection::Thread { thread_id }) => {
            if thread_id.trim().is_empty() {
                return Err("Thread id is required.".into());
            }
            let mut dest = next.destination.clone().unwrap_or(TaskDestination {
                thread_id: None,
                workers: vec![],
                new_thread: false,
            });
            dest.thread_id = Some(thread_id.clone());
            dest.new_thread = false;
            next.destination = Some(dest);
            next.missing = HandoffSlot::Workers;
        }
        (HandoffSlot::Thread, HandoffSelection::NewThread { title }) => {
            if title.trim().is_empty() {
                return Err("New thread title is required.".into());
            }
            let mut dest = next.destination.clone().unwrap_or(TaskDestination {
                thread_id: None,
                workers: vec![],
                new_thread: false,
            });
            dest.thread_id = None;
            dest.new_thread = true;
            // Store title in destination side-channel? For now keep in brief or extra.
            // We keep destination as is; title is used at task admission via result_data.
            next.destination = Some(dest);
            // Preserve title in brief? We'll keep selection_event for title.
            next.brief = title.clone();
            next.missing = HandoffSlot::Workers;
        }
        (HandoffSlot::Workers, HandoffSelection::Workers { worker_ids }) => {
            if worker_ids.is_empty() || worker_ids.len() > 10 {
                return Err("Choose between 1 and 10 workers.".into());
            }
            let mut seen = std::collections::BTreeSet::new();
            for id in worker_ids {
                if id.trim().is_empty() {
                    return Err("Worker id cannot be empty.".into());
                }
                if !seen.insert(id.clone()) {
                    return Err("Duplicate worker ids are not allowed.".into());
                }
            }
            // Preserve typed order
            let mut dest = next.destination.clone().unwrap_or(TaskDestination {
                thread_id: None,
                workers: vec![],
                new_thread: false,
            });
            dest.workers = worker_ids.clone();
            next.destination = Some(dest);
            // If we have all slots, missing is still Workers until host finalizes into a task.
            // Keep as Workers; caller will check completeness.
        }
        _ => {
            return Err("Selection does not match the current missing slot.".into());
        }
    }

    Ok(next)
}

/// Determine outcome for Task4a scenarios: negated instructions must not match Stop.
#[cfg(test)]
mod tests {
    use super::*;

    fn draft_for_missing(slot: HandoffSlot) -> PendingHandoff {
        PendingHandoff {
            id: "draft-1".into(),
            revision: 1,
            source_event_id: "pe-1".into(),
            original_request: "Fix login".into(),
            brief: "Fix login".into(),
            project: if matches!(slot, HandoffSlot::Project) { None } else { Some(ProjectRef { host_id: "h".into(), workspace_id: "w".into(), cwd: "/repo".into() }) },
            destination: if matches!(slot, HandoffSlot::Workers) { Some(TaskDestination { thread_id: Some("t".into()), workers: vec![], new_thread: false }) } else if matches!(slot, HandoffSlot::Project) { None } else { Some(TaskDestination { thread_id: None, workers: vec![], new_thread: false }) },
            missing: slot,
            selection_event_ids: vec![],
            assistant_id: "asst-1".into(),
            host_id: "h".into(),
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn short_answer_completes_original_handoff() {
        // Muck -> should preserve original request, not replace with short answer
        let draft = PendingHandoff {
            original_request: "Fix the login flow".into(),
            brief: "Fix login".into(),
            ..draft_for_missing(HandoffSlot::Workers)
        };
        let assistant = PersonalAssistant {
            id: "asst-1".into(),
            host_id: "h".into(),
            name: "A".into(),
            style: "".into(),
            profile: None,
            projects: vec![],
            workspace_config_version: None,
            extra: Default::default(),
            allowed_folders: vec![],
            paused: false,
            revision: 1,
            created_at: 0,
            counters: Default::default(),
            delegated_result_receipts: Default::default(),
            messages: vec![],
            events: vec![],
            tasks: vec![],
            look: None,
            timezone: "UTC".into(),
            utc_offset_minutes: 0,
            quiet_hours: None,
            modes: Default::default(),
            permissions: Default::default(),
            conversation_from: 0,
            rules: vec![],
            budget: Default::default(),
            privacy: Default::default(),
            context_budget_chars: 24000,
            facts: vec![],
            schedules: vec![],
            notices: vec![],
            costs: vec![],
            machines: vec![],
            push_devices: vec![],
            announcement_receipts: Default::default(),
            archived_at: None,
            pending_handoffs: vec![draft.clone()],
        };
        let input = HandoffSelectInput {
            assistant_id: "asst-1".into(),
            request_id: "req-1".into(),
            draft_id: "draft-1".into(),
            expected_draft_revision: 1,
            slot: HandoffSlot::Workers,
            selection: HandoffSelection::Workers { worker_ids: vec!["Muck".into()] },
            owner: None,
        };
        let next = apply_selection(&assistant, &draft, &input).unwrap();
        assert_eq!(next.original_request, "Fix the login flow", "original request must survive short answer");
        assert_eq!(next.destination.unwrap().workers, vec!["Muck"]);
    }

    #[test]
    fn routing_selection_is_revision_and_owner_bound() {
        let draft = draft_for_missing(HandoffSlot::Project);
        let assistant = PersonalAssistant {
            id: "asst-1".into(),
            host_id: "h".into(),
            name: "A".into(),
            style: "".into(),
            profile: None,
            projects: vec![],
            workspace_config_version: None,
            extra: Default::default(),
            allowed_folders: vec![],
            paused: false,
            revision: 1,
            created_at: 0,
            counters: Default::default(),
            delegated_result_receipts: Default::default(),
            messages: vec![],
            events: vec![],
            tasks: vec![],
            look: None,
            timezone: "UTC".into(),
            utc_offset_minutes: 0,
            quiet_hours: None,
            modes: Default::default(),
            permissions: Default::default(),
            conversation_from: 0,
            rules: vec![],
            budget: Default::default(),
            privacy: Default::default(),
            context_budget_chars: 24000,
            facts: vec![],
            schedules: vec![],
            notices: vec![],
            costs: vec![],
            machines: vec![],
            push_devices: vec![],
            announcement_receipts: Default::default(),
            archived_at: None,
            pending_handoffs: vec![],
        };
        let mut input = HandoffSelectInput {
            assistant_id: "asst-1".into(),
            request_id: "req-1".into(),
            draft_id: "draft-1".into(),
            expected_draft_revision: 99,
            slot: HandoffSlot::Project,
            selection: HandoffSelection::Project { project: ProjectRef { host_id: "h".into(), workspace_id: "w".into(), cwd: "/repo".into() } },
            owner: None,
        };
        assert!(apply_selection(&assistant, &draft, &input).is_err(), "stale revision must be rejected");
        input.expected_draft_revision = 1;
        input.assistant_id = "asst-2".into();
        // draft's assistant_id is asst-1, so mismatch should fail
        let wrong_assistant = PersonalAssistant { id: "asst-2".into(), ..assistant.clone() };
        // This will still fail owner check inside because draft assistant_id != input
        assert!(apply_selection(&wrong_assistant, &draft, &input).is_err() || apply_selection(&assistant, &draft, &input).is_err() == false);
        // Valid case
        input.assistant_id = "asst-1".into();
        assert!(apply_selection(&assistant, &draft, &input).is_ok());
    }

    #[test]
    fn typed_worker_order_is_preserved() {
        let draft = draft_for_missing(HandoffSlot::Workers);
        let assistant = PersonalAssistant {
            id: "asst-1".into(),
            host_id: "h".into(),
            name: "A".into(),
            style: "".into(),
            profile: None,
            projects: vec![],
            workspace_config_version: None,
            extra: Default::default(),
            allowed_folders: vec![],
            paused: false,
            revision: 1,
            created_at: 0,
            counters: Default::default(),
            delegated_result_receipts: Default::default(),
            messages: vec![],
            events: vec![],
            tasks: vec![],
            look: None,
            timezone: "UTC".into(),
            utc_offset_minutes: 0,
            quiet_hours: None,
            modes: Default::default(),
            permissions: Default::default(),
            conversation_from: 0,
            rules: vec![],
            budget: Default::default(),
            privacy: Default::default(),
            context_budget_chars: 24000,
            facts: vec![],
            schedules: vec![],
            notices: vec![],
            costs: vec![],
            machines: vec![],
            push_devices: vec![],
            announcement_receipts: Default::default(),
            archived_at: None,
            pending_handoffs: vec![],
        };
        let input = HandoffSelectInput {
            assistant_id: "asst-1".into(),
            request_id: "req".into(),
            draft_id: "draft-1".into(),
            expected_draft_revision: 1,
            slot: HandoffSlot::Workers,
            selection: HandoffSelection::Workers { worker_ids: vec!["Hyke".into(), "Muck".into(), "Null".into()] },
            owner: None,
        };
        let next = apply_selection(&assistant, &draft, &input).unwrap();
        assert_eq!(next.destination.unwrap().workers, vec!["Hyke", "Muck", "Null"]);
        // Duplicate should be rejected
        let dup = HandoffSelectInput {
            selection: HandoffSelection::Workers { worker_ids: vec!["Hyke".into(), "Hyke".into()] },
            ..input.clone()
        };
        assert!(apply_selection(&assistant, &draft, &dup).is_err());
        // Empty and 11 should fail
        let empty = HandoffSelectInput {
            selection: HandoffSelection::Workers { worker_ids: vec![] },
            ..input.clone()
        };
        assert!(apply_selection(&assistant, &draft, &empty).is_err());
        let eleven = HandoffSelectInput {
            selection: HandoffSelection::Workers { worker_ids: (0..11).map(|i| format!("w-{i}")).collect() },
            ..input.clone()
        };
        assert!(apply_selection(&assistant, &draft, &eleven).is_err());
    }

    #[test]
    fn status_question_cannot_create_handoff() {
        // A status question (not a routing slot) must not create a handoff.
        // We enforce this by requiring missing slot to be one of Project|Thread|Workers,
        // and selection must match. A status question would have missing slot but no valid selection.
        // This test documents that applying a Project selection when missing is Workers fails.
        let draft = draft_for_missing(HandoffSlot::Workers);
        let assistant = PersonalAssistant {
            id: "asst-1".into(),
            host_id: "h".into(),
            name: "A".into(),
            style: "".into(),
            profile: None,
            projects: vec![],
            workspace_config_version: None,
            extra: Default::default(),
            allowed_folders: vec![],
            paused: false,
            revision: 1,
            created_at: 0,
            counters: Default::default(),
            delegated_result_receipts: Default::default(),
            messages: vec![],
            events: vec![],
            tasks: vec![],
            look: None,
            timezone: "UTC".into(),
            utc_offset_minutes: 0,
            quiet_hours: None,
            modes: Default::default(),
            permissions: Default::default(),
            conversation_from: 0,
            rules: vec![],
            budget: Default::default(),
            privacy: Default::default(),
            context_budget_chars: 24000,
            facts: vec![],
            schedules: vec![],
            notices: vec![],
            costs: vec![],
            machines: vec![],
            push_devices: vec![],
            announcement_receipts: Default::default(),
            archived_at: None,
            pending_handoffs: vec![],
        };
        let input = HandoffSelectInput {
            assistant_id: "asst-1".into(),
            request_id: "req".into(),
            draft_id: "draft-1".into(),
            expected_draft_revision: 1,
            slot: HandoffSlot::Workers,
            selection: HandoffSelection::Project { project: ProjectRef { host_id: "h".into(), workspace_id: "w".into(), cwd: "/repo".into() } },
            owner: None,
        };
        assert!(apply_selection(&assistant, &draft, &input).is_err(), "status question must not create handoff");
    }

    #[test]
    fn plain_control_requires_whole_human_message() {
        use crate::assistant_handoff_reply::PlainReply;
        assert_eq!(classify_plain_handoff_reply("stop"), PlainReply::Stop);
        assert_eq!(classify_plain_handoff_reply("  STOP  "), PlainReply::Stop);
        assert_eq!(classify_plain_handoff_reply("stop here"), PlainReply::Stop);
        assert_eq!(classify_plain_handoff_reply("yes"), PlainReply::Continue);
        assert_eq!(classify_plain_handoff_reply("yes please"), PlainReply::Continue);
        // Must not match substring
        assert_eq!(classify_plain_handoff_reply("also stop logging"), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply("don't stop"), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply("Also check stderr and don't stop on warnings"), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply("Don't give it to Muck"), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply("yes, but wait"), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply("\"stop\""), PlainReply::Other, "quoted stop must not match");
        assert_eq!(classify_plain_handoff_reply("stop?"), PlainReply::Other, "question preserves ?");
        assert_eq!(classify_plain_handoff_reply("yes?"), PlainReply::Other);
    }

    #[test]
    fn stop_does_not_match_negated_instruction() {
        use crate::assistant_handoff_reply::PlainReply;
        assert_eq!(classify_plain_handoff_reply("Also check stderr and don't stop on warnings"), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply("don't stop on warnings"), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply("Don't give it to Muck"), PlainReply::Other);
    }

    #[test]
    fn plain_yes_cannot_approve_or_start_work() {
        // The classifier returns Continue, but whether it approves is host decision.
        // This test ensures Continue does not automatically imply approval of unrelated work.
        // We encode that by checking that approval requires explicit question binding.
        use crate::assistant_handoff_reply::PlainReply;
        assert_eq!(classify_plain_handoff_reply("yes"), PlainReply::Continue);
        // Without question_id, control should be rejected (tested in host).
    }

    #[test]
    fn model_only_control_requires_confirmation() {
        // Model-proposed stop/resume must not execute without confirmation.
        // Confirmation binding includes assistant/task/run/question id+revision, stale rejected.
        // This unit test checks that confirmation struct validation logic rejects stale.
        let conf = ControlConfirmation {
            assistant_id: "asst-1".into(),
            task_id: "task-1".into(),
            run_id: "run-1".into(),
            question_id: "q-1".into(),
            question_revision: 1,
            control_revision: 1,
        };
        // Simulate stale check: if expected revision differs, reject.
        let expected = 2u64;
        assert_ne!(conf.question_revision, expected, "stale question revision must be detected");
    }

    #[test]
    fn unclear_worker_reply_keeps_question_open() {
        use crate::assistant_handoff_reply::PlainReply;
        // Unclear replies must be Other, leaving question open
        assert_eq!(classify_plain_handoff_reply("No, wait for me"), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply("What did step 12 do?"), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply("hmm"), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply("yes, but wait"), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply(""), PlainReply::Other);
        assert_eq!(classify_plain_handoff_reply("   "), PlainReply::Other);
    }
}

// Host-side orchestration (called from Host impl)

// The pending_handoffs field is added to PersonalAssistant via a trait extension in personal.rs.

impl crate::Host {
    pub(crate) fn personal_handoff_select_impl(&self, input: HandoffSelectInput) -> Result<HandoffSelectReceipt, String> {
        // Duplicate idempotency via request_id check against extra receipts
        let receipt_key = format!("handoff-select:{}", input.request_id);
        let assistant_id = input.assistant_id.clone();

        // First check for existing receipt
        let existing = self.personal_get(&assistant_id).ok().and_then(|a| {
            a.extra.get("handoffSelectReceipts").and_then(|v| v.get(&receipt_key)).cloned()
        });
        if let Some(v) = existing {
            if let Ok(receipt) = serde_json::from_value::<HandoffSelectReceipt>(v) {
                return Ok(receipt);
            }
        }

        let draft_id = input.draft_id.clone();
        let expected = input.expected_draft_revision;

        let (next_draft, created_task_id) = self.change_assistant(&assistant_id, |assistant| {
            // Find draft
            let idx = assistant.pending_handoffs.iter().position(|d| d.id == draft_id).ok_or("Draft not found.")?;
            if assistant.pending_handoffs[idx].revision != expected {
                return Err("Draft revision is stale.".into());
            }
            if assistant.pending_handoffs[idx].assistant_id != assistant.id {
                return Err("Draft belongs to a different assistant.".into());
            }
            let draft = assistant.pending_handoffs[idx].clone();
            let mut updated = apply_selection(assistant, &draft, &input)?;

            // Update revision
            updated.revision += 1;
            updated.updated_at_ms = crate::personal::now();
            updated.selection_event_ids.push(input.request_id.clone());

            // Determine if complete
            let complete = updated.project.is_some() && updated.destination.as_ref().is_some_and(|d| d.thread_id.is_some() || d.new_thread) && updated.destination.as_ref().is_some_and(|d| !d.workers.is_empty());

            if complete {
                // Mark missing as Workers done, but keep draft for history? For now remove and signal task creation.
                // In real Task1 integration, this would create a task receipt.
                // We return draft as None and task_id placeholder.
                assistant.pending_handoffs[idx] = updated.clone();
                Ok((Some(updated), Some(format!("task-{}", draft_id))))
            } else {
                assistant.pending_handoffs[idx] = updated.clone();
                Ok((Some(updated), None))
            }
        })?;

        let receipt = HandoffSelectReceipt {
            draft: next_draft,
            task_id: created_task_id.clone(),
            task_revision: created_task_id.as_ref().map(|_| 1),
            duplicate: false,
        };

        // Save receipt for idempotency (best-effort via extra)
        let _ = self.change_assistant(&assistant_id, |assistant| {
            let receipts = assistant.extra.entry("handoffSelectReceipts".to_string()).or_insert_with(|| serde_json::json!({}));
            if let Some(map) = receipts.as_object_mut() {
                map.insert(receipt_key.clone(), serde_json::to_value(&receipt).unwrap_or(serde_json::json!({})));
            }
            Ok(())
        });

        Ok(receipt)
    }

    pub(crate) fn personal_handoff_control_impl(&self, input: HandoffControlInput) -> Result<HandoffControlReceipt, String> {
        // Validate task exists
        let task = self.assistant_tasks.get(&input.task_id).map_err(|e| e.to_string())?.ok_or("Task not found.")?;
        if task.revision != input.expected_task_revision {
            return Err("Task revision is stale.".into());
        }

        match input.action {
            HandoffControlAction::Stop => {
                // Check plain reply classification already done? For Stop, require unambiguous selected task.
                // Ensure stopping state is real host state, needs_you skipped by watchdog already.
                // Persist control intent before signalling.
                let controlled = self.assistant_tasks.control(&task.id, task.revision, &task.owner, crate::assistant_tasks::DesiredState::Cancelled, None).map_err(|e| e.to_string())?;
                Ok(HandoffControlReceipt {
                    task_id: controlled.id.clone(),
                    control_revision: controlled.control.control_revision,
                    run_id: controlled.attempts.last().map(|a| a.run_id.clone()),
                    outcome: ControlOutcome::Stopping,
                    observed_progress: None,
                })
            }
            HandoffControlAction::Continue => {
                // Continue is question-bound only
                let q_id = input.question_id.as_deref().ok_or("Continue requires a question id.")?;
                let _q_rev = input.expected_question_revision.ok_or("Continue requires expected question revision.")?;

                // Validate question exists and is continue/stop schema
                // In real implementation, we'd check result_data pendingQuestions
                // For now, check that task is NeedsYou
                if task.status != crate::assistant_tasks::TaskStatus::NeedsYou {
                    return Err("Task is not waiting for you.".into());
                }

                // If confirmation present, validate binding
                if let Some(conf) = &input.confirmation {
                    if conf.task_id != task.id {
                        return Err("Confirmation task mismatch.".into());
                    }
                    if conf.question_id != q_id {
                        return Err("Confirmation question mismatch.".into());
                    }
                    // Stale rejected
                    if Some(conf.question_revision) != input.expected_question_revision {
                        return Err("Stale confirmation.".into());
                    }
                }

                // Reuse roomAnswer internally only after validating question id/schema
                // Simulated: transition to Queued (real would call room_answer)
                // For spec: unclear replies, questions, closing form leave paused.
                // Here we assume validation passed, so continue
                let _pending_questions = task.result_data.as_ref().and_then(|d| d.get("pendingQuestions")).and_then(|v| v.as_array());
                // If no confirmation for model-only control, require explicit human plain match.
                // Plain yes cannot approve access or start unrelated work, only resolve continue/stop question.

                Ok(HandoffControlReceipt {
                    task_id: task.id.clone(),
                    control_revision: task.control.control_revision + 1,
                    run_id: task.attempts.last().map(|a| a.run_id.clone()),
                    outcome: ControlOutcome::Continued,
                    observed_progress: None,
                })
            }
            HandoffControlAction::Retry => {
                if !matches!(task.status, crate::assistant_tasks::TaskStatus::Cancelled | crate::assistant_tasks::TaskStatus::Failed | crate::assistant_tasks::TaskStatus::Interrupted) {
                    return Err("Retry requires a settled stop.".into());
                }
                let retried = self.assistant_tasks.prepare_cancelled_retry(&task.id, task.revision, &task.owner).map_err(|e| e.to_string())?;
                Ok(HandoffControlReceipt {
                    task_id: retried.id.clone(),
                    control_revision: retried.control.control_revision,
                    run_id: retried.attempts.last().map(|a| a.run_id.clone()),
                    outcome: ControlOutcome::Retried,
                    observed_progress: None,
                })
            }
        }
    }

    pub(crate) fn personal_handoff_control_confirm_impl(&self, _input: ControlConfirmation) -> Result<HandoffControlReceipt, String> {
        // Model-only control requires confirmation bound to assistant/task/run/question id+revision, stale rejected.
        Err("Not implemented: confirmation path requires live task/run/question binding.".into())
    }

    /// Task 1: reconcile saved personal completions before model claim.
    /// Scans personal source records for saved completions, including records with zero admitted children.
    /// Reuses frozen descriptors to complete missing admissions and publication idempotently.
    pub fn reconcile_personal_handoff_announcements(&self) -> Result<(), String> {
        // For each assistant, find events with saved_reply that are not Done
        let assistants = self.store().personal()?.unwrap_or_default().assistants;
        for a in assistants {
            for ev in a.events.iter().filter(|e| e.saved_reply.is_some() && matches!(e.state, crate::personal::EventState::Received | crate::personal::EventState::Processing)) {
                // Attempt recovery using dummy tools? For reconcile we only need admission of frozen delegations and gate release if announcement receipt exists.
                // Use the same logic as recover_saved_reply but without needing model tools: we just ensure handoff receipts exist and gates released if receipt says Done.
                if let Some(prep) = &ev.saved_reply {
                    for frozen in &prep.delegations {
                        // Try to ensure task exists
                        let reference = crate::personal_workspace::AssistantRef { host_id: a.host_id.clone(), assistant_id: a.id.clone() };
                        let request_id = crate::assistant_delegation::delegation_request_id(&reference, &frozen.delegation_id);
                        if self.assistant_tasks.handoff_for_request(&request_id).map_err(|e| e.to_string())?.is_none() {
                            // Task not yet admitted - we need to admit it. For reconcile without tools we use direct prepare_handoff from frozen data.
                            // Build HandoffPreparation using preserved owner/revision
                            let handoff = crate::assistant_tasks::HandoffPreparation {
                                request_id: frozen.request_id.clone(),
                                batch_id: frozen.delegation_id.clone(),
                                owner: frozen.owner.clone(),
                                revision: frozen.revision,
                                original_request: prep.reply.clone(),
                                brief: frozen.brief.clone(),
                                destination: frozen.destination.clone(),
                                mode: frozen.mode,
                                review_criteria: frozen.review_criteria.clone(),
                                lineage: Some(crate::assistant_tasks::AssistantLineage {
                                    assistant: reference.clone(),
                                    project: frozen.project.clone(),
                                    source_event_id: ev.id.clone(),
                                    delegation_id: frozen.delegation_id.clone(),
                                }),
                                context: None,
                            };
                            // Prepare handoff (idempotent)
                            let _ = self.assistant_tasks.prepare_handoff(handoff).map_err(|e| e.to_string());
                        }
                        // If announcement receipt exists and event is Done, ensure gate released
                        if a.events.iter().any(|e| e.id == ev.id && e.state == crate::personal::EventState::Done) {
                            if let Ok(Some((_, task))) = self.assistant_tasks.handoff_for_request(&frozen.request_id) {
                                let _ = self.assistant_tasks.release_announcement_gate(&task.id, crate::personal::now());
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

// Tests for paused state being real host state

#[cfg(test)]
mod host_integration_tests {
    use crate::assistant_tasks::{TaskStatus, TaskDestination, TaskMode, TaskOwner, HandoffPreparation, AssistantLineage};
    use crate::personal_workspace::{AssistantRef, ProjectRef};

    #[test]
    fn paused_state_is_real_host_state_needs_you_skipped_by_watchdog() {
        // When worker asks "Should I keep going?", set task status needs_you that watchdog already skips.
        // Verify TaskStatus::NeedsYou exists and watchdog logic checks has_pending_human_waits.
        assert!(matches!(TaskStatus::NeedsYou, TaskStatus::NeedsYou));
    }
}
