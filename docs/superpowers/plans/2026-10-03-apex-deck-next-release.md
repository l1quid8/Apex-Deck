# Apex Deck Next Release Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans`, when available, to work through the first release task by task. Steps use checkboxes for tracking. This is a draft handoff for a future group chat; no implementation has started.

**Goal:** Make Apex Deck dependable enough to reopen a project, restore a saved team, run a conversation, and stop ongoing work promptly.

**Architecture:** Keep conversation rules in `apex-core`, provider and process behavior in `apex-adapters`, and persistence and desktop lifecycle in `src-tauri`. Keep React focused on presenting state and issuing commands. Extend the existing backend interface so native and browser preview behavior remain explicit.

**Tech stack:** Tauri 2, Rust, React, TypeScript, xterm.js, existing workspace dependencies.

**Spec:** Existing `SPEC.md`, plus the release requirements below. These requirements are proposed additions to that roadmap.

## Product direction

The eventual workflow is: choose a project, load a Coder + Reviewer team, request a change, inspect the diff and test evidence, and decide what to keep. The first release builds its reliability foundations. A later release adds supervision and change inspection.

The welcome screen should offer an obvious first action. A saved team is a reusable roster with models, roles, access settings, and room options. It does not include a previous conversation or running processes.

## Global constraints

- Preserve the existing mixed-backend chat, routing policies, hop limit, and live terminal behavior.
- Preserve read-only defaults. Restoring a session or applying a template must never silently increase access or start an agent.
- Keep API key values out of saved state. Store environment-variable names only. Treat transcripts as private local data.
- Use existing dependencies where practical. Explain any new dependency and its specific purpose before adding it.
- Separate native verification from browser preview verification. Canned replies are not evidence that providers work.
- Keep changes local. Do not publish, merge, or deploy as part of this plan.
- Recheck the checkout before implementation. This folder had no `.git` directory when inspected; do not invent branches or commit evidence.
- Only one participant edits a shared checkout at a time until worktree isolation exists. Reviewers examine the implementation and evidence before the next task.

## Baseline and preflight

The review on 2026-10-03 found a passing frontend build and 76 passing Rust tests. Native terminal interaction and real provider execution were not independently verified. Recheck these facts because this plan will be used later.

- [ ] Read the current `README.md`, `SPEC.md`, and any applicable `AGENTS.md`.
- [ ] Run `cargo test --workspace` and `npm run build`; record the actual results.
- [ ] Exercise a native terminal in a disposable project, including input, resizing, workspace switching, and process exit.
- [ ] Exercise real installed chat providers with a short read-only prompt. Check model selection, streaming, error reporting, mentions, and round limits. Record unavailable providers as untested.
- [ ] Fix any regression that blocks the existing chat workflow before extending it.

## Review focus

- Stop during a silent or hung reply must cancel work, not just hide its output.
- A restart during generation must restore completed history without rerunning work or treating an incomplete reply as complete.
- Concurrent streaming and saves must not allow an older snapshot to overwrite newer state.
- Missing project folders, unavailable providers, or corrupt saved files must produce a recoverable state without wiping the original data.
- Applying a saved team must preserve unique handles and requested permissions without changing an existing conversation unexpectedly.

## Release 1: reliable sessions and reusable teams

### Task 1: immediate cancellation and safe room cleanup

**Files:** `crates/apex-core/src/room.rs`, `participant.rs`, and related core types; `crates/apex-adapters/src/cli.rs` and `openai.rs`; `src-tauri/src/lib.rs`; `src/backend.ts`, `src/types.ts`, `src/ChatPane.tsx`; existing core and adapter tests.

**Contract:** A run has an identity and cancellation signal separate from the room lock. `roomStop(id)` requests cancellation without waiting for that lock. Cancellation settles the run once, releases resources, suppresses stale deltas, and returns the room to a usable state. A later post starts a fresh run.

