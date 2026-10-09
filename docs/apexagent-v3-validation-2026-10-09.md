# ApexAgent V3 validation — October 9, 2026

Implementation source: `b97b6833fa3c7aaea5c8d590d7c6758fd69b7645`, following the user-approved [V3 plan](superpowers/plans/2026-10-09-apexagent-v3.md). Main was fast-forwarded from `ba97376` without conflicts. The [usage guide](apexagent-delegation.md) describes the implemented workflow.

## Implemented behavior

- Resizable assistant dock beside shared multi-model chats, focused workspace, independent floating widget that stays green while open, and narrow-window linked-chat navigation.
- Chat, Tasks and Activity views; editable assistant profile; compact Needs you queue; original request, brief, results, checks, reported usage and durable history in task detail.
- One task-context composer, complete human question arrays and explicit approvals, pinned decision controls, and current-revision review acknowledgement only after the result enters the detail viewport.
- Natural named-worker routing from trusted saved profiles and chat rosters, with clarification for ambiguity or incompatibility. Assistant proposals require human approval.
- Real read-only tasks without a Git repository or writer reservation; editing modes retain existing in-place and isolated integration protections.
- Persistent estimated-cost pauses and explicit resume after raising/removing a cap. Open human questions and approvals block resume. Terminal clearing survives settlement of a stale worker snapshot.
- `assistant_workspace_v3` capability checks reject unsupported new requests before an older project daemon can ignore their optional fields.

## Verification

| Check | Result | Local evidence |
| --- | --- | --- |
| JavaScript suite | 1,038 passed, zero failed | `/tmp/apexagent-v3-js-final-wave.log` |
| TypeScript and Vite production build | Passed | `/tmp/apexagent-v3-build-final-wave.log` |
| Rust locked workspace, remote feature | 791 passed, zero failed; one existing live-agent test intentionally ignored | `/tmp/apexagent-v3-rust-final-wave.log` |
| Real-daemon E2E | 15 passed, zero failed | `/tmp/apexagent-v3-e2e-final-wave.log` |
| Native development widget smoke | 15 passed, including actual visible/clickable decisions at 320px, expansion, resizing and exact linked execution chat | `/tmp/apex-widget-screenshots/`; task-2 report |
| General native development smoke | Unchanged diagnostic repeat passed all steps and second launch | `/tmp/apexagent-v3-desktop-diagnostic.log` |
| Native multi-host smoke | Passed drop/reconnect, no replay, drafts, import/remap, removal protection and restored canvas | `/tmp/apexagent-v3-multihost-final.log` |
| Main checkout verification | 1,038 JavaScript tests and 791 Rust tests passed; TypeScript/Vite build passed | `/tmp/apexagent-v3-main-js.log`, `/tmp/apexagent-v3-main-build.log`, `/tmp/apexagent-v3-main-rust.log` |
| Signed final package | Developer ID build and deep/strict verification passed | `/tmp/apexagent-v3-package-final-wave.log` |
| Packaged desktop and widget smoke | Both passed; 15 widget checks, zero failed; general smoke and persisted second launch passed | `/tmp/apexagent-v3-packaged-desktop.log`, `/tmp/apexagent-v3-packaged-widget.log` |
| Installed native widget smoke | 15 passed, zero failed, using `/Applications/Apex Deck.app` with isolated data | `/tmp/apexagent-v3-installed-widget.log` |
| Normal installed app and preserved data | Verified V3 dock, saved profile picker, real task overview and shared chat with two idle bots; all durable chat files and saved identities preserved | Installation and preservation records |

The first general native smoke run timed out at its saved-agent fixture (`/tmp/apexagent-v3-desktop-final.log`). No source change was made for that timeout, and its cause was not reproduced in the successful diagnostic repeat. Final packaged validation is recorded separately above.

## Native installation

The package uses Developer ID Application identity `75N5HW62JH` and bundle identifier `dev.apexdeck.app`. The app version remains 0.5.1; source and artifact hashes identify this V3 update. The verified package hashes are:

| Artifact | SHA-256 |
| --- | --- |
| `Contents/Resources/app.asar` | `9d2cccf697315609674a01ff341325f14ee1ba68a3770a04d3c9b970256bbefb` |
| Signed `Contents/Resources/bin/apex-daemon` | `21d019705ee8d5bb4e31cc8c1a1ead0ad0cd05299934f254a32439e6d4fe20e0` |

Two staging attempts stopped before replacing the app because the background service was being reloaded. The service then became stable; the installer rechecked live workers and human waits, verified its serving PID, and shut it down gracefully before making consistent app/data backups. No cause is attributed to the reloads.

Installed at 2026-10-09 23:06:01 UTC in `/Applications/Apex Deck.app`. Both installed artifact hashes match the tested package exactly, and deep/strict signature verification passed after the bundle swap. The loaded LaunchAgent serves the installed daemon and advertises `assistant_workspace_v3`. Existing remote access and pairing identity remain unchanged.

Recoverable backup: `/Users/tylercaldwell/Library/Application Support/Apex Deck/build-backups/20261009T230536-apexagent-v3`. It contains the previous signed app, daemon data, desktop data and LaunchAgent plist. Installation evidence is `/tmp/apexagent-v3-install-final.log` and the implementation checkout's `.superpowers/sdd/2026-10-09-apexagent-v3/installation.json`.

Fresh read-back preserved three workspaces, nine saved chat panes, seven complete saved profiles and both proposed task records, including their IDs and revisions. SHA-256 comparisons preserved host ID, Iroh identity, paired devices and remote configuration. All 29 files in the durable saved-chat store (6,573,241 bytes) matched the stopped-service backup before reopening. Live room handles are restored lazily after restart: the first direct room-state comparison ran before the UI had restored them, and was replaced with durable file verification plus the reopened chat's actual state. The reopened shared chat has both existing bots, no running worker, and no pending question or approval.

The normal native UI showed a 480px resizable V3 dock, editable Thinking with profile, Chat / Tasks / Activity tabs, and the two real pending proposals in Task overview. No proposal was approved, dismissed or dispatched during validation. The installed widget fixture exercises paid-provider substitutes on isolated data; the existing monitoring responsibility was retained.

## Review

GPT Luna helpers implemented and reviewed disjoint UI, dock, routing and cost paths. Host and UI reviews were clean after refinements. The whole-branch review identified one Important budget-resume issue. The single final fix wave closed it and added older-host compatibility protection; its bounded scoped re-review reported Ready to merge with no remaining actionable findings. Review reports are under `.superpowers/sdd/2026-10-09-apexagent-v3/` in the managed implementation checkout. The controller independently ran the suites listed above; source review reports alone were not treated as test results.

## Limits

Deterministic local provider fixtures establish the tested workflow without paid model calls. They do not establish physical iPhone or live paid-provider behavior. CLI-reported costs are estimates; reporting may arrive at the end of a turn, and missing cost remains Unknown. A spend pause is not a guaranteed hard billing ceiling. Remote project daemons must be upgraded separately from the Mac app before V3 controls are available. Existing isolated-startup limitations of the Codex adapter remain described in the usage guide.
