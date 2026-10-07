//! `apex-daemon`: the Apex Deck host without a window. Clients (the desktop
//! app, a phone, an SSH session) drive it over one JSON protocol.

pub mod authority;
pub mod cli;
pub mod devices;
pub mod devices_cli;
pub mod files;
pub mod identity;
pub mod paths;
pub mod protocol;
pub mod serve;
pub mod signals;
pub mod stdio;
pub mod websocket;
