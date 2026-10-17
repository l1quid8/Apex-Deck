# Deck Phone validation — 2026-10-17

Implementation is on `feat/phone-finish`, continuing the unmerged `ios-sim-upgrade` work. Neither branch has been merged or pushed. The original plan is [2026-10-16-deck-phone.md](plans/2026-10-16-deck-phone.md).

## Verification

Final tree at implementation commit `240654b` (following pending-fix commit `9caf0fa`):

| Check | Result |
| --- | --- |
| `TMPDIR=/tmp cargo test --workspace` | 1,025 passed, 5 ignored, exit 0 |
| `npm test` | 1,490 passed, exit 0 |
| `npx tsc --noEmit` | Passed, exit 0 |
| `git diff --check` | Passed |

The ignored simulator test is supplemented by the real daemon/CLI run below. Two pre-existing adapters dead-code warnings remain. One concurrent frontend run encountered `artifact-frame-runtime` Electron-temp cleanup `ENOTEMPTY`; the final rerun after stopping the simulator passed all 1,490.

- Real throwaway simulator: `phone start` returned 603×1311 after a 96-second cold start; immediate `look` succeeded. `elements`, open, tap, swipe, type, key, human takeover, give-back/wait with queued chat, done and stop succeeded through the actual daemon/CLI. Device FA12E7EA-6407-4E64-B4B9-BB97B092A563 was deleted successfully. No human simulator or real phone was used.
- Real Codex app-server `command/exec`, with no model turn: Full access reached the throwaway daemon after explicit phone environment settings. Workspace-write could not connect, including with the environment explicitly verified. This covers the sandbox used by Ask/Edits.
- Offscreen render inspected in four states: off with error, starting, human driver and bot driver. Actual image dimensions now fit the rounded image box.
- A fresh reviewer checked the whole implementation and fix delta. All Important findings were addressed; no outstanding Critical/Important findings were reported in the final review. The reviewer did not independently rerun the suites.

## Behavior decisions

- One action already running may finish before human input executes. Queued bot actions recheck ownership and cannot run ahead of pending human input, even when an existing tool runs longer than ten seconds.
- The ten-second idle release begins again when the last accepted human input finishes. Cancellation drops the pending-input reservation; a prior startup generation cannot release the current generation's reservation.
- Startup generations run serially. Shutdown reserves its barrier before publishing Off; old cleanup checks generation before touching the device. A restart may therefore wait for an old startup command's bounded timeout.
- Bot startup retains its 110-second deadline and waits for a real frame before reporting a usable phone. A still-starting response is not a ready screen.
- Typed text is flushed before tap/Home/Lock/Give back/Turn off, split into at most 500 characters, and cleared when off. Off also discards the previous image and sequence.
- Codex receives only the five phone variables as explicit shell environment settings. Other environment policy and sandbox settings remain the person's choices. Ask/Edits do not silently elevate; the guide says Full access is required for phone control on this Mac.
- The existing task branch was preserved; `feat/phone-finish` satisfies the repository's typed task-branch rule. Integration must include this continuation branch.

## Before integration

The plan's Task 13 steps 4–5 explicitly reserve merge and branch/worktree removal for human approval. Repository instructions permit the live desktop dev app only from the main checkout, so the human-controlled live Phone-tab check still follows an authorized merge. Pushing has not been authorized. Memory changes have not been requested and were not made.

After integration, check one Claude and one Codex bot at Full in the same room, human tap/type takeover, automatic resume after idle, and a chat message during takeover. Automated regressions and a CLI simulator test do not replace that live human check.

## Scope limits

First version is a Mac desktop Phone tab. It uses Apple's simulator; it does not implement an iOS runtime. Plain ASCII typing only, and native accessibility names do not expose web-page controls (use pictures and coordinates). Real-device installation and automatic TestFlight delivery are outside this plan.

## Deferred minor findings from the implementation ledger

The user-visible startup, stale-image, input ordering, input-size and startup serialization issues were fixed in this continuation. The remaining polish, diagnostics and test-coverage observations are preserved here rather than presented as completed work:

- Task 4-6: minor (deferred): tar stderr dropped in "Couldn't unpack" error.
- Task 4-6: minor (deferred): ensure filesystem steps untested offline.
- Task 4-6: minor (deferred): off-screen elements listed at clamped/out-of-picture coords.
- Task 4-6: minor (deferred): 200-line cap truncates silently.
- Task 4-6: minor (deferred): labels with newlines/quotes split a line; value-only prints "" label.
- Task 4-6: minor (deferred): reqwest {e} omits cause.
- Task 4-6: minor (deferred, plan-mandated): the_guide_names_every_command is weak.
- Task 7: minor (deferred): stream failures silent (respawn every 1 s, no problem shown).
- Task 7: minor (deferred): measuring loop drops describe-ui error.
- Task 7: minor (deferred): after stop(), a waiting bot is told "go ahead" then turns the phone back on.
- Task 7: minor (deferred): empty Elements reply omits the web-page note.
- Task 7: minor (deferred): running()/ready() duplicate match; wire_name via serde; base64 under frame lock.
- Task 7: minor (deferred, plan-mandated wording): "Typed 1 characters."; UNREADABLE says "Turn off" while off and leaves sim booted; NOT_MADE says "simulator".
- Task 7: minor (deferred, pre-existing): apex-adapters dead-code warnings; clippy deny in apex-host test target (assistant_service.rs).
- Task 7: minor (deferred): Busy::Human text says "is using" even for a finished missed turn; only the latest person turn is reported if two happen before wait; a bot that ran done is paused once after a later person turn.
- Task 8-9: minor (deferred): status/start/look/elements/wait/done silently accept extra words.
- Task 8-9: minor (deferred): wrong argument counts get "needs whole numbers"; bare tap doesn't mention --label; dangling --ms untested.
- Task 8-9: minor (deferred): key usage text duplicated (phone_cli.rs:116,177).
- Task 8-9: minor (deferred): phone_cli main untested (env gating, Wait→75 only manual).
- Task 8-9: minor (deferred): look pictures never pruned; default perms (fine on macOS TMPDIR).
- Task 8-9: minor (deferred, plan-mandated): failures to stderr; raw OS errors in a few messages.
- Task 8-9: minor (deferred): no host.call dispatch smoke test for phone_* commands.
- Task 10: minor (deferred): no test pins room_create's phone wiring (macOS gate, socket, room id; reopen).
- Task 10: minor (deferred): no test for the tools_disabled gate.
- Task 10: minor (deferred, plan-mandated): gate expression written twice in cli.rs (140, 608).
- Task 10: minor (deferred): end-to-end adapter test adds ~10 s (Codex phone-off turn redundant).
- Task 11-12: minor (deferred): a hung view/input freezes polling/controls (no timeout).
- Task 11-12: minor (deferred, plan-mandated): role=status countdown re-announces every second; focus-visible absent after click; keyboard users can't tap.
