# Handoff acceptance fixes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the three observed installed acceptance blockers and rerun the real checks.
**Architecture:** Keep watchdog ownership in the host for delegated execution rooms. Cap modes using only authenticated human wording. Feed phone conversation controls from its existing authenticated task registry and reuse shared task details.
**Tech Stack:** Rust host/adapters, React/TypeScript, Electron/Capacitor.
**Spec:** release/assistant-handoff-184d0def102c/evidence/RESULTS.md and the approved v11.1 Round 1 plan.

## Global Constraints
- Preserve unrelated shared-checkout changes; no Round 2 work.
- Production packaging starts under release; require tsc before any merge.
- Watchdog remains 20 quiet minutes / 60 during a command; paused human waits remain protected.
- Phone acceptance uses a throwaway daemon, never pairs to the user's daemon.

## Review Focus
- Ordinary CLI workers retain their silence protection; delegated workers remain cancellable.
- Human read-only restrictions survive contaminated context, model defaults, routing and admission.
- Missing project/thread/workers remain unresolved until selected; mode capping grants no authority.
- Phone tasks remain owner-qualified and access revocation cannot authorize stale actions.
- Real installed behavior, 20-minute wall clock and cold relaunch are distinct from passing fixtures.

### Task 1: Watchdog ownership
Files: crates/apex-adapters/src/{lib,cli}.rs; crates/apex-host/src/host.rs.
- [x] Add a regression showing a quiet host-managed worker outlives the adapter limit, while an ordinary worker times out.
- [x] Run it RED; add a host-issued watchdog context flag only for registered delegated execution rooms, and bypass adapter silence timeout there.
- [x] Run adapter and host regression suites GREEN; retain external Stop cleanup.

### Task 2: Read-only mode
Files: crates/apex-host/src/{personal_handoff,assistant_delegation}.rs and personal_worker/tests.rs.
- [x] Add regressions for ordinary model drafts and untrusted-context fallback using the exact explicit read-only request; verify isolated fallback for editing requests.
- [x] Run RED; cap mode from authenticated human restrictions for drafts and direct admission without trusting outside payloads.
- [x] Run GREEN, preserving announcement gating and ordered worker selection.

### Task 3: Phone controls
Files: src/phone/{PhoneApp.tsx,taskFeed.ts}; tests/phone-tasks.test.mjs and shared handoff browser tests.
- [x] Add regression for owner-scoped delegated task projection and shared conversation wiring.
- [x] Run RED; pass registry tasks/workspaces/offline state to ApexAgentAll and open owner-qualified shared task details.
- [x] Run GREEN and tsc; verify phone controls against a real pending question.

### Task 4: Build and installed acceptance
- [x] Run scoped tests, full host/client/daemon checks; review diff independently.
- [ ] Commit scoped source and package a clean snapshot under release; preserve prior evidence.
- [ ] Install the candidate through the authority-preserving upgrade path and capture running provenance.
- [ ] Rerun real conversational new-thread/read-only/Stop checks, real 20-minute watchdog recovery, paused protection, phone controls and cold relaunch.
- [ ] Save logs and explicit pass/fail acceptance in release/assistant-handoff-184d0def102c/evidence.

## Verification ledger
- Task 1: adapter silence regression RED to GREEN; host watchdog binding assertion passes.
- Task 2: draft/fallback, direct replay and frozen mode regressions RED to GREEN; read-only subset 10 passed.
- Task 3: phone projection/wiring and overlay regression RED to GREEN; TypeScript passed.
- Final review: two Important findings fixed with failing regressions before correction. No deferred minors.
- Final suites: host 1128 passed / 17 ignored; daemon remote library 243 passed / 1 ignored; client 3364 passed / 3 skipped; adapter library serial 474 passed / 3 ignored.
- Initial concurrent adapter run had two image fixture failures; untouched baseline OpenAI subset and candidate serial library both passed. Full serial integration results are saved with evidence.
- Mobile build prerequisite: repaired the preexisting stale lock using the earlier acceptance patch, preserving existing versions; locked offline metadata passes.
- Installed acceptance remains pending; package/tests do not establish it. No main merge authorized or performed in this fix task.
