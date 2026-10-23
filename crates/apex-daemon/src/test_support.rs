//! Opt-in for the `apex-daemon-fixture` test binary only. The production
//! `apex-daemon` binary never calls this, and no environment variable, CLI option
//! or RPC does either: a process is verified-UI-assuming only if its own `main`
//! says so before the daemon starts.
use std::sync::atomic::{AtomicBool, Ordering};

static ASSUMED: AtomicBool = AtomicBool::new(false);

pub fn assume_verified_ui_for_this_process() {
    ASSUMED.store(true, Ordering::SeqCst);
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn assumed() -> bool {
    ASSUMED.load(Ordering::SeqCst)
}
