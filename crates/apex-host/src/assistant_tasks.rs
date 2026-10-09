//! Durable assistant task records and the execution-thread ownership registry.
//!
//! This document is independent of `session.json`: task transitions are
//! small, serialized updates and cannot be overwritten by a stale UI session.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOwner {
    pub workspace_id: String,
    pub cwd: String,
    pub host_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDestination {
    pub thread_id: Option<String>,
    #[serde(default)]
    pub workers: Vec<String>,
    #[serde(default)]
    pub new_thread: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanRequest {
    pub request_id: String,
    pub owner: TaskOwner,
    pub text: String,
    pub destination: Option<TaskDestination>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Proposed,
    NeedsClarification,
    Queued,
    Running,
    NeedsYou,
    ReadyForReview,
    Applying,
    Done,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskMode {
    ReadOnly,
    InPlace,
    Isolated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_micros: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttempt {
    pub number: u64,
    pub run_id: String,
    pub status: TaskStatus,
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub review_revision: Option<u64>,
    pub usage: Option<TaskUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTask {
    pub id: String,
    pub workspace_id: String,
    pub owner: TaskOwner,
    pub destination: Option<TaskDestination>,
    pub origin: TaskOrigin,
    pub original_request: String,
    pub brief: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub review_criteria: Vec<String>,
    pub parent_thread_id: Option<String>,
    pub execution_thread_id: Option<String>,
    #[serde(default)]
    pub workers: Vec<String>,
    #[serde(default)]
    pub attempts: Vec<TaskAttempt>,
    pub status: TaskStatus,
    pub result: Option<String>,
    pub result_data: Option<serde_json::Value>,
    pub revision: u64,
    pub mode: TaskMode,
    /// Absence means usage was not reported, rather than zero usage.
    pub usage: Option<TaskUsage>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskOrigin {
    HumanRequest,
    Proposal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEntry {
    pub task_id: String,
    pub workspace_id: String,
    pub thread_id: String,
    pub mode: TaskMode,
    pub tombstoned_at_ms: Option<u64>,
}

impl ExecutionEntry {
    pub fn is_tombstoned(&self) -> bool {
        self.tombstoned_at_ms.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskErrorKind {
    NotFound,
    NotOwner,
    StaleRevision,
    InvalidTransition,
    RequestIdConflict,
    Tombstoned,
    InvalidRequest,
    Storage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskError {
    pub kind: TaskErrorKind,
    pub message: String,
}

impl TaskError {
    fn new(kind: TaskErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for TaskError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HumanRequestRecord {
    request_id: String,
    owner: TaskOwner,
    text: String,
    requested_destination: Option<TaskDestination>,
    task_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutcome {
    pub status: TaskStatus,
    pub result: Option<String>,
    pub result_data: Option<serde_json::Value>,
    pub usage: Option<TaskUsage>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    version: u32,
    revision: u64,
    next_task_id: u64,
    next_run_id: u64,
    #[serde(default)]
    tasks: BTreeMap<String, AssistantTask>,
    #[serde(default)]
    requests: BTreeMap<String, HumanRequestRecord>,
    #[serde(default)]
    executions: BTreeMap<String, ExecutionEntry>,
}

struct Inner {
    path: PathBuf,
    document: Mutex<Document>,
}

/// One host-local task ledger. Construct one instance per host data directory.
#[derive(Clone)]
pub struct AssistantTasks {
    inner: std::sync::Arc<Inner>,
}

impl AssistantTasks {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, TaskError> {
        let path = path.as_ref().to_path_buf();
        let document = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Document>(&bytes).map_err(|e| {
                TaskError::new(
                    TaskErrorKind::Storage,
                    format!("Could not read assistant tasks: {e}"),
                )
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Document {
                version: 1,
                ..Document::default()
            },
            Err(e) => {
                return Err(TaskError::new(
                    TaskErrorKind::Storage,
                    format!("Could not read assistant tasks: {e}"),
                ));
            }
        };
        if document.version != 1 {
            return Err(TaskError::new(
                TaskErrorKind::Storage,
                "Unsupported assistant task document version.",
            ));
        }
        let store = Self {
            inner: std::sync::Arc::new(Inner {
                path,
                document: Mutex::new(document),
            }),
        };
        store.recover_interrupted()?;
        Ok(store)
    }

    pub fn list(&self, workspace_id: Option<&str>) -> Result<Vec<AssistantTask>, TaskError> {
        let document = self.inner.document.lock().unwrap();
        Ok(document
            .tasks
            .values()
            .filter(|t| workspace_id.is_none_or(|id| id == t.workspace_id))
            .cloned()
            .collect())
    }

    pub fn get(&self, task_id: &str) -> Result<Option<AssistantTask>, TaskError> {
        Ok(self
            .inner
            .document
            .lock()
            .unwrap()
            .tasks
            .get(task_id)
            .cloned())
    }

    pub fn snapshot_revision(&self) -> u64 {
        self.inner.document.lock().unwrap().revision
    }

    /// Persist a human request. A missing validated destination is clarification-only.
    /// Repeating a request ID with the same owner, text and originally requested destination is idempotent.
    pub fn submit_human_request(
        &self,
        request: HumanRequest,
        brief: String,
        validated_destination: Option<TaskDestination>,
    ) -> Result<AssistantTask, TaskError> {
        if request.request_id.trim().is_empty() || request.text.trim().is_empty() {
            return Err(TaskError::new(
                TaskErrorKind::InvalidRequest,
                "A request ID and request text are required.",
            ));
        }
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        if let Some(saved) = document.requests.get(&request.request_id) {
            let same = saved.owner == request.owner
                && saved.text == request.text
                && saved.requested_destination == request.destination;
            if !same {
                return Err(TaskError::new(
                    TaskErrorKind::RequestIdConflict,
                    "That request ID was already used with a different request scope.",
                ));
            }
            return document.tasks.get(&saved.task_id).cloned().ok_or_else(|| {
                TaskError::new(
                    TaskErrorKind::Storage,
                    "The task for this request is missing.",
                )
            });
        }
        let task = make_task(
            &mut document,
            request.owner.clone(),
            validated_destination.clone(),
            TaskOrigin::HumanRequest,
            request.text.clone(),
            brief,
            if validated_destination.is_some() {
                TaskStatus::Queued
            } else {
                TaskStatus::NeedsClarification
            },
        );
        document.requests.insert(
            request.request_id.clone(),
            HumanRequestRecord {
                request_id: request.request_id,
                owner: request.owner,
                text: request.text,
                requested_destination: request.destination,
                task_id: task.id.clone(),
            },
        );
        save_mutation(&self.inner, &mut document, before)?;
        Ok(task)
    }

    /// Proactive proposals never dispatch until separately authorized.
    pub fn create_proposal(
        &self,
        owner: TaskOwner,
        original_request: String,
        brief: String,
    ) -> Result<AssistantTask, TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let task = make_task(
            &mut document,
            owner,
            None,
            TaskOrigin::Proposal,
            original_request,
            brief,
            TaskStatus::Proposed,
        );
        save_mutation(&self.inner, &mut document, before)?;
        Ok(task)
    }

    /// Compare-and-set a task state; actions require both the owning scope and current revision.
    pub fn transition(
        &self,
        task_id: &str,
        expected_revision: u64,
        owner: &TaskOwner,
        status: TaskStatus,
        result: Option<String>,
    ) -> Result<AssistantTask, TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let current = document
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| TaskError::new(TaskErrorKind::NotFound, "Task not found."))?;
        check_owner_revision(&current, expected_revision, owner)?;
        if !allowed(current.status, status) {
            return Err(TaskError::new(
                TaskErrorKind::InvalidTransition,
                format!(
                    "Cannot move a task from {:?} to {:?}.",
                    current.status, status
                ),
            ));
        }
        let task = document.tasks.get_mut(task_id).unwrap();
        task.status = status;
        task.result = result;
        task.updated_at_ms = now_ms();
        task.revision += 1;
        if let Some(attempt) = task.attempts.last_mut() {
            attempt.review_revision =
                (status == TaskStatus::ReadyForReview).then_some(task.revision);
            if matches!(
                status,
                TaskStatus::NeedsYou
                    | TaskStatus::ReadyForReview
                    | TaskStatus::Applying
                    | TaskStatus::Done
                    | TaskStatus::Failed
                    | TaskStatus::Cancelled
                    | TaskStatus::Interrupted
            ) {
                attempt.status = status;
            }
            if matches!(
                status,
                TaskStatus::Done
                    | TaskStatus::Failed
                    | TaskStatus::Cancelled
                    | TaskStatus::Interrupted
            ) {
                attempt.finished_at_ms = Some(now_ms());
            }
        }
        let result = task.clone();
        save_mutation(&self.inner, &mut document, before)?;
        Ok(result)
    }

    /// Begin one durable attempt. The generated run ID is unique and monotonic within this ledger.
    pub fn begin_attempt(
        &self,
        task_id: &str,
        expected_revision: u64,
        owner: &TaskOwner,
    ) -> Result<(AssistantTask, String), TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let current = document
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| TaskError::new(TaskErrorKind::NotFound, "Task not found."))?;
        check_owner_revision(&current, expected_revision, owner)?;
        let budget_resume = current.status == TaskStatus::NeedsYou
            && current.result_data.as_ref().is_some_and(|data| data["budgetPaused"] == true)
            && current.attempts.last().is_some_and(|attempt| attempt.finished_at_ms.is_some());
        if current.result_data.as_ref().and_then(|data| data["spendLimitMicros"].as_u64())
            .is_some_and(|limit| current.usage.as_ref().and_then(|usage| usage.cost_micros).is_some_and(|cost| cost >= limit))
        { return Err(TaskError::new(TaskErrorKind::InvalidTransition, "Raise or remove the spend limit before starting another attempt.")); }
        if !budget_resume && !matches!(
            current.status,
            TaskStatus::Queued
                | TaskStatus::Failed
                | TaskStatus::Interrupted
                | TaskStatus::ReadyForReview
        ) {
            return Err(TaskError::new(
                TaskErrorKind::InvalidTransition,
                "This task is not ready to start or continue.",
            ));
        }
        document.next_run_id += 1;
        let run_id = format!("run-{:020}", document.next_run_id);
        let task = document.tasks.get_mut(task_id).unwrap();
        task.status = TaskStatus::Running;
        task.result = None;
        if let Some(data) = task.result_data.as_mut() { data["budgetPaused"] = serde_json::json!(false); }
        task.updated_at_ms = now_ms();
        task.revision += 1;
        if let Some(previous) = task.attempts.last_mut() {
            previous.review_revision = None;
        }
        let number = task.attempts.len() as u64 + 1;
        task.attempts.push(TaskAttempt {
            number,
            run_id: run_id.clone(),
            status: TaskStatus::Running,
            started_at_ms: now_ms(),
            finished_at_ms: None,
            review_revision: None,
            usage: None,
        });
        let result = task.clone();
        save_mutation(&self.inner, &mut document, before)?;
        Ok((result, run_id))
    }

    pub fn set_task_details(
        &self,
        task_id: &str,
        expected_revision: u64,
        owner: &TaskOwner,
        brief: String,
        evidence: Vec<String>,
        review_criteria: Vec<String>,
        workers: Vec<String>,
    ) -> Result<AssistantTask, TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let current = document
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| TaskError::new(TaskErrorKind::NotFound, "Task not found."))?;
        check_owner_revision(&current, expected_revision, owner)?;
        let task = document.tasks.get_mut(task_id).unwrap();
        task.brief = brief;
        task.evidence = evidence;
        task.review_criteria = review_criteria;
        task.workers = workers;
        task.updated_at_ms = now_ms();
        task.revision += 1;
        let result = task.clone();
        save_mutation(&self.inner, &mut document, before)?;
        Ok(result)
    }

    /// Resolve a clarification in one durable compare-and-set: destination and task become queued together.
    pub fn set_destination(
        &self,
        task_id: &str,
        expected_revision: u64,
        owner: &TaskOwner,
        destination: TaskDestination,
        brief: String,
    ) -> Result<AssistantTask, TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let current = document
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| TaskError::new(TaskErrorKind::NotFound, "Task not found."))?;
        check_owner_revision(&current, expected_revision, owner)?;
        if !matches!(
            current.status,
            TaskStatus::NeedsClarification | TaskStatus::Proposed
        ) {
            return Err(TaskError::new(
                TaskErrorKind::InvalidTransition,
                "This task cannot receive a destination in its current state.",
            ));
        }
        let task = document.tasks.get_mut(task_id).unwrap();
        task.destination = Some(destination.clone());
        if destination.thread_id.is_some() {
            task.parent_thread_id = destination.thread_id.clone();
        }
        task.workers = destination.workers.clone();
        task.brief = brief;
        task.status = TaskStatus::Queued;
        task.updated_at_ms = now_ms();
        task.revision += 1;
        let result = task.clone();
        save_mutation(&self.inner, &mut document, before)?;
        Ok(result)
    }

    pub fn set_usage(&self, task_id: &str, usage: TaskUsage) -> Result<AssistantTask, TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let task = document
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| TaskError::new(TaskErrorKind::NotFound, "Task not found."))?;
        task.usage = Some(usage);
        task.updated_at_ms = now_ms();
        let result = task.clone();
        save_mutation(&self.inner, &mut document, before)?;
        Ok(result)
    }

    /// Record metrics on both the task and its owning attempt without staling a user action.
    pub fn record_run_usage(
        &self,
        task_id: &str,
        run_id: &str,
        usage: TaskUsage,
    ) -> Result<AssistantTask, TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let task = document
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| TaskError::new(TaskErrorKind::NotFound, "Task not found."))?;
        let attempt = task
            .attempts
            .last_mut()
            .filter(|attempt| attempt.run_id == run_id)
            .ok_or_else(|| {
                TaskError::new(
                    TaskErrorKind::StaleRevision,
                    "This run no longer owns the task.",
                )
            })?;
        attempt.usage = Some(usage.clone());
        task.usage = Some(usage);
        task.updated_at_ms = now_ms();
        let result = task.clone();
        save_mutation(&self.inner, &mut document, before)?;
        Ok(result)
    }

    /// Add one provider event atomically. Missing metrics remain unknown.
    pub fn add_run_usage(&self, task_id: &str, run_id: &str, delta: TaskUsage) -> Result<AssistantTask, TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let task = document.tasks.get_mut(task_id).ok_or_else(|| TaskError::new(TaskErrorKind::NotFound, "Task not found."))?;
        let attempt = task.attempts.last_mut().filter(|a| a.run_id == run_id && a.finished_at_ms.is_none()).ok_or_else(|| TaskError::new(TaskErrorKind::StaleRevision, "This run no longer owns the task."))?;
        fn add(a: Option<u64>, b: Option<u64>) -> Option<u64> { match (a,b) { (None,None) => None, (a,b) => Some(a.unwrap_or(0).saturating_add(b.unwrap_or(0))) } }
        let usage = attempt.usage.get_or_insert(TaskUsage { input_tokens: None, output_tokens: None, cost_micros: None });
        usage.input_tokens = add(usage.input_tokens, delta.input_tokens);
        usage.output_tokens = add(usage.output_tokens, delta.output_tokens);
        usage.cost_micros = add(usage.cost_micros, delta.cost_micros);
        let total = task.usage.get_or_insert(TaskUsage { input_tokens: None, output_tokens: None, cost_micros: None });
        total.input_tokens = add(total.input_tokens, delta.input_tokens);
        total.output_tokens = add(total.output_tokens, delta.output_tokens);
        total.cost_micros = add(total.cost_micros, delta.cost_micros);
        if task.result_data.as_ref().and_then(|data| data["spendLimitMicros"].as_u64())
            .is_some_and(|limit| total.cost_micros.is_some_and(|cost| cost >= limit))
        {
            task.result_data.get_or_insert_with(|| serde_json::json!({}))["budgetPaused"] = serde_json::json!(true);
        }
        task.updated_at_ms = now_ms();
        let result = task.clone();
        save_mutation(&self.inner, &mut document, before)?;
        Ok(result)
    }

    pub fn set_result_data(
        &self,
        task_id: &str,
        expected_revision: u64,
        owner: &TaskOwner,
        result_data: Option<serde_json::Value>,
    ) -> Result<AssistantTask, TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let current = document
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| TaskError::new(TaskErrorKind::NotFound, "Task not found."))?;
        check_owner_revision(&current, expected_revision, owner)?;
        let requested_mode = result_data.as_ref().and_then(|data| data.get("mode")).map(|value| serde_json::from_value::<TaskMode>(value.clone())
            .map_err(|_| TaskError::new(TaskErrorKind::InvalidRequest, "Task execution mode is invalid."))).transpose()?;
        if requested_mode.is_some_and(|mode| mode != current.mode) && current.execution_thread_id.is_some() {
            return Err(TaskError::new(TaskErrorKind::InvalidTransition, "An existing execution thread cannot change its isolation mode."));
        }
        let task = document.tasks.get_mut(task_id).unwrap();
        if let Some(mode) = requested_mode { task.mode = mode; }
        task.result_data = result_data;
        task.updated_at_ms = now_ms();
        task.revision += 1;
        let result = task.clone();
        save_mutation(&self.inner, &mut document, before)?;
        Ok(result)
    }

    /// Track an approval wait on the same run without making an in-flight user action stale.
    pub fn set_run_waiting(
        &self,
        task_id: &str,
        run_id: &str,
        waiting: bool,
    ) -> Result<AssistantTask, TaskError> {
        self.set_run_wait_state(task_id, run_id, waiting, None)
    }

    pub fn set_run_waits(&self, task_id: &str, run_id: &str, approvals: Vec<serde_json::Value>, questions: Vec<serde_json::Value>) -> Result<AssistantTask, TaskError> {
        self.set_run_wait_state(task_id, run_id, !approvals.is_empty() || !questions.is_empty(), Some((approvals, questions)))
    }

    fn set_run_wait_state(&self, task_id: &str, run_id: &str, waiting: bool, waits: Option<(Vec<serde_json::Value>, Vec<serde_json::Value>)>) -> Result<AssistantTask, TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let current = document
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| TaskError::new(TaskErrorKind::NotFound, "Task not found."))?;
        if current
            .attempts
            .last()
            .is_none_or(|attempt| attempt.run_id != run_id || attempt.finished_at_ms.is_some())
        {
            return Err(TaskError::new(
                TaskErrorKind::StaleRevision,
                "This run no longer owns the task.",
            ));
        }
        let next = if waiting {
            TaskStatus::NeedsYou
        } else {
            TaskStatus::Running
        };
        if !matches!(current.status, TaskStatus::Running | TaskStatus::NeedsYou) {
            return Err(TaskError::new(
                TaskErrorKind::InvalidTransition,
                "The run is not in the expected approval state.",
            ));
        }
        let task = document.tasks.get_mut(task_id).unwrap();
        if let Some((approvals, questions)) = waits {
            let data = task.result_data.get_or_insert_with(|| serde_json::json!({}));
            data["pendingApprovals"] = serde_json::json!(approvals);
            data["pendingQuestions"] = serde_json::json!(questions);
        }
        task.status = next;
        task.updated_at_ms = now_ms();
        if let Some(attempt) = task.attempts.last_mut() {
            attempt.status = next;
        }
        let result = task.clone();
        save_mutation(&self.inner, &mut document, before)?;
        Ok(result)
    }

    /// Complete only the current run; a late completion from an older run cannot mutate a retry.
    pub fn finish_attempt(
        &self,
        task_id: &str,
        run_id: &str,
        mut outcome: TaskOutcome,
    ) -> Result<AssistantTask, TaskError> {
        if !matches!(
            outcome.status,
            TaskStatus::ReadyForReview | TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::NeedsYou
        ) {
            return Err(TaskError::new(
                TaskErrorKind::InvalidTransition,
                "That state is not a valid attempt outcome.",
            ));
        }
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let current = document
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| TaskError::new(TaskErrorKind::NotFound, "Task not found."))?;
        let attempt = current.attempts.last().ok_or_else(|| {
            TaskError::new(
                TaskErrorKind::StaleRevision,
                "This task has no active attempt.",
            )
        })?;
        if attempt.run_id != run_id || attempt.finished_at_ms.is_some()
            || !matches!(current.status, TaskStatus::Running | TaskStatus::NeedsYou)
        {
            return Err(TaskError::new(
                TaskErrorKind::StaleRevision,
                "This run no longer owns the task.",
            ));
        }
        // A live human wait already exposes NeedsYou. Settling a spend pause
        // in that same state must still close its owned run attempt.
        if !allowed(current.status, outcome.status)
            && !(current.status == TaskStatus::NeedsYou && outcome.status == TaskStatus::NeedsYou)
        {
            return Err(TaskError::new(
                TaskErrorKind::InvalidTransition,
                "This attempt cannot finish in that state.",
            ));
        }
        // A worker prepares its result outside this lock. Human notes and
        // limit changes may have arrived in the meantime; settle against the
        // current ledger rather than replacing those fields with its snapshot.
        let mut data = outcome.result_data.take().unwrap_or_else(|| serde_json::json!({}));
        if !data.is_object() { data = serde_json::json!({}); }
        if let Some(latest) = current.result_data.as_ref() {
            for key in ["spendLimitMicros", "queuedNotes"] {
                if let Some(value) = latest.get(key) { data[key] = value.clone(); }
            }
            for key in ["pendingApprovals", "pendingQuestions"] {
                data[key] = latest.get(key).cloned().unwrap_or_else(|| serde_json::json!([]));
            }
            let mut history = latest["taskHistory"].as_array().cloned().unwrap_or_default();
            for entry in data["taskHistory"].as_array().into_iter().flatten() {
                if !history.contains(entry) { history.push(entry.clone()); }
            }
            history.sort_by_key(|entry| entry["atMs"].as_u64().unwrap_or(0));
            if history.len() > 200 { history.drain(..history.len() - 200); }
            if !history.is_empty() { data["taskHistory"] = serde_json::json!(history); }
        }
        let over_limit = data["spendLimitMicros"].as_u64().is_some_and(|limit| {
            current.usage.as_ref().and_then(|usage| usage.cost_micros).is_some_and(|cost| cost >= limit)
        });
        if outcome.status != TaskStatus::Cancelled && over_limit {
            outcome.status = TaskStatus::NeedsYou;
            data["budgetPaused"] = serde_json::json!(true);
            outcome.result = Some("Paused at the reported spend limit. Raise or remove the limit, then resume this task.".into());
        }
        outcome.result_data = (!data.as_object().is_some_and(|object| object.is_empty())).then_some(data);
        let task = document.tasks.get_mut(task_id).unwrap();
        task.status = outcome.status;
        task.result = outcome.result;
        task.result_data = outcome.result_data;
        if outcome.usage.is_some() {
            task.usage = outcome.usage.clone();
        }
        task.updated_at_ms = now_ms();
        task.revision += 1;
        let revision = task.revision;
        if let Some(attempt) = task.attempts.last_mut() {
            attempt.status = outcome.status;
            if matches!(
                outcome.status,
                TaskStatus::ReadyForReview | TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::NeedsYou
            ) {
                attempt.finished_at_ms = Some(now_ms());
            }
            attempt.review_revision =
                (outcome.status == TaskStatus::ReadyForReview).then_some(revision);
            if outcome.usage.is_some() { attempt.usage = outcome.usage; }
        }
        let result = task.clone();
        save_mutation(&self.inner, &mut document, before)?;
        Ok(result)
    }

    pub fn bind_execution(
        &self,
        task_id: &str,
        expected_revision: u64,
        owner: &TaskOwner,
        thread_id: String,
        mode: TaskMode,
        result_data: Option<serde_json::Value>,
    ) -> Result<AssistantTask, TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let current = document
            .tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| TaskError::new(TaskErrorKind::NotFound, "Task not found."))?;
        check_owner_revision(&current, expected_revision, owner)?;
        if current.workspace_id != owner.workspace_id {
            return Err(TaskError::new(
                TaskErrorKind::NotOwner,
                "Execution thread belongs to a different workspace.",
            ));
        }
        if let Some(existing) = document.executions.get(&thread_id) {
            if existing.is_tombstoned() {
                return Err(TaskError::new(
                    TaskErrorKind::Tombstoned,
                    "This execution thread was deleted and cannot be reused.",
                ));
            }
            if existing.task_id == task_id
                && existing.workspace_id == owner.workspace_id
                && existing.mode == mode
                && current.execution_thread_id.as_deref() == Some(thread_id.as_str())
            {
                return Ok(current);
            }
            return Err(TaskError::new(
                TaskErrorKind::RequestIdConflict,
                "This thread is already owned by another task.",
            ));
        }
        document.executions.insert(
            thread_id.clone(),
            ExecutionEntry {
                task_id: task_id.into(),
                workspace_id: owner.workspace_id.clone(),
                thread_id: thread_id.clone(),
                mode,
                tombstoned_at_ms: None,
            },
        );
        let task = document.tasks.get_mut(task_id).unwrap();
        task.execution_thread_id = Some(thread_id);
        task.mode = mode;
        task.result_data = result_data;
        task.revision += 1;
        task.updated_at_ms = now_ms();
        let result = task.clone();
        save_mutation(&self.inner, &mut document, before)?;
        Ok(result)
    }

    pub fn tombstone_execution(&self, thread_id: &str) -> Result<(), TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let entry = document.executions.get_mut(thread_id).ok_or_else(|| {
            TaskError::new(TaskErrorKind::NotFound, "Execution thread not found.")
        })?;
        if entry.tombstoned_at_ms.is_none() {
            entry.tombstoned_at_ms = Some(now_ms());
        }
        save_mutation(&self.inner, &mut document, before)
    }

    pub fn execution(&self, thread_id: &str) -> Result<Option<ExecutionEntry>, TaskError> {
        Ok(self
            .inner
            .document
            .lock()
            .unwrap()
            .executions
            .get(thread_id)
            .cloned())
    }

    pub fn list_executions(&self, workspace_id: Option<&str>) -> Vec<ExecutionEntry> {
        self.inner
            .document
            .lock()
            .unwrap()
            .executions
            .values()
            .filter(|entry| workspace_id.is_none_or(|id| entry.workspace_id == id))
            .cloned()
            .collect()
    }

    pub fn tombstone_task_executions(&self, task_id: &str) -> Result<(), TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        if !document.tasks.contains_key(task_id) {
            return Err(TaskError::new(TaskErrorKind::NotFound, "Task not found."));
        }
        let now = now_ms();
        for entry in document
            .executions
            .values_mut()
            .filter(|entry| entry.task_id == task_id)
        {
            if entry.tombstoned_at_ms.is_none() {
                entry.tombstoned_at_ms = Some(now);
            }
        }
        save_mutation(&self.inner, &mut document, before)
    }

    pub fn recover_interrupted(&self) -> Result<(), TaskError> {
        let mut document = self.inner.document.lock().unwrap();
        let before = document.clone();
        let mut changed = false;
        for task in document.tasks.values_mut() {
            if matches!(task.status, TaskStatus::Queued | TaskStatus::Running | TaskStatus::Applying)
                || (task.status == TaskStatus::NeedsYou && task.attempts.last().is_some_and(|attempt|attempt.finished_at_ms.is_none()))
            {
                task.status = TaskStatus::Interrupted;
                task.revision += 1;
                task.updated_at_ms = now_ms();
                if let Some(attempt) = task.attempts.last_mut() {
                    attempt.status = TaskStatus::Interrupted;
                    attempt.finished_at_ms = Some(now_ms());
                    attempt.review_revision = None;
                }
                changed = true;
            }
        }
        if changed {
            save_mutation(&self.inner, &mut document, before)?;
        }
        Ok(())
    }
}

