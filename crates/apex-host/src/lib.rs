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
pub mod events;
pub mod quit;
pub mod host;

pub use host::{Host, HostPaths};
