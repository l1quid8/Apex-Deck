use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures::future::join_all;
use serde::{Deserialize, Serialize};

use async_trait::async_trait;

use crate::approval::{ApprovalDesk, Approver, Decision, FileChange, ProposedAction};
use crate::mention::{parse_mentions, MentionTarget};
use crate::participant::{Participant, ParticipantError, Progress, Reply, TurnRequest};
use crate::types::{Message, ParticipantConfig, ParticipantId, Speaker};
use crate::view::{render_view, system_prompt, PASS_TOKEN};

/// Who answers a human message that does not @mention anyone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnPolicy {
    /// Whoever was addressed last keeps answering. In a new room that is the
    /// first participant.
    #[default]
    Mention,
    /// Every participant answers at the same time, without seeing the
    /// others' answers to this message.
    Everyone,
    /// Every participant answers in roster order, each seeing the answers
    /// given before it.
    RoundRobin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomOptions {
    pub policy: TurnPolicy,
    /// How many rounds of bots answering other bots are allowed after one
    /// human message. 0 means bots can never trigger each other.
    pub max_bot_hops: usize,
}

impl Default for RoomOptions {
    fn default() -> Self {
        Self { policy: TurnPolicy::Mention, max_bot_hops: 3 }
    }
}

/// Things that happen while a room works through a human message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RoomEvent {
    /// A message was added to the transcript.
    MessageAdded { message: Message },
    /// A participant started writing.
    TurnStarted { id: ParticipantId },
    /// A piece of a reply that is still being written.
    Delta { id: ParticipantId, text: String },
    /// What a participant is doing while it works on its reply, such as
    /// reading a file or running a command.
    Activity { id: ParticipantId, text: String },
    /// A participant wants to do something and is waiting for a yes or no.
    /// `request` names it when the answer is given.
    ApprovalRequested { id: ParticipantId, request: String, action: ProposedAction },
    /// A proposed action was answered.
    ApprovalResolved { id: ParticipantId, request: String, approved: bool },
    /// A participant changed a file.
    Changed { id: ParticipantId, change: FileChange },
    /// How many tokens a finished turn used, when the backend reports it.
    Usage { id: ParticipantId, input_tokens: Option<u64>, output_tokens: Option<u64> },
    /// A participant chose not to reply.
    Passed { id: ParticipantId },
    /// A participant could not reply.
    Failed { id: ParticipantId, error: String },
    /// Bots kept addressing each other and the room cut them off.
    HopLimitReached { limit: usize },
    /// The human pressed stop.
    Stopped,
    /// The room finished handling the human message.
    Idle,
}

type EventSink<'a> = &'a (dyn Fn(RoomEvent) + Send + Sync);

fn progress_event(id: &ParticipantId, update: Progress<'_>) -> RoomEvent {
    match update {
        Progress::Text(text) => RoomEvent::Delta { id: id.clone(), text: text.to_string() },
        Progress::Activity(text) => RoomEvent::Activity { id: id.clone(), text: text.to_string() },
        Progress::Change(change) => RoomEvent::Changed { id: id.clone(), change: change.clone() },
    }
}

/// Puts a participant's proposal in front of the person and waits for
/// their answer.
struct RoomApprover<'a> {
    desk: &'a ApprovalDesk,
    id: &'a ParticipantId,
    on_event: EventSink<'a>,
}

#[async_trait]
impl Approver for RoomApprover<'_> {
    async fn decide(&self, action: ProposedAction) -> Decision {
        let (request, answer) = self.desk.open();
        (self.on_event)(RoomEvent::ApprovalRequested { id: self.id.clone(), request: request.clone(), action });
        // No answer at all (the chat was closed) counts as a refusal.
        let decision = answer.await.unwrap_or(Decision::Reject);
        (self.on_event)(RoomEvent::ApprovalResolved {
            id: self.id.clone(),
            request,
            approved: decision == Decision::Approve,
        });
        decision
    }
}

/// Durable chat data. Running turns and provider processes are never resumed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomSnapshot {
    pub participants: Vec<ParticipantConfig>,
    pub transcript: Vec<Message>,
    pub options: RoomOptions,
    #[serde(default)]
    pub cursors: HashMap<ParticipantId, usize>,
    #[serde(default)]
    pub last_targets: Vec<ParticipantId>,
}

/// One group chat.
pub struct Room {
    roster: Vec<Arc<dyn Participant>>,
    transcript: Vec<Message>,
    /// For each participant, how much of the transcript it has been shown.
    cursors: HashMap<ParticipantId, usize>,
    last_targets: Vec<ParticipantId>,
    options: RoomOptions,
    stop: Arc<AtomicBool>,
    /// Actions participants have proposed and are waiting on.
    desk: Arc<ApprovalDesk>,
}

impl Room {
    /// Where this room's proposed actions wait for an answer. Another task
    /// uses it to deliver the person's decision while a turn is running.
    pub fn approvals_handle(&self) -> Arc<ApprovalDesk> {
        Arc::clone(&self.desk)
    }