- [ ] Add a deterministic test participant that signals when a reply starts and then waits indefinitely. Test Stop during that wait, including everyone and round-robin policies.
- [ ] Replace the between-turn-only stop check with a cancellation-aware wait around active replies. Preserve the room and completed transcript when a reply is cancelled.
- [ ] Make CLI cancellation terminate and reap its process, terminate spawned descendants where supported, and finish or cancel its stdin/stderr helper tasks. Verify cleanup using a test command that starts a child process.
- [ ] Make HTTP cancellation drop the response stream promptly. Add bounded connection and inactivity waits so a dead provider cannot hold the room indefinitely.
- [ ] Show `Stopping…` until cleanup completes, then restore Send. Keep any displayed partial reply visibly interrupted and out of completed model context.
- [ ] Apply the same lifecycle rules when closing a chat or removing its workspace. Closing the UI must not leave chat commands running invisibly.
- [ ] Test repeated Stop, Stop just before completion, a late delta, closing during generation, and a new message after cancellation.

**Acceptance:** With the local test participant, Stop settles within one second. The test CLI and its descendant are gone, no later delta appears, and the next message works. Provider-side billing or work may continue after a network disconnect; the UI must not promise remote cancellation it cannot verify.

### Task 2: durable session recovery

**Files:** Create `src-tauri/src/session_store.rs` and `src/session.ts`; modify `src-tauri/src/lib.rs`, core room restoration/types, `src/backend.ts`, `src/types.ts`, `src/App.tsx`, and `src/ChatPane.tsx`; extend wire-format tests and add persistence tests.

**Contract:** A versioned session document stores workspaces, pane descriptors, titles, active workspace, layout, room rosters and options, and completed transcript messages. Native storage lives in Tauri's app-data directory. Rust owns completed chat history; UI layout updates cannot overwrite it. Running processes and credentials are excluded.

- [ ] Define and test the versioned document and room restoration constructor before changing startup behavior. Validate IDs, workspace references, participant handles, and message sequence ordering.
- [ ] Add load/save backend commands and a serialized save queue. Write a temporary file, then replace the saved document atomically. Report failures visibly and retain the previous valid file.
- [ ] Save completed messages and configuration mutations from the authoritative backend. Debounce UI layout saves and flush them on normal shutdown; do not rely on frontend unload events for chat durability.
- [ ] Import the old `apex-deck.workspaces.v1` list once when no native session exists. Preserve the old data until the new file is successfully saved.
- [ ] Hydrate startup before creating empty rooms or triggering default saves. Restore terminal panes as stopped with an explicit Start action. Restore chat history and settings without submitting a prompt.
- [ ] Show missing folders and unavailable agents with a path-repair or provider-edit action. Keep the conversation readable.
- [ ] Test a normal relaunch, forced termination during a reply, corrupt JSON, unsupported schema version, write failure, and two saves whose completion order would otherwise race. Preserve the source file on recovery errors.

**Acceptance:** Relaunch restores completed history, participants, access settings, pane titles, and layout. No agent launches and no message resubmits automatically. Interrupted work is identified honestly. Save failure never masquerades as successful persistence.

### Task 3: saved teams and a simpler first conversation

**Files:** Create `src/TeamPicker.tsx` and `src-tauri/src/team_store.rs`; modify `src/backend.ts`, `src/types.ts`, `src/App.tsx`, `src/ChatPane.tsx`, and `src/styles.css`; add store and team-application tests.

**Contract:** A team template has its own ID, name, participant configurations, and room options. `teamsList`, `teamSave`, and `teamRemove` operate on the local template library. Applying a team creates a new chat with that roster; it does not mutate another chat or launch a turn.

- [ ] Build team persistence on the versioned and atomic storage approach from Task 2. Store no transcript, project path, or key values in a template.
- [ ] Add Save team to populated chats and a team picker to the pane creation flow. Support renaming, updating, and removing a template independently of active chats.
- [ ] Offer a Coder + Reviewer starter configuration. Let the user select installed providers and models; leave access read-only until they deliberately change it.
- [ ] Preview names, models, and access before creating the room. Flag unavailable providers and duplicate handles inline.
- [ ] Keep model and access visible. Put persona and reasoning effort behind an expandable Advanced section with keyboard-accessible controls.
- [ ] Test saving and reopening a team, unavailable providers, duplicate handles, failed writes, and deleting a template while an instantiated chat remains open.

