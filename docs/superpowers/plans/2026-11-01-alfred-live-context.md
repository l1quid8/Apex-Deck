# Alfred Live Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user keep viewing project threads while talking to Alfred, who can find permitted open or closed work, understand the referenced pane, and use existing authorized agent delivery.

**Architecture:** The host remains the authority for projects, room identities, workers and permissions. Each human message may carry an immutable snapshot of the originating window's focused/open thread IDs; these are resolved against current grants before use. A bounded fresh room retrieval section gets reserved space before conversation history, rather than being silently omitted after history. Existing room delivery, cancellation and approval rules remain the only mutation path.

**Tech Stack:** Existing React/TypeScript, Rust host, signed Swift computer-use helper and Python upgrade transaction. No dependency upgrades or alternate model/API credentials.

**Spec:** User decisions in this chat: all permitted threads searchable whether open or closed; open panes provide lightweight fresh titles/agents/status and focused context; voice remains with Alfred while viewing work; authorized instructions go to existing agents with report-back. Floating companion mockup is independently delegated and is not production UI authorization.

## Global Constraints

- Reuse clean `ucu-integration`; branch `feat/alfred-live-context` from tested main `a5e59557`. Preserve the other feature checkouts and their dirty files.
- Implement the user-authorized permission controls below; do not activate new grants or change existing saved grants merely by shipping the controls. No cookie/profile changes, real provider tests without explicit test scope, or model-supplied authority. Context is data, never authorization.
- Snapshot pane context at send time, not reply time. Bind it to the assistant's actual machine; never redirect another machine's pane into a local room with a matching ID.
- Keep read/search bounded and revocation-aware. Closed does not mean archived; archived and ungranted work remain excluded.
- Production builds only beneath canonical `release/`. Require `npx tsc --noEmit` before local merge. No push or automatic running-app replacement.

## Review Focus

- Long histories and many rooms must not remove the focused/live context or silently claim a complete catalog.
- Focus changes while a voice reply is pending cannot retarget the original request.
- A forged/stale pane ID, revoked project, remote host collision or archived thread must reveal no private room data.
- Search results are quoted external evidence; they cannot authorize sends, establish facts/memory, or alter settings.
- A still-running old helper after an upgrade must be detected or refused, with a useful diagnostic; signature/peer identity verification must never be relaxed.

### Task 1: Bounded authoritative room retrieval

**Files:** `personal_worker/rooms.rs`, `personal_worker/context.rs`, `personal_worker.rs`, existing worker tests.

- [ ] Add failing regressions for long-history catalog loss, closed-thread discovery by discussion text, current title/state, archived/ungranted exclusion.
- [ ] Discover saved rooms within validated project bindings; rank bounded excerpts by the user's request, prefer focused/open rooms, and explicitly report catalog limits.
- [ ] Reserve retrieval space before assembling history and preserve outside-content provenance.
- [ ] Run focused Rust tests and commit.

### Task 2: Immutable view context for typed and voice messages

**Files:** new small `assistantViewContext.ts`; `App.tsx`, `usePersonalAssistants.ts`, `personalAssistant.ts`; Rust `personal.rs`, `command.rs`, event consumers; focused JS/Rust tests.

- [ ] Write failing tests for host isolation, open/closed filtering, capture-at-send across focus changes, legacy messages and host revalidation.
- [ ] Carry only bounded IDs and the originating host, never client titles or grants. Resolve server-side against current permitted rooms. Share the send path across main chat, voice and float.
- [ ] Expose a lightweight current-thread label in existing assistant/voice surfaces without implementing the separately proposed visual design.
- [ ] Verify TypeScript, affected JS and Rust checks; commit.

### Task 3: Diagnose and prevent stale helper registration

**Files:** `computer.rs`, `personal_worker/computer.rs`, `scripts/upgrade.py`, existing helper/package tests.

- [ ] Record the observed stale-helper/new-daemon boundary without stopping active work.
- [ ] Write failing tests for the chosen lifecycle/diagnostic correction, then implement it with exact identity and signature checks preserved.
- [ ] Return safe, actionable per-reply readiness information instead of silently swallowing the registration failure.
- [ ] Run relevant package/helper/host regressions and commit.

### Task 4: Granular assistant authority and delegated approvals

**Scope added by the user in this chat:** Alfred may manage threads and participants, coordinate agents, gather context, perform file/command/browser/computer work, and handle approvals on the user's behalf within explicitly delegated limits. These are requested capabilities, not grants activated by this scope change.

- [ ] Inventory existing native operations and their permission boundaries before adding adapters; use direct host operations for app management and preserve computer-use authorization for visual interactions.
- [ ] Define distinct capabilities for creating threads, renaming/organizing threads, archiving, moving to Trash, permanently deleting, adding/removing participants, assigning/messaging agents, and pausing/resuming work. Preserve recoverable and permanent deletion as separate actions.
- [ ] Cover permitted conversation/file/status reads, file edits, commands/tests, browser/computer use, spending and publishing with explicit capability mappings. Existing grants remain effective; no ambient global computer grant substitutes for app permissions.
- [ ] Provide Ask every time, Allow when I request it, and Always allow for each supported capability, scoped to a thread, project or all projects where applicable. Approval cards also support Allow once. Precisely define whether a grant covers execution, delegated approval, or both.
- [ ] Treat approving other agents' requests as a separate delegable capability. Validate the underlying operation, target, scope, current grant and request provenance on the host at execution time. Alfred cannot approve its own privilege expansion or use an unrelated approval to authorize another action.
- [ ] Let the user explicitly delegate spending, publishing and permanent deletion too; do not hard-code them as human-only. Retain separate controls for these capabilities and the limits the user actually chooses.
- [ ] Record actor, underlying operation, target, authorizing grant and result for delegated decisions; provide revocation and clear outstanding-request behavior after revocation. Never expose credentials in the audit record.
- [ ] Add tests for one-shot versus persistent grants, explicit-human-request provenance, scope isolation, revocation, nested approvals, create/trash/permanent-delete distinctions and legacy policy compatibility.
- [ ] Extend the mockup with permission management and delegated-approval states; clearly label simulated controls. Verify native behavior separately from mockup checks.

### Task 5: Combined verification

- [ ] Run full JavaScript and relevant Rust suites, TypeScript, and one fresh whole-change review.
- [ ] Fix important confirmed findings with reproducing regressions; preserve mockup independence.
- [ ] Merge locally only after green checks, delete this task branch, and report exact validation and installed acceptance limitations.
