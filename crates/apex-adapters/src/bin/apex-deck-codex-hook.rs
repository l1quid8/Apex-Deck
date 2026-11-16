//! The Codex hook helper on its own, for the adapter tests. The app runs
//! the same code as `apex-deck --codex-hook`.
fn main() {
    if std::env::args().nth(1).as_deref() == Some(apex_adapters::CODE_MODE_MCP_ARG) {
        std::process::exit(apex_adapters::code_mode_mcp_main());
    }
    std::process::exit(apex_adapters::codex_hook_main())
}
