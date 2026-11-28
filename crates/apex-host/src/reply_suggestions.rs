//! What sits under the newest reply: one decision, or nothing.
//!
//! The Mac decides once, so the desktop and the iPhone only draw the answer.
//! A Git decision comes only from the saved merge workflow and GitHub. A
//! question an agent wrote can only ever send text back to that agent.

use crate::thread_git::{Checks, Line, Phase, Readiness, Workflow};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU8, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

/// The settings key, saved with the other settings so every client sees it.
pub const SETTING: &str = "replySuggestions";
/// How long one GitHub answer about a commit's checks is reused.
const CHECKS_TTL: Duration = Duration::from_secs(30);
/// Dismissals kept per thread. Older ones belong to replies long scrolled away.
const KEPT: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    DecisionCard,
    NextSteps,
    Off,
}
impl Mode {
    pub const DEFAULT: Mode = Mode::DecisionCard;
    pub fn from_settings(settings: Option<&serde_json::Value>) -> Mode {
        settings
            .and_then(|s| s.get(SETTING))
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or(Mode::DEFAULT)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::DecisionCard => "decision_card",
            Mode::NextSteps => "next_steps",
            Mode::Off => "off",
        }
    }
    fn code(self) -> u8 {
        match self {
            Mode::DecisionCard => 0,
            Mode::NextSteps => 1,
            Mode::Off => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// The commit's pull request: Deck merges on a tap, 0 turns. When GitHub
    /// would refuse, the card says why and its button is off.
    Merge,
    /// A required check failed before any merge was asked for. 1 turn.
    FixChecks,
    /// A merge that was asked for stopped on a failed check. 1 turn.
    FixFailed,
    /// A merge is in flight. Shown in every mode so Cancel stays reachable.
    /// A merge that landed is reported by Deck's note in the thread.
    Merging,
    /// The agent's own yes/no question. Only ever sends text to that agent.
    Question,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// Project, thread, reply, action and commit: what a dismissal is remembered by.
    pub key: String,
    pub kind: Kind,
    pub context: String,
    pub question: String,
    /// The main button. A receipt has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary: Option<String>,
    /// Model turns the main button spends.
    pub turns: u8,
    pub dismissible: bool,
    /// Only a merge in flight: whether Cancel can still be asked.
    pub cancellable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<u64>,
    /// A question's agent, and the text the main button sends to it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Why the main button is off: what GitHub would refuse, found before asking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
    /// A pull request's checks, conflicts and review, one row each.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub status: Vec<Line>,
}

/// The newest message in the thread.
pub struct Reply<'a> {
    pub seq: usize,
    /// The agent that wrote it; `None` when a person did.
    pub by: Option<&'a str>,
    pub text: &'a str,
}

pub struct Facts<'a> {
    pub mode: Mode,
    pub room: &'a str,
    /// An agent is working, so there is no finished reply to sit under.
    pub busy: bool,
    pub watched: bool,
    pub reply: Option<Reply<'a>>,
    pub workflow: Option<&'a Workflow>,
    /// The commit checked out in the thread's folder right now.
    pub head: Option<&'a str>,
    /// What GitHub says about that commit's pull request.
    pub ready: &'a Readiness,
}

fn key(repo: &str, room: &str, seq: usize, action: &str, commit: &str) -> String {
    format!("{repo}|{room}|{seq}|{action}|{commit}")
}

/// A key names its thread second, so one thread cannot dismiss another's card.
pub fn key_room(key: &str) -> Option<&str> {
    let mut parts = key.split('|');
    parts.next()?;
    let room = parts.next()?;
    (parts.count() == 3).then_some(room)
}

fn short(sha: &str) -> &str {
    sha.get(..8).unwrap_or(sha)
}

#[allow(clippy::too_many_arguments)]
fn git_card(room: &str, seq: usize, w: &Workflow, kind: Kind, action: &str, question: &str, primary: Option<&str>, turns: u8, detail: Option<String>) -> Decision {
    Decision {
        key: key(&w.repo, room, seq, action, &w.head),
        kind,
        context: w.detail.lines().next().unwrap_or("").to_owned(),
        question: question.to_owned(),
        primary: primary.map(str::to_owned),
        turns,
        dismissible: kind != Kind::Merging,
        cancellable: kind == Kind::Merging && !matches!(w.phase, Phase::Cancelling | Phase::Syncing),
        detail,
        head: Some(w.head.clone()),
        pr: w.pr,
        to: None,
        prompt: None,
        blocked: None,
        status: Vec::new(),
    }
}

