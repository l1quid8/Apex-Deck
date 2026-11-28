//! What stands between a pull request and main, read from GitHub before the
//! person is asked to approve anything. Read-only: it pushes nothing, opens
//! nothing and changes no saved state.

use super::{reconcile, required, Decision, Pull, Required, Shell, PULL_FIELDS};
use crate::thread_git::{Checks, Phase, Workflow};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Light {
    Ok,
    Wait,
    Bad,
    Unknown,
}

/// One row of a pull request card: "Checks · 26 passed".
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Line {
    pub label: String,
    pub text: String,
    pub state: Light,
}
fn line(label: &str, text: impl Into<String>, state: Light) -> Line {
    Line { label: label.into(), text: text.into(), state }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Readiness {
    pub pr: Option<u64>,
    /// The reading the merge worker itself would make.
    pub checks: Checks,
    pub lines: Vec<Line>,
    /// Why the pull request can't merge right now, in a few words.
    pub blocker: Option<String>,
    /// Nothing is wrong; GitHub just hasn't finished. A merge asked for now waits.
    pub waiting: bool,
}
impl Readiness {
    pub fn unknown(why: impl Into<String>) -> Self {
        let why = why.into();
        Self { pr: None, checks: Checks::Unknown(why.clone()), lines: Vec::new(), blocker: (!why.is_empty()).then_some(why), waiting: false }
    }
    /// A merge asked for now would go through at once.
    pub fn ready(&self) -> bool {
        self.blocker.is_none() && matches!(self.checks, Checks::Passed { .. })
    }
    /// What a fixed answer about the checks alone implies (tests, and a
    /// reading GitHub could not complete).
    pub fn of(checks: Checks) -> Self {
        let (pr, lines, blocker, waiting) = match &checks {
            Checks::Unknown(why) => return Self::unknown(why.clone()),
            Checks::Running => (None, vec![line("Checks", "still running", Light::Wait)], Some("Checks are still running".to_owned()), true),
            Checks::Passed { pr } => (Some(*pr), vec![line("Checks", "passed", Light::Ok)], None, false),
            Checks::Failed { pr, detail } => {
                let first = detail.lines().next().unwrap_or("A required check failed").to_owned();
                (Some(*pr), vec![line("Checks", first.clone(), Light::Bad)], Some(first), false)
            }
        };
        Self { pr, checks, lines, blocker, waiting }
    }
}

/// What `gh pr view` adds for the card, beyond what the merge worker reads.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Extra {
    mergeable: String,
    review_decision: String,
    is_draft: bool,
}

const FAILED: [&str; 7] = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"];

fn result(check: &serde_json::Value) -> &str {
    check["conclusion"].as_str().filter(|s| !s.is_empty()).or_else(|| check["state"].as_str()).unwrap_or("")
}
fn name(check: &serde_json::Value) -> &str {
    check["name"].as_str().or_else(|| check["context"].as_str()).unwrap_or("GitHub check")
}
fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

