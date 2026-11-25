//! Durable, user-requested GitHub merges. Only the worker submits a merge.
use crate::authority_file::VersionedDocument;
use crate::git_changes::{git, run, State};
use apex_core::{Backend, ParticipantConfig};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ThreadGitAction {
    /// From the thread folder's Git panel, which shows that folder's state.
    Push { expected: State },
    RequestMerge { expected: State },
    /// From the decision card: merge only if the checks still pass right now.
    MergeReady { expected: WorkflowKey },
    /// From the decision card: send a check that failed before any merge to the builder.
    FixChecks { expected: WorkflowKey },
    CancelMerge { expected: WorkflowKey },
    AskFix { expected: WorkflowKey },
}

/// The merge request a card acts on, read from the card the person saw.
/// Its folder may be a task folder, not the thread's own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct WorkflowKey {
    pub root: String,
    pub branch: String,
    pub repo: String,
    pub head: String,
    pub generation: u64,
}
impl WorkflowKey {
    pub fn of(w: &Workflow) -> Self {
        Self { root: w.root.clone(), branch: w.branch.clone(), repo: w.repo.clone(), head: w.head.clone(), generation: w.generation }
    }
    /// The same commit, folder and repository (any merge generation).
    pub(crate) fn names_commit(&self, w: &Workflow) -> bool {
        self.head == w.head && self.repo == w.repo && self.branch == w.branch && self.root == w.root
    }
    pub(crate) fn matches(&self, w: &Workflow) -> bool {
        self.names_commit(w) && self.generation == w.generation
    }
}

/// The receipt line ending an agent's reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Marker {
    /// `Deck built <sha>`: the builder's commit, merged with the person's tap.
    Built,
    /// `Deck review passed <sha>`: another agent reviewed that commit.
    ReviewPassed,
    /// `Deck ship <sha>`: the builder's commit, merged by Deck when the person said "ship it".
    Ship,
}

/// What a receipt did to the thread's merge workflow.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordOutcome {
    Recorded,
    /// Not this folder's commit, or not a receipt at all.
    Ignored,
    /// Another builder's merge is in flight; nothing changed.
    BusyOther { other: String },
}

/// Why the Mac's main folder wasn't fast-forwarded after a merge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Deferral {
    /// Local changes (or untracked files) there that the merge also touches.
    Files(Vec<String>),
    Reason(String),
}
impl std::fmt::Display for Deferral {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Deferral::Files(files) => write!(f, "these files on your Mac have changes the merge also touches: {}", files.join(", ")),
            Deferral::Reason(why) => write!(f, "{}", why.trim_end().trim_end_matches('.')),
        }
    }
}
impl From<String> for Deferral {
    fn from(why: String) -> Self {
        Deferral::Reason(why)
    }
}
impl From<&str> for Deferral {
    fn from(why: &str) -> Self {
        Deferral::Reason(why.into())
    }
}

/// What a Cancel tap did: `cancelled` only when this tap moved the merge into cancelling.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CancelOutcome {
    pub detail: String,
    pub cancelled: bool,
    pub pr: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Syncing,
    Ready,
    Preparing,
    Checks,
    Submitting,
    Cancelling,
    Cancelled,
    Failed,
    Blocked,
    Merged,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Workflow {
    pub root: String,
    pub branch: String,
    pub repo: String,
    pub head: String,
    pub builder: String,
    builder_model: String,
    pub reviewer: Option<String>,
    pub phase: Phase,
    pub generation: u64,
    pub pr: Option<u64>,
    pub detail: String,
    #[serde(default)]
    pub result_oid: Option<String>,
    pub pushed: bool,
    pub fix_requested: bool,
    /// Asked for from the decision card, where the checks had already passed:
    /// if they no longer do, the merge stops and nothing waits.
    #[serde(default)]
    ready_only: bool,
}

