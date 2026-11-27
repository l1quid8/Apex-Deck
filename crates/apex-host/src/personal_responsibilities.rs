//! A responsibility is a human-authorized, time-bounded watch on an existing room.
//! The daemon reduces saved worker messages into progress and questions. A tick
//! has read authority only; a reply to a question goes through human admission.
use crate::{
    personal::{EventSource, EventState, PersonalAssistant},
    personal_worker::rooms::{can_auto_read_context, Target, READ},
    personal_workspace::ProjectRef,
    Host,
};
use apex_core::RoomSnapshot;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(crate) mod conversation;
mod reports;
pub use conversation::ResponsibilityDraft;

const CHECK_INTERVAL_MS: u64 = 60_000;
const MAX_LIVE: usize = 16;
const MAX_HISTORY: usize = 100;

/// Volatile due times suppress unrelated wakeups without saving the personal document
/// when nothing changed. Reopening a daemon falls back to the persisted checkpoints.
#[derive(Default)]
pub(crate) struct ResponsibilityClock {
    due: BTreeMap<(String, String), u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResponsibilityState {
    Watching,
    Paused,
    Cancelled,
    Finished,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DecisionStatus {
    Pending,
    Wait,
    Requested,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchDecision {
    pub message_id: String,
    pub worker_id: String,
    pub worker_name: String,
    pub evidence_seq: usize,
    pub status: DecisionStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ReportKind {
    Progress,
    Risk,
    Clear,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerReport {
    seq: usize,
    kind: ReportKind,
    excerpt: String,
    question_posted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchedWorker {
    name: String,
    report: Option<WorkerReport>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    open_risks: Vec<WorkerReport>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Responsibility {
    pub id: String,
    pub source_event_id: String,
    pub objective: String,
    pub thread_id: String,
    pub project: ProjectRef,
    pub until_ms: u64,
    pub timezone: String,
    pub state: ResponsibilityState,
    pub decision: Option<WatchDecision>,
    pub risk_only: bool,
    next_check_at: u64,
    next_origin_seq: usize,
    workers: BTreeMap<String, WatchedWorker>,
}

impl Responsibility {
    pub(crate) fn live(&self) -> bool {
        matches!(
            self.state,
            ResponsibilityState::Watching | ResponsibilityState::Paused
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsibilityView {
    pub id: String,
    pub thread_id: String,
    pub state: ResponsibilityState,
    pub decision: Option<WatchDecisionView>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchDecisionView {
    pub message_id: String,
    pub worker_name: String,
    pub status: DecisionStatus,
}

impl From<&Responsibility> for ResponsibilityView {
    fn from(watch: &Responsibility) -> Self {
        Self {
            id: watch.id.clone(),
            thread_id: watch.thread_id.clone(),
            state: watch.state,
            decision: watch.decision.as_ref().map(|d| WatchDecisionView {
                message_id: d.message_id.clone(),
                worker_name: d.worker_name.clone(),
                status: d.status,
            }),
        }
    }
}

impl Host {
    /// Called inside change_assistant, in the same transaction as the acknowledgment.
    pub(crate) fn start_responsibility(
        &self,
        a: &mut PersonalAssistant,
        event_id: &str,
        objective: &str,
        thread: &str,
        until_ms: u64,
        at: u64,
    ) -> Result<String, String> {
        let event = a
            .events
            .iter()
            .find(|e| e.id == event_id && e.state == EventState::Processing)
            .ok_or("The original human request is no longer active.")?;
        let EventSource::Human { text, .. } = &event.source else {
            return Err("A release watch needs your direct request.".into());
        };
        let source_id = if text == objective {
            event_id
        } else {
            let draft = a
                .responsibility_draft
                .as_ref()
                .filter(|d| d.objective == objective)
                .ok_or("The saved request has changed.")?;
            if !a.events.iter().any(|e| {
                e.id == draft.source_event_id
                    && matches!(&e.source,EventSource::Human{text,..} if text==objective)
            }) {
                return Err("The original watch request is unavailable.".into());
            }
            &draft.source_event_id
        };
        let id = format!("watch-{source_id}");
        if a.responsibilities.iter().any(|w| w.id == id) {
            return Ok(id);
        }
        if a.paused || a.archived_at.is_some() {
            return Err("Resume Alfred before starting a watch.".into());
        }
        if until_ms <= at {
            return Err("Choose a deadline in the future.".into());
        }
        let (target, snapshot) = self.watch_target(a, thread, objective)?;
        if target.workers.is_empty() {
            return Err("Add an agent to this thread before starting a watch.".into());
        }
        if a.responsibilities
            .iter()
            .any(|w| w.live() && w.thread_id == thread)
        {
            return Err(
                "I already have a watch on that thread. Ask me to change or stop it.".into(),
            );
        }
        if a.responsibilities.iter().filter(|w| w.live()).count() >= MAX_LIVE {
            return Err("Finish or stop an existing watch before adding another.".into());
        }
        // Start after the current transcript. Older briefs and examples are not new reports.
        let watch = Responsibility {
            id: id.clone(),
            source_event_id: source_id.to_owned(),
            objective: objective.to_owned(),
            thread_id: thread.to_owned(),
            project: target.project,
            until_ms,
            timezone: a.timezone.clone(),
            state: ResponsibilityState::Watching,
            decision: None,
            risk_only: true,
            next_check_at: at,
            next_origin_seq: next_seq(&snapshot),
            workers: target
                .workers
                .into_iter()
                .map(|(id, name)| {
                    (
                        id,
                        WatchedWorker {
                            name,
                            report: None,
                            open_risks: Vec::new(),
                        },
                    )
                })
                .collect(),
        };
        if a.responsibilities.len() >= MAX_HISTORY {
            if let Some(index) = a.responsibilities.iter().position(|old| !old.live()) {
                a.responsibilities.remove(index);
            }
        }
        a.responsibilities.push(watch);
        Ok(id)
    }

    fn watch_target(
        &self,
        a: &PersonalAssistant,
        thread: &str,
        objective: &str,
    ) -> Result<(Target, RoomSnapshot), String> {
        self.require_not_trashed(thread)?;
        let (target, snapshot) = self.personal_room_target_snapshot(a, thread)?;
        if target.project.host_id != a.host_id
            || !can_auto_read_context(a, &target, READ, objective)
        {
            return Err("Alfred needs permission to read this thread on its home machine.".into());
        }
        Ok((target, snapshot))
    }

    pub(crate) fn responsibility_target_allowed(
        &self,
        a: &PersonalAssistant,
        watch: &Responsibility,
    ) -> bool {
        self.watch_target(a, &watch.thread_id, &watch.objective)
            .is_ok_and(|(target, _)| target.project == watch.project)
    }

    /// A persisted worker reply wakes watches on its own room. The periodic
    /// check also covers restored snapshots and recovery without a live event.
    pub(crate) fn wake_responsibility_room(&self, thread: &str) {
        let mut clock = self
            .responsibility_clock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut changed = false;
        for ((_, room), due) in &mut clock.due {
            if room == thread {
                *due = 0;
                changed = true;
            }
        }
        if changed {
            self.personal_wake.notify_one();
        }
    }

    /// Called inside the personal clock's atomic document change. Checkpoint,
    /// pending decision and message are therefore recovered together after restart.
    pub(crate) fn tick_responsibilities(&self, a: &mut PersonalAssistant, at: u64) -> Option<u64> {
        let mut clock = self
            .responsibility_clock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        clock.due.retain(|(assistant, thread), _| {
            assistant != &a.id
                || (!a.paused
                    && a.responsibilities.iter().any(|w| {
                        &w.thread_id == thread && w.state == ResponsibilityState::Watching
                    }))
        });
        if a.paused || a.archived_at.is_some() {
            return None;
        }
        let mut next = None;
        let mut watches = std::mem::take(&mut a.responsibilities);
        for watch in &mut watches {
            if watch.state != ResponsibilityState::Watching {
                continue;
            }
            let key = (a.id.clone(), watch.thread_id.clone());
            let mut due = clock
                .due
                .get(&key)
                .copied()
                .unwrap_or(at.min(watch.next_check_at))
                .min(watch.until_ms);
            if at >= due {
                let checked = self
                    .watch_target(a, &watch.thread_id, &watch.objective)
                    .ok()
                    .filter(|(target, _)| target.project == watch.project);
                let Some((_, snapshot)) = checked else {
                    let text = if at >= watch.until_ms {
                        watch.state = ResponsibilityState::Finished;
                        "The watch reached its deadline. I couldn’t verify the final thread reports."
                    } else {
                        watch.state = ResponsibilityState::Paused;
                        "I paused the watch because I can no longer read its assigned thread. Review its access before resuming."
                    };
                    watch.decision = None;
                    a.post(
                        "assistant",
                        "update",
                        text.into(),
                        None,
                        Some(watch.source_event_id.clone()),
                        at,
                    );
                    clock.due.remove(&key);
                    continue;
                };
                // Only evidence produced within the watch period counts, including
                // reports already on disk when an overdue home wakes up.
                let changed = watch.collect_reports(&snapshot, at);
                if at >= watch.until_ms {
                    watch.finish(a, at);
                    clock.due.remove(&key);
                    continue;
                }
                watch.publish_updates(a, changed, at);
                due = at.saturating_add(CHECK_INTERVAL_MS).min(watch.until_ms);
                clock.due.insert(key, due);
            }
            next = Some(next.map_or(due, |old: u64| old.min(due)));
        }
        a.responsibilities = watches;
        next
    }
}

fn next_seq(snapshot: &RoomSnapshot) -> usize {
    snapshot.next_origin_seq.max(
        snapshot
            .transcript
            .iter()
            .map(|m| m.origin_seq.unwrap_or(m.seq).saturating_add(1))
            .max()
            .unwrap_or(0),
    )
}

#[cfg(test)]
mod tests;
