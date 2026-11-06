# Gateway telemetry

Gateway completions preserve provider-reported token counts in both JSON and SSE. Unknown `prompt_tokens`, `completion_tokens`, `total_tokens`, cached input and cost are `null`, rather than zero. Total tokens require both input and output counts. Claude's prompt count includes cache reads and creation. Reported cached reads remain a separate subset of input, never extra output.

`usage.context` optionally contains `used_tokens`, `window_tokens` and `estimated`. CLI progress reports are forwarded. When context is calculated from a completion's counts and a reported model limit, it is marked estimated. Limits are never guessed from model names. API model catalogs forward upstream `context_length` where available, including saved API profiles.

## Subscription usage

Authenticated clients can POST `/v1/usage` (or `/usage` for a base URL that already includes `/v1`) with `{"model":"claude/default"}` and their existing bearer credential. The response has `object: "apex.gateway.usage"`, the canonical `model`, `observed_at` in Unix seconds, and `subscription` containing provider plan windows or `null`.

The normal model-family scope is required. Usage reads do not consume model turns or execute client tools. Provider credentials remain on the gateway. Readers use the gateway's configured account; Codex honors the dedicated data-directory login ahead of `CODEX_HOME`. Muse usage is available only after a turn reports it. Provider failures/timeouts produce unavailable usage; gateway cache backoff cannot restore an old report. Reset credits and reset actions are not exposed.

Deck requests subscription telemetry after a reply for Claude, Codex, Muse, Grok and Gemini gateway model families. Remote plans are keyed by endpoint, credential reference and model, preserving case-sensitive identities, and cannot fall back to a local CLI account. A failed refresh clears prior figures. Desktop and phone show `Not reported` for absent tokens, context and plan values; calculated context is labeled `Estimated`.

Token totals and cached-input counts survive thread reloads. Missing input/output sides remain distinguishable from explicitly reported zero and incomplete totals are labeled partial. Older saved histories retain the numbers originally recorded; telemetry cannot reconstruct missing historical reports.

## Verification

- Gateway authentication/scope and no-turn-charge HTTP regression.
- Nullable token totals, Claude cache accounting and context metadata regressions.
- Deck adapter HTTP/SSE integration: tokens, cached input, estimated context, account-scoped plan and clearing after an authenticated usage read fails.
- Gateway cache failure-backoff and dedicated Codex account selection regressions.
- Core wire-format/room persistence and host checkpoint regressions.
- Desktop/phone usage formatting and namespace isolation tests; TypeScript check.

Source implementation does not imply VPS deployment or an installed Deck upgrade.
