# Alfred Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the user's existing Alfred assistant into a screenshot-aware, voice-capable conversational coordinator with Apex UCU and an optional floating window.

**Architecture:** Extend the existing personal-assistant path and shared host APIs. Keep identity, conversation, drafts and calls authoritative in existing stores/controllers; use bounded host-validated coordination rather than a second work dashboard or scripted mockup router.

**Tech Stack:** React/TypeScript, Electron, Rust apex-host/apex-adapters, existing macOS signed computer helper.

**Spec:** ../specs/2026-11-01-alfred-assistant-design.md

## Global Constraints

- Preserve the existing assistant record, history, memory, granted projects, schedules, identity/avatar, provider profile and rule settings.
- The personal assistant is Alfred; the coding participant Jigga remains Jigga. Use saved names everywhere.
- No new per-agent UCU master checkbox, browser/profile or task dashboard.
- Never move the user's pointer or use a foreground fallback for background-only work.
- No release merge, packaging, install or app restart from this task while the independent UCU release owns those operations.
- Production builds only in /Users/tylercaldwell/Downloads/apex-deck/release; do not start a worktree development app.

## Review Focus

1. An image marker for a different assistant, symlink escape or arbitrary path cannot exfiltrate a file.
2. A question/status/hypothetical does not send a room message, create work or change an existing task.
3. A renamed assistant or identical room title cannot retarget authority; host-qualified stable ids govern access.
4. Stop, reconnect or a delivered-but-unverified action cannot replay side effects or continue after cancellation.
5. Floating and docked views share draft/call state; closing one view cannot start another mic or duplicate a message.

### Task 1: Deliver screenshot content through the existing adapters

**Files:** crates/apex-host/src/personal_worker.rs, crates/apex-host/src/assistant_inference.rs, crates/apex-adapters/src/assistant.rs, existing attachment/worker tests; supporting host call sites only as necessary.

**Interfaces:** Consume existing personal_send text and host-owned saved attachment markers. Produce TurnRequest with current human image content in its User turn and canonical owner-scoped BuildContext.attachment_roots. Leave helpers/internal summaries tool-free and image-free unless explicitly supplied by the owner.

- [ ] Extend existing focused tests to capture the actual inference request: current image markers appear in the user turn, roots belong only to that assistant, no previous unrelated image is silently resent, and unsupported/text-only capability is accurately reported.
- [ ] Reuse adapters/attachments.rs parsing, MIME/content/size checks and root validation. Wire roots into both API and supported CLI assistant builders without enabling workspace tools.
- [ ] Run focused Rust tests/checks; report actual provider limits. Commit only this slice.

### Task 2: Conversational coordination of existing shared chats

**Files:** crates/apex-host/src/personal_worker.rs, personal_worker/context.rs, personal_workspace.rs, existing assistant_service/task lineage APIs, existing personal worker tests; introduce a focused personal coordinator module if needed to avoid further enlarging the worker.

**Interfaces:** Consume validated AssistantRef and current ProjectRef bindings, saved room metadata and eligible participant ids. Produce fresh read-only chat summaries and explicit authorized room instructions through the existing durable room/task APIs, with stable source event/request identity.

- [ ] Fix destination context to include human-recognizable current chat titles and participant names as data alongside stable host/project/room ids. Do not authorize from titles.
- [ ] Use existing adapter tool/call machinery for bounded read/status/send/stop operations; first inspect its security contract. Avoid a text-pattern fallback that treats all replies as execution.
- [ ] Validate current binding and operation class immediately before every host action. Reuse existing grants/rules and preserve read-only/ask ceilings; no extra ask after a scoped action is already authorized.
- [ ] Extend existing tests with status/hypothetical read-only behavior, one explicit instruction, duplicate request id, revoked project access, ambiguous title and stopped/restarted delivery. Verify room read-back, not merely a model claim.
- [ ] Commit the scoped coordinator slice; do not send real user chat messages during implementation.

### Task 3: Personal assistant access to Apex UCU

**Files:** host computer policy/turn integration, assistant_inference.rs, personal coordinator module, existing adapter computer bridge and capability checks, existing personal/editor UI only for relevant invocation copy.

