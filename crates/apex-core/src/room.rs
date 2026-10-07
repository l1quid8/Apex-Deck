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
use crate::types::{AgentTool, Message, ParticipantConfig, ParticipantId, PlanWindow, Speaker, TokenTotals};
use crate::view::{pinned_section, render_view_after, system_prompt, Role, ViewTurn, COMPACT_ASK, COMPACT_SYSTEM, MAX_PIN_CHARS, PASS_TOKEN};

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

/// Added to every bot's instructions while the thread's Plan switch is on.
pub const PLAN_SYSTEM: &str = "\n\nPlan mode is on in this thread. Explore and read as much as you need, but do not change any \
files or run anything that changes the project. Ask the person anything only they can decide. End your reply with a \
clear, step-by-step plan.";

/// Things that happen while a room works through a human message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RoomEvent {
    /// Settings saved by any connected client. Applies to the next turn.
    ParticipantChanged { participant: ParticipantConfig },
    ToolServers { id: ParticipantId, servers: Vec<crate::server_request::ToolServer> },
    /// A message was added to the transcript.
    MessageAdded { message: Message },
    /// The participant holding the workspace edit reservation changed.
    EditorChanged { id: Option<ParticipantId> },
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
    /// A participant asked the person something and is waiting. `request`
    /// names it when it is answered with `room_answer`.
    QuestionRequested { id: ParticipantId, request: String, questions: Vec<crate::Question> },
    /// A question left the screen: answered, skipped, or dropped.
    QuestionResolved {
        id: ParticipantId,
        request: String,
        end: crate::QuestionEnd,
        #[serde(default)]
        answers: Vec<Vec<String>>,
    },
    /// Suggested next prompts after `id`'s reply. `pending` while they are
    /// being worked out. An empty, settled list clears them.
    NextSteps {
        id: ParticipantId,
        steps: Vec<crate::NextStep>,
        #[serde(default)]
        pending: bool,
    },
    /// The thread's Plan switch was turned on or off.
    PlanChanged { on: bool },
    /// The thread's "Always allow" list changed. It is the whole list.
    AllowedChanged { allowed: Vec<crate::AllowedRule> },
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
    /// Bots kept addressing each other and the room cut them off. `next`
    /// lists who the last replies addressed, so the person can let them answer.
    HopLimitReached {
        limit: usize,
        #[serde(default)]
        next: Vec<ParticipantId>,
    },
    /// The models now see `summary` in place of the first `upto` messages.
    Compacted { id: ParticipantId, summary: String, upto: usize },
    /// The human pressed stop.
    Stopped,
    /// The room finished handling the human message.
    Idle,
    /// This participant has released its turn slot.
    ParticipantIdle { id: ParticipantId },
}

type EventSink<'a> = &'a (dyn Fn(RoomEvent) + Send + Sync);

pub(crate) fn progress_event(id: &ParticipantId, update: Progress<'_>) -> RoomEvent {
    match update {
        Progress::ToolServers(servers) => RoomEvent::ToolServers { id: id.clone(), servers: servers.to_vec() },
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
pub(crate) struct RoomApprover<'a> {
    pub(crate) desk: &'a ApprovalDesk,
    pub(crate) id: &'a ParticipantId,
    pub(crate) on_event: EventSink<'a>,
}

#[async_trait]
impl Approver for RoomApprover<'_> {
    async fn decide(&self, action: ProposedAction) -> Decision {
        // Starting the work after a plan is asked every time.
        let once = action.kind == crate::ActionKind::Plan;
        if !once && self.desk.always_allowed(self.id, &action) {
            eprintln!("[apex-deck] answered without a card (always allowed): {}", action.title);
            (self.on_event)(RoomEvent::Activity { id: self.id.clone(), text: format!("Always allowed: {}", action.title) });
            // A plain yes: the thread's saved rule answered, so no tool is
            // told to remember anything, and removing the rule takes it back.
            return Decision::Approve;
        }
        let remembered = action.clone();
        let (request, answer) = self.desk.open_for(self.id.clone());
        (self.on_event)(RoomEvent::ApprovalRequested { id: self.id.clone(), request: request.clone(), action });
        let mut card = Card { approver: self, request: Some(request) };
        // No answer at all (the chat was closed) counts as a refusal.
        let decision = match answer.await.unwrap_or(Decision::Reject) {
            Decision::ApproveAlways if once => Decision::Approve,
            decision => decision,
        };
        eprintln!("[apex-deck] card answered: {decision:?}: {}", remembered.title);
        card.settle(decision.approved());
        if decision == Decision::ApproveAlways && self.desk.allow_always(self.id, &remembered) {
            (self.on_event)(RoomEvent::AllowedChanged { allowed: self.desk.allowed() });
        }
        decision
    }

    async fn ask(&self, questions: Vec<crate::Question>) -> crate::Answer {
        let questions = crate::question::clean_questions(questions);
        let (request, answer) = self.desk.open_question_for(self.id.clone());
        (self.on_event)(RoomEvent::QuestionRequested { id: self.id.clone(), request: request.clone(), questions });
        let mut open = OpenQuestion { approver: self, request: Some(request) };
        match answer.await {
            Ok(answer) => {
                open.settle(&answer);
                answer
            }
            // Stopped, or the chat closed: `open` reports it dropped.
            Err(_) => crate::Answer::Skipped,
        }
    }
}

