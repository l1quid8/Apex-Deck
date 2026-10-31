# Task 2 implementation handoff

2026-10-31. **Signed native spike ready for independent review and Human permission setup; Task 2 live proof is not complete.**

Source is scoped to `computer-helper/spike/**` and `docs/computer-use-spike.md`; this requested report is the only additional write. Stable app: `/Users/tylercaldwell/Library/Application Support/Apex Computer Spike/Apex Computer Spike.app`; stdio command is its `Contents/Helpers/SpikeMCP`.

Identifier `dev.apexdeck.computer.spike`, Team ID `75N5HW62JH`, Developer ID Application: Tyler Caldwell (same Developer ID as Deck). Timestamped hardened-runtime app plus both nested helpers pass `codesign --verify --deep --strict`. Designated requirement and exact setup/reset instructions are in `docs/computer-use-spike.md`.

Actual no-prompt app checks after signed relaunch: Accessibility false, listen-event access false, tap health false. `SpikeMCP --status` is a bounded generic protocol inspection path; do not use CUA getApp for this menu-only agent app. Grant Accessibility only through the Human's System Settings selection of the exact stable app. Recheck listen access after that change before concluding whether separate Input Monitoring is required. No prompt/grant was requested by the agent.

The app starts stopped. Menu: **Computer Spike → STOP — cancel all input** directly latches cancellation on the main thread. **Start new isolated run** is the only reset and retries a missing tap. Establish the persistent proof-bot connection before Human Start: disconnect/EOF (including an operator status command ending) stops the fixture. Relaunch the same signed app after OS grants only if macOS needs it, and verify actual trust again.

Implemented five MCP tools (only TextEdit target), sequential bounded Unicode input with expected AX value/UTF-16 selection verification, per-event target/focus/window/document/fingerprint/secure-surface guards, listen-only activity epoch, independent matching cancel/EOF handling, and fresh bounded AX readings. No clipboard use or shortcut save implementation. Operator-only aggregate DS4 AX probe and one-window click exposure diagnostics are present but not invoked. Neither is a second MCP control target. See documentation for limits and diagnostic caveats.

Verification: Swift package builds; six pure policy/cancellation tests pass. TypeScript `npx tsc --noEmit` passes. Denied-access protocol smoke and final signature/readback result are recorded in the parent handoff. No native input has been posted; no TextEdit launch/focus, test dialog, DS4 probe, or synthetic diagnostic click has run. Runtime `.build`, app, socket and status artifacts are outside staged source / ignored.

Unchanged: `~/.claude.json`, all `.mcp.json`/shared MCP settings, live bots/rooms, Deck source outside Task 1, installed Deck bundles, user app windows, shared daemon/model processes, TCC databases and clipboard. No merge, push, Deck build/package or TCC reset.

Use unique proof-directory and run-numbered filenames, never overwrite an existing Documents file; document creation/save remains native.

Pending Human/source-review/backend gate: five DS4 runs and saved-byte inspection; native Save sheet PID/attachment; TextEdit and DS4 AX coverage; live Stop/cancel/fidelity tests; active/idle CPU/RSS and same-prompt DS4 throughput/tool-gap measurements; tap tags/hardware/untagged origin/permissions and manual/synthetic click observations; inspection of saved protected Deck logs for content redaction. This implementation does not claim any of those outcomes or production readiness.
