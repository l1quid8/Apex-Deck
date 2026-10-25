//! Host-owned project notes and reviewed task scratch. Opening and reading are
//! side-effect free; all changes publish one durable document before memory.

use crate::assistant_tasks::{TaskError, TaskErrorKind};
use crate::personal::FactKind;
use crate::personal_workspace::{AssistantRef, ProjectRef};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_ACTIVE_NOTES: usize = 500;
const MAX_NOTE_RECORDS: usize = 5000;
const MAX_CURRENT_SCRATCH: usize = 1000;
// Retain source/delivery tombstones rather than garbage collecting replay guards.
const MAX_SCRATCH_RECORDS: usize = 5000;
const MAX_DELIVERY_IDS: usize = 10000;
const MAX_TEXT_CHARS: usize = 2000;
const SCRATCH_TTL_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNote {
    pub id: String,
    pub project: ProjectRef,
    pub text: String,
    pub kind: FactKind,
    pub version: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub author: Option<AssistantRef>,
    pub source: NoteSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
}

impl ProjectNote {
    pub fn current(&self, now: u64) -> bool {
        crate::memory_lifecycle::current(
            self.deleted_at,
            self.superseded_by.as_deref(),
            self.expires_at,
            now,
        )
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveNote {
    pub project: ProjectRef,
    pub id: Option<String>,
    pub expected_version: Option<u64>,
    pub text: String,
    pub kind: FactKind,
    pub author: Option<AssistantRef>,
    #[serde(default)]
    pub source: NoteSource,
    pub expires_at: Option<u64>,
    pub now: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScratch {
    pub id: String,
    pub project: ProjectRef,
    pub assistant: AssistantRef,
    pub task_id: String,
    pub attempt: u64,
    pub run_id: String,
    /// Revision when the evidence was first captured; zero means a legacy
    /// record that predates capture-revision metadata.
    #[serde(default)]
    pub captured_task_revision: u64,
    /// Latest explicit human review, independently validated by the host.
    pub expected_task_revision: u64,
    pub text: String,
    pub kind: FactKind,
    pub created_at: u64,
    pub expires_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageScratch {
    pub project: ProjectRef,
    pub assistant: AssistantRef,
    pub task_id: String,
    pub attempt: u64,
    pub run_id: String,
    pub expected_task_revision: u64,
    pub text: String,
    pub kind: FactKind,
    pub now: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromoteScratch {
    pub project: ProjectRef,
    pub assistant: AssistantRef,
    pub task_id: String,
    pub attempt: u64,
    pub run_id: String,
    pub scratch_id: String,
    pub expected_task_revision: u64,
    pub expected_version: Option<u64>,
    pub promotion_id: String,
    pub now: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionReceipt {
    pub project: ProjectRef,
    pub assistant: AssistantRef,
    pub task_id: String,
    pub attempt: u64,
    pub run_id: String,
    pub scratch_id: String,
    pub expected_task_revision: u64,
    pub promotion_id: String,
    pub note_id: String,
    pub note_version: u64,
    pub promoted_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromotionBinding {
    project: ProjectRef,
    assistant: AssistantRef,
    task_id: String,
    attempt: u64,
    run_id: String,
    scratch_id: String,
    expected_task_revision: u64,
    expected_version: Option<u64>,
}

impl From<&PromoteScratch> for PromotionBinding {
    fn from(request: &PromoteScratch) -> Self {
        Self {
            project: request.project.clone(),
            assistant: request.assistant.clone(),
            task_id: request.task_id.clone(),
            attempt: request.attempt,
            run_id: request.run_id.clone(),
            scratch_id: request.scratch_id.clone(),
            expected_task_revision: request.expected_task_revision,
            expected_version: request.expected_version,
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    version: u32,
    #[serde(default)]
    next_note_id: u64,
    #[serde(default)]
    notes: BTreeMap<String, ProjectNote>,
    #[serde(default)]
    scratch: BTreeMap<String, ProjectScratch>,
    #[serde(default)]
    promotions: BTreeMap<String, PromotionReceipt>,
    #[serde(default)]
    delivery_ids: BTreeMap<String, PromotionBinding>,
}

struct Inner {
    path: PathBuf,
    document: Mutex<Document>,
}

/// Construct once per host data directory; clones share the transaction lock.
#[derive(Clone)]
pub struct ProjectMemory {
    inner: Arc<Inner>,
}

impl ProjectMemory {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, TaskError> {
        let path = path.as_ref().to_path_buf();
        // Authority-bearing: production reads only the root broker. A same-user
        // process editing this JSON on disk is not authoritative, by design.
        let document = match crate::authority_file::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Document>(&bytes)
                .map_err(|e| storage(format!("Could not read project memory: {e}")))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Document {
                version: 1,
                ..Document::default()
            },
            Err(e) => return Err(storage(format!("Could not read project memory: {e}"))),
        };
        if document.version != 1 {
            return Err(storage("Unsupported project memory document version."));
        }
        Ok(Self {
            inner: Arc::new(Inner {
                path,
                document: Mutex::new(document),
            }),
        })
    }

    /// Start empty when the root broker cannot serve this UI, or when the
    /// installed build is not the one the broker pinned.
    ///
    /// A host that refuses to start is worse than a host with no notes: the
    /// window stays on its splash screen with nothing to act on. Reads return
    /// empty and writes stay closed, because `authority_file::write` refuses a
    /// ledger that was never read. The broker keeps the real records, so
    /// nothing is discarded and a later re-pin brings them back.
    pub fn unavailable(path: impl AsRef<Path>) -> Self {
        Self {
            inner: Arc::new(Inner {
                path: path.as_ref().to_path_buf(),
                document: Mutex::new(Document {
                    version: 1,
                    ..Document::default()
                }),
            }),
        }
    }

    /// All project history, including expired/superseded/deleted metadata.
    /// Use `current` for context retrieval. Forgotten records contain no text.
    pub fn list(&self, project: &ProjectRef, _now: u64) -> Result<Vec<ProjectNote>, TaskError> {
        validate_project(project)?;
        let document = self
            .inner
            .document
            .lock()
            .map_err(|_| storage("Project memory lock is unavailable."))?;
        Ok(document
            .notes
            .values()
            .filter(|n| &n.project == project)
            .cloned()
            .collect())
    }

    pub fn current(&self, project: &ProjectRef, now: u64) -> Result<Vec<ProjectNote>, TaskError> {
        Ok(self
            .list(project, now)?
            .into_iter()
            .filter(|n| n.current(now))
            .collect())
    }

    pub fn save(&self, request: SaveNote) -> Result<ProjectNote, TaskError> {
        validate_project(&request.project)?;
        validate_text(&request.text)?;
        validate_source(&request.source)?;
        if let Some(author) = &request.author {
            validate_assistant(author)?;
        }
        if request.expires_at.is_some_and(|at| at <= request.now) {
            return Err(invalid("A note's expiration must be in the future."));
        }
        match (&request.id, request.expected_version) {
            (None, Some(_)) => return Err(invalid("A new note cannot have an expected version.")),
            (Some(id), None) => {
                validate_id(id)?;
                return Err(invalid("A correction requires the current note version."));
            }
            (Some(id), Some(_)) => validate_id(id)?,
            _ => {}
        }
        self.mutate(|document| {
            if let Some(id) = &request.id {
                let previous = scoped_note(document, &request.project, id)?;
                if Some(previous.version) != request.expected_version
                    || !previous.current(request.now)
                {
                    return Err(stale(
                        "This note changed or is no longer current. Refresh before correcting it.",
                    ));
                }
            }
            ensure_note_capacity(
                document,
                &request.project,
                request.now,
                request.id.is_some(),
            )?;
            let id = next_note_id(document)?;
            if let Some(previous_id) = &request.id {
                let previous = document.notes.get_mut(previous_id).unwrap();
                previous.version = increment(previous.version)?;
                previous.updated_at = request.now;
                previous.superseded_by = Some(id.clone());
            }
            let note = ProjectNote {
                id: id.clone(),
                project: request.project,
                text: request.text,
                kind: request.kind,
                version: 1,
                created_at: request.now,
                updated_at: request.now,
                author: request.author,
                source: request.source,
                expires_at: request.expires_at,
                superseded_by: None,
                deleted_at: None,
            };
            document.notes.insert(id, note.clone());
            Ok((note, true))
        })
    }

    /// Erase the selected note, every predecessor/successor, and staged copies.
    pub fn forget(
        &self,
        project: &ProjectRef,
        id: &str,
        expected_version: u64,
        now: u64,
    ) -> Result<Vec<ProjectNote>, TaskError> {
        validate_project(project)?;
        validate_id(id)?;
        self.mutate(|document| {
            let selected = scoped_note(document, project, id)?;
            if selected.version != expected_version {
                return Err(stale("This note changed. Refresh before forgetting it."));
            }
            let chain = crate::memory_lifecycle::correction_chain(
                id,
                document
                    .notes
                    .values()
                    .filter(|note| &note.project == project)
                    .map(|note| (note.id.as_str(), note.superseded_by.as_deref())),
            );
            let texts: std::collections::BTreeSet<_> = chain
                .iter()
                .filter_map(|id| document.notes.get(id))
                .filter(|note| !note.text.is_empty())
                .map(|note| note.text.clone())
                .collect();
            let scratch_ids: std::collections::BTreeSet<_> = chain
                .iter()
                .filter_map(|id| document.notes.get(id))
                .filter_map(|note| note.source.scratch_id.clone())
                .collect();
            let mut changed = false;
            for scratch in document
                .scratch
                .values_mut()
                .filter(|scratch| &scratch.project == project)
            {
                if (scratch_ids.contains(&scratch.id) || texts.contains(&scratch.text))
                    && scratch.deleted_at.is_none()
                {
                    scratch.text.clear();
                    scratch.deleted_at = Some(now);
                    changed = true;
                }
            }
            let mut erased = Vec::with_capacity(chain.len());
            for id in chain {
                let note = document
                    .notes
                    .get_mut(&id)
                    .ok_or_else(|| storage("A correction chain is incomplete."))?;
                if note.deleted_at.is_none() || !note.text.is_empty() {
                    note.text.clear();
                    note.deleted_at = Some(now);
                    note.updated_at = now;
                    note.version = increment(note.version)?;
                    changed = true;
                }
                erased.push(note.clone());
            }
            Ok((erased, changed))
        })
    }

    pub fn stage(&self, request: StageScratch) -> Result<ProjectScratch, TaskError> {
        validate_project(&request.project)?;
        validate_assistant(&request.assistant)?;
        validate_task_source(
            &request.task_id,
            request.attempt,
            &request.run_id,
            request.expected_task_revision,
        )?;
        validate_text(&request.text)?;
        let expires_at = request
            .now
            .checked_add(SCRATCH_TTL_MS)
            .ok_or_else(|| invalid("Scratch expiration is out of range."))?;
        let id = scratch_id(&request)?;
        self.mutate(|document| {
            if let Some(existing) = document.scratch.get(&id) {
                if existing.deleted_at.is_some()
                    || existing.expires_at <= request.now
                {
                    return Err(stale(
                        "This scratch source was forgotten or expired.",
                    ));
                }
                if existing.expected_task_revision == request.expected_task_revision {
                    return Ok((existing.clone(), false));
                }
                let source = source_key(&existing.project, &existing.task_id, existing.attempt, &existing.id)?;
                if document.promotions.contains_key(&source) {
                    return Err(stale("This source is already promoted; inspect its existing receipt."));
                }
                if request.expected_task_revision < existing.expected_task_revision {
                    return Err(stale("This scratch was reviewed at a newer task revision. Refresh before reviewing it."));
                }
                // The host revalidates the completed result and lineage under
                // its task lock before reaching this explicit review operation.
                // Evidence, stable ID, capture revision and lifetime stay fixed.
                let existing = document.scratch.get_mut(&id).unwrap();
                existing.expected_task_revision = request.expected_task_revision;
                return Ok((existing.clone(), true));
            }
            if document
                .scratch
                .values()
                .filter(|s| s.project == request.project)
                .count()
                >= MAX_SCRATCH_RECORDS
            {
                return Err(invalid(
                    "This project already has 5000 retained scratch records.",
                ));
            }
            if document
                .scratch
                .values()
                .filter(|s| {
                    s.project == request.project
                        && s.deleted_at.is_none()
                        && s.expires_at > request.now
                })
                .count()
                >= MAX_CURRENT_SCRATCH
            {
                return Err(invalid(
                    "This project already has 1000 current scratch records.",
                ));
            }
            let scratch = ProjectScratch {
                id: id.clone(),
                project: request.project,
                assistant: request.assistant,
                task_id: request.task_id,
                attempt: request.attempt,
                run_id: request.run_id,
                captured_task_revision: request.expected_task_revision,
                expected_task_revision: request.expected_task_revision,
                text: request.text,
                kind: request.kind,
                created_at: request.now,
                expires_at,
                deleted_at: None,
            };
            document.scratch.insert(id, scratch.clone());
            Ok((scratch, true))
        })
    }

    pub fn scratch(
        &self,
        project: &ProjectRef,
        id: &str,
    ) -> Result<Option<ProjectScratch>, TaskError> {
        validate_project(project)?;
        validate_id(id)?;
        let document = self
            .inner
            .document
            .lock()
            .map_err(|_| storage("Project memory lock is unavailable."))?;
        Ok(document
            .scratch
            .get(id)
            .filter(|s| &s.project == project)
            .cloned())
    }

    pub fn promote(&self, request: PromoteScratch) -> Result<PromotionReceipt, TaskError> {
        validate_project(&request.project)?;
        validate_assistant(&request.assistant)?;
        validate_task_source(
            &request.task_id,
            request.attempt,
            &request.run_id,
            request.expected_task_revision,
        )?;
        validate_id(&request.scratch_id)?;
        validate_id(&request.promotion_id)?;
        let source_key = source_key(
            &request.project,
            &request.task_id,
            request.attempt,
            &request.scratch_id,
        )?;
        let binding = PromotionBinding::from(&request);
        self.mutate(|document| {
            if document.delivery_ids.get(&request.promotion_id).is_some_and(|existing| existing != &binding) {
                return Err(conflict("This promotion identifier is already bound to a different request."));
            }
            if !document.delivery_ids.contains_key(&request.promotion_id)
                && document.delivery_ids.values().filter(|b| b.project == request.project).count() >= MAX_DELIVERY_IDS {
                return Err(invalid("This project already has 10000 retained promotion delivery identifiers. Use a known delivery identifier to retrieve an existing receipt."));
            }
            let scratch = document.scratch.get(&request.scratch_id).filter(|scratch| scratch.project == request.project)
                .ok_or_else(|| not_found("Reviewed scratch was not found in this project."))?;
            if scratch.assistant != request.assistant || scratch.task_id != request.task_id || scratch.attempt != request.attempt
                || scratch.run_id != request.run_id || scratch.expected_task_revision != request.expected_task_revision
                || scratch.deleted_at.is_some() || scratch.expires_at <= request.now {
                return Err(stale("The reviewed scratch source changed, expired or was forgotten."));
            }
            if let Some(receipt) = document.promotions.get(&source_key).cloned() {
                require_current_receipt(document, &receipt, request.now)?;
                if request.expected_version.is_some_and(|version| version != receipt.note_version) {
                    return Err(stale("The promoted note version changed."));
                }
                let changed = document.delivery_ids.insert(request.promotion_id, binding).is_none();
                return Ok((receipt, changed));
            }
            if request.expected_version.is_some() {
                return Err(invalid("A first promotion creates a note and cannot have an expected version."));
            }
            ensure_note_capacity(document, &request.project, request.now, false)?;
            let scratch = scratch.clone();
            let note_id = next_note_id(document)?;
            let note = ProjectNote {
                id: note_id.clone(), project: request.project.clone(), text: scratch.text,
                kind: scratch.kind, version: 1, created_at: request.now, updated_at: request.now,
                author: Some(request.assistant.clone()),
                source: NoteSource { task_id: Some(request.task_id.clone()), attempt: Some(request.attempt),
                    run_id: Some(request.run_id.clone()), scratch_id: Some(request.scratch_id.clone()), message_id: None },
                expires_at: None, superseded_by: None, deleted_at: None,
            };
            let receipt = PromotionReceipt {
                project: request.project, assistant: request.assistant, task_id: request.task_id,
                attempt: request.attempt, run_id: request.run_id, scratch_id: request.scratch_id,
                expected_task_revision: request.expected_task_revision, promotion_id: request.promotion_id.clone(),
                note_id: note_id.clone(), note_version: note.version, promoted_at: request.now,
            };
            document.notes.insert(note_id, note);
            document.promotions.insert(source_key, receipt.clone());
            document.delivery_ids.insert(request.promotion_id, binding);
            Ok((receipt, true))
        })
    }

    pub fn promotion_receipt(
        &self,
        project: &ProjectRef,
        promotion_id: &str,
        now: u64,
    ) -> Result<Option<PromotionReceipt>, TaskError> {
        validate_project(project)?;
        validate_id(promotion_id)?;
        let document = self
            .inner
            .document
            .lock()
            .map_err(|_| storage("Project memory lock is unavailable."))?;
        let Some(binding) = document
            .delivery_ids
            .get(promotion_id)
            .filter(|b| &b.project == project)
        else {
            return Ok(None);
        };
        let key = source_key(
            project,
            &binding.task_id,
            binding.attempt,
            &binding.scratch_id,
        )?;
        let receipt = document
            .promotions
            .get(&key)
            .ok_or_else(|| storage("A promotion receipt is missing."))?;
        require_current_receipt(&document, receipt, now)?;
        Ok(Some(receipt.clone()))
    }

    pub fn source_receipt(
        &self,
        project: &ProjectRef,
        task_id: &str,
        attempt: u64,
        scratch_id: &str,
        now: u64,
    ) -> Result<Option<PromotionReceipt>, TaskError> {
        validate_project(project)?;
        validate_id(task_id)?;
        validate_id(scratch_id)?;
        if attempt == 0 {
            return Err(invalid("An attempt must be positive."));
        }
        let key = source_key(project, task_id, attempt, scratch_id)?;
        let document = self
            .inner
            .document
            .lock()
            .map_err(|_| storage("Project memory lock is unavailable."))?;
        let Some(receipt) = document.promotions.get(&key) else {
            return Ok(None);
        };
        require_current_receipt(&document, receipt, now)?;
        Ok(Some(receipt.clone()))
    }

    fn mutate<T>(
        &self,
        operation: impl FnOnce(&mut Document) -> Result<(T, bool), TaskError>,
    ) -> Result<T, TaskError> {
        let mut document = self
            .inner
            .document
            .lock()
            .map_err(|_| storage("Project memory lock is unavailable."))?;
        let mut candidate = document.clone();
        let (result, changed) = operation(&mut candidate)?;
        if changed {
            write_document(&self.inner.path, &candidate)?;
            *document = candidate;
        }
        Ok(result)
    }
}

fn error(kind: TaskErrorKind, message: impl Into<String>) -> TaskError {
    TaskError {
        kind,
        message: message.into(),
    }
}
fn invalid(message: impl Into<String>) -> TaskError {
    error(TaskErrorKind::InvalidRequest, message)
}
fn stale(message: impl Into<String>) -> TaskError {
    error(TaskErrorKind::StaleRevision, message)
}
fn storage(message: impl Into<String>) -> TaskError {
    error(TaskErrorKind::Storage, message)
}
fn not_found(message: impl Into<String>) -> TaskError {
    error(TaskErrorKind::NotFound, message)
}
fn conflict(message: impl Into<String>) -> TaskError {
    error(TaskErrorKind::RequestIdConflict, message)
}

fn validate_id(value: &str) -> Result<(), TaskError> {
    if value.is_empty()
        || value != value.trim()
        || value.chars().any(char::is_control)
        || value.chars().count() > 512
    {
        return Err(invalid(
            "Use a nonempty identifier without surrounding whitespace or control characters.",
        ));
    }
    Ok(())
}

fn validate_project(project: &ProjectRef) -> Result<(), TaskError> {
    validate_id(&project.host_id)?;
    validate_id(&project.workspace_id)?;
    let cwd = &project.cwd;
    if !Path::new(cwd).is_absolute()
        || cwd.len() > 4096
        || cwd.chars().any(char::is_control)
        || cwd != cwd.trim()
        || cwd.contains("//")
        || (cwd != "/" && cwd.ends_with('/'))
        || cwd.split('/').any(|part| part == "." || part == "..")
    {
        return Err(invalid(
            "The project requires an absolute canonical checkout path.",
        ));
    }
    Ok(())
}

fn validate_assistant(assistant: &AssistantRef) -> Result<(), TaskError> {
    validate_id(&assistant.host_id)?;
    validate_id(&assistant.assistant_id)
}

fn validate_text(text: &str) -> Result<(), TaskError> {
    if text.trim().is_empty() || text.chars().count() > MAX_TEXT_CHARS || text.contains('\0') {
        return Err(invalid(
            "A project note needs 1 to 2000 Unicode characters.",
        ));
    }
    Ok(())
}

fn validate_task_source(
    task_id: &str,
    attempt: u64,
    run_id: &str,
    revision: u64,
) -> Result<(), TaskError> {
    validate_id(task_id)?;
    validate_id(run_id)?;
    if attempt == 0 || revision == 0 {
        return Err(invalid("Task attempt and revision must be positive."));
    }
    Ok(())
}

fn validate_source(source: &NoteSource) -> Result<(), TaskError> {
    for id in [
        &source.task_id,
        &source.run_id,
        &source.scratch_id,
        &source.message_id,
    ]
    .into_iter()
    .flatten()
    {
        validate_id(id)?;
    }
    if source
        .attempt
        .is_some_and(|attempt| attempt == 0 || source.task_id.is_none())
        || (source.run_id.is_some() && (source.task_id.is_none() || source.attempt.is_none()))
        || (source.scratch_id.is_some()
            && (source.task_id.is_none() || source.attempt.is_none() || source.run_id.is_none()))
    {
        return Err(invalid(
            "Task provenance requires a complete positive task/attempt/run source.",
        ));
    }
    Ok(())
}

fn scoped_note<'a>(
    document: &'a Document,
    project: &ProjectRef,
    id: &str,
) -> Result<&'a ProjectNote, TaskError> {
    document
        .notes
        .get(id)
        .filter(|note| &note.project == project)
        .ok_or_else(|| not_found("This note was not found in the selected project."))
}

fn increment(value: u64) -> Result<u64, TaskError> {
    value
        .checked_add(1)
        .ok_or_else(|| storage("The project note version is exhausted."))
}

fn next_note_id(document: &mut Document) -> Result<String, TaskError> {
    loop {
        document.next_note_id = increment(document.next_note_id)?;
        let id = format!("project-note-{}", document.next_note_id);
        if !document.notes.contains_key(&id) {
            return Ok(id);
        }
    }
}

fn ensure_note_capacity(
    document: &Document,
    project: &ProjectRef,
    now: u64,
    correction: bool,
) -> Result<(), TaskError> {
    let notes: Vec<_> = document
        .notes
        .values()
        .filter(|note| &note.project == project)
        .collect();
    if notes.len() >= MAX_NOTE_RECORDS {
        return Err(invalid(
            "This project already has 5000 historical note records.",
        ));
    }
    if !correction && notes.iter().filter(|note| note.current(now)).count() >= MAX_ACTIVE_NOTES {
        return Err(invalid("This project already has 500 active notes."));
    }
    Ok(())
}

fn scratch_id(request: &StageScratch) -> Result<String, TaskError> {
    // JSON arrays preserve field boundaries, including adversarial delimiters.
    // Review revisions are separate from the immutable capture identity/TTL.
    let bytes = serde_json::to_vec(&(
        &request.project,
        &request.assistant,
        &request.task_id,
        request.attempt,
        &request.run_id,
        &request.text,
        request.kind,
    ))
    .map_err(|e| storage(e.to_string()))?;
    Ok(format!("scratch-{:x}", Sha256::digest(bytes)))
}

fn source_key(
    project: &ProjectRef,
    task_id: &str,
    attempt: u64,
    scratch_id: &str,
) -> Result<String, TaskError> {
    serde_json::to_string(&(project, task_id, attempt, scratch_id))
        .map_err(|e| storage(e.to_string()))
}

fn require_current_receipt(
    document: &Document,
    receipt: &PromotionReceipt,
    now: u64,
) -> Result<(), TaskError> {
    let note = scoped_note(document, &receipt.project, &receipt.note_id)?;
    let scratch = document
        .scratch
        .get(&receipt.scratch_id)
        .filter(|s| s.project == receipt.project)
        .ok_or_else(|| stale("The promoted scratch source is unavailable."))?;
    if !note.current(now)
        || note.version != receipt.note_version
        || scratch.deleted_at.is_some()
        || scratch.expires_at <= now
    {
        return Err(stale(
            "This promoted source is expired, superseded or forgotten.",
        ));
    }
    Ok(())
}

fn write_document(path: &Path, document: &Document) -> Result<(), TaskError> {
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|e| storage(format!("Could not encode project memory: {e}")))?;
    // Routed through the root broker like every other authority-bearing ledger.
    crate::authority_file::write(path, &bytes)
        .map_err(|e| storage(format!("Could not save project memory: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};

    struct Fixture {
        dir: PathBuf,
        path: PathBuf,
        /// Where the local fixture keeps the protected document for `path`.
        disk: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "apex-project-memory-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("project-memory-v1.json");
            let disk = crate::authority_file::fixture_path(&path);
            Self { dir, path, disk }
        }
        fn store(&self) -> ProjectMemory {
            ProjectMemory::open(&self.path).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    fn project() -> ProjectRef {
        ProjectRef {
            host_id: "host-a".into(),
            workspace_id: "workspace-a".into(),
            cwd: if cfg!(windows) { "C:/projects/a" } else { "/projects/a" }.into(),
        }
    }
    fn other_project() -> ProjectRef {
        ProjectRef {
            workspace_id: "workspace-b".into(),
            ..project()
        }
    }
    fn assistant() -> AssistantRef {
        AssistantRef {
            host_id: "host-a".into(),
            assistant_id: "assistant-a".into(),
        }
    }
    fn save(text: &str, now: u64) -> SaveNote {
        SaveNote {
            project: project(),
            id: None,
            expected_version: None,
            text: text.into(),
            kind: FactKind::Fact,
            author: Some(assistant()),
            source: NoteSource::default(),
            expires_at: None,
            now,
        }
    }
    fn stage(text: &str, now: u64) -> StageScratch {
        StageScratch {
            project: project(),
            assistant: assistant(),
            task_id: "task-a".into(),
            attempt: 1,
            run_id: "run-a".into(),
            expected_task_revision: 7,
            text: text.into(),
            kind: FactKind::Decision,
            now,
        }
    }
    fn promote(scratch: &ProjectScratch, id: &str, now: u64) -> PromoteScratch {
        PromoteScratch {
            project: scratch.project.clone(),
            assistant: scratch.assistant.clone(),
            task_id: scratch.task_id.clone(),
            attempt: scratch.attempt,
            run_id: scratch.run_id.clone(),
            scratch_id: scratch.id.clone(),
            expected_task_revision: scratch.expected_task_revision,
            expected_version: None,
            promotion_id: id.into(),
            now,
        }
    }
    fn error<T: std::fmt::Debug>(value: Result<T, TaskError>, kind: TaskErrorKind) {
        assert_eq!(value.unwrap_err().kind, kind);
    }

    // A missing project filter would disclose the first project's text.
    #[test]
    fn project_memory_isolates_full_project_ref_and_retains_inactive_metadata() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let first = store.save(save("project-a only", 10)).unwrap();
        let mut request = save("project-b only", 11);
        request.project = other_project();
        store.save(request).unwrap();
        assert_eq!(store.list(&project(), 20).unwrap(), vec![first.clone()]);
        for other in [
            ProjectRef {
                host_id: "host-b".into(),
                ..project()
            },
            ProjectRef {
                cwd: if cfg!(windows) { "C:/projects/b" } else { "/projects/b" }.into(),
                ..project()
            },
        ] {
            assert!(store.list(&other, 20).unwrap().is_empty());
            error(
                store.forget(&other, &first.id, first.version, 20),
                TaskErrorKind::NotFound,
            );
        }
        let mut correction = save("corrected", 21);
        correction.id = Some(first.id.clone());
        correction.expected_version = Some(first.version);
        let second = store.save(correction).unwrap();
        assert_eq!(store.current(&project(), 22).unwrap(), vec![second.clone()]);
        let history = store.list(&project(), 22).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(
            history
                .iter()
                .find(|n| n.id == first.id)
                .unwrap()
                .superseded_by,
            Some(second.id)
        );
    }

    // Missing version checks would let stale editors overwrite a correction.
    #[test]
    fn project_memory_requires_expected_version_for_every_correction() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let mut invalid = save("new", 1);
        invalid.expected_version = Some(1);
        error(store.save(invalid), TaskErrorKind::InvalidRequest);
        let first = store.save(save("original", 1)).unwrap();
        let mut edit = save("updated", 2);
        edit.id = Some(first.id.clone());
        error(store.save(edit.clone()), TaskErrorKind::InvalidRequest);
        edit.expected_version = Some(8);
        error(store.save(edit.clone()), TaskErrorKind::StaleRevision);
        edit.expected_version = Some(first.version);
        let second = store.save(edit.clone()).unwrap();
        assert_ne!(first.id, second.id);
        error(store.save(edit), TaskErrorKind::StaleRevision);
        error(
            store.forget(&project(), &second.id, 0, 3),
            TaskErrorKind::StaleRevision,
        );
        assert_eq!(store.current(&project(), 3).unwrap(), vec![second]);
    }

    // Erasing only a tombstone would leave sensitive predecessor/scratch text on disk.
    #[test]
    fn project_memory_forget_erases_the_whole_chain_and_scratch_copies_on_disk() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let scratch = store.stage(stage("private-original", 1)).unwrap();
        let receipt = store.promote(promote(&scratch, "delivery-a", 2)).unwrap();
        let mut edit = save("private-correction", 3);
        edit.id = Some(receipt.note_id.clone());
        edit.expected_version = Some(receipt.note_version);
        let current = store.save(edit).unwrap();
        let mut copy = stage("private-correction", 4);
        copy.task_id = "task-copy".into();
        store.stage(copy).unwrap();
        let erased = store
            .forget(&project(), &current.id, current.version, 5)
            .unwrap();
        assert_eq!(erased.len(), 2);
        assert!(erased
            .iter()
            .all(|n| n.text.is_empty() && n.deleted_at == Some(5)));
        assert!(store.current(&project(), 5).unwrap().is_empty());
        assert!(store
            .scratch(&project(), &scratch.id)
            .unwrap()
            .unwrap()
            .text
            .is_empty());
        let bytes = std::fs::read_to_string(&fixture.disk).unwrap();
        assert!(!bytes.contains("private-original"));
        assert!(!bytes.contains("private-correction"));
        error(
            store.promote(promote(&scratch, "delivery-b", 6)),
            TaskErrorKind::StaleRevision,
        );
        error(
            store.stage(stage("private-original", 6)),
            TaskErrorKind::StaleRevision,
        );
        assert!(fixture.store().current(&project(), 6).unwrap().is_empty());
    }

    // A read must neither create the document nor rewrite existing content.
    #[test]
    fn project_memory_reads_do_not_create_or_rewrite_storage() {
        let fixture = Fixture::new();
        let store = fixture.store();
        assert!(store.list(&project(), 1).unwrap().is_empty());
        assert!(store.current(&project(), 1).unwrap().is_empty());
        assert!(store.scratch(&project(), "missing").unwrap().is_none());
        assert!(!fixture.disk.exists());
        store.save(save("remember", 1)).unwrap();
        let before = std::fs::read(&fixture.disk).unwrap();
        let modified = std::fs::metadata(&fixture.disk)
            .unwrap()
            .modified()
            .unwrap();
        fixture.store().list(&project(), 100).unwrap();
        store.current(&project(), 100).unwrap();
        assert_eq!(std::fs::read(&fixture.disk).unwrap(), before);
        assert_eq!(
            std::fs::metadata(&fixture.disk)
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
    }

    // Delivery IDs are not the durable source dedup key.
    #[test]
    fn project_memory_stage_and_promote_are_idempotent_across_fresh_delivery_ids_and_reopen() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let scratch = store.stage(stage("reviewed observation", 1)).unwrap();
        assert_eq!(
            store.stage(stage("reviewed observation", 2)).unwrap(),
            scratch
        );
        let first = store.promote(promote(&scratch, "delivery-a", 3)).unwrap();
        let before = std::fs::read(&fixture.disk).unwrap();
        assert_eq!(
            store.promote(promote(&scratch, "delivery-a", 4)).unwrap(),
            first
        );
        assert_eq!(std::fs::read(&fixture.disk).unwrap(), before);
        assert_eq!(
            store.promote(promote(&scratch, "delivery-b", 4)).unwrap(),
            first
        );
        let reopened = fixture.store();
        assert_eq!(
            reopened
                .promote(promote(&scratch, "delivery-c", 5))
                .unwrap(),
            first
        );
        assert_eq!(
            reopened
                .promotion_receipt(&project(), "delivery-b", 5)
                .unwrap(),
            Some(first.clone())
        );
        assert_eq!(
            reopened
                .source_receipt(&project(), "task-a", 1, &scratch.id, 5)
                .unwrap(),
            Some(first)
        );
        assert_eq!(reopened.current(&project(), 5).unwrap().len(), 1);
        assert!(reopened
            .scratch(&other_project(), &scratch.id)
            .unwrap()
            .is_none());
    }

    // Rebinding any delivery/source field must not reuse another payload's approval.
    #[test]
    fn project_memory_rejects_promotion_id_rebinding_and_unstored_or_mismatched_sources() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let first = store.stage(stage("first", 1)).unwrap();
        let receipt = store.promote(promote(&first, "delivery", 2)).unwrap();
        let second = store.stage(stage("second", 3)).unwrap();
        error(
            store.promote(promote(&second, "delivery", 4)),
            TaskErrorKind::RequestIdConflict,
        );
        for field in [
            "assistant",
            "run",
            "task",
            "attempt",
            "revision",
            "version",
            "project",
        ] {
            let mut request = promote(&first, "delivery", 4);
            match field {
                "assistant" => request.assistant.assistant_id = "another".into(),
                "run" => request.run_id = "another".into(),
                "task" => request.task_id = "another".into(),
                "attempt" => request.attempt = 2,
                "revision" => request.expected_task_revision = 8,
                "version" => request.expected_version = Some(receipt.note_version),
                _ => request.project = other_project(),
            }
            error(store.promote(request), TaskErrorKind::RequestIdConflict);
        }
        let mut request = promote(&first, "fresh", 5);
        request.scratch_id = "does-not-exist".into();
        error(store.promote(request), TaskErrorKind::NotFound);
        let mut request = promote(&first, "fresh", 5);
        request.run_id = "other-run".into();
        error(store.promote(request), TaskErrorKind::StaleRevision);
        let mut request = promote(&second, "fresh", 5);
        request.expected_version = Some(1);
        error(store.promote(request), TaskErrorKind::InvalidRequest);
    }

    // An existing promotion must not revive after correction, forget or expiration.
    #[test]
    fn project_memory_promotion_retries_reject_stale_notes_and_expired_scratch() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let scratch = store.stage(stage("original", 1)).unwrap();
        let receipt = store.promote(promote(&scratch, "delivery-a", 2)).unwrap();
        let mut correction = save("corrected", 3);
        correction.id = Some(receipt.note_id);
        correction.expected_version = Some(receipt.note_version);
        store.save(correction).unwrap();
        error(
            store.promote(promote(&scratch, "delivery-b", 4)),
            TaskErrorKind::StaleRevision,
        );
        error(
            store.source_receipt(&project(), "task-a", 1, &scratch.id, 4),
            TaskErrorKind::StaleRevision,
        );
        let mut staged = stage("expires", 10);
        staged.task_id = "expiring-task".into();
        let expiring = store.stage(staged.clone()).unwrap();
        assert_eq!(expiring.expires_at, 86_400_010);
        error(
            store.promote(promote(&expiring, "expired", 86_400_010)),
            TaskErrorKind::StaleRevision,
        );
        staged.now = 86_400_011;
        error(store.stage(staged), TaskErrorKind::StaleRevision);
    }

    // Invalid refs and overlong Unicode text must be rejected before persistence.
    #[test]
    fn project_memory_validates_refs_unicode_length_and_expiry() {
        let fixture = Fixture::new();
        let store = fixture.store();
        for bad in ["", " ", "host\n"] {
            let mut request = save("valid", 1);
            request.project.host_id = bad.into();
            error(store.save(request), TaskErrorKind::InvalidRequest);
        }
        for cwd in ["relative", "/a/../b", "/a//b", "/a/./b", "/a/"] {
            let mut request = save("valid", 1);
            request.project.cwd = cwd.into();
            error(store.save(request), TaskErrorKind::InvalidRequest);
        }
        let mut invalid = stage("text", 1);
        invalid.assistant.assistant_id.clear();
        error(store.stage(invalid), TaskErrorKind::InvalidRequest);
        error(store.save(save(" ", 1)), TaskErrorKind::InvalidRequest);
        error(
            store.save(save(&"🦀".repeat(2001), 1)),
            TaskErrorKind::InvalidRequest,
        );
        let note = store.save(save(&"🦀".repeat(2000), 1)).unwrap();
        assert_eq!(note.text.chars().count(), 2000);
        let mut expiring = save("temporary", 2);
        expiring.expires_at = Some(3);
        let expiring = store.save(expiring).unwrap();
        assert!(store
            .current(&project(), 2)
            .unwrap()
            .iter()
            .any(|n| n.id == expiring.id));
        assert!(!store
            .current(&project(), 3)
            .unwrap()
            .iter()
            .any(|n| n.id == expiring.id));
        let mut past = save("already expired", 5);
        past.expires_at = Some(5);
        error(store.save(past), TaskErrorKind::InvalidRequest);
    }

    // Ignoring format versions could overwrite a future document with an older schema.
    #[test]
    fn project_memory_reopen_rejects_unknown_document_version_without_rewrite() {
        let fixture = Fixture::new();
        let original = b"{\"version\":2}";
        std::fs::write(&fixture.disk, original).unwrap();
        error(
            ProjectMemory::open(&fixture.path).map(|_| ()),
            TaskErrorKind::Storage,
        );
        assert_eq!(std::fs::read(&fixture.disk).unwrap(), original);
    }

    // Publishing memory before the write succeeds would make failed writes visible.
    #[test]
    fn project_memory_storage_failure_rolls_back_and_atomic_files_are_private() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let first = store.save(save("persisted", 1)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&fixture.disk)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let original = std::fs::read(&fixture.disk).unwrap();
        std::fs::remove_file(&fixture.disk).unwrap();
        std::fs::create_dir(&fixture.disk).unwrap();
        error(
            store.save(save("must roll back", 2)),
            TaskErrorKind::Storage,
        );
        assert_eq!(store.current(&project(), 3).unwrap(), vec![first]);
        std::fs::remove_dir(&fixture.disk).unwrap();
        std::fs::write(&fixture.disk, original).unwrap();
        assert_eq!(fixture.store().current(&project(), 3).unwrap().len(), 1);
        assert_eq!(std::fs::read_dir(&fixture.dir).unwrap().count(), 1);
    }

    // Without a serialized transaction concurrent updates would lose acknowledged notes.
    #[test]
    fn project_memory_concurrent_writers_preserve_every_acknowledged_record() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let barrier = Arc::new(Barrier::new(9));
        let handles: Vec<_> = (0..8)
            .map(|worker| {
                let store = store.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    for i in 0..8 {
                        store
                            .save(save(&format!("worker {worker} note {i}"), 10))
                            .unwrap();
                    }
                })
            })
            .collect();
        barrier.wait();
        for handle in handles {
            handle.join().unwrap();
        }
        let notes = fixture.store().current(&project(), 11).unwrap();
        assert_eq!(notes.len(), 64);
        let unique: std::collections::BTreeSet<_> = notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(unique.len(), 64);
    }