fn make_task(
    document: &mut Document,
    owner: TaskOwner,
    destination: Option<TaskDestination>,
    origin: TaskOrigin,
    original_request: String,
    brief: String,
    status: TaskStatus,
) -> AssistantTask {
    document.next_task_id += 1;
    let id = format!("task-{:020}", document.next_task_id);
    let now = now_ms();
    let workers = destination
        .as_ref()
        .map(|d| d.workers.clone())
        .unwrap_or_default();
    let execution_thread_id = None;
    let parent_thread_id = destination.as_ref().and_then(|d| d.thread_id.clone());
    let task = AssistantTask {
        id: id.clone(),
        workspace_id: owner.workspace_id.clone(),
        parent_thread_id,
        owner,
        destination,
        origin,
        original_request,
        brief,
        evidence: vec![],
        review_criteria: vec![],
        execution_thread_id,
        workers,
        attempts: vec![],
        status,
        result: None,
        result_data: None,
        revision: 1,
        mode: TaskMode::InPlace,
        usage: None,
        created_at_ms: now,
        updated_at_ms: now,
    };
    document.tasks.insert(id, task.clone());
    task
}

fn check_owner_revision(
    task: &AssistantTask,
    expected_revision: u64,
    owner: &TaskOwner,
) -> Result<(), TaskError> {
    if &task.owner != owner {
        return Err(TaskError::new(
            TaskErrorKind::NotOwner,
            "Only the owning workspace and conversation may change this task.",
        ));
    }
    if task.revision != expected_revision {
        return Err(TaskError::new(
            TaskErrorKind::StaleRevision,
            "This task changed; reload it before acting.",
        ));
    }
    Ok(())
}

