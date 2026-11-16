# CLI Apex Code Mode

The user authorized MCP integration for Claude Code and Codex subscription agents.
Reuse the bounded Rust batch executor rather than each CLI's own execution engine.
Register a private, authenticated, turn-local stdio MCP relay automatically through
launch overrides; never edit the user's MCP configuration. Model traffic stays on
the CLI subscription. Gateway/model-only turns must not register the tool.

1. Add the relay entry point and bounded MCP protocol handler. Only expose
   `deck_code_mode`, using the existing schema and per-child permission checks.
2. Register the relay in Claude and Codex launches, retaining computer MCP config.
   Keep the listener and executor in the response future, so completion, error,
   timeout, Stop, and dropped turns destroy the service. Stop must also interrupt
   pending approvals before a late answer can release another operation.
3. Verify real reads, denied/approved writes, partial output, cancellation, and
   automatic registration using regression tests. Run Rust and TypeScript checks.

Do not commit, change branches, build installers, or modify the settings mockup.
Global UI toggle remains separate. Live subscription acceptance must be reported
separately from transport fixtures and executor tests.
