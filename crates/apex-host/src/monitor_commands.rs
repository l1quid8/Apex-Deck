//! The ApexAgent writes: assign, message, pause, check now and resolve.
//! Each is one locked read, change and save of `monitor.json`, and each
//! answers with the monitor as it now is.

use std::sync::Mutex;

use apex_core::ParticipantConfig;

use crate::host::Host;
use crate::monitor::{MonitorDocument, ProjectMonitor};
use crate::monitor_evidence;

const MAX_TEXT_BYTES: usize = 20 * 1024;
const MAX_THREADS: usize = 16;
const MAX_FILES: usize = 32;
const MAX_SUGGESTED_FILES: usize = 32;
const MAX_DIRECTORY_ENTRIES: usize = 512;
const MAX_INSPECTED_ENTRIES: usize = 2_048;

/// One change to `monitor.json` at a time. Never held across a model call or
/// a git command.
static MONITORS: Mutex<()> = Mutex::new(());

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn text(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Say what ApexAgent should do.".into());
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err("That message is too long for ApexAgent.".into());
    }
    Ok(text.to_owned())
}

pub struct Assignment {
    pub workspace_id: String,
    pub cwd: String,
    pub host_id: String,
    pub text: String,
    pub files: Vec<String>,
    pub threads: Vec<String>,
    pub profile: ParticipantConfig,
}

#[derive(Clone, Debug)]
pub(crate) struct MonitorOwner {
    pub cwd: String,
    pub host_id: String,
    pub conversation_id: String,
}

impl MonitorOwner {
    pub(crate) fn optional(cwd: Option<String>, host_id: Option<String>, conversation_id: Option<String>) -> Result<Option<Self>, String> {
        match (cwd, host_id, conversation_id) {
            (None, None, None) => Ok(None),
            (Some(cwd), Some(host_id), Some(conversation_id)) => Ok(Some(Self { cwd, host_id, conversation_id })),
            _ => Err("ApexAgent owner guard needs cwd, hostId, and conversationId together.".into()),
        }
    }
}

impl Host {
    /// Read, change and save the monitors under the one lock. `change` gets
    /// the whole list so it can add a monitor as well as edit one.
    pub(crate) fn change_monitors<T>(&self, change: impl FnOnce(&mut Vec<ProjectMonitor>) -> Result<T, String>) -> Result<T, String> {
        let _held = MONITORS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut document = self.store().monitors()?.unwrap_or_default();
        let out = change(&mut document.monitors)?;
        self.store().save_monitors(&MonitorDocument { version: document.version.max(1), monitors: document.monitors })?;
        self.monitor_wake.notify_one();
        Ok(out)
    }

    pub(crate) fn change_monitor(&self, workspace_id: &str, change: impl FnOnce(&mut ProjectMonitor, u64) -> Result<(), String>) -> Result<ProjectMonitor, String> {
        self.change_monitor_owned(workspace_id, None, change)
    }

    pub(crate) fn change_monitor_owned(&self, workspace_id: &str, owner: Option<MonitorOwner>, change: impl FnOnce(&mut ProjectMonitor, u64) -> Result<(), String>) -> Result<ProjectMonitor, String> {
        self.change_monitors(|monitors| {
            let monitor = monitors
                .iter_mut()
                .find(|m| m.workspace_id == workspace_id && owner.as_ref().is_none_or(|owner| {
                    m.cwd == owner.cwd && m.host_id == owner.host_id && m.conversation_id == owner.conversation_id
                }))
                .ok_or_else(|| "ApexAgent isn't set up for this project yet.".to_string())?;
            change(monitor, now())?;
            Ok(monitor.clone())
        })
    }

    /// Give ApexAgent a responsibility for one project, replacing any it had.
    /// The folder, files and threads are checked here, on the machine that
    /// owns them, before anything is saved.
    pub fn monitor_assign(&self, assignment: Assignment) -> Result<ProjectMonitor, String> {
        self.monitor_assign_if_absent(assignment, false)
    }

    pub fn monitor_assign_if_absent(&self, assignment: Assignment, only_if_absent: bool) -> Result<ProjectMonitor, String> {
        let Assignment { workspace_id, cwd, host_id, text: responsibility, files, threads, profile } = assignment;
        let responsibility = text(&responsibility)?;
        if workspace_id.is_empty() || host_id.is_empty() {
            return Err("ApexAgent needs a saved project.".into());
        }
        crate::monitor_check::monitor_profile_ok(&profile)?;
        let files = monitor_evidence::validate_files(&cwd, &files)?;
        let mut seen = std::collections::HashSet::new();
        let threads: Vec<_> = threads.into_iter().filter(|id| seen.insert(id.clone())).collect();
        if threads.len() > MAX_THREADS {
            return Err(format!("ApexAgent can follow at most {MAX_THREADS} chats."));
        }
        for id in &threads {
            let room = self.store().room(id)?.ok_or_else(|| format!("Chat '{id}' isn't saved on this machine."))?;
            if room.cwd.as_deref() != Some(cwd.as_str()) {
                return Err(format!("Chat '{id}' belongs to a different project folder."));
            }
        }
        self.change_monitors(|monitors| {
            if only_if_absent && monitors.iter().any(|m| m.workspace_id == workspace_id) {
                return Err("ApexAgent already has a responsibility for this project. Refresh before trying again.".into());
            }
            if !only_if_absent && self.assistant_tasks.list(Some(&workspace_id)).map_err(|e|e.to_string())?.iter().any(|task| !matches!(task.status, crate::assistant_tasks::TaskStatus::Done | crate::assistant_tasks::TaskStatus::Cancelled) || task.result_data.as_ref().is_some_and(|data| data["leaseHeld"] == true)) {
                return Err("Finish or cancel this project's assistant tasks before replacing its responsibility.".into());
            }
            monitors.retain(|m| m.workspace_id != workspace_id);
            let at = now();
            let mut monitor = ProjectMonitor::new(
                workspace_id.clone(),
                format!("apex-agent-{workspace_id}-{at}"),
                cwd,
                host_id,
                profile.id.to_string(),
                responsibility,
                files,
                threads,
                at,
            );
            monitor.profile = Some(profile);
            monitor.record_activity(at, "assigned", "ApexAgent was given this responsibility.");
            monitors.push(monitor.clone());
            Ok(monitor)
        })
    }

