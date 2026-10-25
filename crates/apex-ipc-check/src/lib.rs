//! Test target for the production transport; no copied implementation or mocks.

#[cfg(test)]
#[allow(dead_code, unused_imports)] // This target exercises only the transport.
#[path = "../../apex-daemon/src/ipc.rs"]
mod ipc;

#[cfg(all(test, windows))]
extern crate self as apex_host;

#[cfg(all(test, windows))]
#[path = "../../apex-host/src/private_data.rs"]
pub mod private_data;

#[cfg(all(test, windows))]
#[allow(dead_code)]
#[path = "../../apex-daemon/src/files.rs"]
mod files;