**Acceptance:** A user can save a two-person team, relaunch, load it into a new project chat, inspect its access settings, and send a message without reentering every setting. Existing conversations remain intact.

### Task 4: release validation and documentation

**Files:** `README.md`, `SPEC.md`, and a release validation record under `docs/`.

- [ ] Run the full Rust suite and frontend build after the changes. Add focused frontend tests only for meaningful new state behavior; use the smallest suitable test setup if one is needed.
- [ ] Verify the packaged native app: save a team, open a project, send a real provider prompt, stop mid-reply, send again, close during generation, relaunch, and restore the completed transcript.
- [ ] Check shell input and pane resizing again. Confirm switching workspaces preserves live sessions within a launch.
- [ ] Check keyboard focus, accessible control names, readable failure messages, and multiple panes at the native minimum window size of 900 × 600.
- [ ] Document recovery behavior, storage location, cancellation limits, provider coverage, and any remaining limitations. Update roadmap states only where supported by evidence.

**Release gate:** All automated checks pass, the native workflow passes, persistence errors are visible, and cancellation cleanup is demonstrated. A browser preview alone cannot satisfy this gate.

## Release 2: supervise work and inspect results

Draft a separate detailed plan after Release 1 is validated. Keep the order below.

1. **Status inbox.** For chats, use lifecycle events to show running, stopping, failed, and idle. For terminals, distinguish recent output from known agent state; silence is not proof of idle. Add explicit Waiting for you when supported and a manual fallback. Pattern-based detection must be labelled heuristic. Clicking an item selects its workspace and pane.
2. **Transcript usability.** Render safe Markdown and copyable code blocks. Disable raw HTML. Preserve scroll position when reading older messages; offer a New messages control. Keep speaker and interrupted-state labels readable without relying on color alone.
3. **Pane controls.** Add persistent draggable dividers, editable pane names, and documented shortcuts for switching and maximizing panes. Use consistent icons and adequate pointer targets.
4. **Changes view.** Use structured local Git output to show modified, staged, and untracked files, with safe handling for unusual filenames, large diffs, and binary files. Treat non-Git folders explicitly. Attribute changes to a workspace unless isolation gives evidence for stronger attribution. Separate agent-reported test results from tests Apex Deck actually executed. Provide no automatic merge or discard action.

**Acceptance:** The user can identify which task needs attention, jump to it, inspect actual file changes, and assess recorded test evidence without relying solely on an agent's summary.

## Release 3: isolated agent editing

Plan this separately because it changes the workspace and process model.

- Offer an explicit opt-in to one Git worktree and branch per agent doing independent edits.
- Keep reviewers read-only by default and make the selected review target clear.
- Handle dirty source checkouts, non-Git folders, branch collisions, missing worktrees, and cancelled setup without losing files.
- Bind terminals, chat CLI participants, status items, and diffs to the correct worktree.
- Provide a reviewed integration flow. Preserve dirty worktrees and require deliberate action before deleting them or discarding changes.

**Acceptance:** Two editing agents can change the same file independently without overwriting one another. The user can inspect each result and integrate a selected change deliberately.

## Defer until these workflows are dependable

Voice, scheduling, system notifications, cloud sync, automatic merging, and additional provider formats. Revisit integrations when a concrete user workflow requires them.

## Group chat working instructions

First inspect the current build and challenge this draft where the code has changed. Agree on Release 1 interfaces before implementation. Use one implementer and one reviewer for each task; serialize edits in a shared checkout. Work through Release 1 only, then report its validation evidence before expanding scope.

After each task, report: files changed, observable behavior, actual checks run and their results, unresolved limitations, and the review decision. Distinguish source review, automated tests, browser preview, native interaction, and real provider execution. Do not mark a task done from a model's statement alone.
