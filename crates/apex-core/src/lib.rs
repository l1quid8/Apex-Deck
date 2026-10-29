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
mod write_gate;
pub mod work_steps;

pub use concurrent::{copy_turn_line, read_only_line, ConcurrentRoom, CopyProvider, TurnBatch, TurnStartHook};
pub use approval::{ActionKind, AllowedRule, ApprovalDesk, Approver, Decision, FileChange, NoApprover, ProposedAction};
pub use mention::{mention_clash, mention_for, mentioned_words, mentions_handle, names, parse_mentions, MentionTarget};
pub use participant::{
    DeltaSink, Participant, ParticipantError, Progress, ProgressSink, Reply, TurnRequest,
};
pub use room::{ChangeRecord, ClientMessageRecord, ClientMessageRequest, ClientMessageState, Compaction, Room, RoomEvent, RoomKind, RoomOptions, RoomSnapshot, TurnPolicy};
pub use write_gate::{CheckoutWriteGate, WriteLease, WriteWaitError};
pub use types::{
    Access, AgentTool, Backend, ContextUse, MediaSettings, Message, MessageOrigin, ModelChoice, ParticipantConfig, ParticipantId, PlanUsage, Speed,
    PlanWindow, ResetCredit, ResetCredits, Speaker, TokenTotals,
};
pub use view::{render_prompt, render_view, render_view_after, system_prompt, Role, ViewTurn, PASS_TOKEN};
pub use view::{ClientCapabilities, GeneratedUiClientCapability, GeneratedUiCapability};

pub mod server_request;

pub mod next_steps;
pub mod question;
pub use next_steps::NextStep;
pub use question::{Answer, Question, QuestionEnd, QuestionOption};
