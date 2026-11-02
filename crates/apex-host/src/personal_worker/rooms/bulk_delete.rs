//! Exact native batches, with progress in the protected assistant document.
//! An in-flight entry is saved before touching a room. A restart may confirm
//! that room is gone; a still-present room has an uncertain outcome and is
//! never replayed automatically. The authority anchor is always deleted last.
use super::*;
use std::collections::HashSet;

const MAX_TARGETS: usize = 20;
const JOURNALS: &str = "roomDeleteMany";

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DeleteTarget { id: String, title: String }

fn validate_ids(anchor: &str, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() || ids.len() > MAX_TARGETS {
        return Err("Bulk permanent deletion needs 1 to 20 explicit thread IDs.".into());
    }
    let mut unique = HashSet::new();
    if ids.iter().any(|id| id.is_empty() || id.len() > 160 || id.chars().any(char::is_control) || !unique.insert(id)) {
        return Err("Bulk permanent deletion needs unique, valid thread IDs.".into());
    }
    if !ids.iter().any(|id| id == anchor) {
        return Err("The bulk deletion anchor must be included in the explicit target list.".into());
    }
    Ok(())
}

/// Execution accepts only the host's snapshot, never a model-supplied title.
pub(super) fn targets(argv: &[String]) -> Result<Vec<DeleteTarget>, String> {
    if argv.len() != 2 { return Err("Bulk permanent deletion needs an anchor and one explicit target list.".into()); }
    let targets: Vec<DeleteTarget> = serde_json::from_str(&argv[1]).map_err(|_| "Bulk permanent deletion needs a host-bound target snapshot.")?;
    validate_ids(&argv[0], &targets.iter().map(|target| target.id.clone()).collect::<Vec<_>>())?;
    Ok(targets)
}

