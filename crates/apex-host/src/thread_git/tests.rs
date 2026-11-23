use super::github::Shell;
use super::*;
use crate::project_process::{fixture_git_command, TestDataDir};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Fixture {
    data: TestDataDir,
    checkout: TestDataDir,
    store: ThreadGit,
}
impl Fixture {
    fn new() -> Self {
        let data = TestDataDir::new();
        let checkout = TestDataDir::new();
        let store = ThreadGit::new(data.path());
        let f = Self {
            data,
            checkout,
            store,
        };
        for args in [
            &["init", "-qb", "main"][..],
            &["config", "user.name", "Fixture"],
            &["config", "user.email", "test@example.invalid"],
            &["commit", "--allow-empty", "-qm", "base"],
            &["switch", "-qc", "task"],
            &["commit", "--allow-empty", "-qm", "fix"],
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/test/repo.git",
            ],
        ] {
            f.git(args);
        }
        f
    }
    fn git(&self, args: &[&str]) -> String {
        let out = fixture_git_command()
            .args(args)
            .current_dir(self.checkout.path())
            .output()
            .unwrap();
        assert!(out.status.success(), "{:?}", out);
        String::from_utf8(out.stdout).unwrap().trim().into()
    }
    fn mark(&self, id: &str, model: &str, built: bool) {
        let by=serde_json::from_value(serde_json::json!({"id":id,"display_name":id,"backend":{"kind":"open_ai_compatible","base_url":"http://test.invalid","model":model}})).unwrap();
        let text = format!(
            "{} {}",
            if built {
                "Deck built"
            } else {
                "Deck review passed"
            },
            self.git(&["rev-parse", "HEAD"])
        );
        self.store
            .record("r", self.data.path(), self.checkout.path(), &by, &text)
            .unwrap();
    }
    fn state(&self) -> State {
        let mut state = crate::git_changes::status(self.data.path(), self.checkout.path()).unwrap();
        state.workflow = self.store.get("r").unwrap();
        state
    }
    fn reviewed(&self) -> State {
        self.mark("builder", "model-a", true);
        self.mark("reviewer", "model-b", false);
        let state = self.state();
        assert!(state.workflow.as_ref().unwrap().reviewer.is_some());
        state
    }
    async fn tick(&self, store: &ThreadGit, remote: &Github) {
        let job = store.get("r").unwrap().unwrap();
        store
            .advance(
                remote,
                "r",
                &job,
                self.data.path(),
                Some(self.checkout.path()),
            )
            .await
            .unwrap();
    }
}
#[derive(Default)]
struct Github {
    merged: AtomicBool,
    puts: AtomicUsize,
    creates: AtomicUsize,
    fail: AtomicBool,
    pause: AtomicBool,
    required: Option<Vec<String>>,
    /// The builder already opened the pull request.
    listed: bool,
    dispatch: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}
