//! Shipping a pull request from the assistant's conversation instead of the
//! worker's thread: the person's own words there ("ship PR 84") or their tap
//! on the card. Either is tied to the thread that built the pull request, its
//! number and its head commit, and a newer commit ends it.
//!
//! The assistant's model takes no part: the Host reads the person's message
//! itself, so nothing a model, a file or a pull request says can ask for a merge.

use crate::personal::PersonalAssistant;
use crate::personal_workspace::ProjectTools;
use crate::thread_git::{Phase, Shown, ThreadGitAction, Workflow, WorkflowKey};
use crate::Host;
use serde::Deserialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Pull requests one message, or one look at the conversation, may name.
const MAX_ASKED: usize = 3;
/// How far back in an assistant's conversation a pull request's card is kept.
const RECENT_REPLIES: usize = 8;
/// How long one GitHub answer about where a pull request lives is reused:
/// briefly while it can still be shipped, longer once there is nothing to do.
const FIND_TTL: Duration = Duration::from_secs(20);
const SETTLED_TTL: Duration = Duration::from_secs(300);
/// The first line of a refusal, short enough to read in a conversation.
fn brief(why: &str) -> String {
    let line = why.lines().find(|line| !line.trim().is_empty()).unwrap_or("it was refused").trim();
    if line.chars().count() > 300 { format!("{}…", line.chars().take(300).collect::<String>()) } else { line.to_owned() }
}

fn short(sha: &str) -> &str {
    sha.get(..8).unwrap_or(sha)
}

/// A pull request number, written `84`, `#84` or `pr84`. A link is never
/// read as one: it names a repository, and the number alone would be looked
/// for in the assistant's own projects.
fn number(token: &str) -> Option<u64> {
    if token.contains('/') {
        return None;
    }
    let digits = token.strip_prefix("pr").unwrap_or(token).trim_start_matches('#');
    (!digits.is_empty() && digits.len() <= 7 && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.parse().ok()).flatten().filter(|n| *n > 0)
}

/// The pull requests one line tells Deck to ship. Deliberately narrow: an
/// instruction that leads with the verb and ends at the numbers. A question,
/// a condition ("after I test") or anything else it doesn't recognise is no
/// instruction at all, and the line goes to the assistant as ordinary words.
fn asked_line(line: &str, name: &[String]) -> Vec<u64> {
    if line.contains('?') || line.trim_start().starts_with('>') {
        return Vec::new();
    }
    let lower = line.to_lowercase();
    // (word, whether a sentence break followed it)
    let words: Vec<(&str, bool)> = lower
        .split_whitespace()
        .map(|raw| {
            let word = raw.trim_start_matches(['(', '"', '\'', '*', '`', '“']);
            let core = word.trim_end_matches(['.', ',', ';', '!', ':', ')', '"', '\'', '*', '`', '”']);
            (core, word[core.len()..].contains(['.', ',', ';', '!']))
        })
        .filter(|(word, _)| !word.is_empty())
        .collect();
    let word = |at: usize| words.get(at).map(|(word, _)| *word);
    let mut at = 0;
    // Greeting, the assistant's name, a yes.
    loop {
        let Some(next) = word(at) else { return Vec::new() };
        let pair = (next, word(at + 1).unwrap_or(""));
        if matches!(pair, ("go", "ahead") | ("looks", "good") | ("you", "can") | ("all", "good")) {
            at += 2;
        } else if (at == 0 && name.len() == 1 && next.strip_prefix('@') == Some(name[0].as_str()))
            || (at < name.len() && name[at] == next)
            || matches!(next, "ok" | "okay" | "yes" | "yep" | "yeah" | "sure" | "great" | "good" | "perfect" | "please" | "pls" | "now" | "so" | "then" | "and" | "alright" | "cool" | "nice" | "thanks" | "lgtm" | "approved" | "hey" | "hi" | "let's" | "lets")
        {
            at += 1;
        } else {
            break;
        }
    }
    if !matches!(word(at), Some("ship" | "merge" | "land")) || words[at].1 {
        return Vec::new();
    }
    at += 1;
    if word(at) == Some("it") && !words[at].1 {
        at += 1;
    }
    let mut found = Vec::new();
    while let Some(next) = word(at) {
        let marker = match (next, word(at + 1)) {
            ("pull", Some("request" | "requests")) => 2,
            ("pr" | "prs", _) => 1,
            _ => 0,
        };
        let Some(pr) = word(at + marker).and_then(number) else {
            if marker > 0 {
                return Vec::new();
            }
            break;
        };
        found.push(pr);
        at += marker + 1;
        // "84, 85", "84 and 85": another one follows. Otherwise the list is over.
        let joined = matches!(word(at), Some("and" | "&" | "+"));
        let after = at + usize::from(joined);
        let more = match (word(after), word(after + 1)) {
            (Some("pull"), Some("request" | "requests")) | (Some("pr" | "prs"), _) => true,
            (Some(next), _) => number(next).is_some(),
            (None, _) => false,
        };
        if more {
            at = after;
        } else {
            at = after;
            break;
        }
    }
    if found.is_empty() {
        return Vec::new();
    }
    // What may still follow: where it merges, a please, and what to do after
    // ("then continue"). Anything else, such as a condition or a second
    // thought after a comma, means this is not a plain instruction.
    while let Some(next) = word(at) {
        let step = match (next, word(at + 1)) {
            ("to" | "into" | "on", Some("main")) => 2,
            ("thank", Some("you")) => 2,
            ("now" | "please" | "pls" | "thanks" | "it" | "and", _) => 1,
            ("then", Some("continue")) if at + 2 == words.len() => 2,
            ("then", Some("update")) if words[at+2..].iter().map(|(w, _)| *w).eq(["the", "changelog"]) => 4,
            _ => return Vec::new(),
        };
        at += step;
    }
    found.dedup();
    found
}

