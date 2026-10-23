//! The UI-free core of Apex Deck. The desktop shell and the daemon both
//! drive it; neither owns any logic of its own.

mod authority_file;
#[cfg(feature="test-support")]
pub mod test_support;
pub mod agents;
pub mod changes;
pub mod git_changes;
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
pub mod assistant_delegation;
pub mod assistant_conversation;
pub mod legacy_import;
mod legacy_personal;
pub mod monitor;
pub mod monitor_evidence;
pub mod monitor_commands;
pub mod monitor_check;
pub mod monitor_clock;
pub mod persona_draft;
pub mod personal;
pub mod personal_settings;
pub mod personal_workspace;
pub mod assistant_avatar;
pub mod project_memory;
mod memory_lifecycle;
pub mod project_memory_service;
pub mod personal_worker;
mod personal_task_lifecycle;
mod personal_archive;
mod personal_voice;
pub mod events;
pub mod quit;
pub mod host;
pub mod command;
pub mod documents;
pub mod folders;
pub mod project_files;
pub mod worktrees;
pub mod phone;
pub mod lock;

/// True only when this build compiled the in-process test fixtures. Production
/// builds, and `cargo test -p apex-host-production-check`, must see false.
pub const TEST_SUPPORT_COMPILED: bool = cfg!(feature = "test-support");

pub use command::Command;
pub use host::{Host, HostPaths};
pub use apex_core::{ClientCapabilities, GeneratedUiCapability};

mod next_steps;
mod step_buffers;
