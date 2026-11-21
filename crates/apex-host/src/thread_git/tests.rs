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
            ["pr", "list"] => Ok(String::new()),
            ["pr", "create"] => {
                self.creates.fetch_add(1, Ordering::SeqCst);
                Ok("https://github.com/test/repo/pull/42".into())
            }
            ["pr", "view"] => {
                let actual = git(data, cwd, None, &["rev-parse", "HEAD"])?;
                Ok(serde_json::json!({"number":42,"state":if self.merged.load(Ordering::SeqCst){"MERGED"}else{"OPEN"},"headRefOid":actual.trim(),"headRefName":"task","baseRefName":"main","isCrossRepository":false,"mergeCommit":{"oid":"a".repeat(40)},"mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"Windows","conclusion":if self.fail.load(Ordering::SeqCst){"FAILURE"}else{"SUCCESS"}}]}).to_string())
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
