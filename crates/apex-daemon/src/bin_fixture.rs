//! Test-only daemon: identical command line, but the host assumes verified UI
//! admission for a dedicated temporary data directory. Built only with the
//! `test-support` feature (see Cargo.toml `required-features`); never packaged.
fn main() {
    apex_daemon::test_support::assume_verified_ui_for_this_process();
    apex_daemon::test_support::register_deterministic_images_for_this_process();
    apex_daemon::entry::run();
}
