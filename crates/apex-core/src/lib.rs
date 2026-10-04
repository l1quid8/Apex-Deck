//! Apex Deck core: the group chat room.
//!
//! A room is one shared transcript plus a roster of participants. Each
//! participant is a model reached through some backend (an HTTP API, a
//! command-line tool, or a scripted fake for tests). The room decides who
//! speaks next, hands each speaker its own view of the transcript, and stops
//! bots from talking to each other forever.
//!
//! This crate has no network or process code and no async runtime. Backends
//! live in `apex-adapters`.

mod approval;
mod concurrent;
mod mention;
mod participant;
mod room;
pub mod testing;
mod types;
mod view;

pub use concurrent::{ConcurrentRoom, TurnBatch};
pub use approval::{ActionKind, AllowedRule, ApprovalDesk, Approver, Decision, FileChange, NoApprover, ProposedAction};
pub use mention::{handle_for, parse_mentions, MentionTarget};
pub use participant::{
    DeltaSink, Participant, ParticipantError, Progress, ProgressSink, Reply, TurnRequest,
};
pub use room::{ChangeRecord, Compaction, Room, RoomEvent, RoomOptions, RoomSnapshot, TurnPolicy};
pub use types::{
    Access, AgentTool, Backend, ContextUse, Message, ModelChoice, ParticipantConfig, ParticipantId, PlanUsage,
    PlanWindow, Speaker, TokenTotals,
};
pub use view::{render_prompt, render_view, render_view_after, system_prompt, Role, ViewTurn, PASS_TOKEN};

pub mod server_request;
