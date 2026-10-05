//! `apex-daemon`: the Apex Deck host without a window. Clients (the desktop
//! app, a phone, an SSH session) drive it over one JSON protocol.

pub mod cli;
pub mod identity;
pub mod paths;
pub mod protocol;
