# Local Moshi implementation plan

**Goal:** The desktop microphone starts a local speech-to-speech session without a terminal. Voice stays off until selected. First use explicitly offers the approximately 5.2 GB download.

**Architecture:** Electron owns the local helper because voice must run on the client Mac even when Deck is connected to a remote daemon. A private, sandboxed voice window talks to the pinned Kyutai MLX runner over authenticated loopback. Python and models live in Deck's data folder. Cloud providers are a separate task.

**Constraints:** Apple Silicon only for this backend. No system Python dependency. No microphone access before selection. Never expose Deck preload or credentials to the voice page. Preserve the existing assistant call. Do not launch dev or release builds from this worktree.

## Tasks

- [x] Test lifecycle: no eager start, one concurrent startup, explicit first-use consent, cancellation, errors, retry and process-group cleanup.
- [x] Implement a pinned uv bootstrap, managed Python 3.12, moshi_mlx 0.3.0, persistent cache and bounded setup diagnostics. Pin uv archive SHA-256.
- [x] Adapt the upstream concurrent runner to raw float32 audio; test framing and authenticated requests. Keep upstream inference unchanged.
- [x] Add an isolated local call window with capture/playback worklet, mute/end controls and bounded audio queues. Reject navigation, foreign origins and non-audio permissions.
- [x] Add a desktop mic entry and setup/status dialog, start only on selection, cancel on dismissal, stop on call close and app exit.
- [x] Run `npx tsc --noEmit`, `npm test`, Python adapter tests and a cached-model handshake/audio smoke test. Report any unverified audible/packaged behavior explicitly.

## Review focus

Cancellation during dependency/model setup, child processes surviving window close, duplicate requests/windows, permission denial and loss of the audio socket, and non-local requests reaching the voice helper.

## Execution evidence

- `npx tsc --noEmit`: passed.
- `npm test`: 1,782 passed, zero failed.
- Python adapter: 5 passed, independently rerun in review.
- Real model: new managed Python 3.12 setup succeeded using the existing model cache; authenticated handshake and 5 finite PCM audio frames passed. Latest cached startup: 5.5 seconds.
- A forced SIGKILL of an actual inference/codec worker propagated to an error and cleaned up the helper process group.
- Independent review found and verified fixes for restart/stop races, worker death, inherited-pipe cleanup, and post-ready status regression. No remaining important findings.
- Electron microphone permission, audible playback, and the packaged app were not tested. No dev app, DMG, merge, or push was performed. The remaining smoke is to click the mic in an integrated desktop build, allow the microphone, speak/listen, mute, restart, and end the call.

Ruling: cap sessions at 30 minutes with a fixed local restart action, rather than inheriting upstream's roughly five-minute generation limit. A watchdog detects native worker crashes as well as Python exceptions. The voice page gets no Deck preload; main intercepts only its fixed local restart route.
