//! Run-scoped orchestration for durable assistant tasks.
//!
//! This service intentionally writes only the task and conversation ledgers;
//! session snapshots remain owned by the chat host.
use crate::{
    assistant_conversation::{
        self, ConversationEvidence, ConversationRequest, ConversationStatus, ThreadChoice,
    },
    assistant_git,
    assistant_tasks::{
        AssistantTask, HumanRequest, TaskDestination, TaskMode, TaskOutcome, TaskOwner, TaskStatus,
    },
    host::Host,
};
use apex_adapters::OwnedProcessRegistry;
use apex_core::{ParticipantConfig, ParticipantId, TurnRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    future::Future,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    io::AsyncReadExt,
    sync::{watch, Notify},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLabel {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessageInput {
    pub workspace_id: String,
    pub cwd: String,
    pub host_id: String,
    pub conversation_id: String,
    pub request_id: String,
    pub text: String,
    #[serde(default)]
    pub destination: Option<TaskDestination>,
    #[serde(default)]
    pub new_worker_profiles: Vec<ParticipantConfig>,
    #[serde(default)]
    pub worker_profiles: Vec<ParticipantConfig>,
    #[serde(default)]
    pub spend_limit_micros: Option<u64>,
    #[serde(default)]
    pub thread_labels: Vec<ThreadLabel>,
    #[serde(default = "default_mode")]
    pub mode: TaskMode,
    #[serde(default)]
    pub checks: Vec<Vec<String>>,
}
fn default_mode() -> TaskMode {
    TaskMode::InPlace
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantActionInput {
    pub task_id: String,
    pub revision: u64,
    pub owner: TaskOwner,
    pub action: String,
    #[serde(default)]
    pub mode: Option<TaskMode>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub destination: Option<TaskDestination>,
    #[serde(default)]
    pub new_worker_profiles: Vec<ParticipantConfig>,
    #[serde(default)]
    pub checks: Option<Vec<Vec<String>>>,
    #[serde(default)]
    pub spend_limit_micros: Option<u64>,
}

pub(crate) struct AssistantRun {
    pub stop: Arc<AtomicBool>,
    pub stop_tx: watch::Sender<bool>,
    pub done: Arc<Notify>,
    pub finished: AtomicBool,
    pub budget_pause: AtomicBool,
    pub error: Mutex<Option<String>>,
}
impl AssistantRun {
    fn new() -> Self {
        let (stop_tx, _) = watch::channel(false);
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            stop_tx,
            done: Arc::new(Notify::new()),
            finished: AtomicBool::new(false),
            budget_pause: AtomicBool::new(false),
            error: Mutex::new(None),
        }
    }
}

impl Host {
    /// Preparation is a proposal receipt only; human approval owns all dispatch.
    pub async fn assistant_handoff_prepare(self: &Arc<Self>, input: crate::assistant_tasks::HandoffPreparation) -> Result<Value, String> {
        let response = self.change_monitors(|monitors| {
            let monitor = monitors.iter().find(|monitor| monitor.workspace_id == input.owner.workspace_id).ok_or("ApexAgent assignment is unavailable.")?;
            if monitor.cwd != input.owner.cwd || monitor.host_id != input.owner.host_id || monitor.conversation_id != input.owner.conversation_id {
                return Err("Handoff belongs to a different project or ApexAgent assignment.".into());
            }
            // Lost-reply recovery survives ordinary monitor revision changes, but
            // cannot move an existing receipt to a replacement owner.
            if let Some(task) = self.assistant_tasks.prepared_handoff(&input).map_err(|e|e.to_string())? { return Ok(json!({"task":task})); }
            if monitor.revision != input.revision { return Err("Handoff monitor revision is stale. Refresh the plan.".into()); }
            if input.request_id.trim().is_empty() || input.request_id.len() > 200 || input.batch_id.trim().is_empty() || input.batch_id.len() > 200 || input.original_request.trim().is_empty() || input.original_request.len() > 16_000 || input.brief.trim().is_empty() || input.brief.len() > 16_000 || input.review_criteria.len() > 20 || input.review_criteria.iter().any(|s| s.trim().is_empty() || s.len() > 2000) || !matches!(input.mode, TaskMode::Isolated | TaskMode::ReadOnly) {
                return Err("Invalid handoff preparation scope.".into());
            }
            let destination = &input.destination;
            if destination.new_thread || destination.workers.is_empty() || destination.workers.len() > 10 || destination.workers.iter().collect::<std::collections::HashSet<_>>().len() != destination.workers.len() {
                return Err("Choose an available saved chat and eligible workers.".into());
            }
            let id = destination.thread_id.as_deref().filter(|id| !id.trim().is_empty()).ok_or("Handoff requires a saved destination chat.")?;
            let saved = self.store().room(id)?.ok_or("Handoff destination chat is unavailable.")?;
            if saved.cwd.as_deref() != Some(input.owner.cwd.as_str()) { return Err("Handoff destination is outside the assigned project.".into()); }
            let workers: Vec<_> = saved.snapshot.participants.iter().filter(|profile| destination.workers.contains(&profile.id.to_string())).cloned().collect();
            if workers.len() != destination.workers.len() { return Err("Handoff contains an unknown destination worker.".into()); }
            verify_task_workers(&workers)?;
            let task = self.assistant_tasks.prepare_handoff(input.clone()).map_err(|e|e.to_string())?;
            Ok(json!({"task":task}))
        })?;
        self.assistant_changed(&input.owner.workspace_id);
        Ok(response)
    }

    pub(crate) fn ensure_task_read_access(&self, id: &str, participant: &ParticipantConfig) -> Result<(), String> {
        if participant.access == apex_core::Access::Read { return Ok(()); }
        if let Some(entry) = self.assistant_tasks.execution(id).map_err(|e| e.to_string())? {
            if self.assistant_tasks.get(&entry.task_id).map_err(|e| e.to_string())?
                .is_some_and(|task| task.mode == TaskMode::ReadOnly)
            { return Err("Read-only assistant tasks cannot grant workers editing access.".into()); }
        }
        Ok(())
    }
    pub async fn assistant_message(
        self: &Arc<Self>,
        input: AssistantMessageInput,
    ) -> Result<Value, String> {
        self.assistant_message_with(input, crate::monitor_check::reason)
            .await
    }

    pub async fn assistant_message_with<F, Fut>(
        self: &Arc<Self>,
        input: AssistantMessageInput,
        reason: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(ParticipantConfig, TurnRequest) -> Fut,
        Fut: Future<Output = Result<String, String>>,
    {
        if input.spend_limit_micros == Some(0) {
            return Err("A spend limit must be greater than zero.".into());
        }
        if input.mode == TaskMode::ReadOnly && !input.checks.is_empty() {
            return Err("Read-only tasks cannot run verification commands. Choose an editing mode to run checks.".into());
        }
        verify_task_workers(&input.new_worker_profiles)?;
        let owner = TaskOwner {
            workspace_id: input.workspace_id.clone(),
            cwd: input.cwd.clone(),
            host_id: input.host_id.clone(),
            conversation_id: input.conversation_id.clone(),
        };
        let monitor = self
            .monitor_get(&owner.workspace_id)?
            .ok_or("ApexAgent is not assigned to this project.")?;
        if monitor.cwd != owner.cwd
            || monitor.host_id != owner.host_id
            || monitor.conversation_id != owner.conversation_id
        {
            return Err(
                "This request belongs to a different project or ApexAgent assignment.".into(),
            );
        }
        let profile = monitor
            .profile
            .clone()
            .ok_or("ApexAgent has no reasoning profile assigned.")?;
        let mut threads = Vec::new();
        for label in &input.thread_labels {
            if label.id.trim().is_empty() {
                continue;
            }
            let saved = self
                .store()
                .room(&label.id)?
                .ok_or_else(|| format!("Saved chat `{}` was not found.", label.id))?;
            if saved.cwd.as_deref().unwrap_or("") != owner.cwd {
                continue;
            }
            let opened_here = if self.handle(&label.id).is_err() {
                self.room_create(
                    label.id.clone(),
                    saved.snapshot.participants.clone(),
                    saved.snapshot.options.clone(),
                    Some(owner.cwd.clone()),
                )?;
                true
            } else {
                false
            };
            let named_only_workers = self.handle(&label.id)?.room.lock().await.named_only_ids();
            if opened_here {
                self.room_close(label.id.clone());
            }
            threads.push(ThreadChoice {
                id: label.id.clone(),
                label: label.label.clone(),
                cwd: owner.cwd.clone(),
                named_only_workers,
                snapshot: saved.snapshot,
            });
        }
        let evidence = monitor
            .messages
            .iter()
            .map(|m| ConversationEvidence {
                id: m.id.clone(),
                label: format!("{} conversation message", m.role),
                text: m.text.clone(),
            })
            .collect();
        let request = ConversationRequest {
            request_id: input.request_id.clone(),
            owner: owner.clone(),
            text: input.text.clone(),
            destination: input.destination.clone(),
            new_worker_profiles: input.new_worker_profiles.clone(),
            worker_profiles: input.worker_profiles.iter().filter(|profile| task_worker_eligible(profile)).cloned().collect(),
            threads,
            evidence,
        };
        // A request recovered from a restart is answered once on a retry with the same ID. A completed one returns its saved response.
        let begin = self
            .assistant_conversations
            .begin(request.clone(), true)
            .map_err(|e| e.to_string())?;
        let record = match begin {
            assistant_conversation::BeginOutcome::Existing(rec) => {
                if rec.status == ConversationStatus::Completed {
                    if let Some(mut response) = rec
                        .response
                        .and_then(|saved| serde_json::from_str::<Value>(&saved).ok())
                    {
                        if let Some(id) = response["task"]["id"].as_str() {
                            if let Some(task) =
                                self.assistant_tasks.get(id).map_err(|e| e.to_string())?
                            {
                                response["task"] =
                                    serde_json::to_value(&task).map_err(|e| e.to_string())?;
                                response["taskMonitor"] = task_monitor(Some(&task));
                                if task.status == TaskStatus::Queued && task.attempts.is_empty() {
                                    if let Some(destination) = task.destination.clone() {
                                        let checks = task
                                            .result_data
                                            .as_ref()
                                            .and_then(|data| data["checks"].as_array())
                                            .map(|checks| {
                                                checks
                                                    .iter()
                                                    .cloned()
                                                    .filter_map(|v| serde_json::from_value(v).ok())
                                                    .collect()
                                            })
                                            .unwrap_or_default();
                                        let replay_profiles: Vec<ParticipantConfig> = task.result_data.as_ref()
                                            .and_then(|data| serde_json::from_value(data["workerProfiles"].clone()).ok()).unwrap_or_default();
                                        let replay_input = AssistantMessageInput {
                                            workspace_id: owner.workspace_id.clone(),
                                            cwd: owner.cwd.clone(),
                                            host_id: owner.host_id.clone(),
                                            conversation_id: owner.conversation_id.clone(),
                                            request_id: task.id.clone(),
                                            text: task.original_request.clone(),
                                            destination: Some(destination.clone()),
                                            new_worker_profiles: replay_profiles.clone(),
                                            thread_labels: vec![],
                                            mode: task
                                                .result_data
                                                .as_ref()
                                                .and_then(|data| {
                                                    serde_json::from_value(data["mode"].clone())
                                                        .ok()
                                                })
                                                .unwrap_or(task.mode),
                                            checks,
                                            worker_profiles: rec.request.worker_profiles.clone(),
                                            spend_limit_micros: task.result_data.as_ref().and_then(|data| data["spendLimitMicros"].as_u64()),
                                        };
                                        let child = self.schedule_dispatch(
                                            &task,
                                            &owner,
                                            replay_input,
                                            destination.thread_id.clone().unwrap_or_default(),
                                            task.workers.clone(),
                                            replay_profiles,
                                        );
                                        response["pane"]["id"] = json!(child);
                                    }
                                }
                                if let Some(child) = task.execution_thread_id.as_deref() {
                                    response["pane"]["id"] = json!(child);
                                }
                                if let Some(path) = task
                                    .result_data
                                    .as_ref()
                                    .and_then(|data| data["executionPath"].as_str())
                                {
                                    response["pane"]["executionPath"] = json!(path);
                                }
                            }
                        }
                        response["monitor"] = serde_json::to_value(
                            self.monitor_get(&owner.workspace_id)?
                                .ok_or("ApexAgent assignment disappeared.")?,
                        )
                        .map_err(|e| e.to_string())?;
                        return Ok(response);
                    }
                    return Err("The completed assistant request has no response record.".into());
                }
                return Err("This request is already being processed. Wait for it to finish before sending it again.".into());
            }
            assistant_conversation::BeginOutcome::Started(rec) => rec,
        };
        // A retry of a request that already created its task answers with that task. It never creates a second one.
        if let Some(task_id) = record.task_id.clone() {
            if self.assistant_tasks.get(&task_id).map_err(|e| e.to_string())?.is_some() {
                let saved = json!({"message":"This request already created its task. Showing that task.","task":{"id":task_id},"taskMonitor":Value::Null,"pane":Value::Null});
                self.assistant_conversations
                    .finish(&input.request_id, &owner, record.revision, saved.to_string())
                    .map_err(|e| e.to_string())?;
                return Box::pin(self.assistant_message_with(input, reason)).await;
            }
        }
        self.monitor_chat_message_owned(
            &owner.workspace_id,
            crate::monitor_commands::MonitorOwner {
                cwd: owner.cwd.clone(),
                host_id: owner.host_id.clone(),
                conversation_id: owner.conversation_id.clone(),
            },
            "human",
            &input.text,
        )?;
        let latest = self
            .monitor_get(&owner.workspace_id)?
            .ok_or("ApexAgent assignment disappeared.")?;
        if latest.cwd != owner.cwd
            || latest.host_id != owner.host_id
            || latest.conversation_id != owner.conversation_id
            || latest.profile.as_ref() != Some(&profile)
        {
            return Err("ApexAgent's assignment changed while it was considering this request. Please submit it again.".into());
        }
        let raw = match reason(profile, assistant_conversation::prompt(&request)).await {
            Ok(raw) => raw,
            Err(err) => {
                let message = format!("I couldn't assess that request: {err}");
                self.monitor_chat_message_owned(
                    &owner.workspace_id,
                    crate::monitor_commands::MonitorOwner {
                        cwd: owner.cwd.clone(),
                        host_id: owner.host_id.clone(),
                        conversation_id: owner.conversation_id.clone(),
                    },
                    "assistant",
                    &message,
                )?;
                let response = json!({"message":message,"task":Value::Null,"taskMonitor":Value::Null,"pane":Value::Null,"monitor":self.monitor_get(&owner.workspace_id)?});
                self.assistant_conversations
                    .finish(
                        &input.request_id,
                        &owner,
                        record.revision,
                        serde_json::to_string(&response).map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                return Ok(response);
            }
        };
        let latest = self
            .monitor_get(&owner.workspace_id)?
            .ok_or("ApexAgent assignment disappeared.")?;
        if latest.cwd != owner.cwd
            || latest.host_id != owner.host_id
            || latest.conversation_id != owner.conversation_id
            || latest.profile.as_ref() != monitor.profile.as_ref()
        {
            return Err("ApexAgent's assignment changed while it was considering this request. Please submit it again.".into());
        }
        let intent = match assistant_conversation::parse_intent(&raw) {
            Ok(intent) => intent,
            Err(error) => {
                let message = format!("I couldn't interpret that request safely: {error}");
                self.monitor_chat_message_owned(
                    &owner.workspace_id,
                    crate::monitor_commands::MonitorOwner {
                        cwd: owner.cwd.clone(),
                        host_id: owner.host_id.clone(),
                        conversation_id: owner.conversation_id.clone(),
                    },
                    "assistant",
                    &message,
                )?;
                let response = json!({"message":message,"task":Value::Null,"taskMonitor":Value::Null,"pane":Value::Null,"monitor":self.monitor_get(&owner.workspace_id)?});
                self.assistant_conversations
                    .finish(
                        &input.request_id,
                        &owner,
                        record.revision,
                        serde_json::to_string(&response).map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                return Ok(response);
            }
        };
        let decision = assistant_conversation::authorize(&request, intent);
        let mut output = match decision {
            assistant_conversation::ConversationDecision::Answer { message } => {
                json!({"message":message,"task":Value::Null,"taskMonitor":Value::Null})
            }
            assistant_conversation::ConversationDecision::Clarify { message, brief } => {
                let mut task = self
                    .assistant_tasks
                    .submit_human_request(
                        HumanRequest {
                            request_id: input.request_id.clone(),
                            owner: owner.clone(),
                            text: input.text.clone(),
                            destination: input.destination.clone(),
                        },
                        brief.unwrap_or_default(),
                        None,
                    )
                    .map_err(|e| e.to_string())?;
                self.assistant_conversations.attach_task(&input.request_id, &owner, &task.id).map_err(|e| e.to_string())?;
                task = self.assistant_tasks.set_result_data(&task.id, task.revision, &owner, Some(initial_task_data(&input, &[]))).map_err(|e|e.to_string())?;
                self.assistant_changed(&owner.workspace_id);
                json!({"message":message,"task":task,"taskMonitor":task_monitor(Some(&task)),"pane":Value::Null})
            }
            assistant_conversation::ConversationDecision::Proposal { message, brief } => {
                let mut task = self
                    .assistant_tasks
                    .create_proposal(owner.clone(), input.text.clone(), brief)
                    .map_err(|e| e.to_string())?;
                self.assistant_conversations.attach_task(&input.request_id, &owner, &task.id).map_err(|e| e.to_string())?;
                task = self.assistant_tasks.set_result_data(&task.id, task.revision, &owner, Some(initial_task_data(&input, &[]))).map_err(|e|e.to_string())?;
                self.assistant_changed(&owner.workspace_id);
                json!({"message":message,"task":task,"taskMonitor":task_monitor(Some(&task)),"pane":Value::Null})
            }
            assistant_conversation::ConversationDecision::Handoff {
                message,
                brief,
                thread_id,
                workers,
                review_criteria,
                new_thread,
                worker_profiles,
            } => {
                let destination = TaskDestination {
                    thread_id: (!new_thread).then_some(thread_id.clone()),
                    workers: workers.clone(),
                    new_thread,
                };
                let mut task = self
                    .assistant_tasks
                    .submit_human_request(
                        HumanRequest {
                            request_id: input.request_id.clone(),
                            owner: owner.clone(),
                            text: input.text.clone(),
                            destination: input.destination.clone(),
                        },
                        brief.clone(),
                        Some(destination),
                    )
                    .map_err(|e| e.to_string())?;
                self.assistant_conversations.attach_task(&input.request_id, &owner, &task.id).map_err(|e| e.to_string())?;
                task = self
                    .assistant_tasks
                    .set_task_details(
                        &task.id,
                        task.revision,
                        &owner,
                        brief.clone(),
                        vec![],
                        review_criteria,
                        workers.clone(),
                    )
                    .map_err(|e| e.to_string())?;
                task = self.assistant_tasks.set_result_data(&task.id, task.revision, &owner, Some(initial_task_data(&input, &worker_profiles))).map_err(|e|e.to_string())?;
                self.assistant_changed(&owner.workspace_id);
                let child_id = self.schedule_dispatch(
                    &task,
                    &owner,
                    input.clone(),
                    thread_id.clone(),
                    workers.clone(),
                    worker_profiles.clone(),
                );
                let mut pane_participants = if new_thread {
                    worker_profiles.clone()
                } else {
                    request
                        .threads
                        .iter()
                        .find(|thread| thread.id == thread_id)
                        .map(|thread| {
                            thread
                                .snapshot
                                .participants
                                .iter()
                                .filter(|profile| workers.contains(&profile.id.to_string()))
                                .cloned()
                                .collect()
                        })
                        .unwrap_or_default()
                };
                enforce_read_only(input.mode, &mut pane_participants);
                let pane_options = if new_thread {
                    apex_core::RoomOptions {
                        policy: apex_core::TurnPolicy::RoundRobin,
                        max_bot_hops: 0,
                    }
                } else {
                    request
                        .threads
                        .iter()
                        .find(|thread| thread.id == thread_id)
                        .map(|thread| thread.snapshot.options.clone())
                        .unwrap_or_default()
                };
                let pane_path = if input.mode == TaskMode::Isolated {
                    self.assistant_data_dir()
                        .join("apex-agent")
                        .join("tasks")
                        .join(&task.id)
                        .join("worktree")
                        .to_string_lossy()
                        .to_string()
                } else {
                    owner.cwd.clone()
                };
                let pane = json!({"id":child_id,"workspaceId":owner.workspace_id,"kind":"chat","title":format!("Assistant task {}",task.id),"participants":pane_participants,"options":pane_options,"started":false,"assistantTaskId":task.id,"hostId":owner.host_id,"executionPath":pane_path});
                json!({"message":message,"task":task,"taskMonitor":task_monitor(Some(&task)),"pane":pane})
            }
        };
        if let Some(message) = output["message"].as_str() {
            self.monitor_chat_message_owned(
                &owner.workspace_id,
                crate::monitor_commands::MonitorOwner {
                    cwd: owner.cwd.clone(),
                    host_id: owner.host_id.clone(),
                    conversation_id: owner.conversation_id.clone(),
                },
                "assistant",
                message,
            )?;
        }
        output["monitor"] = serde_json::to_value(
            self.monitor_get(&owner.workspace_id)?
                .ok_or("ApexAgent assignment disappeared.")?,
        )
        .map_err(|e| e.to_string())?;
        let saved_response = serde_json::to_string(&output).map_err(|e| e.to_string())?;
        self.assistant_conversations
            .finish(&input.request_id, &owner, record.revision, saved_response)
            .map_err(|e| e.to_string())?;
        Ok(output)
    }

    fn schedule_dispatch(
        self: &Arc<Self>,
        task: &AssistantTask,
        owner: &TaskOwner,
        input: AssistantMessageInput,
        parent: String,
        workers: Vec<String>,
        profiles: Vec<ParticipantConfig>,
    ) -> String {
        let child_id = task
            .execution_thread_id
            .clone()
            .unwrap_or_else(|| format!("assistant-{}", task.id));
        if self.assistant_runs.lock().unwrap().contains_key(&task.id) {
            return child_id;
        }
        let run = Arc::new(AssistantRun::new());
        {
            use std::collections::hash_map::Entry;
            let mut runs = self.assistant_runs.lock().unwrap();
            match runs.entry(task.id.clone()) {
                Entry::Occupied(_) => return child_id,
                Entry::Vacant(entry) => {
                    entry.insert(run.clone());
                }
            }
        }
        let host = Arc::clone(self);
        let task = task.clone();
        let owner = owner.clone();
        let child = child_id.clone();
        self.runtime().spawn(async move {
            if let Err(error) = host
                .dispatch_task(
                    task.clone(),
                    &owner,
                    &input,
                    parent,
                    workers,
                    profiles,
                    child,
                    run.clone(),
                )
                .await
            {
                host.fail_dispatch(&task, &owner, error, &run);
            }
        });
        child_id
    }

    async fn dispatch_task(
        self: &Arc<Self>,
        mut task: AssistantTask,
        owner: &TaskOwner,
        input: &AssistantMessageInput,
        parent_id: String,
        workers: Vec<String>,
        profiles: Vec<ParticipantConfig>,
        child_id: String,
        run: Arc<AssistantRun>,
    ) -> Result<(), String> {
        let is_new_thread = task
            .destination
            .as_ref()
            .is_some_and(|destination| destination.new_thread);
        let parent = if is_new_thread {
            None
        } else {
            let parent = match self.handle(&parent_id) {
                Ok(parent) => parent,
                Err(_) => {
                    let saved = self
                        .store()
                        .room(&parent_id)?
                        .ok_or("Selected destination chat was not found.")?;
                    if saved.cwd.as_deref() != Some(owner.cwd.as_str()) {
                        return Err("Selected thread is not in the assigned project.".into());
                    }
                    let available: std::collections::HashSet<_> = saved
                        .snapshot
                        .participants
                        .iter()
                        .map(|profile| profile.id.to_string())
                        .collect();
                    if workers.iter().any(|worker| !available.contains(worker)) {
                        return Err(
                            "Every selected worker must belong to the destination chat.".into()
                        );
                    }
                    // Rehydrate from this host's saved room before forking it.
                    // A task retry after app restart must not depend on the
                    // original window still having a live runtime handle.
                    self.room_create(
                        parent_id.clone(),
                        Vec::new(),
                        saved.snapshot.options.clone(),
                        Some(owner.cwd.clone()),
                    )?;
                    self.handle(&parent_id)?
                }
            };
            if parent
                .context
                .cwd
                .as_deref()
                .is_none_or(|cwd| cwd.to_string_lossy() != owner.cwd)
            {
                return Err("Selected thread is not in the assigned project.".into());
            }
            Some(parent)
        };
        if input.mode == TaskMode::Isolated {
            return self
                .dispatch_isolated_task(
                    task, owner, input, parent_id, parent, workers, profiles, child_id, run,
                )
                .await;
        }
        let gate = self.checkout_gate(Path::new(&owner.cwd));
        let _lease = if input.mode == TaskMode::ReadOnly { None } else { Some(gate
            .acquire_retained(task.id.clone(), run.stop.clone())
            .await
            .map_err(|e| format!("Could not reserve checkout: {e:?}"))?) };
        let mut baseline_data = task.result_data.clone().unwrap_or_else(|| initial_task_data(&input, &profiles));
        baseline_data["leaseHeld"] = json!(input.mode != TaskMode::ReadOnly);
        baseline_data["executionPath"] = json!(owner.cwd);
        if input.mode != TaskMode::ReadOnly {
            let baseline = assistant_git::capture(Path::new(&owner.cwd), &task.id, "baseline")?;
            baseline_data["baselineSnapshot"] = json!(baseline);
            baseline_data["exclusions"] = json!(baseline.exclusions);
        }
        task = self
            .assistant_tasks
            .set_result_data(&task.id, task.revision, owner, Some(baseline_data.clone()))
            .map_err(|e| e.to_string())?;
        let already_bound = task.execution_thread_id.as_deref() == Some(child_id.as_str());
        if task
            .execution_thread_id
            .as_ref()
            .is_some_and(|bound| bound != &child_id)
        {
            return Err("This task is already bound to another execution thread.".into());
        }
        if self
            .assistant_tasks
            .execution(&child_id)
            .map_err(|e| e.to_string())?
            .is_some_and(|entry| entry.is_tombstoned())
        {
            return Err("This execution chat was deleted and cannot be reused.".into());
        }
        let restored_child = if already_bound {
            self.store().room(&child_id)?
        } else {
            None
        };
        if restored_child
            .as_ref()
            .is_some_and(|saved| saved.cwd.as_deref() != Some(owner.cwd.as_str()))
        {
            return Err("Saved execution chat belongs to a different project.".into());
        }
        let (child_snapshot, new_room) = if let Some(saved) = restored_child {
            (Some(saved.snapshot), None)
        } else if already_bound && is_new_thread {
            let profile_ids: std::collections::HashSet<_> = profiles
                .iter()
                .map(|profile| profile.id.to_string())
                .collect();
            let worker_ids: std::collections::HashSet<_> = workers.iter().cloned().collect();
            if profiles.is_empty() || profile_ids != worker_ids {
                return Err(
                    "A new execution chat needs an explicitly selected profile for each worker."
                        .into(),
                );
            }
            let mut options = apex_core::RoomOptions::default();
            options.policy = apex_core::TurnPolicy::RoundRobin;
            options.max_bot_hops = 0;
            (None, Some((profiles, options)))
        } else if already_bound {
            return Err("The saved execution chat for this task is missing.".into());
        } else if let Some(parent) = &parent {
            let parent_snapshot = parent.checkpoint.lock().unwrap().snapshot.clone();
            let mut child_snapshot = parent_snapshot.fork(parent_snapshot.transcript.len());
            child_snapshot
                .participants
                .retain(|p| workers.contains(&p.id.to_string()));
            enforce_read_only(input.mode, &mut child_snapshot.participants);
            if child_snapshot.participants.is_empty() {
                return Err("No selected worker is available in the saved thread.".into());
            }
            if !already_bound {
                self.room_import(
                    child_id.clone(),
                    child_snapshot.clone(),
                    Some(owner.cwd.clone()),
                    false,
                )?;
            }
            (Some(child_snapshot), None)
        } else {
            let profile_ids: std::collections::HashSet<_> = profiles
                .iter()
                .map(|profile| profile.id.to_string())
                .collect();
            let worker_ids: std::collections::HashSet<_> = workers.iter().cloned().collect();
            if profiles.is_empty() || profile_ids != worker_ids {
                return Err(
                    "A new execution chat needs an explicitly selected profile for each worker."
                        .into(),
                );
            }
            let mut options = apex_core::RoomOptions::default();
            options.policy = apex_core::TurnPolicy::RoundRobin;
            options.max_bot_hops = 0;
            (None, Some((profiles, options)))
        };
        task = self
            .assistant_tasks
            .bind_execution(
                &task.id,
                task.revision,
                owner,
                child_id.clone(),
                input.mode,
                Some(baseline_data),
            )
            .map_err(|e| e.to_string())?;
        if let Some(mut snapshot) = child_snapshot {
            enforce_read_only(input.mode, &mut snapshot.participants);
            verify_read_only_workers(input.mode, &snapshot.participants)?;
            self.room_create(
                child_id.clone(),
                snapshot.participants.clone(),
                snapshot.options.clone(),
                Some(owner.cwd.clone()),
            )?;
        }
        if let Some((mut profiles, options)) = new_room {
            enforce_read_only(input.mode, &mut profiles);
            verify_read_only_workers(input.mode, &profiles)?;
            self.room_create(child_id.clone(), profiles, options, Some(owner.cwd.clone()))?;
        }
        let (task, run_id) = self
            .assistant_tasks
            .begin_attempt(&task.id, task.revision, owner)
            .map_err(|e| e.to_string())?;
        *self.handle(&child_id)?.task_run_id.lock().unwrap() = Some(run_id.clone());
        if !parent_id.is_empty() {
            self.append_assistant_note(
                &parent_id,
                format!(
                    "Assistant task {} started in linked chat {}. Request: {}\nBrief: {}",
                    task.id, child_id, task.original_request, task.brief
                ),
            )
            .await?;
        }
        // Keep the durable reservation, but let the child room acquire the
        // active lease for each run segment. Holding this guard here deadlocks
        // the child against its own retained checkout reservation.
        drop(_lease);
        let targets = workers.iter().map(ParticipantId::new).collect();
        let handle = self.handle(&child_id)?;
        let batch = self.prepare_post(&child_id, &handle, &task_start_prompt(&task), Some(targets), false).await?;
        spawn_task_attempt(
            Arc::clone(self),
            task.id.clone(),
            run_id,
            owner.clone(),
            child_id,
            handle,
            batch,
            run,
            None,
        );
        Ok(())
    }

    async fn dispatch_isolated_task(
        self: &Arc<Self>,
        mut task: AssistantTask,
        owner: &TaskOwner,
        input: &AssistantMessageInput,
        parent_id: String,
        parent: Option<crate::host::RoomHandle>,
        workers: Vec<String>,
        profiles: Vec<ParticipantConfig>,
        child_id: String,
        run: Arc<AssistantRun>,
    ) -> Result<(), String> {
        let mut stop = run.stop_tx.subscribe();
        let gate = self.checkout_gate(Path::new(&owner.cwd));
        let lease = gate
            .acquire(task.id.clone(), run.stop.clone())
            .await
            .map_err(|e| format!("Could not capture the isolated task baseline: {e:?}"))?;
        let baseline = assistant_git::capture(Path::new(&owner.cwd), &task.id, "baseline")?;
        drop(lease);
        let mut startup_data = task.result_data.clone().unwrap_or_else(|| json!({}));
        startup_data["mode"] = json!(TaskMode::Isolated);
        startup_data["checks"] = json!(input.checks);
        startup_data["workerProfiles"] =
            serde_json::to_value(&profiles).map_err(|e| e.to_string())?;
        startup_data["executionPath"] = json!(owner.cwd);
        startup_data["baselineSnapshot"] =
            serde_json::to_value(&baseline).map_err(|e| e.to_string())?;
        startup_data["leaseHeld"] = json!(false);
        task = self
            .assistant_tasks
            .set_result_data(&task.id, task.revision, owner, Some(startup_data))
            .map_err(|e| e.to_string())?;
        let _permit = self
            .assistant_isolated_slots
            .acquire(Path::new(&owner.cwd).to_path_buf(), &mut stop)
            .await?;
        let selected_profiles = if parent.is_some() || profiles.is_empty() {
            let snapshot = parent
                .as_ref()
                .ok_or("Choose explicit worker profiles for a new execution chat.")?
                .checkpoint
                .lock()
                .unwrap()
                .snapshot
                .clone();
            snapshot
                .participants
                .into_iter()
                .filter(|profile| workers.contains(&profile.id.to_string()))
                .collect::<Vec<_>>()
        } else {
            profiles
        };
        let prepared = match crate::assistant_isolation::prepare(
            &baseline,
            &task.id,
            self.assistant_data_dir(),
            &selected_profiles,
            &mut stop,
        )
        .await
        {
            Ok(prepared) => prepared,
            Err(needs_you) => {
                let mut data = task.result_data.clone().unwrap_or_else(|| json!({}));
                data["startup"] = serde_json::to_value(&needs_you).map_err(|e| e.to_string())?;
                data["baselineSnapshot"] =
                    serde_json::to_value(&baseline).map_err(|e| e.to_string())?;
                data["checks"] = json!(input.checks);
                data["executionPath"] = json!(owner.cwd);
                data["leaseHeld"] = json!(false);
                task = self
                    .assistant_tasks
                    .set_result_data(&task.id, task.revision, owner, Some(data))
                    .map_err(|e| e.to_string())?;
                task = self
                    .assistant_tasks
                    .transition(
                        &task.id,
                        task.revision,
                        owner,
                        TaskStatus::NeedsYou,
                        Some(needs_you.message.clone()),
                    )
                    .map_err(|e| e.to_string())?;
                let _ = task;
                self.assistant_runs.lock().unwrap().remove(&task.id);
                run.finished.store(true, Ordering::SeqCst);
                run.done.notify_waiters();
                self.assistant_changed(&owner.workspace_id);
                return Ok(());
            }
        };
        let worktree = prepared.path.to_string_lossy().to_string();
        let mut result_data = task.result_data.clone().unwrap_or_else(|| json!({}));
        result_data["baselineSnapshot"] =
            serde_json::to_value(&baseline).map_err(|e| e.to_string())?;
        result_data["checks"] = json!(input.checks);
        result_data["executionPath"] = json!(worktree);
        result_data["cargoTargetDir"] = json!(prepared.setup.cargo_target_dir);
        result_data["isolatedSetup"] =
            serde_json::to_value(&prepared.setup).map_err(|e| e.to_string())?;
        result_data["workerReadiness"] =
            serde_json::to_value(&prepared.workers).map_err(|e| e.to_string())?;
        result_data["leaseHeld"] = json!(false);
        task = self
            .assistant_tasks
            .set_result_data(&task.id, task.revision, owner, Some(result_data.clone()))
            .map_err(|e| e.to_string())?;
        let parent_thread = parent
            .as_ref()
            .map(|room| room.checkpoint.lock().unwrap().snapshot.clone());
        let (participants, options) = if let Some(snapshot) = parent_thread {
            let mut fork = snapshot.fork(snapshot.transcript.len());
            fork.participants
                .retain(|profile| workers.contains(&profile.id.to_string()));
            if fork.participants.is_empty() {
                return Err("No selected worker is available in the destination chat.".into());
            }
            if self.store().room(&child_id)?.is_none() {
                self.room_import(
                    child_id.clone(),
                    fork.clone(),
                    Some(worktree.clone()),
                    false,
                )?;
            }
            (fork.participants, fork.options)
        } else {
            if selected_profiles.is_empty() {
                return Err(
                    "Choose at least one worker before starting isolated execution.".into(),
                );
            }
            let mut options = apex_core::RoomOptions::default();
            options.policy = apex_core::TurnPolicy::RoundRobin;
            options.max_bot_hops = 0;
            (selected_profiles, options)
        };
        task = self
            .assistant_tasks
            .bind_execution(
                &task.id,
                task.revision,
                owner,
                child_id.clone(),
                TaskMode::Isolated,
                Some(result_data),
            )
            .map_err(|e| e.to_string())?;
        self.room_create(child_id.clone(), participants, options, Some(worktree))
            .map_err(|e| e.to_string())?;
        let (task, run_id) = self
            .assistant_tasks
            .begin_attempt(&task.id, task.revision, owner)
            .map_err(|e| e.to_string())?;
        *self.handle(&child_id)?.task_run_id.lock().unwrap() = Some(run_id.clone());
        if !parent_id.is_empty() {
            self.append_assistant_note(
                &parent_id,
                format!(
                    "Assistant task {} started in an isolated chat {}. Request: {}\nBrief: {}",
                    task.id, child_id, task.original_request, task.brief
                ),
            )
            .await?;
        }
        let handle = self.handle(&child_id)?;
        let targets = workers.iter().map(ParticipantId::new).collect();
        let content = task_start_prompt(&task);
        let batch = self
            .prepare_post(&child_id, &handle, &content, Some(targets), false)
            .await?;
        spawn_task_attempt(
            Arc::clone(self),
            task.id.clone(),
            run_id,
            owner.clone(),
            child_id,
            handle,
            batch,
            run,
            Some(_permit),
        );
        Ok(())
    }

    /// Dispatch every task that was queued and never started when the service stopped.
    /// Call once at startup, before any new request arrives.
    pub(crate) fn redispatch_recovered_queued(self: &Arc<Self>) -> Result<(), String> {
        for task in self.assistant_tasks.list(None).map_err(|e| e.to_string())? {
            if task.status != TaskStatus::Queued || !task.attempts.is_empty() {
                continue;
            }
            let Some(destination) = task.destination.clone() else { continue };
            let owner = task.owner.clone();
            let data = task.result_data.clone().unwrap_or_else(|| json!({}));
            let profiles: Vec<ParticipantConfig> =
                serde_json::from_value(data["workerProfiles"].clone()).unwrap_or_default();
            let input = AssistantMessageInput {
                workspace_id: owner.workspace_id.clone(),
                cwd: owner.cwd.clone(),
                host_id: owner.host_id.clone(),
                conversation_id: owner.conversation_id.clone(),
                request_id: task.id.clone(),
                text: task.original_request.clone(),
                destination: Some(destination.clone()),
                new_worker_profiles: profiles.clone(),
                thread_labels: vec![],
                mode: serde_json::from_value(data["mode"].clone()).unwrap_or(task.mode),
                checks: serde_json::from_value(data["checks"].clone()).unwrap_or_default(),
                worker_profiles: vec![],
                spend_limit_micros: data["spendLimitMicros"].as_u64(),
            };
            self.schedule_dispatch(
                &task,
                &owner,
                input,
                destination.thread_id.clone().unwrap_or_default(),
                destination.workers.clone(),
                profiles,
            );
        }
        Ok(())
    }

    fn fail_dispatch(
        &self,
        queued: &AssistantTask,
        owner: &TaskOwner,
        error: String,
        run: &Arc<AssistantRun>,
    ) {
        if let Ok(Some(task)) = self.assistant_tasks.get(&queued.id) {
            if task.status == TaskStatus::Queued {
                let _ = self.assistant_tasks.transition(
                    &task.id,
                    task.revision,
                    owner,
                    TaskStatus::Failed,
                    Some(error.clone()),
                );
            } else if task.status == TaskStatus::Running {
                if let Some(attempt) = task.attempts.last() {
                    let _ = self.assistant_tasks.finish_attempt(
                        &task.id,
                        &attempt.run_id,
                        TaskOutcome {
                            status: TaskStatus::Failed,
                            result: Some(error.clone()),
                            result_data: task.result_data.clone(),
                            usage: None,
                        },
                    );
                }
            }
        }
        if self
            .checkout_gate(Path::new(&owner.cwd))
            .release(&queued.id)
        {
            if let Ok(Some(task)) = self.assistant_tasks.get(&queued.id) {
                if let Some(mut data) = task.result_data.clone() {
                    data["leaseHeld"] = json!(false);
                    let _ = self.assistant_tasks.set_result_data(
                        &task.id,
                        task.revision,
                        owner,
                        Some(data),
                    );
                }
            }
        }
        self.assistant_runs.lock().unwrap().remove(&queued.id);
        *run.error.lock().unwrap() = Some(error);
        run.finished.store(true, Ordering::SeqCst);
        run.done.notify_waiters();
        self.assistant_changed(&owner.workspace_id);
    }

    /// Intercept a human post into an assistant-owned execution thread so a
    /// review continuation becomes a new, durable run and invalidates the old
    /// review snapshot. Questions and approvals must be answered through their
    /// scoped room desk before a new task attempt can start.
    pub(crate) async fn assistant_continue_thread(
        self: &Arc<Self>,
        id: &str,
        text: Option<String>,
        targets: Vec<ParticipantId>,
        _hops: Option<usize>,
    ) -> Result<bool, String> {
        self.continue_thread_expected(id, text, targets, None).await
    }

    async fn continue_thread_expected(
        self: &Arc<Self>,
        id: &str,
        text: Option<String>,
        targets: Vec<ParticipantId>,
        expected_revision: Option<u64>,
    ) -> Result<bool, String> {
        // Ordinary chats do not participate in task integration. Let their
        // read turns continue while another task is being accepted.
        if self.assistant_tasks.execution(id).map_err(|e| e.to_string())?.is_none() {
            return Ok(false);
        }
        let _lifecycle_lock = self.assistant_apply.lock().await;
        let Some(entry) = self
            .assistant_tasks
            .execution(id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(false);
        };
        let task = self
            .assistant_tasks
            .get(&entry.task_id)
            .map_err(|e| e.to_string())?
            .ok_or("The assistant task for this chat is missing.")?;
        if expected_revision.is_some_and(|revision| revision != task.revision) {
            return Err("Task ownership or revision is stale.".into());
        }
        if task.execution_thread_id.as_deref() != Some(id) {
            return Err(
                "This chat is not the current execution thread for its assistant task.".into(),
            );
        }
        if task.status == TaskStatus::Interrupted && has_pending_integration(&task) {
            return Err(
                "Reconcile the interrupted project integration before continuing this task.".into(),
            );
        }
        match task.status {
            TaskStatus::ReadyForReview | TaskStatus::Failed | TaskStatus::Interrupted => {}
            TaskStatus::NeedsYou if task.result_data.as_ref().is_some_and(|data| data["budgetPaused"] == true || data["restartedWhileWaiting"] == true)
                && task.attempts.last().is_some_and(|attempt| attempt.finished_at_ms.is_some()) => {},
            TaskStatus::NeedsYou => return Err("Answer the worker's open question or approval first, or cancel the current attempt.".into()),
            TaskStatus::Running | TaskStatus::Applying => return Err("This assistant task is still running.".into()),
            _ => return Err("This assistant task cannot be continued in its current state.".into()),
        }
        if budget_exceeded(&task) {
            return Err("Raise or remove this task's spend limit, or resume it from its pause to accept an unreported cost, before resuming.".into());
        }
        let monitor = self
            .monitor_get(&task.owner.workspace_id)?
            .ok_or("ApexAgent assignment disappeared.")?;
        if monitor.cwd != task.owner.cwd
            || monitor.host_id != task.owner.host_id
            || monitor.conversation_id != task.owner.conversation_id
        {
            return Err("This task belongs to a previous ApexAgent assignment.".into());
        }
        let handle = match self.handle(id) {
            Ok(handle) => handle,
            Err(_) => {
                let saved = self.store().room(id)?.ok_or("The task's saved execution chat is missing.")?;
                let mut participants = saved.snapshot.participants;
                enforce_read_only(task.mode, &mut participants);
                verify_read_only_workers(task.mode, &participants)?;
                self.room_create(id.to_string(), participants, saved.snapshot.options, saved.cwd)?;
                self.handle(id)?
            }
        };
        if handle.runtime.busy() {
            return Err(
                "Wait for the current worker turn to finish before continuing this task.".into(),
            );
        }
        let current = self.assistant_tasks.get(&task.id).map_err(|e| e.to_string())?.ok_or("The assistant task for this chat is missing.")?;
        let has_live_wait = handle.has_pending_human_waits();
        let has_persisted_wait = current.result_data.as_ref().is_some_and(|data| {
            data["pendingApprovals"].as_array().is_some_and(|waits| !waits.is_empty())
                || data["pendingQuestions"].as_array().is_some_and(|waits| !waits.is_empty())
        });
        if has_live_wait || has_persisted_wait {
            return Err("Answer the worker's open question or approval first, or cancel the current attempt.".into());
        }
        let allowed: std::collections::HashSet<_> =
            task.workers.iter().map(|id| id.as_str()).collect();
        if targets
            .iter()
            .any(|target| !allowed.contains(target.as_str()))
        {
            return Err("A continuation can only target workers selected for this task.".into());
        }
        let selected = if targets.is_empty() {
            task.workers
                .iter()
                .cloned()
                .map(ParticipantId::new)
                .collect::<Vec<_>>()
        } else {
            targets
        };
        if selected.is_empty() {
            return Err("This task has no authorized worker to continue.".into());
        }
        self.recover_worker_cleanup(id)?;
        self.recover_task_operations(&task.id)?;
        let run = Arc::new(AssistantRun::new());
        let isolated = task.mode == TaskMode::Isolated;
        let isolated_permit = if isolated {
            let mut stop = run.stop_tx.subscribe();
            let permit = self
                .assistant_isolated_slots
                .acquire(Path::new(&task.owner.cwd).to_path_buf(), &mut stop)
                .await?;
            let room_profiles = handle
                .checkpoint
                .lock()
                .unwrap()
                .snapshot
                .participants
                .clone();
            let process_dir = crate::assistant_isolation::operation_process_dir(
                self.assistant_data_dir(),
                &task.id,
            )?;
            let registry = OwnedProcessRegistry::new(Some(process_dir));
            crate::assistant_isolation::verify_workers_with_registry(
                &room_profiles,
                &mut stop,
                &registry,
            )
            .await
            .map_err(|needs_you| needs_you.message)?;
            Some(permit)
        } else {
            None
        };
        let gate = self.checkout_gate(Path::new(&task.owner.cwd));
        let lease = if isolated || task.mode == TaskMode::ReadOnly {
            None
        } else {
            Some(
                gate.acquire_retained(task.id.clone(), run.stop.clone())
                    .await
                    .map_err(|e| format!("Could not reserve checkout: {e:?}"))?,
            )
        };
        let work_path = task
            .result_data
            .as_ref()
            .and_then(|data| data["executionPath"].as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&task.owner.cwd));
        let baseline = if task.mode == TaskMode::ReadOnly { None } else { Some(assistant_git::capture(&work_path, &task.id, "baseline")?) };
        let (mut next, run_id) = self
            .assistant_tasks
            .begin_attempt(&task.id, task.revision, &task.owner)
            .map_err(|e| e.to_string())?;
        let mut data = next.result_data.clone().unwrap_or_else(|| json!({}));
        if let Some(baseline) = baseline { data["attemptBaselineSnapshot"] = json!(baseline); }
        data["leaseHeld"] = json!(task.mode == TaskMode::InPlace);
        if let Some(text) = text.as_ref().filter(|text| !text.trim().is_empty()) { append_history(&mut data, "revision", text); }
        data.as_object_mut().map(|m| {
            m.remove("resultSnapshot");
            m.remove("diff");
        });
        next = self
            .assistant_tasks
            .set_result_data(&next.id, next.revision, &next.owner, Some(data))
            .map_err(|e| e.to_string())?;
        *handle.task_run_id.lock().unwrap() = Some(run_id.clone());
        *handle.task_error.lock().unwrap() = None;
        self.assistant_runs
            .lock()
            .unwrap()
            .insert(task.id.clone(), run.clone());
        self.append_assistant_note(
            task.parent_thread_id.as_deref().unwrap_or(id),
            format!(
                "Assistant task {} started attempt {} from a human continuation.",
                task.id,
                next.attempts.len()
            ),
        )
        .await?;
        drop(lease);
        let mut content = text
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("Continue the original request: {}", task.original_request));
        if let Some(notes) = next.result_data.as_ref().and_then(|data| data["queuedNotes"].as_array()) {
            for note in notes.iter().filter_map(Value::as_str) { content.push_str(&format!("\n\nAdditional human note for this task:\n{note}")); }
        }
        let batch = match self
            .prepare_post(id, &handle, &content, Some(selected), false)
            .await
        {
            Ok(batch) => batch,
            Err(error) => {
                let outcome = TaskOutcome {
                    status: TaskStatus::Failed,
                    result: Some(error.clone()),
                    result_data: next.result_data.clone(),
                    usage: None,
                };
                let _ = self
                    .assistant_tasks
                    .finish_attempt(&task.id, &run_id, outcome);
                self.assistant_runs.lock().unwrap().remove(&task.id);
                run.finished.store(true, Ordering::SeqCst);
                run.done.notify_waiters();
                self.assistant_changed(&task.owner.workspace_id);
                return Err(error);
            }
        };
        self.assistant_changed(&task.owner.workspace_id);
        if let Some(mut data) = next.result_data.clone() {
            data["queuedNotes"] = json!([]);
            let _ = self.assistant_tasks.set_result_data(&next.id, next.revision, &next.owner, Some(data));
        }
        spawn_task_attempt(
            Arc::clone(self),
            task.id,
            run_id,
            task.owner,
            id.to_string(),
            handle,
            batch,
            run,
            isolated_permit,
        );
        Ok(true)
    }

    pub fn assistant_tasks_list(&self, owner: TaskOwner) -> Result<Value, String> {
        let mut tasks = self
            .assistant_tasks
            .list(Some(&owner.workspace_id))
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|task| task.owner == owner)
            .collect::<Vec<_>>();
        for task in &mut tasks {
            if task.mode != TaskMode::Isolated
                || task
                    .result_data
                    .as_ref()
                    .is_some_and(|data| !data["archivedAtMs"].is_null())
            {
                continue;
            }
            if let Ok(base) = assistant_git::task_dir(self.assistant_data_dir(), &task.id) {
                if let Some(bytes) = directory_bytes(&base) {
                    task.result_data.get_or_insert_with(|| json!({}))["worktreeDiskBytes"] =
                        json!(bytes);
                }
            }
        }
        let executions: Vec<Value> = self.assistant_tasks.list_executions(Some(&owner.workspace_id)).into_iter().filter_map(|entry| {
            let task = tasks.iter().find(|task| task.id == entry.task_id)?;
            let saved = self.store().room(&entry.thread_id).ok().flatten();
            let pane = if entry.is_tombstoned() || saved.is_none() { Value::Null } else {
                let saved = saved.as_ref().unwrap();
                let execution_path = task.result_data.as_ref().and_then(|data|data["executionPath"].as_str()).unwrap_or(&task.owner.cwd);
                json!({"id":entry.thread_id,"workspaceId":owner.workspace_id,"kind":"chat","title":format!("Assistant task {}",task.id),"participants":saved.snapshot.participants,"options":saved.snapshot.options,"started":true,"assistantTaskId":task.id,"hostId":task.owner.host_id,"executionPath":execution_path})
            };
            Some(json!({"taskId":entry.task_id,"workspaceId":entry.workspace_id,"threadId":entry.thread_id,"mode":entry.mode,"tombstonedAtMs":entry.tombstoned_at_ms,"pane":pane}))
        }).collect();
        // The profile library can differ from a chat's saved participants.
        // Return its actual eligible worker IDs for explicit routing choices.
        let session = self.store().session()?;
        let mut named_only_workers = std::collections::BTreeSet::new();
        for profile in session.as_ref().and_then(|session| session["profiles"].as_array()).into_iter().flatten() {
            if let Ok(profile) = serde_json::from_value::<ParticipantConfig>(profile.clone()) {
                if !task_worker_eligible(&profile) { named_only_workers.insert(profile.id.to_string()); }
            }
        }
        let mut thread_ids = std::collections::BTreeSet::new();
        for pane in session.as_ref().and_then(|session| session["panes"].as_array()).into_iter().flatten() {
            if pane["kind"] == "chat" && pane["workspaceId"] == owner.workspace_id && pane["archived"] != true {
                if let Some(id) = pane["id"].as_str() { thread_ids.insert(id.to_owned()); }
            }
        }
        for task in &tasks {
            if let Some(id) = task.destination.as_ref().and_then(|destination| destination.thread_id.as_ref()) { thread_ids.insert(id.clone()); }
        }
        let mut routing_threads = Vec::new();
        for id in thread_ids {
            if let Some(saved) = self.store().room(&id)? {
                if saved.cwd.as_deref() != Some(owner.cwd.as_str()) { continue; }
                let workers: Vec<_> = saved.snapshot.participants.into_iter().filter(|profile| {
                    let eligible = task_worker_eligible(profile);
                    if !eligible { named_only_workers.insert(profile.id.to_string()); }
                    eligible
                }).collect();
                routing_threads.push(json!({"id":id,"workers":workers}));
            }
        }
        Ok(json!({"workspaceId":owner.workspace_id,"revision":self.assistant_tasks.snapshot_revision(),"tasks":tasks,"executions":executions,"routingThreads":routing_threads,"namedOnlyWorkerIds":named_only_workers}))
    }

    async fn wait_for_run_to_settle(&self, task_id: &str) -> Result<(), String> {
        let Some(run) = self.assistant_runs.lock().unwrap().get(task_id).cloned() else { return Ok(()) };
        let notified = run.done.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !run.finished.load(Ordering::SeqCst) {
            tokio::time::timeout(std::time::Duration::from_secs(5), notified)
                .await
                .map_err(|_| "Wait for the active task operation to stop before retrying.".to_string())?;
        }
        Ok(())
    }

    pub async fn assistant_task_action(
        self: &Arc<Self>,
        input: AssistantActionInput,
    ) -> Result<AssistantTask, String> {
        let task = self
            .assistant_tasks
            .get(&input.task_id)
            .map_err(|e| e.to_string())?
            .ok_or("Task not found.")?;
        if task.owner != input.owner || task.revision != input.revision {
            return Err("Task ownership or revision is stale.".into());
        }
        match input.action.as_str() {
            "note" | "set_budget" => {
                let _lock = self.assistant_apply.lock().await;
                let latest = self.assistant_tasks.get(&task.id).map_err(|e| e.to_string())?.ok_or("Task not found.")?;
                if latest.owner != input.owner || latest.revision != input.revision { return Err("Task ownership or revision is stale.".into()); }
                if matches!(latest.status, TaskStatus::Done | TaskStatus::Cancelled | TaskStatus::Applying) { return Err("This task can no longer receive notes or a spend limit.".into()); }
                let mut data = latest.result_data.clone().unwrap_or_else(|| json!({}));
                if input.action == "note" {
                    let text = input.text.as_deref().filter(|text| !text.trim().is_empty()).ok_or("Write a note before sending.")?;
                    append_history(&mut data, "note", text);
                    data["queuedNotes"].as_array_mut().map(|notes| notes.push(json!(text)));
                    if !data["queuedNotes"].is_array() { data["queuedNotes"] = json!([text]); }
                } else {
                    if input.spend_limit_micros == Some(0) { return Err("A spend limit must be greater than zero.".into()); }
                    data["spendLimitMicros"] = json!(input.spend_limit_micros);
                    append_history(&mut data, "spend_limit", &input.spend_limit_micros.map(|limit| format!("Spend limit set to ${:.2}.", limit as f64 / 1_000_000.0)).unwrap_or_else(|| "Spend limit removed.".into()));
                }
                let updated = self.assistant_tasks.set_result_data(&latest.id, latest.revision, &input.owner, Some(data)).map_err(|e| e.to_string())?;
                if budget_exceeded(&updated) {
                    if let Some(run) = self.assistant_runs.lock().unwrap().get(&updated.id) {
                        run.budget_pause.store(true, Ordering::SeqCst);
                        if let Some(id) = updated.execution_thread_id.as_ref() { if let Ok(handle) = self.handle(id) { handle.runtime.stop(None); } }
                    }
                }
                self.assistant_changed(&input.owner.workspace_id);
                Ok(updated)
            }
            "resume_budget" => {
                if task.status != TaskStatus::NeedsYou || !task.result_data.as_ref().is_some_and(|data| data["budgetPaused"] == true) { return Err("This task is not paused at a spend limit.".into()); }
                let id = task.execution_thread_id.as_deref().ok_or("Task has no execution chat to resume.")?;
                // An unreported cost is accepted here, by the human, so the task can continue. A reported cost over the limit is not.
                let mut revision = input.revision;
                let over_reported = task.result_data.as_ref().and_then(|data| data["spendLimitMicros"].as_u64())
                    .is_some_and(|limit| task.usage.as_ref().and_then(|usage| usage.cost_micros).is_some_and(|cost| cost >= limit));
                if !over_reported && task.usage.as_ref().is_some_and(|usage| usage.unknown_cost_turns > 0) {
                    let mut data = task.result_data.clone().unwrap_or_else(|| json!({}));
                    data["unknownCostAccepted"] = json!(true);
                    revision = self.assistant_tasks.set_result_data(&task.id, input.revision, &input.owner, Some(data)).map_err(|e| e.to_string())?.revision;
                }
                self.continue_thread_expected(id, Some("Resume the original task after my spend-limit change.".into()), vec![], Some(revision)).await?;
                self.assistant_tasks.get(&task.id).map_err(|e| e.to_string())?.ok_or("Task not found after resume.".into())
            }
            "dismiss" => {
                // A proposal nobody approved has no worker, checkout or run to
                // stop, so dismissing it only records the human's decision.
                let _apply_lock = self.assistant_apply.lock().await;
                let latest = self.assistant_tasks.get(&task.id).map_err(|e| e.to_string())?.ok_or("Task not found.")?;
                if latest.owner != input.owner || latest.revision != input.revision { return Err("Task ownership or revision is stale.".into()); }
                if !matches!(latest.status, TaskStatus::Proposed | TaskStatus::NeedsClarification) {
                    return Err("Only a proposed task can be dismissed; use Cancel for work that has started.".into());
                }
                let cancelled = self.assistant_tasks
                    .transition(&latest.id, latest.revision, &input.owner, TaskStatus::Cancelled, Some("Dismissed by the project owner.".into()))
                    .map_err(|e| e.to_string())?;
                let mut data = cancelled.result_data.clone().unwrap_or_else(|| json!({}));
                data["dismissedAtMs"] = json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64);
                let dismissed = self.assistant_tasks
                    .set_result_data(&cancelled.id, cancelled.revision, &input.owner, Some(data))
                    .map_err(|e| e.to_string())?;
                self.assistant_changed(&input.owner.workspace_id);
                Ok(dismissed)
            }
            "archive" => {
                let _archive_lock = self.assistant_apply.lock().await;
                let task = self
                    .assistant_tasks
                    .get(&input.task_id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Task not found.")?;
                if task.owner != input.owner || task.revision != input.revision {
                    return Err("Task ownership or revision is stale.".into());
                }
                if !matches!(
                    task.status,
                    TaskStatus::Done
                        | TaskStatus::Cancelled
                        | TaskStatus::Failed
                        | TaskStatus::Interrupted
                ) {
                    return Err("Only a terminal assistant task can be archived.".into());
                }
                if has_pending_integration(&task) {
                    return Err("Reconcile or review the interrupted integration before archiving this task.".into());
                }
                if let Some(child) = &task.execution_thread_id {
                    self.recover_worker_cleanup(child)?;
                }
                self.recover_task_operations(&task.id)?;
                if task
                    .result_data
                    .as_ref()
                    .is_some_and(|data| data["leaseHeld"] == true)
                    && !self
                        .checkout_gate(Path::new(&input.owner.cwd))
                        .release(&task.id)
                {
                    return Err("The task's project reservation could not be released; archive was stopped.".into());
                }
                let disk_bytes = (task.mode == TaskMode::Isolated)
                    .then(|| {
                        assistant_git::task_dir(self.assistant_data_dir(), &task.id)
                            .ok()
                            .and_then(|base| directory_bytes(&base))
                    })
                    .flatten();
                if task.mode == TaskMode::Isolated {
                    assistant_git::archive_worktree(
                        Path::new(&input.owner.cwd),
                        &task.id,
                        self.assistant_data_dir(),
                    )?;
                }
                let latest = self
                    .assistant_tasks
                    .get(&task.id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Task not found.")?;
                let mut data = latest.result_data.clone().unwrap_or_else(|| json!({}));
                data["leaseHeld"] = json!(false);
                if let Some(bytes) = disk_bytes {
                    data["worktreeDiskBytes"] = json!(bytes);
                }
                if data["archivedAtMs"].is_null() {
                    data["archivedAtMs"] = json!(std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64);
                }
                let _archived = self
                    .assistant_tasks
                    .set_result_data(&latest.id, latest.revision, &input.owner, Some(data))
                    .map_err(|e| e.to_string())?;
                self.assistant_tasks
                    .tombstone_task_executions(&task.id)
                    .map_err(|e| e.to_string())?;
                if let Some(child) = &task.execution_thread_id {
                    self.room_delete(child.clone())?;
                }
                self.assistant_changed(&input.owner.workspace_id);
                self.assistant_tasks
                    .get(&task.id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Task record was not retained after archive.".into())
            }
            "cancel" => {
                // Serialize terminal cancellation with human acceptance so a
                // Done task cannot race back to Cancelled during verification.
                let _apply_lock = self.assistant_apply.lock().await;
                let task = self
                    .assistant_tasks
                    .get(&input.task_id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Task not found.")?;
                if task.owner != input.owner || task.revision != input.revision {
                    return Err("Task ownership or revision is stale.".into());
                }
                if has_pending_integration(&task) {
                    return Err("Reconcile the interrupted project integration before cancelling this task.".into());
                }
                let active_run = { self.assistant_runs.lock().unwrap().get(&task.id).cloned() };
                if let Some(run) = active_run {
                    run.stop.store(true, Ordering::SeqCst);
                    run.stop_tx.send_replace(true);
                    if let Some(child) = &task.execution_thread_id {
                        if let Ok(handle) = self.handle(child) {
                            handle.runtime.stop(None);
                        }
                    }
                    let notified = run.done.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if !run.finished.load(Ordering::SeqCst) {
                        tokio::time::timeout(std::time::Duration::from_secs(30), notified).await.map_err(|_|"Cancellation timed out while the worker was shutting down; the checkout remains reserved.".to_string())?;
                    }
                } else if let Some(child) = &task.execution_thread_id {
                    if let Ok(handle) = self.handle(child) {
                        handle.runtime.stop(None);
                    }
                }
                if let Some(child) = &task.execution_thread_id {
                    self.recover_worker_cleanup(child)?;
                }
                self.recover_task_operations(&task.id)?;
                let latest = self
                    .assistant_tasks
                    .get(&task.id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Task not found.")?;
                let mut cancelled = if latest.status == TaskStatus::Cancelled {
                    latest
                } else {
                    self.assistant_tasks
                        .transition(
                            &task.id,
                            latest.revision,
                            &input.owner,
                            TaskStatus::Cancelled,
                            Some("Cancelled by the project owner.".into()),
                        )
                        .map_err(|e| e.to_string())?
                };
                if cancelled
                    .result_data
                    .as_ref()
                    .is_some_and(|data| data["leaseHeld"] == true)
                {
                    if !self
                        .checkout_gate(Path::new(&input.owner.cwd))
                        .release(&task.id)
                    {
                        return Err("Cancellation finished, but the task's checkout reservation could not be released.".into());
                    }
                    if let Some(mut data) = cancelled.result_data.clone() {
                        data["leaseHeld"] = json!(false);
                        cancelled = self
                            .assistant_tasks
                            .set_result_data(
                                &cancelled.id,
                                cancelled.revision,
                                &input.owner,
                                Some(data),
                            )
                            .map_err(|e| e.to_string())?;
                    }
                }
                self.assistant_changed(&input.owner.workspace_id);
                Ok(cancelled)
            }
            "accept" | "review" => {
                if input.action == "review" && task.mode != TaskMode::ReadOnly { return Err("Only read-only results can be marked reviewed.".into()); }
                let _lock = self.assistant_apply.lock().await;
                if let Some(child) = &task.execution_thread_id {
                    self.recover_worker_cleanup(child)?;
                }
                self.recover_task_operations(&task.id)?;
                let applying = self
                    .assistant_tasks
                    .transition(
                        &task.id,
                        input.revision,
                        &input.owner,
                        TaskStatus::Applying,
                        None,
                    )
                    .map_err(|e| e.to_string())?;
                self.assistant_changed(&input.owner.workspace_id);
                let verification: Result<AssistantTask, String> = async {
                    if applying.mode == TaskMode::ReadOnly { return Ok(applying.clone()); }
                    let data = applying
                        .result_data
                        .clone()
                        .ok_or("Task has no review snapshot.")?;
                    if applying.mode == TaskMode::Isolated {
                        let baseline: assistant_git::GitSnapshot = serde_json::from_value(data["baselineSnapshot"].clone()).map_err(|e|e.to_string())?;
                        let result: assistant_git::GitSnapshot = serde_json::from_value(data["resultSnapshot"].clone()).map_err(|e|e.to_string())?;
                        let gate = self.checkout_gate(Path::new(&input.owner.cwd));
                        let _lease = gate.acquire(task.id.clone(), Arc::new(AtomicBool::new(false))).await.map_err(|e|format!("Could not reserve the project for task integration: {e:?}"))?;
                        let plan = assistant_git::stage_integration(Path::new(&input.owner.cwd), &baseline, &result.commit, &task.id, self.assistant_data_dir())?;
                        let checks: Vec<Vec<String>> = data["checks"].as_array().cloned().unwrap_or_default().into_iter().filter_map(|v|serde_json::from_value(v).ok()).collect();
                        let cargo_target_dir = data["cargoTargetDir"].as_str().map(Path::new);
                        let process_dir = crate::assistant_isolation::operation_process_dir(self.assistant_data_dir(), &task.id)?;
                        let mut check_results = Vec::new();
                        for check in checks {
                            match run_check(&plan.scratch_path, &check, cargo_target_dir, &process_dir).await {
                                Ok(result) => {
                                    let success = result["success"] == true;
                                    check_results.push(result);
                                    if !success {
                                        let mut failed = data.clone();
                                        failed["checkResults"] = json!(check_results);
                                        let _ = self.assistant_tasks.set_result_data(&applying.id, applying.revision, &input.owner, Some(failed));
                                        discard_integration_scratch(&plan);
                                        return Err("A configured verification check failed.".into());
                                    }
                                }
                                Err(error) => {
                                    let mut failed = data.clone();
                                    check_results.push(json!({"argv":check,"success":false,"error":error}));
                                    failed["checkResults"] = json!(check_results);
                                    let _ = self.assistant_tasks.set_result_data(&applying.id, applying.revision, &input.owner, Some(failed));
                                    discard_integration_scratch(&plan);
                                    return Err(error);
                                }
                            }
                        }
                        let scratch = assistant_git::capture(&plan.scratch_path, &task.id, "integration-verify")?;
                        let expected_tree = assistant_git::git(&plan.root, &["rev-parse", &format!("{}^{{tree}}", plan.merged_commit)])?;
                        if scratch.tree != expected_tree.trim() {
                            discard_integration_scratch(&plan);
                            return Err("The integration check changed tracked scratch state; review the task again.".into());
                        }
                        let journal_path = self.assistant_data_dir().join("apex-agent").join("tasks").join(&task.id).join("apply.json");
                        let mut saved_data = data;
                        saved_data["checkResults"] = json!(check_results);
                        saved_data["integrationPlan"] = serde_json::to_value(&plan).map_err(|e|e.to_string())?;
                        saved_data["applyJournal"] = json!(journal_path);
                        let durable = self.assistant_tasks.set_result_data(&applying.id, applying.revision, &input.owner, Some(saved_data)).map_err(|e|e.to_string())?;
                        if let Err(error) = assistant_git::apply_integration(&plan, &journal_path) {
                            if !journal_path.exists() {
                                discard_integration_scratch(&plan);
                                let _ = self.assistant_tasks.transition(&durable.id, durable.revision, &input.owner, TaskStatus::ReadyForReview, Some(error.clone()));
                            }
                            return Err(error);
                        }
                        discard_integration_scratch(&plan);
                        return Ok(durable);
                    }
                    let expected: assistant_git::GitSnapshot =
                        serde_json::from_value(data["resultSnapshot"].clone())
                            .map_err(|e| e.to_string())?;
                    let before =
                        assistant_git::capture(Path::new(&input.owner.cwd), &task.id, "accept")?;
                    if !same_checkout(&before, &expected) {
                        return Err("The checkout changed since this task was reviewed.".into());
                    }
                    let checks: Vec<Vec<String>> = data["checks"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|v| serde_json::from_value(v).ok())
                        .collect();
                    let process_dir = crate::assistant_isolation::operation_process_dir(self.assistant_data_dir(), &task.id)?;
                    let mut check_results = Vec::new();
                    for check in checks {
                        match run_check(Path::new(&input.owner.cwd), &check, None, &process_dir).await {
                            Ok(result) => {
                                let success = result["success"] == true;
                                check_results.push(result);
                                if !success {
                                    let mut failed = data.clone();
                                    failed["checkResults"] = json!(check_results);
                                    let _ = self.assistant_tasks.set_result_data(&applying.id, applying.revision, &input.owner, Some(failed));
                                    return Err("A configured verification check failed.".into());
                                }
                            }
                            Err(error) => {
                                check_results.push(json!({"argv":check,"success":false,"error":error}));
                                let mut failed = data.clone();
                                failed["checkResults"] = json!(check_results);
                                let _ = self.assistant_tasks.set_result_data(&applying.id, applying.revision, &input.owner, Some(failed));
                                return Err(error);
                            }
                        }
                    }
                    let mut verified_data = data.clone();
                    verified_data["checkResults"] = json!(check_results);
                    let verified_task = self.assistant_tasks.set_result_data(&applying.id, applying.revision, &input.owner, Some(verified_data)).map_err(|e|e.to_string())?;
                    let after = assistant_git::capture(
                        Path::new(&input.owner.cwd),
                        &task.id,
                        "post-check",
                    )?;
                    if !same_checkout(&after, &expected) {
                        return Err(
                            "A check changed tracked checkout state; review the task again.".into(),
                        );
                    }
                    Ok(verified_task)
                }
                .await;
                let done_source = match verification {
                    Ok(task) => task,
                    Err(error) => {
                        let latest = self
                            .assistant_tasks
                            .get(&task.id)
                            .map_err(|e| e.to_string())?
                            .ok_or("Task not found.")?;
                        let has_journal = latest.result_data.as_ref().is_some_and(|data| {
                            data["applyJournal"]
                                .as_str()
                                .is_some_and(|path| Path::new(path).exists())
                        });
                        if latest.status == TaskStatus::Applying && !has_journal {
                            let _ = self.assistant_tasks.transition(
                                &latest.id,
                                latest.revision,
                                &input.owner,
                                TaskStatus::ReadyForReview,
                                Some(error.clone()),
                            );
                        }
                        self.assistant_changed(&input.owner.workspace_id);
                        return Err(error);
                    }
                };
                let mut done = self
                    .assistant_tasks
                    .transition(
                        &done_source.id,
                        done_source.revision,
                        &input.owner,
                        TaskStatus::Done,
                        applying.result.clone(),
                    )
                    .map_err(|e| e.to_string())?;
                if let Some(mut data) = done.result_data.clone() {
                    if data["archiveSuggestedAtMs"].is_null() {
                        data["archiveSuggestedAtMs"] =
                            json!(done.updated_at_ms.saturating_add(14 * 24 * 60 * 60 * 1000));
                        done = self
                            .assistant_tasks
                            .set_result_data(&done.id, done.revision, &input.owner, Some(data))
                            .map_err(|e| e.to_string())?;
                    }
                }
                if done
                    .result_data
                    .as_ref()
                    .is_some_and(|data| data["leaseHeld"] == true)
                {
                    if !self
                        .checkout_gate(Path::new(&input.owner.cwd))
                        .release(&task.id)
                    {
                        return Err("Task completed, but its checkout reservation could not yet be released.".into());
                    }
                    if let Some(mut data) = done.result_data.clone() {
                        data["leaseHeld"] = json!(false);
                        done = self
                            .assistant_tasks
                            .set_result_data(&done.id, done.revision, &input.owner, Some(data))
                            .map_err(|e| e.to_string())?;
                    }
                }
                self.assistant_changed(&input.owner.workspace_id);
                Ok(done)
            }
            "retry" | "continue" | "request_changes" => {
                // Waiting on an approval or question when the service restarted: run the step again on the same chat.
                if input.action == "retry"
                    && task.status == TaskStatus::NeedsYou
                    && task.result_data.as_ref().is_some_and(|data| data["restartedWhileWaiting"] == true)
                {
                    let id = task.execution_thread_id.as_deref().ok_or("Task has no execution chat to retry.")?;
                    self.continue_thread_expected(id, Some("Run the step again after the service restarted.".into()), vec![], Some(input.revision)).await?;
                    return self.assistant_tasks.get(&task.id).map_err(|e| e.to_string())?.ok_or("Task not found after retry.".into());
                }
                if task.status == TaskStatus::Interrupted && has_pending_integration(&task) {
                    return Err(
                        "Reconcile the interrupted project integration before retrying this task."
                            .into(),
                    );
                }
                if task
                    .result_data
                    .as_ref()
                    .is_some_and(|data| !data["archivedAtMs"].is_null())
                {
                    return Err("An archived task cannot be retried or continued.".into());
                }
                if input.action == "retry"
                    && matches!(task.status, TaskStatus::NeedsYou | TaskStatus::Interrupted)
                    && task.attempts.is_empty()
                {
                    let _retry_lock = self.assistant_apply.lock().await;
                    let task = self
                        .assistant_tasks
                        .get(&input.task_id)
                        .map_err(|e| e.to_string())?
                        .ok_or("Task not found.")?;
                    if task.owner != input.owner || task.revision != input.revision {
                        return Err("Task ownership or revision is stale.".into());
                    }
                    // NeedsYou is saved just before the startup run marks itself
                    // finished; let that run settle instead of refusing the retry.
                    self.wait_for_run_to_settle(&task.id).await?;
                    self.recover_task_operations(&task.id)?;
                    let monitor = self
                        .monitor_get(&task.owner.workspace_id)?
                        .ok_or("ApexAgent assignment disappeared.")?;
                    if monitor.cwd != task.owner.cwd
                        || monitor.host_id != task.owner.host_id
                        || monitor.conversation_id != task.owner.conversation_id
                    {
                        return Err("This task belongs to a previous ApexAgent assignment.".into());
                    }
                    let destination = task
                        .destination
                        .clone()
                        .ok_or("Choose a destination before retrying isolated startup.")?;
                    let data = task.result_data.clone().unwrap_or_else(|| json!({}));
                    let profiles: Vec<ParticipantConfig> =
                        serde_json::from_value(data["workerProfiles"].clone()).unwrap_or_default();
                    let checks = serde_json::from_value(data["checks"].clone()).unwrap_or_default();
                    let mode = serde_json::from_value(data["mode"].clone()).unwrap_or(task.mode);
                    let queued = self
                        .assistant_tasks
                        .transition(
                            &task.id,
                            task.revision,
                            &input.owner,
                            TaskStatus::Queued,
                            None,
                        )
                        .map_err(|e| e.to_string())?;
                    let retry_input = AssistantMessageInput {
                        workspace_id: input.owner.workspace_id.clone(),
                        cwd: input.owner.cwd.clone(),
                        host_id: input.owner.host_id.clone(),
                        conversation_id: input.owner.conversation_id.clone(),
                        request_id: task.id.clone(),
                        text: task.original_request.clone(),
                        destination: Some(destination.clone()),
                        new_worker_profiles: profiles.clone(),
                        thread_labels: vec![],
                        mode,
                        checks,
                     worker_profiles: vec![], spend_limit_micros: None, };
                    self.schedule_dispatch(
                        &queued,
                        &input.owner,
                        retry_input,
                        destination.thread_id.unwrap_or_default(),
                        destination.workers,
                        profiles,
                    );
                    self.assistant_changed(&input.owner.workspace_id);
                    return self
                        .assistant_tasks
                        .get(&queued.id)
                        .map_err(|e| e.to_string())?
                        .ok_or("Task not found after retry was queued.".into());
                }
                if input.action == "request_changes"
                    && input
                        .text
                        .as_deref()
                        .is_none_or(|text| text.trim().is_empty())
                {
                    return Err("A request-changes action needs the human's correction.".into());
                }
                let id = task
                    .execution_thread_id
                    .as_deref()
                    .ok_or("Task has no execution chat to continue.")?;
                self.continue_thread_expected(
                    id,
                    input.text.clone(),
                    task.workers
                        .iter()
                        .cloned()
                        .map(ParticipantId::new)
                        .collect(),
                    Some(input.revision),
                )
                .await?;
                self.assistant_tasks
                    .get(&task.id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Task not found after continuation.".to_string())
            }
            "reconcile" => {
                if !matches!(task.status, TaskStatus::Applying | TaskStatus::Interrupted)
                    || task.mode != TaskMode::Isolated
                {
                    return Err(
                        "Only an interrupted isolated integration can be reconciled.".into(),
                    );
                }
                let _lock = self.assistant_apply.lock().await;
                let latest = self
                    .assistant_tasks
                    .get(&task.id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Task not found.")?;
                if latest.owner != input.owner || latest.revision != input.revision {
                    return Err("Task ownership or revision is stale.".into());
                }
                let data = latest
                    .result_data
                    .clone()
                    .ok_or("Interrupted integration metadata is missing.")?;
                let plan: assistant_git::IntegrationPlan =
                    serde_json::from_value(data["integrationPlan"].clone())
                        .map_err(|e| e.to_string())?;
                let project = std::fs::canonicalize(&input.owner.cwd).map_err(|e| e.to_string())?;
                let plan_root = std::fs::canonicalize(&plan.root).map_err(|e| e.to_string())?;
                if plan.task_id != task.id || plan_root != project {
                    return Err("Interrupted integration metadata does not match this task's assigned project.".into());
                }
                let journal = data["applyJournal"]
                    .as_str()
                    .map(PathBuf::from)
                    .ok_or("Interrupted integration journal path is missing.")?;
                let gate = self.checkout_gate(Path::new(&input.owner.cwd));
                let _lease = gate
                    .acquire(task.id.clone(), Arc::new(AtomicBool::new(false)))
                    .await
                    .map_err(|e| format!("Could not reserve the project for recovery: {e:?}"))?;
                let journal_doc: Option<Value> = if journal.exists() {
                    Some(
                        serde_json::from_slice(
                            &std::fs::read(&journal).map_err(|e| e.to_string())?,
                        )
                        .map_err(|e| e.to_string())?,
                    )
                } else {
                    None
                };
                let was_applied = journal_doc
                    .as_ref()
                    .is_some_and(|doc| doc["phase"] == "applied");
                if journal_doc.is_some() {
                    assistant_git::reconcile_interrupted_apply(&plan, &journal)?;
                }
                discard_integration_scratch(&plan);
                let verified_applied = was_applied && applied_integration_matches(&plan)?;
                let status = if verified_applied {
                    TaskStatus::Done
                } else {
                    TaskStatus::ReadyForReview
                };
                let mut latest = latest;
                if !verified_applied {
                    let mut recovered_data =
                        latest.result_data.clone().unwrap_or_else(|| json!({}));
                    recovered_data["integrationPlan"] = Value::Null;
                    recovered_data["applyJournal"] = Value::Null;
                    latest = self
                        .assistant_tasks
                        .set_result_data(
                            &latest.id,
                            latest.revision,
                            &input.owner,
                            Some(recovered_data),
                        )
                        .map_err(|e| e.to_string())?;
                }
                let result = self
                    .assistant_tasks
                    .transition(
                        &latest.id,
                        latest.revision,
                        &input.owner,
                        status,
                        if verified_applied { latest.result.clone() } else { Some("The interrupted integration was safely reconciled. Review the task before accepting again.".into()) },
                    )
                    .map_err(|e| e.to_string())?;
                self.assistant_changed(&input.owner.workspace_id);
                Ok(result)
            }
            "approve" | "clarify" => self.change_monitors(|monitors| {
                if task.result_data.as_ref().is_some_and(|data| data["batchId"].is_string()) {
                    let monitor = monitors.iter().find(|monitor| monitor.workspace_id == input.owner.workspace_id).ok_or("Handoff project assignment is unavailable.")?;
                    if monitor.cwd != input.owner.cwd || monitor.host_id != input.owner.host_id || monitor.conversation_id != input.owner.conversation_id || task.result_data.as_ref().and_then(|data| data["monitorRevision"].as_u64()) != Some(monitor.revision) {
                        return Err("Handoff context changed. Refresh the plan and reconfirm the affected proposal.".into());
                    }
                }
                let destination = input
                    .destination
                    .clone()
                    .ok_or("Select a destination and worker before approving this task.")?;
                if destination.workers.is_empty() {
                    return Err("Select at least one worker before approving this task.".into());
                }
                if destination.new_thread { verify_task_workers(&input.new_worker_profiles)?; }
                if destination.new_thread
                    && input
                        .new_worker_profiles
                        .iter()
                        .map(|p| p.id.to_string())
                        .collect::<std::collections::HashSet<_>>()
                        != destination.workers.iter().cloned().collect()
                {
                    return Err("New chat approval must include an explicitly selected profile for each worker.".into());
                }
                if !destination.new_thread {
                    let thread_id = destination
                        .thread_id
                        .as_deref()
                        .ok_or("Select a saved chat as the task destination.")?;
                    let saved = self
                        .store()
                        .room(thread_id)?
                        .ok_or("Selected destination chat was not found.")?;
                    if saved.cwd.as_deref() != Some(input.owner.cwd.as_str()) {
                        return Err(
                            "Selected destination chat is outside the assigned project.".into()
                        );
                    }
                    let available: std::collections::HashSet<_> = saved
                        .snapshot
                        .participants
                        .iter()
                        .map(|profile| profile.id.to_string())
                        .collect();
                    if destination
                        .workers
                        .iter()
                        .any(|worker| !available.contains(worker))
                    {
                        return Err(
                            "Every selected worker must belong to the destination chat.".into()
                        );
                    }
                    let selected: Vec<_> = saved.snapshot.participants.into_iter().filter(|profile| destination.workers.contains(&profile.id.to_string())).collect();
                    verify_task_workers(&selected)?;
                }
                let requested_mode = task.result_data.as_ref()
                    .and_then(|data| serde_json::from_value(data["mode"].clone()).ok()).unwrap_or(task.mode);
                let mode = input.mode.unwrap_or(requested_mode);
                let check_commands: Vec<Vec<String>> = input.checks.clone().unwrap_or_else(|| task.result_data.as_ref()
                    .and_then(|data| serde_json::from_value(data["checks"].clone()).ok()).unwrap_or_default());
                if mode == TaskMode::ReadOnly && !check_commands.is_empty() {
                    return Err("Read-only tasks cannot run verification commands.".into());
                }
                let queued = self
                    .assistant_tasks
                    .set_destination(
                        &task.id,
                        input.revision,
                        &input.owner,
                        destination.clone(),
                        task.brief.clone(),
                    )
                    .map_err(|e| e.to_string())?;
                let mut data = queued.result_data.clone().unwrap_or_else(|| json!({}));
                data["checks"] = serde_json::to_value(&check_commands)
                    .map_err(|e| e.to_string())?;
                data["executionPath"] = json!(input.owner.cwd);
                data["leaseHeld"] = json!(false);
                data["mode"] = json!(mode);
                let worker_profiles = if destination.new_thread { input.new_worker_profiles.clone() } else { vec![] };
                data["workerProfiles"] =
                    serde_json::to_value(&worker_profiles).map_err(|e| e.to_string())?;
                if input.action == "clarify" {
                    if let Some(text) = input.text.as_deref().filter(|text| !text.trim().is_empty()) {
                        data["routingClarification"] = json!(text);
                        append_history(&mut data, "clarification", text);
                    }
                }
                let queued = self
                    .assistant_tasks
                    .set_result_data(&queued.id, queued.revision, &input.owner, Some(data))
                    .map_err(|e| e.to_string())?;
                let action_owner = input.owner.clone();
                let input = AssistantMessageInput {
                    workspace_id: action_owner.workspace_id.clone(),
                    cwd: action_owner.cwd.clone(),
                    host_id: action_owner.host_id.clone(),
                    conversation_id: action_owner.conversation_id.clone(),
                    request_id: queued.id.clone(),
                    text: queued.original_request.clone(),
                    destination: Some(destination.clone()),
                    new_worker_profiles: worker_profiles.clone(),
                    thread_labels: vec![],
                    mode,
                    checks: check_commands,
                 worker_profiles: vec![], spend_limit_micros: None, };
                self.schedule_dispatch(
                    &queued,
                    &action_owner,
                    input,
                    destination.thread_id.unwrap_or_default(),
                    destination.workers,
                    worker_profiles,
                );
                self.assistant_changed(&action_owner.workspace_id);
                self.assistant_tasks
                    .get(&queued.id)
                    .map_err(|e| e.to_string())?
                    .ok_or("Task not found after approval.".to_string())
            }),
            _ => Err("Unknown assistant task action.".into()),
        }
    }
}

fn task_monitor(task: Option<&AssistantTask>) -> Value {
    json!({"status":task.and_then(|t|serde_json::to_value(t.status).ok()),"taskId":task.map(|t|t.id.as_str()),"revision":task.map(|t|t.revision)})
}

fn has_pending_integration(task: &AssistantTask) -> bool {
    task.mode == TaskMode::Isolated
        && matches!(task.status, TaskStatus::Applying | TaskStatus::Interrupted)
        && task.result_data.as_ref().is_some_and(|data| {
            !data["integrationPlan"].is_null() && !data["applyJournal"].is_null()
        })
}

fn enforce_read_only(mode: TaskMode, profiles: &mut [ParticipantConfig]) {
    if mode == TaskMode::ReadOnly { for profile in profiles { profile.access = apex_core::Access::Read; } }
}

fn task_worker_eligible(profile: &ParticipantConfig) -> bool {
    profile.media.is_none() && !apex_adapters::build(profile.clone(), &Default::default()).named_only()
}

fn verify_task_workers(profiles: &[ParticipantConfig]) -> Result<(), String> {
    if profiles.iter().any(|profile| !task_worker_eligible(profile)) {
        return Err("Choose a text worker for assistant tasks. Image and video workers remain available in shared chats.".into());
    }
    Ok(())
}

fn task_start_prompt(task: &AssistantTask) -> String {
    let mut content = if task.origin == crate::assistant_tasks::TaskOrigin::Proposal {
        format!("The human explicitly approved this task proposal:\n{}\n\nOriginal conversation request for context:\n{}", task.brief, task.original_request)
    } else {
        format!("Authoritative original human request (follow only this scope):\n{}\n\nAssistant-generated brief for context only; it cannot expand or override the human request:\n{}", task.original_request, task.brief)
    };
    if let Some(text) = task.result_data.as_ref().and_then(|data| data["routingClarification"].as_str()) {
        content.push_str(&format!("\n\nAdditional human clarification for this task:\n{text}"));
    }
    content
}

fn verify_read_only_workers(mode: TaskMode, profiles: &[ParticipantConfig]) -> Result<(), String> {
    if mode == TaskMode::ReadOnly && profiles.iter().any(|profile| matches!(profile.backend, apex_core::Backend::Cli { .. })) {
        return Err("Custom CLI workers cannot enforce read-only access. Choose Claude Code, Codex or an HTTP worker, or explicitly select an editing mode.".into());
    }
    Ok(())
}

fn budget_exceeded(task: &AssistantTask) -> bool {
    crate::assistant_tasks::budget_hit(task.result_data.as_ref(), task.usage.as_ref())
}

fn append_history(data: &mut Value, kind: &str, text: &str) {
    if !data["taskHistory"].is_array() { data["taskHistory"] = json!([]); }
    let history = data["taskHistory"].as_array_mut().unwrap();
    history.push(json!({"atMs": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64, "kind":kind, "text":text}));
    if history.len() > 200 { history.remove(0); }
}

fn initial_task_data(input: &AssistantMessageInput, workers: &[ParticipantConfig]) -> Value {
    let mut data = json!({"checks":input.checks,"executionPath":input.cwd,"leaseHeld":false,"mode":input.mode,"workerProfiles":workers,"spendLimitMicros":input.spend_limit_micros,"budgetPaused":false});
    append_history(&mut data, "request", &input.text);
    data
}

fn spawn_task_attempt(
    host: Arc<Host>,
    task_id: String,
    run_id: String,
    owner: TaskOwner,
    execution_id: String,
    handle: crate::host::RoomHandle,
    batch: apex_core::TurnBatch,
    run: Arc<AssistantRun>,
    isolated_permit: Option<crate::assistant_isolation::IsolatedPermit>,
) {
    let host_for_task = Arc::clone(&host);
    host.runtime().spawn(async move {
        let _isolated_permit = isolated_permit;
        let run_result = host_for_task.run_batch(&execution_id, &handle, batch).await;
        let task_before = host_for_task.assistant_tasks.get(&task_id).ok().flatten();
        let result_path = task_before
            .as_ref()
            .and_then(|task| task.result_data.as_ref())
            .and_then(|data| data["executionPath"].as_str())
            .map(Path::new)
            .unwrap_or(Path::new(&owner.cwd));
        let is_isolated = task_before
            .as_ref()
            .is_some_and(|task| task.mode == TaskMode::Isolated);
        let read_only = task_before.as_ref().is_some_and(|task| task.mode == TaskMode::ReadOnly);
        let snapshot = if read_only { Ok(None) } else if is_isolated {
            assistant_git::capture_result(result_path, &task_id).map(Some)
        } else {
            assistant_git::capture(result_path, &task_id, "result").map(Some)
        };
        let error = handle
            .task_error
            .lock()
            .unwrap()
            .clone()
            .or_else(|| run_result.err())
            .or_else(|| snapshot.as_ref().err().cloned());
        let status = if run.stop.load(Ordering::SeqCst) {
            TaskStatus::Cancelled
        } else if run.budget_pause.load(Ordering::SeqCst) {
            TaskStatus::NeedsYou
        } else if error.is_some() {
            TaskStatus::Failed
        } else if handle.has_open_questions() {
            TaskStatus::NeedsYou
        } else {
            TaskStatus::ReadyForReview
        };
        if status == TaskStatus::NeedsYou {
            if host_for_task
                .assistant_tasks
                .get(&task_id)
                .ok()
                .flatten()
                .is_some_and(|task| task.status == TaskStatus::Running)
            {
                let _ = host_for_task
                    .assistant_tasks
                    .set_run_waiting(&task_id, &run_id, true);
            }
        }
        let mut result_data = host_for_task
            .assistant_tasks
            .get(&task_id)
            .ok()
            .flatten()
            .and_then(|task| task.result_data)
            .unwrap_or_else(|| json!({}));
        if let Ok(Some(snapshot)) = snapshot {
            if let Some(baseline) = result_data["baselineSnapshot"]["commit"]
                .as_str()
                .map(str::to_owned)
            {
                result_data["baselineCommit"] = json!(baseline);
                match assistant_git::review_diff(result_path, &baseline, &snapshot.commit) {
                    Ok(diff) => {
                        result_data["diff"] = json!(diff);
                        result_data["reviewDiff"] = json!(diff);
                    }
                    Err(diff_error) => *run.error.lock().unwrap() = Some(diff_error),
                }
            }
            result_data["resultCommit"] = json!(&snapshot.commit);
            let mut exclusions = result_data["baselineSnapshot"]["exclusions"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            exclusions.extend(snapshot.exclusions.iter().cloned().map(Value::String));
            let mut seen = std::collections::HashSet::new();
            exclusions.retain(|value| {
                value
                    .as_str()
                    .is_some_and(|path| seen.insert(path.to_owned()))
            });
            result_data["exclusions"] = json!(exclusions);
            result_data["resultSnapshot"] = serde_json::to_value(snapshot).unwrap_or(Value::Null);
        }
        result_data["leaseHeld"] = json!(!is_isolated && !read_only);
        result_data["budgetPaused"] = json!(status == TaskStatus::NeedsYou && run.budget_pause.load(Ordering::SeqCst));
        let worker_result = handle.checkpoint.lock().unwrap().snapshot.transcript.iter().rev()
            .find(|message| matches!(message.speaker, apex_core::Speaker::Bot(_)))
            .map(|message| message.text.clone());
        let result = if result_data["budgetPaused"] == true {
            let usage = host_for_task.assistant_tasks.get(&task_id).ok().flatten().and_then(|task| task.usage);
            Some(crate::assistant_tasks::budget_pause_text(Some(&result_data), usage.as_ref()).into())
        }
            else { run.error.lock().unwrap().clone().or(error.clone()).or(worker_result) };
        append_history(&mut result_data, if status == TaskStatus::NeedsYou { "pause" } else { "result" }, result.as_deref().unwrap_or("Worker attempt completed."));
        let outcome = TaskOutcome {
            status: if run.error.lock().unwrap().is_some() && error.is_none() {
                TaskStatus::Failed
            } else {
                status
            },
            result,
            result_data: Some(result_data),
            usage: None,
        };
        let _ = host_for_task
            .assistant_tasks
            .finish_attempt(&task_id, &run_id, outcome);
        run.finished.store(true, Ordering::SeqCst);
        run.done.notify_waiters();
        host_for_task
            .assistant_runs
            .lock()
            .unwrap()
            .remove(&task_id);
        host_for_task.assistant_changed(&owner.workspace_id);
    });
}

fn same_checkout(a: &assistant_git::GitSnapshot, b: &assistant_git::GitSnapshot) -> bool {
    a.tree == b.tree
        && a.head == b.head
        && a.branch == b.branch
        && a.index_hash == b.index_hash
        && a.exclusions == b.exclusions
}

fn applied_integration_matches(plan: &assistant_git::IntegrationPlan) -> Result<bool, String> {
    let current = assistant_git::capture(&plan.root, &plan.task_id, "reconcile-verify")?;
    if current.head != plan.current_snapshot.head
        || current.branch != plan.current_snapshot.branch
        || current.index_hash != plan.current_snapshot.index_hash
    {
        return Ok(false);
    }
    let merged_tree = assistant_git::git(
        &plan.root,
        &["rev-parse", &format!("{}^{{tree}}", plan.merged_commit)],
    )?
    .trim()
    .to_owned();
    for path in &plan.changed_paths {
        let current_entry =
            assistant_git::git(&plan.root, &["ls-tree", "-z", &current.tree, "--", path])?;
        let expected_entry =
            assistant_git::git(&plan.root, &["ls-tree", "-z", &merged_tree, "--", path])?;
        if current_entry != expected_entry {
            return Ok(false);
        }
    }
    Ok(true)
}

fn discard_integration_scratch(plan: &assistant_git::IntegrationPlan) {
    if plan.scratch_path.exists() {
        let _ = assistant_git::git(
            &plan.root,
            &[
                "worktree",
                "remove",
                "--force",
                &plan.scratch_path.to_string_lossy(),
            ],
        );
    }
}

fn directory_bytes(path: &Path) -> Option<u64> {
    fn visit(path: &Path, total: &mut u64, entries: &mut usize) -> std::io::Result<()> {
        *entries += 1;
        if *entries > 100_000 {
            return Err(std::io::Error::other(
                "Task size scan exceeded its entry limit",
            ));
        }
        let metadata = std::fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            return Ok(());
        }
        if metadata.is_file() {
            *total = total.saturating_add(metadata.len());
            return Ok(());
        }
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path)? {
                visit(&entry?.path(), total, entries)?;
            }
        }
        Ok(())
    }
    let mut bytes = 0;
    visit(path, &mut bytes, &mut 0).ok()?;
    Some(bytes)
}

async fn run_check(
    cwd: &Path,
    argv: &[String],
    cargo_target_dir: Option<&Path>,
    process_dir: &Path,
) -> Result<Value, String> {
    let (program, args) = argv.split_first().ok_or("Check command cannot be empty.")?;
    if program.contains('/') || program.contains('\\') || program.trim().is_empty() {
        return Err("Check command must name a program on PATH.".into());
    }
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = cargo_target_dir {
        command.env("CARGO_TARGET_DIR", path);
    }
    let registry = OwnedProcessRegistry::new(Some(process_dir.to_path_buf()));
    let mut child = registry
        .spawn(&mut command)
        .map_err(|e| format!("Could not run check: {e}"))?;
    let stdout_pipe = child.stdout.take().ok_or("Check stdout unavailable")?;
    let stderr_pipe = child.stderr.take().ok_or("Check stderr unavailable")?;
    let mut stdout_task = tokio::spawn(read_check_output(stdout_pipe));
    let mut stderr_task = tokio::spawn(read_check_output(stderr_pipe));
    let status = tokio::select! {
        result = child.wait() => match result {
            Ok(status) => status,
            Err(error) => {
                child.terminate_tree().await?;
                drain_check_output(&mut stdout_task, &mut stderr_task).await?;
                return Err(format!("Could not wait for check: {error}"));
            }
        },
        _ = tokio::time::sleep(std::time::Duration::from_secs(120)) => {
            child.terminate_tree().await?;
            let _ = child.wait().await;
            drain_check_output(&mut stdout_task, &mut stderr_task).await?;
            return Err("Check exceeded the 120 second time limit and was stopped.".into());
        }
    };
    // The main command may exit while descendants keep output descriptors
    // open. Stop the complete owned group before joining the readers.
    child.terminate_tree().await?;
    let (stdout, stderr) = drain_check_output(&mut stdout_task, &mut stderr_task).await?;
    let stdout: String = String::from_utf8_lossy(&stdout)
        .chars()
        .take(4000)
        .collect();
    let stderr: String = String::from_utf8_lossy(&stderr)
        .chars()
        .take(4000)
        .collect();
    Ok(
        json!({"argv":argv,"success":status.success(),"exitCode":status.code(),"stdout":stdout,"stderr":stderr}),
    )
}

async fn read_check_output<R: tokio::io::AsyncRead + Unpin>(
    mut input: R,
) -> std::io::Result<Vec<u8>> {
    const LIMIT: usize = 64 * 1024;
    let mut output = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let count = input.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        let remaining = LIMIT.saturating_sub(output.len());
        output.extend_from_slice(&chunk[..count.min(remaining)]);
    }
    Ok(output)
}

async fn drain_check_output(
    stdout: &mut tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
    stderr: &mut tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let joined = async {
        let (stdout, stderr) = tokio::join!(&mut *stdout, &mut *stderr);
        let stdout = stdout
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let stderr = stderr
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        Ok::<_, String>((stdout, stderr))
    };
    match tokio::time::timeout(std::time::Duration::from_secs(2), joined).await {
        Ok(result) => result,
        Err(_) => {
            stdout.abort();
            stderr.abort();
            let _ = stdout.await;
            let _ = stderr.await;
            Err("Check output pipes did not close after process-tree cleanup.".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{assistant_tasks::TaskStatus, host::HostPaths};
    use apex_core::{Access, Backend, ParticipantConfig, ParticipantId, RoomEvent, RoomOptions};
    use serde_json::json;
    use std::{
        path::PathBuf,
        process::Command,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };

    struct Fixture {
        host: Arc<Host>,
        runtime: tokio::runtime::Runtime,
        root: PathBuf,
        data: PathBuf,
        owner: TaskOwner,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
            let _ = std::fs::remove_dir_all(&self.data);
        }
    }

    #[test]
    fn dismiss_cancels_a_proposal_without_dispatch_and_refuses_started_work() {
        let f = fixture();
        let input = crate::assistant_tasks::HandoffPreparation { request_id:"dismiss-child".into(), batch_id:"dismiss-batch".into(), owner:f.owner.clone(), revision:f.host.monitor_get("workspace").unwrap().unwrap().revision, original_request:"Help me finish unfinished work".into(), brief:"Finish work".into(), destination:TaskDestination { thread_id:Some("parent".into()), workers:vec!["null".into()], new_thread:false }, mode:TaskMode::Isolated, review_criteria:vec![] };
        f.runtime.block_on(f.host.assistant_handoff_prepare(input)).unwrap();
        let task = f.host.assistant_tasks.list(None).unwrap().pop().unwrap();
        let dismiss = |revision| AssistantActionInput { task_id:task.id.clone(), revision, owner:f.owner.clone(), action:"dismiss".into(), mode:None, text:None, destination:None, new_worker_profiles:vec![], checks:None, spend_limit_micros:None };
        let dismissed = f.runtime.block_on(f.host.assistant_task_action(dismiss(task.revision))).unwrap();
        assert_eq!(dismissed.status, TaskStatus::Cancelled);
        assert!(dismissed.result_data.as_ref().unwrap()["dismissedAtMs"].as_u64().is_some());
        assert!(dismissed.execution_thread_id.is_none());
        assert!(f.host.assistant_runs.lock().unwrap().is_empty());
        let again = f.runtime.block_on(f.host.assistant_task_action(dismiss(dismissed.revision))).unwrap_err();
        assert!(again.contains("Only a proposed task"), "{again}");
    }

    #[test]
    fn handoff_prepare_checks_scope_revision_and_routing_without_dispatch() {
        let f = fixture();
        let input = crate::assistant_tasks::HandoffPreparation { request_id:"cross-child".into(), batch_id:"cross-batch".into(), owner:f.owner.clone(), revision:f.host.monitor_get("workspace").unwrap().unwrap().revision, original_request:"Ask Null to fix login and Jigga to test billing".into(), brief:"Fix login".into(), destination:TaskDestination { thread_id:Some("parent".into()), workers:vec!["null".into()], new_thread:false }, mode:TaskMode::Isolated, review_criteria:vec!["Login works".into()] };
        let receipt = f.runtime.block_on(f.host.assistant_handoff_prepare(input.clone())).unwrap();
        assert_eq!(receipt["task"]["status"], "proposed");
        assert!(receipt["task"]["executionThreadId"].is_null());
        assert!(f.host.assistant_runs.lock().unwrap().is_empty());
        let monitor = f.host.monitor_get("workspace").unwrap().unwrap();
        f.host.monitor_profile_update("workspace", crate::monitor_commands::MonitorOwner { cwd:f.owner.cwd.clone(), host_id:f.owner.host_id.clone(), conversation_id:f.owner.conversation_id.clone() }, monitor.revision, monitor.profile.clone().unwrap()).unwrap();
        assert_eq!(f.runtime.block_on(f.host.assistant_handoff_prepare(input.clone())).unwrap(), receipt);
        let task = f.host.assistant_tasks.list(None).unwrap().pop().unwrap();
        for action in ["approve", "clarify"] {
            let action = AssistantActionInput { task_id:task.id.clone(), revision:task.revision, owner:f.owner.clone(), action:action.into(), mode:None, text:None, destination:task.destination.clone(), new_worker_profiles:vec![], checks:None, spend_limit_micros:None };
            assert!(f.runtime.block_on(f.host.assistant_task_action(action)).is_err());
            assert_eq!(f.host.assistant_tasks.get(&task.id).unwrap().unwrap(), task, "Stale monitor must not transition the proposal");
            assert!(f.host.assistant_runs.lock().unwrap().is_empty());
        }
        let mut stale = input.clone(); stale.request_id = "stale-child".into();
        assert!(f.runtime.block_on(f.host.assistant_handoff_prepare(stale)).is_err());
        let mut owner_changed = input.clone(); owner_changed.owner.host_id = "other".into();
        assert!(f.runtime.block_on(f.host.assistant_handoff_prepare(owner_changed)).is_err());
        for worker in ["missing"] {
            let mut bad = input.clone(); bad.request_id = "bad-child".into(); bad.revision = f.host.monitor_get("workspace").unwrap().unwrap().revision; bad.destination.workers = vec![worker.into()];
            assert!(f.runtime.block_on(f.host.assistant_handoff_prepare(bad)).is_err());
        }
        assert_eq!(f.host.assistant_tasks.list(None).unwrap().len(), 1);
        f.host.change_monitor("workspace", |monitor, _| { monitor.conversation_id = "replacement".into(); Ok(()) }).unwrap();
        let task = f.host.assistant_tasks.list(None).unwrap().pop().unwrap();
        let action = AssistantActionInput { task_id:task.id, revision:task.revision, owner:f.owner.clone(), action:"approve".into(), mode:None, text:None, destination:task.destination, new_worker_profiles:vec![], checks:None, spend_limit_micros:None };
        assert!(f.runtime.block_on(f.host.assistant_task_action(action)).is_err());
        assert!(f.host.assistant_runs.lock().unwrap().is_empty());
    }

    #[test]
    fn handoff_saved_destination_uses_host_worker_not_client_same_id_profile() {
        let f = fixture();
        let input = crate::assistant_tasks::HandoffPreparation { request_id:"worker-child".into(), batch_id:"worker-batch".into(), owner:f.owner.clone(), revision:f.host.monitor_get("workspace").unwrap().unwrap().revision, original_request:"Fix login".into(), brief:"Fix login".into(), destination:TaskDestination { thread_id:Some("parent".into()), workers:vec!["null".into()], new_thread:false }, mode:TaskMode::Isolated, review_criteria:vec![] };
        let receipt = f.runtime.block_on(f.host.assistant_handoff_prepare(input)).unwrap();
        let task: AssistantTask = serde_json::from_value(receipt["task"].clone()).unwrap();
        let local_wrong = profile("null", Backend::Scripted { lines:vec!["Wrong client profile executed".into()] }, Access::Edits);
        let approved = f.runtime.block_on(f.host.assistant_task_action(AssistantActionInput { task_id:task.id, revision:task.revision, owner:f.owner.clone(), action:"approve".into(), mode:None, text:None, destination:task.destination, new_worker_profiles:vec![local_wrong], checks:None, spend_limit_micros:None })).unwrap();
        let finished = wait_for(&f, &approved.id);
        assert_eq!(finished.status, TaskStatus::ReadyForReview);
        assert_eq!(finished.result_data.as_ref().unwrap()["workerProfiles"], json!([]), "Saved destination must discard supplied client profiles before startup");
        let execution = f.host.store().room(finished.execution_thread_id.as_deref().unwrap()).unwrap().unwrap();
        let saved = f.host.store().room("parent").unwrap().unwrap();
        assert_eq!(serde_json::to_value(&execution.snapshot.participants[0].backend).unwrap(), serde_json::to_value(&saved.snapshot.participants[0].backend).unwrap());
        assert!(execution.snapshot.transcript.iter().all(|message| !message.text.contains("Wrong client profile executed")));
    }

    fn profile(id: &str, backend: Backend, access: Access) -> ParticipantConfig {
        ParticipantConfig {
            id: ParticipantId::new(id),
            display_name: id.into(),
            backend,
            persona: String::new(),
            access,
            effort: None,
            auto_effort: false,
            appearance: None,
            media: None,
        }
    }
    fn fixture() -> Fixture {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let suffix = NEXT.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "apex-assistant-service-{}-{suffix}",
            std::process::id()
        ));
        let root = base.join("repo");
        let data = base.join("data");
        std::fs::create_dir_all(&root).unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.invalid"],
        ] {
            assert!(Command::new("git")
                .current_dir(&root)
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        std::fs::write(root.join("tracked.txt"), "baseline\n").unwrap();
        assert!(Command::new("git")
            .current_dir(&root)
            .args(["add", "tracked.txt"])
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .current_dir(&root)
            .args(["commit", "-qm", "baseline"])
            .status()
            .unwrap()
            .success());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let host = Host::try_new(
            HostPaths {
                data: data.clone(),
                downloads: None,
            },
            runtime.handle().clone(),
        )
        .unwrap();
        let agent = profile(
            "null",
            Backend::Scripted {
                lines: vec![
                    "The requested change is complete.".into(),
                    "Continuation complete.".into(),
                    "Retry complete.".into(),
                ],
            },
            Access::Edits,
        );
        host.room_create(
            "parent".into(),
            vec![agent],
            RoomOptions::default(),
            Some(root.to_string_lossy().into_owned()),
        )
        .unwrap();
        let reasoner_profile = profile(
            "check",
            Backend::OpenAiCompatible {
                base_url: "http://127.0.0.1:1/v1".into(),
                model: "test-model".into(),
                api_key_env: None,
            },
            Access::Read,
        );
        host.monitor_assign(crate::monitor_commands::Assignment {
            workspace_id: "workspace".into(),
            cwd: root.to_string_lossy().into_owned(),
            host_id: "local".into(),
            text: "Handle requested project work".into(),
            files: vec![],
            threads: vec![],
            profile: reasoner_profile,
        })
        .unwrap();
        let monitor = host.monitor_get("workspace").unwrap().unwrap();
        Fixture {
            host,
            runtime,
            root,
            data,
            owner: TaskOwner {
                workspace_id: "workspace".into(),
                cwd: monitor.cwd,
                host_id: monitor.host_id,
                conversation_id: monitor.conversation_id,
            },
        }
    }

    #[test]
    fn failed_verification_check_records_output_and_clears_process_manifest() {
        let f = fixture();
        let process_dir =
            crate::assistant_isolation::operation_process_dir(&f.data, "check-task").unwrap();
        let result = f
            .runtime
            .block_on(run_check(
                &f.root,
                &[
                    "sh".into(),
                    "-c".into(),
                    "printf check-output; exit 9".into(),
                ],
                None,
                &process_dir,
            ))
            .unwrap();
        assert_eq!(result["success"], false);
        assert_eq!(result["exitCode"], 9);
        assert_eq!(result["stdout"], "check-output");
        assert_eq!(std::fs::read_dir(process_dir).unwrap().count(), 0);
    }

    #[test]
    fn ordinary_read_chat_dispatch_does_not_wait_for_task_integration() {
        let f = fixture();
        f.host.room_create("reader".into(), vec![profile("read-bot", Backend::Scripted { lines: vec!["Reading continued.".into()] }, Access::Read)], RoomOptions::default(), Some(f.owner.cwd.clone())).unwrap();
        f.runtime.block_on(async {
            let _integration = f.host.assistant_apply.lock().await;
            let dispatch = tokio::time::timeout(std::time::Duration::from_secs(2), f.host.room_post_to("reader".into(), "Read the project.".into(), vec![ParticipantId::new("read-bot")], false)).await;
            assert!(matches!(dispatch, Ok(Ok(()))), "A read chat must remain available during task integration.");
            for _ in 0..100 {
                if f.host.room_state("reader".into()).unwrap()["snapshot"]["transcript"].as_array().unwrap().iter().any(|message| message["text"] == "Reading continued.") { return; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            panic!("The read worker did not complete while integration was reserved.");
        });
    }

    #[test]
    fn overview_reasons_over_two_projects_without_mutating_the_assignment() {
        let f = fixture();
        let before = f.host.monitor_get(&f.owner.workspace_id).unwrap().unwrap();
        let input = crate::assistant_overview::OverviewInput {
            owner: f.owner.clone(), text: "Compare blockers everywhere".into(), history: vec![],
            projects: vec![
                json!({"workspaceId":"workspace","name":"Mobile","availability":"online","snapshot":{"findings":[{"evidence":[{"sourceId":"file:tests.md","label":"tests.md","excerpt":"Login fails","observedAt":1}]}]}}),
                json!({"workspaceId":"billing","name":"Billing","availability":"offline","snapshot":{"responsibility":"Ship billing"}}),
            ],
        };
        let result = f.runtime.block_on(f.host.assistant_overview_with(input, |_, request| {
            assert_eq!(request.access, Some(Access::Read));
            assert!(request.system.contains("Mobile") && request.system.contains("Billing"));
            assert!(request.system.contains("offline"));
            std::future::ready(Ok(json!({"message":"Mobile login is blocked; Billing is offline.","citations":[{"workspaceId":"workspace","sourceId":"file:tests.md","quote":"Login fails"}]}).to_string()))
        })).unwrap();
        assert_eq!(result["citations"][0]["evidence"]["excerpt"], "Login fails");
        assert_eq!(serde_json::to_value(f.host.monitor_get(&f.owner.workspace_id).unwrap().unwrap()).unwrap(), serde_json::to_value(before).unwrap());
    }

    #[test]
    fn overview_rejects_redirection_during_reasoning() {
        let f = fixture();
        let input = crate::assistant_overview::OverviewInput { owner: f.owner.clone(), text: "Overview".into(), history: vec![], projects: vec![json!({"workspaceId":"workspace"})] };
        let host = f.host.clone();
        let result = f.runtime.block_on(f.host.assistant_overview_with(input, move |_, _| {
            host.monitor_message("workspace", "Defer SSO").unwrap();
            std::future::ready(Ok(r#"{"message":"Old snapshot answer","citations":[]}"#.into()))
        }));
        assert!(result.unwrap_err().contains("redirected"));
    }

    #[test]
    fn overview_rejects_stale_owner_before_reasoning() {
        let f = fixture();
        let mut owner = f.owner.clone(); owner.conversation_id = "obsolete".into();
        let input = crate::assistant_overview::OverviewInput { owner, text: "Overview".into(), history: vec![], projects: vec![json!({"workspaceId":"workspace"})] };
        let result = f.runtime.block_on(f.host.assistant_overview_with(input, |_, _| { panic!("stale owner cannot call model"); #[allow(unreachable_code)] std::future::ready(Ok(String::new())) }));
        assert!(result.is_err());
    }

    #[test]
    fn routing_choices_use_saved_chat_workers_and_exclude_other_folders() {
        let f = fixture();
        let saved = f.host.store().room("parent").unwrap().unwrap();
        f.host.store().save_room("elsewhere", &crate::storage::SavedRoom {
            cwd: Some("/another/project".into()), snapshot: saved.snapshot,
        }).unwrap();
        f.host.store().save_session(&json!({
            "panes": [
                {"id":"parent","kind":"chat","workspaceId":"workspace"},
                {"id":"elsewhere","kind":"chat","workspaceId":"workspace"}
            ],
            "profiles": []
        })).unwrap();
        let snapshot = f.host.assistant_tasks_list(f.owner.clone()).unwrap();
        let threads = snapshot["routingThreads"].as_array().unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0]["id"], "parent");
        assert_eq!(threads[0]["workers"][0]["id"], "null", "A saved participant remains selectable after its library profile is deleted.");
    }

    #[test]
    fn cached_image_workers_are_excluded_from_all_task_routing_choices() {
        use std::io::{Read, Write};
        let f = fixture();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 8192]; stream.read(&mut request).unwrap();
            let body = r#"{"data":[{"id":"picture","type":"image"}]}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        f.runtime.block_on(apex_adapters::list_models(&base_url, None)).unwrap();
        server.join().unwrap();
        let image = profile("image", Backend::OpenAiCompatible { base_url, model: "picture".into(), api_key_env: None }, Access::Read);
        assert!(image.media.is_none(), "The provider catalogue, not profile media settings, identifies this worker.");
        assert!(!task_worker_eligible(&image));
        assert!(verify_task_workers(&[image.clone()]).is_err());
        let mut saved = f.host.store().room("parent").unwrap().unwrap();
        saved.snapshot.participants.push(image.clone());
        f.host.store().save_room("parent", &saved).unwrap();
        f.host.store().save_session(&json!({"panes":[{"id":"parent","kind":"chat","workspaceId":"workspace"}],"profiles":[image]})).unwrap();
        let snapshot = f.host.assistant_tasks_list(f.owner.clone()).unwrap();
        assert_eq!(snapshot["namedOnlyWorkerIds"], json!(["image"]));
        assert_eq!(snapshot["routingThreads"][0]["workers"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn clarification_validation_keeps_task_pending_and_delivers_human_scope() {
        let f = fixture();
        let response = f.runtime.block_on(f.host.assistant_message_with(input(&f, "clarify-scope"), |_, _| {
            std::future::ready(Ok(json!({"kind":"clarify","message":"Choose a destination.","brief":"Review the project."}).to_string()))
        })).unwrap();
        let task: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        let mut action = AssistantActionInput {
            task_id: task.id.clone(), revision: task.revision, owner: f.owner.clone(), action:"clarify".into(),
            text: Some("Review the open chats only; leave archived chats untouched.".into()),
            destination: Some(TaskDestination {thread_id:Some("parent".into()),workers:vec!["null".into()],new_thread:false}),
            new_worker_profiles:vec![], mode:Some(TaskMode::ReadOnly), checks:Some(vec![vec!["npm".into(),"test".into()]]), spend_limit_micros:None,
        };
        assert!(f.runtime.block_on(f.host.assistant_task_action(action.clone())).unwrap_err().contains("Read-only"));
        let unchanged = f.host.assistant_tasks.get(&task.id).unwrap().unwrap();
        assert_eq!(unchanged.status, TaskStatus::NeedsClarification);
        assert_eq!(unchanged.revision, task.revision, "Invalid controls must not consume the routing decision.");
        action.checks = None;
        f.runtime.block_on(f.host.assistant_task_action(action)).unwrap();
        let ready = wait_for(&f, &task.id);
        assert_eq!(ready.status, TaskStatus::ReadyForReview);
        assert_eq!(ready.original_request, task.original_request);
        let state = f.host.room_state(ready.execution_thread_id.unwrap()).unwrap();
        assert!(state["snapshot"]["transcript"].as_array().unwrap().iter().any(|message| message["text"].as_str().is_some_and(|text| text.contains("Additional human clarification") && text.contains("leave archived chats untouched"))));
        assert!(ready.result_data.unwrap()["taskHistory"].as_array().unwrap().iter().any(|entry| entry["kind"] == "clarification"));
    }
    fn input(f: &Fixture, request_id: &str) -> AssistantMessageInput {
        AssistantMessageInput {
            workspace_id: f.owner.workspace_id.clone(),
            cwd: f.owner.cwd.clone(),
            host_id: f.owner.host_id.clone(),
            conversation_id: f.owner.conversation_id.clone(),
            request_id: request_id.into(),
            text: "Please fix this in the Build Room and ask @null".into(),
            destination: None,
            new_worker_profiles: vec![],
            thread_labels: vec![ThreadLabel {
                id: "parent".into(),
                label: "Build Room".into(),
            }],
            mode: TaskMode::InPlace,
            checks: vec![],
            worker_profiles: vec![],
            spend_limit_micros: None,
        }
    }
    fn handoff(
        _: ParticipantConfig,
        _: apex_core::TurnRequest,
    ) -> std::future::Ready<Result<String, String>> {
        std::future::ready(Ok(json!({"kind":"handoff","message":"I can take this on.","brief":"Fix the requested issue.","threadId":"model-invented","workers":["another-worker"],"reviewCriteria":["inspect the change"]}).to_string()))
    }
    fn wait_for(f: &Fixture, id: &str) -> AssistantTask {
        f.runtime.block_on(async {
            for _ in 0..1500 {
                let task = f.host.assistant_tasks.get(id).unwrap().unwrap();
                if matches!(
                    task.status,
                    TaskStatus::Proposed
                        | TaskStatus::NeedsClarification
                        | TaskStatus::ReadyForReview
                        | TaskStatus::Failed
                        | TaskStatus::NeedsYou
                ) {
                    return task;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            let task = f.host.assistant_tasks.get(id).unwrap().unwrap();
            panic!(
                "assistant task did not finish within 15 seconds: status={:?}, result={:?}",
                task.status, task.result
            )
        })
    }

    fn isolated_task(f: &Fixture, request_id: &str) -> AssistantTask {
        let mut request = input(f, request_id);
        request.mode = TaskMode::Isolated;
        let reason = |_: ParticipantConfig, _: apex_core::TurnRequest| {
            std::future::ready(Ok(json!({"kind":"handoff","message":"I can take this on.","brief":"Fix the requested issue.","threadId":"parent","workers":["null"],"reviewCriteria":[]}).to_string()))
        };
        let response = f
            .runtime
            .block_on(f.host.assistant_message_with(request, reason))
            .unwrap();
        let receipt: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        wait_for(f, &receipt.id)
    }

    fn budget_paused_wait_task(f: &Fixture, request_id: &str, wait: RoomEvent, stop_first: bool) -> AssistantTask {
        let mut request = input(f, request_id);
        request.mode = TaskMode::ReadOnly;
        let response = f.runtime.block_on(f.host.assistant_message_with(request, handoff)).unwrap();
        let initial: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        let task = wait_for(f, &initial.id);
        let child = task.execution_thread_id.clone().unwrap();
        let (_, run_id) = f.host.assistant_tasks.begin_attempt(&task.id, task.revision, &task.owner).unwrap();
        *f.host.handle(&child).unwrap().task_run_id.lock().unwrap() = Some(run_id.clone());
        f.host.room_event(&child, wait);
        if stop_first {
            f.host.room_event(&child, RoomEvent::Stopped);
        }
        let active = f.host.assistant_tasks.get(&task.id).unwrap().unwrap();
        let mut data = active.result_data.clone().unwrap_or_else(|| json!({}));
        data["budgetPaused"] = json!(true);
        data["spendLimitMicros"] = Value::Null;
        f.host.assistant_tasks.set_result_data(&task.id, active.revision, &task.owner, Some(data.clone())).unwrap();
        f.host.assistant_tasks.finish_attempt(&task.id, &run_id, TaskOutcome {
            status: TaskStatus::NeedsYou,
            result: Some("Paused at the reported spend limit.".into()),
            result_data: Some(data),
            usage: None,
        }).unwrap()
    }

    fn set_isolated_result(
        f: &Fixture,
        task: &AssistantTask,
        path: &str,
        contents: &str,
    ) -> AssistantTask {
        let data = task.result_data.as_ref().unwrap();
        let worktree = Path::new(data["executionPath"].as_str().unwrap());
        std::fs::write(worktree.join(path), contents).unwrap();
        let snapshot = assistant_git::capture_result(worktree, &task.id).unwrap();
        let diff = assistant_git::review_diff(
            worktree,
            data["baselineSnapshot"]["commit"].as_str().unwrap(),
            &snapshot.commit,
        )
        .unwrap();
        let result_commit = snapshot.commit.clone();
        let mut result_data = data.clone();
        result_data["resultSnapshot"] = serde_json::to_value(snapshot).unwrap();
        result_data["diff"] = json!(diff);
        result_data["reviewDiff"] = json!(diff);
        result_data["baselineCommit"] = data["baselineSnapshot"]["commit"].clone();
        result_data["resultCommit"] = json!(result_commit);
        f.host
            .assistant_tasks
            .set_result_data(&task.id, task.revision, &task.owner, Some(result_data))
            .unwrap()
    }

    #[test]
    fn authorized_human_request_creates_one_linked_child_and_finishes_review_capture() {
        let f = fixture();
        let result = f
            .runtime
            .block_on(f.host.assistant_message_with(input(&f, "req-1"), handoff))
            .unwrap();
        let initial: AssistantTask = serde_json::from_value(result["task"].clone()).unwrap();
        let task = wait_for(&f, &initial.id);
        assert_eq!(task.status, TaskStatus::ReadyForReview);
        assert_eq!(task.owner, f.owner);
        assert_eq!(task.parent_thread_id.as_deref(), Some("parent"));
        assert!(task.execution_thread_id.is_some());
        assert_eq!(
            f.host
                .assistant_tasks
                .list(Some("workspace"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            f.host
                .assistant_tasks
                .list_executions(Some("workspace"))
                .len(),
            1
        );
        assert_eq!(task_monitor(Some(&task))["status"], "ready_for_review");
    }

    #[test]
    fn read_only_result_needs_no_git_or_writer_lease_and_cannot_gain_edit_access() {
        let f = fixture();
        std::fs::rename(f.root.join(".git"), f.data.join("fixture-git")).unwrap();
        let mut request = input(&f, "read-only-request"); request.mode = TaskMode::ReadOnly;
        let response = f.runtime.block_on(f.host.assistant_message_with(request, handoff)).unwrap();
        let initial: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        let task = wait_for(&f, &initial.id);
        assert_eq!(task.status, TaskStatus::ReadyForReview, "{:?}", task.result);
        assert_eq!(task.mode, TaskMode::ReadOnly);
        assert_eq!(task.result.as_deref(), Some("The requested change is complete."));
        assert_eq!(task.result_data.as_ref().unwrap()["leaseHeld"], false);
        let child = task.execution_thread_id.as_ref().unwrap();
        let state = f.host.room_state(child.clone()).unwrap();
        assert_eq!(state["snapshot"]["participants"][0]["access"], "read");
        let mut worker = serde_json::from_value::<ParticipantConfig>(state["snapshot"]["participants"][0].clone()).unwrap();
        worker.access = Access::Edits;
        assert!(f.runtime.block_on(f.host.room_update_participant(child.clone(), worker)).is_err());
        let done = f.runtime.block_on(f.host.assistant_task_action(AssistantActionInput { task_id:task.id, revision:task.revision, owner:f.owner.clone(), action:"review".into(), mode:None, text:None, destination:None, new_worker_profiles:vec![], checks:None, spend_limit_micros:None })).unwrap();
        assert_eq!(done.status, TaskStatus::Done);
        assert!(!f.root.join(".git").exists());
    }

    #[test]
    fn notes_and_revisions_preserve_human_request_and_worker_history() {
        let f = fixture();
        let mut request = input(&f, "note-request"); request.mode = TaskMode::ReadOnly;
        let response = f.runtime.block_on(f.host.assistant_message_with(request, handoff)).unwrap();
        let initial: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        let task = wait_for(&f, &initial.id);
        let noted = f.runtime.block_on(f.host.assistant_task_action(AssistantActionInput { task_id:task.id.clone(), revision:task.revision, owner:f.owner.clone(), action:"note".into(), mode:None, text:Some("Keep my archived chats untouched.".into()), destination:None, new_worker_profiles:vec![], checks:None, spend_limit_micros:None })).unwrap();
        f.runtime.block_on(f.host.assistant_task_action(AssistantActionInput { task_id:task.id.clone(), revision:noted.revision, owner:f.owner.clone(), action:"request_changes".into(), mode:None, text:Some("Summarize only the active chats.".into()), destination:None, new_worker_profiles:vec![], checks:None, spend_limit_micros:None })).unwrap();
        let ready = wait_for(&f, &task.id);
        assert_eq!(ready.status, TaskStatus::ReadyForReview);
        assert_eq!(ready.original_request, task.original_request);
        assert_eq!(ready.attempts.len(), 2);
        let messages = f.host.room_state(ready.execution_thread_id.unwrap()).unwrap()["snapshot"]["transcript"].clone();
        assert!(messages.as_array().unwrap().iter().any(|message| message["text"].as_str().is_some_and(|text| text.contains("Additional human note") && text.contains("archived chats untouched"))));
        assert!(ready.result_data.as_ref().unwrap()["taskHistory"].as_array().unwrap().iter().any(|entry| entry["kind"] == "revision"));
    }

    #[test]
    fn budget_resume_cannot_bypass_a_live_question_or_approval() {
        let waits = [
            RoomEvent::QuestionRequested {
                id: ParticipantId::new("null"),
                request: "question-1".into(),
                questions: vec![apex_core::Question { header: "Choice".into(), question: "Which?".into(), options: vec![], multi_select: false }],
            },
            RoomEvent::ApprovalRequested {
                id: ParticipantId::new("null"),
                request: "approval-1".into(),
                action: apex_core::ProposedAction { kind: apex_core::ActionKind::Command, title: "Run command".into(), detail: "make change".into(), expires_at: None, risky: false },
            },
        ];
        for (index, wait) in waits.into_iter().enumerate() {
            let f = fixture();
            let task = budget_paused_wait_task(&f, &format!("budget-live-wait-{index}"), wait, false);
            let child = task.execution_thread_id.clone().unwrap();
            let state = f.host.room_state(child.clone()).unwrap();
            assert!(!state["questions"].as_array().unwrap().is_empty() || !state["approvals"].as_array().unwrap().is_empty());
            let result = f.runtime.block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: task.id.clone(), revision: task.revision, owner: f.owner.clone(), action: "resume_budget".into(),
                mode: None, text: None, destination: None, new_worker_profiles: vec![], checks: None, spend_limit_micros: None,
            }));
            assert!(result.unwrap_err().contains("Answer the worker's open question or approval first"));
            assert_eq!(f.host.assistant_tasks.get(&task.id).unwrap().unwrap().attempts.len(), task.attempts.len());
        }
    }

    #[test]
    fn stopped_budget_paused_wait_clears_durable_waits_and_can_resume() {
        let f = fixture();
        let task = budget_paused_wait_task(&f, "budget-stopped-wait", RoomEvent::QuestionRequested {
            id: ParticipantId::new("null"), request: "question-stop".into(),
            questions: vec![apex_core::Question { header: "Choice".into(), question: "Which?".into(), options: vec![], multi_select: false }],
        }, true);
        assert_eq!(task.status, TaskStatus::NeedsYou);
        let data = task.result_data.as_ref().unwrap();
        assert!(data["pendingQuestions"].as_array().is_none_or(Vec::is_empty));
        assert!(data["pendingApprovals"].as_array().is_none_or(Vec::is_empty));
        let child = task.execution_thread_id.clone().unwrap();
        let state = f.host.room_state(child).unwrap();
        assert!(state["questions"].as_array().unwrap().is_empty());
        assert!(state["approvals"].as_array().unwrap().is_empty());
        let mut stale_wait = task.result_data.clone().unwrap();
        stale_wait["pendingQuestions"] = json!([{"id":"null","request":"stale-question","questions":[]}]);
        let task = f.host.assistant_tasks.set_result_data(&task.id, task.revision, &f.owner, Some(stale_wait)).unwrap();
        let blocked = f.runtime.block_on(f.host.assistant_task_action(AssistantActionInput {
            task_id: task.id.clone(), revision: task.revision, owner: f.owner.clone(), action: "resume_budget".into(),
            mode: None, text: None, destination: None, new_worker_profiles: vec![], checks: None, spend_limit_micros: None,
        }));
        assert!(blocked.unwrap_err().contains("Answer the worker's open question or approval first"));
        let latest = f.host.assistant_tasks.get(&task.id).unwrap().unwrap();
        let mut cleared_wait = latest.result_data.clone().unwrap();
        cleared_wait["pendingQuestions"] = json!([]);
        let task = f.host.assistant_tasks.set_result_data(&task.id, latest.revision, &f.owner, Some(cleared_wait)).unwrap();
        let resumed = f.runtime.block_on(f.host.assistant_task_action(AssistantActionInput {
            task_id: task.id.clone(), revision: task.revision, owner: f.owner.clone(), action: "resume_budget".into(),
            mode: None, text: None, destination: None, new_worker_profiles: vec![], checks: None, spend_limit_micros: None,
        })).unwrap();
        let settled = wait_for(&f, &task.id);
        assert!(settled.attempts.len() > task.attempts.len());
        assert!(matches!(settled.status, TaskStatus::ReadyForReview | TaskStatus::Failed), "resume receipt {:?}, settled {:?}", resumed.status, settled.status);
    }

    #[test]
    fn simultaneous_queued_receipt_replay_runs_only_one_attempt() {
        let f = fixture();
        let gate = f.host.checkout_gate(Path::new(&f.owner.cwd));
        let lease = f
            .runtime
            .block_on(gate.acquire_retained("test-blocker", Arc::new(AtomicBool::new(false))))
            .unwrap();
        drop(lease);
        let original = input(&f, "req-queued-replay");
        let reason = |_: ParticipantConfig, _: apex_core::TurnRequest| {
            std::future::ready(Ok(json!({"kind":"handoff","message":"I can take this on.","brief":"Fix the requested issue.","threadId":"parent","workers":["null"],"reviewCriteria":[]}).to_string()))
        };
        let response = f
            .runtime
            .block_on(f.host.assistant_message_with(original.clone(), reason))
            .unwrap();
        let task: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        let reason_a = |_: ParticipantConfig, _: apex_core::TurnRequest| {
            std::future::ready(Err("duplicate should not invoke reasoner".into()))
        };
        let reason_b = |_: ParticipantConfig, _: apex_core::TurnRequest| {
            std::future::ready(Err("duplicate should not invoke reasoner".into()))
        };
        let a = f.host.assistant_message_with(original.clone(), reason_a);
        let b = f.host.assistant_message_with(original, reason_b);
        let (a, b) = f.runtime.block_on(async { tokio::join!(a, b) });
        assert!(a.is_ok() && b.is_ok());
        assert!(gate.release("test-blocker"));
        let finished = wait_for(&f, &task.id);
        assert_eq!(
            finished.status,
            TaskStatus::ReadyForReview,
            "retry failed: {:?}",
            finished.result
        );
        assert_eq!(finished.attempts.len(), 1);
    }

    #[test]
    fn queued_zero_attempt_task_after_restart_is_dispatched_again() {
        let f = fixture();
        let destination = TaskDestination {
            thread_id: Some("parent".into()),
            workers: vec!["null".into()],
            new_thread: false,
        };
        let queued = f
            .host
            .assistant_tasks
            .submit_human_request(
                HumanRequest {
                    request_id: "manual-queued-restart".into(),
                    owner: f.owner.clone(),
                    text: "Fix this in the Build Room and ask @null".into(),
                    destination: Some(destination.clone()),
                },
                "Fix the requested issue.".into(),
                Some(destination),
            )
            .unwrap();
        let mut data = json!({"mode":"in_place","checks":[],"executionPath":f.owner.cwd,"leaseHeld":false,"workerProfiles":[]});
        let queued = f
            .host
            .assistant_tasks
            .set_result_data(
                &queued.id,
                queued.revision,
                &f.owner,
                Some(std::mem::take(&mut data)),
            )
            .unwrap();
        assert_eq!(queued.attempts.len(), 0);

        let restarted_runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let restarted = Host::try_new(
            HostPaths {
                data: f.data.clone(),
                downloads: None,
            },
            restarted_runtime.handle().clone(),
        )
        .unwrap();
        let still_queued = restarted.assistant_tasks.get(&queued.id).unwrap().unwrap();
        assert_eq!(still_queued.status, TaskStatus::Queued, "a task that never started stays queued across a restart");
        assert!(still_queued.attempts.is_empty());
        restarted.redispatch_recovered_queued().unwrap();
        let finished = restarted_runtime.block_on(async {
            // Same 15-second budget as wait_for; 3 seconds flaked under full-suite load.
            for _ in 0..1500 {
                let task = restarted.assistant_tasks.get(&still_queued.id).unwrap().unwrap();
                if matches!(
                    task.status,
                    TaskStatus::ReadyForReview | TaskStatus::Failed | TaskStatus::NeedsYou
                ) {
                    return task;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            panic!("explicit retry did not finish within 15 seconds")
        });
        assert_eq!(
            finished.status,
            TaskStatus::ReadyForReview,
            "retry failed: {:?}",
            finished.result
        );
        assert_eq!(finished.attempts.len(), 1);
    }

    #[test]
    fn isolated_task_runs_in_task_worktree_and_accepts_through_integration() {
        let f = fixture();
        let task = isolated_task(&f, "req-isolated");
        assert_eq!(task.status, TaskStatus::ReadyForReview);
        assert_eq!(task.mode, TaskMode::Isolated);
        let execution_path = task.result_data.as_ref().unwrap()["executionPath"]
            .as_str()
            .unwrap();
        assert_ne!(Path::new(execution_path), f.root.as_path());
        assert!(Path::new(execution_path).join(".git").exists());
        let task = set_isolated_result(&f, &task, "tracked.txt", "worker task one\n");
        std::fs::write(f.root.join("human-staged.txt"), "human work\n").unwrap();
        let git_add = Command::new("git")
            .current_dir(&f.root)
            .args(["add", "human-staged.txt"])
            .status()
            .unwrap();
        assert!(git_add.success());
        let staged_index = std::fs::read(f.root.join(".git/index")).unwrap();
        let accepted = f
            .runtime
            .block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: task.id.clone(),
                revision: task.revision,
                owner: f.owner.clone(),
                action: "accept".into(),
                mode: None,
                text: None,
                destination: None,
                new_worker_profiles: vec![],
                checks: None,
             spend_limit_micros: None, }))
            .unwrap();
        assert_eq!(accepted.status, TaskStatus::Done);
        assert_eq!(
            std::fs::read_to_string(f.root.join("tracked.txt")).unwrap(),
            "worker task one\n"
        );
        assert_eq!(
            std::fs::read_to_string(f.root.join("human-staged.txt")).unwrap(),
            "human work\n"
        );
        assert_eq!(
            std::fs::read(f.root.join(".git/index")).unwrap(),
            staged_index
        );
        assert_eq!(accepted.result_data.as_ref().unwrap()["leaseHeld"], false);
        let archived = f
            .runtime
            .block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: accepted.id.clone(),
                revision: accepted.revision,
                owner: f.owner.clone(),
                action: "archive".into(),
                mode: None,
                text: None,
                destination: None,
                new_worker_profiles: vec![],
                checks: None,
             spend_limit_micros: None, }))
            .unwrap();
        assert!(archived.result_data.as_ref().unwrap()["archivedAtMs"]
            .as_u64()
            .is_some());
        assert!(f
            .host
            .assistant_tasks
            .execution(archived.execution_thread_id.as_deref().unwrap())
            .unwrap()
            .unwrap()
            .is_tombstoned());
        assert!(!Path::new(execution_path).exists());

        let second = isolated_task(&f, "req-isolated-second");
        let second = set_isolated_result(&f, &second, "second.txt", "worker task two\n");
        let accepted = f
            .runtime
            .block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: second.id.clone(),
                revision: second.revision,
                owner: f.owner.clone(),
                action: "accept".into(),
                mode: None,
                text: None,
                destination: None,
                new_worker_profiles: vec![],
                checks: None,
             spend_limit_micros: None, }))
            .unwrap();
        assert_eq!(accepted.status, TaskStatus::Done);
        assert_eq!(
            std::fs::read_to_string(f.root.join("second.txt")).unwrap(),
            "worker task two\n"
        );
        assert_eq!(
            std::fs::read(f.root.join(".git/index")).unwrap(),
            staged_index
        );

        let conflicting = isolated_task(&f, "req-isolated-conflict");
        let conflicting = set_isolated_result(&f, &conflicting, "tracked.txt", "worker conflict\n");
        std::fs::write(f.root.join("tracked.txt"), "human conflict\n").unwrap();
        let result = f
            .runtime
            .block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: conflicting.id.clone(),
                revision: conflicting.revision,
                owner: f.owner.clone(),
                action: "accept".into(),
                mode: None,
                text: None,
                destination: None,
                new_worker_profiles: vec![],
                checks: None,
             spend_limit_micros: None, }));
        assert!(result.is_err());
        let latest = f
            .host
            .assistant_tasks
            .get(&conflicting.id)
            .unwrap()
            .unwrap();
        assert_eq!(latest.status, TaskStatus::ReadyForReview);
        assert_eq!(
            std::fs::read_to_string(f.root.join("tracked.txt")).unwrap(),
            "human conflict\n"
        );
    }

    #[test]
    fn unsupported_isolated_worker_stays_needs_you_and_can_be_retried() {
        let f = fixture();
        let codex = profile(
            "codex",
            Backend::Agent {
                tool: apex_core::AgentTool::Codex,
                model: None,
            },
            Access::Edits,
        );
        let mut request = input(&f, "req-isolated-needs-you");
        request.mode = TaskMode::Isolated;
        request.destination = Some(TaskDestination {
            thread_id: None,
            workers: vec!["codex".into()],
            new_thread: true,
        });
        request.new_worker_profiles = vec![codex];
        let reason = |_: ParticipantConfig, _: apex_core::TurnRequest| {
            std::future::ready(Ok(json!({"kind":"handoff","message":"I can take this on.","brief":"Make the requested change.","threadId":"ignored","workers":["codex"],"reviewCriteria":[]}).to_string()))
        };
        let response = f
            .runtime
            .block_on(f.host.assistant_message_with(request, reason))
            .unwrap();
        let receipt: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        let task = wait_for(&f, &receipt.id);
        assert_eq!(task.status, TaskStatus::NeedsYou);
        assert!(task.attempts.is_empty());
        assert!(task.result_data.as_ref().unwrap()["startup"]["message"]
            .as_str()
            .unwrap()
            .contains("needs you"));
        let retried_receipt = f
            .runtime
            .block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: task.id.clone(),
                revision: task.revision,
                owner: f.owner.clone(),
                action: "retry".into(),
                mode: None,
                text: None,
                destination: None,
                new_worker_profiles: vec![],
                checks: None,
             spend_limit_micros: None, }))
            .unwrap();
        let retried = wait_for(&f, &retried_receipt.id);
        assert_eq!(retried.status, TaskStatus::NeedsYou);
        assert!(retried.attempts.is_empty());
    }

    #[test]
    fn duplicate_request_returns_the_existing_task_without_running_reasoner_again() {
        let f = fixture();
        let first = f
            .runtime
            .block_on(f.host.assistant_message_with(input(&f, "req-1"), handoff))
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let hit = Arc::clone(&calls);
        let second = f
            .runtime
            .block_on(
                f.host
                    .assistant_message_with(input(&f, "req-1"), move |_, _| {
                        hit.fetch_add(1, Ordering::SeqCst);
                        std::future::ready(Err("must not run".into()))
                    }),
            )
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(first["task"]["id"], second["task"]["id"]);
        let id = first["task"]["id"].as_str().unwrap();
        let _ = wait_for(&f, id);
        assert_eq!(
            f.host
                .assistant_tasks
                .list(Some("workspace"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            f.host
                .assistant_tasks
                .list_executions(Some("workspace"))
                .len(),
            1
        );
    }

    #[test]
    fn model_proposal_is_persisted_but_never_starts_a_worker() {
        let f = fixture();
        let response = f.runtime.block_on(f.host.assistant_message_with(input(&f, "proposal-1"), |_, _| std::future::ready(Ok(json!({"kind":"proposal","message":"Consider fixing this.","brief":"Potential fix."}).to_string())))).unwrap();
        let initial: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        let task = wait_for(&f, &initial.id);
        assert_eq!(task.status, TaskStatus::Proposed);
        assert!(task.execution_thread_id.is_none());
        assert!(f
            .host
            .assistant_tasks
            .list_executions(Some("workspace"))
            .is_empty());
        let invalid = f
            .runtime
            .block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: task.id.clone(),
                revision: task.revision,
                owner: f.owner.clone(),
                action: "approve".into(),
                mode: None,
                text: None,
                destination: Some(TaskDestination {
                    thread_id: None,
                    workers: vec!["codex".into()],
                    new_thread: true,
                }),
                new_worker_profiles: vec![],
                checks: None,
             spend_limit_micros: None, }));
        assert!(invalid.is_err());
        let unchanged = f.host.assistant_tasks.get(&task.id).unwrap().unwrap();
        assert_eq!(unchanged.status, TaskStatus::Proposed);
        assert_eq!(unchanged.revision, task.revision);
    }

    #[test]
    fn approval_preserves_isolated_mode_requested_before_proposal() {
        let f = fixture();
        let mut request = input(&f, "proposal-isolated");
        request.mode = TaskMode::Isolated;
        let response = f.runtime.block_on(f.host.assistant_message_with(request, |_, _| std::future::ready(Ok(json!({"kind":"proposal","message":"I can prepare this.","brief":"Make the requested change."}).to_string())))).unwrap();
        let task: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        assert_eq!(task.status, TaskStatus::Proposed);
        assert_eq!(task.result_data.as_ref().unwrap()["mode"], "isolated");
        let worker = profile(
            "null",
            Backend::Scripted {
                lines: vec!["Approved change complete.".into()],
            },
            Access::Edits,
        );
        let queued = f
            .runtime
            .block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: task.id.clone(),
                revision: task.revision,
                owner: f.owner.clone(),
                action: "approve".into(),
                mode: None,
                text: None,
                destination: Some(TaskDestination {
                    thread_id: None,
                    workers: vec!["null".into()],
                    new_thread: true,
                }),
                new_worker_profiles: vec![worker],
                checks: None,
             spend_limit_micros: None, }))
            .unwrap();
        let ready = wait_for(&f, &queued.id);
        assert_eq!(ready.status, TaskStatus::ReadyForReview);
        assert_eq!(ready.mode, TaskMode::Isolated);
    }

    #[test]
    fn interrupted_isolated_apply_reconciles_after_host_restart() {
        let f = fixture();
        let task = isolated_task(&f, "req-interrupted-apply");
        let task = set_isolated_result(&f, &task, "tracked.txt", "worker result\n");
        let data = task.result_data.as_ref().unwrap();
        let baseline: assistant_git::GitSnapshot =
            serde_json::from_value(data["baselineSnapshot"].clone()).unwrap();
        let result: assistant_git::GitSnapshot =
            serde_json::from_value(data["resultSnapshot"].clone()).unwrap();
        let plan =
            assistant_git::stage_integration(&f.root, &baseline, &result.commit, &task.id, &f.data)
                .unwrap();
        std::fs::write(
            f.root.join("tracked.txt"),
            std::fs::read(plan.scratch_path.join("tracked.txt")).unwrap(),
        )
        .unwrap();
        let journal = f
            .data
            .join("apex-agent")
            .join("tasks")
            .join(&task.id)
            .join("apply.json");
        std::fs::create_dir_all(journal.parent().unwrap()).unwrap();
        std::fs::write(&journal, serde_json::to_vec(&json!({"version":1,"taskId":task.id,"phase":"applying","completedPaths":["tracked.txt"],"mergedCommit":plan.merged_commit})).unwrap()).unwrap();
        let mut persisted = data.clone();
        persisted["integrationPlan"] = serde_json::to_value(&plan).unwrap();
        persisted["applyJournal"] = json!(journal);
        let applying = f
            .host
            .assistant_tasks
            .set_result_data(&task.id, task.revision, &f.owner, Some(persisted))
            .unwrap();
        let applying = f
            .host
            .assistant_tasks
            .transition(
                &applying.id,
                applying.revision,
                &f.owner,
                TaskStatus::Applying,
                None,
            )
            .unwrap();
        assert_eq!(applying.status, TaskStatus::Applying);

        let restarted_runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let restarted = Host::try_new(
            HostPaths {
                data: f.data.clone(),
                downloads: None,
            },
            restarted_runtime.handle().clone(),
        )
        .unwrap();
        let interrupted = restarted.assistant_tasks.get(&task.id).unwrap().unwrap();
        assert_eq!(interrupted.status, TaskStatus::Interrupted);
        let before = interrupted.result_data.clone();
        let child = interrupted.execution_thread_id.clone().unwrap();
        assert!(restarted_runtime
            .block_on(
                restarted.room_post(child.clone(), "Continue despite pending integration".into(),)
            )
            .is_err());
        assert!(restarted_runtime
            .block_on(restarted.assistant_task_action(AssistantActionInput {
                task_id: interrupted.id.clone(),
                revision: interrupted.revision,
                owner: f.owner.clone(),
                action: "retry".into(),
                mode: None,
                text: None,
                destination: None,
                new_worker_profiles: vec![],
                checks: None,
             spend_limit_micros: None, }))
            .is_err());
        for action in ["cancel", "archive"] {
            assert!(restarted_runtime
                .block_on(restarted.assistant_task_action(AssistantActionInput {
                    task_id: interrupted.id.clone(),
                    revision: interrupted.revision,
                    owner: f.owner.clone(),
                    action: action.into(),
                    mode: None,
                    text: None,
                    destination: None,
                    new_worker_profiles: vec![],
                    checks: None,
                 spend_limit_micros: None, }))
                .is_err());
        }
        let still_interrupted = restarted.assistant_tasks.get(&task.id).unwrap().unwrap();
        assert_eq!(still_interrupted.status, TaskStatus::Interrupted);
        assert_eq!(still_interrupted.attempts.len(), task.attempts.len());
        assert_eq!(still_interrupted.result_data, before);
        let reconciled = restarted_runtime
            .block_on(restarted.assistant_task_action(AssistantActionInput {
                task_id: task.id.clone(),
                revision: interrupted.revision,
                owner: f.owner.clone(),
                action: "reconcile".into(),
                mode: None,
                text: None,
                destination: None,
                new_worker_profiles: vec![],
                checks: None,
             spend_limit_micros: None, }))
            .unwrap();
        assert_eq!(reconciled.status, TaskStatus::ReadyForReview);
        assert!(reconciled.result_data.as_ref().unwrap()["integrationPlan"].is_null());
        assert!(reconciled.result_data.as_ref().unwrap()["applyJournal"].is_null());
        assert_eq!(
            std::fs::read_to_string(f.root.join("tracked.txt")).unwrap(),
            "baseline\n"
        );
    }

    #[test]
    fn accept_rechecks_snapshot_and_cancel_uses_owner_revision() {
        let f = fixture();
        let response = f
            .runtime
            .block_on(
                f.host
                    .assistant_message_with(input(&f, "req-accept"), handoff),
            )
            .unwrap();
        let initial: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        let task = wait_for(&f, &initial.id);
        let accepted = f
            .runtime
            .block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: task.id.clone(),
                revision: task.revision,
                owner: f.owner.clone(),
                action: "accept".into(),
                mode: None,
                text: None,
                destination: None,
                new_worker_profiles: vec![],
                checks: None,
             spend_limit_micros: None, }))
            .unwrap();
        assert_eq!(accepted.status, TaskStatus::Done);
        let cancelled_task = f
            .host
            .assistant_tasks
            .create_proposal(f.owner.clone(), "Cancel me".into(), "proposal".into())
            .unwrap();
        let cancelled = f
            .runtime
            .block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: cancelled_task.id.clone(),
                revision: cancelled_task.revision,
                owner: f.owner.clone(),
                action: "cancel".into(),
                mode: None,
                text: None,
                destination: None,
                new_worker_profiles: vec![],
                checks: None,
             spend_limit_micros: None, }))
            .unwrap();
        assert_eq!(cancelled.status, TaskStatus::Cancelled);
        assert!(f
            .runtime
            .block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: cancelled.id.clone(),
                revision: cancelled_task.revision,
                owner: f.owner.clone(),
                action: "cancel".into(),
                mode: None,
                text: None,
                destination: None,
                new_worker_profiles: vec![],
                checks: None
            , spend_limit_micros: None, }))
            .is_err());
    }

    #[test]
    fn continuation_invalidates_the_previous_review_and_captures_a_new_diff() {
        let f = fixture();
        let response = f
            .runtime
            .block_on(
                f.host
                    .assistant_message_with(input(&f, "req-continue"), handoff),
            )
            .unwrap();
        let initial: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        let ready = wait_for(&f, &initial.id);
        assert_eq!(ready.status, TaskStatus::ReadyForReview);
        let child = ready.execution_thread_id.as_deref().unwrap();
        assert_eq!(
            f.runtime
                .block_on(f.host.assistant_continue_thread(
                    child,
                    Some("Please make one more pass".into()),
                    vec![ParticipantId::new("null")],
                    None
                ))
                .unwrap(),
            true
        );
        let running = f.host.assistant_tasks.get(&ready.id).unwrap().unwrap();
        assert_eq!(running.status, TaskStatus::Running);
        assert_eq!(running.attempts.len(), 2);
        assert_eq!(running.attempts[0].review_revision, None);
        assert!(f
            .runtime
            .block_on(f.host.assistant_task_action(AssistantActionInput {
                task_id: ready.id.clone(),
                revision: ready.revision,
                owner: f.owner.clone(),
                action: "accept".into(),
                mode: None,
                text: None,
                destination: None,
                new_worker_profiles: vec![],
                checks: None
            , spend_limit_micros: None, }))
            .is_err());
        let reviewed = wait_for(&f, &ready.id);
        assert_eq!(reviewed.status, TaskStatus::ReadyForReview);
        assert!(reviewed.result_data.as_ref().unwrap()["diff"].is_string());
    }

    #[test]
    fn explicit_new_thread_handoff_uses_only_selected_profiles() {
        let f = fixture();
        let mut request = input(&f, "new-thread");
        request.text = "Please create a new chat and ask @null to fix this".into();
        request.destination = Some(TaskDestination {
            thread_id: None,
            workers: vec!["null".into()],
            new_thread: true,
        });
        request.new_worker_profiles = vec![profile(
            "null",
            Backend::Scripted {
                lines: vec!["Done.".into()],
            },
            Access::Edits,
        )];
        let response = f
            .runtime
            .block_on(f.host.assistant_message_with(request, handoff))
            .unwrap();
        let initial: AssistantTask = serde_json::from_value(response["task"].clone()).unwrap();
        let task = wait_for(&f, &initial.id);
        assert_eq!(task.status, TaskStatus::ReadyForReview);
        assert!(task.parent_thread_id.is_none());
        let execution = f
            .host
            .assistant_tasks
            .execution(task.execution_thread_id.as_deref().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(execution.task_id, task.id);
    }
}