/// The pull requests the person's message tells Deck to ship, in order.
/// `name` is the assistant's, which may open the message.
/// The message must be that one line and nothing else: words on another line
/// (a condition, a pasted block, a Plan-only preface) could change its meaning.
pub(crate) fn asked(text: &str, name: &str) -> Vec<u64> {
    let name: Vec<String> = name.to_lowercase().split_whitespace().map(|part| part.trim_end_matches([',', ':']).to_owned()).collect();
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let (Some(line), None) = (lines.next(), lines.next()) else { return Vec::new() };
    let mut prs = Vec::new();
    for pr in asked_line(line, &name) {
        if !prs.contains(&pr) {
            prs.push(pr);
        }
    }
    prs.truncate(MAX_ASKED);
    prs
}

/// Pull request numbers an assistant's reply mentions: "PR #84", "PR 84", a GitHub link.
pub(crate) fn mentioned(text: &str) -> Vec<u64> {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().map(|raw| raw.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '#')).collect();
    let mut prs = Vec::new();
    for (at, word) in words.iter().copied().enumerate() {
        let pr = if word.starts_with("pr") && word.len() > 2 {
            number(word)
        } else if matches!(word, "pr" | "request") && (word == "pr" || at.checked_sub(1).and_then(|before| words.get(before)) == Some(&"pull")) {
            words.get(at + 1).copied().and_then(number)
        } else {
            None
        };
        if let Some(pr) = pr.filter(|pr| !prs.contains(pr)) {
            prs.push(pr);
        }
    }
    prs
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pull {
    state: String,
    head_ref_name: String,
    head_ref_oid: String,
    base_ref_name: String,
    is_cross_repository: bool,
}

/// Where a pull request lives on this Mac.
#[derive(Clone, Debug)]
enum Lookup {
    /// A thread's merge request for the pull request's current head commit.
    /// `adopt`: the agent whose task folder holds it, when the thread has no
    /// saved merge request for that commit yet.
    Found { room: String, workflow: Box<Workflow>, adopt: Option<(String, PathBuf)> },
    /// Already merged; what Deck knows about it.
    Merged(String),
    No(String),
}

#[derive(Default)]
pub struct ShipRelay {
    finds: Mutex<HashMap<(String, u64, bool), (Instant, Lookup)>>,
}