    // Counts must apply to the selected project and expired notes must release active capacity.
    #[test]
    fn project_memory_note_caps_allow_correction_at_active_limit_but_bound_history() {
        let fixture = Fixture::new();
        let first = fixture.store().save(save("seed", 1)).unwrap();
        let mut document: Document =
            serde_json::from_slice(&std::fs::read(&fixture.disk).unwrap()).unwrap();
        document.notes.clear();
        for index in 1..=500 {
            let mut note = first.clone();
            note.id = format!("project-note-{index}");
            document.notes.insert(note.id.clone(), note);
        }
        document.next_note_id = 500;
        std::fs::write(&fixture.disk, serde_json::to_vec(&document).unwrap()).unwrap();
        let store = fixture.store();
        error(
            store.save(save("beyond active limit", 2)),
            TaskErrorKind::InvalidRequest,
        );
        let mut other = save("other project has capacity", 2);
        other.project = other_project();
        store.save(other).unwrap();
        let mut correction = save("replacement", 2);
        correction.id = Some(first.id.clone());
        correction.expected_version = Some(1);
        store.save(correction).unwrap();
        assert_eq!(store.current(&project(), 2).unwrap().len(), 500);

        // Populate historical tombstones in one fixture write, avoiding thousands of fsyncs.
        let mut document: Document =
            serde_json::from_slice(&std::fs::read(&fixture.disk).unwrap()).unwrap();
        document.notes.clear();
        for index in 1..=5000 {
            let mut note = first.clone();
            note.id = format!("history-{index}");
            note.text.clear();
            note.deleted_at = Some(1);
            document.notes.insert(note.id.clone(), note);
        }
        std::fs::write(&fixture.disk, serde_json::to_vec(&document).unwrap()).unwrap();
        let store = fixture.store();
        error(
            store.save(save("beyond historical limit", 3)),
            TaskErrorKind::InvalidRequest,
        );
        let mut other = save("other project remains independent", 3);
        other.project = other_project();
        store.save(other).unwrap();

        let mut document: Document =
            serde_json::from_slice(&std::fs::read(&fixture.disk).unwrap()).unwrap();
        document.notes.retain(|_, note| note.project != project());
        for index in 1..=500 {
            let mut note = first.clone();
            note.id = format!("expired-{index}");
            note.expires_at = Some(2);
            document.notes.insert(note.id.clone(), note);
        }
        std::fs::write(&fixture.disk, serde_json::to_vec(&document).unwrap()).unwrap();
        let store = fixture.store();
        store
            .save(save("expiry releases active capacity", 3))
            .unwrap();
        assert_eq!(store.current(&project(), 3).unwrap().len(), 1);
        assert_eq!(store.list(&project(), 3).unwrap().len(), 501);
    }

