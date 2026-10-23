# Assistant providers verification — 2026-10-23

Scope: approved shared text providers and existing Work v8 UX, branch feat/assistant-providers (base d7d7749). Native package/DMG remain pending until their recorded acceptance below.

## Source behavior
- Assistant inference is separate from the scheduled monitor. Known Claude/Codex/Gemini/Grok/Muse and configured text API profiles can be represented; media/custom command profiles cannot become assistant runtimes.
- Shared owning-host discovery includes installed providers without requiring another reusable bot. Unknown API endpoints still require a configured account. Older hosts retain visible choices with an update reason.
- Model switching preserves identity/revision/history/project grants/voice. No visible worker room is created. Explicit task execution/approvals remain unchanged.
- CLI conversation paths remove tools/MCP/plugins/subagents and phone/attachment access; non-Claude private process modes require the supported macOS sandbox. Other platforms refuse unsupported modes; no claim of native validation there.
- Private OAuth snapshots carry no refresh secrets. Codex's original auth store is the sole refresh owner; sufficiently fresh access/id/account data are whitelisted. Near-expiry connections ask for renewal. No automatic canonical refresh or internal-only OpenAI token API is used. Grok maps retain their session identity/expiry while every refresh secret is stripped. Muse uses existing access-only staging.
- Native Gemini discovery does not alter Threads' preference for Antigravity. If both exist, the assistant chooses native Gemini and its default, never Antigravity's model catalog. CLIs without catalogs offer explicit provider default (null) or retained configured choices, not invented model lists.

## Automated evidence
Frontend2470/2470 (`/tmp/apex-assistant-provider-complete-frontend.log`); focused102/102; npx tsc --noEmit; git diff --check. Adapter292 pass1 ignored (`/tmp/apex-assistant-final-adapters.log`); host612 pass5 ignored (`/tmp/apex-assistant-reviewed-host.log`); daemon hello1 pass. Explicit installed-Codex configuration regression passed without creating a reusable profile. Observed RED→GREEN for original provider rejection, startup Stop ownership, escalation refusal, unexpected tool stop, old-host gate, Gemini co-install/default behavior, credential preservation and mixed Grok maps. The new resize fixture now has an independent Vite cache after shared-cache failures under parallel runs.

## Live adapter evidence
- Codex: current access-only implementation passed reply, history, nonzero streamed deltas, unauthorized outside-file read/write attempt, with no outside changes (`/tmp/apex-assistant-final-codex-live.log`).
- Muse/Claude: live reply/history/stream and file boundary passed; these paths unchanged by subsequent Codex/Grok credential fixes.
- Grok: initial probe reached402 usage balance exhausted. Canonical auth snapshot is now stale; protected access-only preflight requires renewal. No successful access-only Grok reply claim.
- Gemini: native Google CLI absent on this Mac; Antigravity remains visible with its isolated-mode explanation. Co-install discovery/catalog behavior tested with fixtures; no real Gemini inference claim.

The fresh review's Codex refresh ownership and Gemini co-install findings were fixed. A further Grok mixed-session finding was fixed with a dedicated fixture. Native selection, replies, Stop, restart, Work layout, exact signed installation and final DMG remain pending.