pub(crate) async fn read(shell: &impl Shell, w: &Workflow, data: &Path) -> Result<Readiness, String> {
    let root = Path::new(&w.root);
    let gh_repo = format!("github.com/{}", w.repo);
    let number = match w.pr {
        Some(number) => number,
        None => {
            let list = shell
                .run(
                    data,
                    root,
                    "gh",
                    &[
                        "pr", "list", "--repo", &gh_repo, "--base", "main", "--head", &w.branch, "--state", "open",
                        "--json", "number,isCrossRepository",
                        "--jq", "[.[] | select(.isCrossRepository == false)][0].number // empty",
                    ],
                )
                .await?;
            match list.trim().parse::<u64>() {
                Ok(number) => number,
                Err(_) => return Ok(Readiness::unknown("This branch has no open pull request.")),
            }
        }
    };
    let fields = format!("{PULL_FIELDS},mergeable,reviewDecision,isDraft");
    let raw = shell.run(data, root, "gh", &["pr", "view", &number.to_string(), "--repo", &gh_repo, "--json", &fields]).await?;
    let pr: Pull = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let extra: Extra = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    // The same reading the merge worker uses, as if the merge had been asked for.
    let mut asked = w.clone();
    asked.phase = Phase::Checks;
    asked.pr = Some(number);
    let decision = reconcile(&asked, &pr, true);
    match decision {
        Decision::HeadChanged => return Ok(Readiness::unknown("The pull request changed. Review the new commit.")),
        Decision::Closed => return Ok(Readiness::unknown("This pull request is closed.")),
        _ => {}
    }
    if let Decision::Finish(phase, detail) = &decision {
        // Merged already: nothing to offer.
        if *phase == Phase::Merged {
            return Ok(Readiness::unknown(detail.clone()));
        }
        if *phase != Phase::Failed {
            let mut gone = Readiness::unknown(detail.clone());
            gone.pr = Some(number);
            return Ok(gone);
        }
    }
    let protection = required(shell, w, &pr, data, root).await?;

    let rollup = &pr.status_check_rollup;
    let failed: Vec<&str> = rollup.iter().filter(|c| FAILED.contains(&result(c))).map(name).collect();
    let passed = rollup.iter().filter(|c| matches!(result(c), "SUCCESS" | "SKIPPED" | "NEUTRAL")).count();
    let pending = rollup.len() - passed - failed.len();
    let mut lines = Vec::new();
    lines.push(if let Some(first) = failed.first() {
        let more = if failed.len() > 1 { format!(" and {} more", failed.len() - 1) } else { String::new() };
        line("Checks", format!("{first}{more} failed"), Light::Bad)
    } else if pending > 0 {
        line("Checks", format!("{} still running, {passed} passed", pending), Light::Wait)
    } else if rollup.is_empty() {
        line("Checks", "none have reported yet", Light::Wait)
    } else {
        line("Checks", format!("{passed} passed"), Light::Ok)
    });
    lines.push(match &protection {
        Required::None => line("Required checks", "main has none set on GitHub", Light::Bad),
        Required::Waiting(check) => line("Required checks", format!("waiting for {check}"), Light::Wait),
        Required::Passed => line("Required checks", "passed", Light::Ok),
    });
    lines.push(match extra.mergeable.as_str() {
        "CONFLICTING" => line("Conflicts", "conflicts with main", Light::Bad),
        "MERGEABLE" => line("Conflicts", "none", Light::Ok),
        _ => line("Conflicts", "GitHub is still working it out", Light::Unknown),
    });
    let deck_review = w.reviewer.as_ref().map(|_| "another agent's review passed");
    lines.push(match extra.review_decision.as_str() {
        "APPROVED" => line("Review", "approved", Light::Ok),
        "CHANGES_REQUESTED" => line("Review", "changes requested", Light::Bad),
        "REVIEW_REQUIRED" => line("Review", "needs an approving review", Light::Bad),
        _ => line("Review", deck_review.unwrap_or("not required"), Light::Ok),
    });

    let conflicting = extra.mergeable == "CONFLICTING" || pr.merge_state_status == "DIRTY";
    let (checks, blocker, waiting) = if extra.is_draft {
        (Checks::Running, Some("This pull request is still a draft".to_owned()), false)
    } else if conflicting {
        (Checks::Running, Some("It conflicts with main".to_owned()), false)
    } else if let Decision::Finish(_, detail) = &decision {
        let first = failed.first().copied().unwrap_or("A check");
        (Checks::Failed { pr: number, detail: detail.clone() }, Some(format!("{first} failed")), false)
    } else if matches!(protection, Required::None) {
        (Checks::Unknown("GitHub reports no required status checks for main.".into()), Some("main has no required checks on GitHub".to_owned()), false)
    } else if extra.review_decision == "CHANGES_REQUESTED" {
        (Checks::Running, Some("A review asked for changes".to_owned()), false)
    } else if extra.review_decision == "REVIEW_REQUIRED" {
        (Checks::Running, Some("It needs an approving review".to_owned()), false)
    } else if pr.merge_state_status == "BEHIND" {
        (Checks::Running, Some("The branch is behind main".to_owned()), false)
    } else if pending > 0 || rollup.is_empty() {
        let what = if pending > 0 { format!("{} still running", plural(pending, "check is", "checks are")) } else { "Checks haven't reported yet".to_owned() };
        (Checks::Running, Some(what), true)
    } else if let Required::Waiting(check) = &protection {
        // Every check that ran has finished, so waiting would never end.
        (Checks::Running, Some(format!("Required check {check} never reported")), false)
    } else if matches!(decision, Decision::Submit) {
        (Checks::Passed { pr: number }, None, false)
    } else if pr.merge_state_status == "UNKNOWN" {
        (Checks::Running, Some("GitHub is still working out whether it can merge".to_owned()), true)
    } else {
        (Checks::Running, Some("GitHub is blocking this merge".to_owned()), false)
    };
    Ok(Readiness { pr: Some(number), checks, lines, blocker, waiting })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// GitHub's answers for one pull request and for main's protection.
    struct Github {
        pull: serde_json::Value,
        required: Vec<&'static str>,
        /// Whether the branch has an open pull request to list.
        listed: bool,
        asked: std::sync::Mutex<Vec<String>>,
    }
    impl Shell for Github {
        async fn run(&self, _data: &Path, _cwd: &Path, program: &str, args: &[&str]) -> Result<String, String> {
            assert_eq!(program, "gh", "a reading never runs git: {args:?}");
            self.asked.lock().unwrap().push(args[..2].join(" "));
            match &args[..2] {
                ["pr", "list"] => Ok(if self.listed { "84".into() } else { String::new() }),
                ["pr", "view"] => Ok(self.pull.to_string()),
                ["api", "graphql"] => Ok(json!({"data":{"repository":{"ref":{"refUpdateRule":{"requiredStatusCheckContexts":self.required}}}}}).to_string()),
                _ => panic!("a reading changes nothing on GitHub: {args:?}"),
            }
        }
    }
    const HEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fn workflow() -> Workflow {
        Workflow::draft("/repo".into(), "feat/x".into(), "test/repo".into(), HEAD.into(), "a".into())
    }
    fn pull(change: impl FnOnce(&mut serde_json::Value)) -> serde_json::Value {
        let mut pull = json!({
            "number": 84, "state": "OPEN", "headRefOid": HEAD, "headRefName": "feat/x", "baseRefName": "main",
            "isCrossRepository": false, "mergeCommit": null, "mergeStateStatus": "CLEAN", "mergeable": "MERGEABLE",
            "reviewDecision": "", "isDraft": false,
            "statusCheckRollup": [{"name": "all-checks-passed", "conclusion": "SUCCESS"}, {"name": "test", "conclusion": "SUCCESS"}, {"name": "docs", "conclusion": "SKIPPED"}],
        });
        change(&mut pull);
        pull
    }
    async fn reading(pull: serde_json::Value, required: &[&'static str]) -> Readiness {
        let github = Github { pull, required: required.to_vec(), listed: true, asked: Default::default() };
        read(&github, &workflow(), Path::new("/data")).await.unwrap()
    }
    fn row<'a>(ready: &'a Readiness, label: &str) -> (&'a str, Light) {
        let line = ready.lines.iter().find(|line| line.label == label).unwrap_or_else(|| panic!("no {label} row in {:?}", ready.lines));
        (line.text.as_str(), line.state)
    }

    #[tokio::test]
    async fn a_clean_pull_request_is_ready_and_says_what_was_checked() {
        let ready = reading(pull(|_| {}), &["all-checks-passed"]).await;
        assert_eq!((ready.pr, &ready.checks, &ready.blocker, ready.waiting), (Some(84), &Checks::Passed { pr: 84 }, &None, false));
        assert!(ready.ready());
        assert_eq!(row(&ready, "Checks"), ("3 passed", Light::Ok));
        assert_eq!(row(&ready, "Required checks"), ("passed", Light::Ok));
        assert_eq!(row(&ready, "Conflicts"), ("none", Light::Ok));
        assert_eq!(row(&ready, "Review"), ("not required", Light::Ok));
    }

    #[tokio::test]
    async fn main_without_required_checks_is_said_before_anyone_approves() {
        // PR #84: every check green, GitHub calls it clean, and main requires nothing.
        let ready = reading(pull(|_| {}), &[]).await;
        assert_eq!(ready.blocker.as_deref(), Some("main has no required checks on GitHub"));
        assert!(!ready.waiting && !ready.ready());
        assert_eq!(ready.checks, Checks::Unknown("GitHub reports no required status checks for main.".into()));
        assert_eq!(row(&ready, "Required checks"), ("main has none set on GitHub", Light::Bad));
        assert_eq!(row(&ready, "Checks"), ("3 passed", Light::Ok));
    }

    #[tokio::test]
    async fn conflicts_reviews_and_drafts_each_stop_it_with_a_reason() {
        for (change, why, label, text) in [
            (json!({"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"}), "It conflicts with main", "Conflicts", "conflicts with main"),
            (json!({"reviewDecision": "CHANGES_REQUESTED", "mergeStateStatus": "BLOCKED"}), "A review asked for changes", "Review", "changes requested"),
            (json!({"reviewDecision": "REVIEW_REQUIRED", "mergeStateStatus": "BLOCKED"}), "It needs an approving review", "Review", "needs an approving review"),
            (json!({"isDraft": true, "mergeStateStatus": "DRAFT"}), "This pull request is still a draft", "Conflicts", "none"),
            (json!({"mergeStateStatus": "BEHIND"}), "The branch is behind main", "Conflicts", "none"),
            (json!({"mergeStateStatus": "BLOCKED"}), "GitHub is blocking this merge", "Conflicts", "none"),
        ] {
            let ready = reading(pull(|pull| pull.as_object_mut().unwrap().extend(change.as_object().unwrap().clone())), &["all-checks-passed"]).await;
            assert_eq!((ready.blocker.as_deref(), ready.waiting, ready.ready()), (Some(why), false, false), "{why}");
            assert_eq!(row(&ready, label).0, text, "{why}");
            assert_eq!(ready.pr, Some(84));
        }
        let approved = reading(pull(|pull| pull["reviewDecision"] = json!("APPROVED")), &["all-checks-passed"]).await;
        assert_eq!((approved.ready(), row(&approved, "Review")), (true, ("approved", Light::Ok)));
    }

    #[tokio::test]
    async fn a_failed_check_names_itself_and_running_ones_only_wait() {
        let failed = reading(pull(|pull| pull["statusCheckRollup"] = json!([{"name": "test", "conclusion": "FAILURE", "detailsUrl": "https://example.invalid/run"}, {"name": "ui", "conclusion": "SUCCESS"}])), &["test"]).await;
        assert_eq!(failed.blocker.as_deref(), Some("test failed"));
        assert!(matches!(&failed.checks, Checks::Failed { pr: 84, detail } if detail.starts_with("test reported FAILURE")), "{:?}", failed.checks);
        assert_eq!(row(&failed, "Checks"), ("test failed", Light::Bad));

        let running = reading(pull(|pull| {
            pull["mergeStateStatus"] = json!("BLOCKED");
            pull["statusCheckRollup"] = json!([{"name": "test", "status": "IN_PROGRESS", "conclusion": ""}, {"name": "ui", "conclusion": "SUCCESS"}, {"name": "all-checks-passed", "status": "QUEUED", "conclusion": ""}]);
        }), &["all-checks-passed"]).await;
        assert_eq!((running.blocker.as_deref(), running.waiting, &running.checks), (Some("2 checks are still running"), true, &Checks::Running));
        assert_eq!(row(&running, "Checks"), ("2 still running, 1 passed", Light::Wait));
        assert_eq!(row(&running, "Required checks"), ("waiting for all-checks-passed", Light::Wait));

        // Every check that ran is green, but the one main requires never reported.
        let missing = reading(pull(|_| {}), &["all-checks-passed", "deploy-preview"]).await;
        assert_eq!((missing.blocker.as_deref(), missing.waiting), (Some("Required check deploy-preview never reported"), false));

        let merged = reading(pull(|pull| { pull["state"] = json!("MERGED"); pull["mergeCommit"] = json!({"oid": "c".repeat(40)}); }), &["all-checks-passed"]).await;
        assert_eq!(merged.pr, None, "merged outside Deck: no card");

        // GitHub works mergeability out lazily.
        let unknown = reading(pull(|pull| { pull["mergeStateStatus"] = json!("UNKNOWN"); pull["mergeable"] = json!("UNKNOWN"); }), &["all-checks-passed"]).await;
        assert_eq!((unknown.blocker.as_deref(), unknown.waiting), (Some("GitHub is still working out whether it can merge"), true));
        assert_eq!(row(&unknown, "Conflicts"), ("GitHub is still working it out", Light::Unknown));
    }

    #[tokio::test]
    async fn a_branch_without_a_pull_request_or_with_a_newer_commit_has_no_card() {
        let none = Github { pull: pull(|_| {}), required: vec!["test"], listed: false, asked: Default::default() };
        let ready = read(&none, &workflow(), Path::new("/data")).await.unwrap();
        assert_eq!((ready.pr, ready.blocker.as_deref()), (None, Some("This branch has no open pull request.")));
        assert_eq!(*none.asked.lock().unwrap(), vec!["pr list"], "nothing else is asked");

        let moved = reading(pull(|pull| pull["headRefOid"] = json!("b".repeat(40))), &["test"]).await;
        assert_eq!(moved.checks, Checks::Unknown("The pull request changed. Review the new commit.".into()));
        assert!(!moved.ready() && !moved.waiting);
    }

    #[tokio::test]
    async fn the_reading_matches_what_the_merge_worker_would_decide() {
        // Readiness::of is what tests and a failed reading fall back to.
        assert!(Readiness::of(Checks::Passed { pr: 1 }).ready());
        let running = Readiness::of(Checks::Running);
        assert_eq!((running.pr, running.waiting), (None, true));
        let failed = Readiness::of(Checks::Failed { pr: 1, detail: "Windows failed\nlog".into() });
        assert_eq!((failed.blocker.as_deref(), failed.waiting), (Some("Windows failed"), false));
        assert_eq!(Readiness::unknown("").blocker, None);
    }
}
