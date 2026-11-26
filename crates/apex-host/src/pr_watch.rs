//! Pull request observations, wake decisions, and their saved per-thread budget.

use crate::authority_file::VersionedDocument;
use crate::thread_git::Workflow;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub const MAX_WAKES: u8 = 3;
pub const EVERY: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seen {
    pub pr: Option<u64>,
    pub branch: String,
    pub woken: Vec<String>,
    pub wakes: u8,
    pub gave_up_at: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Observation {
    Running,
    Passed,
    LocalCheckFailed {
        head: String,
        detail: String,
    },
    Failed {
        head: String,
        names: Vec<String>,
        url: String,
    },
    Conflict {
        head: String,
    },
    Merged {
        oid: String,
        head: String,
    },
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerState {
    Ready,
    Busy,
    CannotTurn,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    Nothing,
    Wake { key: String, note: String },
    NoteOnly { key: String, note: String },
    Sync { oid: String, head: String },
    Close,
    GiveUp { note: String },
}

/// Decide what to do about one thread's PR, using its actual head from GitHub.
pub fn next(
    w: &Workflow,
    seen: &Seen,
    now: &Observation,
    owner: OwnerState,
    person_wrote_since: bool,
) -> Act {
    match now {
        Observation::Merged { oid, head } => {
            return Act::Sync {
                oid: oid.clone(),
                head: head.clone(),
            };
        }
        Observation::Closed => return Act::Close,
        Observation::Running | Observation::Passed => return Act::Nothing,
        _ => {}
    }
    if owner == OwnerState::Busy {
        return Act::Nothing;
    }

    let (key, note, failure, instruction) = match now {
        Observation::LocalCheckFailed { head, detail } => (
            format!("{head}:local_check"),
            format!(
                "Automatic check: local type check failed on {} ({}).\n{detail}",
                w.branch,
                short(head)
            ),
            "local type check".to_owned(),
            format!("\n@{}, fix it and push", w.builder),
        ),
        Observation::Failed { head, names, url } => {
            let Some(pr) = w.pr else { return Act::Nothing };
            let names = names.join(", ");
            (
                format!("{head}:failed"),
                format!(
                    "Automatic check: {names} failed on PR #{pr} ({}). {url}",
                    short(head)
                ),
                names,
                format!("\n@{}, fix it and push", w.builder),
            )
        }
        Observation::Conflict { head } => {
            let Some(pr) = w.pr else { return Act::Nothing };
            (
                format!("{head}:conflict"),
                format!("Automatic check: PR #{pr} now conflicts with main."),
                "conflicts with main".to_owned(),
                format!(
                    " @{}, merge main into {}, fix the conflicts and push",
                    w.builder, w.branch
                ),
            )
        }
        _ => unreachable!(),
    };
    if seen.woken.contains(&key) {
        return Act::Nothing;
    }
    if owner == OwnerState::CannotTurn {
        return Act::NoteOnly { key, note };
    }
    if seen.gave_up_at.is_some() {
        if !person_wrote_since {
            return Act::Nothing;
        }
    } else if seen.wakes >= MAX_WAKES {
        let target =
            w.pr.map_or_else(|| w.branch.clone(), |pr| format!("PR #{pr}"));
        return Act::GiveUp {
            note: format!(
                "Stopped fixing {target} automatically after {MAX_WAKES} tries. The last failure: {failure}. Over to you."
            ),
        };
    }

    Act::Wake {
        key,
        note: format!(
            "{note}{instruction}, then end your reply with your Deck ship or Deck built line for the new commit, as before."
        ),
    }
}

fn short(head: &str) -> String {
    head.chars().take(7).collect()
}

#[derive(Serialize, Deserialize)]
struct Ledger {
    version: u32,
    rooms: BTreeMap<String, Seen>,
}

impl VersionedDocument for Ledger {}

#[derive(Default)]
struct Cache {
    ledger: Option<Ledger>,
    unflushed: bool,
}

pub struct PrWatch {
    path: PathBuf,
    cache: Mutex<Cache>,
}

impl PrWatch {
    pub fn load(data: &Path) -> Self {
        Self {
            path: data.join("pr-watch-v1.json"),
            cache: Mutex::new(Cache::default()),
        }
    }

    pub fn seen(&self, room: &str, w: &Workflow) -> Result<Seen, String> {
        let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
        self.flush(&mut cache)?;
        let ledger = self.ledger(&mut cache)?;
        let mut seen = ledger.rooms.get(room).cloned().unwrap_or_default();
        // The first PR opened for a task inherits any local typecheck wakes.
        if seen.branch != w.branch || matches!((seen.pr, w.pr), (Some(a), Some(b)) if a != b) {
            seen = Seen {
                branch: w.branch.clone(),
                ..Seen::default()
            };
        }
        seen.pr = w.pr.or(seen.pr);
        Ok(seen)
    }

    /// Apply the ledger change only after the corresponding effect succeeded.
    pub fn record(
        &self,
        room: &str,
        mut seen: Seen,
        act: &Act,
        person_wrote_since: bool,
        seq: usize,
    ) -> Result<(), String> {
        if person_wrote_since && seen.gave_up_at.take().is_some() {
            seen.wakes = 0;
        }
        match act {
            Act::Wake { key, .. } => {
                seen.wakes += 1;
                seen.woken.push(key.clone());
            }
            Act::NoteOnly { key, .. } => seen.woken.push(key.clone()),
            Act::GiveUp { .. } => seen.gave_up_at = Some(seq),
            Act::Nothing | Act::Sync { .. } | Act::Close => return Ok(()),
        }

        let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
        let ledger = self.ledger(&mut cache)?;
        ledger.rooms.insert(room.to_owned(), seen);
        // The turn or note already happened. Keep its budget in memory if the
        // write fails, and flush it before another observation can act.
        cache.unflushed = true;
        self.flush(&mut cache)
    }

    fn ledger<'a>(&self, cache: &'a mut Cache) -> Result<&'a mut Ledger, String> {
        if cache.ledger.is_none() {
            cache.ledger = Some(
                Ledger::read_optional(&self.path)
                    .map_err(|e| e.to_string())?
                    .unwrap_or_else(|| Ledger {
                        version: 1,
                        rooms: BTreeMap::new(),
                    }),
            );
        }
        Ok(cache.ledger.as_mut().unwrap())
    }

    fn flush(&self, cache: &mut Cache) -> Result<(), String> {
        if cache.unflushed {
            cache
                .ledger
                .as_ref()
                .unwrap()
                .write_to(&self.path)
                .map_err(|e| e.to_string())?;
            cache.unflushed = false;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_process::TestDataDir;

    fn workflow() -> Workflow {
        serde_json::from_value(serde_json::json!({
            "root": "/work", "branch": "feat/example", "repo": "org/project",
            "head": "receipt-head", "builder": "builder", "builder_model": "model",
            "phase": "failed", "generation": 1, "pr": 7, "detail": "",
            "pushed": true, "fix_requested": false
        }))
        .unwrap()
    }

    fn failure(head: &str) -> Observation {
        Observation::Failed {
            head: head.into(),
            names: vec!["linux".into(), "windows".into()],
            url: "https://github.com/org/project/pull/7/checks".into(),
        }
    }

    #[test]
    fn a_failed_check_wakes_once_per_head_and_lists_the_failing_shards() {
        let w = workflow();
        let dir = TestDataDir::new();
        let state = PrWatch::load(dir.path());
        let seen = state.seen("room", &w).unwrap();
        let act = next(&w, &seen, &failure("new-head"), OwnerState::Ready, false);
        assert!(matches!(&act, Act::Wake { key, note }
            if key == "new-head:failed" && note.contains("linux, windows failed")));
        state.record("room", seen, &act, false, 1).unwrap();
        let seen = PrWatch::load(dir.path()).seen("room", &w).unwrap();
        let another_shard = Observation::Failed {
            head: "new-head".into(),
            names: vec!["mac".into()],
            url: String::new(),
        };
        assert_eq!(
            next(&w, &seen, &another_shard, OwnerState::Ready, false),
            Act::Nothing
        );
        assert!(
            matches!(next(&w, &seen, &failure("second-head"), OwnerState::Ready, false),
            Act::Wake { key, .. } if key == "second-head:failed")
        );
    }

    #[test]
    fn three_wakes_then_deck_gives_up_until_the_person_writes() {
        let w = workflow();
        let dir = TestDataDir::new();
        let state = PrWatch::load(dir.path());
        for head in ["first", "second", "third"] {
            let seen = state.seen("room", &w).unwrap();
            let act = next(&w, &seen, &failure(head), OwnerState::Ready, false);
            assert!(matches!(act, Act::Wake { .. }));
            state.record("room", seen, &act, false, 1).unwrap();
        }
        let seen = state.seen("room", &w).unwrap();
        let fourth = failure("fourth");
        let act = next(&w, &seen, &fourth, OwnerState::Ready, false);
        assert!(matches!(act, Act::GiveUp { .. }));
        state.record("room", seen, &act, false, 4).unwrap();
        let seen = state.seen("room", &w).unwrap();
        assert_eq!(seen.gave_up_at, Some(4));
        assert_eq!(
            next(&w, &seen, &fourth, OwnerState::Ready, false),
            Act::Nothing
        );
        let act = next(&w, &seen, &fourth, OwnerState::Ready, true);
        assert!(matches!(act, Act::Wake { .. }));
        state.record("room", seen, &act, true, 6).unwrap();
        let seen = state.seen("room", &w).unwrap();
        assert_eq!(seen.wakes, 1);
        assert_eq!(seen.gave_up_at, None);
    }

    #[test]
    fn local_failure_before_a_pr_keeps_its_count_when_the_pr_appears() {
        let mut w = workflow();
        w.pr = None;
        let dir = TestDataDir::new();
        let state = PrWatch::load(dir.path());
        let seen = state.seen("room", &w).unwrap();
        let failure = Observation::LocalCheckFailed {
            head: w.head.clone(),
            detail: "tsc failed".into(),
        };
        let act = next(&w, &seen, &failure, OwnerState::Ready, false);
        assert!(matches!(&act, Act::Wake { key, note }
            if key == "receipt-head:local_check" && note.contains("tsc failed")));
        state.record("room", seen, &act, false, 1).unwrap();
        w.pr = Some(7);
        let seen = state.seen("room", &w).unwrap();
        assert_eq!(seen.wakes, 1);
        assert_eq!(seen.pr, Some(7));
        let conflict = Observation::Conflict {
            head: w.head.clone(),
        };
        let act = next(&w, &seen, &conflict, OwnerState::Ready, false);
        assert!(matches!(&act, Act::Wake { key, .. } if key == "receipt-head:conflict"));
        state.record("room", seen, &act, false, 2).unwrap();
        w.pr = Some(8);
        assert_eq!(state.seen("room", &w).unwrap().wakes, 0);
    }

    #[test]
    fn a_branch_change_discards_the_previous_task_budget() {
        let mut w = workflow();
        let dir = TestDataDir::new();
        let state = PrWatch::load(dir.path());
        let seen = state.seen("room", &w).unwrap();
        let act = next(&w, &seen, &failure("head"), OwnerState::Ready, false);
        state.record("room", seen, &act, false, 1).unwrap();

        w.branch = "fix/another-task".into();
        let seen = state.seen("room", &w).unwrap();
        assert_eq!(seen.branch, w.branch);
        assert_eq!(seen.wakes, 0);
        assert!(seen.woken.is_empty());
    }

    #[test]
    fn a_failed_save_is_retried_before_another_observation_can_act() {
        let w = workflow();
        let dir = TestDataDir::new();
        let state = PrWatch::load(dir.path());
        let seen = state.seen("room", &w).unwrap();
        let now = failure("head");
        let act = next(&w, &seen, &now, OwnerState::Ready, false);

        let fixture = crate::authority_file::fixture_path(&state.path);
        std::fs::create_dir(&fixture).unwrap();
        assert!(state.record("room", seen, &act, false, 1).is_err());
        assert!(state.seen("room", &w).is_err());

        std::fs::remove_dir(&fixture).unwrap();
        let seen = state.seen("room", &w).unwrap();
        assert_eq!(
            next(&w, &seen, &now, OwnerState::Ready, false),
            Act::Nothing
        );
        assert_eq!(PrWatch::load(dir.path()).seen("room", &w).unwrap(), seen);
    }

    #[test]
    fn an_unreadable_saved_budget_stops_the_watcher_from_using_an_empty_budget() {
        let w = workflow();
        let dir = TestDataDir::new();
        let state = PrWatch::load(dir.path());
        std::fs::write(
            crate::authority_file::fixture_path(&state.path),
            b"bad json",
        )
        .unwrap();
        assert!(state.seen("room", &w).is_err());
    }

    #[test]
    fn busy_owners_are_skipped_and_unavailable_owners_get_one_note() {
        let w = workflow();
        let dir = TestDataDir::new();
        let state = PrWatch::load(dir.path());
        let seen = state.seen("room", &w).unwrap();
        let now = failure("head");
        assert_eq!(next(&w, &seen, &now, OwnerState::Busy, false), Act::Nothing);
        let act = next(&w, &seen, &now, OwnerState::CannotTurn, false);
        assert!(matches!(&act, Act::NoteOnly { key, note }
            if key == "head:failed" && !note.contains("@builder")));
        state.record("room", seen, &act, false, 1).unwrap();
        let seen = state.seen("room", &w).unwrap();
        assert_eq!(seen.wakes, 0);
        assert_eq!(
            next(&w, &seen, &now, OwnerState::CannotTurn, false),
            Act::Nothing
        );
    }

    #[test]
    fn terminal_pr_states_win_and_stale_workflow_failure_is_ignored() {
        let w = workflow();
        let seen = Seen::default();
        let merged = Observation::Merged {
            oid: "merge".into(),
            head: "new".into(),
        };
        assert_eq!(
            next(&w, &seen, &merged, OwnerState::Busy, false),
            Act::Sync {
                oid: "merge".into(),
                head: "new".into()
            }
        );
        assert_eq!(
            next(&w, &seen, &Observation::Closed, OwnerState::Busy, false),
            Act::Close
        );
        assert_eq!(
            next(&w, &seen, &Observation::Passed, OwnerState::Ready, false),
            Act::Nothing
        );
    }
}
