use super::*;
use crate::pr_watch::{next, Act, OwnerState, Seen};
use crate::project_process::TestDataDir;
use serde_json::{json, Value};

fn workflow(root: &Path) -> Workflow {
    serde_json::from_value(json!({
        "root": root, "branch": "task", "repo": "test/repo", "head": "reviewed",
        "builder": "builder", "builder_model": "model", "phase": "checks",
        "generation": 1, "pr": 42, "detail": "", "pushed": true, "fix_requested": false
    }))
    .unwrap()
}

fn pull(state: &str, head: &str, merge_state: &str, checks: Value) -> Value {
    json!({
        "number": 42, "state": state, "headRefOid": head, "headRefName": "task",
        "baseRefName": "main", "isCrossRepository": false, "mergeCommit": {"oid": "merge-oid"},
        "mergeStateStatus": merge_state, "statusCheckRollup": checks
    })
}

struct Remote {
    pull: Value,
    list: Value,
    log_id: Option<&'static str>,
}
impl Shell for Remote {
    async fn run(
        &self,
        _: &Path,
        cwd: &Path,
        program: &str,
        args: &[&str],
    ) -> Result<String, String> {
        let output = match (program, args) {
            ("git", ["rev-parse", "HEAD"]) => "reviewed".into(),
            ("git", ["symbolic-ref", "--short", "HEAD"]) => "task".into(),
            ("git", ["remote", "get-url", "--push", "origin"]) => {
                "https://github.com/test/repo.git".into()
            }
            ("git", ["rev-parse", "--show-toplevel"]) => cwd.display().to_string(),
            (
                "gh",
                ["pr", "view", "42", "--repo", "github.com/test/repo", "--json", PULL_FIELDS],
            ) => self.pull.to_string(),
            (
                "gh",
                ["pr", "list", "--repo", "github.com/test/repo", "--base", "main", "--head", "task", "--state", "all", "--json", "number,state,headRefOid,isCrossRepository"],
            ) => self.list.to_string(),
            ("gh", ["run", "view", id, "--repo", "test/repo", "--log-failed"]) => {
                assert_eq!(Some(*id), self.log_id);
                format!("log for run {id}")
            }
            _ => panic!("unexpected command: {program} {args:?}"),
        };
        Ok(output)
    }
}

#[tokio::test]
async fn all_checks_passed_is_skipped_in_reconcile_log_fetch_and_observe_pr() {
    let data = TestDataDir::new();
    let w = workflow(data.path());
    let store = ThreadGit::new(data.path());
    let gate = json!({"name":"all-checks-passed","conclusion":"FAILURE","detailsUrl":"https://github.com/test/repo/actions/runs/1/job/9"});
    let windows = json!({"name":"test-windows","conclusion":"FAILURE","detailsUrl":"https://github.com/test/repo/actions/runs/2/job/8"});
    let linux = json!({"context":"test-linux","state":"ERROR","targetUrl":"https://ci.example.invalid/build/7"});
    for (checks, main_check, names, log_id) in [
        (
            json!([gate, windows, linux]),
            "test-windows",
            vec!["test-windows", "test-linux"],
            "2",
        ),
        (
            json!([gate]),
            "all-checks-passed",
            vec!["all-checks-passed"],
            "1",
        ),
    ] {
        store
            .edit(|rooms| {
                rooms.insert("r".into(), w.clone());
                Ok(())
            })
            .unwrap();
        let remote = Remote {
            pull: pull("OPEN", "reviewed", "BLOCKED", checks),
            list: Value::Null,
            log_id: Some(log_id),
        };
        store
            .advance(&remote, "r", &w, data.path(), Some(data.path()))
            .await
            .unwrap();
        let job = store.get("r").unwrap().unwrap();
        assert_eq!(job.phase, Phase::Failed);
        assert!(job.detail.starts_with(main_check), "{}", job.detail);
        assert!(
            job.detail.ends_with(&format!("log for run {log_id}")),
            "{}",
            job.detail
        );
        let observed = observe_pr_with(&remote, data.path(), &w).await.unwrap();
        let Observation::Failed {
            names: observed_names,
            ..
        } = observed
        else {
            panic!("expected failure")
        };
        assert_eq!(observed_names, names);
    }
}

