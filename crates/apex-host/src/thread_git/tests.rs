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
    fn mark(&self, id: &str, model: &str, built: bool) -> RecordOutcome {
        self.receipt(id, model, if built { "Deck built" } else { "Deck review passed" })
    }
    /// `line` and the checkout's HEAD, from agent `id` running `model` (empty: the tool's default).
    fn receipt(&self, id: &str, model: &str, line: &str) -> RecordOutcome {
        self.try_receipt(id, model, line).unwrap()
    }
    fn try_receipt(&self, id: &str, model: &str, line: &str) -> Result<RecordOutcome, String> {
        let backend = if model.is_empty() {
            serde_json::json!({"kind":"agent","tool":"claude_code","model":null})
        } else {
            serde_json::json!({"kind":"open_ai_compatible","base_url":"http://test.invalid","model":model})
        };
        let by = serde_json::from_value(serde_json::json!({"id":id,"display_name":id,"backend":backend})).unwrap();
        let text = format!("{line} {}", self.git(&["rev-parse", "HEAD"]));
        self.store.record("r", self.data.path(), self.checkout.path(), &by, &text)
    }
    /// The saved workflow, as a card names it.
    fn key(&self) -> WorkflowKey {
        WorkflowKey::of(&self.store.get("r").unwrap().unwrap())
    }
    fn reviewed_key(&self) -> WorkflowKey {
        self.reviewed();
        self.key()
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
    f.store.admit("r", &f.reviewed_key()).unwrap();
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
    f.store.admit("r", &f.reviewed_key()).unwrap();
    f.tick(&f.store, &remote).await;
    tokio::join!(f.tick(&f.store, &remote), async {
        remote.dispatch.notified().await;
        assert!(f.store.cancel("r", &f.key()).unwrap().cancelled);
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
    let initial = f.reviewed_key();
    for _ in 0..2 {
        f.store.admit("r", &initial).unwrap();
    }
    f.tick(&f.store, &remote).await;
    let waiting = f.state();
    let shown = f.key();
    for _ in 0..2 {
        f.store.cancel("r", &shown).unwrap();
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
    assert!(f.store.admit("r", &initial).is_err());
}
#[tokio::test]
async fn new_head_invalidates_review_and_alias_of_builder_model_cannot_approve() {
    let f = Fixture::new();
    let remote = Github::default();
    f.store.admit("r", &f.reviewed_key()).unwrap();
    f.tick(&f.store, &remote).await;
    f.git(&["commit", "--allow-empty", "-qm", "updated"]);
    f.tick(&f.store, &remote).await;
    assert_eq!(remote.puts.load(Ordering::SeqCst), 0);
    assert!(f.store.admit("r", &f.key()).is_err(), "the stopped merge of the old commit");
    f.mark("builder", "model-a", true);
    f.mark("alias", "model-a", false);
    assert!(f.state().workflow.unwrap().reviewer.is_none());
    f.mark("reviewer", "model-b", false);
    assert!(f.state().workflow.unwrap().reviewer.is_some());
    assert!(f.store.admit("r", &f.key()).is_ok());
}
#[tokio::test]
async fn failed_check_exposes_output_and_only_an_explicit_fix_marks_it_requested() {
    let f = Fixture::new();
    let remote = Github::default();
    remote.fail.store(true, Ordering::SeqCst);
    f.store.admit("r", &f.reviewed_key()).unwrap();
    f.tick(&f.store, &remote).await;
    f.tick(&f.store, &remote).await;
    let failed = f.store.fix("r", &f.key()).unwrap();
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
        f.store.admit("r", &f.reviewed_key()).unwrap();
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
    let shown = f.reviewed_key();
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
    f.store.admit_ready("r", &f.reviewed_key()).unwrap();
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
    g.store.admit("r", &g.reviewed_key()).unwrap();
    g.tick(&g.store, &changed).await;
    g.tick(&g.store, &changed).await;
    assert_eq!(g.store.get("r").unwrap().unwrap().phase, Phase::Checks);
    // After a restart with the checks still green, the card's merge goes through once.
    let h = Fixture::new();
    h.store.admit_ready("r", &h.reviewed_key()).unwrap();
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
    let shown = f.reviewed_key();
    f.store.admit_ready("r", &shown).unwrap();
    f.tick(&f.store, &remote).await;
    assert!(f.store.cancel("r", &f.key()).unwrap().cancelled);
    f.tick(&f.store, &remote).await;
    assert_eq!(f.store.get("r").unwrap().unwrap().phase, Phase::Cancelled);
    assert_eq!(remote.puts.load(Ordering::SeqCst), 0);
    // GitHub merged before the cancel was confirmed: the result is the merge.
    let g = Fixture::new();
    let landed = listed(&["Windows"]);
    g.store.admit_ready("r", &g.reviewed_key()).unwrap();
    g.tick(&g.store, &landed).await;
    landed.merged.store(true, Ordering::SeqCst);
    g.store.cancel("r", &g.key()).unwrap();
    g.tick(&g.store, &landed).await;
    let result = g.store.get("r").unwrap().unwrap();
    assert!(matches!(result.phase, Phase::Syncing | Phase::Merged), "{:?}", result.phase);
    assert!(result.detail.contains("Merged PR #42"), "{}", result.detail);
}

#[test]
fn a_builder_receipt_needs_no_named_model() {
    let f = Fixture::new();
    assert_eq!(f.receipt("builder", "", "Deck built"), RecordOutcome::Recorded);
    let w = f.store.get("r").unwrap().unwrap();
    assert_eq!((w.builder.as_str(), w.phase.clone(), w.head), ("builder", Phase::Ready, f.git(&["rev-parse", "HEAD"])));
    // Models are compared only when both are named; the reviewer is still another agent.
    f.receipt("builder", "", "Deck review passed");
    assert!(f.store.get("r").unwrap().unwrap().reviewer.is_none(), "the builder can't review its own commit");
    f.receipt("reviewer", "model-b", "Deck review passed");
    assert_eq!(f.store.get("r").unwrap().unwrap().reviewer.as_deref(), Some("reviewer"));
}

#[test]
fn a_merge_no_longer_waits_for_a_review() {
    let f = Fixture::new();
    f.mark("builder", "model-a", true);
    assert!(f.store.get("r").unwrap().unwrap().reviewer.is_none());
    f.store.admit("r", &f.key()).unwrap();
    assert_eq!(f.store.get("r").unwrap().unwrap().phase, Phase::Preparing);
}

#[test]
fn a_stale_key_is_refused_and_changes_nothing() {
    let f = Fixture::new();
    f.mark("builder", "model-a", true);
    let saved = f.store.get("r").unwrap().unwrap();
    let mut old_head = f.key();
    old_head.head = "b".repeat(40);
    let mut other_merge = f.key();
    other_merge.generation += 1;
    for stale in [&old_head, &other_merge] {
        assert!(f.store.admit_ready("r", stale).is_err(), "{stale:?}");
        assert!(f.store.cancel("r", stale).is_err(), "{stale:?}");
    }
    assert_eq!(f.store.get("r").unwrap().unwrap(), saved);
}

#[test]
fn ship_asks_for_the_merge_of_the_recorded_commit_only() {
    let f = Fixture::new();
    assert_eq!(f.receipt("builder", "", "Deck ship"), RecordOutcome::Recorded);
    let head = f.git(&["rev-parse", "HEAD"]);
    assert!(f.store.ship("r", "builder", &"c".repeat(40)).is_err(), "not the recorded commit");
    assert!(f.store.ship("r", "reviewer", &head).is_err(), "not its builder");
    assert_eq!(f.store.get("r").unwrap().unwrap().phase, Phase::Ready);
    f.store.ship("r", "builder", &head).unwrap();
    let w = f.store.get("r").unwrap().unwrap();
    assert_eq!((w.phase, w.generation), (Phase::Preparing, 1));
    f.store.ship("r", "builder", &head).unwrap();
    assert_eq!(f.store.get("r").unwrap().unwrap().generation, 1, "a second ship line shares the merge");
}

#[tokio::test]
async fn cancel_reports_whether_this_tap_started_cancelling() {
    let f = Fixture::new();
    f.mark("builder", "model-a", true);
    f.store.admit("r", &f.key()).unwrap();
    // Still preparing: no pull request yet.
    let first = f.store.cancel("r", &f.key()).unwrap();
    assert_eq!((first.cancelled, first.pr), (true, None));
    let again = f.store.cancel("r", &f.key()).unwrap();
    assert!(!again.cancelled, "a second tap moves nothing");
    // Waiting for checks on PR #42.
    let g = Fixture::new();
    g.mark("builder", "model-a", true);
    g.store.admit("r", &g.key()).unwrap();
    g.tick(&g.store, &listed(&["Windows", "Linux"])).await;
    let checks = g.store.get("r").unwrap().unwrap();
    assert_eq!((checks.phase.clone(), checks.pr), (Phase::Checks, Some(42)));
    let tap = g.store.cancel("r", &g.key()).unwrap();
    assert_eq!((tap.cancelled, tap.pr), (true, Some(42)));
}

#[test]
fn a_stale_cancel_during_syncing_moves_nothing() {
    let f = Fixture::new();
    f.mark("builder", "model-a", true);
    let mut syncing = f.store.get("r").unwrap().unwrap();
    syncing.phase = Phase::Syncing;
    syncing.pr = Some(42);
    f.store.edit(|rooms| { rooms.insert("r".into(), syncing.clone()); Ok(()) }).unwrap();
    let tap = f.store.cancel("r", &f.key()).unwrap();
    assert!(!tap.cancelled);
    assert_eq!(f.store.get("r").unwrap().unwrap().phase, Phase::Syncing, "the merge already landed");
}

#[test]
fn a_second_builder_waits_for_a_merge_in_flight() {
    let f = Fixture::new();
    f.mark("builder", "model-a", true);
    f.store.admit("r", &f.key()).unwrap();
    let in_flight = f.store.get("r").unwrap().unwrap();
    f.git(&["commit", "--allow-empty", "-qm", "the other agent's work"]);
    for line in ["Deck built", "Deck ship"] {
        assert_eq!(f.receipt("other", "", line), RecordOutcome::BusyOther { other: "builder".into() }, "{line}");
        assert_eq!(f.store.get("r").unwrap().unwrap(), in_flight, "{line}: nothing replaced the merge in flight");
    }
    // The same builder's new commit replaces a merge that is still waiting.
    assert_eq!(f.mark("builder", "model-a", true), RecordOutcome::Recorded);
    let replaced = f.store.get("r").unwrap().unwrap();
    assert_eq!((replaced.phase.clone(), replaced.head.clone()), (Phase::Ready, f.git(&["rev-parse", "HEAD"])));
    // While a merge is being confirmed with GitHub, even its builder waits.
    let mut confirming = replaced.clone();
    confirming.phase = Phase::Submitting;
    f.store.edit(|rooms| { rooms.insert("r".into(), confirming.clone()); Ok(()) }).unwrap();
    f.git(&["commit", "--allow-empty", "-qm", "later"]);
    assert!(f.try_receipt("builder", "", "Deck built").is_err());
    assert_eq!(f.store.get("r").unwrap().unwrap(), confirming);
}

#[tokio::test]
async fn a_poll_that_blocks_a_pending_merge_says_so_once() {
    let f = Fixture::new();
    f.mark("builder", "model-a", true);
    f.store.admit("r", &f.key()).unwrap();
    let preparing = f.store.get("r").unwrap().unwrap();
    // The local commit moved before anything reached GitHub.
    f.git(&["commit", "--allow-empty", "-qm", "moved"]);
    let blocked = f.store.advance(&Github::default(), "r", &preparing, f.data.path(), Some(f.checkout.path())).await.unwrap();
    assert_eq!(blocked.as_deref(), Some("Merge stopped before submission."));
    assert_eq!(f.store.get("r").unwrap().unwrap().phase, Phase::Blocked);
    let stale = f.store.advance(&Github::default(), "r", &preparing, f.data.path(), Some(f.checkout.path())).await.unwrap();
    assert_eq!(stale, None, "a second, stale poll changes nothing and reports nothing");
}

#[test]
fn the_marker_reads_built_ship_and_review_lines() {
    let sha = "d".repeat(40);
    assert_eq!(marker(&format!("Done.\nDeck built {sha}")), Some((Marker::Built, sha.as_str())));
    assert_eq!(marker(&format!("Done.\nDeck ship {sha}\n")), Some((Marker::Ship, sha.as_str())));
    assert_eq!(marker(&format!("Deck review passed {sha}")), Some((Marker::ReviewPassed, sha.as_str())));
    assert_eq!(marker(&format!("Deck ship {}", &sha[..39])), None);
    assert_eq!(marker(&format!("Deck ship {sha}\nmore")), None, "only the last line");
}

/// The Mac's main folder on `main`, whose `origin` fetches from a bare
/// repository standing in for GitHub (and pushes to GitHub, never reached),
/// kept inside the folder's `.git` so Linux's jailed git can see it,
/// the builder's task folder on `fix/x` with one commit, and the merge
/// commit GitHub made for it, already on GitHub's main.
struct Mac {
    data: TestDataDir,
    main: TestDataDir,
    store: ThreadGit,
    folder: PathBuf,
    merge: String,
}
const GITHUB: &str = "https://github.com/test/repo.git";
impl Mac {
    /// `files` are the task commit's changes; the main folder starts with README.md, notes.md and old.md.
    fn new(files: &[(&str, &str)]) -> Self {
        let (data, main) = (TestDataDir::new(), TestDataDir::new());
        let run = |cwd: &Path, args: &[&str]| -> String {
            let out = fixture_git_command().args(args).current_dir(cwd).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8(out.stdout).unwrap().trim().to_owned()
        };
        let m = main.path();
        run(m, &["init", "-qb", "main"]);
        let bare = m.join(".git").join("github.git");
        run(m, &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
        run(m, &["config", "user.name", "Fixture"]);
        run(m, &["config", "user.email", "test@example.invalid"]);
        run(m, &["config", "http.proxy", "http://127.0.0.1:9"]);
        for (file, text) in [("README.md", "readme\n"), ("notes.md", "notes\n"), ("old.md", "old\n")] {
            std::fs::write(m.join(file), text).unwrap();
        }
        run(m, &["add", "-A"]);
        run(m, &["commit", "-qm", "base"]);
        run(m, &["remote", "add", "origin", bare.to_str().unwrap()]);
        run(m, &["config", "remote.origin.pushurl", GITHUB]);
        run(m, &["push", "-q", bare.to_str().unwrap(), "main:main"]);
        // Git for Windows refuses Rust's \\?\ canonical form, so it gets the plain one.
        let folder = crate::assistant_git::external_path(&std::fs::canonicalize(m).unwrap()).with_file_name(format!("{}-task", m.file_name().unwrap().to_string_lossy()));
        run(m, &["worktree", "add", "-q", "-b", "fix/x", folder.to_str().unwrap()]);
        for (file, text) in files {
            let path = folder.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        run(&folder, &["add", "-A"]);
        run(&folder, &["commit", "-qm", "the fix"]);
        let head = run(&folder, &["rev-parse", "HEAD"]);
        run(&folder, &["push", "-q", bare.to_str().unwrap(), "fix/x:fix/x"]);
        // GitHub's merge commit: main and the fix, with the fix's tree.
        let tree = run(&folder, &["rev-parse", "HEAD^{tree}"]);
        let base = run(m, &["rev-parse", "main"]);
        let merge = run(m, &["commit-tree", &tree, "-p", &base, "-p", &head, "-m", "Merge pull request #42"]);
        run(m, &["push", "-q", bare.to_str().unwrap(), &format!("{merge}:refs/heads/main")]);
        let store = ThreadGit::new(data.path());
        store.put("r", serde_json::from_value(serde_json::json!({
            "root": folder.to_str().unwrap(), "branch": "fix/x", "repo": "test/repo", "head": head,
            "builder": "a", "builder_model": "", "reviewer": null, "phase": "syncing", "generation": 1,
            "pr": 42, "detail": "Merged PR #42 into main.", "result_oid": merge, "pushed": true, "fix_requested": false,
        })).unwrap()).unwrap();
        Self { data, main, store, folder, merge }
    }
    fn git(&self, args: &[&str]) -> String {
        let out = fixture_git_command().args(args).current_dir(self.main.path()).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }
    async fn sync(&self) -> Result<bool, Deferral> {
        self.sync_from(&self.store.get("r").unwrap().unwrap()).await
    }
    /// The merge worker's step for the workflow as it was when it started.
    async fn sync_from(&self, w: &Workflow) -> Result<bool, Deferral> {
        self.store.sync_with(&super::github::ProjectShell, self.data.path(), &|_| apex_core::CheckoutWriteGate::default(), Some(self.main.path()), "r", w).await
    }
}
impl Drop for Mac {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.folder);
    }
}

#[tokio::test]
async fn an_unrelated_local_edit_does_not_stop_the_update() {
    let mac = Mac::new(&[("src/x.rs", "fixed\n")]);
    let m = mac.main.path();
    std::fs::write(m.join("README.md"), "edited, not staged\n").unwrap();
    std::fs::write(m.join("notes.md"), "edited and staged\n").unwrap();
    std::fs::write(m.join("new.md"), "a new staged file\n").unwrap();
    mac.git(&["add", "notes.md", "new.md"]);
    mac.git(&["rm", "-q", "old.md"]);
    let before = mac.git(&["status", "--porcelain"]);
    let syncing = mac.store.get("r").unwrap().unwrap();
    assert_eq!(mac.sync().await, Ok(true));
    assert_eq!(mac.git(&["rev-parse", "HEAD"]), mac.merge, "the Mac's main is at the merge");
    assert_eq!(std::fs::read_to_string(m.join("src/x.rs")).unwrap(), "fixed\n");
    assert_eq!(mac.git(&["status", "--porcelain"]), before, "every local edit is still there");
    assert_eq!(mac.store.get("r").unwrap().unwrap().phase, Phase::Merged);
    assert_eq!(mac.sync_from(&syncing).await, Ok(false), "a second, stale sync changes nothing");
}

#[tokio::test]
async fn a_local_edit_to_a_merged_file_stops_the_update_and_names_it() {
    for staged in [false, true] {
        let mac = Mac::new(&[("README.md", "the fix's readme\n")]);
        std::fs::write(mac.main.path().join("README.md"), "my own edit\n").unwrap();
        if staged {
            mac.git(&["add", "README.md"]);
        }
        let base = mac.git(&["rev-parse", "HEAD"]);
        assert_eq!(mac.sync().await, Err(Deferral::Files(vec!["README.md".into()])), "staged: {staged}");
        assert_eq!(mac.git(&["rev-parse", "HEAD"]), base, "the Mac stays on the old commit");
        assert_eq!(std::fs::read_to_string(mac.main.path().join("README.md")).unwrap(), "my own edit\n");
    }
}

#[tokio::test]
async fn an_untracked_file_in_the_way_is_named() {
    let mac = Mac::new(&[("src/new.rs", "from the fix\n")]);
    std::fs::create_dir_all(mac.main.path().join("src")).unwrap();
    std::fs::write(mac.main.path().join("src/new.rs"), "my own new file\n").unwrap();
    assert_eq!(mac.sync().await, Err(Deferral::Files(vec!["src/new.rs".into()])));
}

#[tokio::test]
async fn a_main_with_local_commits_is_not_updated() {
    let mac = Mac::new(&[("src/x.rs", "fixed\n")]);
    mac.git(&["commit", "-q", "--allow-empty", "-m", "a local commit not on GitHub"]);
    assert_eq!(mac.sync().await, Err(Deferral::Reason("its main has commits that aren't on GitHub".into())));
    assert_eq!(mac.store.defer_sync("r", &mac.store.get("r").unwrap().unwrap(), &Deferral::Reason("its main has commits that aren't on GitHub".into())), Ok(true));
    assert_eq!(mac.store.get("r").unwrap().unwrap().phase, Phase::Merged);
}

#[test]
fn an_unexpected_git_error_strips_the_run_wrapper() {
    assert_eq!(super::github::refusal("git failed:\n\nfatal: unable to access the repository\nmore detail"), Deferral::Reason("fatal: unable to access the repository".into()));
    assert_eq!(
        super::github::refusal("git failed:\nUpdating 1234..5678\nerror: Your local changes to the following files would be overwritten by merge:\n\tREADME.md\n\tsrc/x.rs\nPlease commit your changes or stash them before you merge.\nAborting"),
        Deferral::Files(vec!["README.md".into(), "src/x.rs".into()])
    );
    assert_eq!(
        super::github::refusal("git failed:\n\nhint: Diverging branches can't be fast-forwarded.\nfatal: Not possible to fast-forward, aborting."),
        Deferral::Reason("its main has commits that aren't on GitHub".into())
    );
}

#[test]
fn an_older_client_naming_the_git_state_still_acts_on_the_card() {
    // An iPhone a build behind sends the folder's Git state, as before.
    let f = Fixture::new();
    f.mark("builder", "model-a", true);
    let state = serde_json::to_value(f.state()).unwrap();
    for kind in ["merge_ready", "cancel_merge", "fix_checks", "ask_fix"] {
        let action: ThreadGitAction = serde_json::from_value(serde_json::json!({ "kind": kind, "expected": state })).unwrap_or_else(|e| panic!("{kind}: {e}"));
        let (ThreadGitAction::MergeReady { expected } | ThreadGitAction::CancelMerge { expected } | ThreadGitAction::FixChecks { expected } | ThreadGitAction::AskFix { expected }) = action else { panic!("{kind}") };
        assert_eq!(expected.key().unwrap(), f.key(), "{kind}");
    }
    let key = serde_json::to_value(f.key()).unwrap();
    let action: ThreadGitAction = serde_json::from_value(serde_json::json!({ "kind": "merge_ready", "expected": key })).unwrap();
    let ThreadGitAction::MergeReady { expected } = action else { panic!() };
    assert_eq!(expected.key().unwrap(), f.key());
    // A state with no merge request on it names none.
    let mut bare = f.state();
    bare.workflow = None;
    let action: ThreadGitAction = serde_json::from_value(serde_json::json!({ "kind": "cancel_merge", "expected": bare })).unwrap();
    let ThreadGitAction::CancelMerge { expected } = action else { panic!() };
    assert!(expected.key().is_err());
}

#[test]
fn stale_external_observations_cannot_replace_a_newer_workflow() {
    let f = Fixture::new();
    f.mark("builder", "model-a", true);
    let original = f.store.get("r").unwrap().unwrap();
    let found = f.store.set_pr("r", &original, 42).unwrap();
    assert!(f.store.mark_closed("r", &original).is_err());
    assert_eq!(f.store.workflows().unwrap(), vec![("r".into(), found.clone())]);
    let merged_head = "b".repeat(40);
    let oid = "c".repeat(40);
    f.store.mark_observed_merge("r", &found, oid.clone(), merged_head.clone()).unwrap();
    assert!(f.store.workflows().unwrap().is_empty());
    let synced = f.store.get("r").unwrap().unwrap();
    assert_eq!((synced.phase, synced.head, synced.result_oid), (Phase::Syncing, merged_head, Some(oid)));
}
