//! The UI-free core of Apex Deck. The desktop shell and the daemon both
//! drive it; neither owns any logic of its own.

pub mod agents;
pub mod changes;
pub mod checkpoints;
pub mod export;
pub mod images;
pub mod mods;
pub mod preview;
pub mod pty;
pub mod reply_images;
pub mod storage;
pub mod assistant_service;
pub mod assistant_overview;
pub mod assistant_git;
pub mod assistant_isolation;
pub mod assistant_tasks;
pub mod assistant_conversation;
pub mod monitor;
pub mod monitor_evidence;
pub mod monitor_commands;
pub mod monitor_check;
pub mod monitor_clock;
pub mod personal;
pub mod personal_worker;
pub mod events;
pub mod quit;
pub mod host;
pub mod command;
pub mod documents;
pub mod folders;
pub mod lock;

pub use command::Command;
pub use host::{Host, HostPaths};

mod decision;
mod next_steps;