/// A question on screen. If its wait is abandoned it is taken down and
/// shown as dropped.
struct OpenQuestion<'a, 'b> {
    approver: &'a RoomApprover<'b>,
    request: Option<String>,
}

impl OpenQuestion<'_, '_> {
    fn settle(&mut self, answer: &crate::Answer) {
        if let Some(request) = self.request.take() {
            let (end, answers) = match answer {
                crate::Answer::Answered(answers) => (crate::QuestionEnd::Answered, answers.clone()),
                crate::Answer::Skipped => (crate::QuestionEnd::Skipped, Vec::new()),
            };
            (self.approver.on_event)(RoomEvent::QuestionResolved { id: self.approver.id.clone(), request, end, answers });
        }
    }
}

impl Drop for OpenQuestion<'_, '_> {
    fn drop(&mut self) {
        if let Some(request) = self.request.take() {
            self.approver.desk.withdraw(&request);
            (self.approver.on_event)(RoomEvent::QuestionResolved {
                id: self.approver.id.clone(), request, end: crate::QuestionEnd::Dropped, answers: Vec::new(),
            });
        }
    }
}

/// A proposal on screen. If the wait for it is abandoned, as when the tool
/// that asked stops waiting, it is taken down and shown as refused.
struct Card<'a, 'b> {
    approver: &'a RoomApprover<'b>,
    request: Option<String>,
}

impl Card<'_, '_> {
    fn settle(&mut self, approved: bool) {
        if let Some(request) = self.request.take() {
            (self.approver.on_event)(RoomEvent::ApprovalResolved { id: self.approver.id.clone(), request, approved });
        }
    }
}

