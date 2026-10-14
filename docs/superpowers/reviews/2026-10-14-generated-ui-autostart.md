# Generated UI automatic opening

Branch: `feat/generated-ui-autostart`, based on `988458f`. Product change: `278fc5d`. Unmerged and unpushed.

The human requested removing the initial **Run this interface** action. The newest complete, valid generated bot card now opens automatically after 250 ms of stable, fully visible geometry in the focused desktop chat. Streaming, invalid, human, unsupported and historical cards remain nonexecuting. Only one card is nominated per thread; duplicate identities in a reply cannot nominate two hosts.

There is no initial launch button on the automatic card. Trusted **Stop** and explicit **Restart** remain; older distinct cards offer **Open interface**. A stopped, failed or frozen instance does not automatically retry. Attempt suppression survives pane availability/focus changes; disposing an unopened controller does not consume its attempt. The readable fallback is under **Text version**, below the stable native viewport.

Main still validates the full payload and binds each fresh admission to its owner, identity and revision digest. It now additionally rejects hidden, minimized and background owners before allocation, after previous cleanup, and before payload delivery. Ongoing geometry, overlay, watchdog, cancellation, process ownership and session-limit protections are retained. The network, permission and opaque-frame policies are unchanged. Discuss still requires trusted preview acceptance; sending remains a separate human action. Bot guidance and the design spec describe automatic opening.

## Verification

- `npx tsc --noEmit`, build, harness syntax and `git diff --check`: passed.
- Generated/comparison scoped tests: 109 passed.
- `cargo test -p apex-core`: 144 passed.
- Independent read-only code review found no remaining blocker.
- Packaged runtime copy, Electron 44.5.1 / Chromium 152.0.7977.130: automatic phase 6/6, native lifecycle 24/24, 32-session cleanup and cap 2/2, actual quit and PID exit 2/2. Every recorded generated PID exited; chat and the isolated daemon remained usable.
- Final full suite: 1,421 passed and exactly the same 12 baseline failures, with no new failure names. An earlier default-concurrency run timed out the existing quick-selector test; its scoped rerun and the final full run at concurrency 4 passed that test.
- Primary DMG: `apex-daemon 0.7.0 (278fc5db66ea)`, 143,603,949 bytes. DMG integrity and mounted app signature pass; its mounted archive matches the candidate. Signed with Developer ID, not notarized.
- Final automatic phase against that exact package: 6/6 passed, all generated PIDs exited, production capability unchanged, every recorded source hash matches the checkout. Mounted archive and retained production archive share SHA-256 `d41a1444baecf047b4343718dccaaded721098005a6aa66981fa7470912615b4`.

[Compact receipts and exact baseline failure names](2026-10-14-generated-ui-autostart-evidence.json).

The automatic phase exercises no-click startup, local controls, Stop/Restart, two remounted different-ID cards with exactly one new payload, revision replacement and historical fallback, and frozen recovery without repeat execution. The broader lifecycle checks include actual OS keyboard Reset for Claude/Codex cards, overlays, disconnect/reconnect, thread fork/reload, Retry/Revert, zoom, suspend, stale Discuss and runaway code. The test's OS Return delivery is asynchronous so it cannot block main's watchdog or expire geometry leases.

Evidence: `/tmp/deck-generated-lifecycle-dZ1iJZ`, `/tmp/apex-autostart-scoped.log`, `/tmp/apex-autostart-rust.log`, `/tmp/apex-autostart-full-final.log`. The lifecycle runner changes only a temporary app copy for instrumentation; it retains the shipped Electron binaries and real main/preload/daemon integration. Final package verification separately requires matching production source hashes and the production capability registry.

## Testing the primary build

Install `release/Apex-Deck_0.7.0_arm64.dmg`, open a desktop thread and ask for a generated flowchart. Once the finished interface is fully visible, it opens automatically. Use **Stop** to stop it and **Restart** if you want a fresh run. This change does not install the app or update a remote daemon or phone.