#[cfg(test)]
static FAKE_PULLS: Mutex<Vec<(u64, serde_json::Value)>> = Mutex::new(Vec::new());
/// Tests: what GitHub answers for pull request `pr`, instead of asking it.
#[cfg(test)]
pub(crate) fn fake_pull(pr: u64, answer: serde_json::Value) {
    let mut fakes = FAKE_PULLS.lock().unwrap();
    fakes.retain(|(seen, _)| *seen != pr);
    fakes.push((pr, answer));
}

impl Host {
    async fn ship_pull(&self, cwd: &std::path::Path, repo: &str, pr: u64) -> Result<Pull, String> {
        #[cfg(test)]
        if let Some((_, answer)) = FAKE_PULLS.lock().unwrap().iter().find(|(seen, _)| *seen == pr) {
            return serde_json::from_value(answer.clone()).map_err(|e| e.to_string());
        }
        let raw = crate::git_changes::run(
            self.data_dir(),
            cwd,
            "gh",
            &["pr", "view", &pr.to_string(), "--repo", &format!("github.com/{repo}"), "--json", "state,headRefName,headRefOid,baseRefName,isCrossRepository"],
        )
        .await?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }

    /// The thread that built pull request `pr`, looked for in the assistant's
    /// projects (`full_only`: those with saved Full tools). Reads only.
    async fn ship_find(self: &Arc<Self>, assistant: &PersonalAssistant, pr: u64, full_only: bool) -> Lookup {
        let cached = (assistant.id.clone(), pr, full_only);
        if let Some((at, found)) = self.ship_relay.finds.lock().unwrap().get(&cached) {
            let ttl = match found {
                Lookup::Found { .. } => FIND_TTL,
                // Not shippable now, but a push or a finished turn can change that.
                Lookup::No(_) => FIND_TTL * 3,
                Lookup::Merged(_) => SETTLED_TTL,
            };
            if at.elapsed() < ttl {
                return found.clone();
            }
        }
        let found = self.ship_find_now(assistant, pr, full_only).await;
        self.ship_relay.finds.lock().unwrap().insert(cached, (Instant::now(), found.clone()));
        found
    }

