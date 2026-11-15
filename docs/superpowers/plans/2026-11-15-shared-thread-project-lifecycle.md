# Shared thread and project lifecycle implementation plan

**Goal:** Make desktop and CLI creation, renaming, editing, removal and deletion agree through the owning host.

**Design:** Keep room contents and thread metadata on the existing shared paths. Add a small host-owned project catalog, keyed by folder, including durable removal records. Removing a project hides it and closes its desktop panes; it never deletes its folder or saved threads. Explicitly adding the folder restores it. Keep durable thread-deletion records so stale panes cannot recreate deleted rooms. Existing desktop sessions seed project names without replacing newer host metadata.

**Approach:** Extend the shared host rather than synchronizing a separate CLI database or repairing only the desktop sidebar. This follows the user's request to check the shared backend and test edits from both interfaces. The request authorizes implementation; routine internal choices are settled here without an additional approval cycle.

**Constraints:** Preserve all pre-existing checkout edits (baseline patch: `/tmp/apex-lifecycle-before/checkout.patch`). Use isolated test data. Do not touch real services, publish CLI packages, merge, or build a release. Project names are display names; folder edits do not move files on disk. Existing model/agent/access edits continue through shared room commands.

## Tasks

1. Backend lifecycle: write failing integration regressions for deleted-room recreation, stale sessions, project rename/remove/re-add/restart, and independent clients. Add durable catalog storage, narrow project commands, notifications, and thread tombstones. Preserve unknown session data and remote host boundaries.
2. Desktop reconciliation: write failing tests for durable removal, host project names, missing-thread tombstones, empty projects, stale catalog replies, and host routing. Wire project actions to shared commands. Keep removed records after Undo expires; refresh immediately on lifecycle notifications.
3. CLI lifecycle: add `/projects` list/add/rename/remove and `/delete` (Trash), archive/restore controls using shared backend commands with Cancel-first confirmation. Filter stale/remote/session-only panes by authoritative catalog. Refresh/detach selected threads after external removal or deletion. Cover parser, controllers and shared-fixture behavior.
4. Verify: run focused and full relevant JavaScript/Rust suites, `npx tsc --noEmit`, and both-interface fixture checks; review the final scoped diff. Clearly report source-level verification separately from installed release behavior.

## Review focus

- Reconnection or restart must not resurrect removed projects/deleted threads.
- A stale save or list response must not overwrite a newer rename or removal.
- Identical paths on different hosts must remain separate.
- Project removal preserves files/history; deleting one thread preserves its siblings.
- Empty projects, folder aliases and unavailable hosts must not disappear or be silently recreated.