pub(super) fn approval_prompt(op: &OperationSpec) -> Option<String> {
    if op.tool != DELETE_MANY { return None; }
    let targets = targets(&op.argv).ok()?;
    let names = targets.iter().map(|target| format!("{} ({})", serde_json::to_string(&target.title).unwrap_or_default(), target.id)).collect::<Vec<_>>().join("; ");
    Some(format!("Permanently delete these {} threads in one batch: {names}? This cannot be undone.", targets.len()))
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteJournal {
    params_hash: String,
    #[serde(rename = "completedIDs")]
    completed_ids: Vec<String>,
    in_flight: Option<String>,
}

impl DeleteJournal {
    fn check(&self, op: &OperationSpec, targets: &[DeleteTarget]) -> Result<(), String> {
        let mut unique = HashSet::new();
        if self.params_hash != op.hash()
            || self.completed_ids.iter().any(|id| !targets.iter().any(|target| &target.id == id) || !unique.insert(id))
            || self.in_flight.as_ref().is_some_and(|id| !targets.iter().any(|target| &target.id == id) || self.completed_ids.contains(id))
            || (self.completed_ids.contains(&op.argv[0]) && self.completed_ids.len() != targets.len()) {
            return Err("The durable bulk deletion journal does not match this exact batch. No remaining threads were deleted.".into());
        }
        Ok(())
    }

    fn result(&self, targets: &[DeleteTarget], why: Option<&str>) -> ToolRun {
        let remaining = targets.iter().filter(|target| !self.completed_ids.contains(&target.id)).map(|target| target.id.as_str()).collect::<Vec<_>>();
        let completed = if self.completed_ids.is_empty() { "none".into() } else { self.completed_ids.join(", ") };
        let rest = if remaining.is_empty() { "none".into() } else { remaining.join(", ") };
        ToolRun { exit_code: i32::from(why.is_some()), output: format!("{}\nCompleted IDs: {completed}\nRemaining IDs: {rest}", why.map(str::to_owned).unwrap_or_else(|| format!("Permanently deleted all {} selected threads.", targets.len()))) }
    }
}

impl Host {
    /// Resolve every explicit ID before proposal, so the hash and one approval
    /// card bind the complete server-derived set of IDs and display titles.
    pub(in crate::personal_worker) fn personal_normalize_bulk_delete(&self, assistant: &PersonalAssistant, proposed: &mut super::super::ProposedTask) -> Result<(), String> {
        if proposed.tool.as_deref() != Some(DELETE_MANY) { return Ok(()); }
        if proposed.argv.len() != 2 { return Err("Bulk permanent deletion needs an anchor and a JSON array of explicit thread IDs.".into()); }
        let ids: Vec<String> = serde_json::from_str(&proposed.argv[1]).map_err(|_| "Bulk permanent deletion needs a JSON array of explicit thread IDs, never a title query.")?;
        validate_ids(&proposed.argv[0], &ids)?;
        let reachable = self.personal_rooms(assistant)?;
        let anchor = reachable.iter().find(|room| room.thread == proposed.argv[0]).ok_or("That anchor isn't in a project this assistant can reach.")?;
        let mut bound = Vec::with_capacity(ids.len());
        for id in ids {
            let room = reachable.iter().find(|room| room.thread == id).ok_or_else(|| format!("Thread {id} isn't in a project this assistant can reach."))?;
            if room.project != anchor.project { return Err("Every bulk deletion target must belong to the anchor's same assigned project.".into()); }
            bound.push(DeleteTarget { id, title: room.title.clone() });
        }
        proposed.argv[1] = serde_json::to_string(&bound).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn save_bulk_delete_journal(&self, assistant_id: &str, key: &str, journal: &DeleteJournal) -> Result<(), String> {
        let value = serde_json::to_value(journal).map_err(|error| error.to_string())?;
        self.change_assistant(assistant_id, |assistant| {
            let journals = assistant.extra.entry(JOURNALS).or_insert_with(|| json!({})).as_object_mut().ok_or("The bulk deletion journal is invalid.")?;
            journals.insert(key.into(), value);
            Ok(())
        })
    }

    fn bulk_delete_check(&self, assistant_id: &str, task_id: &str, op: &OperationSpec, targets: &[DeleteTarget], completed: &[String]) -> Result<(), String> {
        self.personal_room_delivery_check(assistant_id, task_id, op)?;
        let assistant = self.personal_get(assistant_id)?;
        let anchor = self.personal_room_target(&assistant, &op.argv[0])?;
        // Validate the whole remaining set before each destructive step. A
        // target moving projects cannot turn an approved batch into a sweep.
        for target in targets.iter().filter(|target| !completed.contains(&target.id)) {
            let room = self.personal_room_target(&assistant, &target.id)?;
            if room.project != anchor.project || room.project.host_id != op.host || room.project.cwd != op.cwd {
                return Err(format!("Thread {} moved outside the approved project.", target.id));
            }
        }
        Ok(())
    }

    pub(super) async fn personal_bulk_delete(self: &Arc<Self>, assistant_id: &str, task_id: &str, op: &OperationSpec) -> Result<ToolRun, String> {
        let targets = targets(&op.argv)?;
        let key = format!("{task_id}:{}", op.hash());
        let assistant = self.personal_get(assistant_id)?;
        let mut journal = match assistant.extra.get(JOURNALS).and_then(|value| value.get(&key)) {
            Some(value) => serde_json::from_value::<DeleteJournal>(value.clone()).map_err(|_| "The bulk deletion journal is invalid; no remaining threads were deleted.")?,
            None => DeleteJournal { params_hash: op.hash(), completed_ids: vec![], in_flight: None },
        };
        journal.check(op, &targets)?;
        if let Some(id) = journal.in_flight.clone() {
            // Native deletion removes authority before deleting room files.
            // A cleanup error can leave a raw room with no readable manifest;
            // only physical absence confirms that deletion happened.
            let present = match self.store().room_ids() {
                Ok(ids) => ids.contains(&id),
                Err(why) => return Ok(journal.result(&targets, Some(&format!("Stopped: the in-flight deletion outcome is uncertain because saved rooms could not be checked: {why}")))),
            };
            if present {
                return Ok(journal.result(&targets, Some("Stopped: the in-flight deletion outcome is uncertain. No remaining threads were retried.")));
            }
            journal.completed_ids.push(id);
            journal.in_flight = None;
            self.save_bulk_delete_journal(assistant_id, &key, &journal)?;
        }
        if journal.completed_ids.len() == targets.len() { return Ok(journal.result(&targets, None)); }
        if let Err(why) = self.bulk_delete_check(assistant_id, task_id, op, &targets, &journal.completed_ids) {
            return Ok(journal.result(&targets, Some(&format!("Stopped before deleting any remaining thread: {why}"))));
        }
        let mut order: Vec<_> = targets.iter().filter(|target| target.id != op.argv[0]).collect();
        order.push(targets.iter().find(|target| target.id == op.argv[0]).expect("validated anchor"));
        for target in order {
            if journal.completed_ids.contains(&target.id) { continue; }
            if let Err(why) = self.bulk_delete_check(assistant_id, task_id, op, &targets, &journal.completed_ids) {
                return Ok(journal.result(&targets, Some(&format!("Stopped before deleting any remaining thread: {why}"))));
            }
            journal.in_flight = Some(target.id.clone());
            if let Err(why) = self.save_bulk_delete_journal(assistant_id, &key, &journal) {
                return Ok(journal.result(&targets, Some(&format!("Stopped before deletion because progress could not be saved: {why}"))));
            }
            let check = || {
                let guard = crate::personal::authority_guard();
                self.bulk_delete_check(assistant_id, task_id, op, &targets, &journal.completed_ids)?;
                Ok(Some(guard))
            };
            let result = self.room_delete_owned_checked(target.id.clone(), &check).await;
            // A deletion may have removed the room before later cleanup failed.
            // Record only the observed absence, and preserve an uncertain
            // marker if it still exists rather than attempting it twice.
            let present = match self.store().room_ids() {
                Ok(ids) => ids.contains(&target.id),
                Err(why) => return Ok(journal.result(&targets, Some(&format!("Stopped: the deletion outcome is uncertain because saved rooms could not be checked: {why}")))),
            };
            if !present {
                journal.completed_ids.push(target.id.clone());
                journal.in_flight = None;
                if let Err(why) = self.save_bulk_delete_journal(assistant_id, &key, &journal) {
                    return Ok(journal.result(&targets, Some(&format!("Stopped after deletion because progress could not be saved: {why}"))));
                }
            }
            if let Err(why) = result {
                return Ok(journal.result(&targets, Some(&format!("Bulk deletion stopped: {why}"))));
            }
            if journal.in_flight.is_some() {
                return Ok(journal.result(&targets, Some("Bulk deletion stopped: the selected room still exists; its outcome is uncertain.")));
            }
        }
        Ok(journal.result(&targets, None))
    }
}