/// A merge in flight: reachable whatever the setting says, so Cancel is too.
pub fn merging_card(room: &str, seq: usize, w: &Workflow) -> Decision {
    let question = if w.phase == Phase::Checks { "Merging when checks pass…" } else { "Merging…" };
    git_card(room, seq, w, Kind::Merging, "merging", question, None, 0, None)
}

/// The pull request for `w`'s commit, with whatever stands in its way shown
/// before the tap. None when the commit has no pull request.
pub fn ship_card(room: &str, seq: usize, w: &Workflow, ready: &Readiness) -> Option<Decision> {
    let pr = ready.pr?;
    let (question, label) = match (&ready.blocker, ready.waiting) {
        (None, _) => ("Merge into main?", "Ship it"),
        (Some(_), true) => ("Merge into main once the checks pass?", "Ship when checks pass"),
        (Some(_), false) => ("This can't merge yet.", "Ship it"),
    };
    let mut card = git_card(room, seq, w, Kind::Merge, "merge", question, Some(label), 0, None);
    // A different model's review is the author's job now; shown when there was one.
    card.context = match (&ready.blocker, &w.reviewer) {
        (Some(why), _) => format!("PR #{pr} · {why}"),
        (None, Some(_)) => format!("PR #{pr} · checks passed · review passed for {}", short(&w.head)),
        (None, None) => format!("PR #{pr} · checks passed"),
    };
    card.pr = Some(pr);
    card.blocked = ready.blocker.clone().filter(|_| !ready.waiting);
    card.status = ready.lines.clone();
    Some(card)
}

pub fn decide(facts: &Facts<'_>, dismissed: impl Fn(&str) -> bool) -> Option<Decision> {
    let seq = facts.reply.as_ref().map_or(0, |r| r.seq);
    // A merge in flight is reachable whatever the setting says.
    if let Some(w) = facts.workflow.filter(|w| w.pending()) {
        return Some(merging_card(facts.room, seq, w));
    }
    let reply = facts.reply.as_ref()?;
    if facts.mode == Mode::Off || facts.busy {
        return None;
    }
    let current = facts.workflow.filter(|w| facts.head == Some(w.head.as_str()));
    let ready = facts.ready;
    let fix = |w: &Workflow, kind, detail: String| git_card(facts.room, seq, w, kind, "fix", "Send the failed check to the builder?", Some("Ask agent to fix"), 1, Some(detail));
    let candidate = current.and_then(|w| match (&w.phase, &ready.checks) {
        (Phase::Failed, Checks::Passed { .. }) if !w.local_check_failed => ship_card(facts.room, seq, w, ready),
        (_, Checks::Failed { .. }) if facts.watched => None,
        (Phase::Failed, _) if !facts.watched && !w.fix_requested => Some(fix(w, Kind::FixFailed, w.detail.clone())),
        (Phase::Ready | Phase::Cancelled | Phase::Blocked, Checks::Failed { pr, detail }) if !facts.watched && !w.fix_requested => {
            let mut card = fix(w, Kind::FixChecks, detail.clone());
            card.context = format!("PR #{pr} · {}", detail.lines().next().unwrap_or("A required check failed"));
            card.pr = Some(*pr);
            card.status = ready.lines.clone();
            Some(card)
        }
        (Phase::Ready | Phase::Cancelled | Phase::Blocked, _) => ship_card(facts.room, seq, w, ready),
        _ => None,
    })
    .filter(|card| !dismissed(&card.key));
    let asked = question(facts, reply).filter(|card| !dismissed(&card.key));
    // A card that can act comes first; one that only explains gives way to the agent's question.
    match candidate {
        Some(card) if card.blocked.is_none() || asked.is_none() => Some(card),
        _ => asked,
    }
}

fn question(facts: &Facts<'_>, reply: &Reply<'_>) -> Option<Decision> {
    let by = reply.by?;
    let ask = ask(reply.text)?;
    let repo = facts.workflow.map_or("", |w| w.repo.as_str());
    Some(Decision {
        key: key(repo, facts.room, reply.seq, "question", ""),
        kind: Kind::Question,
        context: String::new(),
        question: ask.question,
        primary: Some(ask.label.clone()),
        turns: 1,
        dismissible: true,
        cancellable: false,
        detail: None,
        head: None,
        pr: None,
        to: Some(by.to_owned()),
        prompt: Some(ask.label),
        blocked: None,
        status: Vec::new(),
    })
}

