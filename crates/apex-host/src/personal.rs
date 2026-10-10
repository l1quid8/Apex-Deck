//! The personal assistant: one ongoing conversation that lives on a durable
//! host (the VPS), not on whichever app happens to be open.
//!
//! Everything an assistant owns is one record in `personal-assistants.json`:
//! its conversation, the events clients sent it, its tasks, their pending
//! decisions and their operation receipts. Each step is one locked read,
//! change and atomic save, so a reply, the task change it causes and the
//! event being marked done land together or not at all.
//!
//! Client commands only validate and append an event; the worker in
//! `personal_worker.rs` does the rest. Permission never comes from text: a
//! decision is applied only from a `personal_decide` event whose parameter
//! hash matches the task's current operation.

use std::sync::Mutex;

use apex_core::ParticipantConfig;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_MESSAGES: usize = 500;
pub const MAX_TEXT_BYTES: usize = 20 * 1024;
/// Settled events kept for request-id deduplication.
pub const MAX_SETTLED_EVENTS: usize = 500;
const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_ARGV: usize = 32;
const MAX_ARG_BYTES: usize = 1024;

/// One change to `personal-assistants.json` at a time. Never held across a
/// model call or a command run.
static PERSONAL: Mutex<()> = Mutex::new(());

pub(crate) fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalDocument {
    pub version: u32,
    pub assistants: Vec<PersonalAssistant>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Counters {
    pub message: u64,
    pub event: u64,
    pub task: u64,
    pub decision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalAssistant {
    pub id: String,
    pub name: String,
    /// Free text for the prompt only. It describes tone, never permissions.
    pub style: String,
    /// The machine this assistant lives on, from `<data>/host-id`.
    pub host_id: String,
    pub profile: Option<ParticipantConfig>,
    /// Folders on this host its operations may run in.
    pub allowed_folders: Vec<String>,
    pub paused: bool,
    pub revision: u64,
    pub created_at: u64,
    pub counters: Counters,
    pub messages: Vec<PersonalMessage>,
    pub events: Vec<PersonalEvent>,
    pub tasks: Vec<PersonalTask>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalMessage {
    pub id: String,
    /// `human` is only ever written by `personal_send`. Model and tool output
    /// is `assistant` or `system`.
    pub role: String,
    /// `chat`, `approval`, `result` or `update`.
    pub kind: String,
    pub text: String,
    pub at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum EventSource {
    /// Text the human typed in a client. The only source that can start a task.
    Human { text: String },
    /// The human's answer to one decision, bound to the operation it approves.
    Decision { decision_id: String, params_hash: String, approve: bool },
    Cancel { task_id: String },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EventState {
    Received,
    Processing,
    Done,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalEvent {
    pub id: String,
    /// The client's id for this request. A repeat returns the first event.
    pub request_id: String,
    pub source: EventSource,
    pub received_at: u64,
    pub state: EventState,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    /// Waiting for the human: an approval or a question (`wait` says which).
    NeedsYou,
    /// Approved and ready for the worker.
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn settled(self) -> bool {
        matches!(self, TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationSpec {
    pub tool: String,
    pub host: String,
    pub cwd: String,
    pub argv: Vec<String>,
}

impl OperationSpec {
    /// sha256 of the spec's canonical JSON (fields in declaration order).
    pub fn hash(&self) -> String {
        let bytes = serde_json::to_vec(self).unwrap_or_default();
        let digest = Sha256::digest(&bytes);
        format!("sha256:{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DecisionKind {
    /// Run this exact operation?
    Approve,
    /// A non-repeatable operation may or may not have happened. Run it again?
    Uncertain,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DecisionStatus {
    Open,
    Approved,
    Denied,
    Superseded,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingDecision {
    pub id: String,
    pub kind: DecisionKind,
    pub params_hash: String,
    pub prompt: String,
    pub status: DecisionStatus,
    pub opened_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by_event: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpPhase {
    /// Saved just before the operation ran. Left alone, it means "may have happened".
    Attempted,
    Verified,
    Failed,
    /// Found `Attempted` after a restart.
    Uncertain,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationReceipt {
    pub op_id: String,
    pub params_hash: String,
    pub phase: OpPhase,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub output_excerpt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_hash: Option<String>,
    /// This run repeats one whose outcome a restart left unknown.
    #[serde(default)]
    pub rerun_after_restart: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalTask {
    pub id: String,
    pub goal: String,
    pub completion_criteria: Vec<String>,
    pub target_host: String,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<OperationSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<PendingDecision>,
    #[serde(default)]
    pub receipts: Vec<OperationReceipt>,
    /// The human event that started it.
    pub from_event: String,
    pub max_attempts: u32,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_update: Option<String>,
}

impl PersonalAssistant {
    pub(crate) fn next_message_id(&mut self) -> String {
        self.counters.message += 1;
        format!("pm-{}", self.counters.message)
    }

    pub(crate) fn next_task_id(&mut self) -> String {
        self.counters.task += 1;
        format!("pt-{}", self.counters.task)
    }

    pub(crate) fn next_decision_id(&mut self) -> String {
        self.counters.decision += 1;
        format!("pd-{}", self.counters.decision)
    }

    pub(crate) fn post(&mut self, role: &str, kind: &str, text: String, task_id: Option<String>, event_id: Option<String>, at: u64) {
        let id = self.next_message_id();
        self.messages.push(PersonalMessage { id, role: role.into(), kind: kind.into(), text, at, task_id, event_id });
        if self.messages.len() > MAX_MESSAGES {
            let extra = self.messages.len() - MAX_MESSAGES;
            self.messages.drain(..extra);
        }
    }

    pub(crate) fn task_mut(&mut self, id: &str) -> Option<&mut PersonalTask> {
        self.tasks.iter_mut().find(|task| task.id == id)
    }

    /// Settled events beyond the limit are dropped oldest first. Pending ones never are.
    fn prune_events(&mut self) {
        let settled = self.events.iter().filter(|e| matches!(e.state, EventState::Done | EventState::Failed)).count();
        let mut extra = settled.saturating_sub(MAX_SETTLED_EVENTS);
        self.events.retain(|e| {
            if extra > 0 && matches!(e.state, EventState::Done | EventState::Failed) {
                extra -= 1;
                false
            } else {
                true
            }
        });
    }

    /// After a restart: a claimed event goes back to be processed again, and
    /// an operation that was attempted but never finished is now uncertain.
    pub(crate) fn recover(&mut self) -> bool {
        let mut changed = false;
        for event in &mut self.events {
            if event.state == EventState::Processing {
                event.state = EventState::Received;
                changed = true;
            }
        }
        for task in &mut self.tasks {
            if task.status == TaskStatus::Running {
                for receipt in &mut task.receipts {
                    if receipt.phase == OpPhase::Attempted {
                        receipt.phase = OpPhase::Uncertain;
                        receipt.note = Some("The service restarted before this finished.".into());
                    }
                }
                // The worker decides what an uncertain operation means.
                task.status = TaskStatus::Queued;
                changed = true;
            }
        }
        changed
    }
}

fn request_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() || id.len() > MAX_REQUEST_ID_BYTES || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b':') {
        return Err("The request needs a short id made of letters, digits, '-', '_' or ':'.".into());
    }
    Ok(id.to_owned())
}

fn message_text(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Say what the assistant should do.".into());
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err("That message is too long for the assistant.".into());
    }
    Ok(text.to_owned())
}

/// A command the assistant proposes: no shell, bounded, plain arguments.
pub(crate) fn valid_argv(argv: &[String]) -> Result<(), String> {
    if argv.is_empty() || argv.len() > MAX_ARGV {
        return Err("The command needs between 1 and 32 arguments.".into());
    }
    if argv.iter().any(|arg| arg.len() > MAX_ARG_BYTES || arg.contains('\0')) {
        return Err("A command argument is too long or contains a NUL byte.".into());
    }
    Ok(())
}

/// What `personal_send`, `personal_decide` and `personal_cancel` answer with.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Accepted {
    pub event_id: String,
    pub duplicate: bool,
    pub assistant: PersonalAssistant,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInput {
    pub name: String,
    #[serde(default)]
    pub style: String,
    pub folder: String,
    pub profile: ParticipantConfig,
}

impl crate::Host {
    pub(crate) fn change_personal<T>(&self, change: impl FnOnce(&mut Vec<PersonalAssistant>) -> Result<T, String>) -> Result<T, String> {
        let _held = PERSONAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut document = self.store().personal()?.unwrap_or_default();
        let before = document.assistants.clone();
        let out = change(&mut document.assistants)?;
        if document.assistants != before {
            self.store().save_personal(&PersonalDocument { version: document.version.max(1), assistants: document.assistants.clone() })?;
            for (assistant, previous) in document.assistants.iter().map(|a| (a, before.iter().find(|b| b.id == a.id))) {
                if previous != Some(assistant) {
                    self.emit_personal_changed(&assistant.id, assistant.revision);
                }
            }
            self.personal_wake.notify_one();
        }
        Ok(out)
    }

    pub(crate) fn change_assistant<T>(&self, id: &str, change: impl FnOnce(&mut PersonalAssistant) -> Result<T, String>) -> Result<T, String> {
        self.change_personal(|assistants| {
            let assistant = assistants.iter_mut().find(|a| a.id == id).ok_or("That assistant doesn't exist on this machine.")?;
            let before = assistant.clone();
            let out = change(assistant)?;
            if *assistant != before {
                assistant.revision += 1;
            }
            Ok(out)
        })
    }

    /// This machine's id, as the daemon reports it in its welcome.
    pub(crate) fn local_host_id(&self) -> Result<String, String> {
        let path = self.data_dir().join("host-id");
        std::fs::read_to_string(&path).ok().map(|id| id.trim().to_owned()).filter(|id| !id.is_empty())
            .ok_or_else(|| "This machine has no host id yet; start it as a service.".into())
    }

    pub fn personal_list(&self) -> Result<Vec<PersonalAssistant>, String> {
        Ok(self.store().personal()?.unwrap_or_default().assistants)
    }

    pub fn personal_get(&self, id: &str) -> Result<PersonalAssistant, String> {
        self.personal_list()?.into_iter().find(|a| a.id == id).ok_or_else(|| "That assistant doesn't exist on this machine.".into())
    }

    /// Make an assistant that lives on this machine. Its folder is created if
    /// missing and must be absolute.
    pub fn personal_create(&self, input: CreateInput) -> Result<PersonalAssistant, String> {
        crate::monitor_check::monitor_profile_ok(&input.profile)?;
        let name = input.name.trim();
        if name.is_empty() || name.len() > 64 {
            return Err("Give the assistant a name of up to 64 characters.".into());
        }
        if input.style.len() > 2_000 {
            return Err("That style is too long.".into());
        }
        let folder = match input.folder.trim().strip_prefix("~/") {
            Some(rest) => std::path::PathBuf::from(std::env::var_os("HOME").ok_or("This machine has no home folder set.")?).join(rest),
            None => std::path::PathBuf::from(input.folder.trim()),
        };
        let folder = folder.as_path();
        if !folder.is_absolute() {
            return Err("The assistant's folder must be a full path on this machine.".into());
        }
        std::fs::create_dir_all(folder).map_err(|e| format!("Could not make the assistant's folder: {e}"))?;
        let folder = folder.canonicalize().map_err(|e| format!("Could not open the assistant's folder: {e}"))?;
        let host_id = self.local_host_id()?;
        let at = now();
        self.change_personal(|assistants| {
            let n = assistants.len() + 1;
            let id = (n..).map(|n| format!("asst-{n}")).find(|id| !assistants.iter().any(|a| &a.id == id)).unwrap();
            let assistant = PersonalAssistant {
                id, name: name.to_owned(), style: input.style.trim().to_owned(), host_id,
                profile: Some(input.profile), allowed_folders: vec![folder.to_string_lossy().into_owned()],
                paused: false, revision: 1, created_at: at, counters: Counters::default(),
                messages: vec![], events: vec![], tasks: vec![],
            };
            assistants.push(assistant.clone());
            Ok(assistant)
        })
    }

    fn personal_accept(&self, id: &str, request: &str, source: EventSource, human_line: Option<String>) -> Result<Accepted, String> {
        let request = request_id(request)?;
        self.change_assistant(id, |assistant| {
            if let Some(existing) = assistant.events.iter().find(|e| e.request_id == request) {
                if existing.source != source {
                    return Err("That request id was already used for something else.".into());
                }
                return Ok((existing.id.clone(), true));
            }
            assistant.counters.event += 1;
            let event_id = format!("pe-{}", assistant.counters.event);
            let at = now();
            if let Some(text) = human_line {
                assistant.post("human", "chat", text, None, Some(event_id.clone()), at);
            }
            assistant.events.push(PersonalEvent {
                id: event_id.clone(), request_id: request, source, received_at: at,
                state: EventState::Received, attempts: 0, error: None,
            });
            assistant.prune_events();
            Ok((event_id, false))
        }).and_then(|(event_id, duplicate)| Ok(Accepted { event_id, duplicate, assistant: self.personal_get(id)? }))
    }

    /// Save the human's message and its event, then answer at once. The
    /// worker replies later.
    pub fn personal_send(&self, id: &str, request_id: &str, text: &str) -> Result<Accepted, String> {
        let text = message_text(text)?;
        self.personal_accept(id, request_id, EventSource::Human { text: text.clone() }, Some(text))
    }

    pub fn personal_decide(&self, id: &str, request_id: &str, decision_id: &str, params_hash: &str, approve: bool) -> Result<Accepted, String> {
        let source = EventSource::Decision { decision_id: decision_id.into(), params_hash: params_hash.into(), approve };
        self.personal_accept(id, request_id, source, None)
    }

    pub fn personal_cancel(&self, id: &str, request_id: &str, task_id: &str) -> Result<Accepted, String> {
        self.personal_accept(id, request_id, EventSource::Cancel { task_id: task_id.into() }, None)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn operation_hash_changes_with_any_material_parameter() {
        let spec = OperationSpec { tool: "host.command".into(), host: "h".into(), cwd: "/a".into(), argv: vec!["df".into(), "-h".into(), "/".into()] };
        let base = spec.hash();
        assert!(base.starts_with("sha256:"));
        assert_eq!(base, spec.clone().hash());
        for changed in [
            OperationSpec { tool: "x".into(), ..spec.clone() },
            OperationSpec { host: "other".into(), ..spec.clone() },
            OperationSpec { cwd: "/b".into(), ..spec.clone() },
            OperationSpec { argv: vec!["df".into(), "-h".into(), "/home".into()], ..spec.clone() },
        ] {
            assert_ne!(changed.hash(), base);
        }
    }

    #[test]
    fn request_ids_are_short_and_plain() {
        assert!(request_id("phone:1700-abc_2").is_ok());
        assert!(request_id("").is_err());
        assert!(request_id("has space").is_err());
        assert!(request_id(&"x".repeat(129)).is_err());
    }
}