fn allowed(from: TaskStatus, to: TaskStatus) -> bool {
    use TaskStatus::*;
    match from {
        Proposed => matches!(to, NeedsClarification | Cancelled),
        NeedsClarification => matches!(to, Cancelled),
        Queued => matches!(to, NeedsYou | Cancelled | Failed | Interrupted),
        Running => matches!(
            to,
            NeedsYou | ReadyForReview | Failed | Cancelled | Interrupted
        ),
        NeedsYou => matches!(to, Queued | Running | ReadyForReview | NeedsClarification | Failed | Cancelled | Interrupted),
        ReadyForReview => matches!(to, Applying | NeedsClarification | Cancelled),
        Applying => matches!(to, Done | ReadyForReview | Failed | Cancelled | Interrupted),
        Failed => matches!(to, Queued | Cancelled),
        Interrupted => matches!(to, Queued | Cancelled | ReadyForReview | Done),
        Done | Cancelled => false,
    }
}

fn save_mutation(
    inner: &Inner,
    document: &mut Document,
    before: Document,
) -> Result<(), TaskError> {
    document.revision += 1;
    if let Err(error) = write_document(&inner.path, document) {
        *document = before;
        return Err(error);
    }
    Ok(())
}

fn write_document(path: &Path, document: &Document) -> Result<(), TaskError> {
    use std::io::Write;
    let bytes = serde_json::to_vec_pretty(document).map_err(|e| {
        TaskError::new(
            TaskErrorKind::Storage,
            format!("Could not encode assistant tasks: {e}"),
        )
    })?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| {
        TaskError::new(
            TaskErrorKind::Storage,
            format!("Could not create assistant task storage: {e}"),
        )
    })?;
    let temp = path.with_extension(format!("tasks-{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)?;
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    result.map_err(|e| {
        TaskError::new(
            TaskErrorKind::Storage,
            format!("Could not save assistant tasks: {e}"),
        )
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn folder() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "apex-assistant-tasks-{}-{}-{}",
            std::process::id(),
            now_ms(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    fn ledger(path: &Path) -> PathBuf {
        path.join("tasks.json")
    }
    fn owner() -> TaskOwner {
        TaskOwner {
            workspace_id: "ws".into(),
            cwd: "/repo".into(),
            host_id: "local".into(),
            conversation_id: "parent".into(),
        }
    }
    fn destination() -> TaskDestination {
        TaskDestination {
            thread_id: Some("child".into()),
            workers: vec!["null".into()],
            new_thread: false,
        }
    }
    fn request(id: &str, text: &str) -> HumanRequest {
        HumanRequest {
            request_id: id.into(),
            owner: owner(),
            text: text.into(),
            destination: Some(destination()),
        }
    }

    #[test]
    fn requested_isolation_is_visible_before_startup_and_survives_needs_you() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let task = store.submit_human_request(request("isolated-startup", "Fix it"), "brief".into(), Some(destination())).unwrap();
        let task = store.set_result_data(&task.id, task.revision, &owner(), Some(serde_json::json!({"mode":"isolated"}))).unwrap();
        assert_eq!(task.mode, TaskMode::Isolated);
        let task = store.transition(&task.id, task.revision, &owner(), TaskStatus::NeedsYou, Some("Workspace startup needs attention".into())).unwrap();
        let reopened = AssistantTasks::open(ledger(&path)).unwrap();
        let restored = reopened.get(&task.id).unwrap().unwrap();
        assert_eq!(restored.status, TaskStatus::NeedsYou);
        assert_eq!(restored.mode, TaskMode::Isolated);
        assert!(restored.attempts.is_empty());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn provider_usage_deltas_accumulate_without_inventing_missing_metrics() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let task = store.submit_human_request(request("usage", "Fix it"), "brief".into(), Some(destination())).unwrap();
        let (task, run) = store.begin_attempt(&task.id, task.revision, &owner()).unwrap();
        store.add_run_usage(&task.id, &run, TaskUsage { input_tokens: None, output_tokens: None, cost_micros: Some(7) }).unwrap();
        let updated = store.add_run_usage(&task.id, &run, TaskUsage { input_tokens: Some(5), output_tokens: None, cost_micros: Some(3) }).unwrap();
        assert_eq!(updated.revision, task.revision, "usage events don't invalidate human actions");
        assert_eq!(updated.usage, Some(TaskUsage { input_tokens: Some(5), output_tokens: None, cost_micros: Some(10) }));
        let done = store.finish_attempt(&task.id, &run, TaskOutcome { status: TaskStatus::ReadyForReview, result: None, result_data: None, usage: None }).unwrap();
        assert_eq!(done.usage, updated.usage);
        assert_eq!(done.attempts[0].usage, updated.usage);
        assert!(store.add_run_usage(&task.id, &run, TaskUsage { input_tokens: None, output_tokens: Some(99), cost_micros: None }).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn spend_pause_persists_and_rejects_late_events_and_resume_below_limit() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let task = store.submit_human_request(request("cap", "Review it"), "brief".into(), Some(destination())).unwrap();
        let task = store.set_result_data(&task.id, task.revision, &owner(), Some(serde_json::json!({"mode":"read_only","spendLimitMicros":10}))).unwrap();
        let (task, run) = store.begin_attempt(&task.id, task.revision, &owner()).unwrap();
        let unknown = store.add_run_usage(&task.id, &run, TaskUsage { input_tokens: Some(20), output_tokens: None, cost_micros: None }).unwrap();
        assert_ne!(unknown.result_data.as_ref().unwrap()["budgetPaused"], true, "unknown provider cost cannot invent a spend pause");
        let met = store.add_run_usage(&task.id, &run, TaskUsage { input_tokens: None, output_tokens: None, cost_micros: Some(10) }).unwrap();
        assert_eq!(met.result_data.as_ref().unwrap()["budgetPaused"], true);
        store.set_run_waiting(&task.id, &run, true).unwrap();
        let paused = store.finish_attempt(&task.id, &run, TaskOutcome { status: TaskStatus::NeedsYou, result: Some("Spend limit reached".into()), result_data: met.result_data, usage: None }).unwrap();
        assert!(paused.attempts[0].finished_at_ms.is_some());
        assert!(store.begin_attempt(&paused.id, paused.revision, &owner()).is_err());
        assert!(store.finish_attempt(&task.id, &run, TaskOutcome { status: TaskStatus::ReadyForReview, result: None, result_data: None, usage: None }).is_err());
        let reopened = AssistantTasks::open(ledger(&path)).unwrap();
        let restored = reopened.get(&task.id).unwrap().unwrap();
        assert_eq!(restored.status, TaskStatus::NeedsYou, "a settled spend pause survives restart without starting work");
        let mut data = restored.result_data.clone().unwrap(); data["spendLimitMicros"] = serde_json::json!(20);
        let raised = reopened.set_result_data(&restored.id, restored.revision, &owner(), Some(data)).unwrap();
        let (resumed, next_run) = reopened.begin_attempt(&raised.id, raised.revision, &owner()).unwrap();
        assert_eq!(resumed.attempts.len(), 2); assert_ne!(next_run, run);
        assert_eq!(resumed.result_data.unwrap()["budgetPaused"], false);
        assert!(reopened.add_run_usage(&task.id, &run, TaskUsage { input_tokens: None, output_tokens: None, cost_micros: Some(99) }).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn settlement_preserves_notes_and_limits_written_after_the_worker_snapshot() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let task = store.submit_human_request(request("race", "Review it"), "brief".into(), Some(destination())).unwrap();
        let task = store.set_result_data(&task.id, task.revision, &owner(), Some(serde_json::json!({
            "spendLimitMicros": 100, "queuedNotes": [], "budgetPaused": false,
            "taskHistory": [{"atMs": 1, "kind": "request", "text": "Review it"}]
        }))).unwrap();
        let (running, run) = store.begin_attempt(&task.id, task.revision, &owner()).unwrap();
        let mut stale_result = running.result_data.clone().unwrap();
        stale_result["taskHistory"].as_array_mut().unwrap().push(serde_json::json!({"atMs": 3, "kind": "result", "text": "Findings"}));
        let used = store.add_run_usage(&task.id, &run, TaskUsage { cost_micros: Some(10), input_tokens: None, output_tokens: None }).unwrap();
        let mut latest = used.result_data.clone().unwrap();
        latest["spendLimitMicros"] = serde_json::json!(5);
        latest["queuedNotes"] = serde_json::json!(["Keep archived chats untouched"]);
        latest["taskHistory"].as_array_mut().unwrap().push(serde_json::json!({"atMs": 2, "kind": "note", "text": "Keep archived chats untouched"}));
        store.set_result_data(&task.id, used.revision, &owner(), Some(latest)).unwrap();
        let settled = store.finish_attempt(&task.id, &run, TaskOutcome {
            status: TaskStatus::ReadyForReview, result: Some("Findings".into()), result_data: Some(stale_result), usage: None,
        }).unwrap();
        let data = settled.result_data.unwrap();
        assert_eq!(data["spendLimitMicros"], 5);
        assert_eq!(data["queuedNotes"], serde_json::json!(["Keep archived chats untouched"]));
        assert_eq!(data["taskHistory"].as_array().unwrap().len(), 3);
        assert_eq!(data["taskHistory"][1]["kind"], "note");
        assert_eq!(settled.status, TaskStatus::NeedsYou);
        assert_eq!(data["budgetPaused"], true);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn settlement_keeps_terminal_wait_clears_over_a_stale_worker_snapshot() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let task = store.submit_human_request(request("wait-settlement", "Review it"), "brief".into(), Some(destination())).unwrap();
        let task = store.set_result_data(&task.id, task.revision, &owner(), Some(serde_json::json!({
            "pendingApprovals": [], "pendingQuestions": [], "budgetPaused": false
        }))).unwrap();
        let (running, run) = store.begin_attempt(&task.id, task.revision, &owner()).unwrap();
        let mut stale_result = running.result_data.clone().unwrap();
        stale_result["pendingQuestions"] = serde_json::json!([{"request":"question-1","id":"null","questions":[{"question":"Which?"}]}]);
        store.set_run_waits(&task.id, &run, vec![], vec![serde_json::json!({"request":"question-1","id":"null","questions":[{"question":"Which?"}]})]).unwrap();
        store.set_run_waits(&task.id, &run, vec![], vec![]).unwrap();
        let settled = store.finish_attempt(&task.id, &run, TaskOutcome {
            status: TaskStatus::ReadyForReview, result: Some("Findings".into()), result_data: Some(stale_result), usage: None,
        }).unwrap();
        let data = settled.result_data.unwrap();
        assert_eq!(data["pendingApprovals"], serde_json::json!([]));
        assert_eq!(data["pendingQuestions"], serde_json::json!([]));
        assert_eq!(settled.status, TaskStatus::ReadyForReview);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn human_request_is_durable_and_deduplicated_with_full_binding() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let first = store
            .submit_human_request(
                request("client-1", "Fix the bug"),
                "brief".into(),
                Some(destination()),
            )
            .unwrap();
        let duplicate = store
            .submit_human_request(
                request("client-1", "Fix the bug"),
                "different brief".into(),
                Some(destination()),
            )
            .unwrap();
        assert_eq!(first.id, duplicate.id);
        assert_eq!(
            store
                .submit_human_request(request("client-1", "Fix the bug"), "ignored".into(), None)
                .unwrap()
                .id,
            first.id
        );
        let mut conflict = request("client-1", "Different text");
        assert_eq!(
            store
                .submit_human_request(conflict.clone(), "brief".into(), Some(destination()))
                .unwrap_err()
                .kind,
            TaskErrorKind::RequestIdConflict
        );
        conflict.text = "Fix the bug".into();
        conflict.owner.host_id = "remote".into();
        assert_eq!(
            store
                .submit_human_request(conflict, "brief".into(), Some(destination()))
                .unwrap_err()
                .kind,
            TaskErrorKind::RequestIdConflict
        );

        drop(store);
        let reopened = AssistantTasks::open(ledger(&path)).unwrap();
        let restored = reopened.get(&first.id).unwrap().unwrap();
        assert_eq!(restored.status, TaskStatus::Interrupted);
        assert_eq!(restored.original_request, first.original_request);
        assert_eq!(reopened.submit_human_request(request("client-1", "Fix the bug"), "ignored".into(), Some(destination())).unwrap().id, first.id);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn unresolved_request_needs_clarification_and_proposal_stays_proposed() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let unresolved = HumanRequest {
            request_id: "clarify".into(),
            owner: owner(),
            text: "Do something".into(),
            destination: None,
        };
        let task = store
            .submit_human_request(unresolved, "brief".into(), None)
            .unwrap();
        assert_eq!(task.status, TaskStatus::NeedsClarification);
        let queued = store
            .set_destination(
                &task.id,
                task.revision,
                &owner(),
                destination(),
                "resolved brief".into(),
            )
            .unwrap();
        assert_eq!(queued.status, TaskStatus::Queued);
        assert_eq!(queued.parent_thread_id.as_deref(), Some("child"));
        let proposal = store
            .create_proposal(owner(), "Maybe do it".into(), "brief".into())
            .unwrap();
        assert_eq!(proposal.status, TaskStatus::Proposed);
        assert!(proposal.usage.is_none());
        assert_eq!(
            store
                .begin_attempt(&proposal.id, proposal.revision, &owner())
                .unwrap_err()
                .kind,
            TaskErrorKind::InvalidTransition
        );
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn authority_and_revision_guard_task_actions() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let task = store
            .submit_human_request(request("r", "Do it"), "brief".into(), Some(destination()))
            .unwrap();
        let mut intruder = owner();
        intruder.workspace_id = "other".into();
        assert_eq!(
            store
                .transition(
                    &task.id,
                    task.revision,
                    &intruder,
                    TaskStatus::Cancelled,
                    None
                )
                .unwrap_err()
                .kind,
            TaskErrorKind::NotOwner
        );
        let queued = store
            .transition(&task.id, task.revision, &owner(), TaskStatus::Running, None)
            .unwrap_err();
        assert_eq!(queued.kind, TaskErrorKind::InvalidTransition);
        let cancelled = store
            .transition(
                &task.id,
                task.revision,
                &owner(),
                TaskStatus::Cancelled,
                None,
            )
            .unwrap();
        assert_eq!(
            store
                .transition(
                    &task.id,
                    task.revision,
                    &owner(),
                    TaskStatus::Cancelled,
                    None
                )
                .unwrap_err()
                .kind,
            TaskErrorKind::StaleRevision
        );
        assert_eq!(cancelled.status, TaskStatus::Cancelled);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn interrupted_runs_recover_without_redispatch_and_ready_review_keeps_ownership() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let task = store
            .submit_human_request(request("r", "Do it"), "brief".into(), Some(destination()))
            .unwrap();
        let (running, run_id) = store
            .begin_attempt(&task.id, task.revision, &owner())
            .unwrap();
        assert_eq!(running.attempts[0].run_id, run_id);
        assert!(run_id.ends_with("1"));
        let recovered = AssistantTasks::open(ledger(&path)).unwrap();
        let interrupted = recovered.get(&task.id).unwrap().unwrap();
        assert_eq!(interrupted.status, TaskStatus::Interrupted);
        assert_eq!(interrupted.attempts[0].status, TaskStatus::Interrupted);
        assert_eq!(interrupted.attempts.len(), 1);
        let (retry, second_run) = recovered
            .begin_attempt(&task.id, interrupted.revision, &owner())
            .unwrap();
        assert_ne!(second_run, run_id);
        assert_eq!(retry.attempts.len(), 2);
        let review = recovered
            .transition(
                &task.id,
                retry.revision,
                &owner(),
                TaskStatus::ReadyForReview,
                None,
            )
            .unwrap();
        assert_eq!(
            review.attempts.last().unwrap().review_revision,
            Some(review.revision)
        );
        drop(recovered);
        let opened = AssistantTasks::open(ledger(&path)).unwrap();
        assert_eq!(opened.get(&task.id).unwrap().unwrap(), review);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn continuation_invalidates_old_review_and_attempt_ids_are_monotonic() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let task = store
            .submit_human_request(request("r", "Do it"), "brief".into(), Some(destination()))
            .unwrap();
        let (running, first_run) = store
            .begin_attempt(&task.id, task.revision, &owner())
            .unwrap();
        let review = store
            .transition(
                &task.id,
                running.revision,
                &owner(),
                TaskStatus::ReadyForReview,
                None,
            )
            .unwrap();
        let (continued, second_run) = store
            .begin_attempt(&task.id, review.revision, &owner())
            .unwrap();
        assert_eq!(continued.attempts[0].review_revision, None);
        assert_eq!(continued.attempts[1].number, 2);
        assert_ne!(first_run, second_run);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn old_run_completion_cannot_finish_a_later_attempt_and_usage_is_partial() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let task = store
            .submit_human_request(request("r", "Do it"), "brief".into(), Some(destination()))
            .unwrap();
        let (_first, first_run) = store
            .begin_attempt(&task.id, task.revision, &owner())
            .unwrap();
        let review = store
            .finish_attempt(
                &task.id,
                &first_run,
                TaskOutcome {
                    status: TaskStatus::ReadyForReview,
                    result: Some("Done".into()),
                    result_data: Some(serde_json::json!({"diff": "...", "checks": ["ok"]})),
                    usage: Some(TaskUsage {
                        input_tokens: Some(12),
                        output_tokens: None,
                        cost_micros: Some(45),
                    }),
                },
            )
            .unwrap();
        let (second, second_run) = store
            .begin_attempt(&task.id, review.revision, &owner())
            .unwrap();
        assert_ne!(first_run, second_run);
        assert_eq!(
            store
                .finish_attempt(
                    &task.id,
                    &first_run,
                    TaskOutcome {
                        status: TaskStatus::Failed,
                        result: None,
                        result_data: None,
                        usage: None
                    }
                )
                .unwrap_err()
                .kind,
            TaskErrorKind::StaleRevision
        );
        assert_eq!(
            store.get(&task.id).unwrap().unwrap().attempts.len(),
            second.attempts.len()
        );
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn approval_wait_and_usage_updates_do_not_stale_task_actions() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let task = store
            .submit_human_request(request("r", "Do it"), "brief".into(), Some(destination()))
            .unwrap();
        let (running, run_id) = store
            .begin_attempt(&task.id, task.revision, &owner())
            .unwrap();
        let waiting = store.set_run_waiting(&task.id, &run_id, true).unwrap();
        assert_eq!(waiting.revision, running.revision);
        let resumed = store.set_run_waiting(&task.id, &run_id, false).unwrap();
        assert_eq!(resumed.revision, running.revision);
        let updated = store
            .record_run_usage(
                &task.id,
                &run_id,
                TaskUsage {
                    input_tokens: Some(10),
                    output_tokens: None,
                    cost_micros: None,
                },
            )
            .unwrap();
        assert_eq!(updated.revision, running.revision);
        assert_eq!(
            updated.attempts[0].usage.as_ref().unwrap().input_tokens,
            Some(10)
        );
        assert_eq!(
            store
                .transition(
                    &task.id,
                    running.revision,
                    &owner(),
                    TaskStatus::Cancelled,
                    None
                )
                .unwrap()
                .status,
            TaskStatus::Cancelled
        );
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn all_queued_tasks_require_explicit_retry_after_restart() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let first = store
            .submit_human_request(
                request("first", "Do it"),
                "brief".into(),
                Some(destination()),
            )
            .unwrap();
        let (started, _) = store
            .begin_attempt(&first.id, first.revision, &owner())
            .unwrap();
        let failed = store
            .transition(
                &first.id,
                started.revision,
                &owner(),
                TaskStatus::Failed,
                None,
            )
            .unwrap();
        let queued_retry = store
            .transition(
                &first.id,
                failed.revision,
                &owner(),
                TaskStatus::Queued,
                None,
            )
            .unwrap();
        let second = store
            .submit_human_request(
                request("second", "Also do it"),
                "brief".into(),
                Some(destination()),
            )
            .unwrap();
        drop(store);
        let recovered = AssistantTasks::open(ledger(&path)).unwrap();
        assert_eq!(
            recovered.get(&first.id).unwrap().unwrap().status,
            TaskStatus::Interrupted
        );
        assert_eq!(
            recovered.get(&second.id).unwrap().unwrap().status,
            TaskStatus::Interrupted
        );
        assert_eq!(queued_retry.attempts.len(), 1);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn tombstones_prevent_execution_thread_resurrection() {
        let path = folder();
        let store = AssistantTasks::open(ledger(&path)).unwrap();
        let task = store
            .create_proposal(owner(), "Do it".into(), "brief".into())
            .unwrap();
        store
            .bind_execution(
                &task.id,
                task.revision,
                &owner(),
                "child".into(),
                TaskMode::InPlace,
                Some(serde_json::json!({"baseline":"rev-a"})),
            )
            .unwrap();
        store.tombstone_execution("child").unwrap();
        assert!(store.execution("child").unwrap().unwrap().is_tombstoned());
        assert_eq!(
            store
                .bind_execution(
                    &task.id,
                    store.get(&task.id).unwrap().unwrap().revision,
                    &owner(),
                    "child".into(),
                    TaskMode::InPlace,
                    None
                )
                .unwrap_err()
                .kind,
            TaskErrorKind::Tombstoned
        );
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn failed_disk_write_rolls_back_memory_and_consumes_no_request_id() {
        let root = folder();
        std::fs::create_dir_all(&root).unwrap();
        let ledger = root.join("ledger.json");
        let store = AssistantTasks::open(&ledger).unwrap();
        std::fs::create_dir(&ledger).unwrap();
        assert_eq!(
            store
                .submit_human_request(request("r", "Do it"), "brief".into(), Some(destination()))
                .unwrap_err()
                .kind,
            TaskErrorKind::Storage
        );
        assert!(store.list(None).unwrap().is_empty());
        std::fs::remove_dir(&ledger).unwrap();
        let task = store
            .submit_human_request(request("r", "Do it"), "brief".into(), Some(destination()))
            .unwrap();
        assert!(task.id.ends_with("1"));
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
