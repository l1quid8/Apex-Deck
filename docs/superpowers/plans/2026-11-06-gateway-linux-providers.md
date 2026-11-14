# Linux gateway providers implementation plan

Goal: enable Muse, Grok and Gemini at the existing HTTPS endpoint, with all requested function execution owned by the Windows client.

Architecture: reuse the existing private process sandbox and provider tool-free adapters. Encode conversation and function definitions as data in a validated JSON envelope, reusing the gateway's existing schema and tool-choice checks. Fail closed on unsupported platforms, missing sandbox/runtime, native action events, and invalid envelopes. Never inherit personal MCP configuration. Existing Claude/Codex/API paths remain intact.

1. Add failing gateway tool-envelope tests for all three providers, invalid output, and JSON/SSE client loops. Add sandbox checks that fail rather than skip in the deployment acceptance command.
2. Reuse CliParticipant::with_tools_disabled for the three providers, reject native action progress, preserve usage and cancellation. Permit Linux only with sandbox preflight; ordinary chat must also run tools-disabled.
3. Run adapter/daemon tests, full Rust suite and TypeScript. Verify on VPS with installed CLIs: private host-file sentinel inaccessible, inherited MCP sentinel absent, shell/web/subagents unavailable. Provider login failures must be reported separately from isolation proof.
4. Build exact candidate on VPS, back up deployed binary and config, atomically replace and restart. Keep public URL/Caddy and Mac tunnel disabled. Verify authenticated JSON/SSE tool loops.
5. In Windows Deck add the three remote models, ask each to create and separately read a unique Windows file, independently verify contents on Windows, and record evidence without credentials.

Ruling: the user's explicit implementation/deployment request supplies scope and execution authorization; proceed inline. No merge is required for a reviewable candidate; do not claim deployed or accepted until observed.
