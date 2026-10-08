//! Asking the person before a participant acts.
//!
//! A participant with "ask first" access proposes each edit and command and
//! waits for a yes or no. The pieces are:
//!
//! - [`ProposedAction`]: what the participant wants to do, in a form a
//!   person can read and judge.
//! - [`Approver`]: what a backend calls to get the answer. The room gives
//!   each turn one that shows the proposal in the chat and waits.
//! - [`ApprovalDesk`]: where proposals wait. It is shared with whoever
//!   delivers the person's answer, and can be reached while a turn is
//!   running, which the room itself cannot.
//! - [`FileChange`]: an edit that was actually made, for the list of
//!   changes kept beside the conversation.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use crate::{Answer, ParticipantId, Question};
use futures::channel::oneshot;
use serde::{Deserialize, Serialize};

/// What kind of thing a participant wants to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    /// Create or change a file. The detail is the change, as a diff.
    Edit,
    /// Run a command. The detail is the command line.
    Command,
    /// An MCP tool call. The detail is its complete JSON arguments.
    Tool,
    /// Anything else a tool asks permission for.
    Other,
    /// A bot that planned asks to start the work. Approving turns the
    /// thread's Plan switch off. Never "Always allow".
    Plan,
    /// A picture or video bot asks before a paid job. The title has the
    /// price. Never "Always allow": every one costs money.
    Spend,
}

impl ActionKind {
    /// Asked every time: "Always allow" is never offered or kept.
    pub fn asked_every_time(self) -> bool {
        matches!(self, ActionKind::Plan | ActionKind::Spend)
    }
}

/// Something a participant wants to do and is waiting for permission for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposedAction {
    pub kind: ActionKind,
    /// One line, such as "Edit src/main.rs" or "Run a command".
    pub title: String,
    /// The whole of it: the diff, the command, or the tool's arguments.
    pub detail: String,
    /// When the asking tool gives up and denies it, in Unix milliseconds.
    /// Only Codex MCP calls checked by Deck's hook have one; everything
    /// else waits as long as the person takes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    /// It can spend money or publish: an MCP tool whose name says so
    /// (`mcp::needs_approval` in apex-adapters) or a request Codex marks
    /// `riskLevel: "high"`. The card says so, always shows what Always allow
    /// would cover, and the saved rule remembers it.
    #[serde(default)]
    pub risky: bool,
}

/// Something the person chose "Always allow" for. Saved with the thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "SavedRule")]
pub struct AllowedRule {
    /// The bot it applies to.
    pub by: ParticipantId,
    pub kind: ActionKind,
    /// The card's title when it was allowed, for the list in thread details.
    pub title: String,
    /// What it covers: the same tool (its title, without the arguments), the
    /// same command, edits to the same file, or the same permission question,
    /// which for Computer Use names the app. Allowing one app or command
    /// doesn't allow another.
    pub what: String,
    /// When it was allowed, in Unix seconds. 0 for rules saved before Deck
    /// recorded it.
    pub allowed_at: u64,
    /// The card it came from could spend money or publish.
    pub risky: bool,
}

/// A rule as it is read from a saved thread. Rules saved before this
/// version have no `allowed_at` or `risky`.
#[derive(Deserialize)]
struct SavedRule {
    by: ParticipantId,
    kind: ActionKind,
    title: String,
    what: String,
    #[serde(default)]
    allowed_at: u64,
    risky: Option<bool>,
}

impl From<SavedRule> for AllowedRule {
    fn from(saved: SavedRule) -> Self {
        // Before `risky` was saved, the only MCP tools that reached a card
        // were ones that can spend money or publish, so a saved tool rule
        // was always one of them.
        let risky = saved.risky.unwrap_or(saved.kind == ActionKind::Tool);
        Self { by: saved.by, kind: saved.kind, title: saved.title, what: saved.what, allowed_at: saved.allowed_at, risky }
    }
}

/// What a rule made from `action` covers. See `AllowedRule::what`.
fn scope(action: &ProposedAction) -> &str {
    match action.kind {
        ActionKind::Tool | ActionKind::Edit => &action.title,
        ActionKind::Command | ActionKind::Other | ActionKind::Plan | ActionKind::Spend => &action.detail,
    }
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl AllowedRule {
    pub fn new(by: &ParticipantId, action: &ProposedAction) -> Self {
        Self {
            by: by.clone(),
            kind: action.kind,
            title: action.title.clone(),
            what: scope(action).to_string(),
            allowed_at: now_seconds(),
            risky: action.risky,
        }
    }

    /// Whether this rule covers `action` from `by`. The title, the date and
    /// the risk are only labels.
    pub fn covers(&self, by: &ParticipantId, action: &ProposedAction) -> bool {
        &self.by == by && self.kind == action.kind && self.what == scope(action)
    }
}

/// The person's answer to a proposed action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Approve,
    /// Approve, and don't ask again about the same thing in this thread. The
    /// rule is saved with the thread and lasts until the person removes it
    /// in thread details. Codex is told to remember it only for its own
    /// session, which ends with the turn, so the saved list is the only
    /// lasting record.
    ApproveAlways,
    Reject,
}

