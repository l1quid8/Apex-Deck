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

static DETERMINISTIC_IMAGES: AtomicBool = AtomicBool::new(false);
/// Only the fixture binary's own main calls this before daemon construction.
pub fn register_deterministic_images_for_this_process(){DETERMINISTIC_IMAGES.store(true,Ordering::SeqCst);}
pub(crate) fn deterministic_images()->bool{DETERMINISTIC_IMAGES.load(Ordering::SeqCst)}