impl Drop for Card<'_, '_> {
    fn drop(&mut self) {
        if let Some(request) = &self.request {
            self.approver.desk.withdraw(request);
        }
        self.settle(false);
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

/// A file a participant changed, kept with the chat for attribution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeRecord {
    pub by: ParticipantId,
    pub path: String,
    pub added: usize,
    pub removed: usize,
    /// The transcript length when the round that made it began.
    pub seq: usize,
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
    #[serde(default)]
    pub pins: Vec<String>,
    #[serde(default)]
    pub changes: Vec<ChangeRecord>,
    /// Where the folder stood when the chat began, as the app recorded it. Opaque to the room.
    #[serde(default)]
    pub baseline: Option<String>,
    /// What the person chose "Always allow" for. A fork starts without it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed: Vec<crate::AllowedRule>,
    /// Tokens each participant has used in this thread. `/clear` keeps
    /// them; a fork starts without them.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub usage: HashMap<ParticipantId, TokenTotals>,
    /// The thread's Plan switch: every bot plans and changes nothing.
    #[serde(default)]
    pub plan: bool,
}

impl RoomSnapshot {
    /// Copy the first `upto` messages, retaining only context from that point.
    pub fn fork(&self, upto: usize) -> Self {
        let upto = upto.min(self.transcript.len());
        Self {
            participants: self.participants.clone(),
            transcript: self.transcript[..upto].to_vec(),
            options: self.options,
            cursors: self.cursors.iter().map(|(id, &seen)| (id.clone(), seen.min(upto))).collect(),
            last_targets: if upto == self.transcript.len() { self.last_targets.clone() } else { Vec::new() },
            compaction: self.compaction.clone().filter(|c| c.upto <= upto),
            pins: self.pins.clone(),
            changes: self.changes.iter().filter(|c| c.seq < upto).cloned().collect(),
            baseline: self.baseline.clone(),
            allowed: Vec::new(),
            usage: HashMap::new(),
            plan: self.plan,
        }
    }
}

/// One group chat.
pub struct Room {
    roster: Vec<Arc<dyn Participant>>,
    transcript: Vec<Message>,
    /// For each participant, how much of the transcript it has been shown.
    cursors: HashMap<ParticipantId, usize>,
    last_targets: Vec<ParticipantId>,
    compaction: Option<Compaction>,
    pins: Vec<String>,
    changes: Vec<ChangeRecord>,
    baseline: Option<String>,
    /// Tokens each participant has used in this thread.
    usage: HashMap<ParticipantId, TokenTotals>,
    options: RoomOptions,
    stop: Arc<AtomicBool>,
    /// The Plan switch. Shared with the host, which flips it while a turn
    /// may hold the room.
    plan: Arc<AtomicBool>,
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
            pins: self.pins.clone(),
            changes: self.changes.clone(),
            baseline: self.baseline.clone(),
            allowed: self.desk.allowed(),
            usage: self.usage.clone(),
            plan: self.plan.load(Ordering::SeqCst),
        }
    }

    pub fn restore(roster: Vec<Arc<dyn Participant>>, snapshot: RoomSnapshot) -> Self {
        let desk = ApprovalDesk::default();
        desk.set_allowed(snapshot.allowed);
        Self {
            roster,
            transcript: snapshot.transcript,
            options: snapshot.options,
            cursors: snapshot.cursors,
            last_targets: snapshot.last_targets,
            compaction: snapshot.compaction,
            pins: snapshot.pins,
            changes: snapshot.changes,
            baseline: snapshot.baseline,
            usage: snapshot.usage,
            stop: Arc::new(AtomicBool::new(false)),
            plan: Arc::new(AtomicBool::new(snapshot.plan)),
            desk: Arc::new(desk),
        }
    }

    pub fn new(roster: Vec<Arc<dyn Participant>>, options: RoomOptions) -> Self {
        Self {
            roster,
            transcript: Vec::new(),
            cursors: HashMap::new(),
            last_targets: Vec::new(),
            compaction: None,
            pins: Vec::new(),
            changes: Vec::new(),
            baseline: None,
            usage: HashMap::new(),
            options,
            stop: Arc::new(AtomicBool::new(false)),
            plan: Arc::new(AtomicBool::new(false)),
            desk: Arc::new(ApprovalDesk::default()),
        }
    }

    pub(crate) fn record_changes(&mut self, changes: Vec<ChangeRecord>) { self.changes.extend(changes); }

    /// Tokens each participant has used in this thread.
    pub fn usage(&self) -> &HashMap<ParticipantId, TokenTotals> {
        &self.usage
    }

    pub fn baseline(&self) -> Option<&str> {
        self.baseline.as_deref()
    }

    pub fn set_baseline(&mut self, tree: String) {
        self.baseline = Some(tree);
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

    /// Replace only model/effort while active turns retain their cloned instance.
    pub fn replace_turn_settings(&mut self, participant: Arc<dyn Participant>) -> bool {
        let next = participant.config();
        let Some(current) = self.roster.iter().find(|p| p.config().id == next.id) else { return false; };
        let mut permitted = current.config().clone();
        permitted.effort = next.effort.clone();
        match (&mut permitted.backend, &next.backend) {
            (crate::Backend::Agent { model, .. }, crate::Backend::Agent { model: new, .. }) => *model = new.clone(),
            (crate::Backend::OpenAiCompatible { model, .. }, crate::Backend::OpenAiCompatible { model: new, .. }) => *model = new.clone(),
            _ => {}
        }
        if &permitted != next { return false; }
        self.replace_participant(participant)
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
        self.pins = self.pins.iter().map(|pin| response_pin_parts(pin).map_or_else(|| pin.clone(), |(_, text)| text.to_string())).collect();
        self.transcript.clear();
        self.cursors.clear();
        self.last_targets.clear();
        self.compaction = None;
        self.changes.clear();
        self.baseline = None;
    }

    /// Drop every message from `upto` on, as if they were never sent. Pins,
    /// token totals and Always allow rules stay.
    pub fn rewind(&mut self, upto: usize) {
        if upto >= self.transcript.len() { return; }
        self.pins.retain(|pin| response_pin_parts(pin).is_none_or(|(seq, _)| seq < upto));
        self.transcript.truncate(upto);
        for seen in self.cursors.values_mut() { *seen = (*seen).min(upto); }
        self.last_targets.clear();
        if self.compaction.as_ref().is_some_and(|c| c.upto > upto) { self.compaction = None; }
        self.changes.retain(|c| c.seq < upto);
    }

    /// Facts every model is given on every turn. They live outside the
    /// transcript, so `/clear` and `/compact` keep them.
    pub fn pins(&self) -> &[String] {
        &self.pins
    }

    pub fn pin(&mut self, fact: &str) -> Result<(), String> {
        let fact = fact.trim();
        if fact.is_empty() {
            return Err("select a response to pin".into());
        }
        if response_pin_parts(fact).is_none() && fact.chars().count() > MAX_PIN_CHARS {
            return Err(format!("pins can be at most {MAX_PIN_CHARS} characters"));
        }
        if self.pins.iter().any(|p| p == fact) {
            return Err("that is already pinned".into());
        }
        self.pins.push(fact.to_string());
        Ok(())
    }

    pub fn unpin(&mut self, index: usize) -> Result<(), String> {
        if index >= self.pins.len() {
            return Err("that pin is gone".into());
        }
        self.pins.remove(index);
        Ok(())
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
        let request = TurnRequest { access: Some(crate::Access::Read), system: COMPACT_SYSTEM.to_string(), turns, unseen: Vec::new(), plan: false };

        on_event(RoomEvent::TurnStarted { id: id.clone() });
        let progress = |update: Progress<'_>| on_event(progress_event(&id, update));
        let outcome = Self::interruptible(summarizer, request, self.stop.clone(), &progress, &crate::approval::NoApprover).await;
        if self.stopped() {
            on_event(RoomEvent::Stopped);
            return Ok(());
        }
        let reply = outcome.map_err(|error| error.to_string())?;
        if reply.input_tokens.is_some() || reply.output_tokens.is_some() {
            self.usage.entry(id.clone()).or_default().add(reply.input_tokens, reply.output_tokens);
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

    /// The Plan switch, for the host to flip without the room's lock.
    pub fn plan_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.plan)
    }

    pub(crate) fn has(&self, id: &ParticipantId) -> bool {
        self.roster.iter().any(|p| &p.config().id == id)
    }

    fn all_ids(&self) -> Vec<ParticipantId> {
        self.roster.iter().map(|p| p.config().id.clone()).collect()
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    pub(crate) fn push(&mut self, speaker: Speaker, text: String, on_event: EventSink<'_>) {
        let servers = if speaker == Speaker::Human { crate::server_request::parse_server_requests(&text) } else { vec![] };
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64);
        let message = Message { servers, seq: self.transcript.len(), speaker, text, at };
        self.transcript.push(message.clone());
        on_event(RoomEvent::MessageAdded { message });
    }

    pub fn resolve_targets(&self, text: &str) -> Vec<ParticipantId> {
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
        targets
    }

    pub(crate) fn remember_targets(&mut self, targets: Vec<ParticipantId>) {
        self.last_targets = targets;
    }

    pub(crate) fn targets_for_human(&mut self, text: &str) -> Vec<ParticipantId> {
        let targets = self.resolve_targets(text);
        self.last_targets = targets.clone();
        targets
    }

    pub(crate) fn request_for(&self, id: &ParticipantId) -> Option<(Arc<dyn Participant>, TurnRequest)> {
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
        let mut request = TurnRequest {
            access: Some(participant.config().access),
            system: system_prompt(participant.config(), &configs) + &pinned_section(&self.pins) + &self.transcript.iter().rev().find(|m| m.speaker == Speaker::Human).map(|m| {
                crate::server_request::prompt_section(&m.text)
            }).unwrap_or_default(),
            turns: render_view_after(self.summary(), &self.transcript[start..], id, &configs),
            unseen,
            plan: false,
        };
        if self.plan.load(Ordering::SeqCst) {
            request.plan = true;
            request.access = Some(crate::Access::Read);
            request.system.push_str(PLAN_SYSTEM);
        }
        Some((participant, request))
    }

    /// What to send `id` for suggested next prompts after its latest reply:
    /// its own view of the chat, then the next-steps question, read-only.
    pub fn next_steps_request(&self, id: &ParticipantId) -> Option<(Arc<dyn Participant>, TurnRequest)> {
        let (participant, mut request) = self.request_for(id)?;
        // Suggesting is not planning, even while the thread plans.
        if request.plan {
            request.plan = false;
            request.system.truncate(request.system.len() - PLAN_SYSTEM.len());
        }
        request.turns.push(ViewTurn { role: Role::User, content: crate::next_steps::ASK.to_string() });
        request.access = Some(crate::Access::Read);
        request.unseen = Vec::new();
        Some((participant, request))
    }

    /// Record the outcome of one turn. Returns the ids this reply addressed.
    pub(crate) fn settle(
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
                    self.usage.entry(id.clone()).or_default().add(reply.input_tokens, reply.output_tokens);
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
    pub(crate) async fn interruptible(
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
                let made = Mutex::new(Vec::new());
                let progress = |update: Progress<'_>| {
                    if let Progress::Change(change) = &update {
                        made.lock().unwrap().push(ChangeRecord {
                            by: id.clone(), path: change.path.clone(), added: change.added, removed: change.removed, seq: shown,
                        });
                    }
                    on_event(progress_event(id, update));
                };
                let approver = RoomApprover { desk: &self.desk, id, on_event };
                let outcome = Self::interruptible(participant.as_ref(), request, self.stop.clone(), &progress, &approver).await;
                self.changes.extend(made.into_inner().unwrap());
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
            let made = Mutex::new(Vec::new());
            let made_ref = &made;
            let desk: &ApprovalDesk = &self.desk;
            let stop = &self.stop;
            let outcomes = join_all(jobs.into_iter().map(|(id, participant, request)| async move {
                let progress = |update: Progress<'_>| {
                    if let Progress::Change(change) = &update {
                        made_ref.lock().unwrap().push(ChangeRecord {
                            by: id.clone(), path: change.path.clone(), added: change.added, removed: change.removed, seq: shown,
                        });
                    }
                    on_event(progress_event(&id, update));
                };
                let approver = RoomApprover { desk, id: &id, on_event };
                let outcome = Self::interruptible(participant.as_ref(), request, stop.clone(), &progress, &approver).await;
                (id, outcome)
            }))
            .await;
            // Reported edits remain even when Stop interrupts the turn.
            self.changes.extend(made.into_inner().unwrap());
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
                on_event(RoomEvent::HopLimitReached { limit: self.options.max_bot_hops, next: targets.clone() });
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

#[cfg(test)]
mod approver_tests {
    use super::*;
    use crate::approval::ActionKind;
    use futures::FutureExt;
    use std::sync::Mutex;

    #[test]
    fn the_next_steps_question_is_never_asked_in_plan_mode() {
        let null = Arc::new(crate::testing::ScriptedParticipant::new("null", &["done"]));
        let mut room = Room::new(vec![null], RoomOptions::default());
        futures::executor::block_on(room.post_human("@null hi", &|_| {}));
        room.plan_handle().store(true, Ordering::SeqCst);
        let (_, request) = room.next_steps_request(&ParticipantId::new("null")).unwrap();
        assert!(!request.plan, "a planning fork would plan instead of suggesting");
        assert!(!request.system.contains(PLAN_SYSTEM));
        assert_eq!(request.access, Some(crate::Access::Read));
    }

    #[test]
    fn a_start_the_work_card_is_never_always_allowed() {
        let desk = ApprovalDesk::default();
        let id = ParticipantId::new("jigga");
        let sink = |_: RoomEvent| {};
        let approver = RoomApprover { desk: &desk, id: &id, on_event: &sink };
        let start = ProposedAction { kind: ActionKind::Plan, title: "Start the work?".into(), detail: "1. Do it".into(), expires_at: None, risky: false };
        let (decision, _) = futures::executor::block_on(async {
            futures::join!(approver.decide(start.clone()), async { desk.resolve("ask-1", Decision::ApproveAlways) })
        });
        assert_eq!(decision, Decision::Approve, "an always answer counts once");
        assert!(desk.allowed().is_empty(), "no rule is saved");
        desk.allow_always(&id, &start);
        let (_, asked) = futures::executor::block_on(async {
            futures::join!(approver.decide(start.clone()), async { desk.resolve("ask-2", Decision::Approve) })
        });
        assert!(asked, "a saved rule never answers it");
    }

    #[test]
    fn with_plan_on_every_turn_is_read_only_and_told_to_plan() {
        let null = Arc::new(crate::testing::ScriptedParticipant::new("null", &["one", "two"]));
        let mut config = null.config().clone();
        config.access = crate::Access::Full;
        let full = Arc::new(crate::testing::ScriptedParticipant::from_config(config));
        let mut room = Room::new(vec![full.clone()], RoomOptions::default());
        let id = ParticipantId::new("null");
        let (_, off) = room.request_for(&id).unwrap();
        assert!(!off.plan);
        assert_eq!(off.access, Some(crate::Access::Full));
        assert!(!off.system.contains(PLAN_SYSTEM));
        room.plan_handle().store(true, Ordering::SeqCst);
        let (_, on) = room.request_for(&id).unwrap();
        assert!(on.plan);
        assert_eq!(on.access, Some(crate::Access::Read), "nobody edits while planning");
        assert!(on.system.ends_with(PLAN_SYSTEM));
        let _ = futures::executor::block_on(room.post_human("@null hi", &|_| {}));
    }

    #[test]
    fn the_plan_switch_is_saved_with_the_thread() {
        let room = Room::new(vec![], RoomOptions::default());
        assert!(!room.snapshot().plan);
        room.plan_handle().store(true, Ordering::SeqCst);
        let saved = room.snapshot();
        assert!(saved.plan);
        assert!(Room::restore(vec![], saved.clone()).plan_handle().load(Ordering::SeqCst));
        let mut old = serde_json::to_value(&saved).unwrap();
        old.as_object_mut().unwrap().remove("plan");
        assert!(!serde_json::from_value::<RoomSnapshot>(old).unwrap().plan, "threads saved before the switch existed are not planning");
    }

    #[test]
    fn a_question_is_shown_answered_and_taken_down() {
        use crate::{Answer, Question, QuestionEnd, QuestionOption};
        let desk = ApprovalDesk::default();
        let id = ParticipantId::new("null");
        let events = Mutex::new(Vec::new());
        let sink = |event: RoomEvent| events.lock().unwrap().push(event);
        let approver = RoomApprover { desk: &desk, id: &id, on_event: &sink };
        let asked = vec![Question { header: "DB".into(), question: "Which\u{200b} one?".into(), options: vec![QuestionOption { label: "SQLite".into(), description: String::new() }], multi_select: false }];
        let (answer, answered) = futures::executor::block_on(async {
            futures::join!(approver.ask(asked), async { desk.answer("ask-1", Answer::Answered(vec![vec!["SQLite".into()]])) })
        });
        assert!(answered);
        assert_eq!(answer, Answer::Answered(vec![vec!["SQLite".into()]]));
        let events = events.into_inner().unwrap();
        match &events[0] {
            RoomEvent::QuestionRequested { request, questions, .. } => {
                assert_eq!(request, "ask-1");
                assert_eq!(questions[0].question, "Which one?", "cleaned before anyone sees it");
            }
            other => panic!("expected a question, got {other:?}"),
        }
        assert_eq!(events[1], RoomEvent::QuestionResolved { id: id.clone(), request: "ask-1".into(), end: QuestionEnd::Answered, answers: vec![vec!["SQLite".into()]] });
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn a_question_dropped_by_stop_says_so_and_the_bot_hears_skipped() {
        use crate::{Answer, Question, QuestionEnd};
        let desk = ApprovalDesk::default();
        let id = ParticipantId::new("null");
        let events = Mutex::new(Vec::new());
        let sink = |event: RoomEvent| events.lock().unwrap().push(event);
        let approver = RoomApprover { desk: &desk, id: &id, on_event: &sink };
        let asked = vec![Question { header: String::new(), question: "Go?".into(), options: vec![], multi_select: false }];
        let (answer, _) = futures::executor::block_on(async { futures::join!(approver.ask(asked), async { desk.reject_all() }) });
        assert_eq!(answer, Answer::Skipped);
        let events = events.into_inner().unwrap();
        assert!(matches!(events.last(), Some(RoomEvent::QuestionResolved { end: QuestionEnd::Dropped, .. })), "{events:?}");
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn the_next_steps_request_is_the_bots_own_view_plus_the_question_read_only() {
        let null = Arc::new(crate::testing::ScriptedParticipant::new("null", &["done"]));
        let mut room = Room::new(vec![null.clone()], RoomOptions::default());
        futures::executor::block_on(room.post_human("@null hi", &|_| {}));
        let (participant, request) = room.next_steps_request(&ParticipantId::new("null")).unwrap();
        assert_eq!(participant.config().id.as_str(), "null");
        assert_eq!(request.access, Some(crate::Access::Read));
        assert_eq!(request.turns.last().unwrap().content, crate::next_steps::ASK);
        let first = &null.requests()[0].turns;
        assert_eq!(request.turns[..first.len()], first[..], "everything the bot saw comes first");
        assert_eq!(request.turns[request.turns.len() - 2].content, "done", "then its own reply");
        assert!(request.unseen.is_empty());
        assert!(room.next_steps_request(&ParticipantId::new("nobody")).is_none());
    }

    fn action() -> ProposedAction {
        ProposedAction { kind: ActionKind::Tool, title: "probe: place_order".into(), detail: "{}".into(), expires_at: None, risky: false }
    }

    #[test]
    fn a_card_whose_wait_is_abandoned_is_taken_down() {
        let desk = ApprovalDesk::default();
        let id = ParticipantId::new("null");
        let events = Mutex::new(Vec::new());
        let sink = |event: RoomEvent| events.lock().unwrap().push(event);
        let approver = RoomApprover { desk: &desk, id: &id, on_event: &sink };
        let mut waiting = approver.decide(action());
        assert!(waiting.as_mut().now_or_never().is_none(), "nobody has answered");
        assert_eq!(desk.waiting(), 1);
        drop(waiting);
        assert_eq!(desk.waiting(), 0, "the card is gone");
        let events = events.into_inner().unwrap();
        assert!(matches!(events.as_slice(), [RoomEvent::ApprovalRequested { .. }, RoomEvent::ApprovalResolved { approved: false, .. }]), "{events:?}");
    }

    #[test]
    fn an_answered_card_is_settled_once() {
        let desk = ApprovalDesk::default();
        let id = ParticipantId::new("null");
        let events = Mutex::new(Vec::new());
        let sink = |event: RoomEvent| events.lock().unwrap().push(event);
        let approver = RoomApprover { desk: &desk, id: &id, on_event: &sink };
        let mut waiting = approver.decide(action());
        assert!(waiting.as_mut().now_or_never().is_none());
        assert!(desk.resolve("ask-1", Decision::Approve));
        assert_eq!(futures::executor::block_on(waiting), Decision::Approve);
        let events = events.into_inner().unwrap();
        assert!(matches!(events.as_slice(), [RoomEvent::ApprovalRequested { .. }, RoomEvent::ApprovalResolved { approved: true, .. }]), "{events:?}");
    }

    #[test]
    fn always_allow_skips_the_card_next_time() {
        let desk = ApprovalDesk::default();
        let id = ParticipantId::new("null");
        let events = Mutex::new(Vec::new());
        let sink = |event: RoomEvent| events.lock().unwrap().push(event);
        let approver = RoomApprover { desk: &desk, id: &id, on_event: &sink };
        let mut first = approver.decide(action());
        assert!(first.as_mut().now_or_never().is_none());
        assert!(desk.resolve("ask-1", Decision::ApproveAlways));
        assert_eq!(futures::executor::block_on(first), Decision::ApproveAlways);
        let second = approver.decide(action()).now_or_never();
        assert_eq!(second, Some(Decision::Approve), "answered without waiting, as a plain yes so no tool is told to remember it");
        assert_eq!(desk.waiting(), 0, "no second card");
        let events = events.into_inner().unwrap();
        assert!(matches!(events.as_slice(), [RoomEvent::ApprovalRequested { .. }, RoomEvent::ApprovalResolved { approved: true, .. },
            RoomEvent::AllowedChanged { allowed }, RoomEvent::Activity { .. }] if allowed.len() == 1), "{events:?}");
    }
}

fn response_pin_parts(pin: &str) -> Option<(usize, &str)> {
    let rest = pin.strip_prefix("[Pinned response #")?;
    let (seq, text) = rest.split_once("]\n")?;
    Some((seq.parse().ok()?, text))
}