    async fn ship_find_now(self: &Arc<Self>, assistant: &PersonalAssistant, pr: u64, full_only: bool) -> Lookup {
        let data = self.data_dir().to_path_buf();
        let folders: Vec<_> = assistant.projects.iter().map(|binding| (PathBuf::from(&binding.project.cwd), binding.tools == ProjectTools::Full)).collect();
        if folders.is_empty() || (full_only && !folders.iter().any(|(_, full)| *full)) {
            return Lookup::No(if full_only { format!("none of {}'s projects has saved Full access", assistant.name) } else { format!("{} has no project on this Mac", assistant.name) });
        }
        // A repository is named by where it pushes, as receipts are.
        let repos = tokio::task::spawn_blocking(move || {
            let mut repos: Vec<(String, PathBuf, bool)> = Vec::new();
            for (cwd, full) in folders {
                let named = crate::git_changes::git(&data, &cwd, None, &["remote", "get-url", "--push", "origin"]).ok().and_then(|url| crate::thread_git::repository(url.trim()).ok());
                let Some(repo) = named else { return Err("A bound project could not be identified.".to_owned()); };
                if let Some((_, _, authorized)) = repos.iter_mut().find(|(seen, _, _)| *seen == repo) {
                    *authorized |= full;
                } else {
                    repos.push((repo, cwd, full));
                }
            }
            Ok(repos)
        }).await;
        let repos = match repos { Ok(Ok(repos)) => repos, Ok(Err(why)) => return Lookup::No(why), Err(_) => return Lookup::No("Project lookup failed.".into()) };
        let mut pulls = Vec::new();
        for (repo, cwd, full) in repos {
            match self.ship_pull(&cwd, &repo, pr).await {
                Ok(pull) => pulls.push((repo, pull, full)),
                // Only GitHub's own "no such pull request" rules a repository out.
                Err(why) if why.contains("Could not resolve to a PullRequest") || why.contains("no pull requests found") => {}
                Err(_) => return Lookup::No(format!("GitHub couldn't be read for {repo} just now")),
            }
        }
        if pulls.iter().filter(|(_, pull, _)| pull.state == "OPEN").count() > 1 {
            let names = pulls.iter().map(|(repo, _, _)| repo.as_str()).collect::<Vec<_>>().join(" and ");
            return Lookup::No(format!("{names} each have a PR #{pr}; ship it from its own thread"));
        }
        let Some((repo, pull, full)) = pulls.iter().find(|(_, pull, _)| pull.state == "OPEN").or(pulls.first()).cloned() else {
            return Lookup::No(format!("GitHub has no PR #{pr} in {}'s projects", assistant.name));
        };
        if full_only && !full {
            return Lookup::No(format!("{repo} lacks saved Full access for {}", assistant.name));
        }
        let saved = self.thread_git.find(&repo, &pull.head_ref_name).unwrap_or_default();
        match pull.state.as_str() {
            "OPEN" => {}
            "MERGED" => {
                let known = saved.iter().find(|(_, w)| w.head == pull.head_ref_oid && w.phase == Phase::Merged).map(|(_, w)| w.detail.clone());
                return Lookup::Merged(known.unwrap_or_else(|| format!("PR #{pr} is already merged.")));
            }
            _ => return Lookup::No("it was closed without merging".into()),
        }
        if pull.is_cross_repository {
            return Lookup::No("it comes from a fork, and Deck merges only branches its own threads built".into());
        }
        if pull.base_ref_name != "main" {
            return Lookup::No(format!("it merges into {}, not main", pull.base_ref_name));
        }
        if let Some((room, workflow)) = saved.iter().find(|(_, w)| w.head == pull.head_ref_oid && w.phase != Phase::Merged).cloned() {
            return Lookup::Found { room, workflow: Box::new(workflow), adopt: None };
        }
        // No receipt for this commit: the task folder that holds it names its thread.
        let folder = match self.task_branches.owner(&repo, &pull.head_ref_name) {
            Ok(Some(folder)) => folder,
            Ok(None) if saved.is_empty() => return Lookup::No("no Deck thread on this Mac built it".into()),
            Ok(None) => return Lookup::No("it has a newer commit than the one its thread finished with".into()),
            Err(why) => return Lookup::No(why),
        };
        let (data, path) = (self.data_dir().to_path_buf(), folder.path.clone());
        let head = tokio::task::spawn_blocking(move || crate::git_changes::git(&data, &path, None, &["rev-parse", "HEAD"])).await.ok().and_then(Result::ok).map(|head| head.trim().to_owned());
        if head.as_deref() != Some(pull.head_ref_oid.as_str()) {
            return Lookup::No(format!("its task folder is at commit {}, but GitHub has {}", head.as_deref().map(short).unwrap_or("unknown"), short(&pull.head_ref_oid)));
        }
        let root = crate::assistant_git::external_path(&folder.path).to_string_lossy().into_owned();
        let workflow = Workflow::draft(root, folder.branch.clone(), repo, pull.head_ref_oid.clone(), folder.agent.clone());
        Lookup::Found { room: folder.thread.clone(), workflow: Box::new(workflow), adopt: Some((folder.agent, folder.path)) }
    }

    fn ship_post(&self, assistant: &str, event: Option<&str>, text: String) {
        let posted = self.change_assistant(assistant, |a| {
            a.post("system", "update", text, None, event.map(str::to_owned), crate::personal::now());
            Ok(())
        });
        if let Err(why) = posted {
            eprintln!("[apex-deck] could not post the ship result to {assistant}: {why}");
        }
    }

    /// How a merge asked for from an assistant's conversation ended, said there too.
    pub(crate) fn ship_report(&self, w: &Workflow, text: &str) {
        if let Some(assistant) = &w.relayed_by {
            self.ship_post(assistant, None, text.to_owned());
        }
    }