/// What GitHub says about the reviewed commit before any merge is asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Checks {
    /// No pull request, no required checks on main, or GitHub could not be asked.
    Unknown(String),
    Running,
    Passed { pr: u64 },
    Failed { pr: u64, detail: String },
}
impl Workflow {
    pub(crate) fn pending(&self) -> bool {
        matches!(
            self.phase,
            Phase::Preparing
                | Phase::Checks
                | Phase::Submitting
                | Phase::Cancelling
                | Phase::Syncing
        )
    }
    pub(crate) fn matches(&self, state: &State) -> bool {
        self.head == state.head
            && self.root == state.root
            && state.branch.as_ref() == Some(&self.branch)
    }
    fn request(&mut self) -> Result<(), String> {
        if self.pending() || self.phase == Phase::Merged {
            return Ok(());
        }
        if !matches!(self.phase, Phase::Ready | Phase::Cancelled) {
            return Err(self.detail.clone());
        }
        self.generation += 1;
        self.phase = Phase::Preparing;
        self.detail = "Publishing the commit…".into();
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Ledger {
    version: u32,
    rooms: BTreeMap<String, Workflow>,
}
impl VersionedDocument for Ledger {}
pub struct ThreadGit {
    path: PathBuf,
    cache: Mutex<Option<Ledger>>,
}
impl ThreadGit {
    pub fn new(data: &Path) -> Self {
        Self {
            path: data.join("thread-git-v1.json"),
            cache: Mutex::new(None),
        }
    }
    fn edit<T>(
        &self,
        f: impl FnOnce(&mut BTreeMap<String, Workflow>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
        if cache.is_none() {
            *cache = Some(
                Ledger::read_optional(&self.path)
                    .map_err(|e| e.to_string())?
                    .unwrap_or_else(|| Ledger {
                        version: 1,
                        rooms: Default::default(),
                    }),
            );
        }
        let current = cache.as_ref().unwrap();
        let mut next = current.clone();
        let result = f(&mut next.rooms)?;
        if current.rooms != next.rooms {
            if let Err(e) = next.write_to(&self.path) {
                *cache = None;
                return Err(e.to_string());
            }
            *cache = Some(next);
        }
        Ok(result)
    }
    pub fn get(&self, room: &str) -> Result<Option<Workflow>, String> {
        self.edit(|r| Ok(r.get(room).cloned()))
    }
    pub fn pending(&self) -> Result<Vec<(String, Workflow)>, String> {
        self.edit(|r| {
            Ok(r.iter()
                .filter(|(_, w)| w.pending())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect())
        })
    }
    // Every async result compares its complete starting state before applying.
    fn update(
        &self,
        room: &str,
        prior: &Workflow,
        f: impl FnOnce(&mut Workflow),
    ) -> Result<bool, String> {
        self.edit(|r| {
            let Some(w) = r.get_mut(room) else {
                return Ok(false);
            };
            if w != prior {
                return Ok(false);
            }
            f(w);
            Ok(true)
        })
    }
    /// A receipt line from `by`, read in `cwd`: the folder whose HEAD it names.
    pub fn record(
        &self,
        room: &str,
        data: &Path,
        cwd: &Path,
        by: &ParticipantConfig,
        text: &str,
    ) -> Result<RecordOutcome, String> {
        let Some((kind, sha)) = marker(text) else {
            return Ok(RecordOutcome::Ignored);
        };
        let builder = kind != Marker::ReviewPassed;
        // The tool's default model has no name; models are compared only when both have one.
        let model = match &by.backend {
            Backend::Agent { model: Some(m), .. } | Backend::OpenAiCompatible { model: m, .. } => m.trim().to_ascii_lowercase(),
            _ => String::new(),
        };
        let read = |args: &[&str]| git(data, cwd, None, args).map(|s| s.trim().to_owned());
        if read(&["rev-parse", "HEAD"])? != sha {
            return Ok(RecordOutcome::Ignored);
        }
        let branch = read(&["symbolic-ref", "--short", "HEAD"])?;
        if branch == "main" || branch == "master" {
            return Ok(RecordOutcome::Ignored);
        }
        let root = read(&["rev-parse", "--show-toplevel"])?;
        let repo = repository(&read(&["remote", "get-url", "--push", "origin"])?)?;
        self.edit(|r| {
            let current = r.get(room);
            let same = current.is_some_and(|w| {
                w.head == sha && w.repo == repo && w.branch == branch && w.root == root
            });
            if builder {
                if let Some(w) = current {
                    // One merge per thread: another builder's waits until it lands.
                    if w.pending() && !w.builder.is_empty() && w.builder != by.id.as_str() {
                        return Ok(RecordOutcome::BusyOther { other: w.builder.clone() });
                    }
                    if same {
                        return Ok(RecordOutcome::Recorded);
                    }
                    // While GitHub confirms a merge or a cancel, nothing replaces it.
                    if matches!(w.phase, Phase::Submitting | Phase::Cancelling | Phase::Syncing) {
                        return Err("The previous merge is still reconciling.".into());
                    }
                }
                r.insert(
                    room.into(),
                    Workflow {
                        root,
                        branch,
                        repo,
                        head: sha.into(),
                        builder: by.id.to_string(),
                        builder_model: model,
                        reviewer: None,
                        result_oid: None,
                        phase: Phase::Ready,
                        generation: 0,
                        pr: None,
                        detail: "Waiting for checks".into(),
                        pushed: false,
                        fix_requested: false,
                        ready_only: false,
                    },
                );
            } else if same {
                let w = r.get_mut(room).unwrap();
                let other_model = w.builder_model.is_empty() || model.is_empty() || w.builder_model != model;
                if !w.pending() && w.phase != Phase::Merged && w.builder != by.id.as_str() && other_model {
                    w.reviewer = Some(by.id.to_string());
                    w.detail = format!("Review passed for {}.", &sha[..8]);
                }
            }
            Ok(RecordOutcome::Recorded)
        })
    }
    /// From the thread folder's Git panel.
    pub fn admit(&self, room: &str, expected: &WorkflowKey) -> Result<String, String> {
        self.admit_with(room, expected, false)
    }
    /// A merge asked for from the decision card, after its checks passed.
    pub fn admit_ready(&self, room: &str, expected: &WorkflowKey) -> Result<String, String> {
        self.admit_with(room, expected, true)
    }
    fn admit_with(&self, room: &str, expected: &WorkflowKey, ready_only: bool) -> Result<String, String> {
        self.edit(|rooms| {
            let w = rooms
                .get_mut(room)
                .ok_or("Waiting for the builder’s commit.")?;
            if !expected.names_commit(w) {
                return Err("The branch changed. Refresh the thread.".into());
            }
            // A second tap on a merge already in flight shares it.
            if w.generation != expected.generation && !w.pending() && w.phase != Phase::Merged {
                return Err("Refresh the current branch before merging.".into());
            }
            let before = w.generation;
            w.request()?;
            if w.generation != before {
                w.ready_only = ready_only;
            }
            Ok(w.detail.clone())
        })
    }
    /// `Deck ship`: the builder's receipt for `sha` was just recorded; ask for
    /// the merge as RequestMerge does. Never reads the folder.
    pub fn ship(&self, room: &str, builder: &str, sha: &str) -> Result<String, String> {
        self.edit(|rooms| {
            let w = rooms
                .get_mut(room)
                .filter(|w| w.head == sha && w.builder == builder)
                .ok_or("The shipped commit is no longer this thread's merge request.")?;
            let before = w.generation;
            w.request()?;
            if w.generation != before {
                w.ready_only = false;
            }
            Ok(w.detail.clone())
        })
    }
    /// Cancel moves a merge that is still being prepared, waiting for checks or
    /// being submitted into cancelling. A merge already landing, or a second
    /// tap, changes nothing.
    pub fn cancel(&self, room: &str, expected: &WorkflowKey) -> Result<CancelOutcome, String> {
        self.edit(|rooms| {
            let w = rooms
                .get_mut(room)
                .ok_or("Waiting for the builder’s commit.")?;
            if !expected.names_commit(w) {
                return Err("The branch changed. Refresh the thread.".into());
            }
            if w.generation != expected.generation {
                return Err("This is a different merge request.".into());
            }
            let cancelled = matches!(w.phase, Phase::Preparing | Phase::Checks | Phase::Submitting);
            if cancelled {
                w.phase = Phase::Cancelling;
                w.detail = "Confirming cancellation with GitHub…".into();
            }
            Ok(CancelOutcome { detail: w.detail.clone(), cancelled, pr: w.pr })
        })
    }
    #[cfg(test)]
    pub(crate) fn put(&self, room: &str, w: Workflow) -> Result<(), String> {
        self.edit(|rooms| {
            rooms.insert(room.into(), w);
            Ok(())
        })
    }
    pub fn pushed(&self, room: &str, state: &State) -> Result<(), String> {
        self.edit(|r| {
            if let Some(w) = r.get_mut(room).filter(|w| w.matches(state)) {
                w.pushed = true;
            }
            Ok(())
        })
    }
    pub fn fix(&self, room: &str, expected: &WorkflowKey) -> Result<Workflow, String> {
        self.get(room)?
            .filter(|w| expected.matches(w) && w.phase == Phase::Failed)
            .ok_or_else(|| "The failed check has changed.".into())
    }
    pub fn mark_fix(&self, room: &str, w: &Workflow) -> Result<bool, String> {
        self.update(room, w, |j| j.fix_requested = true)
    }
}
pub fn marker(text: &str) -> Option<(Marker, &str)> {
    let line = text.trim_end().lines().last()?;
    let (kind, sha) = [("Deck built ", Marker::Built), ("Deck ship ", Marker::Ship), ("Deck review passed ", Marker::ReviewPassed)]
        .into_iter()
        .find_map(|(prefix, kind)| line.strip_prefix(prefix).map(|sha| (kind, sha)))?;
    (sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())).then_some((kind, sha))
}
pub(crate) fn repository(url: &str) -> Result<String, String> {
    let slug = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .unwrap_or("");
    let slug = slug.strip_suffix(".git").unwrap_or(slug);
    if slug.split('/').count() != 2
        || !slug.split('/').all(|p| {
            !p.is_empty()
                && p != ".."
                && p != "."
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err("Origin must name a GitHub repository.".into());
    }
    Ok(slug.into())
}
pub async fn push(data: &Path, state: &State) -> Result<(), String> {
    let branch = state
        .branch
        .as_deref()
        .ok_or("Check out the task branch.")?;
    if branch == "main" || branch == "master" || state.ahead == 0 {
        return Err("No task branch commits to push.".into());
    }
    let cwd = Path::new(&state.root);
    let url = run(data, cwd, "git", &["remote", "get-url", "--push", "origin"]).await?;
    if Some(repository(&url)?) != state.origin_repo {
        return Err("Origin changed. Refresh before pushing.".into());
    }
    run(
        data,
        cwd,
        "git",
        &["push", &url, &format!("{}:refs/heads/{branch}", state.head)],
    )
    .await?;
    Ok(())
}

mod github;
pub(crate) mod ship;
pub use github::checks;
#[cfg(test)]
pub(crate) use github::fake_checks;
#[cfg(test)]
mod tests;