    // Expired scratch must release capacity without refreshing/reusing its old source.
    #[test]
    fn project_memory_scratch_cap_is_project_scoped_and_expiry_releases_capacity() {
        let fixture = Fixture::new();
        let first = fixture.store().stage(stage("seed", 1)).unwrap();
        let mut document: Document =
            serde_json::from_slice(&std::fs::read(&fixture.disk).unwrap()).unwrap();
        document.scratch.clear();
        for index in 0..1000 {
            let mut scratch = first.clone();
            scratch.id = format!("scratch-seed-{index}");
            document.scratch.insert(scratch.id.clone(), scratch);
        }
        std::fs::write(&fixture.disk, serde_json::to_vec(&document).unwrap()).unwrap();
        let store = fixture.store();
        error(
            store.stage(stage("beyond scratch limit", 2)),
            TaskErrorKind::InvalidRequest,
        );
        let mut other = stage("other project scratch", 2);
        other.project = other_project();
        store.stage(other).unwrap();
        let released = store
            .stage(stage("expiry releases scratch capacity", 86_400_001))
            .unwrap();
        assert_eq!(released.created_at, 86_400_001);
        let mut revision = stage("expiry releases scratch capacity", 86_400_002);
        revision.expected_task_revision = 6;
        error(store.stage(revision), TaskErrorKind::StaleRevision);

        let mut document: Document =
            serde_json::from_slice(&std::fs::read(&fixture.disk).unwrap()).unwrap();
        document
            .scratch
            .retain(|_, scratch| scratch.project != project());
        for index in 0..5000 {
            let mut scratch = first.clone();
            scratch.id = format!("forgotten-scratch-{index}");
            scratch.text.clear();
            scratch.deleted_at = Some(2);
            document.scratch.insert(scratch.id.clone(), scratch);
        }
        std::fs::write(&fixture.disk, serde_json::to_vec(&document).unwrap()).unwrap();
        let store = fixture.store();
        error(
            store.stage(stage("beyond retained scratch history", 3)),
            TaskErrorKind::InvalidRequest,
        );
        let mut other = stage("other project still has historical capacity", 3);
        other.project = other_project();
        store.stage(other).unwrap();
    }