    /// Add or replace selected source paths and saved threads for the exact
    /// monitor shown by the client. Selection changes invalidate an in-flight
    /// check, while a duplicate add leaves it untouched.
    pub fn monitor_sources_update(
        &self,
        workspace_id: &str,
        cwd: &str,
        host_id: &str,
        conversation_id: &str,
        files: Vec<String>,
        threads: Vec<String>,
        mode: &str,
    ) -> Result<ProjectMonitor, String> {
        if !matches!(mode, "add" | "replace") {
            return Err("Source update mode must be 'add' or 'replace'.".into());
        }
        if files.len() > MAX_FILES {
            return Err(format!("ApexAgent can monitor at most {MAX_FILES} files."));
        }
        let files = monitor_evidence::validate_files(cwd, &files)?;
        let mut seen_threads = std::collections::HashSet::new();
        let threads: Vec<_> = threads.into_iter().filter(|id| seen_threads.insert(id.clone())).collect();
        if threads.len() > MAX_THREADS {
            return Err(format!("ApexAgent can follow at most {MAX_THREADS} chats."));
        }

        self.change_monitors(|monitors| {
            let monitor = monitors.iter_mut().find(|monitor| {
                monitor.workspace_id == workspace_id
                    && monitor.cwd == cwd
                    && monitor.host_id == host_id
                    && monitor.conversation_id == conversation_id
            }).ok_or_else(|| "ApexAgent's saved project or conversation has changed. Refresh and try again.".to_string())?;

            for id in &threads {
                let room = self.store().room(id)?.ok_or_else(|| format!("Chat '{id}' isn't saved on this machine."))?;
                if room.cwd.as_deref() != Some(cwd) {
                    return Err(format!("Chat '{id}' belongs to a different project folder."));
                }
            }

            let mut next_files = if mode == "replace" { Vec::new() } else { monitor.files.clone() };
            let mut next_threads = if mode == "replace" { Vec::new() } else { monitor.threads.clone() };
            for file in files {
                if !next_files.contains(&file) { next_files.push(file); }
            }
            for thread in threads {
                if !next_threads.contains(&thread) { next_threads.push(thread); }
            }
            if next_threads.len() > MAX_THREADS {
                return Err(format!("ApexAgent can follow at most {MAX_THREADS} chats."));
            }
            if next_files.len() > MAX_FILES {
                return Err(format!("ApexAgent can monitor at most {MAX_FILES} files."));
            }
            if next_files == monitor.files && next_threads == monitor.threads {
                return Ok(monitor.clone());
            }

            monitor.files = next_files;
            monitor.threads = next_threads;
            let at = now();
            monitor.revision = monitor.revision.saturating_add(1);
            monitor.active_check = None;
            monitor.pending_check_at = None;
            monitor.wake_reason = "sources_updated".into();
            monitor.next_check_at = if monitor.paused { None } else { Some(at) };
            monitor.record_activity(at, "sources_updated", "ApexAgent's selected sources were updated.");
            Ok(monitor.clone())
        })
    }

    /// Change only the saved reasoning profile, guarded by the assignment
    /// shown to the caller. Old check replies cannot merge into this revision.
    pub(crate) fn monitor_profile_update(
        &self, workspace_id: &str, owner: MonitorOwner, revision: u64,
        profile: ParticipantConfig,
    ) -> Result<ProjectMonitor, String> {
        crate::monitor_check::monitor_profile_ok(&profile)?;
        self.change_monitor_owned(workspace_id, Some(owner), |monitor, at| {
            if monitor.revision != revision {
                return Err("ApexAgent has changed. Refresh before changing its profile.".into());
            }
            monitor.profile_id = profile.id.to_string();
            monitor.profile = Some(profile);
            monitor.revision = monitor.revision.checked_add(1).ok_or("ApexAgent revision exhausted.")?;
            monitor.active_check = None;
            monitor.pending_check_at = None;
            monitor.wake_reason = "profile_updated".into();
            monitor.next_check_at = if monitor.paused { None } else { Some(at) };
            monitor.error = None;
            monitor.record_activity(at, "profile_updated", "ApexAgent's reasoning profile changed.");
            Ok(())
        })
    }

