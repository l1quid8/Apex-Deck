# Worktree Mount Implementation Plan

Goal: implement the approved Worktrees menu Mount design so the human can test the inline Git card with real changes. Leave all changes uncommitted on feat/worktree-mount; preserve the existing Git-card work and unrelated files.

Architecture: a room_mount command validates a registered worktree in the same repository and atomically retires the idle room, preserving its full snapshot. The next room_create rebuilds the bots in the mounted folder. Room state supplies the authoritative cwd. Pane.mount persists the view's folder; Mount requests wait for idle, can be canceled, and move Files, Git and chat tools together.

## Tasks
- [x] Host + core: tests for history preservation, foreign/missing folders, busy/retired runtimes, registered same-repo targets, restart cwd; Full permission classification.
- [x] UI: Mount first in the row menu, Mounted label, protect Remove/Prune, deferred mount and cancel, pane cwd routing, popout following, old-chip provenance and existing notice line.
- [x] Verification: TypeScript, JS suite, Rust core/host/authority tests, focused rendered UI flow. Review changes. Build only from release and verify DMG/signatures. Do not commit or merge: the human will test those controls.

Review focus: racing post vs mount; stale room cwd on reload; preserved transcript/change records; old chips must not select same-named files in a different checkout; mounted worktree deletion protections; pending requests must stay attached to the original chat and machine.

Delivered: `release/Apex-Deck_0.8.2_arm64-worktree-mount.dmg`. TypeScript, 1,983 JS tests and 845 Rust tests passed (5 existing ignored). Packaged daemon confirmed actual bot cwd after mount, history/fork preservation and removal guard. DMG integrity, mounted app signature, all 153 packaged UI files and 514 release source files verified. Source remains uncommitted on `feat/worktree-mount` for the human to test Commit / Checks / Merge.