    /// Ask for the merge of pull request `pr` on the person's behalf.
    /// `by_words`: they said it to the assistant, which needs the assistant's
    /// saved Full access; otherwise they tapped the card, which shows `head`.
    /// What is now happening, or why nothing was merged.
    async fn ship_now(self: &Arc<Self>, assistant_id: &str, pr: u64, shown: Option<(&str, &str)>, by_words: bool) -> Result<String, String> {
        let assistant = self.personal_get(assistant_id)?;
        if by_words {
            if assistant.paused || assistant.archived_at.is_some() {
                return Err(format!("{} is paused. Use the Ship it button in the pull request's thread.", assistant.name));
            }
            if !crate::personal::permissions::full_access(&assistant) {
                return Err(format!("{} doesn't have saved Full access, so Deck won't merge on words said here. Tap Ship it on the card instead.", assistant.name));
            }
        }
        self.ship_relay.finds.lock().unwrap().retain(|(owner, number, _), _| !(owner == assistant_id && *number == pr));
        let (room, mut workflow, adopt) = match self.ship_find(&assistant, pr, by_words).await {
            Lookup::Found { room, workflow, adopt } => (room, *workflow, adopt),
            Lookup::Merged(detail) => return Ok(detail),
            Lookup::No(why) => return Err(format!("{why}. Nothing was merged.")),
        };
        if shown.is_some_and(|(repo, _)| repo != workflow.repo) { return Err("The repository changed. Refresh the card.".into()); }
        if shown.is_some_and(|(_, head)| head != workflow.head) {
            return Err("it has a new commit since this card was shown. Nothing was merged.".into());
        }
        if self.handle(&room).is_err() {
            self.open_saved_room(&room)?;
        }
        if let Some((agent, folder)) = adopt {
            // Never over another merge in flight, or another agent's merge request.
            if let Some(other) = self.thread_git.get(&room)?.filter(|w| w.phase != Phase::Merged && (w.pending() || w.builder != agent)) {
                return Err(format!("its thread already has a merge request for {}. Nothing was merged.", other.branch));
            }
            // The person's go-ahead for this commit stands in for the builder's receipt.
            let handle = self.handle(&room)?;
            let by = handle.checkpoint.lock().unwrap().snapshot.participants.iter().find(|p| p.id.as_str() == agent).cloned().ok_or("its agent is no longer in that thread. Nothing was merged.")?;
            let (store, data, thread, sha) = (Arc::clone(self), self.data_dir().to_path_buf(), room.clone(), workflow.head.clone());
            let recorded = tokio::task::spawn_blocking(move || store.thread_git.record(&thread, &data, &folder, &by, &format!("Deck built {sha}"))).await.map_err(|e| e.to_string())??;
            if recorded != crate::thread_git::RecordOutcome::Recorded {
                return Err("another merge is in progress in that thread. Nothing was merged.".into());
            }
            workflow = self.thread_git.get(&room)?.filter(|w| w.head == workflow.head).ok_or("its thread moved on. Nothing was merged.")?;
        }
        let key = WorkflowKey::of(&workflow);
        self.thread_git_action_for(room.clone(), ThreadGitAction::MergeReady { expected: Shown::Key(key) }, Some((pr, assistant_id))).await?;
        self.ship_relay.finds.lock().unwrap().retain(|(owner, number, _), _| !(owner == assistant_id && *number == pr));
        let how = if by_words { format!("You told {} to ship", assistant.name) } else { format!("In {}'s conversation you tapped Ship it for", assistant.name) };
        let commit = short(&workflow.head);
        if let Err(why) = self.deck_note(&room, format!("{how} PR #{pr}. Deck is merging commit {commit}; a newer commit would need your go-ahead again.")).await {
            eprintln!("[apex-deck] could not post the ship note in {room}: {why}");
        }
        let waiting = self.reply_suggestions.recent_checks(&room, &workflow.head).filter(|ready| ready.waiting).and_then(|ready| ready.blocker);
        Ok(match waiting {
            Some(why) => format!("PR #{pr} will merge once its checks pass ({}). This covers commit {commit} on {} only; a newer commit ends it. The result will be posted here.", why.to_lowercase(), workflow.branch),
            None => format!("Deck is merging PR #{pr} (commit {commit} on {}). The result will be posted here.", workflow.branch),
        })
    }

