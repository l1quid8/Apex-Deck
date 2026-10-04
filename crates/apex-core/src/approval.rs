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
use crate::ParticipantId;
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
}

/// Something a participant wants to do and is waiting for permission for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposedAction {
    pub kind: ActionKind,
    /// One line, such as "Edit src/main.rs" or "Run a command".
    pub title: String,
    /// The whole of it: the diff, the command, or the tool's arguments.
    pub detail: String,
}

impl ProposedAction {
    /// What an "Always allow" covers: the same tool on the same app, the
    /// same command, or edits to the same file. A tool's arguments are left
    /// out, so it isn't asked about again; an app or a command is kept, so
    /// allowing one doesn't allow another.
    pub fn remember_key(&self) -> String {
        let what = match self.kind {
            ActionKind::Tool | ActionKind::Edit => &self.title,
            ActionKind::Command | ActionKind::Other => &self.detail,
        };
        format!("{:?}\u{1f}{what}", self.kind)
    }
}

/// The person's answer to a proposed action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Approve,
    /// Approve, and don't ask again about the same thing in this thread
    /// until the app quits. Tools that can remember it themselves are told too.
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
    /// "Always allow" answers, by participant and [`ProposedAction::remember_key`].
    always: Mutex<std::collections::HashSet<(Option<ParticipantId>, String)>>,
}

impl ApprovalDesk {
    /// Whether the person already chose "Always allow" for this.
    pub fn always_allowed(&self, participant: Option<&ParticipantId>, action: &ProposedAction) -> bool {
        self.always.lock().unwrap().contains(&(participant.cloned(), action.remember_key()))
    }

    /// Don't ask again about this.
    pub fn allow_always(&self, participant: Option<&ParticipantId>, action: &ProposedAction) {
        self.always.lock().unwrap().insert((participant.cloned(), action.remember_key()));
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
        self.waiting.lock().unwrap().remove(request).is_some()
    }

    /// Reject everything that is waiting, as when the person presses stop.
    /// Returns how many proposals that was.
    pub fn reject_all(&self) -> usize {
        let waiting: Vec<_> = self.waiting.lock().unwrap().drain().collect();
        let count = waiting.len();
        for (_, (_, sender)) in waiting {
            let _ = sender.send(Decision::Reject);
        }
        count
    }

    pub fn reject_for(&self, participant: &ParticipantId) -> usize {
        let mut waiting = self.waiting.lock().unwrap();
        let requests: Vec<_> = waiting.iter().filter(|(_, (owner, _))| owner.as_ref() == Some(participant)).map(|(id, _)| id.clone()).collect();
        for request in &requests {
            if let Some((_, sender)) = waiting.remove(request) { let _ = sender.send(Decision::Reject); }
        }
        requests.len()
    }

    pub fn waiting(&self) -> usize {
        self.waiting.lock().unwrap().len()
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
    use super::*;
    use futures::executor::block_on;

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
        let action = ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: "rm -rf /".into() };
        assert_eq!(block_on(NoApprover.decide(action)), Decision::Reject);
    }

    #[test]
    fn always_allow_covers_the_same_thing_and_nothing_else() {
        let desk = ApprovalDesk::default();
        let bot = ParticipantId::new("codex");
        let other_bot = ParticipantId::new("claude");
        let app = |name: &str| ProposedAction { kind: ActionKind::Other, title: "cua_repl asks permission".into(), detail: format!("Allow Computer Use to use \"{name}\"?") };
        let order = |qty: u32| ProposedAction { kind: ActionKind::Tool, title: "robinhood: place_order".into(), detail: format!("{{\"qty\":{qty}}}") };
        let run = |cmd: &str| ProposedAction { kind: ActionKind::Command, title: "Run a command".into(), detail: cmd.into() };
        desk.allow_always(Some(&bot), &app("Brave Browser"));
        desk.allow_always(Some(&bot), &order(1));
        desk.allow_always(Some(&bot), &run("npm test"));
        assert!(desk.always_allowed(Some(&bot), &app("Brave Browser")));
        assert!(!desk.always_allowed(Some(&bot), &app("Calculator")), "another app asks again");
        assert!(desk.always_allowed(Some(&bot), &order(5)), "the same tool with other arguments");
        assert!(desk.always_allowed(Some(&bot), &run("npm test")));
        assert!(!desk.always_allowed(Some(&bot), &run("rm -rf build")), "another command asks again");
        assert!(!desk.always_allowed(Some(&other_bot), &app("Brave Browser")), "another bot asks again");
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
