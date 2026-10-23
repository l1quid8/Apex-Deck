//! `apex-daemon`: the Apex Deck host without a window. Clients (the desktop
//! app, a phone, an SSH session) drive it over one JSON protocol.

pub mod authority;
pub mod build_info;
pub mod cli;
pub mod devices;
pub mod entry;
pub mod devices_cli;
pub mod files;
pub mod gateway_admin;
pub mod gateway_cli;
pub mod gateway_http;
pub mod gateway_keys;
pub mod identity;
pub mod local_call;
pub mod log_time;
pub mod pair_cli;
pub mod pair_commands;
pub mod paths;
#[cfg(feature = "remote")]
pub mod pairing;
pub mod phone_cli;
pub mod protocol;
#[cfg(feature = "remote")]
pub mod remote;
#[cfg(feature = "remote")]
pub mod remote_control;
pub mod remote_config;
pub mod remote_settings;
pub mod serve;
pub mod signals;
pub mod stdio;
pub mod websocket;

pub mod voice;

#[cfg(feature = "test-support")]
pub mod test_support;