    /// The person's message to an assistant, just accepted: any pull request it
    /// tells Deck to ship is checked and merged, and the conversation hears how
    /// it went. A message that says no such thing costs nothing.
    pub(crate) fn relay_ship_later(self: &Arc<Self>, assistant_id: &str, event_id: &str, text: &str) {
        let Ok(name) = self.personal_get(assistant_id).map(|assistant| assistant.name) else { return };
        let prs = asked(text, &name);
        if prs.is_empty() {
            return;
        }
        let (host, assistant, event) = (Arc::clone(self), assistant_id.to_owned(), event_id.to_owned());
        self.runtime().spawn(async move {
            for pr in prs {
                let said = match host.ship_now(&assistant, pr, None, true).await {
                    Ok(doing) => doing,
                    Err(why) => format!("Couldn't ship PR #{pr}: {}", brief(&why)),
                };
                host.ship_post(&assistant, Some(&event), said);
            }
        });
    }

    /// The card's tap in an assistant's conversation.
    pub async fn personal_ship(self: &Arc<Self>, assistant_id: String, pr: u64, repo: String, head: String) -> Result<serde_json::Value, String> {
        let message = self.ship_now(&assistant_id, pr, Some((&repo, &head)), false).await.map_err(|why| format!("Couldn't ship PR #{pr}: {}", brief(&why)))?;
        Ok(serde_json::json!({ "message": message }))
    }

