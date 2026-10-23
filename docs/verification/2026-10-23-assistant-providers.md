# Assistant providers verification — 2026-10-23

Scope: approved shared text providers and existing Work v8 UX, branch feat/assistant-providers (base d7d7749). Native acceptance and release evidence are recorded below.

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

The fresh review's Codex refresh ownership and Gemini co-install findings were fixed. A further Grok mixed-session finding was fixed with a dedicated fixture. Native acceptance is recorded below; unavailable-provider limits remain explicit.

## Installed native acceptance
Protected package `Apex-Deck_0.8.2_assistant-providers_arm64.pkg` manifest d50d5d50-a494-4592-8aa8-d434dc78e292 installed successfully. Both /Applications and TrustedUI verified UI064681891d3ce183091e90bcae0454f56b53f61d, daemonfed1690de9d19fb3f510c7141060e8c7038d10b5, brokerc67d7372dd6a710178e28ec05f8ae95cd183bc38. Cold launched TrustedUI.

Restored the existing archived Approved Flow QA for testing. Runtime lists Null/Codex, Jigga/Claude, Gronk/Grok, Muck/Muse, Forge/Gemini, Gwen/API and deepgeek/DeepSeek. Codex selection saved with GPT-6.1-Sol/Low, same identity/avatar/history/project binding. Actual named assistant reply QA_PROVIDER_CODEX_OK. Muse saved muse-spark-1.3/Low; a first response repeated an older QA token; a fresh distinct instruction returned MUSECHECK47. No visible worker chat created. Gemini attempt retained Muse and explained isolated Gemini CLI is required; Antigravity remains in Threads. Grok selection saved, then ordinary reply explicitly refused with connection-needs-refreshing message and stated login unchanged. No successful native Gemini/Grok inference claim.

Restored Codex, started a long benign reply, entered multiline unsent draft, clicked Stop; Stop disappeared and draft remained intact. Cleared only that QA draft afterward. Cold relaunch retained Codex/runtime/history including both successful markers. Side panel reset320. Archived QA again through Remove and keep history; original Apex Assistant and Fidelity QA Verified untouched.

Work native width320 and640 side panels checked: header reflows, Chat/Work and New task stay visible, History/Projects/Deleted sections remain reachable. Screenshot assistant-providers-work-narrow.png in session visualization directory. The prior disposable project path /Users/tylercaldwell/Downloads/apex-assistant-qa/approved-flow no longer exists on disk (confirmed independently); its binding is retained and correctly marked unavailable. New task reports reconnect assigned project. Prior task lifecycle/approval native evidence remains in approved-flow verification; those deleted-folder tasks could not be rerun in this acceptance, and were not recreated or purged. This is a limitation, not a claim that every historical workflow was rerun. Disabled New task keyboard reason remains a deferred tooltip-only accessibility issue from prior review.

## Artifact
Final DMG release/Apex-Deck_0.8.2_arm64.dmg, 147820156 bytes, SHA256947bc1c4de4542e624d726578ec77f6332fad09e44125592c757f99b89b8d8e1. hdiutil verify passed; mounted read-only, protected signature/hash verification passed, and app.asar/daemon/broker SHA256 matched candidate, Applications and TrustedUI byte for byte. Detached cleanly; checksum sidecar written. Final npx tsc --noEmit and git diff --check passed. No merge/push. Notarization skipped because credentials were unavailable; embedded app is Developer ID signed. Earlier inventoried stale DMGs and matching sidecars were removed before packaging. Fresh 0.9.0 artifacts observed from separate work are preserved rather than overwritten or treated as the earlier deleted files.