    pub fn snapshot(&self) -> RoomSnapshot {
        RoomSnapshot {
            participants: self.configs(),
            transcript: self.transcript.clone(),
            options: self.options,
            cursors: self.cursors.clone(),
            last_targets: self.last_targets.clone(),
        }
    }

    pub fn restore(roster: Vec<Arc<dyn Participant>>, snapshot: RoomSnapshot) -> Self {
        Self {
            roster,
            transcript: snapshot.transcript,
            options: snapshot.options,
            cursors: snapshot.cursors,
            last_targets: snapshot.last_targets,
            stop: Arc::new(AtomicBool::new(false)),
            desk: Arc::new(ApprovalDesk::default()),
        }
    }

    pub fn new(roster: Vec<Arc<dyn Participant>>, options: RoomOptions) -> Self {
        Self {
            roster,
            transcript: Vec::new(),
            cursors: HashMap::new(),
            last_targets: Vec::new(),
            options,
            stop: Arc::new(AtomicBool::new(false)),
            desk: Arc::new(ApprovalDesk::default()),
        }
    }

    pub fn transcript(&self) -> &[Message] {
        &self.transcript
    }

    pub fn options(&self) -> RoomOptions {
        self.options
    }

    pub fn set_options(&mut self, options: RoomOptions) {
        self.options = options;
    }

    pub fn configs(&self) -> Vec<ParticipantConfig> {
        self.roster.iter().map(|p| p.config().clone()).collect()
    }

    /// Add a participant. Returns false if that id is already in the room.
    pub fn add_participant(&mut self, participant: Arc<dyn Participant>) -> bool {
        if self.has(&participant.config().id) {
            return false;
        }
        self.roster.push(participant);
        true
    }

    /// Swap in a new version of a participant that is already in the room
    /// (same id), keeping its place in the roster and what it has seen.
    /// Returns false if nobody in the room has that id.
    pub fn replace_participant(&mut self, participant: Arc<dyn Participant>) -> bool {
        let id = participant.config().id.clone();
        match self.roster.iter_mut().find(|p| p.config().id == id) {
            Some(slot) => {
                *slot = participant;
                true
            }
            None => false,
        }
    }

    /// Remove a participant. Its past messages stay in the transcript.
    pub fn remove_participant(&mut self, id: &ParticipantId) -> bool {
        let before = self.roster.len();
        self.roster.retain(|p| &p.config().id != id);
        self.cursors.remove(id);
        self.last_targets.retain(|t| t != id);
        self.roster.len() != before
    }

    /// Forget the conversation but keep the participants and settings.
    /// Participants see only the transcript, so this resets their context.
    pub fn clear(&mut self) {
        self.transcript.clear();
        self.cursors.clear();
        self.last_targets.clear();
    }

