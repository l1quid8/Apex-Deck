use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use futures::{FutureExt, pin_mut};

use futures::future::join_all;
use serde::{Deserialize, Serialize};

use async_trait::async_trait;

use crate::approval::{ApprovalDesk, Approver, Decision, FileChange, ProposedAction};
use crate::mention::{parse_mentions, MentionTarget};
use crate::participant::{Participant, ParticipantError, Progress, ProgressSink, Reply, TurnRequest};
use crate::types::{AgentTool, Message, ParticipantConfig, ParticipantId, PlanWindow, Speaker};
use crate::view::{render_view_after, system_prompt, Role, ViewTurn, COMPACT_ASK, COMPACT_SYSTEM, PASS_TOKEN};

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
    /// How full a participant's context window is, from its latest request.
    ContextUsage { id: ParticipantId, used_tokens: u64, window_tokens: u64 },
    /// How much of a provider account's plan is used. Shared by every agent
    /// on that provider. With `partial`, windows not listed keep their last
    /// value.
    PlanUsage { provider: AgentTool, windows: Vec<PlanWindow>, partial: bool },
    /// A participant chose not to reply.
    Passed { id: ParticipantId },
    /// A participant could not reply.
    Failed { id: ParticipantId, error: String },
    /// Bots kept addressing each other and the room cut them off.
    HopLimitReached { limit: usize },
    /// The models now see `summary` in place of the first `upto` messages.
    Compacted { id: ParticipantId, summary: String, upto: usize },
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
        Progress::Context(use_) => {
            RoomEvent::ContextUsage { id: id.clone(), used_tokens: use_.used_tokens, window_tokens: use_.window_tokens }
        }
        Progress::Plan(plan) => plan_event(plan),
    }
}

impl RoomEvent {
    /// The event that reports `plan`, for plan usage read outside a turn.
    pub fn plan(plan: &crate::types::PlanUsage) -> Self {
        plan_event(plan)
    }
}

fn plan_event(plan: &crate::types::PlanUsage) -> RoomEvent {
    RoomEvent::PlanUsage { provider: plan.provider, windows: plan.windows.clone(), partial: plan.partial }
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

/// A summary the models see in place of the older part of the transcript.
/// The person still sees every message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Compaction {
    pub summary: String,
    /// The summary covers the messages before this index.
    pub upto: usize,
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
    #[serde(default)]
    pub compaction: Option<Compaction>,
}

