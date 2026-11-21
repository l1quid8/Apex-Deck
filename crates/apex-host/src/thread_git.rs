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
    Push { expected: State },
    RequestMerge { expected: State },
    CancelMerge { expected: State },
    AskFix { expected: State },
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
}
impl Workflow {
    fn pending(&self) -> bool {
        matches!(
            self.phase,
            Phase::Preparing
                | Phase::Checks
                | Phase::Submitting
                | Phase::Cancelling
                | Phase::Syncing
        )
    }
    fn matches(&self, state: &State) -> bool {
        self.head == state.head
            && self.root == state.root
            && state.branch.as_ref() == Some(&self.branch)
    }
    fn request(&mut self) -> Result<(), String> {
        if self.reviewer.is_none() {
            return Err("Waiting for a different model’s review.".into());
        }
        if self.pending() || self.phase == Phase::Merged {
            return Ok(());
        }
        if !matches!(self.phase, Phase::Ready | Phase::Cancelled) {
            return Err(self.detail.clone());
        }
        self.generation += 1;
        self.phase = Phase::Preparing;
        self.detail = "Publishing the reviewed commit…".into();
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
    pub fn record(
        &self,
        room: &str,
        data: &Path,
        cwd: &Path,
        by: &ParticipantConfig,
        text: &str,
    ) -> Result<(), String> {
        let Some((builder, sha)) = marker(text) else {
            return Ok(());
        };
        let model = match &by.backend {
            Backend::Agent { model: Some(m), .. } | Backend::OpenAiCompatible { model: m, .. }
                if !m.trim().is_empty() =>
            {
                m.trim().to_ascii_lowercase()
            }
            _ => return Err("A named model is required to record a Git review.".into()),
        };
        let read = |args: &[&str]| git(data, cwd, None, args).map(|s| s.trim().to_owned());
        if read(&["rev-parse", "HEAD"])? != sha {
            return Ok(());
        }
        let branch = read(&["symbolic-ref", "--short", "HEAD"])?;
        if branch == "main" || branch == "master" {
            return Ok(());
        }
        let root = read(&["rev-parse", "--show-toplevel"])?;
        let repo = repository(&read(&["remote", "get-url", "--push", "origin"])?)?;
        self.edit(|r| {
            let same = r.get(room).is_some_and(|w| {
                w.head == sha && w.repo == repo && w.branch == branch && w.root == root
            });
            if builder && !same {
                if r.get(room).is_some_and(|w| {
                    matches!(
                        w.phase,
                        Phase::Submitting | Phase::Cancelling | Phase::Syncing
                    )
                }) {
                    return Err("The previous merge is still reconciling.".into());
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
                        detail: "Waiting for review".into(),
                        pushed: false,
                        fix_requested: false,
                    },
                );
            } else if !builder && same {
                let w = r.get_mut(room).unwrap();
                if w.phase == Phase::Ready
                    && w.builder != by.id.as_str()
                    && w.builder_model != model
                {
                    w.reviewer = Some(by.id.to_string());
                    w.detail = format!("Review passed for {}.", &sha[..8]);
                }
            }
            Ok(())
        })
    }
    pub fn admit(&self, room: &str, expected: &State, cancel: bool) -> Result<String, String> {
        self.edit(|rooms| {
            let w = rooms
                .get_mut(room)
                .ok_or("Waiting for the builder’s commit.")?;
            let shown = expected
                .workflow
                .as_ref()
                .ok_or("Refresh the Git actions.")?;
            if w.head != shown.head
                || w.repo != shown.repo
                || w.branch != shown.branch
                || w.root != shown.root
            {
                return Err("The branch changed. Refresh the thread.".into());
            }
            if cancel {
                if w.generation != shown.generation {
                    return Err("This is a different merge request.".into());
                }
                if w.phase == Phase::Syncing {
                    return Ok(w.detail.clone());
                }
                if w.pending() {
                    w.phase = Phase::Cancelling;
                    w.detail = "Confirming cancellation with GitHub…".into();
                }
            } else {
                if !w.matches(expected)
                    || (w.generation != shown.generation
                        && !w.pending()
                        && w.phase != Phase::Merged)
                {
                    return Err("Refresh the current branch before merging.".into());
                }
                w.request()?;
            }
            Ok(w.detail.clone())
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
    pub fn fix(&self, room: &str, state: &State) -> Result<Workflow, String> {
        self.get(room)?
            .filter(|w| w.matches(state) && w.phase == Phase::Failed)
            .ok_or_else(|| "The failed check has changed.".into())
    }
    pub fn mark_fix(&self, room: &str, w: &Workflow) -> Result<bool, String> {
        self.update(room, w, |j| j.fix_requested = true)
    }
}
pub fn marker(text: &str) -> Option<(bool, &str)> {
    let line = text.trim_end().lines().last()?;
    let (builder, sha) = line
        .strip_prefix("Deck built ")
        .map(|s| (true, s))
        .or_else(|| line.strip_prefix("Deck review passed ").map(|s| (false, s)))?;
    (sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())).then_some((builder, sha))
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
#[cfg(test)]
mod tests;
