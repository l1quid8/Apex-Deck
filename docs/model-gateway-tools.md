# Model gateway function tools

The gateway returns function requests; **only the client harness executes them**. The public base URL remains `https://apex-terminal.xyz/model-gateway/v1`. Runtime provenance, rollback commands and public acceptance results belong in the VPS operations runbook; local suite results below describe source verification.

## Supported routes

| Model family | Function protocol | Streaming |
| --- | --- | --- |
| API providers and saved OpenAI-compatible profiles | Original messages, tool definitions, call IDs, arguments, reasoning fields, finish reasons and errors pass through | Upstream SSE passes through |
| `claude/*` | Fresh CLI invocation with `--json-schema`; native tools, MCP, hooks and slash commands disabled | Validated response is emitted as buffered SSE |
| `codex/*` | Fresh CLI invocation with strict output schema and a guarded model-only transport | Validated response is emitted as buffered SSE |
| Other subscription/custom CLI providers | HTTP 409 for function tools | Unsupported |

Existing normal subscription chat retains its adapter route. Existing bearer authentication, family scopes, daily caps and revocation apply to function requests. Subscription routes require subscription scope; API-only keys cannot use them.

Only OpenAI-compatible `type: "function"` tools are supported. Function arguments must be JSON objects. Claude and Codex output is validated against each supplied parameter schema, the supplied names, `tool_choice` and `parallel_tool_calls`; invalid output returns HTTP 502 and never becomes executable calls. External schema references are unsupported. HTTP request body limit remains 4 MiB.

## Client loop

1. POST `chat/completions` with messages and function definitions. Set `tool_choice` to `auto`, `required`, `none`, or a supplied named function. `stream: true` selects SSE.
2. On `finish_reason: "tool_calls"`, preserve the whole assistant message, including IDs and provider reasoning fields.
3. Validate/authorize each call in the client, execute it there, and append a `role: "tool"` message with its `tool_call_id` and string result.
4. Send the accumulated history and definitions again. Repeat until the provider returns a final answer.

The API path asks for streamed usage while preserving other stream options. Reported `usage.cost` or `cost.usd` advances monthly spend. When those are absent, existing adapter token-price accounting is used if the provider lists prices. Missing prices or cost remain unknown; spend caps are not a guaranteed dollar ceiling. Codex subscription CLI output reports token usage but no dollar cost. No prices are fabricated.

Completed paid Claude output is charged even when envelope validation fails. Upstream API HTTP failures refund their reservation. Key revocation and client disconnect drop pending upstream work; subscription children are killed on drop. Cancelling cannot retroactively undo provider work already performed.

## Codex containment and login

CLI feature switches alone did not establish isolation: collaboration tools remained reachable, and a refusal caused by a missing ephemeral rollout was not a reliable policy boundary.

The implemented boundary therefore also operates on the model wire:

- A separate loopback listener exists only for each request and requires a random capability header.
- It accepts only the CLI model-catalog and Responses paths. Production forwarding targets the fixed HTTPS Codex backend with redirects disabled; callers cannot supply a destination.
- Model input is reconstructed solely from the gateway conversation. Inherited CLI developer/skill/plugin messages and continuation identifiers are removed.
- Native `tools` is forced to an empty array and native `tool_choice` to `none`. Client function requests are schema-constrained JSON text instead.
- Complete SSE frames are validated before forwarding. Native tool/action output and unrecognized event types fail closed. Split frames, CRLF and multiline data are handled. A future Codex event change may need a reviewed allowlist update.
- CLI user configuration and rules are ignored. Shell, apps, plugins, web, subagents and other native features are disabled as defense in depth.

Codex requires a file-backed subscription login. It uses the authoritative auth home, preferring `<gateway-data>/codex` when its `auth.json` exists, otherwise `CODEX_HOME`, otherwise the user's normal Codex home. Credentials are not copied per request. The CLI retains its normal refresh persistence and coordination. No credential contents belong in diagnostics or this document.

Verified locally with Codex CLI 0.166.0 and Claude Code 2.1.319. The VPS needs compatible CLIs and its own valid logins; deployed CLI versions and public acceptance results are recorded in the operations runbook. Local tool-loop checks do not establish Windows Deck UI acceptance.

## Verification record

Final live HTTP runs each completed ten requests: five client-side addition loops, alternating JSON and SSE. Each tool request was parsed and executed by the test harness, then its result was returned to the model and verified as `42`.

| Provider | Result | Evidence |
| --- | --- | --- |
| OpenAI `gpt-4o-mini` | 10/10; zero parse failures | `/tmp/apex-gateway-live-final.log` |
| Claude `haiku` | 10/10; zero parse failures | `/tmp/apex-gateway-live-claude-final.log` |
| Codex `gpt-6.1-sol` | 10/10; zero parse failures | `/tmp/apex-gateway-live-codex.log` |

Other checks:

- `TMPDIR=/tmp cargo test -p apex-daemon`: passed; `/tmp/apex-gateway-daemon-final.log`.
- `npx tsc --noEmit`: passed; `/tmp/apex-gateway-tsc.log`.
- HTTP regressions cover API/Claude/Codex loops, provider errors, validation before quota reservation, spend, revocation and client cancellation. Transport tests cover private authentication, input rewriting, rejection of native SSE events, auth-home selection and cancellation of the upstream stream.
- Review regressions were observed failing, then passed after the accounting, cancellation and native-frame fixes.
- Both image regressions are fixed. The old test fixture cached fake MCP servers against the live Claude configuration timestamp; concurrent configuration writes invalidated the cache and replaced the fixtures with real servers. Fixtures now hold fixed server definitions while retaining access-level filtering. `TMPDIR=/tmp cargo test -p apex-adapters` passes: 474 unit tests and 94 integration tests, with live credential tests ignored. Evidence: `/tmp/apex-gateway-adapters-fixed.log`.
- The clean merge export also exposed an existing `BuildContext` initializer missing the main branch watchdog field. The live restart test now inherits newly added fields from `BuildContext::default()`; watchdog behavior is preserved.
- An initial daemon run failed seven attach tests because the inherited temporary path exceeded macOS socket limits; the full rerun with `TMPDIR=/tmp` passed.
- A broad ignored-test filter additionally ran `live_grok_http_completion_with_legacy_key`; it failed because the existing Grok sign-in needs refreshing. The two requested provider-loop tests in that same run passed. Grok login was not changed.

Pre-merge review also fixed API image-only requests being rejected by legacy text flattening and cumulative SSE usage being ignored after an initial empty usage frame. The HTTP regression verifies image payload preservation, a complete JSON/SSE tool loop, and exactly one charge from the final usage totals. A separate regression keeps the provider socket open after `[DONE]` and closes the client immediately, verifying usage is recorded before completion is exposed. All three failures were observed before the fixes.

Final daemon unit rerun: 202 passed, 4 ignored. Clean adapter+daemon suites before the completion-settlement regression: 800 passed, 15 ignored.

Clean export validation on 2026-11-06: full Rust suite 2,453 passed, 32 ignored; JavaScript 3,424 passed, 5 skipped (concurrency 4); TypeScript passed. An initial concurrent JavaScript run failed the phone composer detent timing test, which passed in isolation and in the complete rerun. The initial shared dirty checkout Rust run failed three unrelated host tests (hung save deadline, read dispatch timing, bulk-delete exact card); those unrelated edits are excluded from this merge, and the clean export passed all host tests.

The logs are temporary local evidence, not release artifacts. No API keys or login tokens are recorded here. Local test logs alone do not establish production or Windows UI acceptance.
