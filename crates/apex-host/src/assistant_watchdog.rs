//! Watches every delegated job so the human doesn't have to. A job with no
//! worker activity gets one restart in its own chat; if it goes quiet again
//! the human is told. This costs no model call: it only reads room activity.
//!
//! A restart goes through the ordinary "continue" action, so paused
//! assistants, spending limits and project access all still apply.

use std::sync::{atomic::Ordering, Arc};

use serde_json::json;

use crate::assistant_service::{append_history, AssistantActionInput, AssistantRun};
use crate::assistant_tasks::{AssistantTask, DesiredState, TaskStatus};

const MINUTE_MS: u64 = 60_000;
/// How long a worker may say nothing before it counts as stuck.
const QUIET_MS: u64 = 20 * MINUTE_MS;
/// A command that is still running reports nothing until it ends, so a long
/// build gets longer. A command that has truly hung is still caught.
const QUIET_COMMAND_MS: u64 = 60 * MINUTE_MS;
const SETTLE_SECONDS: u64 = 30;
/// The clock runs about once a minute, so a longer gap means the machine slept.
const ASLEEP_GAP_MS: u64 = 5 * MINUTE_MS;

/// Marks the attempt the watchdog stopped, so its receipt isn't a false alarm.
pub(crate) const RESTARTED_RESULT: &str = "The watchdog stopped this attempt after it went quiet, and is restarting it once.";
pub(crate) const RESTARTED_LABEL: &str = "Restarting a stuck job";
const NUDGE: &str = "Deck's watchdog stopped your last attempt because nothing happened for a long time. Check how far the work got, then continue the original task. If a command hung, don't run it the same way again. If you are blocked, say what you need.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict { Fine, Restart, Tell }

fn judge(quiet_ms: u64, command_running: bool, restarted: bool, told: bool) -> Verdict {
    if quiet_ms < if command_running { QUIET_COMMAND_MS } else { QUIET_MS } { return Verdict::Fine }
    if !restarted { return Verdict::Restart }
    if told { Verdict::Fine } else { Verdict::Tell }
}

/// Time asleep is not time a worker wasted: no process ran, so the wall clock
/// must not count against it. Quiet time starts over when the machine wakes.
pub(crate) struct WatchClock { last_pass: u64, awake_since: u64 }

impl WatchClock {
    pub(crate) fn new(at: u64) -> Self { Self { last_pass: at, awake_since: at } }

    pub(crate) fn pass(&mut self, at: u64) -> u64 {
        if at.saturating_sub(self.last_pass) > ASLEEP_GAP_MS { self.awake_since = at; }
        self.last_pass = at;
        self.awake_since
    }
}

impl crate::host::Host {
    /// One pass over the delegated jobs, run on the personal assistant's clock.
    pub(crate) fn watch_delegated_work(self: &Arc<Self>, at: u64, awake_since: u64) -> Result<(), String> {
        for task in self.assistant_tasks.list(None).map_err(|e| e.to_string())? {
            if task.status != TaskStatus::Running || task.lineage.is_none() || task.control.desired_state != DesiredState::Running { continue }
            let Some(attempt) = task.attempts.last().filter(|attempt| attempt.finished_at_ms.is_none()) else { continue };
            let Some(run) = self.assistant_runs.lock().unwrap().get(&task.id).cloned() else { continue };
            if run.stop.load(Ordering::SeqCst) { continue }
            let Some(handle) = task.execution_thread_id.as_deref().and_then(|room| self.handle(room).ok()) else { continue };
            // A live run in an idle room is saving its result. Stopping can't
            // interrupt that and a restart would add a second writer, so it is
            // only ever reported.
            let saving = !handle.runtime.busy();
            if !saving && handle.has_pending_human_waits() { continue }
            let (last_activity, command_running) = handle.worker_activity();
            let quiet_ms = at.saturating_sub(last_activity.max(attempt.started_at_ms).max(awake_since));
            let watchdog = task.result_data.as_ref().map(|data| &data["watchdog"]);
            let restarted = watchdog.is_some_and(|saved| saved["restarted"] == true);
            let told = watchdog.is_some_and(|saved| saved["toldRun"].as_str() == Some(attempt.run_id.as_str()));
            let verdict = judge(quiet_ms, command_running && !saving, restarted || saving, told);
            if verdict == Verdict::Fine || self.owner_paused(&task) { continue }
            let run_id = attempt.run_id.clone();
            let result = match verdict {
                Verdict::Restart => self.restart_stuck(task, run, handle),
                _ => self.tell_stuck(&task, &run_id, saving, quiet_ms, at),
            };
            if let Err(error) = result { eprintln!("Delegated work watchdog: {error}"); }
        }
        Ok(())
    }

    fn owner_paused(&self, task: &AssistantTask) -> bool {
        let Some(lineage) = &task.lineage else { return false };
        self.store().personal().ok().flatten().is_none_or(|document| {
            document.assistants.iter().find(|a| a.id == lineage.assistant.assistant_id && a.host_id == lineage.assistant.host_id).is_none_or(|a| a.paused)
        })
    }

