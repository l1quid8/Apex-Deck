//! The Codex hook helper on its own, for the adapter tests. The app runs
//! the same code as `apex-deck --codex-hook`.
fn main() {
    std::process::exit(apex_adapters::codex_hook_main())
}