    /// Suggest bounded, likely project planning files without opening or
    /// reading their contents. Symlink entries and symlinked folders are
    /// excluded so discovery cannot leave the selected workspace.
    pub fn monitor_suggest_sources(&self, cwd: &str) -> Result<Vec<String>, String> {
        let root = std::fs::canonicalize(cwd).map_err(|e| format!("Could not open project folder: {e}"))?;
        if !std::fs::metadata(&root).map_err(|e| format!("Could not inspect project folder: {e}"))?.is_dir() {
            return Err("Project path is not a folder.".into());
        }
        let directories = ["", "docs", "docs/plans", "docs/superpowers/plans", "specs"];
        let mut candidates = Vec::new();
        let mut inspected = 0usize;
        for directory in directories {
            let dir = if directory.is_empty() { root.clone() } else { root.join(directory) };
            let mut current = root.clone();
            let safe_dir = directory.split('/').filter(|part| !part.is_empty()).all(|part| {
                current.push(part);
                std::fs::symlink_metadata(&current).is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
            });
            if !safe_dir { continue; }
            let entries = match std::fs::read_dir(&dir) { Ok(entries) => entries, Err(_) => continue };
            let mut in_directory = 0usize;
            for entry in entries {
                if in_directory >= MAX_DIRECTORY_ENTRIES || inspected >= MAX_INSPECTED_ENTRIES { break; }
                in_directory += 1;
                inspected += 1;
                let Ok(entry) = entry else { continue };
                let file_type = match entry.file_type() { Ok(kind) => kind, Err(_) => continue };
                if file_type.is_symlink() || !file_type.is_file() { continue; }
                let name = entry.file_name().to_string_lossy().into_owned();
                let extension = std::path::Path::new(&name).extension().and_then(|extension| extension.to_str()).unwrap_or_default();
                if !["md", "markdown", "txt", "text"].iter().any(|allowed| extension.eq_ignore_ascii_case(allowed)) {
                    continue;
                }
                let lower_name = name.to_lowercase();
                let is_readme = name.rsplit_once('.').is_some_and(|(stem, _)| stem.eq_ignore_ascii_case("README"));
                if directory.is_empty()
                    && !is_readme
                    && !["plan", "task", "launch", "report", "release", "readiness", "milestone"].iter().any(|needle| lower_name.contains(needle))
                {
                    continue;
                }
                let relative = if directory.is_empty() { name } else { format!("{directory}/{name}") };
                candidates.push(relative);
            }
            if inspected >= MAX_INSPECTED_ENTRIES { break; }
        }
        candidates.sort();
        candidates.dedup();
        // Validate independently so one secret or otherwise invalid candidate
        // does not suppress the rest of the suggestions.
        let mut valid = Vec::new();
        for candidate in candidates {
            if valid.len() >= MAX_SUGGESTED_FILES { break; }
            if let Ok(mut normalized) = monitor_evidence::validate_files(&root.to_string_lossy(), std::slice::from_ref(&candidate)) {
                if let Some(file) = normalized.pop() {
                    if !valid.contains(&file) { valid.push(file); }
                }
            }
        }
        Ok(valid)
    }

    /// A new message in the conversation: it redirects the responsibility
    /// and drops any check that was running on the old one.
    pub fn monitor_message(&self, workspace_id: &str, message: &str) -> Result<ProjectMonitor, String> {
        self.monitor_message_owned(workspace_id, None, message)
    }

    /// Immediate assistant conversation preserves the monitoring responsibility and active check.
    pub(crate) fn monitor_chat_message_owned(&self, workspace_id: &str, owner: MonitorOwner, role: &str, message: &str) -> Result<ProjectMonitor, String> {
        if !matches!(role, "human" | "assistant") { return Err("Invalid assistant conversation role.".into()); }
        let message = text(message)?;
        self.change_monitor_owned(workspace_id, Some(owner), |monitor, at| {
            monitor.append_message(role, &message, at, vec![])?;
            monitor.snapshot_version = monitor.snapshot_version.saturating_add(1);
            Ok(())
        })
    }

    pub(crate) fn monitor_message_owned(&self, workspace_id: &str, owner: Option<MonitorOwner>, message: &str) -> Result<ProjectMonitor, String> {
        let message = text(message)?;
        self.change_monitor_owned(workspace_id, owner, |monitor, at| {
            monitor.redirect(message, at)?;
            Ok(())
        })
    }

    pub fn monitor_pause(&self, workspace_id: &str, paused: bool) -> Result<ProjectMonitor, String> {
        self.monitor_pause_owned(workspace_id, None, paused)
    }

    pub(crate) fn monitor_pause_owned(&self, workspace_id: &str, owner: Option<MonitorOwner>, paused: bool) -> Result<ProjectMonitor, String> {
        self.change_monitor_owned(workspace_id, owner, |monitor, at| {
            monitor.set_paused(paused, at);
            Ok(())
        })
    }

    /// Make the next check due now. The check itself runs on the clock, so
    /// this answers at once.
    pub fn monitor_check_now(&self, workspace_id: &str) -> Result<ProjectMonitor, String> {
        self.monitor_check_now_owned(workspace_id, None)
    }

    pub(crate) fn monitor_check_now_owned(&self, workspace_id: &str, owner: Option<MonitorOwner>) -> Result<ProjectMonitor, String> {
        self.change_monitor_owned(workspace_id, owner, |monitor, at| {
            monitor.request_check_now(at)
        })
    }

    /// Settle one finding. A resolved or dismissed finding stays settled; a
    /// later check that sees new evidence makes a new finding.
    pub fn monitor_resolve(&self, workspace_id: &str, finding_id: &str, status: &str, snoozed_until: Option<u64>) -> Result<ProjectMonitor, String> {
        self.monitor_resolve_owned(workspace_id, None, finding_id, status, snoozed_until)
    }