impl Decision {
    /// Whether the action goes ahead, once or always.
    pub fn approved(self) -> bool {
        self != Decision::Reject
    }
}

/// Gets the person's answer to a proposed action. Backends call this and
/// wait; it returns when the person has decided.
#[async_trait]
pub trait Approver: Send + Sync {
    async fn decide(&self, action: ProposedAction) -> Decision;

    /// Put questions to the person and wait for their answer. Backends call
    /// this for a tool like Claude's AskUserQuestion. With nobody to ask,
    /// the questions are skipped.
    async fn ask(&self, _questions: Vec<Question>) -> Answer {
        Answer::Skipped
    }
}

/// Rejects everything. Used where nobody can be asked, so that a backend
/// which proposes an action anyway is refused rather than left waiting.
pub struct NoApprover;

#[async_trait]
impl Approver for NoApprover {
    async fn decide(&self, _: ProposedAction) -> Decision {
        Decision::Reject
    }
}

/// Proposals waiting for an answer.
#[derive(Default)]
pub struct ApprovalDesk {
    waiting: Mutex<HashMap<String, (Option<ParticipantId>, oneshot::Sender<Decision>)>>,
    next: AtomicU64,
    /// "Always allow" answers, oldest first.
    always: Mutex<Vec<AllowedRule>>,
    /// Questions waiting for words, not a yes or no. Ids share `next`.
    asking: Mutex<HashMap<String, (Option<ParticipantId>, oneshot::Sender<Answer>)>>,
}

impl ApprovalDesk {
    /// Whether the person already chose "Always allow" for this.
    pub fn always_allowed(&self, participant: &ParticipantId, action: &ProposedAction) -> bool {
        self.always.lock().unwrap().iter().any(|rule| rule.covers(participant, action))
    }

    /// Don't ask again about this. Returns false if it was already allowed.
    pub fn allow_always(&self, participant: &ParticipantId, action: &ProposedAction) -> bool {
        let mut rules = self.always.lock().unwrap();
        if rules.iter().any(|rule| rule.covers(participant, action)) { return false; }
        rules.push(AllowedRule::new(participant, action));
        true
    }

    /// Everything allowed so far, oldest first.
    pub fn allowed(&self) -> Vec<AllowedRule> {
        self.always.lock().unwrap().clone()
    }

    /// Replace the list, as when a saved thread is opened.
    pub fn set_allowed(&self, rules: Vec<AllowedRule>) {
        *self.always.lock().unwrap() = rules;
    }

    /// Ask again about this. Returns false if it wasn't in the list.
    pub fn forget(&self, rule: &AllowedRule) -> bool {
        let mut rules = self.always.lock().unwrap();
        let before = rules.len();
        rules.retain(|r| (&r.by, r.kind, &r.what) != (&rule.by, rule.kind, &rule.what));
        rules.len() != before
    }

    /// Register a new proposal. Returns its id and the place its answer
    /// will arrive. If the desk is dropped first, the answer is an error,
    /// which callers treat as a rejection.
    pub fn open(&self) -> (String, oneshot::Receiver<Decision>) {
        self.open_owned(None)
    }

    pub fn open_for(&self, participant: ParticipantId) -> (String, oneshot::Receiver<Decision>) {
        self.open_owned(Some(participant))
    }