    // Fresh delivery retries must not turn a source receipt into an unbounded index.
    #[test]
    fn project_memory_delivery_cap_preserves_existing_receipts_and_rejects_new_ids() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let scratch = store.stage(stage("observation", 1)).unwrap();
        let receipt = store.promote(promote(&scratch, "delivery-0", 2)).unwrap();
        let mut document: Document =
            serde_json::from_slice(&std::fs::read(&fixture.disk).unwrap()).unwrap();
        let binding = document.delivery_ids["delivery-0"].clone();
        for index in 1..10000 {
            document
                .delivery_ids
                .insert(format!("delivery-{index}"), binding.clone());
        }
        std::fs::write(&fixture.disk, serde_json::to_vec(&document).unwrap()).unwrap();
        let store = fixture.store();
        let before = std::fs::read(&fixture.disk).unwrap();
        assert_eq!(
            store.promote(promote(&scratch, "delivery-0", 3)).unwrap(),
            receipt
        );
        assert_eq!(
            store
                .promotion_receipt(&project(), "delivery-9999", 3)
                .unwrap(),
            Some(receipt)
        );
        error(
            store.promote(promote(&scratch, "new-delivery", 3)),
            TaskErrorKind::InvalidRequest,
        );
        assert_eq!(std::fs::read(&fixture.disk).unwrap(), before);
        let mut other = stage("independent source", 3);
        other.project = other_project();
        let other = store.stage(other).unwrap();
        store
            .promote(promote(&other, "other-project-delivery", 4))
            .unwrap();
    }

    // One expected version can authorize at most one simultaneous correction.
    #[test]
    fn project_memory_racing_corrections_and_promotion_retries_are_serialized() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let first = store.save(save("original", 1)).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let handles: Vec<_> = ["replacement-a", "replacement-b"]
            .into_iter()
            .map(|text| {
                let store = store.clone();
                let barrier = barrier.clone();
                let id = first.id.clone();
                std::thread::spawn(move || {
                    let mut request = save(text, 2);
                    request.id = Some(id);
                    request.expected_version = Some(1);
                    barrier.wait();
                    store.save(request)
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| result
                    .as_ref()
                    .is_err_and(|e| e.kind == TaskErrorKind::StaleRevision))
                .count(),
            1
        );
        let scratch = store.stage(stage("one promoted note", 3)).unwrap();
        let barrier = Arc::new(Barrier::new(9));
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let store = store.clone();
                let barrier = barrier.clone();
                let scratch = scratch.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store
                        .promote(promote(&scratch, &format!("racing-{index}"), 4))
                        .unwrap()
                })
            })
            .collect();
        barrier.wait();
        let receipts: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(receipts.iter().all(|receipt| receipt == &receipts[0]));
        assert_eq!(fixture.store().current(&project(), 5).unwrap().len(), 2);
    }

    // Optional timestamps/provenance must match the inspector's absent-field wire contract.
    #[test]
    fn project_memory_json_omits_absent_metadata_but_keeps_explicit_human_author() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let mut request = save("human note", 1);
        request.author = None;
        let note = store.save(request).unwrap();
        let value = serde_json::to_value(note).unwrap();
        assert_eq!(value["author"], serde_json::Value::Null);
        for key in ["expiresAt", "supersededBy", "deletedAt"] {
            assert!(value.get(key).is_none(), "unexpected {key}");
        }
        assert_eq!(value["source"], serde_json::json!({}));
        let scratch = store.stage(stage("scratch", 1)).unwrap();
        assert!(serde_json::to_value(scratch)
            .unwrap()
            .get("deletedAt")
            .is_none());
    }

    // Accepting a task may advance its revision; explicit re-review can update
    // the pending review revision without changing already captured evidence.
    #[test]
    fn project_memory_explicit_scratch_rereview_preserves_evidence_and_prior_receipts() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let captured = store.stage(stage("captured result", 10)).unwrap();
        let old_promotion = promote(&captured, "old-review", 21);
        let mut review = stage("captured result", 20);
        review.expected_task_revision = 8;
        let reviewed = store.stage(review.clone()).unwrap();
        assert_eq!(reviewed.id, captured.id);
        assert_eq!(reviewed.expected_task_revision, 8);
        let original_json = serde_json::to_value(&captured).unwrap();
        let reviewed_json = serde_json::to_value(&reviewed).unwrap();
        assert_eq!(original_json["capturedTaskRevision"], 7);
        assert_eq!(reviewed_json["capturedTaskRevision"], 7);
        for key in [
            "id",
            "project",
            "assistant",
            "taskId",
            "attempt",
            "runId",
            "text",
            "kind",
            "createdAt",
            "expiresAt",
        ] {
            assert_eq!(
                reviewed_json[key], original_json[key],
                "evidence changed: {key}"
            );
        }
        assert_eq!(reviewed.created_at, 10);
        assert_eq!(reviewed.expires_at, 86_400_010);
        let persisted = std::fs::read(&fixture.disk).unwrap();
        assert_eq!(store.stage(review.clone()).unwrap(), reviewed);
        assert_eq!(std::fs::read(&fixture.disk).unwrap(), persisted);
        assert_eq!(
            fixture.store().scratch(&project(), &captured.id).unwrap(),
            Some(reviewed.clone())
        );
        error(store.promote(old_promotion), TaskErrorKind::StaleRevision);
        let receipt = store
            .promote(promote(&reviewed, "reviewed-delivery", 22))
            .unwrap();
        assert_eq!(store.current(&project(), 22).unwrap().len(), 1);
        assert_eq!(receipt.expected_task_revision, 8);

        // Re-review after promotion cannot replace or invalidate the original receipt.
        let before = std::fs::read(&fixture.disk).unwrap();
        review.expected_task_revision = 9;
        review.now = 23;
        let rejected = store.stage(review.clone()).unwrap_err();
        assert_eq!(rejected.kind, TaskErrorKind::StaleRevision);
        assert!(rejected.message.contains("already promoted"));
        assert_eq!(std::fs::read(&fixture.disk).unwrap(), before);
        assert_eq!(
            store
                .promote(promote(&reviewed, "reviewed-delivery", 24))
                .unwrap(),
            receipt
        );
        assert_eq!(
            store
                .promote(promote(&reviewed, "fresh-delivery", 24))
                .unwrap(),
            receipt
        );
        assert_eq!(
            store
                .promotion_receipt(&project(), "reviewed-delivery", 24)
                .unwrap(),
            Some(receipt.clone())
        );
        assert_eq!(store.current(&project(), 24).unwrap().len(), 1);
        let note = store.current(&project(), 24).unwrap().pop().unwrap();
        store
            .forget(&project(), &note.id, note.version, 25)
            .unwrap();
        review.now = 26;
        error(store.stage(review), TaskErrorKind::StaleRevision);
        let erased = store.scratch(&project(), &captured.id).unwrap().unwrap();
        assert!(erased.text.is_empty());
        assert_eq!(erased.expected_task_revision, 8);
        assert_eq!(erased.expires_at, 86_400_010);
    }

    // Neither a lower revision nor re-review at the original expiration can
    // make a pending source current or extend its lifetime.
    #[test]
    fn project_memory_scratch_rereview_rejects_lower_revision_and_expiry_without_refresh() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let captured = store.stage(stage("pending result", 10)).unwrap();
        let mut request = stage("pending result", 20);
        request.expected_task_revision = 8;
        let reviewed = store.stage(request.clone()).unwrap();
        let before = std::fs::read(&fixture.disk).unwrap();
        request.expected_task_revision = 7;
        error(store.stage(request.clone()), TaskErrorKind::StaleRevision);
        request.expected_task_revision = 9;
        request.now = 86_400_010;
        error(store.stage(request), TaskErrorKind::StaleRevision);
        assert_eq!(std::fs::read(&fixture.disk).unwrap(), before);
        let unchanged = store.scratch(&project(), &captured.id).unwrap().unwrap();
        assert_eq!(unchanged, reviewed);
        assert_eq!(unchanged.created_at, 10);
        assert_eq!(unchanged.expires_at, 86_400_010);
    }

    // Previously persisted v1 scratch records have no capture-revision field.
    #[test]
    fn project_memory_scratch_legacy_capture_revision_has_a_serde_default() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let captured = store.stage(stage("legacy result", 10)).unwrap();
        let mut json = serde_json::to_value(&captured).unwrap();
        json.as_object_mut().unwrap().remove("capturedTaskRevision");
        let restored: ProjectScratch = serde_json::from_value(json).unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap()["capturedTaskRevision"],
            0
        );
    }
}