/// One group chat.
pub struct Room {
    roster: Vec<Arc<dyn Participant>>,
    transcript: Vec<Message>,
    /// For each participant, how much of the transcript it has been shown.
    cursors: HashMap<ParticipantId, usize>,
    last_targets: Vec<ParticipantId>,
    compaction: Option<Compaction>,
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
            compaction: self.compaction.clone(),
        }
    }

    pub fn restore(roster: Vec<Arc<dyn Participant>>, snapshot: RoomSnapshot) -> Self {
        Self {
            roster,
            transcript: snapshot.transcript,
            options: snapshot.options,
            cursors: snapshot.cursors,
            last_targets: snapshot.last_targets,
            compaction: snapshot.compaction,
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
            compaction: None,
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
        self.compaction = None;
    }

    /// Who writes the summary for `/compact`: whoever was addressed last,
    /// or else the first participant.
    pub fn summarizer(&self) -> Option<ParticipantConfig> {
        let configs = self.configs();
        self.last_targets
            .iter()
            .find_map(|id| configs.iter().find(|c| &c.id == id))
            .or_else(|| configs.first())
            .cloned()
    }

    /// Have `summarizer` summarize the conversation, then show the models
    /// that summary in place of every message so far. The person keeps the
    /// full transcript. The summarizer is passed in rather than taken from
    /// the roster so the caller can give it narrower access.
    pub async fn compact(&mut self, summarizer: &dyn Participant, on_event: EventSink<'_>) -> Result<(), String> {
        self.stop.store(false, Ordering::SeqCst);
        let upto = self.transcript.len();
        if upto == self.compacted_upto() {
            return Err("there is nothing new to summarize".to_string());
        }
        let id = summarizer.config().id.clone();
        // Seen from nobody's side, every message is labelled with its speaker.
        let outsider = ParticipantId::new("");
        let mut turns = render_view_after(self.summary(), &self.transcript[self.compacted_upto()..], &outsider, &self.configs());
        turns.push(ViewTurn { role: Role::User, content: COMPACT_ASK.to_string() });
        let request = TurnRequest { system: COMPACT_SYSTEM.to_string(), turns, unseen: Vec::new() };

        on_event(RoomEvent::TurnStarted { id: id.clone() });
        let progress = |update: Progress<'_>| on_event(progress_event(&id, update));
        let outcome = Self::interruptible(summarizer, request, self.stop.clone(), &progress, &crate::approval::NoApprover).await;
        if self.stopped() {
            on_event(RoomEvent::Stopped);
            return Ok(());
        }
        let reply = outcome.map_err(|error| error.to_string())?;
        if reply.input_tokens.is_some() || reply.output_tokens.is_some() {
            on_event(RoomEvent::Usage { id: id.clone(), input_tokens: reply.input_tokens, output_tokens: reply.output_tokens });
        }
        let summary = reply.text.trim();
        if summary.is_empty() || summary.eq_ignore_ascii_case(PASS_TOKEN) {
            return Err(format!("{} did not write a summary", summarizer.config().display_name));
        }
        self.compaction = Some(Compaction { summary: summary.to_string(), upto });
        on_event(RoomEvent::Compacted { id, summary: summary.to_string(), upto });
        Ok(())
    }

    fn compacted_upto(&self) -> usize {
        self.compaction.as_ref().map_or(0, |c| c.upto.min(self.transcript.len()))
    }

    fn summary(&self) -> Option<&str> {
        self.compaction.as_ref().map(|c| c.summary.as_str())
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
        // What the summary covers counts as seen.
        let start = self.compacted_upto();
        let seen = self.cursors.get(id).copied().unwrap_or(0).max(start).min(self.transcript.len());
        let unseen = self.transcript[seen..]
            .iter()
            .filter(|m| m.speaker != Speaker::Bot(id.clone()))
            .cloned()
            .collect();
        let request = TurnRequest {
            system: system_prompt(participant.config(), &configs),
            turns: render_view_after(self.summary(), &self.transcript[start..], id, &configs),
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
    /// Drop the provider future promptly on Stop. Its child is kill-on-drop.
    /// Preserve streamed text so a replacement model can see the unfinished work.
    async fn interruptible(
        participant: &dyn Participant, request: TurnRequest,
        stop: Arc<AtomicBool>, progress: ProgressSink<'_>, approver: &dyn Approver,
    ) -> Result<Reply, ParticipantError> {
        let partial = Mutex::new(String::new());
        let capture = |update: Progress<'_>| {
            if let Progress::Text(text) = update { partial.lock().unwrap().push_str(text); }
            progress(update);
        };
        let response = participant.respond_with_approvals(request, &capture, approver).fuse();
        let cancelled = async {
            while !stop.load(Ordering::SeqCst) {
                futures_timer::Delay::new(std::time::Duration::from_millis(25)).await;
            }
        }.fuse();
        pin_mut!(response, cancelled);
        futures::select_biased! {
            _ = cancelled => Ok(Reply::text(format!("{}\n\n[Interrupted]", partial.lock().unwrap().trim()).trim().to_string())),
            result = response => result,
        }
    }

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
                let outcome = Self::interruptible(participant.as_ref(), request, self.stop.clone(), &progress, &approver).await;
                if self.stopped() {
                    if let Ok(reply) = outcome { if !reply.text.trim().is_empty() && reply.text != "[Interrupted]" { self.push(Speaker::Bot(id.clone()), reply.text, on_event); } }
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
            let stop = &self.stop;
            let outcomes = join_all(jobs.into_iter().map(|(id, participant, request)| async move {
                let progress = |update: Progress<'_>| on_event(progress_event(&id, update));
                let approver = RoomApprover { desk, id: &id, on_event };
                let outcome = Self::interruptible(participant.as_ref(), request, stop.clone(), &progress, &approver).await;
                (id, outcome)
            }))
            .await;
            if self.stopped() {
                for (id, outcome) in outcomes {
                    if let Ok(reply) = outcome { if !reply.text.trim().is_empty() && reply.text != "[Interrupted]" { self.push(Speaker::Bot(id), reply.text, on_event); } }
                }
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
