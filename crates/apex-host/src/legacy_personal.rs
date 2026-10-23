//! Pre-provenance personal assistants mapped for an explicit, UI-confirmed
//! import (docs/security/provenance-boundary.md, "Legacy data", step 5).
//!
//! Kept: identity (name, look, profile, style, folder), memories with their
//! correction and forget chains, standing rules (they only ever make the
//! assistant more careful), conversation, events and costs as history.
//! Never granted: remembered approvals (Auto modes, unknown-cost OK), machine
//! links and full project access are left ungranted and listed for
//! re-authorization; open or approved decisions on unfinished work are reopened
//! for a fresh decision; schedules wait for confirmation again; unfinished
//! events are never processed. Memories lose the "you said it" label.
//! Machine grants (`personal-machine.json`) are previewed, never imported.
use serde_json::json;

use crate::legacy_import::{title, LegacyMarker, Problem, Row};
use crate::personal::{
    ActionMode, ActionModes, DecisionKind, DecisionStatus, EventState, OpPhase, PendingDecision, PersonalAssistant, PersonalDocument, ScheduleStatus,
    TaskStatus, ToolClass,
};
use crate::personal_settings::MachineAllows;
use crate::personal_workspace::ProjectTools;

pub(crate) struct LegacyPersonalPlan {
    pub rows: Vec<Row>,
    pub problems: Vec<Problem>,
    pub(crate) assistants: Vec<PersonalAssistant>,
}

impl LegacyPersonalPlan {
    pub fn importable(&self) -> usize {
        self.assistants.len()
    }
}