    pub(crate) fn monitor_resolve_owned(&self, workspace_id: &str, owner: Option<MonitorOwner>, finding_id: &str, status: &str, snoozed_until: Option<u64>) -> Result<ProjectMonitor, String> {
        self.change_monitor_owned(workspace_id, owner, |monitor, at| {
            let finding = monitor
                .findings
                .iter_mut()
                .find(|f| f.id == finding_id)
                .ok_or_else(|| "That finding is gone.".to_string())?;
            let summary = match status {
                "resolved" | "dismissed" => {
                    finding.status = status.to_owned();
                    finding.snoozed_until = None;
                    format!("You marked \"{}\" {status}.", finding.summary)
                }
                "snoozed" => {
                    let until = snoozed_until.filter(|until| *until > at).ok_or_else(|| "Pick a time in the future to snooze until.".to_string())?;
                    // Still open: it comes back when the snooze ends.
                    finding.status = "open".into();
                    finding.snoozed_until = Some(until);
                    format!("You snoozed \"{}\".", finding.summary)
                }
                other => return Err(format!("Unknown finding status '{other}'.")),
            };
            monitor.record_activity(at, "finding", &summary);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::Finding;
    use crate::storage::SavedRoom;
    use crate::HostPaths;
    use apex_core::{Backend, Room, RoomOptions, RoomSnapshot};

    fn empty_snapshot() -> RoomSnapshot {
        Room::new(vec![], RoomOptions::default()).snapshot()
    }
    use std::sync::Arc;

    struct Fixture {
        host: Arc<Host>,
        data: std::path::PathBuf,
        project: std::path::PathBuf,
        _runtime: tokio::runtime::Runtime,
    }

    fn fixture(name: &str) -> Fixture {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("apex-monitor-cmd-{name}-{}-{nonce}", std::process::id()));
        let data = base.join("data");
        let project = base.join("project");
        std::fs::create_dir_all(project.join("docs")).unwrap();
        std::fs::write(project.join("docs/plan.md"), "Step 2 is blocked on review.").unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        Fixture { host, data, project, _runtime: runtime }
    }

    fn profile() -> ParticipantConfig {
        serde_json::from_value(serde_json::json!({
            "id": "helper", "display_name": "Helper",
            "backend": { "kind": "open_ai_compatible", "base_url": "http://127.0.0.1:9", "model": "m" }
        }))
        .unwrap()
    }

    fn assignment(f: &Fixture) -> Assignment {
        Assignment {
            workspace_id: "w".into(),
            cwd: f.project.to_string_lossy().into_owned(),
            host_id: "local".into(),
            text: "Keep the launch on track".into(),
            files: vec!["docs/plan.md".into()],
            threads: Vec::new(),
            profile: profile(),
        }
    }

    fn reopen(f: &Fixture) -> Arc<Host> {
        Host::new(HostPaths { data: f.data.clone(), downloads: None }, f._runtime.handle().clone())
    }

    #[test]
    fn profile_change_preserves_history_and_sources_and_invalidates_old_check() {
        let f = fixture("profile-change");
        let initial = f.host.monitor_assign(assignment(&f)).unwrap();
        f.host.monitor_message("w", "Also watch the docs").unwrap();
        let before = f.host.change_monitor("w", |monitor, at| {
            assert!(monitor.claim(at, true).is_some());
            Ok(())
        }).unwrap();
        let owner = MonitorOwner { cwd: initial.cwd.clone(), host_id: initial.host_id.clone(), conversation_id: initial.conversation_id.clone() };
        let mut next = profile();
        next.id = apex_core::ParticipantId::new("replacement");
        let updated = f.host.monitor_profile_update("w", owner.clone(), before.revision, next).unwrap();
        assert_eq!(updated.profile_id, "replacement");
        assert_eq!(updated.files, before.files);
        assert_eq!(updated.messages, before.messages);
        assert_eq!(updated.decisions, before.decisions);
        assert_eq!(updated.findings, before.findings);
        assert!(updated.active_check.is_none());
        assert!(updated.revision > before.revision);
        assert_eq!(reopen(&f).monitor_get("w").unwrap(), Some(updated.clone()));
        assert!(f.host.monitor_profile_update("w", owner, before.revision, profile()).is_err());
        assert_eq!(f.host.monitor_get("w").unwrap(), Some(updated));
    }

    #[test]
    fn immediate_conversation_preserves_periodic_monitoring_and_live_claim() {
        let f = fixture("immediate-chat");
        let initial = f.host.monitor_assign(assignment(&f)).unwrap();
        let before = f.host.change_monitor("w", |monitor,at| { assert!(monitor.claim(at,true).is_some()); Ok(()) }).unwrap();
        let updated = f.host.monitor_chat_message_owned("w", MonitorOwner { cwd:initial.cwd,host_id:initial.host_id,conversation_id:initial.conversation_id }, "human", "What's next?").unwrap();
        assert_eq!(updated.responsibility,before.responsibility);
        assert_eq!(updated.revision,before.revision);
        assert_eq!(updated.active_check,before.active_check);
        assert!(updated.snapshot_version > before.snapshot_version);
        assert_eq!(updated.messages.last().unwrap().text,"What's next?");
    }

    #[test]
    fn assign_saves_a_monitor_that_survives_a_restart() {
        let f = fixture("assign");
        let monitor = f.host.monitor_assign(assignment(&f)).unwrap();
        assert_eq!(monitor.workspace_id, "w");
        assert_eq!(monitor.files, vec!["docs/plan.md".to_string()]);
        assert_eq!(monitor.profile.as_ref().unwrap().id.to_string(), "helper");
        assert_eq!(reopen(&f).monitor_get("w").unwrap(), Some(monitor));
    }

    #[test]
    fn assign_replaces_the_old_responsibility_entirely() {
        let f = fixture("replace");
        let first = f.host.monitor_assign(assignment(&f)).unwrap();
        f.host.monitor_message("w", "Also watch the docs").unwrap();
        let mut again = assignment(&f);
        again.text = "Something else".into();
        let second = f.host.monitor_assign(again).unwrap();
        assert_ne!(first.conversation_id, second.conversation_id);
        assert_eq!(second.messages.len(), 1);
        assert_eq!(f.host.monitor_list().unwrap().len(), 1);
    }

    #[test]
    fn assign_refuses_bad_inputs_without_saving() {
        let f = fixture("refuse");
        let mut outside = assignment(&f);
        outside.files = vec!["../secret.txt".into()];
        assert!(f.host.monitor_assign(outside).is_err());

        let mut media = assignment(&f);
        media.profile.media = Some(Default::default());
        assert!(f.host.monitor_assign(media).is_err());

        // Gemini's read-only mode is only a prompt; a plain CLI has none.
        let mut gemini = assignment(&f);
        gemini.profile.backend = Backend::Agent { tool: apex_core::AgentTool::Gemini, model: None };
        assert!(f.host.monitor_assign(gemini).is_err());
        let mut cli = assignment(&f);
        cli.profile.backend = Backend::Cli { program: "sh".into(), args: vec![] };
        assert!(f.host.monitor_assign(cli).is_err());

        let mut missing = assignment(&f);
        missing.threads = vec!["nope".into()];
        assert!(f.host.monitor_assign(missing).unwrap_err().contains("isn't saved"));

        f.host.store().save_room("other", &SavedRoom { cwd: Some("/somewhere/else".into()), snapshot: empty_snapshot() }).unwrap();
        let mut foreign = assignment(&f);
        foreign.threads = vec!["other".into()];
        assert!(f.host.monitor_assign(foreign).unwrap_err().contains("different project"));

        let mut blank = assignment(&f);
        blank.text = "   ".into();
        assert!(f.host.monitor_assign(blank).is_err());

        assert!(f.host.monitor_list().unwrap().is_empty());
    }

    #[test]
    fn assign_accepts_a_chat_from_the_same_folder() {
        let f = fixture("thread");
        let cwd = f.project.to_string_lossy().into_owned();
        f.host.store().save_room("mine", &SavedRoom { cwd: Some(cwd), snapshot: empty_snapshot() }).unwrap();
        let mut with_thread = assignment(&f);
        with_thread.threads = vec!["mine".into()];
        assert_eq!(f.host.monitor_assign(with_thread).unwrap().threads, vec!["mine".to_string()]);
    }

    #[test]
    fn message_redirects_and_drops_a_running_check() {
        let f = fixture("message");
        f.host.monitor_assign(assignment(&f)).unwrap();
        let claim = f.host.change_monitor("w", |m, at| { m.claim(at, true); Ok(()) }).unwrap().active_check.unwrap();
        let after = f.host.monitor_message("w", "Defer SSO, keep November 1").unwrap();
        assert!(!after.is_current(&claim));
        assert_eq!(after.wake_reason, "redirected");
        assert_eq!(after.messages.last().unwrap().text, "Defer SSO, keep November 1");
        assert!(f.host.monitor_message("missing", "hi").is_err());
    }

    #[test]
    fn pause_and_check_now() {
        let f = fixture("pause");
        f.host.monitor_assign(assignment(&f)).unwrap();
        let paused = f.host.monitor_pause("w", true).unwrap();
        assert!(paused.paused && paused.next_check_at.is_none());
        assert!(f.host.monitor_check_now("w").unwrap_err().contains("paused"));
        f.host.monitor_pause("w", false).unwrap();
        let now_due = f.host.monitor_check_now("w").unwrap();
        assert_eq!(now_due.wake_reason, "check_now");
        assert!(now_due.next_check_at.unwrap() <= now());
    }

    #[test]
    fn resolve_dismiss_and_snooze_a_finding() {
        let f = fixture("resolve");
        f.host.monitor_assign(assignment(&f)).unwrap();
        f.host
            .change_monitor("w", |m, at| {
                for id in ["a", "b", "c"] {
                    m.findings.push(Finding {
                        id: id.into(), summary: format!("Blocker {id}"), reason: "r".into(), confidence: "observed".into(),
                        next_step: "n".into(), evidence: Vec::new(), status: "open".into(),
                        first_seen_at: at, last_seen_at: at, last_notified_at: None, snoozed_until: None, deadline_at: None, deadline_assessed_at: None,
                    });
                }
                Ok(())
            })
            .unwrap();
        f.host.monitor_resolve("w", "a", "resolved", None).unwrap();
        f.host.monitor_resolve("w", "b", "dismissed", None).unwrap();
        assert!(f.host.monitor_resolve("w", "c", "snoozed", Some(1)).is_err());
        assert!(f.host.monitor_resolve("w", "c", "maybe", None).is_err());
        assert!(f.host.monitor_resolve("w", "gone", "resolved", None).is_err());
        let later = now() + 60_000;
        let monitor = f.host.monitor_resolve("w", "c", "snoozed", Some(later)).unwrap();
        let status: Vec<_> = monitor.findings.iter().map(|f| (f.status.as_str(), f.snoozed_until)).collect();
        assert_eq!(status, vec![("resolved", None), ("dismissed", None), ("open", Some(later))]);
        assert!(monitor.notifiable_findings(now()).is_empty());
        assert_eq!(reopen(&f).monitor_get("w").unwrap(), Some(monitor));
    }

    #[test]
    fn check_now_during_active_claim_survives_restart_and_is_consumed_once() {
        let f = fixture("check-now-active");
        f.host.monitor_assign(assignment(&f)).unwrap();
        let mut claimed = None;
        f.host.change_monitor("w", |m, at| {
            claimed = m.claim(at, true);
            Ok(())
        }).unwrap();
        let claimed = claimed.unwrap();
        let requested = f.host.monitor_check_now("w").unwrap();
        assert_eq!(requested.active_check, Some(claimed.clone()));
        assert_eq!(requested.pending_check_at, Some(requested.next_check_at.unwrap()));

        let reopened = reopen(&f);
        let persisted = reopened.monitor_get("w").unwrap().unwrap();
        assert_eq!(persisted.pending_check_at, requested.pending_check_at);
        assert_eq!(persisted.active_check, Some(claimed.clone()));
        let finished = reopened.change_monitor("w", |m, _| {
            assert!(m.finish_check(&claimed, Some(now() + 60_000), "scheduled"));
            Ok(())
        }).unwrap();
        assert_eq!(finished.wake_reason, "check_now");
        assert!(finished.pending_check_at.is_some());
        assert!(finished.next_check_at.unwrap() <= now());
        let mut next = None;
        reopened.change_monitor("w", |m, at| { next = m.claim(at, false); Ok(()) }).unwrap();
        assert!(next.is_some());
        assert_eq!(reopened.monitor_get("w").unwrap().unwrap().pending_check_at, None);
        let mut after = None;
        reopened.change_monitor("w", |m, at| { after = m.claim(at, true); Ok(()) }).unwrap();
        assert!(after.is_none(), "the pending check must be consumed exactly once");
    }

    #[test]
    fn pending_check_now_survives_recovery_after_restart() {
        let f = fixture("check-now-recovery");
        f.host.monitor_assign(assignment(&f)).unwrap();
        let mut claim = None;
        f.host.change_monitor("w", |m, at| { claim = m.claim(at, true); Ok(()) }).unwrap();
        let claim = claim.unwrap();
        let requested = f.host.monitor_check_now("w").unwrap();
        let reopened = reopen(&f);
        let recovered = reopened.change_monitor("w", |m, at| {
            m.recover(at);
            Ok(())
        }).unwrap();
        assert_eq!(recovered.active_check, None);
        assert_eq!(recovered.pending_check_at, requested.pending_check_at);
        assert_eq!(recovered.wake_reason, "check_now");
        assert!(recovered.next_check_at.unwrap() <= now());
        assert!(!recovered.is_current(&claim));
    }

    #[test]
    fn repeated_check_now_requests_coalesce_to_one_followup() {
        let f = fixture("check-now-coalesce");
        f.host.monitor_assign(assignment(&f)).unwrap();
        let mut active = None;
        f.host.change_monitor("w", |m, at| { active = m.claim(at, true); Ok(()) }).unwrap();
        let active = active.unwrap();
        f.host.monitor_check_now("w").unwrap();
        let once = f.host.monitor_check_now("w").unwrap();
        let twice = f.host.monitor_check_now("w").unwrap();
        assert!(once.pending_check_at.is_some() && twice.pending_check_at.is_some());
        assert_eq!(twice.active_check, Some(active));
        let claim = twice.active_check.clone().unwrap();
        let finished = f.host.change_monitor("w", |m, _| {
            assert!(m.finish_check(&claim, Some(now() + 60_000), "scheduled"));
            Ok(())
        }).unwrap();
        assert!(finished.pending_check_at.is_some());
        assert_eq!(finished.wake_reason, "check_now");
        assert!(finished.next_check_at.unwrap() <= now());
        let mut followup = None;
        f.host.change_monitor("w", |m, at| { followup = m.claim(at, false); Ok(()) }).unwrap();
        let followup = followup.expect("one followup claim should consume the coalesced request");
        assert_eq!(f.host.monitor_get("w").unwrap().unwrap().pending_check_at, None);
        f.host.change_monitor("w", |m, _| {
            assert!(m.finish_check(&followup, Some(now() + 60_000), "scheduled"));
            Ok(())
        }).unwrap();
        let mut extra = None;
        f.host.change_monitor("w", |m, at| { extra = m.claim(at, false); Ok(()) }).unwrap();
        assert!(extra.is_none(), "repeated requests must not queue multiple followups");
    }

    #[test]
    fn finding_id_counter_seeds_from_settled_findings_across_restart() {
        let f = fixture("finding-counter");
        f.host.monitor_assign(assignment(&f)).unwrap();
        f.host.change_monitor("w", |m, at| {
            for id in [format!("finding-{}-8", m.conversation_id), format!("finding-{}-14", m.conversation_id)] {
                m.findings.push(Finding {
                    id: id.clone(), summary: "Old item".into(), reason: "r".into(), confidence: "observed".into(),
                    next_step: "n".into(), evidence: Vec::new(), status: if id.ends_with("-8") { "resolved" } else { "dismissed" }.into(),
                    first_seen_at: at, last_seen_at: at, last_notified_at: None, snoozed_until: None, deadline_at: None, deadline_assessed_at: None,
                });
            }
            Ok(())
        }).unwrap();
        let reopened = reopen(&f);
        let mut allocated = None;
        reopened.change_monitor("w", |m, _| { allocated = Some(m.allocate_finding_id()?); Ok(()) }).unwrap();
        let allocated = allocated.unwrap();
        assert!(allocated.ends_with("-15"));
        let after_reopen = reopen(&f).monitor_get("w").unwrap().unwrap();
        assert_eq!(after_reopen.finding_id_counter, 15);
        assert!(after_reopen.findings.iter().all(|finding| finding.id != allocated));
        let mut next_id = None;
        reopen(&f).change_monitor("w", |m, _| { next_id = Some(m.allocate_finding_id()?); Ok(()) }).unwrap();
        assert!(next_id.unwrap().ends_with("-16"));
    }

    #[test]
    fn source_update_invalidates_running_check_and_preserves_monitor_state() {
        let f = fixture("sources-update");
        let assigned = f.host.monitor_assign(assignment(&f)).unwrap();
        f.host.monitor_message("w", "Keep launch on track").unwrap();
        f.host.monitor_pause("w", true).unwrap();
        f.host.change_monitor("w", |m, at| {
            m.paused = false;
            m.next_check_at = Some(at + 60_000);
            m.findings.push(Finding {
                id: "finding-preserved".into(), summary: "Keep this".into(), reason: "reason".into(), confidence: "observed".into(),
                next_step: "step".into(), evidence: Vec::new(), status: "open".into(), first_seen_at: at,
                last_seen_at: at, last_notified_at: None, snoozed_until: None, deadline_at: None, deadline_assessed_at: None,
            });
            Ok(())
        }).unwrap();
        f.host.change_monitor("w", |m, at| { m.next_check_at = Some(at); Ok(()) }).unwrap();
        let claim = f.host.change_monitor("w", |m, at| {
            m.claim(at, false);
            Ok(())
        }).unwrap().active_check.unwrap();
        let before = f.host.monitor_get("w").unwrap().unwrap();
        let updated = f.host.monitor_sources_update(
            "w", &before.cwd, &before.host_id, &before.conversation_id,
            vec!["README.md".into()], vec![], "add",
        ).unwrap();
        assert_eq!(updated.files, vec!["docs/plan.md", "README.md"]);
        assert_eq!(updated.revision, before.revision + 1);
        assert!(updated.active_check.is_none());
        assert!(!updated.is_current(&claim));
        assert!(updated.next_check_at.unwrap() <= now());
        assert_eq!(updated.messages, before.messages);
        assert_eq!(updated.findings, before.findings);
        assert_eq!(updated.activity.len(), before.activity.len() + 1);
        assert_eq!(updated.responsibility, before.responsibility);
        assert_eq!(updated.profile, before.profile);
        assert_eq!(assigned.workspace_id, updated.workspace_id);

        let paused = f.host.monitor_pause("w", true).unwrap();
        let paused_update = f.host.monitor_sources_update(
            "w", &paused.cwd, &paused.host_id, &paused.conversation_id,
            vec!["README.md".into()], vec![], "add",
        ).unwrap();
        assert!(paused_update.paused);
        assert_eq!(paused_update.next_check_at, None);
    }

    #[test]
    fn duplicate_add_is_idempotent_and_replace_keeps_assignment_and_history() {
        let f = fixture("sources-idempotent");
        let assigned = f.host.monitor_assign(assignment(&f)).unwrap();
        let added = f.host.monitor_sources_update(
            "w", &assigned.cwd, &assigned.host_id, &assigned.conversation_id,
            vec!["README.md".into()], vec![], "add",
        ).unwrap();
        let active = f.host.change_monitor("w", |m, at| { m.claim(at, true); Ok(()) }).unwrap();
        let active = active.active_check.unwrap();
        let before_duplicate = f.host.monitor_get("w").unwrap().unwrap();
        let duplicate = f.host.monitor_sources_update(
            "w", &added.cwd, &added.host_id, &added.conversation_id,
            vec!["README.md".into()], vec![], "add",
        ).unwrap();
        assert_eq!(duplicate, before_duplicate);
        assert_eq!(duplicate.revision, added.revision);
        assert_eq!(duplicate.snapshot_version, before_duplicate.snapshot_version);
        assert_eq!(duplicate.active_check, Some(active));

        let replaced = f.host.monitor_sources_update(
            "w", &duplicate.cwd, &duplicate.host_id, &duplicate.conversation_id,
            vec![], vec![], "replace",
        ).unwrap();
        assert!(replaced.files.is_empty());
        assert_eq!(replaced.workspace_id, assigned.workspace_id);
        assert_eq!(replaced.cwd, assigned.cwd);
        assert_eq!(replaced.host_id, assigned.host_id);
        assert_eq!(replaced.conversation_id, assigned.conversation_id);
        assert_eq!(replaced.responsibility, assigned.responsibility);
        assert_eq!(replaced.profile, assigned.profile);
        assert_eq!(replaced.messages, assigned.messages);
    }

    #[test]
    fn source_update_checks_exact_owner_paths_and_threads() {
        let f = fixture("sources-owner");
        let assigned = f.host.monitor_assign(assignment(&f)).unwrap();
        for (cwd, host_id, conversation_id) in [
            ("/wrong", assigned.host_id.as_str(), assigned.conversation_id.as_str()),
            (assigned.cwd.as_str(), "another-host", assigned.conversation_id.as_str()),
            (assigned.cwd.as_str(), assigned.host_id.as_str(), "another-conversation"),
        ] {
            assert!(f.host.monitor_sources_update("w", cwd, host_id, conversation_id, vec!["README.md".into()], vec![], "add").is_err());
        }
        assert!(f.host.monitor_sources_update("w", &assigned.cwd, &assigned.host_id, &assigned.conversation_id, vec!["../secret".into()], vec![], "add").is_err());
        f.host.store().save_room("foreign", &SavedRoom { cwd: Some("/elsewhere".into()), snapshot: empty_snapshot() }).unwrap();
        assert!(f.host.monitor_sources_update("w", &assigned.cwd, &assigned.host_id, &assigned.conversation_id, vec![], vec!["foreign".into()], "add").unwrap_err().contains("different project"));
        assert!(f.host.monitor_sources_update("w", &assigned.cwd, &assigned.host_id, &assigned.conversation_id, vec![], vec![], "append").is_err());
    }

    #[test]
    fn suggestions_are_bounded_rooted_and_skip_symlinks() {
        let f = fixture("source-suggest");
        std::fs::write(f.project.join("README.md"), "do not read this").unwrap();
        std::fs::write(f.project.join("Readme.markdown"), "case-insensitive README").unwrap();
        std::fs::write(f.project.join("launch-plan.md"), "secret").unwrap();
        std::fs::write(f.project.join("test-report.md"), "SSO blocker").unwrap();
        std::fs::write(f.project.join("launch-screenshot.png"), "binary candidate").unwrap();
        std::fs::write(f.project.join("ordinary.md"), "not a suggestion").unwrap();
        std::fs::write(f.project.join("docs/root.md"), "docs root").unwrap();
        std::fs::create_dir_all(f.project.join("docs/plans")).unwrap();
        std::fs::write(f.project.join("docs/plans/plan.md"), "project plan").unwrap();
        std::fs::create_dir_all(f.project.join("docs/superpowers/plans")).unwrap();
        std::fs::write(f.project.join("docs/superpowers/plans/task.md"), "plan").unwrap();
        std::fs::create_dir_all(f.project.join("specs")).unwrap();
        std::fs::write(f.project.join("specs/overview.md"), "spec").unwrap();
        std::fs::write(f.project.join("docs/.env"), "secret candidate should be skipped").unwrap();
        std::fs::create_dir_all(f.project.join("docs/plans/superpowers/plans")).unwrap();
        std::fs::write(f.project.join("docs/plans/superpowers/plans/old.md"), "old path").unwrap();
        std::fs::create_dir_all(f.project.join("docs/hidden")).unwrap();
        std::fs::write(f.project.join("docs/hidden/plan.md"), "hidden").unwrap();
        #[cfg(unix)] std::os::unix::fs::symlink("/etc/passwd", f.project.join("docs/superpowers/plans/linked.md")).unwrap();
        let suggestions = f.host.monitor_suggest_sources(f.project.to_str().unwrap()).unwrap();
        assert!(suggestions.contains(&"README.md".to_string()));
        assert!(suggestions.contains(&"Readme.markdown".to_string()));
        assert!(suggestions.contains(&"launch-plan.md".to_string()));
        assert!(suggestions.contains(&"test-report.md".to_string()));
        assert!(suggestions.contains(&"docs/plans/plan.md".to_string()));
        assert!(suggestions.contains(&"docs/root.md".to_string()));
        assert!(suggestions.contains(&"docs/superpowers/plans/task.md".to_string()));
        assert!(suggestions.contains(&"specs/overview.md".to_string()));
        assert!(!suggestions.iter().any(|path| path.contains("hidden") || path.contains("linked") || path.contains("old") || path == "ordinary.md" || path == "docs/.env" || path.ends_with(".png")));
        assert!(f.host.monitor_suggest_sources("/missing/path").is_err());
    }

    #[test]
    fn source_suggestions_stay_within_thirty_two_results() {
        let f = fixture("source-suggest-limit");
        for index in 0..80 {
            std::fs::write(f.project.join(format!("plan-{index:03}.md")), "not read").unwrap();
        }
        let suggestions = f.host.monitor_suggest_sources(f.project.to_str().unwrap()).unwrap();
        assert_eq!(suggestions.len(), 32);
    }

    #[test]
    fn resolving_finding_during_check_advances_snapshot_without_invalidating_claim() {
        let f = fixture("snapshot-resolve");
        f.host.monitor_assign(assignment(&f)).unwrap();
        f.host.change_monitor("w", |monitor, at| {
            monitor.findings.push(Finding {
                id: "finding-active".into(), summary: "Needs a choice".into(), reason: "reason".into(), confidence: "observed".into(),
                next_step: "step".into(), evidence: Vec::new(), status: "open".into(), first_seen_at: at,
                last_seen_at: at, last_notified_at: None, snoozed_until: None, deadline_at: None, deadline_assessed_at: None,
            });
            Ok(())
        }).unwrap();
        let claimed = f.host.change_monitor("w", |monitor, at| { monitor.claim(at, true); Ok(()) }).unwrap();
        let claim = claimed.active_check.unwrap();
        let before_resolve = claimed.snapshot_version;
        let resolved = f.host.monitor_resolve("w", "finding-active", "resolved", None).unwrap();
        assert_eq!(resolved.snapshot_version, before_resolve + 1);
        assert_eq!(resolved.revision, claimed.revision);
        assert!(resolved.is_current(&claim));
        let before_finish = resolved.snapshot_version;
        let finished = f.host.change_monitor("w", |monitor, _| {
            assert!(monitor.finish_check(&claim, Some(now() + 60_000), "scheduled"));
            Ok(())
        }).unwrap();
        assert_eq!(finished.snapshot_version, before_finish + 1);
        assert_eq!(finished.findings[0].status, "resolved");
    }
}