#[tokio::test]
async fn a_conflict_during_a_ship_merge_reaches_the_watcher() {
    let data = TestDataDir::new();
    let w = workflow(data.path());
    let store = ThreadGit::new(data.path());
    store
        .edit(|rooms| {
            rooms.insert("r".into(), w.clone());
            Ok(())
        })
        .unwrap();
    let remote = Remote {
        pull: pull("OPEN", "reviewed", "DIRTY", json!([])),
        list: Value::Null,
        log_id: None,
    };
    store
        .advance(&remote, "r", &w, data.path(), Some(data.path()))
        .await
        .unwrap();
    let failed = store.get("r").unwrap().unwrap();
    assert_eq!(failed.phase, Phase::Failed);
    assert_eq!(failed.detail, "PR #42 conflicts with main.");
    let now = observe_pr_with(&remote, data.path(), &failed)
        .await
        .unwrap();
    assert!(matches!(
        next(&failed, &Seen::default(), &now, OwnerState::Ready, false),
        Act::Wake { key, .. } if key == "reviewed:conflict"
    ));
}

#[tokio::test]
async fn observe_pr_gives_terminal_states_priority_over_conflicts_and_checks() {
    let w = workflow(Path::new("/task"));
    let dir = Path::new("/data");
    let checks = json!([{"name": "test", "conclusion": "FAILURE"}]);
    for state in ["MERGED", "CLOSED", "OPEN"] {
        let remote = Remote {
            pull: pull(state, "new-push", "DIRTY", checks.clone()),
            list: Value::Null,
            log_id: None,
        };
        let observed = observe_pr_with(&remote, dir, &w).await.unwrap();
        match (state, observed) {
            ("MERGED", Observation::Merged { oid, head })
                if oid == "merge-oid" && head == "new-push" => {}
            ("CLOSED", Observation::Closed) => {}
            ("OPEN", Observation::Conflict { head }) if head == "new-push" => {}
            _ => panic!("wrong observation for {state}"),
        }
    }
}

#[tokio::test]
async fn a_pr_the_agent_opened_is_found_by_branch_and_ignores_old_reused_branch_prs() {
    let mut w = workflow(Path::new("/task"));
    w.pr = None;
    let dir = Path::new("/data");
    let stale = json!({"number":1,"state":"MERGED","headRefOid":"old","isCrossRepository":false});
    let fork = json!({"number":2,"state":"OPEN","headRefOid":"reviewed","isCrossRepository":true});
    let closed =
        json!({"number":3,"state":"CLOSED","headRefOid":"reviewed","isCrossRepository":false});
    let open = json!({"number":4,"state":"OPEN","headRefOid":"new-push","isCrossRepository":false});
    for (list, expected) in [
        (json!([stale, fork]), None),
        (json!([stale, fork, closed]), Some(3)),
        (json!([stale, fork, closed, open]), Some(4)),
    ] {
        let remote = Remote {
            pull: Value::Null,
            list,
            log_id: None,
        };
        assert_eq!(find_pr_with(&remote, dir, &w).await.unwrap(), expected);
    }
}

#[tokio::test]
async fn externally_finished_prs_reconcile_during_pending_ci_even_at_a_newer_head() {
    for state in ["CLOSED", "MERGED", "OPEN"] {
        let data = TestDataDir::new();
        let w = workflow(data.path());
        let store = ThreadGit::new(data.path());
        store
            .edit(|rooms| {
                rooms.insert("r".into(), w.clone());
                Ok(())
            })
            .unwrap();
        let remote = Remote {
            pull: pull(state, "new-head", "CLEAN", json!([])),
            list: Value::Null,
            log_id: None,
        };
        store
            .advance(&remote, "r", &w, data.path(), Some(data.path()))
            .await
            .unwrap();
        let saved = store.get("r").unwrap().unwrap();
        match state {
            "CLOSED" => assert!(saved.close_pending),
            "MERGED" => assert_eq!(
                (
                    saved.phase,
                    saved.head.as_str(),
                    saved.result_oid.as_deref()
                ),
                (Phase::Syncing, "new-head", Some("merge-oid"))
            ),
            _ => {
                assert_eq!(saved.phase, Phase::Cancelled);
                assert_eq!(
                    store.workflows().unwrap(),
                    vec![("r".into(), saved.clone())]
                );
                let merged = Remote {
                    pull: pull("MERGED", "new-head", "UNKNOWN", json!([])),
                    list: Value::Null,
                    log_id: None,
                };
                let observed = observe_pr_with(&merged, data.path(), &saved).await.unwrap();
                assert!(
                    matches!(next(&saved, &Seen::default(), &observed, OwnerState::Ready, false),
                    Act::Sync { head, .. } if head == "new-head")
                );
            }
        }
    }
}
