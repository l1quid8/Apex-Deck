//! Build-time selection from the release identities shared with Electron.
include!(concat!(env!("OUT_DIR"), "/channel.rs"));
