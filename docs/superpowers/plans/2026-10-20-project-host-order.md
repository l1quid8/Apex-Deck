# Project host grouping implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Group projects by host and allow saved drag ordering only within the same host.

**Architecture:** Keep project and thread selection in App. Resolve host groups and manual ordering in sidebarModel; persist optional numeric sidebarOrder through the existing workspace/session save path. Sidebar owns drag feedback and collapsible host headers.

**Tech Stack:** Existing React, TypeScript, CSS, Node tests and Electron renderer tests; no dependencies.

**Spec:** Human selected option B in chat: grouped by host, drag sortable only within respective hosts. Mock B includes collapsible headers and keyboard move buttons.

## Global constraints

- Work only in the existing project-sort worktree; do not build or restart the app.
- Local group first, then saved host order, then unavailable hosts; never hide projects because a host is disconnected or removed.
- Reordering changes presentation only. Never change a project's host, path, IDs or threads.
- Existing pins lead until a custom order is set. Pin/unpin actions still move a project to the appropriate place within its host.
- Keyboard users can use Option+Up/Down or the move actions in the project menu.

## Review focus

- Interleaved hosts with duplicate names must stay separate by host ID.
- Hidden/new/imported projects must keep a valid order after saving and reloading.
- Cross-host and stale drag targets must leave all workspaces unchanged.
- Dragging project rows must not interfere with existing thread-source drags or rename inputs.
- Long host/project labels at the minimum rail width must not spill or obscure actions.

### Task 1: Grouping and persisted ordering

**Files:** src/sidebarModel.ts, src/types.ts, src/hostSession.ts, tests/sidebar-model.test.mjs.

- [x] Write failing tests for group order, within-host moves, pin behavior, rejected moves and saved order.
- [x] Implement projectGroups(projects, hostIds), reorderProject(list, sourceId, targetId, after) and numeric sidebarOrder normalization.
- [x] Run focused model, workspace and host-session tests.

### Task 2: Sidebar interaction

**Files:** src/Sidebar.tsx, src/App.tsx, src/styles.css, tests/project-order-layout.test.mjs.

- [x] Add a renderer regression for group collapse, drag direction, blocked cross-host drops, keyboard moves and reload.
- [x] Add host headers, same-host drop indicators, onReorderProject callback, move menu entries and keyboard shortcuts.
- [x] Verify real renderer interactions and Clay layout at narrow/wide widths.

### Task 3: Delivery

- [x] Run npx tsc --noEmit, npm test and git diff --check.
- [x] Review the final diff, commit on feat/project-sort and hand it to Jigga for review/integration.

## Verification

- Model tests failed first for missing grouping/reorder behavior and discarded saved ranks, then passed.
- Renderer regression failed against the ungrouped sidebar, then passed with the new implementation.
- TypeScript passed. Full JavaScript suite: 1,731 passed, zero failures.
- Updated the existing attention integration harness to inject the real projectGroups helper, preserving its thread drag and blocker coverage.
- Inspected Clay renderer screenshot; no horizontal rail overflow at 180, 220 or 300 px.
- Integration and installed-app validation are pending Jigga review and the next authorized build.