    /// One card per pull request the assistant's recent replies mention and a
    /// Deck thread built: its checks, conflicts and review, and whether it can
    /// merge. Each sits under the newest message that mentions it. Reads only.
    pub async fn personal_ship_offers(self: &Arc<Self>, assistant_id: String) -> Result<serde_json::Value, String> {
        let assistant = self.personal_get(&assistant_id)?;
        let mut offers = Vec::new();
        // Newest first, so a pull request's card lands under its latest mention.
        let mut named: Vec<(u64, String, bool)> = Vec::new();
        for message in assistant.messages.iter().rev().filter(|message| message.role != "human").take(RECENT_REPLIES) {
            for pr in mentioned(&message.text) {
                if named.len() < MAX_ASKED && !named.iter().any(|(seen, _, _)| *seen == pr) {
                    named.push((pr, message.id.clone(), message.role == "system"));
                }
            }
        }
        for (pr, message_id, deck_said) in named {
            let (room, workflow, adopt) = match self.ship_find(&assistant, pr, false).await {
                Lookup::Found { room, workflow, adopt } => (room, *workflow, adopt),
                // Deck's own line already says how it ended.
                Lookup::Merged(_) if deck_said => continue,
                Lookup::Merged(detail) => {
                    offers.push(serde_json::json!({ "pr": pr, "messageId": message_id, "state": "merged", "message": detail }));
                    continue;
                }
                // Not Deck's to merge: no card, rather than a dead one under every mention.
                Lookup::No(_) => continue,
            };
            let checkout = serde_json::json!({ "repo": workflow.repo, "branch": workflow.branch, "root": workflow.root, "generation": workflow.generation });
            let (state, card) = if workflow.pending() {
                ("merging", Some(crate::reply_suggestions::merging_card(&room, 0, &workflow)))
            } else if workflow.phase == Phase::Failed && workflow.local_check_failed {
                let mut card = crate::reply_suggestions::merging_card(&room, 0, &workflow);
                card.kind = crate::reply_suggestions::Kind::Merge;
                card.cancellable = false;
                card.question = "This can't merge yet.".into();
                card.primary = Some("Ship it".into());
                card.blocked = Some("A check failed after the merge was asked for".into());
                card.detail = Some(workflow.detail.clone());
                ("blocked", Some(card))
            } else {
                let ready = self.readiness_of(&room, &workflow).await;
                let card = crate::reply_suggestions::ship_card(&room, 0, &workflow, &ready).or_else(|| {
                    // GitHub couldn't be read just now; say so rather than show nothing.
                    let mut card = crate::reply_suggestions::ship_card(&room, 0, &workflow, &crate::thread_git::Readiness { pr: Some(pr), ..ready.clone() })?;
                    card.blocked = Some(ready.blocker.clone().unwrap_or_else(|| "GitHub couldn't be reached".into()));
                    Some(card)
                });
                let state = match &card {
                    Some(card) if card.blocked.is_some() => "blocked",
                    Some(_) if ready.waiting => "waiting",
                    _ => "ready",
                };
                (state, card)
            };
            offers.push(serde_json::json!({ "pr": pr, "messageId": message_id, "state": state, "room": room, "saved": adopt.is_none(), "checkout": checkout, "card": card }));
        }
        Ok(serde_json::json!({ "offers": offers }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(text: &str) -> Vec<u64> {
        asked(text, "Alfred")
    }

    #[test]
    fn the_assistants_name_counts_only_where_a_name_goes() {
        assert_eq!(asked("Never, merge PR 84", "Never"), vec![84]);
        assert_eq!(asked("please never merge PR 84", "Never"), Vec::<u64>::new());
        assert_eq!(asked("ok never merge PR 84", "Never"), Vec::<u64>::new());
    }

    #[test]
    fn an_instruction_to_ship_names_its_pull_requests() {
        for (text, prs) in [
            ("ship PR 84", vec![84]),
            ("Ship PR #84.", vec![84]),
            ("merge 66, then continue", vec![66]),
            ("Alfred, ship it: PR 84", vec![84]),
            ("@alfred please merge pull request 84 into main", vec![84]),
            ("ok go ahead and merge #84 and #85", vec![84, 85]),
            ("Looks good, ship PR 84 and PR 85 now!", vec![84, 85]),
            ("merge PRs 84, 85 and 86", vec![84, 85, 86]),
            ("Ship PR 84 and then update the changelog", vec![84]),
            ("yes ship pr84 please", vec![84]),
            ("land PR 84 on main, thanks", vec![84]),
            ("Ship PR 84, thank you", vec![84]),
            ("\nship PR 84\n\n", vec![84]),
        ] {
            assert_eq!(said(text), prs, "{text}");
        }
        assert_eq!(said("merge 1, 2, 3 and 4"), vec![1, 2, 3], "at most three in one message");
    }

    #[test]
    fn anything_short_of_a_plain_instruction_is_left_to_the_assistant() {
        for text in [
            "ship it",
            "did you merge PR 84?",
            "can you ship PR 84?",
            "should we ship PR 84",
            "don't ship PR 84",
            "do not merge PR 84 yet",
            "merge PR 84 after I test it",
            "ship PR 84 if the checks pass",
            "ship PR 84 unless Null objects",
            "merge 2 branches into one",
            "why did PR 84 fail to merge",
            "PR 84 is ready to ship",
            "I will ship PR 84 tomorrow",
            "the worker said: ship PR 84",
            "> ship PR 84",
            "ship. PR 84 is next",
            "ship PR abc",
            "ship PR",
            "ship PR 0",
            "merge PR 84 tomorrow",
            "ship the image support one",
            "shipping PR 84",
            "ship https://example.com/pull/84",
            "ship https://github.com/l1quid8/other/pull/84",
            "Merge PR 84, but only after I test it",
            "Ship PR 84, unless Null objects",
            "Ship PR 84. Actually, wait.",
            "Ship 84, no wait, 85",
            "Once Null approves:\nmerge PR 84",
            "please don't\nmerge PR 84",
            "```\nmerge PR 84\n```",
            "Plan only. Do not execute or edit files.\n\nship PR 84",
            "Thanks for the summary.\nShip PR 84",
            "never merge PR 84",
            "@sam merge PR 84",
            "merge PR 84 then only after approval",
        ] {
            assert_eq!(said(text), Vec::<u64>::new(), "{text}");
        }
    }

    #[test]
    fn a_replys_pull_request_mentions_are_found() {
        assert_eq!(mentioned("PR #84 is green and PR 85 is waiting. See https://github.com/l1quid8/other/pull/88."), vec![84, 85]);
        assert_eq!(mentioned("Opened pull request #12 (PR#13)."), vec![12, 13]);
        assert_eq!(mentioned("Issue #84 and 85 tests passed; the press release is out."), Vec::<u64>::new());
    }
}
