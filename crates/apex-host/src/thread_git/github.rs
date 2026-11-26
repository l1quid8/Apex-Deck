use super::{git, repository, run, Checks, Deferral, Phase, ThreadGit, Workflow};
use crate::pr_watch::Observation;
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pull {
    number: u64,
    state: String,
    head_ref_oid: String,
    head_ref_name: String,
    base_ref_name: String,
    is_cross_repository: bool,
    merge_commit: Option<Oid>,
    merge_state_status: String,
    status_check_rollup: Vec<serde_json::Value>,
}
#[derive(Deserialize)]
struct Oid {
    oid: String,
}
enum Decision {
    Wait,
    Submit,
    Finish(Phase, String),
}
fn reconcile(w: &Workflow, pr: &Pull, local_current: bool) -> Decision {
    if pr.head_ref_oid != w.head
        || pr.head_ref_name != w.branch
        || pr.base_ref_name != "main"
        || pr.is_cross_repository
    {
        return Decision::Finish(
            Phase::Blocked,
            "The pull request changed. Review the new commit.".into(),
        );
    }
    if pr.state == "MERGED" {
        return Decision::Finish(
            Phase::Merged,
            format!(
                "Merged PR #{} into main at {}. Awaiting your test.",
                pr.number,
                pr.merge_commit
                    .as_ref()
                    .map(|c| c.oid.as_str())
                    .unwrap_or("unknown commit")
            ),
        );
    }
    if w.phase == Phase::Cancelling {
        return Decision::Finish(
            Phase::Cancelled,
            "Merge cancelled. The branch stays on GitHub.".into(),
        );
    }
    if !local_current || pr.state != "OPEN" {
        return Decision::Finish(
            Phase::Blocked,
            "The branch or PR changed. A new merge request is needed.".into(),
        );
    }
    if pr.merge_state_status == "DIRTY" {
        return Decision::Finish(
            Phase::Failed,
            format!("PR #{} conflicts with main.", pr.number),
        );
    }
    if let Some(check) = failing_checks(pr).first() {
        return Decision::Finish(
            Phase::Failed,
            format!(
                "{} reported {} on {}. {}",
                check.name, check.result, w.head, check.url
            ),
        );
    }
    if pr.merge_state_status != "CLEAN" || !checks_passed(pr) {
        return Decision::Wait;
    }
    Decision::Submit
}
struct FailedCheck<'a> {
    name: &'a str,
    result: &'a str,
    url: &'a str,
}
fn failing_checks(pr: &Pull) -> Vec<FailedCheck<'_>> {
    let mut failures = Vec::new();
    for check in &pr.status_check_rollup {
        let result = check["conclusion"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| check["state"].as_str())
            .unwrap_or("");
        if [
            "FAILURE",
            "ERROR",
            "TIMED_OUT",
            "CANCELLED",
            "ACTION_REQUIRED",
            "STARTUP_FAILURE",
            "STALE",
        ]
        .contains(&result)
        {
            failures.push(FailedCheck {
                name: check["name"]
                    .as_str()
                    .or_else(|| check["context"].as_str())
                    .unwrap_or("GitHub check"),
                result,
                url: check["detailsUrl"]
                    .as_str()
                    .or_else(|| check["targetUrl"].as_str())
                    .unwrap_or(""),
            });
        }
    }
    // The aggregate check often fails because another check failed.
    if failures
        .iter()
        .any(|check| check.name != "all-checks-passed")
    {
        failures.retain(|check| check.name != "all-checks-passed");
    }
    failures
}
fn checks_passed(pr: &Pull) -> bool {
    fn succeeded(check: &serde_json::Value) -> bool {
        check["conclusion"] == "SUCCESS" || check["state"] == "SUCCESS"
    }
    pr.status_check_rollup.iter().any(succeeded)
        && pr.status_check_rollup.iter().all(|check| {
            succeeded(check) || check["conclusion"] == "SKIPPED" || check["conclusion"] == "NEUTRAL"
        })
}
enum Required {
    /// Main has no required checks, so Deck has nothing to hold a merge to.
    None,
    Waiting(String),
    Passed,
}
/// Whether every check main requires has succeeded on this pull request.
async fn required(
    shell: &impl Shell,
    w: &Workflow,
    pr: &Pull,
    data: &Path,
    root: &Path,
) -> Result<Required, String> {
    let (owner, repo) = w.repo.split_once('/').ok_or("Invalid repository.")?;
    let query = "query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){ref(qualifiedName:\"refs/heads/main\"){refUpdateRule{requiredStatusCheckContexts}}}}";
    let raw = shell
        .run(
            data,
            root,
            "gh",
            &[
                "api",
                "graphql",
                "--hostname",
                "github.com",
                "-f",
                &format!("query={query}"),
                "-f",
                &format!("owner={owner}"),
                "-f",
                &format!("repo={repo}"),
            ],
        )
        .await?;
    let policy: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let contexts = policy
        .pointer("/data/repository/ref/refUpdateRule/requiredStatusCheckContexts")
        .and_then(|contexts| contexts.as_array());
    let Some(contexts) = contexts.filter(|contexts| !contexts.is_empty()) else {
        return Ok(Required::None);
    };
    for context in contexts {
        let name = context.as_str().ok_or("Invalid required check name.")?;
        if !pr.status_check_rollup.iter().any(|check| {
            (check["name"] == name && check["conclusion"] == "SUCCESS")
                || (check["context"] == name && check["state"] == "SUCCESS")
        }) {
            return Ok(Required::Waiting(name.into()));
        }
    }
    Ok(Required::Passed)
}
const PULL_FIELDS: &str = "number,state,headRefOid,headRefName,baseRefName,isCrossRepository,mergeCommit,mergeStateStatus,statusCheckRollup";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedPull {
    number: u64,
    state: String,
    head_ref_oid: String,
    is_cross_repository: bool,
}
/// Find a same-repository PR even if the builder opened it outside Deck.
pub(crate) async fn find_pr(data: &Path, w: &Workflow) -> Result<Option<u64>, String> {
    find_pr_with(&ProjectShell, data, w).await
}
async fn find_pr_with(
    shell: &impl Shell,
    data: &Path,
    w: &Workflow,
) -> Result<Option<u64>, String> {
    let gh_repo = format!("github.com/{}", w.repo);
    let raw = shell
        .run(
            data,
            Path::new(&w.root),
            "gh",
            &[
                "pr",
                "list",
                "--repo",
                &gh_repo,
                "--base",
                "main",
                "--head",
                &w.branch,
                "--state",
                "all",
                "--json",
                "number,state,headRefOid,isCrossRepository",
            ],
        )
        .await?;
    let pulls: Vec<ListedPull> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let mut same_repo = pulls.iter().filter(|pr| !pr.is_cross_repository);
    Ok(same_repo
        .clone()
        .find(|pr| pr.state == "OPEN")
        .or_else(|| {
            same_repo.find(|pr| {
                matches!(pr.state.as_str(), "MERGED" | "CLOSED") && pr.head_ref_oid == w.head
            })
        })
        .map(|pr| pr.number))
}
/// Read current GitHub state using the PR's own head, which can advance
/// independently of the latest Deck receipt.
pub(crate) async fn observe_pr(data: &Path, w: &Workflow) -> Result<Observation, String> {
    observe_pr_with(&ProjectShell, data, w).await
}
async fn view_pull(
    shell: &impl Shell,
    data: &Path,
    w: &Workflow,
    number: u64,
) -> Result<Pull, String> {
    let gh_repo = format!("github.com/{}", w.repo);
    let raw = shell
        .run(
            data,
            Path::new(&w.root),
            "gh",
            &[
                "pr",
                "view",
                &number.to_string(),
                "--repo",
                &gh_repo,
                "--json",
                PULL_FIELDS,
            ],
        )
        .await?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}
