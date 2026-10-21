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

## Packaged follow-up validation

The first Developer ID signed test bundle failed on mic selection: Electron's
`fs.promises.cp` could not recursively extract `desktop/moshi` from `app.asar`,
even though the files were present. Replaced both setup/start extraction calls
with explicit reads and writes of the five client assets. A new real-Electron
archive regression test failed with the same ENOENT before the fix and passed
afterward; it uses a readiness stub rather than downloading or running models.

Rebuilt signed test app (no installation or merge):
`/Users/tylercaldwell/Downloads/apex-deck/release/moshi-911469e-fixed/mac-arm64/Apex Deck.app`.
The bundle contains the exact modified runtime (SHA-256
`37c59f443ee3b0aa7ca5d68c3b688df584852b044a9e920155e384a2ca691b89`).
It uses the existing installed daemon binary for the isolated UI test; this is
not a complete release candidate. Production app/data were not replaced.

Verified in that unchanged signed bundle:

- `codesign --verify --deep --strict` passed; packaged flag is true and the
  microphone usage description is present. Existing macOS mic access was granted.
- Clicked the packaged microphone entry: cached Moshi started automatically,
  captured a real live microphone at 48 kHz, and ran the playback AudioContext.
- Fed a 4.96-second recorded question through the test socket after verifying
  actual microphone capture. Recorded 157 returned 24 kHz PCM frames (12.56 s),
  RMS 0.04231, with rendered playback RMS peak 0.17085. The model generated a
  spoken response; these measurements include an analyser attached to the
  playback worklet, rather than only receiving socket bytes.
- Mute produced 13 measured frames with no nonzero samples. Close stopped the
  helper group; reopening started a fresh loopback session with live microphone.
- Test-only Electron permission denial displayed `Permission denied`, ended the
  previous mic track, and exposed Start again. OS permissions were unchanged.
- Final runtime state was off, zero voice windows, and no helper processes.
- `npx tsc --noEmit` passed, `npm test` passed 1,783/1,783, and the Python runner
  tests passed 5/5.

Evidence and `moshi-playback.wav` are under the test bundle's parent directory.
Physical speaker audibility is still awaiting the human's listening check; the
Mac's default output was an HDMI display. A fresh OS permission prompt was not
tested because authorization already existed. No claim of physical listening or
first-use OS permission approval follows from the successful audio measurements.
