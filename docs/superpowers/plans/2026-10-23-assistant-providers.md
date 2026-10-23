# Shared Assistant Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give assistants the shared configured text-provider catalog and verified isolated conversation adapters.
**Architecture:** Separate personal inference from monitor inference, reuse the existing adapters under a tool-free/private process mode, and share frontend provider discovery. Keep task execution and monitor restrictions intact.
**Tech Stack:** Rust/Tokio adapters and host, React/TypeScript, node tests, native Electron QA.
**Spec:** docs/superpowers/specs/2026-10-23-assistant-providers.md

## Global Constraints
- One model/provider per assistant. Preserve exact owner/revision, history, projects, voice and approval authority.
- Ordinary inference has no local/MCP/plugin/subagent tools; refuse unsupported paths, no fallback to normal full agent mode.
- Preserve unrelated dirty files. Current task branch feat/assistant-providers starts at d7d7749.
- No new dependencies; production builds start in release; require npx tsc --noEmit; no merge/push.

## Review Focus
- Existing CLI configs and background services must not leak into assistant replies; test private config and forbidden file/tool attempts.
- Stop/cancellation must reap child process trees; exercise existing owned-process cancellation.
- Unavailable provider stays visible and explicit selection never silently changes providers; test discovery errors.
- Switching during in-flight work retains captured revision/history; existing conflict and owner tests remain green.
- Monitor acceptance remains Claude/API only; assistant create/update accept only known text backends.

### Task 1: Isolated provider conversation adapters
Files: crates/apex-adapters/src/cli.rs, codex_server.rs, gateway_sandbox.rs, new assistant.rs; crates/apex-host/src/assistant_inference.rs, personal.rs, personal_workspace.rs, personal_worker.rs, lib.rs.
- [x] Add failing tests for assistant profile acceptance of known text providers and refusal of custom/scripted/media; monitor restrictions unchanged.
- [x] Add failing adapter tests for text-only Codex/Grok/Muse/Gemini command/protocol setup, private homes, no MCP/tools/phone/attachments and cancellation.
- [x] Implement assistant profile validation and reply runner, with isolated adapter construction and existing timeouts/process ownership; route personal create/update/replies through it. Keep monitor runner unchanged.
- [x] Run focused Rust checks; commit this deliverable.

### Task 2: Shared provider discovery and controls
Files: src/assistantRuntime.ts, AssistantEditor.tsx, AssistantRuntimeSettings.tsx, relevant tests.
- [x] RED tests: all known configured text providers visible on owning host, exclude media/custom CLI, alias discovery, model errors retain selected provider, preserve assistant identity/grants/revision.
- [x] Use one shared provider predicate and discovery in editor/runtime. Unavailable models/replies show a concrete reason; no invented catalog or automatic fallback after explicit selection.
- [x] Run focused frontend tests and TypeScript; commit.

### Task 3: Review and native acceptance
- [ ] Run full frontend and affected Rust suites. Fresh whole-increment review; fix consequential findings with RED/GREEN.
- [ ] Run real adapter smoke for installed supported providers using disposable context, verify forbidden host access/write attempts fail, and stop cleanup. Record unavailable providers honestly.
- [ ] Build signed app from release; use protected installer and verify exact installed hashes; native QA same Approved Flow QA assistant for provider selection, replies, history, stop, restart, Work layout and approval routing.
- [ ] Cancel/soft-delete only disposable QA tasks, archive QA when no unfinished work, preserve original assistants.
- [ ] Build final DMG from exact native-verified signed app, verify mounted contents/signatures and SHA256, update verification record and deliver. Do not merge.