    /// A flag another task can set to stop the room. The room checks it
    /// between turns and discards replies that arrive after it is set.
    pub fn stop_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop)
    }

    fn has(&self, id: &ParticipantId) -> bool {
        self.roster.iter().any(|p| &p.config().id == id)
    }

    fn all_ids(&self) -> Vec<ParticipantId> {
        self.roster.iter().map(|p| p.config().id.clone()).collect()
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn push(&mut self, speaker: Speaker, text: String, on_event: EventSink<'_>) {
        let message = Message { seq: self.transcript.len(), speaker, text };
        self.transcript.push(message.clone());
        on_event(RoomEvent::MessageAdded { message });
    }

    fn targets_for_human(&mut self, text: &str) -> Vec<ParticipantId> {
        let configs = self.configs();
        let targets = match parse_mentions(text, &configs) {
            MentionTarget::Everyone => self.all_ids(),
            MentionTarget::Some(ids) => ids,
            MentionTarget::None => match self.options.policy {
                TurnPolicy::Everyone | TurnPolicy::RoundRobin => self.all_ids(),
                TurnPolicy::Mention => {
                    let sticky: Vec<ParticipantId> =
                        self.last_targets.iter().filter(|id| self.has(id)).cloned().collect();
                    if sticky.is_empty() {
                        self.all_ids().into_iter().take(1).collect()
                    } else {
                        sticky
                    }
                }
            },
        };
        self.last_targets = targets.clone();
        targets
    }

    fn request_for(&self, id: &ParticipantId) -> Option<(Arc<dyn Participant>, TurnRequest)> {
        let participant = self.roster.iter().find(|p| &p.config().id == id)?.clone();
        let configs = self.configs();
        let seen = self.cursors.get(id).copied().unwrap_or(0).min(self.transcript.len());
        let unseen = self.transcript[seen..]
            .iter()
            .filter(|m| m.speaker != Speaker::Bot(id.clone()))
            .cloned()
            .collect();
        let request = TurnRequest {
            system: system_prompt(participant.config(), &configs),
            turns: render_view(&self.transcript, id, &configs),
            unseen,
        };
        Some((participant, request))
    }

    /// Record the outcome of one turn. Returns the ids this reply addressed.
    fn settle(
        &mut self,
        id: &ParticipantId,
        shown: usize,
        outcome: Result<Reply, ParticipantError>,
        on_event: EventSink<'_>,
    ) -> Vec<ParticipantId> {
        self.cursors.insert(id.clone(), shown);
        match outcome {
            Err(error) => {
                on_event(RoomEvent::Failed { id: id.clone(), error: error.to_string() });
                Vec::new()
            }
            Ok(reply) => {
                if reply.input_tokens.is_some() || reply.output_tokens.is_some() {
                    on_event(RoomEvent::Usage {
                        id: id.clone(),
                        input_tokens: reply.input_tokens,
                        output_tokens: reply.output_tokens,
                    });
                }
                let text = reply.text.trim();
                if text.is_empty() || text.eq_ignore_ascii_case(PASS_TOKEN) {
                    on_event(RoomEvent::Passed { id: id.clone() });
                    return Vec::new();
                }
                let addressed = match parse_mentions(text, &self.configs()) {
                    MentionTarget::Everyone => self.all_ids(),
                    MentionTarget::Some(ids) => ids,
                    MentionTarget::None => Vec::new(),
                };
                self.push(Speaker::Bot(id.clone()), text.to_string(), on_event);
                addressed.into_iter().filter(|other| other != id).collect()
            }
        }
    }

    /// Run one wave of turns. Returns the participants the replies addressed,
    /// or `None` if the room was stopped.
    async fn run_wave(
        &mut self,
        targets: &[ParticipantId],
        sequential: bool,
        on_event: EventSink<'_>,
    ) -> Option<Vec<ParticipantId>> {
        let mut next: Vec<ParticipantId> = Vec::new();
        let mut note = |ids: Vec<ParticipantId>| {
            for id in ids {
                if !next.contains(&id) {
                    next.push(id);
                }
            }
        };

        if sequential {
            for id in targets {
                if self.stopped() {
                    return None;
                }
                let Some((participant, request)) = self.request_for(id) else { continue };
                let shown = self.transcript.len();
                on_event(RoomEvent::TurnStarted { id: id.clone() });
                let progress = |update: Progress<'_>| on_event(progress_event(id, update));
                let approver = RoomApprover { desk: &self.desk, id, on_event };
                let outcome = participant.respond_with_approvals(request, &progress, &approver).await;
                if self.stopped() {
                    return None;
                }
                note(self.settle(id, shown, outcome, on_event));
            }
        } else {
            let shown = self.transcript.len();
            let jobs: Vec<_> = targets
                .iter()
                .filter_map(|id| self.request_for(id).map(|(p, r)| (id.clone(), p, r)))
                .collect();
            for (id, _, _) in &jobs {
                on_event(RoomEvent::TurnStarted { id: id.clone() });
            }
            let desk: &ApprovalDesk = &self.desk;
            let outcomes = join_all(jobs.into_iter().map(|(id, participant, request)| async move {
                let progress = |update: Progress<'_>| on_event(progress_event(&id, update));
                let approver = RoomApprover { desk, id: &id, on_event };
                let outcome = participant.respond_with_approvals(request, &progress, &approver).await;
                (id, outcome)
            }))
            .await;
            if self.stopped() {
                return None;
            }
            for (id, outcome) in outcomes {
                note(self.settle(&id, shown, outcome, on_event));
            }
        }
        Some(next)
    }

    /// Add a human message and let the room answer it.
    ///
    /// The human's message is answered by the participants it @mentions, or
    /// by the room's turn policy if it mentions nobody. If a reply @mentions
    /// another participant, that participant answers next, up to
    /// `max_bot_hops` rounds.
    pub async fn post_human(&mut self, text: &str, on_event: EventSink<'_>) {
        self.stop.store(false, Ordering::SeqCst);
        self.push(Speaker::Human, text.to_string(), on_event);

        let mut targets = self.targets_for_human(text);
        let mut sequential = self.options.policy == TurnPolicy::RoundRobin;
        let mut hops = 0;

        loop {
            if targets.is_empty() {
                break;
            }
            match self.run_wave(&targets, sequential, on_event).await {
                None => {
                    on_event(RoomEvent::Stopped);
                    break;
                }
                Some(next) => {
                    targets = next.into_iter().filter(|id| self.has(id)).collect();
                }
            }
            if targets.is_empty() {
                break;
            }
            if hops >= self.options.max_bot_hops {
                on_event(RoomEvent::HopLimitReached { limit: self.options.max_bot_hops });
                break;
            }
            hops += 1;
            // Follow-up rounds run one at a time so each bot sees what the
            // bot before it said.
            sequential = true;
        }
        on_event(RoomEvent::Idle);
    }
}
