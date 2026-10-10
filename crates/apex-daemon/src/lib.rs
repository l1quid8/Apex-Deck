//! `apex-daemon`: the Apex Deck host without a window. Clients (the desktop
//! app, a phone, an SSH session) drive it over one JSON protocol.

pub mod authority;
pub mod build_info;
pub mod cli;
pub mod devices;
pub mod devices_cli;
pub mod files;
pub mod identity;
pub mod local_call;
pub mod log_time;
pub mod pair_cli;
pub mod pair_commands;
pub mod paths;
#[cfg(feature = "remote")]
pub mod pairing;
pub mod protocol;
#[cfg(feature = "remote")]
pub mod remote;
pub mod remote_config;
pub mod serve;
pub mod signals;
pub mod stdio;
pub mod websocket;