#[derive(Debug, PartialEq, Eq)]
pub struct Ask {
    pub question: String,
    pub label: String,
}

/// Words that belong to buttons the Mac runs itself. An agent's button may not
/// borrow them, so a text-only button never reads as a Deck action.
const HOST_ACTIONS: [&str; 4] = ["merg", "push", "cancel", "ship"];

/// `Deck asks: <question>? | <yes label>` as the reply's last line, or the
/// line before a `Deck built` / `Deck ship` / `Deck review passed` receipt.
/// Anything malformed is no question at all.
pub fn ask(text: &str) -> Option<Ask> {
    let mut lines = text.trim_end().lines().rev().filter(|l| !l.trim().is_empty());
    let mut line = lines.next()?;
    if line.starts_with("Deck built ") || line.starts_with("Deck ship ") || line.starts_with("Deck review passed ") {
        line = lines.next()?;
    }
    let (question, label) = line.strip_prefix("Deck asks: ")?.rsplit_once(" | ")?;
    let (question, label) = (question.trim(), label.trim());
    let plain = |s: &str| !s.chars().any(|c| c.is_control() || c == '|' || c == '`');
    let words = label.to_lowercase();
    let borrows = words
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| HOST_ACTIONS.iter().any(|action| word.starts_with(action)));
    ((8..=160).contains(&question.chars().count())
        && question.ends_with('?')
        && (2..=40).contains(&label.chars().count())
        && plain(question)
        && plain(label)
        && !borrows)
        .then(|| Ask { question: question.into(), label: label.into() })
}

/// The user's own file, not a protected ledger: a dismissal only hides a card.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Ledger {
    version: u32,
    /// Dismissed keys per thread, oldest first.
    rooms: BTreeMap<String, Vec<String>>,
}

pub struct ReplySuggestions {
    path: PathBuf,
    mode: AtomicU8,
    ledger: Mutex<Option<Ledger>>,
    /// Thread → (commit, when asked, GitHub's answer). Never saved: a restart asks again.
    checks: Mutex<BTreeMap<String, (String, Instant, Readiness)>>,
}
impl ReplySuggestions {
    pub fn new(data: &Path, mode: Mode) -> Self {
        Self {
            path: data.join("reply-decisions-v1.json"),
            mode: AtomicU8::new(mode.code()),
            ledger: Mutex::new(None),
            checks: Mutex::default(),
        }
    }
    pub fn mode(&self) -> Mode {
        match self.mode.load(Ordering::SeqCst) {
            1 => Mode::NextSteps,
            2 => Mode::Off,
            _ => Mode::DecisionCard,
        }
    }
    pub fn set_mode(&self, mode: Mode) {
        self.mode.store(mode.code(), Ordering::SeqCst);
    }
    /// The saved ledger, read once. The caller holds the lock for as long as it uses it.
    fn ledger(&self) -> Result<std::sync::MutexGuard<'_, Option<Ledger>>, String> {
        let mut cache = self.ledger.lock().map_err(|e| e.to_string())?;
        if cache.is_none() {
            let saved = crate::plain_file::read::<Ledger>(&self.path)?.unwrap_or(Ledger { version: 1, rooms: BTreeMap::new() });
            if saved.version != 1 {
                return Err(format!("{} is from a newer Deck (version {}).", self.path.display(), saved.version));
            }
            *cache = Some(saved);
        }
        Ok(cache)
    }
    pub fn dismissed(&self, room: &str) -> Result<Vec<String>, String> {
        Ok(self.ledger()?.as_ref().and_then(|l| l.rooms.get(room).cloned()).unwrap_or_default())
    }
    pub fn dismiss(&self, room: &str, key: &str) -> Result<(), String> {
        if key.len() > 400 || key_room(key) != Some(room) {
            return Err("That decision belongs to another thread.".into());
        }
        // One lock covers the change, the save and the swap, so two taps at
        // once build on each other. A failed save leaves the cache as it was.
        let mut cache = self.ledger()?;
        let mut next = cache.clone().unwrap_or_default();
        let keys = next.rooms.entry(room.to_owned()).or_default();
        if keys.iter().any(|k| k == key) {
            return Ok(());
        }
        keys.push(key.to_owned());
        let extra = keys.len().saturating_sub(KEPT);
        keys.drain(..extra);
        crate::plain_file::save(&self.path, &next)?;
        *cache = Some(next);
        Ok(())
    }
    /// GitHub's last answer for this commit, while it is still fresh.
    pub fn recent_checks(&self, room: &str, head: &str) -> Option<Readiness> {
        let checks = self.checks.lock().ok()?;
        let (commit, at, answer) = checks.get(room)?;
        (commit == head && at.elapsed() < CHECKS_TTL).then(|| answer.clone())
    }
    pub fn observe(&self, room: &str, head: &str, answer: Readiness) {
        if let Ok(mut checks) = self.checks.lock() {
            checks.insert(room.to_owned(), (head.to_owned(), Instant::now(), answer));
        }
    }
}