    /// The restart is saved before the worker is stopped, so no crash or
    /// restart of the service can earn a second one.
    fn restart_stuck(self: &Arc<Self>, task: AssistantTask, run: Arc<AssistantRun>, handle: crate::host::RoomHandle) -> Result<(), String> {
        let mut data = task.result_data.clone().unwrap_or_else(|| json!({}));
        data["watchdog"]["restarted"] = json!(true);
        append_history(&mut data, "watchdog", "Went quiet, so the watchdog restarted it.");
        self.assistant_tasks.set_result_data(&task.id, task.revision, &task.owner, Some(data)).map_err(|e| e.to_string())?;
        run.watchdog_stop.store(true, Ordering::SeqCst);
        run.stop.store(true, Ordering::SeqCst);
        run.stop_tx.send_replace(true);
        handle.runtime.stop(None);
        let host = Arc::clone(self);
        self.runtime().spawn(async move {
            if let Err(error) = host.continue_after_stop(&task, &run).await {
                let text = format!("Your delegated job is stuck and I could not restart it: {}. {error}", task.brief.chars().take(140).collect::<String>());
                if let Err(error) = host.tell_human(&task, &format!("watchdog:{}:restart", task.id), text, crate::personal::now()) { eprintln!("Delegated work watchdog: {error}"); }
            }
        });
        Ok(())
    }

    async fn continue_after_stop(self: &Arc<Self>, task: &AssistantTask, run: &AssistantRun) -> Result<(), String> {
        let notified = run.done.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !run.finished.load(Ordering::SeqCst) {
            tokio::time::timeout(std::time::Duration::from_secs(SETTLE_SECONDS), notified).await.map_err(|_| "The worker did not stop.".to_string())?;
        }
        let latest = self.assistant_tasks.get(&task.id).map_err(|e| e.to_string())?.ok_or("The task is gone.")?;
        // The human may have stepped in while the worker was stopping.
        if latest.control.desired_state != DesiredState::Running || latest.status == TaskStatus::Running { return Ok(()) }
        if latest.status != TaskStatus::Interrupted { return Err(run.error.lock().unwrap().clone().unwrap_or_else(|| "The stopped attempt could not be continued.".into())) }
        self.assistant_task_action(AssistantActionInput { task_id: latest.id, revision: latest.revision, owner: latest.owner, action: "continue".into(), mode: None, text: Some(NUDGE.into()), destination: None, new_worker_profiles: vec![], checks: None, spend_limit_micros: None }).await.map(|_| ())
    }

    /// The attempt is left running: it has already had its restart, or is past
    /// the point a restart can help, and a slow worker that comes back keeps its
    /// work. Cancelling is the human's call.
    fn tell_stuck(&self, task: &AssistantTask, run_id: &str, saving: bool, quiet_ms: u64, at: u64) -> Result<(), String> {
        let brief: String = task.brief.chars().take(140).collect();
        let minutes = quiet_ms / MINUTE_MS;
        let text = if saving {
            format!("Your delegated job is stuck saving its result: {brief}. Nothing has happened for {minutes} minutes. Restarting it isn't safe while that step runs, so I left it alone and its checkout stays reserved.")
        } else {
            format!("Still stuck after a restart: {brief}. Nothing has happened for {minutes} minutes. I left it running, so open the task to cancel or retry it.")
        };
        self.tell_human(task, &format!("watchdog:{}:{run_id}", task.id), text, at)?;
        // Worker usage may have moved the task on since this pass read it.
        let latest = self.assistant_tasks.get(&task.id).map_err(|e| e.to_string())?.ok_or("The task is gone.")?;
        let mut data = latest.result_data.clone().unwrap_or_else(|| json!({}));
        data["watchdog"]["toldRun"] = json!(run_id);
        append_history(&mut data, "watchdog", if saving { "Stuck saving its result, so the watchdog told you." } else { "Still stuck after the restart, so the watchdog told you." });
        self.assistant_tasks.set_result_data(&latest.id, latest.revision, &latest.owner, Some(data)).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// A notice alone can be swallowed when the human is on screen, so the
    /// conversation carries the words and the notice carries the phone push.
    fn tell_human(&self, task: &AssistantTask, fingerprint: &str, text: String, at: u64) -> Result<(), String> {
        let lineage = task.lineage.as_ref().ok_or("This job has no owning assistant.")?;
        self.change_assistant(&lineage.assistant.assistant_id, |assistant| {
            if crate::personal_worker::notify::notify(assistant, text.clone(), Some(task.id.clone()), true, fingerprint.to_owned(), at) {
                assistant.post("assistant", "result", text, Some(task.id.clone()), Some(lineage.source_event_id.clone()), at);
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_time_decides_when_a_job_counts_as_stuck() {
        assert_eq!(judge(QUIET_MS - 1, false, false, false), Verdict::Fine);
        assert_eq!(judge(QUIET_MS, false, false, false), Verdict::Restart);
        assert_eq!(judge(QUIET_MS, true, false, false), Verdict::Fine);
        assert_eq!(judge(QUIET_COMMAND_MS, true, false, false), Verdict::Restart);
    }

    #[test]
    fn a_job_gets_one_restart_then_one_message() {
        assert_eq!(judge(QUIET_MS, false, true, false), Verdict::Tell);
        assert_eq!(judge(QUIET_MS, false, true, true), Verdict::Fine);
    }

    #[test]
    fn a_long_gap_between_passes_restarts_the_quiet_time() {
        let mut clock = WatchClock::new(0);
        assert_eq!(clock.pass(ASLEEP_GAP_MS), 0);
        assert_eq!(clock.pass(ASLEEP_GAP_MS + MINUTE_MS), 0);
        let woke = 3 * ASLEEP_GAP_MS;
        assert_eq!(clock.pass(woke), woke);
        assert_eq!(clock.pass(woke + MINUTE_MS), woke);
    }
}
