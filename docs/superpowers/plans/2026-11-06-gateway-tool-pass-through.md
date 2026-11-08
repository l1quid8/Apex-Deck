# Gateway tool pass-through implementation plan

**Goal:** Let client harnesses execute tools through API providers, Claude and Codex subscription models.
**Architecture:** Proxy OpenAI-compatible API JSON/SSE without flattening messages. Claude uses schema-constrained output with native tools and private MCP disabled. Codex uses a capability-protected model transport that strips inherited context, forces native tool_choice=none, and rejects native tool events. Translate both validated envelopes into OpenAI tool calls. Keep auth, scope, quota and revocation at the gateway boundary.
**Tech stack:** Rust, Tokio, reqwest, existing CLI adapter.
**Spec:** The user-approved route design in the conversation and `mockups/model-gateway-routes-v2.html`.

## Constraints
- Tool execution belongs exclusively to the client harness.
- Include Codex using a clean configuration with shell, apps, web, plugins, subagents and host skills disabled; verify containment before enabling.
- Preserve existing chat behavior and unrelated checkout edits.
- Keep public URL and keys unchanged; never write credentials into reports.

## Review focus
- Tool-call IDs and provider reasoning survive both rounds.
- Forced/none tool choice and parallel-call limits are enforced for Claude.
- Malformed tool definitions fail before quota reservation.
- Revocation interrupts upstream waits and streams.
- Invalid Claude output never becomes executable tool calls.

## Tasks
- [x] API proxy: add HTTP round-trip regressions for normal/SSE tool calls, continuation messages, upstream errors and revocation; observe failures; implement raw forwarding and usage accounting in `gateway_http/tools.rs`.
- [x] Claude: test isolated command flags and full JSON/SSE tool loops; use a dedicated fresh-run CLI path without changing ordinary CLI turns.
- [x] Claude protocol: test tool choice, argument validation, unsupported backends and buffered SSE; implement schema envelope and OpenAI translation.
- [x] Codex: probe native capability denial; test isolated command construction and schema output; implement fresh-run JSON envelope translation shared with Claude.
- [x] Verify: run daemon and adapter tests, TypeScript check, real client-side tool loops for API and Claude, then document deployment status and remaining limits.

## Verification and limits
- Ten live HTTP requests (five complete client-executed add loops) passed for each of OpenAI/gpt-4o-mini, Claude/haiku and Codex/gpt-6.1-sol; JSON and SSE covered, zero parse failures in final runs.
- Daemon suite and TypeScript check passed. The two image-test failures were traced to live configuration invalidating the test MCP cache and fixed with immutable fixture definitions; see `docs/model-gateway-tools.md`.
- Review fixes: cost fallback retained; provider failures refund one reservation; completed invalid Claude output still records spend; client disconnect cancels upstream work; Codex uses authoritative CLI auth storage rather than disposable credential copies.
- Merge and VPS deployment are tracked separately in the VPS operations runbook. No installer or Windows UI acceptance is established by local checks.