impl crate::Host {
    pub(crate) async fn post_decision_turn(
        self: &std::sync::Arc<Self>, id: &str, text: String, target: apex_core::ParticipantId,
        request_id: String, capability: apex_core::GeneratedUiCapability,
        check: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<serde_json::Value, String> {
        self.room_client_post_keeping_default(id.into(), text, Some(vec![target]), request_id,
            false, true, Some(0), None, capability, true, true, check).await
    }

    /// A button can only send the validated label to the author of the displayed reply.
    pub(crate) async fn answer_reply_question(self: &std::sync::Arc<Self>, id: String, key: String, text: String, targets: Vec<apex_core::ParticipantId>, capability: apex_core::GeneratedUiCapability) -> Result<serde_json::Value, String> {
        use sha2::{Digest, Sha256};
        let shown = self.room_reply_decision(id.clone()).await?;
        let card = &shown["decision"];
        if card["kind"] != "question" || card["key"] != key || card["prompt"] != text ||
            targets.len() != 1 || card["to"] != targets[0].as_str() {
            return Err("This reply decision changed. Refresh the thread.".into());
        }
        let handle = self.handle(&id)?;
        let seq = shown["replySeq"].as_u64();
        let request_id = format!("reply-choice-{:x}", Sha256::digest(key.as_bytes()));
        let check = || {
            let latest = handle.checkpoint.lock().unwrap().snapshot.transcript.last().map(|m| m.seq as u64);
            if latest != seq || self.reply_suggestions.mode() == crate::reply_suggestions::Mode::Off ||
                self.reply_suggestions.dismissed(&id)?.contains(&key) {
                return Err("This decision is no longer current.".into());
            }
            Ok(())
        };
        self.post_decision_turn(&id, text, targets[0].clone(), request_id, capability, &check).await
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_process::TestDataDir;

    fn workflow(phase: Phase, reviewed: bool) -> Workflow {
        serde_json::from_value(serde_json::json!({
            "root": "/repo", "branch": "fix/alert", "repo": "test/repo", "head": "a".repeat(40),
            "builder": "jigga", "builder_model": "one", "reviewer": reviewed.then_some("mythos"),
            "phase": phase, "generation": 1, "pr": 42, "detail": "Windows test reported FAILURE\nexit 1",
            "pushed": true, "fix_requested": false,
        }))
        .unwrap()
    }
    fn decided(mode: Mode, w: Option<&Workflow>, checks: Checks, text: &str, dismissed: &[String]) -> Option<Decision> {
        let head = "a".repeat(40);
        let ready = Readiness::of(checks);
        decide(
            &Facts { mode, watched: false, room: "r", busy: false, reply: Some(Reply { seq: 7, by: Some("jigga"), text }), workflow: w, head: Some(&head), ready: &ready },
            |key| dismissed.iter().any(|k| k == key),
        )
    }
    const PASSED: Checks = Checks::Passed { pr: 42 };

    #[test]
    fn watcher_owns_failures_only_for_watched_tasks() {
        for phase in [Phase::Ready, Phase::Failed] {
            let w = workflow(phase, false);
            let checks = Checks::Failed { pr: 42, detail: "check failed".into() };
            let mut facts = Facts {
                mode: Mode::DecisionCard, watched: true, room: "r", busy: false,
                reply: Some(Reply { seq: 7, by: Some("worker"), text: "Done." }),
                workflow: Some(&w), head: Some(&w.head), ready: &Readiness::of(checks),
            };
            assert!(decide(&facts, |_| false).is_none());
            facts.watched = false;
            assert!(decide(&facts, |_| false).is_some());
        }
    }

    #[test]
    fn successful_remote_rerun_restores_the_worker_merge_card() {
        let mut w = workflow(Phase::Failed, false);
        assert_eq!(decided(Mode::DecisionCard, Some(&w), PASSED, "Done.", &[]).unwrap().kind, Kind::Merge);
        w.local_check_failed = true;
        assert_eq!(decided(Mode::DecisionCard, Some(&w), PASSED, "Done.", &[]).unwrap().kind, Kind::FixFailed);
    }

    #[test]
    fn each_row_of_the_table() {
        let card = Mode::DecisionCard;
        let ready = workflow(Phase::Ready, true);
        // Nothing: no commits, checks running or unknown.
        assert_eq!(decided(card, None, PASSED, "Done.", &[]), None);
        assert_eq!(decided(card, Some(&ready), Checks::Running, "Done.", &[]), None);
        assert_eq!(decided(card, Some(&ready), Checks::Unknown("no pull request".into()), "Done.", &[]), None);
        // Review and required checks passed on the same commit.
        let merge = decided(card, Some(&ready), PASSED, "Done.", &[]).unwrap();
        assert_eq!((merge.kind, merge.turns, merge.primary.as_deref(), merge.pr), (Kind::Merge, 0, Some("Ship it"), Some(42)));
        assert_eq!(decided(card, Some(&workflow(Phase::Cancelled, true)), PASSED, "Done.", &[]).unwrap().kind, Kind::Merge, "a cancelled merge can be asked again");
        // A required check failed.
        let fix = decided(card, Some(&ready), Checks::Failed { pr: 42, detail: "Windows failed\nlog".into() }, "Done.", &[]).unwrap();
        let mut requested = ready.clone();
        requested.fix_requested = true;
        let asked = decided(card, Some(&requested), Checks::Failed { pr: 42, detail: "Windows".into() }, "Done.", &[]).unwrap();
        assert_eq!((asked.kind, asked.blocked.as_deref()), (Kind::Merge, Some("Windows")), "already sent to the builder: the card only says why it can't merge");
        assert_eq!((fix.kind, fix.turns, fix.detail.as_deref()), (Kind::FixChecks, 1, Some("Windows failed\nlog")));
        let failed = decided(card, Some(&workflow(Phase::Failed, true)), Checks::Running, "Done.", &[]).unwrap();
        assert_eq!((failed.kind, failed.turns), (Kind::FixFailed, 1));
        // In flight, then merged.
        let merging = decided(card, Some(&workflow(Phase::Checks, true)), Checks::Running, "Done.", &[]).unwrap();
        assert_eq!((merging.kind, merging.cancellable, merging.dismissible), (Kind::Merging, true, false));
        assert!(!decided(card, Some(&workflow(Phase::Cancelling, true)), Checks::Running, "Done.", &[]).unwrap().cancellable);
        // Deck's note in the thread reports a merge; no card does.
        assert_eq!(decided(card, Some(&workflow(Phase::Merged, true)), Checks::Running, "Done.", &[]), None);
        // The agent's own question, and Git winning over it.
        let asks = "I traced it.\nDeck asks: Add a timestamp so we can measure the delay? | Yes, add logging";
        let question = decided(card, None, Checks::Running, asks, &[]).unwrap();
        assert_eq!((question.kind, question.turns, question.to.as_deref(), question.prompt.as_deref()), (Kind::Question, 1, Some("jigga"), Some("Yes, add logging")));
        assert_eq!(decided(card, Some(&ready), PASSED, asks, &[]).unwrap().kind, Kind::Merge);
    }

    #[test]
    fn the_merge_card_needs_only_passing_checks() {
        let card = Mode::DecisionCard;
        let unreviewed = decided(card, Some(&workflow(Phase::Ready, false)), PASSED, "Done.", &[]).unwrap();
        assert_eq!((unreviewed.kind, unreviewed.context.as_str(), unreviewed.primary.as_deref()), (Kind::Merge, "PR #42 · checks passed", Some("Ship it")));
        let reviewed = decided(card, Some(&workflow(Phase::Ready, true)), PASSED, "Done.", &[]).unwrap();
        assert_eq!(reviewed.context, "PR #42 · checks passed · review passed for aaaaaaaa");
    }

    fn reading(pr: u64, checks: Checks, blocker: Option<&str>, waiting: bool) -> Readiness {
        Readiness { pr: Some(pr), checks, lines: vec![Line { label: "Conflicts".into(), text: "none".into(), state: crate::thread_git::Light::Ok }], blocker: blocker.map(str::to_owned), waiting }
    }
    fn shown(w: &Workflow, ready: &Readiness, text: &str, dismissed: &[String]) -> Option<Decision> {
        let head = "a".repeat(40);
        decide(
            &Facts { mode: Mode::DecisionCard, watched: false, room: "r", busy: false, reply: Some(Reply { seq: 7, by: Some("jigga"), text }), workflow: Some(w), head: Some(&head), ready },
            |key| dismissed.iter().any(|k| k == key),
        )
    }

    #[test]
    fn a_pull_request_that_cant_merge_says_why_before_anyone_taps() {
        let w = workflow(Phase::Ready, false);
        for why in ["main has no required checks on GitHub", "It conflicts with main", "It needs an approving review"] {
            let card = shown(&w, &reading(42, Checks::Running, Some(why), false), "Done.", &[]).unwrap();
            assert_eq!((card.kind, card.blocked.as_deref(), card.primary.as_deref(), card.turns), (Kind::Merge, Some(why), Some("Ship it"), 0), "{why}");
            assert_eq!(card.context, format!("PR #42 · {why}"));
            assert_eq!(card.question, "This can't merge yet.");
            assert_eq!(card.status.len(), 1, "the rows come with it");
        }
        // The same card once nothing is in the way.
        let ready = shown(&w, &reading(42, Checks::Passed { pr: 42 }, None, false), "Done.", &[]).unwrap();
        assert_eq!((ready.blocked.clone(), ready.primary.as_deref(), ready.question.as_str()), (None, Some("Ship it"), "Merge into main?"));
        let json = serde_json::to_value(&ready).unwrap();
        assert_eq!(json["status"][0], serde_json::json!({ "label": "Conflicts", "text": "none", "state": "ok" }));
        assert!(json.get("blocked").is_none());
    }

    #[test]
    fn checks_still_running_can_be_shipped_ahead_of_time() {
        let card = shown(&workflow(Phase::Ready, false), &reading(42, Checks::Running, Some("3 checks are still running"), true), "Done.", &[]).unwrap();
        assert_eq!((card.kind, card.blocked.clone(), card.primary.as_deref()), (Kind::Merge, None, Some("Ship when checks pass")));
        assert_eq!(card.question, "Merge into main once the checks pass?");
        assert_eq!(card.context, "PR #42 · 3 checks are still running");
    }

    #[test]
    fn a_merge_github_refused_can_be_asked_again() {
        let blocked = workflow(Phase::Blocked, false);
        assert_eq!(shown(&blocked, &reading(42, Checks::Passed { pr: 42 }, None, false), "Done.", &[]).unwrap().primary.as_deref(), Some("Ship it"));
        assert_eq!(shown(&blocked, &reading(42, Checks::Unknown("x".into()), Some("main has no required checks on GitHub"), false), "Done.", &[]).unwrap().blocked.as_deref(), Some("main has no required checks on GitHub"));
    }

    #[test]
    fn a_card_that_only_explains_gives_way_to_the_agents_question() {
        let w = workflow(Phase::Ready, false);
        let asks = "Deck asks: Add a timestamp so we can measure the delay? | Yes, add logging";
        let stuck = reading(42, Checks::Running, Some("It conflicts with main"), false);
        assert_eq!(shown(&w, &stuck, asks, &[]).unwrap().kind, Kind::Question);
        assert_eq!(shown(&w, &stuck, "Done.", &[]).unwrap().kind, Kind::Merge);
        // One that can act still comes first.
        assert_eq!(shown(&w, &reading(42, Checks::Running, Some("2 checks are still running"), true), asks, &[]).unwrap().kind, Kind::Merge);
    }

    #[test]
    fn a_failed_check_without_a_review_still_offers_a_fix() {
        let fix = decided(Mode::DecisionCard, Some(&workflow(Phase::Ready, false)), Checks::Failed { pr: 42, detail: "Windows failed".into() }, "Done.", &[]).unwrap();
        assert_eq!((fix.kind, fix.turns), (Kind::FixChecks, 1));
    }

    #[test]
    fn a_merge_waiting_for_checks_says_so() {
        let question = |phase| decided(Mode::DecisionCard, Some(&workflow(phase, false)), Checks::Running, "Done.", &[]).unwrap().question;
        assert_eq!(question(Phase::Checks), "Merging when checks pass…");
        for phase in [Phase::Preparing, Phase::Submitting, Phase::Cancelling, Phase::Syncing] {
            assert_eq!(question(phase.clone()), "Merging…", "{phase:?}");
        }
    }

    #[test]
    fn a_button_may_not_say_ship_and_a_ship_line_is_a_receipt() {
        let sha = "c".repeat(40);
        assert_eq!(ask("All set.\nDeck asks: Ready to go? | Ship it"), None);
        assert_eq!(ask("All set.\nDeck asks: Ready to go now? | Shipping"), None);
        let above = ask(&format!("Done.\nDeck asks: Show the setting on the phone too? | Show it on the phone\nDeck ship {sha}")).unwrap();
        assert_eq!(above.label, "Show it on the phone");
    }

    #[test]
    fn off_shows_nothing_but_a_merge_in_flight() {
        let asks = "Deck asks: Add a timestamp so we can measure the delay? | Yes, add logging";
        assert_eq!(decided(Mode::Off, Some(&workflow(Phase::Ready, true)), PASSED, asks, &[]), None);
        assert_eq!(decided(Mode::Off, Some(&workflow(Phase::Merged, true)), PASSED, asks, &[]), None);
        let merging = decided(Mode::Off, Some(&workflow(Phase::Submitting, true)), PASSED, asks, &[]).unwrap();
        assert_eq!((merging.kind, merging.cancellable), (Kind::Merging, true), "Cancel stays reachable");
    }

    #[test]
    fn a_new_commit_or_a_working_agent_removes_the_merge_card() {
        let ready = workflow(Phase::Ready, true);
        let passed = Readiness::of(PASSED);
        let facts = |head: &'static str, busy| Facts { mode: Mode::DecisionCard, watched: false, room: "r", busy, reply: Some(Reply { seq: 7, by: Some("jigga"), text: "Done." }), workflow: Some(&ready), head: Some(head), ready: &passed };
        let stale = "b".repeat(40);
        let stale: &'static str = Box::leak(stale.into_boxed_str());
        let same: &'static str = Box::leak("a".repeat(40).into_boxed_str());
        assert_eq!(decide(&facts(stale, false), |_| false), None, "the folder moved past the reviewed commit");
        assert_eq!(decide(&facts(same, true), |_| false), None, "an agent is still working");
        assert_eq!(decide(&facts(same, false), |_| false).unwrap().kind, Kind::Merge);
    }

    #[test]
    fn a_dismissal_is_for_one_reply_action_and_commit() {
        let ready = workflow(Phase::Ready, true);
        let asks = "Deck asks: Add a timestamp so we can measure the delay? | Yes, add logging";
        let merge = decided(Mode::DecisionCard, Some(&ready), PASSED, asks, &[]).unwrap();
        assert_eq!(merge.key, format!("test/repo|r|7|merge|{}", "a".repeat(40)));
        let under = decided(Mode::DecisionCard, Some(&ready), PASSED, asks, &[merge.key.clone()]).unwrap();
        assert_eq!(under.kind, Kind::Question, "the question shows once the merge is put off");
        assert_eq!(decided(Mode::DecisionCard, Some(&ready), PASSED, asks, &[merge.key.clone(), under.key.clone()]), None);
        // The failed-check card is a different action on the same commit.
        assert_eq!(decided(Mode::DecisionCard, Some(&ready), Checks::Failed { pr: 42, detail: "x".into() }, "Done.", &[merge.key]).unwrap().kind, Kind::FixChecks);
    }

    #[test]
    fn dismissals_survive_a_restart_and_reach_every_device() {
        let data = TestDataDir::new();
        let key = format!("test/repo|r|7|merge|{}", "a".repeat(40));
        let mac = ReplySuggestions::new(data.path(), Mode::DecisionCard);
        mac.dismiss("r", &key).unwrap();
        mac.dismiss("r", &key).unwrap();
        assert_eq!(mac.dismissed("r").unwrap(), vec![key.clone()]);
        assert!(mac.dismiss("other", &key).is_err(), "one thread cannot dismiss another's card");
        assert!(mac.dismiss("r", "r").is_err());
        // Both screens ask the same Mac, so a restart is the only other reader.
        let restarted = ReplySuggestions::new(data.path(), Mode::DecisionCard);
        assert_eq!(restarted.dismissed("r").unwrap(), vec![key]);
        assert!(restarted.dismissed("other").unwrap().is_empty());
        for n in 0..KEPT + 5 {
            restarted.dismiss("r", &format!("test/repo|r|{n}|question|")).unwrap();
        }
        assert_eq!(restarted.dismissed("r").unwrap().len(), KEPT);
    }

    #[test]
    fn dismissals_are_a_plain_file_the_broker_never_sees() {
        // The root broker keeps only the ledgers it lists and refuses even a
        // read of any other name, so on an installed Mac a protected ledger
        // here failed every card request. A dismissal grants nothing.
        let data = TestDataDir::new();
        let key = format!("test/repo|r|7|merge|{}", "a".repeat(40));
        ReplySuggestions::new(data.path(), Mode::DecisionCard).dismiss("r", &key).unwrap();
        let path = data.path().join("reply-decisions-v1.json");
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["version"], 1);
        assert_eq!(saved["rooms"]["r"][0], key.as_str());
        assert!(!crate::authority_file::fixture_path(&path).exists());
        assert_eq!(ReplySuggestions::new(data.path(), Mode::DecisionCard).dismissed("r").unwrap(), vec![key], "read back after a restart");
    }

    #[test]
    fn an_agents_line_is_validated_and_cannot_name_a_git_action() {
        let ok = ask("Text.\nDeck asks: Add diagnostic logging to the reopen path? | Yes, add logging").unwrap();
        assert_eq!(ok, Ask { question: "Add diagnostic logging to the reopen path?".into(), label: "Yes, add logging".into() });
        let sha = "c".repeat(40);
        assert!(ask(&format!("Deck asks: Run the slow test suite as well? | Run it\nDeck built {sha}")).is_some(), "before a receipt line");
        for bad in [
            "Deck asks: Merge the alert fix into main? | Merge to main",
            "Deck asks: Publish the branch for review? | Push it",
            "Deck asks: Stop the merge that is running? | Cancel merge",
            "Deck asks: Apply the review fixes to both? | Merging both",
            "Deck asks: No question mark here | Yes",
            "Deck asks: Short? | Yes",
            "Deck asks: Add diagnostic logging to the path? | ",
            "Deck asks: Add diagnostic logging to the path? | A label that goes on for far longer than a button can hold",
            "Deck asks: Add `code` to the reopen path? | Yes",
            "Deck asks: Add diagnostic logging to the path?",
            "deck asks: Add diagnostic logging to the path? | Yes",
            "Deck asks: Add diagnostic logging to the path? | Yes\nAnd then more text.",
        ] {
            assert_eq!(ask(bad), None, "{bad}");
        }
    }

    #[test]
    fn dismissals_made_at_the_same_moment_are_all_kept() {
        let data = TestDataDir::new();
        let state = std::sync::Arc::new(ReplySuggestions::new(data.path(), Mode::DEFAULT));
        let start = std::sync::Arc::new(std::sync::Barrier::new(16));
        let key = |n: usize| format!("test/repo|r|{n}|question|");
        let taps: Vec<_> = (0..16)
            .map(|n| {
                let (state, start, key) = (state.clone(), start.clone(), key(n));
                std::thread::spawn(move || {
                    start.wait();
                    state.dismiss("r", &key).unwrap();
                })
            })
            .collect();
        taps.into_iter().for_each(|tap| tap.join().unwrap());
        let mut expected: Vec<_> = (0..16).map(key).collect();
        expected.sort();
        let sorted = |mut keys: Vec<String>| {
            keys.sort();
            keys
        };
        assert_eq!(sorted(state.dismissed("r").unwrap()), expected, "in memory");
        let restarted = ReplySuggestions::new(data.path(), Mode::DEFAULT);
        assert_eq!(sorted(restarted.dismissed("r").unwrap()), expected, "on disk");
    }

    #[test]
    fn the_setting_defaults_to_the_decision_card_and_reads_only_known_values() {
        assert_eq!(Mode::from_settings(None), Mode::DecisionCard);
        assert_eq!(Mode::from_settings(Some(&serde_json::json!({}))), Mode::DecisionCard);
        assert_eq!(Mode::from_settings(Some(&serde_json::json!({"replySuggestions":"decision_card"}))), Mode::DecisionCard);
        assert_eq!(Mode::from_settings(Some(&serde_json::json!({"replySuggestions":"off"}))), Mode::Off);
        assert_eq!(Mode::from_settings(Some(&serde_json::json!({"replySuggestions":"everything"}))), Mode::DecisionCard);
        assert_eq!(Mode::from_settings(Some(&serde_json::json!({"replySuggestions":"next_steps"}))), Mode::NextSteps);
        let state = ReplySuggestions::new(TestDataDir::new().path(), Mode::DEFAULT);
        state.set_mode(Mode::Off);
        assert_eq!(state.mode().as_str(), "off");
    }
}
