use async_trait::async_trait;

use crate::approval::{Approver, FileChange};
use crate::types::{ContextUse, Message, ParticipantConfig, PlanUsage};
use crate::view::ViewTurn;

/// What a participant is given when it is asked to speak.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnRequest {
    /// Effective workspace access for this turn, enforced by coding adapters.
    pub access: Option<crate::Access>,
    /// A validated level for this reply only; absent means use saved settings.
    pub effort_override: Option<String>,
    /// Instructions that tell the model who it is and who else is present.
    pub system: String,
    /// The whole transcript from this participant's point of view.
    pub turns: Vec<ViewTurn>,
    /// Messages from other speakers added since this participant last spoke.
    /// Backends that keep their own session history (command-line tools with
    /// a resume option) can send only these instead of the full transcript.
    pub unseen: Vec<Message>,
    /// The thread's Plan switch is on: the bot plans and changes nothing.
    /// Agents with a planning mode of their own use it.
    pub plan: bool,
}

/// A finished reply.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Reply {
    pub text: String,
    /// Token counts, when the backend reports them.
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// What the turn cost in millionths of a US dollar, when known.
    pub cost_micros: Option<u64>,
    /// True when `cost_micros` is an estimate (such as a price quote), not a figure the provider reported.
    pub cost_estimated: bool,
}

impl Reply {
    pub fn text(text: impl Into<String>) -> Self {
        Self { text: text.into(), ..Self::default() }
    }
}

/// Why a participant could not reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParticipantError {
    /// The backend is not set up (missing key, program not found).
    NotConfigured(String),
    /// The backend was reached but the turn failed.
    Failed(String),
    /// Owned external work may still be running after cancellation.
    CleanupIncomplete(String),
}

impl std::fmt::Display for ParticipantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured(m) => write!(f, "not configured: {m}"),
            Self::Failed(m) => write!(f, "{m}"),
            Self::CleanupIncomplete(m) => write!(f, "worker cleanup incomplete: {m}"),
        }
    }
}

impl std::error::Error for ParticipantError {}

/// Receives pieces of a reply while it is being written.
pub type DeltaSink<'a> = &'a (dyn for<'s> Fn(&'s str) + Send + Sync);

/// Something a participant reports while it works on a reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Progress<'a> {
    ToolServers(&'a [crate::server_request::ToolServer]),
    /// A piece of the reply.
    Text(&'a str),
    /// What the participant is doing right now, such as reading a file or
    /// running a command. It is shown while the turn runs and is not part
    /// of the reply.
    Activity(&'a str),
    /// A file the participant has just changed.
    Change(&'a FileChange),
    /// How full the participant's context window is, as the backend reports it.
    Context(ContextUse),
    /// How much of the provider account's plan is used.
    Plan(&'a PlanUsage),
}

/// Receives progress while a reply is being worked on.
pub type ProgressSink<'a> = &'a (dyn for<'s> Fn(Progress<'s>) + Send + Sync);

/// One model in a room. Implement this to add a new backend.
#[async_trait]
pub trait Participant: Send + Sync {
    fn config(&self) -> &ParticipantConfig;

    /// Answers only a person's message that names it by `@handle`, as a
    /// bot whose every reply costs money does. Such a bot is left out when
    /// a message names nobody, when the whole room is addressed, and when
    /// another bot mentions it.
    fn named_only(&self) -> bool {
        false
    }

    /// Produce one reply. Call `on_delta` with each piece of text as it
    /// arrives so the room can show the reply while it is being written.
    /// The returned `Reply::text` must be the complete reply.
    async fn respond(
        &self,
        request: TurnRequest,
        on_delta: DeltaSink<'_>,
    ) -> Result<Reply, ParticipantError>;

    /// Produce one reply and also report what is being done along the way.
    /// The room calls this. Backends that can say more than the text of
    /// the reply (which tool they are using, for example) override it; the
    /// rest get it for free from `respond`.
    async fn respond_with_progress(
        &self,
        request: TurnRequest,
        on_progress: ProgressSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        self.respond(request, &|text: &str| on_progress(Progress::Text(text))).await
    }

    /// Produce one reply, asking `approver` before each edit or command
    /// when this participant's access level says to ask first. The room
    /// calls this. Backends that cannot ask get it for free from
    /// `respond_with_progress`, and never call the approver.
    async fn respond_with_approvals(
        &self,
        request: TurnRequest,
        on_progress: ProgressSink<'_>,
        _approver: &dyn Approver,
    ) -> Result<Reply, ParticipantError> {
        self.respond_with_progress(request, on_progress).await
    }

    /// Stop any active external work and wait for its cleanup. The room
    /// calls this before dropping a response future on Stop. Implementations
    /// must bound cleanup and report a failure when owned work may remain.
    async fn cancel_active_turn(&self) -> Result<bool, String> { Ok(false) }
}
