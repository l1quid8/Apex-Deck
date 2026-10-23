# Assistant mockup fidelity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Match the existing mockups/apex-dot screens and workflows in the real desktop app and deliver a verified signed DMG.

**Architecture:** Retain authenticated host-owned APIs and durable records. Replace the nested legacy presentation with the mockup shell, compact conversation, creation/settings, project coordination, activity and memory views. Never substitute simulated mockup state for live results.

**Tech Stack:** React/TypeScript, Electron, Rust daemon, existing CSS and host APIs.

- [x] Task 1: Implement mockup assistant shell, sidebar identity/status, single conversation header/tabs/composer. Owner: primary; files AssistantWorkspace.tsx shell, ApexAgentAll.tsx, assistant-workspace.css, App.tsx, Workspaces.tsx.
- [x] Task 2: Implement creation/settings fidelity with shared ordered controls, avatars and browser controls. Owner: editor agent; only AssistantEditor.tsx extracted from AssistantWorkspace, assistant-editor.css, focused tests.
- [x] Task 3: Implement project coordination and delegation presentation and real actions, assigned projects, task status/result/context. Owner: projects agent; only new AssistantProjects.tsx/css and API adapters/tests as agreed.
- [x] Task 4: Implement Activity and Memory fidelity using real records with private/project scopes, search, add/edit metadata, source and promotion. Owner: panels agent; PersonalPanels.tsx, ProjectMemoryPanel.tsx and personal-panels.css/tests.
- [x] Task 5: Integrate and review all differences, run targeted regression tests, full TypeScript and applicable suites.
- [x] Task 6: Verify actual desktop screens and workflows with live app, preserve original data, record screenshots and truthful unavailable dependencies.
- [x] Task 7: Build signed release from release directory, verify DMG integrity/content/signature and installed build smoke, deliver exact artifact path.

Acceptance: one mockup-style identity/status header; Conversation/Projects/Activity tabs below; Memory and Settings via overflow with correct Back; independent global sidebar; borderless team rows; matching text, density, avatars and composer; creation controls accepted by host; live assignments/delegation/memory and result workflows, correct reload persistence; no duplicate embedded legacy navigation; no false success or simulated runtime.

Verification completed for supported local workflows on installed source eaff3a8: creation/settings/avatar persistence, conversation reply, private/project memory, proposal/approval/pause/resume/cancel, read-only worker result/review/promotion, exact worker navigation, Activity and cold restart. Native findings fixed before final delivery, including undated Activity crash, lost reviewed results and protected action collisions. See release/verification/mockup-fidelity/native-verification.md and artifact-verification.json for screenshots, hashes and evidence levels.

Unavailable dependencies remain explicit: no supported image-generation provider configured; saved remote route unreachable/older build; configured workers cannot establish separate-copy editing trust. Read-only execution passed without expanding access. Historical consumed same-action receipts remain blocked. Original assistant/messages rendered, but whole-record byte identity was not established. No merge to main performed.

Final artifact: release/Apex-Deck_0.8.2_mockup-fidelity_arm64.dmg; signed, mounted content matched exact installed native package, integrity verified. Old DMGs deleted before replacement build.