fn name<T: serde::Serialize>(value: T) -> String {
    serde_json::to_value(value).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

fn row(id: String, kind: &'static str, text: &str, original: impl Into<String>, imported: impl Into<String>, reason: impl Into<String>) -> Row {
    Row { id, kind, title: title(text), original_status: original.into(), import_status: imported.into(), reason: reason.into() }
}

fn set_mode(modes: &mut ActionModes, class: ToolClass, mode: ActionMode) {
    match class {
        ToolClass::Read => modes.read = mode,
        ToolClass::Write => modes.write = mode,
        ToolClass::Send => modes.send = mode,
        ToolClass::Spend => modes.spend = mode,
    }
}

const REOPENED: &str = "Imported from before protected provenance. Nothing runs until you approve it again.";
const BLOCKED: &str = "Imported from before protected provenance. Ask again to run it.";

pub(crate) fn plan_legacy_personal(bytes: &[u8], source_sha256: &str, now: u64) -> Result<LegacyPersonalPlan, String> {
    let legacy: PersonalDocument = serde_json::from_slice(bytes).map_err(|e| format!("The legacy personal assistants could not be read: {e}"))?;
    if legacy.version > 1 {
        return Err("The legacy personal assistants file has an unsupported version.".into());
    }
    let mut plan = LegacyPersonalPlan { rows: vec![], problems: vec![], assistants: vec![] };
    for original in legacy.assistants {
        let mut a = original.clone();
        let at = |id: &str| format!("{}/{id}", original.id);
        plan.rows.push(row(original.id.clone(), "assistant", &original.name, if original.paused { "paused" } else { "active" }, "imported",
            "Name, look, profile, memories and history are kept as unverified legacy records. Standing approvals are not carried over."));

        // Remembered approvals: no class runs without asking unless a new assistant's default allows it.
        let defaults = ActionModes::default();
        for (class, label) in [(ToolClass::Read, "read"), (ToolClass::Write, "write"), (ToolClass::Send, "send"), (ToolClass::Spend, "spend")] {
            let (old, new) = (original.modes.get(class), original.modes.get(class).max(defaults.get(class)));
            if new != old {
                set_mode(&mut a.modes, class, new);
                plan.rows.push(row(at(&format!("mode:{label}")), "approval", &format!("{label} actions"), name(old), name(new), "Remembered approval left ungranted; it asks again. Change it in settings to allow it again."));
            }
        }
        if original.budget.unknown_cost_ok {
            a.budget.unknown_cost_ok = false;
            plan.rows.push(row(at("budget:unknown-cost"), "approval", "Replies whose cost isn't reported", "allowed", "asks", "Remembered approval left ungranted; it asks again."));
        }
        for machine in &original.machines {
            plan.rows.push(row(at(&format!("machine:{}", machine.host_id)), "grant", &format!("{} ({})", machine.name, machine.folder), "linked", "notImported", "Link the machine again to let the assistant run there."));
        }
        a.machines.clear();
        for binding in &mut a.projects {
            if binding.tools == ProjectTools::Full {
                binding.tools = ProjectTools::Ask;
                plan.rows.push(row(at(&format!("project:{}", binding.project.cwd)), "grant", &binding.project.cwd, "full", "ask", "Full project access left ungranted; it asks first until you allow it again."));
            }
        }
        if !a.push_devices.is_empty() {
            plan.problems.push(Problem { id: at("push-devices"), reason: "Phones registered for its notices were not imported; they register again when they connect.".into() });
            a.push_devices.clear();
        }
        for rule in &original.rules {
            plan.rows.push(row(at(&rule.id), "rule", &rule.text, name(rule.mode), "kept", "Standing rules only make the assistant more careful, so it stays in force. Remove it in settings if it no longer applies."));
        }

        // Memories: kept with their chains, never labelled as something you said.
        for fact in &mut a.facts {
            let status = if fact.deleted_at.is_some() { "forgotten" } else if fact.superseded_by.is_some() { "corrected" } else if fact.explicit { "explicit" } else { "inferred" };
            let reason = match status {
                "forgotten" => "Kept forgotten.",
                "corrected" => "Kept as the earlier version in its correction history.",
                _ => "Kept as an unverified memory; never shown as something you confirmed.",
            };
            plan.rows.push(row(at(&fact.id), "memory", &fact.text, status, "legacy", reason));
            fact.legacy = Some(LegacyMarker::new(source_sha256, now, Some(fact.id.clone()), Some(status.into())));
            fact.explicit = false;
        }

        // Schedules wait for a fresh confirmation.
        let mut new_decisions = vec![];
        for schedule in &mut a.schedules {
            let original_status = name(schedule.status);
            if schedule.status != ScheduleStatus::Cancelled {
                schedule.status = ScheduleStatus::Proposed;
                schedule.next_at = None;
                match schedule.decision.as_mut() {
                    Some(decision) => {
                        decision.status = DecisionStatus::Open;
                        decision.params_hash = schedule.params_hash.clone();
                        decision.decided_at = None;
                        decision.decided_by_event = None;
                    }
                    None => new_decisions.push(schedule.id.clone()),
                }
            }
            plan.rows.push(row(at(&schedule.id), "schedule", &schedule.goal, original_status, name(schedule.status), if schedule.status == ScheduleStatus::Cancelled { "Kept as history." } else { "Paused: confirm it again before it runs." }));
        }
        for id in new_decisions {
            let decision_id = a.next_decision_id();
            if let Some(schedule) = a.schedules.iter_mut().find(|s| s.id == id) {
                schedule.decision = Some(PendingDecision { id: decision_id, kind: DecisionKind::Schedule, params_hash: schedule.params_hash.clone(),
                    prompt: format!("Confirm the schedule: {}", schedule.goal), status: DecisionStatus::Open, opened_at: now, decided_at: None, decided_by_event: None });
            }
        }

        // Unfinished work never runs on its own: a bound operation is reopened for approval, anything else is blocked.
        for task in &mut a.tasks {
            if task.status.settled() {
                plan.rows.push(row(at(&task.id), "personalTask", &task.goal, name(task.status), name(task.status), "Kept as history."));
                continue;
            }
            let original_status = name(task.status);
            for receipt in &mut task.receipts {
                if receipt.phase == OpPhase::Attempted {
                    receipt.phase = OpPhase::Uncertain;
                    receipt.note.get_or_insert_with(|| "It may or may not have finished before the upgrade.".into());
                }
            }
            task.wait = None;
            task.updated_at = now;
            let hash = task.operation.as_ref().map(|op| op.hash());
            let decision_status = task.decision.as_ref().map(|d| name(d.status));
            match (hash, task.decision.as_mut()) {
                (Some(hash), Some(decision)) => {
                    decision.status = DecisionStatus::Open;
                    decision.params_hash = hash;
                    decision.decided_at = None;
                    decision.decided_by_event = None;
                    task.status = TaskStatus::NeedsYou;
                    task.last_update = Some(REOPENED.into());
                }
                (_, decision) => {
                    if let Some(decision) = decision { decision.status = DecisionStatus::Superseded; }
                    task.status = TaskStatus::Blocked;
                    task.last_update = Some(BLOCKED.into());
                }
            }
            let reason = if task.status == TaskStatus::NeedsYou { REOPENED } else { BLOCKED };
            plan.rows.push(row(at(&task.id), "personalTask", &task.goal, original_status, name(task.status), reason));
            if let (Some(before), Some(after)) = (decision_status, task.decision.as_ref()) {
                plan.rows.push(row(at(&after.id), "approval", &after.prompt, before, name(after.status), "Not granted: an approval from before the upgrade never runs anything."));
            }
        }

        // History is kept; nothing unfinished in it is processed.
        let mut stopped = 0;
        for event in &mut a.events {
            if !matches!(event.state, EventState::Done | EventState::Failed) {
                event.state = EventState::Failed;
                event.error = Some("Imported from before protected provenance; not processed.".into());
                stopped += 1;
            }
            event.spend_approved = false;
        }
        for notice in &mut a.notices {
            notice.delivered_at.get_or_insert(now);
        }
        plan.rows.push(row(at("history"), "history", &format!("{} messages, {} events", a.messages.len(), a.events.len()), "saved", "legacy",
            if stopped > 0 { format!("Kept as unverified history; {stopped} unfinished request(s) will not be processed.") } else { "Kept as unverified history.".into() }));

        let marker = LegacyMarker::new(source_sha256, now, Some(original.id.clone()), Some(if original.paused { "paused" } else { "active" }.into()));
        let mut legacy = serde_json::to_value(&marker).unwrap_or_default();
        legacy["originalModes"] = json!(original.modes);
        legacy["originalUnknownCostOk"] = json!(original.budget.unknown_cost_ok);
        legacy["originalMachines"] = json!(original.machines);
        legacy["originalProjects"] = json!(original.projects);
        legacy["historyThroughMessage"] = json!(original.messages.last().map(|m| m.id.clone()));
        a.extra.insert("legacy".into(), legacy);
        a.revision = original.revision.saturating_add(1);
        plan.assistants.push(a);
    }
    Ok(plan)
}

/// One row per machine grant. They are never imported as active grants.
pub(crate) fn machine_rows(bytes: &[u8]) -> Result<Vec<Row>, String> {
    let allows: MachineAllows = serde_json::from_slice(bytes).map_err(|e| format!("The legacy machine grants could not be read: {e}"))?;
    Ok(allows.allows.iter().map(|allow| row(format!("{}/{}", allow.assistant_host_id, allow.assistant_id), "grant", &allow.folder, "allowed", "notImported",
        "Re-approve on this machine: grants from before the upgrade are never imported.")).collect())
}