    fn open_owned(&self, owner: Option<ParticipantId>) -> (String, oneshot::Receiver<Decision>) {
        let id = format!("ask-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
        let (sender, receiver) = oneshot::channel();
        self.waiting.lock().unwrap().insert(id.clone(), (owner, sender));
        (id, receiver)
    }

    /// Register a question. Its answer arrives on the receiver; if the
    /// question is dropped (stop, or the desk goes away) the receiver gets
    /// an error, which callers show as dropped and tell the bot was skipped.
    pub fn open_question_for(&self, participant: ParticipantId) -> (String, oneshot::Receiver<Answer>) {
        let id = format!("ask-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
        let (sender, receiver) = oneshot::channel();
        self.asking.lock().unwrap().insert(id.clone(), (Some(participant), sender));
        (id, receiver)
    }

    /// Deliver the person's answer to a question. False if no question with
    /// that id waits.
    pub fn answer(&self, request: &str, answer: Answer) -> bool {
        match self.asking.lock().unwrap().remove(request) {
            Some((_, sender)) => sender.send(answer).is_ok(),
            None => false,
        }
    }

    pub fn questions_waiting(&self) -> usize {
        self.asking.lock().unwrap().len()
    }

    /// Deliver the person's answer. Returns false if nothing with that id
    /// is waiting, for example because it was already answered.
    pub fn resolve(&self, request: &str, decision: Decision) -> bool {
        match self.waiting.lock().unwrap().remove(request) {
            Some((_, sender)) => sender.send(decision).is_ok(),
            None => false,
        }
    }

    /// Take a proposal down without an answer, as when the tool that asked
    /// stopped waiting. Returns false if it was already answered.
    pub fn withdraw(&self, request: &str) -> bool {
        self.waiting.lock().unwrap().remove(request).is_some() | self.asking.lock().unwrap().remove(request).is_some()
    }

    /// Reject everything that is waiting, as when the person presses stop.
    /// Returns how many proposals that was.
    pub fn reject_all(&self) -> usize {
        let waiting: Vec<_> = self.waiting.lock().unwrap().drain().collect();
        let count = waiting.len();
        for (_, (_, sender)) in waiting {
            let _ = sender.send(Decision::Reject);
        }
        // Dropping a question's sender drops the question.
        let asked = self.asking.lock().unwrap().drain().count();
        count + asked
    }

    pub fn reject_for(&self, participant: &ParticipantId) -> usize {
        let mut waiting = self.waiting.lock().unwrap();
        let requests: Vec<_> = waiting.iter().filter(|(_, (owner, _))| owner.as_ref() == Some(participant)).map(|(id, _)| id.clone()).collect();
        for request in &requests {
            if let Some((_, sender)) = waiting.remove(request) { let _ = sender.send(Decision::Reject); }
        }
        let mut asking = self.asking.lock().unwrap();
        let before = asking.len();
        asking.retain(|_, (owner, _)| owner.as_ref() != Some(participant));
        requests.len() + before - asking.len()
    }

    pub fn waiting(&self) -> usize {
        self.waiting.lock().unwrap().len() + self.questions_waiting()
    }
}

/// An edit a participant made to a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    /// The file, relative to the workspace folder when it is inside it.
    pub path: String,
    /// The change as a diff: lines starting with `+` were added and lines
    /// starting with `-` removed. Empty when the backend reports only that
    /// the file changed.
    pub diff: String,
    pub added: usize,
    pub removed: usize,
}

impl FileChange {
    /// Build a change, counting the added and removed lines in `diff`.
    /// The `+++` and `---` lines that name the file are not counted.
    pub fn new(path: impl Into<String>, diff: impl Into<String>) -> Self {
        let diff = diff.into();
        let count = |mark: char, header: &str| {
            diff.lines().filter(|line| line.starts_with(mark) && !line.starts_with(header)).count()
        };
        Self { path: path.into(), added: count('+', "+++"), removed: count('-', "---"), diff }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_rule_records_when_it_was_allowed_and_whether_it_was_risky() {
        let bot = ParticipantId::new("null");
        let tweet = ProposedAction { kind: ActionKind::Tool, title: "x-mcp: post_tweet".into(), detail: "{}".into(), expires_at: None, risky: true };
        let before = now_seconds();
        let rule = AllowedRule::new(&bot, &tweet);
        assert!(rule.allowed_at >= before && rule.allowed_at <= now_seconds());
        assert!(rule.risky);
        let mut older = rule.clone();
        older.allowed_at = 0;
        older.risky = false;
        assert!(older.covers(&bot, &tweet), "the date and the risk are labels, not part of the match");
    }

    use super::*;
    use futures::executor::block_on;

    #[test]
    fn questions_wait_on_the_desk_and_are_answered_once() {
        use crate::{Answer, ParticipantId};
        let desk = ApprovalDesk::default();
        let null = ParticipantId::new("null");
        let (first, first_answer) = desk.open_question_for(null.clone());
        let (card, _card_answer) = desk.open_for(null.clone());
        assert_ne!(first, card, "questions and cards share one id sequence");
        assert_eq!(desk.questions_waiting(), 1);
        assert!(desk.answer(&first, Answer::Answered(vec![vec!["Postgres".into()]])));
        assert!(!desk.answer(&first, Answer::Skipped), "already answered");
        assert!(!desk.answer(&card, Answer::Skipped), "a card is not a question");
        assert_eq!(block_on(first_answer), Ok(Answer::Answered(vec![vec!["Postgres".into()]])));

        let (_, dropped) = desk.open_question_for(null.clone());
        desk.reject_for(&null);
        assert!(block_on(dropped).is_err(), "stop drops a question without an answer");
        let (_, card_again) = desk.open_for(null.clone());
        let (_, dropped_all) = desk.open_question_for(null);
        assert_eq!(desk.reject_all(), 2, "a card and a question");
        assert_eq!(block_on(card_again), Ok(Decision::Reject));
        assert!(block_on(dropped_all).is_err());
        assert_eq!(desk.waiting(), 0);
    }

    #[test]
    fn an_answer_reaches_the_one_waiting_and_only_once() {
        let desk = ApprovalDesk::default();
        let (first, first_answer) = desk.open();
        let (second, second_answer) = desk.open();
        assert_ne!(first, second);
        assert_eq!(desk.waiting(), 2);

        assert!(desk.resolve(&second, Decision::Approve));
        assert!(!desk.resolve(&second, Decision::Reject), "already answered");
        assert!(!desk.resolve("ask-999", Decision::Approve), "never asked");
        assert_eq!(block_on(second_answer), Ok(Decision::Approve));

        assert_eq!(desk.reject_all(), 1);
        assert_eq!(block_on(first_answer), Ok(Decision::Reject));
        assert_eq!(desk.waiting(), 0);
    }

    #[test]
    fn a_proposal_whose_desk_is_gone_gets_no_answer() {
        let desk = ApprovalDesk::default();
        let (_, answer) = desk.open();
        drop(desk);
        assert!(block_on(answer).is_err());
    }

    #[test]
    fn with_nobody_to_ask_everything_is_rejected() {
        let action = ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: "rm -rf /".into(), expires_at: None, risky: false };
        assert_eq!(block_on(NoApprover.decide(action)), Decision::Reject);
    }