async fn observe_pr_with(
    shell: &impl Shell,
    data: &Path,
    w: &Workflow,
) -> Result<Observation, String> {
    let number = w.pr.ok_or("No pull request to observe.")?;
    let pr = view_pull(shell, data, w, number).await?;
    if pr.number != number
        || pr.head_ref_name != w.branch
        || pr.base_ref_name != "main"
        || pr.is_cross_repository
    {
        return Err("GitHub returned a pull request for a different branch or repository.".into());
    }
    match pr.state.as_str() {
        "MERGED" => {
            let oid = pr
                .merge_commit
                .ok_or("GitHub did not report the merge commit.")?
                .oid;
            return Ok(Observation::Merged {
                oid,
                head: pr.head_ref_oid,
            });
        }
        "CLOSED" => return Ok(Observation::Closed),
        "OPEN" => {}
        state => return Err(format!("Unknown GitHub pull request state: {state}")),
    }
    if pr.merge_state_status == "DIRTY" {
        return Ok(Observation::Conflict {
            head: pr.head_ref_oid,
        });
    }
    let failures = failing_checks(&pr);
    if !failures.is_empty() {
        let url = failures
            .iter()
            .find(|check| !check.url.is_empty())
            .map(|check| check.url.to_owned())
            .unwrap_or_else(|| format!("https://github.com/{}/pull/{number}/checks", w.repo));
        let names = failures.iter().map(|check| check.name.to_owned()).collect();
        return Ok(Observation::Failed {
            head: pr.head_ref_oid,
            names,
            url,
        });
    }
    Ok(if checks_passed(&pr) {
        Observation::Passed
    } else {
        Observation::Running
    })
}
/// Read-only: what GitHub says about the reviewed commit's pull request. It
/// pushes nothing, opens nothing and changes no saved state.
pub(super) async fn probe(shell: &impl Shell, w: &Workflow, data: &Path) -> Result<Checks, String> {
    let root = Path::new(&w.root);
    let gh_repo = format!("github.com/{}", w.repo);
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
    let Ok(number) = list.trim().parse::<u64>() else {
        return Ok(Checks::Unknown("This branch has no open pull request.".into()));
    };
    let pr = view_pull(shell, data, w, number).await?;
    // The same reading the merge worker uses, as if the merge had been asked for.
    let mut asked = w.clone();
    asked.phase = Phase::Checks;
    Ok(match reconcile(&asked, &pr, true) {
        Decision::Finish(Phase::Failed, detail) => Checks::Failed { pr: number, detail },
        Decision::Finish(_, detail) => Checks::Unknown(detail),
        Decision::Wait => Checks::Running,
        Decision::Submit => match required(shell, w, &pr, data, root).await? {
            Required::Passed => Checks::Passed { pr: number },
            Required::Waiting(_) => Checks::Running,
            Required::None => Checks::Unknown("GitHub reports no required status checks for main.".into()),
        },
    })
}
#[cfg(test)]
static FAKE_CHECKS: std::sync::Mutex<Vec<(String, Checks)>> = std::sync::Mutex::new(Vec::new());
/// Tests: what `checks` answers for commit `head`, instead of asking GitHub.
#[cfg(test)]
pub(crate) fn fake_checks(head: &str, answer: Checks) {
    let mut fakes = FAKE_CHECKS.lock().unwrap();
    fakes.retain(|(seen, _)| seen != head);
    fakes.push((head.to_owned(), answer));
}
/// Why git refused to fast-forward the main folder, read from its own output
/// (`run` wraps it as `git failed:\n<stdout>\n<stderr>`).
pub(crate) fn refusal(output: &str) -> Deferral {
    let text = output.strip_prefix("git failed:\n").unwrap_or(output);
    // "Your local changes to the following files ..." and "The following
    // untracked working tree files ..." both end so, then list the files.
    let mut files = Vec::new();
    let mut listing = false;
    for line in text.lines() {
        if line.contains("would be overwritten by merge:") {
            listing = true;
        } else if listing && (line.starts_with('\t') || line.starts_with("    ")) {
            files.push(line.trim().to_owned());
        } else {
            listing = false;
        }
    }
    if !files.is_empty() {
        return Deferral::Files(files);
    }
    if text.contains("Not possible to fast-forward") {
        return Deferral::Reason("its main has commits that aren't on GitHub".into());
    }
    Deferral::Reason(text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("git refused to update it").to_owned())
}
/// `probe` against the real project, with a failure to ask read as unknown.
pub async fn checks(data: &Path, w: &Workflow) -> Checks {
    #[cfg(test)]
    if let Some((_, answer)) = FAKE_CHECKS.lock().unwrap().iter().find(|(head, _)| *head == w.head) {
        return answer.clone();
    }
    probe(&ProjectShell, w, data)
        .await
        .unwrap_or_else(|why| Checks::Unknown(why.chars().take(300).collect()))
}
pub(super) trait Shell {
    async fn run(
        &self,
        data: &Path,
        cwd: &Path,
        program: &str,
        args: &[&str],
    ) -> Result<String, String>;
}
pub(super) struct ProjectShell;
impl Shell for ProjectShell {
    async fn run(
        &self,
        data: &Path,
        cwd: &Path,
        program: &str,
        args: &[&str],
    ) -> Result<String, String> {
        run(data, cwd, program, args).await
    }
}
impl ThreadGit {
    /// Fast-forwards the Mac's main folder to GitHub's merge commit, keeping
    /// local edits the merge doesn't touch, then deletes the merged branch on
    /// GitHub. `true` only when this call moved the workflow to Merged.
    /// `fallback` is the thread's folder, for when the task folder is gone.
    pub async fn sync(&self, host: &crate::host::Host, room: &str, w: &Workflow, fallback: Option<&Path>) -> Result<bool, Deferral> {
        self.sync_with(&ProjectShell, host.data_dir(), &|main| host.checkout_gate(main), fallback, room, w).await
    }
    pub(super) async fn sync_with(
        &self,
        shell: &impl Shell,
        data: &Path,
        gate: &(dyn Fn(&Path) -> apex_core::CheckoutWriteGate + Sync),
        fallback: Option<&Path>,
        room: &str,
        w: &Workflow,
    ) -> Result<bool, Deferral> {
        let root = Path::new(&w.root);
        let sha = w
            .result_oid
            .as_deref()
            .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("GitHub didn't report the merge commit")?;
        // Any checkout of the repository lists its worktrees.
        let lister = if root.is_dir() { root } else { fallback.ok_or("the task folder is gone and the thread has no folder")? };
        let worktrees = shell.run(data, lister, "git", &["worktree", "list", "--porcelain", "-z"]).await?;
        let main = worktrees
            .split("\0\0")
            .find_map(|block| {
                let mut fields = block.split('\0');
                let path = fields.next()?.strip_prefix("worktree ")?;
                fields
                    .any(|f| f == "branch refs/heads/main")
                    .then(|| PathBuf::from(path))
            })
            .ok_or("main isn't checked out on this Mac")?;
        if main == root {
            return Err("the task folder itself is on main".into());
        }
        let main_gate = gate(&main);
        let _lease = main_gate
            .acquire(format!("thread-git-sync:{room}"), Default::default())
            .await
            .map_err(|e| format!("{e:?}"))?;
        let read = |args: &[&str]| git(data, &main, None, args).map(|s| s.trim().to_string());
        if read(&["symbolic-ref", "--short", "HEAD"])? != "main" {
            return Err("the main folder isn't on main".into());
        }
        // The repository is named by where it pushes, as receipts are.
        if repository(&read(&["remote", "get-url", "--push", "origin"])?)? != w.repo {
            return Err("the main folder has a different origin".into());
        }
        shell.run(data, &main, "git", &["fetch", "--no-tags", "origin", "refs/heads/main"]).await?;
        if read(&["merge-base", "--is-ancestor", sha, "FETCH_HEAD"]).is_err() {
            return Err("GitHub's main doesn't have the merge yet".into());
        }
        // A fast-forward keeps staged and unstaged edits to files the merge
        // doesn't touch; git refuses, naming them, when it would change them.
        if read(&["merge-base", "--is-ancestor", sha, "HEAD"]).is_err() {
            if let Err(why) = shell.run(data, &main, "git", &["merge", "--ff-only", sha]).await {
                return Err(refusal(&why));
            }
        }
        // Delete only the remote branch that still points to the merged head.
        let remote_ref = format!("refs/heads/{}", w.branch);
        let mut detail = format!("{} Local main contains this merge.", w.detail);
        if let Ok(remote) = shell.run(data, &main, "git", &["ls-remote", "origin", &remote_ref]).await {
            if remote.split_whitespace().next() == Some(&w.head) {
                let lease = format!("--force-with-lease={remote_ref}:{}", w.head);
                if let Err(e) = shell.run(data, &main, "git", &["push", &lease, "origin", &format!(":{remote_ref}")]).await {
                    detail.push_str(&format!(" Remote branch retained: {e}"));
                }
            }
        }
        Ok(self.update(room, w, |j| {
            j.phase = Phase::Merged;
            j.detail = detail;
        })?)
    }
    pub fn defer_sync(&self, room: &str, w: &Workflow, why: &Deferral) -> Result<bool, String> {
        self.update(room, w, |j| {
            j.phase = Phase::Merged;
            j.detail = format!("{} Local update deferred: {why}", w.detail);
        })
    }
    pub(super) async fn advance(
        &self,
        shell: &impl Shell,
        room: &str,
        w: &Workflow,
        data: &Path,
        mounted: Option<&Path>,
    ) -> Result<Option<String>, String> {
        let root = Path::new(&w.root);
        let gh_repo = format!("github.com/{}", w.repo);
        // Moves a pending merge into Blocked; the detail, only when this call did it.
        let block = |prior: &Workflow, detail: String| -> Result<Option<String>, String> {
            let moved = self.update(room, prior, |j| {
                j.phase = Phase::Blocked;
                j.detail = detail.clone();
            })?;
            Ok(moved.then_some(detail))
        };
        // No checkout or credentials inferred from another room on recovery.
        let local = if let Some(cwd) = mounted {
            let head = shell.run(data, cwd, "git", &["rev-parse", "HEAD"]).await?;
            let branch = shell
                .run(data, cwd, "git", &["symbolic-ref", "--short", "HEAD"])
                .await
                .unwrap_or_default();
            let repo = shell
                .run(data, cwd, "git", &["remote", "get-url", "--push", "origin"])
                .await?;
            shell
                .run(data, cwd, "git", &["rev-parse", "--show-toplevel"])
                .await?
                == w.root
                && head == w.head
                && branch == w.branch
                && repository(&repo).ok().as_ref() == Some(&w.repo)
        } else {
            false
        };
        if w.pr.is_none() && (w.phase == Phase::Cancelling || !local) {
            if !local {
                return block(w, "Merge stopped before submission.".into());
            }
            self.update(room, w, |j| {
                j.phase = Phase::Cancelled;
                j.detail = "Merge stopped before submission.".into();
            })?;
            return Ok(None);
        }
        if w.phase == Phase::Preparing {
            if !local {
                return block(w, "The local commit changed. Review the new commit.".into());
            }
            let state = crate::git_changes::status(data, root)?;
            if git(
                data,
                root,
                None,
                &["cat-file", "-e", &format!("{}:tsconfig.json", w.head)],
            )
            .is_ok()
            {
                if let Err(why) = crate::git_changes::check_commit(
                    data,
                    root,
                    &state,
                    &crate::git_changes::TYPECHECK,
                )
                .await
                {
                    self.update(room, w, |j| {
                        j.phase = Phase::Failed;
                        j.local_check_failed = true;
                        j.detail = why.chars().take(6000).collect();
                    })?;
                    return Ok(None);
                }
            }
            if self.get(room)?.as_ref() != Some(w) {
                return Ok(None);
            }
        }
        if w.pr.is_none() {
            let url = shell
                .run(
                    data,
                    root,
                    "git",
                    &["remote", "get-url", "--push", "origin"],
                )
                .await?;
            if repository(&url)? != w.repo {
                return Err("Origin changed.".into());
            }
            shell
                .run(
                    data,
                    root,
                    "git",
                    &["push", &url, &format!("{}:refs/heads/{}", w.head, w.branch)],
                )
                .await?;
            let list = shell
                .run(
                    data,
                    root,
                    "gh",
                    &[
                        "pr",
                        "list",
                        "--repo",
                        &gh_repo,
                        "--base",
                        "main",
                        "--head",
                        &w.branch,
                        "--state",
                        "open",
                        "--json",
                        "number,isCrossRepository",
                        "--jq",
                        "[.[] | select(.isCrossRepository == false)][0].number // empty",
                    ],
                )
                .await?;
            let n = if list.is_empty() {
                let url = shell
                    .run(
                        data,
                        root,
                        "gh",
                        &[
                            "pr",
                            "create",
                            "--repo",
                            &gh_repo,
                            "--head",
                            &w.branch,
                            "--base",
                            "main",
                            "--title",
                            &w.branch,
                            "--body",
                            "Reviewed in the Apex Deck thread.",
                        ],
                    )
                    .await?;
                url.trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .unwrap_or("")
                    .parse::<u64>()
            } else {
                list.parse::<u64>()
            }
            .map_err(|_| "GitHub returned an invalid PR number.")?;
            self.update(room, w, |j| {
                j.pr = Some(n);
                j.pushed = true;
                j.phase = Phase::Checks;
                j.detail = format!("Waiting for checks on PR #{n}…");
            })?;
            return Ok(None);
        }
        if w.phase == Phase::Preparing {
            self.update(room, w, |j| {
                j.phase = Phase::Checks;
                j.detail = "Waiting for checks…".into();
            })?;
            return Ok(None);
        }
        let number = w.pr.unwrap();
        let pr = view_pull(shell, data, w, number).await?;
        match reconcile(w, &pr, local) {
            // GitHub works mergeability out lazily; UNKNOWN is not an answer yet.
            Decision::Wait if w.ready_only && pr.merge_state_status != "UNKNOWN" => {
                self.update(room, w, |job| {
                    job.phase = Phase::Cancelled;
                    job.detail = "The checks changed after the merge was asked for. Nothing was merged.".into();
                })?;
            }
            Decision::Wait => {}
            Decision::Finish(Phase::Blocked, detail) => return block(w, detail),
            Decision::Finish(phase, mut detail) => {
                if phase == Phase::Failed && pr.merge_state_status != "DIRTY" {
                    // Fetch only the failing Actions run for this PR's commit.
                    let run_prefix = format!("https://{gh_repo}/actions/runs/");
                    if let Some(run_id) = failing_checks(&pr).iter().find_map(|check| {
                        check
                            .url
                            .strip_prefix(&run_prefix)?
                            .split('/')
                            .next()?
                            .parse::<u64>()
                            .ok()
                    }) {
                        if let Ok(log) = shell
                            .run(
                                data,
                                root,
                                "gh",
                                &[
                                    "run",
                                    "view",
                                    &run_id.to_string(),
                                    "--repo",
                                    &w.repo,
                                    "--log-failed",
                                ],
                            )
                            .await
                        {
                            let tail = log.lines().rev().take(24).collect::<Vec<_>>();
                            detail.push('\n');
                            detail.push_str(
                                &tail
                                    .into_iter()
                                    .rev()
                                    .collect::<Vec<_>>()
                                    .join("\n")
                                    .chars()
                                    .take(6000)
                                    .collect::<String>(),
                            );
                        }
                    }
                }
                self.update(room, w, |j| {
                    j.phase = phase;
                    if j.phase == Phase::Merged {
                        j.result_oid = pr.merge_commit.as_ref().map(|c| c.oid.clone());
                        if j.result_oid.is_some() {
                            j.phase = Phase::Syncing;
                        }
                    }
                    j.detail = detail;
                })?;
            }
            Decision::Submit => {
                match required(shell, w, &pr, data, root).await? {
                    Required::None => {
                        return block(w, "GitHub reports no required status checks for main. Configure required checks before merging from Deck.".into());
                    }
                    Required::Waiting(name) => {
                        self.update(room, w, |job| {
                            if job.ready_only {
                                job.phase = Phase::Cancelled;
                                job.detail = format!("Required check {name} no longer passes. Nothing was merged.");
                            } else {
                                job.detail = format!("Waiting for required check: {name}.");
                            }
                        })?;
                        return Ok(None);
                    }
                    Required::Passed => {}
                }
                // Serialize dispatch with cancellation; retries use GitHub's exact-SHA compare.
                let mut submitting = w.clone();
                submitting.phase = Phase::Submitting;
                submitting.detail = "Confirming merge with GitHub…".into();
                if !self.update(room, w, |job| *job = submitting.clone())? {
                    return Ok(None);
                }
                let result = shell
                    .run(
                        data,
                        root,
                        "gh",
                        &[
                            "api",
                            "--hostname",
                            "github.com",
                            "--method",
                            "PUT",
                            &format!("repos/{}/pulls/{number}/merge", w.repo),
                            "-f",
                            &format!("sha={}", w.head),
                            "-f",
                            "merge_method=merge",
                        ],
                    )
                    .await;
                if let Err(why) = result {
                    // A transport timeout can follow a successful write. Re-read
                    // the PR before retrying. A definitive refusal stops dispatch.
                    let refused = ["HTTP 403", "HTTP 404", "HTTP 405", "HTTP 409", "HTTP 422"]
                        .iter()
                        .any(|status| why.contains(status));
                    let detail: String = why.chars().take(1500).collect();
                    if refused {
                        return block(&submitting, detail);
                    }
                    self.update(room, &submitting, |job| job.detail = detail)?;
                }
            }
        }
        Ok(None)
    }
    /// One step of the merge worker. Returns why, when this step stopped a
    /// pending merge as Blocked, so the thread can be told once.
    pub async fn poll(&self, room: &str, job: Workflow, data: &Path, mounted: Option<&Path>) -> Option<String> {
        match self.advance(&ProjectShell, room, &job, data, mounted).await {
            Ok(blocked) => blocked,
            Err(why) => {
                let _ = self.update(room, &job, |j| {
                    j.detail = format!(
                        "Waiting for GitHub · {}",
                        why.chars().take(1500).collect::<String>()
                    )
                });
                None
            }
        }
    }
}

#[cfg(test)]
mod tests;