impl Shell for Github {
    async fn run(
        &self,
        data: &Path,
        cwd: &Path,
        program: &str,
        args: &[&str],
    ) -> Result<String, String> {
        if program == "git" {
            if args[0] == "push" {
                return Ok(String::new());
            }
            return run(data, cwd, program, args).await;
        }
        match &args[..2] {
            ["pr", "list"] => Ok(if self.listed { "42".into() } else { String::new() }),
            ["pr", "create"] => {
                self.creates.fetch_add(1, Ordering::SeqCst);
                Ok("https://github.com/test/repo/pull/42".into())
            }
            ["pr", "view"] => {
                let actual = git(data, cwd, None, &["rev-parse", "HEAD"])?;
                Ok(serde_json::json!({"number":42,"state":if self.merged.load(Ordering::SeqCst){"MERGED"}else{"OPEN"},"headRefOid":actual.trim(),"headRefName":"task","baseRefName":"main","isCrossRepository":false,"mergeCommit":{"oid":"a".repeat(40)},"mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"Windows","conclusion":if self.fail.load(Ordering::SeqCst){"FAILURE"}else{"SUCCESS"}}]}).to_string())
            }
            ["api", "graphql"] => {
                let contexts = self
                    .required
                    .clone()
                    .unwrap_or_else(|| vec!["Windows".into()]);
                Ok(serde_json::json!({"data":{"repository":{"ref":{"refUpdateRule":{"requiredStatusCheckContexts":contexts}}}}}).to_string())
            }
            ["api", ..] => {
                let sha = git(data, cwd, None, &["rev-parse", "HEAD"])?;
                assert!(args.contains(&format!("sha={}", sha.trim()).as_str()));
                self.puts.fetch_add(1, Ordering::SeqCst);
                self.dispatch.notify_one();
                if self.pause.load(Ordering::SeqCst) {
                    self.resume.notified().await;
                }
                self.merged.store(true, Ordering::SeqCst);
                Ok("{}".into())
            }
            _ => panic!("unexpected {args:?}"),
        }
    }
}
#[tokio::test]
async fn restart_during_checks_resumes_one_pr_and_reconciles_after_submission() {
    let f = Fixture::new();
    let remote = Github::default();
    f.store.admit("r", &f.reviewed(), false).unwrap();
    f.tick(&f.store, &remote).await;
    let reopened = ThreadGit::new(f.data.path());
    assert_eq!(reopened.pending().unwrap()[0].1.phase, Phase::Checks);
    f.tick(&reopened, &remote).await;
    let again = ThreadGit::new(f.data.path());
    f.tick(&again, &remote).await;
    assert_eq!(again.get("r").unwrap().unwrap().phase, Phase::Syncing);
    assert_eq!(remote.creates.load(Ordering::SeqCst), 1);
    assert_eq!(remote.puts.load(Ordering::SeqCst), 1);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_restart_recovers_without_reopening_the_thread() {
    use crate::host::{Host, HostPaths};
    let f = Fixture::new();
    let reviewed = f.reviewed();
    let paths = || HostPaths {
        data: f.data.path().to_owned(),
        downloads: None,
    };
    let runtime = tokio::runtime::Handle::current();
    let first = Host::new(paths(), runtime.clone());
    first
        .room_create(
            "r".into(),
            vec![],
            Default::default(),
            Some(f.checkout.path().display().to_string()),
        )
        .unwrap();
    first
        .room_thread_git_action(
            "r".into(),
            ThreadGitAction::RequestMerge { expected: reviewed },
        )
        .await
        .unwrap();
    first.shutdown();
    drop(first);
    f.git(&[
        "commit",
        "--allow-empty",
        "-qm",
        "updated while Deck was closed",
    ]);

    let recovered = Host::new(paths(), runtime);
    // Observe the persisted transition independently of the room/UI.
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let persisted = ThreadGit::new(f.data.path()).get("r").unwrap().unwrap();
            if persisted.phase == Phase::Blocked {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("Host did not resume its merge worker on startup");
    recovered.shutdown();
}

#[tokio::test]
async fn cancel_racing_dispatched_merge_reports_github_result() {
    let f = Fixture::new();
    let remote = Github::default();
    remote.pause.store(true, Ordering::SeqCst);
    f.store.admit("r", &f.reviewed(), false).unwrap();
    f.tick(&f.store, &remote).await;
    tokio::join!(f.tick(&f.store, &remote), async {
        remote.dispatch.notified().await;
        f.store.admit("r", &f.state(), true).unwrap();
        assert_eq!(f.state().workflow.unwrap().phase, Phase::Cancelling);
        remote.resume.notify_one();
    });
    f.tick(&f.store, &remote).await;
    assert_eq!(f.state().workflow.unwrap().phase, Phase::Syncing);
}
#[tokio::test]
async fn double_clicks_share_one_request_and_cancel_beats_an_old_poll() {
    let f = Fixture::new();
    let remote = Github::default();
    let initial = f.reviewed();
    for _ in 0..2 {
        f.store.admit("r", &initial, false).unwrap();
    }
    f.tick(&f.store, &remote).await;
    let waiting = f.state();
    for _ in 0..2 {
        f.store.admit("r", &waiting, true).unwrap();
    }
    f.store
        .advance(
            &remote,
            "r",
            waiting.workflow.as_ref().unwrap(),
            f.data.path(),
            Some(f.checkout.path()),
        )
        .await
        .unwrap();
    f.tick(&f.store, &remote).await;
    assert_eq!(f.state().workflow.unwrap().phase, Phase::Cancelled);
    assert_eq!(remote.puts.load(Ordering::SeqCst), 0);
    assert_eq!(remote.creates.load(Ordering::SeqCst), 1);
    assert!(f.store.admit("r", &initial, false).is_err());
}
#[tokio::test]
async fn new_head_invalidates_review_and_alias_of_builder_model_cannot_approve() {
    let f = Fixture::new();
    let remote = Github::default();
    f.store.admit("r", &f.reviewed(), false).unwrap();
    f.tick(&f.store, &remote).await;
    f.git(&["commit", "--allow-empty", "-qm", "updated"]);
    f.tick(&f.store, &remote).await;
    assert_eq!(remote.puts.load(Ordering::SeqCst), 0);
    assert!(f.store.admit("r", &f.state(), false).is_err());
    f.mark("builder", "model-a", true);
    f.mark("alias", "model-a", false);
    assert!(f.state().workflow.unwrap().reviewer.is_none());
    f.mark("reviewer", "model-b", false);
    assert!(f.store.admit("r", &f.state(), false).is_ok());
}
#[tokio::test]
async fn failed_check_exposes_output_and_only_an_explicit_fix_marks_it_requested() {
    let f = Fixture::new();
    let remote = Github::default();
    remote.fail.store(true, Ordering::SeqCst);
    f.store.admit("r", &f.reviewed(), false).unwrap();
    f.tick(&f.store, &remote).await;
    f.tick(&f.store, &remote).await;
    let failed = f.store.fix("r", &f.state()).unwrap();
    assert!(failed.detail.contains("Windows reported FAILURE"));
    assert!(!failed.fix_requested);
    assert!(f.store.mark_fix("r", &failed).unwrap());
    assert!(!f.store.mark_fix("r", &failed).unwrap());
    assert_eq!(remote.puts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_green_check_requires_a_complete_nonempty_required_set() {
    for (required, expected) in [
        (vec!["Windows".into(), "Linux".into()], Phase::Checks),
        (vec![], Phase::Blocked),
    ] {
        let f = Fixture::new();
        let remote = Github {
            required: Some(required),
            ..Github::default()
        };
        f.store.admit("r", &f.reviewed(), false).unwrap();
        f.tick(&f.store, &remote).await;
        f.tick(&f.store, &remote).await;
        assert_eq!(remote.puts.load(Ordering::SeqCst), 0);
        assert_eq!(f.store.get("r").unwrap().unwrap().phase, expected);
    }
}

fn listed(required: &[&str]) -> Github {
    Github {
        listed: true,
        required: Some(required.iter().map(|name| name.to_string()).collect()),
        ..Github::default()
    }
}

#[tokio::test]
async fn the_probe_reads_github_and_changes_nothing() {
    let f = Fixture::new();
    f.reviewed();
    let w = f.store.get("r").unwrap().unwrap();
    let probe = |remote: Github| {
        let w = w.clone();
        let data = f.data.path().to_owned();
        async move {
            let answer = super::github::probe(&remote, &w, &data).await.unwrap();
            assert_eq!(remote.creates.load(Ordering::SeqCst) + remote.puts.load(Ordering::SeqCst), 0);
            answer
        }
    };
    assert!(matches!(probe(Github::default()).await, Checks::Unknown(_)), "no pull request yet");
    assert_eq!(probe(listed(&["Windows"])).await, Checks::Passed { pr: 42 });
    assert_eq!(probe(listed(&["Windows", "Linux"])).await, Checks::Running, "a required check has not reported");
    assert!(matches!(probe(listed(&[])).await, Checks::Unknown(_)), "main requires no checks");
    let failing = listed(&["Windows"]);
    failing.fail.store(true, Ordering::SeqCst);
    assert!(matches!(probe(failing).await, Checks::Failed { pr: 42, .. }));
    // A newer commit than the reviewed one is not this workflow's pull request.
    f.git(&["commit", "--allow-empty", "-qm", "more"]);
    assert!(matches!(probe(listed(&["Windows"])).await, Checks::Unknown(_)));
    assert_eq!(f.store.get("r").unwrap().unwrap(), w, "nothing saved changed");
}

#[tokio::test]
async fn a_card_merge_double_tapped_merges_once() {
    let f = Fixture::new();
    let remote = listed(&["Windows"]);
    let shown = f.reviewed();
    f.store.admit_ready("r", &shown).unwrap();
    f.store.admit_ready("r", &shown).unwrap();
    assert_eq!(f.store.get("r").unwrap().unwrap().generation, 1);
    for _ in 0..4 {
        if f.store.get("r").unwrap().unwrap().pending() {
            f.tick(&f.store, &remote).await;
        }
    }
    assert_eq!(remote.puts.load(Ordering::SeqCst), 1);
    assert_eq!(remote.creates.load(Ordering::SeqCst), 0, "the builder's pull request is reused");
    assert!(matches!(f.store.get("r").unwrap().unwrap().phase, Phase::Syncing | Phase::Merged));
}

#[tokio::test]
async fn a_card_merge_stops_instead_of_waiting_when_checks_changed_even_across_a_restart() {
    // Main now requires a check that has not reported: stop, do not wait.
    let f = Fixture::new();
    f.store.admit_ready("r", &f.reviewed()).unwrap();
    f.tick(&f.store, &listed(&["Windows"])).await;
    assert_eq!(f.store.get("r").unwrap().unwrap().phase, Phase::Checks);
    let restarted = ThreadGit::new(f.data.path());
    let changed = listed(&["Windows", "Linux"]);
    f.tick(&restarted, &changed).await;
    let stopped = restarted.get("r").unwrap().unwrap();
    assert_eq!(stopped.phase, Phase::Cancelled);
    assert!(stopped.detail.contains("Nothing was merged"), "{}", stopped.detail);
    assert_eq!(changed.puts.load(Ordering::SeqCst), 0);
    // The same merge asked for from the old bar still waits, as before.
    let g = Fixture::new();
    g.store.admit("r", &g.reviewed(), false).unwrap();
    g.tick(&g.store, &changed).await;
    g.tick(&g.store, &changed).await;
    assert_eq!(g.store.get("r").unwrap().unwrap().phase, Phase::Checks);
    // After a restart with the checks still green, the card's merge goes through once.
    let h = Fixture::new();
    h.store.admit_ready("r", &h.reviewed()).unwrap();
    let green = listed(&["Windows"]);
    h.tick(&h.store, &green).await;
    let again = ThreadGit::new(h.data.path());
    h.tick(&again, &green).await;
    assert_eq!(green.puts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancel_reaches_a_card_merge_and_reports_one_that_already_landed() {
    let f = Fixture::new();
    let remote = listed(&["Windows"]);
    let shown = f.reviewed();
    f.store.admit_ready("r", &shown).unwrap();
    f.tick(&f.store, &remote).await;
    let shown = f.state();
    f.store.admit("r", &shown, true).unwrap();
    f.tick(&f.store, &remote).await;
    assert_eq!(f.store.get("r").unwrap().unwrap().phase, Phase::Cancelled);
    assert_eq!(remote.puts.load(Ordering::SeqCst), 0);
    // GitHub merged before the cancel was confirmed: the result is the merge.
    let g = Fixture::new();
    let landed = listed(&["Windows"]);
    g.store.admit_ready("r", &g.reviewed()).unwrap();
    g.tick(&g.store, &landed).await;
    landed.merged.store(true, Ordering::SeqCst);
    g.store.admit("r", &g.state(), true).unwrap();
    g.tick(&g.store, &landed).await;
    let result = g.store.get("r").unwrap().unwrap();
    assert!(matches!(result.phase, Phase::Syncing | Phase::Merged), "{:?}", result.phase);
    assert!(result.detail.contains("Merged PR #42"), "{}", result.detail);
}
