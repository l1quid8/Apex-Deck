# Generated UI security gates and Run implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Keep the branch unmerged for review.

**Goal:** Finish the packaged security/lifecycle checks, fix demonstrated failures, and enable generated Run for the verified desktop runtime.

**Architecture:** Retain the isolated main-owned host and pinned upstream adapter. Verify the shipped Electron runtime using reproducible probes and an isolated real Deck/daemon profile. Bind runtime capability to exact verified runtime and policy versions; propagate that capability per connection/turn for bot guidance.

**Tech Stack:** Electron 44.5.1 / Chromium 152.0.7977.130, React, TypeScript, Rust.

**Spec:** `docs/superpowers/specs/2026-10-14-generated-ui-card-design.md`

## Global constraints

- No network or Deck data authority for generated code.
- Every revision/remount/retry requires a fresh trusted Run click.
- Watchdog runs in main and terminates only verified exclusive generated processes.
- Preserve untracked mockups, live profiles, installed app and live daemons.
- Leave `feat/generated-ui-run` unmerged and unpushed.
- Build release artifacts only from `release/`; dev launch only uses the repository-prescribed command.

## Review focus

- DNS/WebRTC traffic missed by promise-only checks: observe positive controls and external/local listeners/capture.
- Frozen child renderer or shared PID: chat/daemon must stay usable and generated PIDs must exit.
- Overlay/scroll or asynchronous revision changes: revoke the native view before it covers trusted controls.
- Late Discuss/start messages after cancellation: cannot alter a draft or revive a run.
- Phone/old remote client or runtime upgrade: keep fallback/comparison behavior and execution disabled unless verified.

### Task 1: Packaged network and authority gates

**Files:** new `desktop/generated-ui/security-network*.mjs`, `security-authority*.mjs`; evidence in a temporary directory and the review handoff.

- [x] Reproduce controlled positive traffic, then test all spec network vectors through the exact wrapper/srcdoc host.
- [x] Exercise real production Deck main/preload/IPC and isolated daemon with data/file/storage canaries and the authority matrix.
- [x] For any demonstrated failure, add a regression that fails first, fix the identified boundary, and rerun the affected packaged gate.

### Task 2: Native lifecycle and recovery

**Files:** new `desktop/generated-ui/security-lifecycle.mjs`, representative fixtures; modify `GeneratedAnswerCard.tsx`, `generatedRun.ts`, `host.mjs` only for reproduced defects.

- [x] Run real Deck chat with an isolated daemon and generated fixture replies; verify partial-stream fallback, Run/Stop/Discuss, revision approval and historical fallback.
- [x] Verify overlays, scrolling, focus/window/thread switches, reload/fork/rewind/move, suspend/quit and stale callbacks dispose runs and clear staged text.
- [x] Execute 32 real sessions, frozen initialization/after-ready/microtask/allocation and Stop recovery with PID receipts; include same-process diagnostic.
- [x] Verify accessible controls/reset, flowchart/chart/calculator fixtures and Claude/Codex output envelopes.

### Task 3: Verified capability and bot guidance

**Files:** `desktop/generated-ui/policy.mjs`, desktop client handshake, Rust protocol/host/room prompt flow, regression tests.

- [x] Add failing exact-version capability tests and per-client/per-turn guidance tests, including absent/unknown/phone capability.
- [x] After security evidence and independent review pass, enable only the recorded Electron/Chromium/adapter/policy tuple.
- [x] Keep arbitrary environment/renderer claims from enabling main execution; keep remote daemon execution absent.

### Task 4: Final verification and review

**Files:** review handoff and compact evidence receipts in `docs/superpowers/reviews/`.

- [x] Run `npx tsc --noEmit`, scoped generated/comparison/export tests, affected Rust tests, and full JS suite; compare existing baseline failures by name.
- [x] Independently review the whole diff and security receipts, fix important findings with regressions, and rerun the relevant gates.
- [x] Commit the concrete reviewable result without merging/pushing. Record exact capability tuple, test results and the command to test Deck chat.