**Interfaces:** Consume host-issued ComputerTurn and the existing assistant conversation identity; produce tools through the selected supported model adapter. Authority stays on the helper control connection and never in prompts.

- [ ] Reuse global enabled state and conversation app grants with assistant:<stable-id> scope; invalidate on Stop/revoke and preserve foreground/background capability boundaries.
- [ ] Reuse dev.apexdeck.assistant-browser for background browser work and existing takeover state/profile. Unsupported native background actions return a capability limitation without stealing focus.
- [ ] Extend existing tests for two assistants' isolated grants, text-only invocation warning, revoked/cancelled turn, takeover and delivered-unverified no-retry behavior.
- [ ] Run focused host/adapter checks. Commit without replacing the independently built release.

### Task 4: GPT-Live on the existing assistant conversation

**Files:** src/voice/useAssistantVoice.ts, src/voice/personalBridge.ts, src/voice/coordinator.ts only as necessary, crates/apex-host/src/personal_voice.rs and authorized realtime-session command path; existing voice-personal-bridge/runtime tests.

**Interfaces:** Implement VoiceRegistration.realtimeSession for the host-qualified assistant scope using existing ephemeral session service, never a raw provider key in UI. Transcript/tool handoff returns to the same PersonalLane.sendRequest event stream.

- [ ] Inspect current room-only session authorization and add an assistant-specific authorized path; do not pretend assistant ids are room ids accepted by existing backend checks.
- [ ] Preserve Local voice, saved engine selection, Pill/Bar/Top bar, mute/end/interruption and cancellation behavior. No duplicate model reply/transcript insertion.
- [ ] Extend existing tests for correct assistant host routing, missing credential/session failure, mute versus Stop, interrupted reply and ending/rejoining without a duplicate mic session.
- [ ] TypeScript and focused voice/host tests must pass. Commit.

### Task 5: Native draggable Alfred window

**Files:** desktop/main.mjs, desktop/preload.cjs, relevant desktop types, src/AssistantWorkspace.tsx and App/popup ownership integration; a focused floating-window module if useful. Reuse existing assistant draft/voice stores and popout layout helpers.

**Interfaces:** One host+assistant identity owns the window. Renderer messages are validated against its owning webContents; no arbitrary window/room commands. Floating and Deck reference the same durable conversation and current call controller.

- [ ] Add explicit pop-out/return controls and optional always-on-top behavior, off until selected. Fit persisted geometry to available screens; support drag without intercepting composer or call buttons.
- [ ] New conversation retains underlying project rooms and memory; mute/end act on the existing call. Avatar still opens Details. Closing/redocking preserves draft and active work.
- [ ] Extend existing desktop/assistant state tests for owner mismatch, one live window, redock/reopen, screen removal and shared draft/call state. Visually inspect in the permitted existing development app when available; do not start a worktree dev app.
- [ ] Commit.

### Task 6: Complete agent settings and integration handoff

**Files:** src/AssistantEditor.tsx, AssistantRuntimeSettings.tsx, PersonalPanels.tsx and their existing CSS/tests; update feature inventory alongside the approved preview.

**Interfaces:** Existing versioned workspace configuration remains the saving authority, with unchanged assistant id. Every old setting has a documented visible home; capability-based controls reflect selected adapter support.

- [ ] Preserve every setting in the design inventory. Group identity, Model & access, voice, memory, connections, rules, schedules, costs/privacy, notices and advanced actions; use concise scope explanations and clear save feedback.
- [ ] Add settings for floating behavior and relevant UCU invocation/cursor options by reusing global UCU settings, not shadow copies. Model image support must not look like a general UCU enable switch.
- [ ] Run npx tsc --noEmit and relevant existing suites, then request whole-branch review. Reconcile against the current verified UCU release and report known adapter gaps before packaging.
- [ ] Prepare one candidate only after authorized integration. Verify actual installed harmless image understanding, live voice, scoped cross-chat instruction/status, background browser action and dock/float continuity. Report incomplete behavior honestly; retain signed source provenance.