    #[test]
    fn always_allow_covers_the_same_thing_and_nothing_else() {
        let desk = ApprovalDesk::default();
        let bot = ParticipantId::new("codex");
        let other_bot = ParticipantId::new("claude");
        let app = |name: &str| ProposedAction { kind: ActionKind::Other, title: "cua_repl asks permission".into(), detail: format!("Allow Computer Use to use \"{name}\"?"), expires_at: None, risky: false };
        let order = |qty: u32| ProposedAction { kind: ActionKind::Tool, title: "robinhood: place_order".into(), detail: format!("{{\"qty\":{qty}}}"), expires_at: None, risky: false };
        let run = |cmd: &str| ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: cmd.into(), expires_at: None, risky: false };
        assert!(desk.allow_always(&bot, &app("Brave Browser")));
        assert!(!desk.allow_always(&bot, &app("Brave Browser")), "already allowed");
        desk.allow_always(&bot, &order(1));
        desk.allow_always(&bot, &run("npm test"));
        assert!(desk.always_allowed(&bot, &app("Brave Browser")));
        assert!(!desk.always_allowed(&bot, &app("Calculator")), "another app asks again");
        assert!(desk.always_allowed(&bot, &order(5)), "the same tool with other arguments");
        assert!(desk.always_allowed(&bot, &run("npm test")));
        assert!(!desk.always_allowed(&bot, &run("rm -rf build")), "another command asks again");
        assert!(!desk.always_allowed(&other_bot, &app("Brave Browser")), "another bot asks again");
    }

    #[test]
    fn allowed_rules_can_be_listed_restored_and_forgotten() {
        let desk = ApprovalDesk::default();
        let bot = ParticipantId::new("codex");
        let run = |cmd: &str| ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: cmd.into(), expires_at: None, risky: false };
        desk.allow_always(&bot, &run("npm test"));
        desk.allow_always(&bot, &run("cargo test"));
        let saved = desk.allowed();
        assert_eq!(saved.iter().map(|r| r.what.as_str()).collect::<Vec<_>>(), ["npm test", "cargo test"]);

        let reopened = ApprovalDesk::default();
        reopened.set_allowed(saved.clone());
        assert!(reopened.always_allowed(&bot, &run("cargo test")), "survives a restart");
        assert!(reopened.forget(&saved[0]));
        assert!(!reopened.forget(&saved[0]), "already gone");
        assert!(!reopened.always_allowed(&bot, &run("npm test")), "asks again once removed");
        assert!(reopened.always_allowed(&bot, &run("cargo test")));
    }

    #[test]
    fn a_change_counts_its_added_and_removed_lines() {
        let change = FileChange::new("src/a.rs", "--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n");
        assert_eq!((change.added, change.removed), (2, 1));
        let unknown = FileChange::new("b.rs", "");
        assert_eq!((unknown.added, unknown.removed), (0, 0));
    }
    #[test]
    fn a_withdrawn_proposal_cannot_be_answered() {
        let desk = ApprovalDesk::default();
        let (request, _answer) = desk.open();
        assert!(desk.withdraw(&request));
        assert!(!desk.withdraw(&request), "already gone");
        assert!(!desk.resolve(&request, Decision::Approve));
        assert_eq!(desk.waiting(), 0);
    }

}
