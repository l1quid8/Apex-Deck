//! Test target for the production transport; no copied implementation or mocks.

#[cfg(test)]
#[allow(dead_code, unused_imports)] // This target exercises only the transport.
#[path = "../../apex-daemon/src/ipc.rs"]
mod ipc;
