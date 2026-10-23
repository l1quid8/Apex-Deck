# Approved Assistant Flow Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for integration and superpowers:dispatching-parallel-agents for independent component work. Steps use checkbox (`- [x]`) syntax.

**Goal:** Implement the approved v7 assistant flow, preserving existing capabilities and reusing Threads composer/voice controls; verify native workflows and deliver a fresh DMG.

**Architecture:** Extract a shared Threads composer surface rather than copying its markup and geometry. Register the named assistant with the existing voice coordinator through an assistant bridge. Keep task identity, grants and approvals intact while adding durable task lifecycle controls, scoped runtime settings, and browser presentation.

**Tech Stack:** React, TypeScript, Rust host, Electron, existing native voice/browser infrastructure.

**Spec:** docs/superpowers/specs/2026-10-23-assistant-approved-flow.md (v7 supersedes earlier approximate composer/voice geometry).

## Global Constraints

- Work on feat/assistant-approved-flow in the root checkout; preserve unrelated untracked files.
- No card left-edge decorations. Assistants entered from the left sidebar; global Agents never selects or routes to them.
- One provider/model at a time; single runtime chip, no participant bot row under assistant composer.
- Existing defaults, folder grants, exact plan/revision approvals and saved assistant identity remain authoritative.
- Native development only from repository root with the user's specified APEX_DECK_DATA_DIR command. Production build only from release directory. Clear stale DMGs before starting packaging.
- npx tsc --noEmit must pass. No claiming mockups or suites prove native behavior.

## Review Focus

- Draft/attachment and call identity across Chat/Work/settings navigation, assistant switching and restart.
- Unsupported or offline host capabilities must show usable reasons without broadening folder access.
- Cancel/delete races, restore without restarting, purge without replay or cross-assistant deletion.
- Runtime changes respect host/account/model capability and conflict revisions.
- Narrow window composer/call/browser geometry and same-tab expand/return behavior.

### Task 1: Shared composer, voice and runtime integration
**Files:** src/ChatPane.tsx, new src/ThreadComposer.tsx, src/ApexAgentAll.tsx, new src/voice/personalBridge.ts, src/AssistantWorkspace.tsx, src/App.tsx, src/SectionNavigation.tsx, scoped tests.
- [x] Add failing shared-surface/bridge/navigation tests; observe failures.
- [x] Extract existing composer structure and use it in Threads and named assistant. Integrate existing voice coordinator/bar/pill/capsule/settings and save the same voice preferences. Preserve attachments, plus menu, Plan, TLDR, send/stop and keyboard semantics.
- [x] Add one header runtime chip using existing BotSettings and truthful host capability/usage/reset/context data.
- [x] Ensure global section selected state excludes assistant and attention shortcuts cannot restore assistant through Agents.
- [x] Run focused tests and TypeScript. Inspect full integration diff.

### Task 2: Task lifecycle and unified Work/detail behavior
**Files:** src/AssistantWork.tsx, src/assistantStatus.ts, src/assistantTaskModel.ts, src/usePersonalAssistants.ts, src/personalAssistant.ts, applicable host/task services and APIs, tests. Coordinate App.tsx integration through root agent.
- [x] Add failing tests for active/completed/cancelled deletion, restore, purge and identity boundaries.
- [x] Make every task row openable with state-specific action and cancel/delete menu. Persist Deleted tasks and Empty with exact-count confirmation. Do not restart on restore or allow purged records to replay operations.
- [x] Keep result/changes/checks, exact acceptance and source-aware back navigation available; disclose diagnostics progressively.
- [x] Run relevant TypeScript/Rust tests and report integration interfaces.

### Task 3: Creation/settings parity and browser presentation
**Files:** src/AssistantEditor.tsx, src/AssistantAvatarEditor.tsx, src/PersonalBrowser.tsx, src/personal-browser.css, src/PersonalPanels.tsx, related tests and focused new components. Coordinate shell integration through root agent.
- [x] Compare existing forms to approved spec and add regression tests for missing creation/settings controls.
- [x] Preserve full avatar creation (including existing ChatGPT provider), runtime, scope, style/timezone/quiet-hours, rules, memory, costs/privacy, schedules and notices. No silent feature removal.
- [x] Expose browser as a mini chat popup by default, expand same session into main pane and return while preserving chat draft/control. Reuse existing browser service; no separate new engine or profile leakage.
- [x] Remove card left-edge decorations in owned component CSS. Run focused tests and provide integration surface.

### Task 4: Native verification and release
**Files:** docs/verification/2026-10-23-assistant-approved-flow.md, release artifact.
- [x] Run required TypeScript, JS suite and affected Rust checks. Independent whole-branch review, fix consequential findings.
- [ ] Reuse existing dev Electron window if present; otherwise launch only authorized dev command from root. Exercise every approved screen/state/workflow and record observed results and limitations honestly.
- [ ] Inventory release DMGs, remove stale DMGs, then launch production packaging only from release. Verify artifact contents, provenance and fresh native launch of intended packaged build; clean new QA data only.
- [ ] Deliver versioned DMG at repository release path with concise validation evidence. Do not merge unrelated branch work without authorization.

### Task 5: Approved Work v8 organization
User approved the clickable v8 mockup with “lets build it”. Continue the existing task branch and preserve all unrelated files.
- [ ] RED: urgency groups hide when empty; History/Projects collapsed; one row per task; New task action; compact project management has no duplicated tasks; programmatic detail/new-task requests remain reachable while management is collapsed.
- [ ] GREEN: compact task rows, title + status/project/worker, one next action and overflow; Needs you/In progress; History/Projects drawers; quiet Deleted tasks. Keep actual backend lifecycle/approval actions. Move creation to the Work header and preserve modal visibility when Projects is closed.
- [ ] Reset stale detail presentation when leaving Work; retain exact task/source Back routing.
- [ ] Run focused tests, tsc and full frontend suite; review this increment.
- [ ] Build signed app from release, install using existing protected updater, compare native Work against v8 (wide/narrow/task/history/projects/creation/deleted). Reuse archived Approved Flow QA and existing results; avoid unnecessary new model calls.
- [ ] Build final DMG from the exact verified signed app, verify mounted contents and deliver it. Five stale DMGs already removed; inventory again before building.
