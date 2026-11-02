# Voice client/audio investigation

Scope: Meta controller/client, local transport, audio contexts/playback worklet, desktop voice log filter. No STT removed or bypassed.

## Reproduced before fixes

- Meta playback callback regression: consuming 48,000 bytes and draining segment 7 produced no `playbackProgress` / `playbackComplete` helper messages. Both assertions pass after forwarding those callbacks. This supplies the credits whose absence caused the lead engineer's five-second TTS stall repro.
- Meta mute regression: speechStart while muted, unmute, then speechComplete submitted one phantom turn. Fixed result: zero submissions. Active turns crossing a mute are also marked rejected; no transcript text is logged.
- Local capture congestion regression: 100 mic frames with WebSocket bufferedAmount 40,000 triggered 100 failure callbacks. Fixed: zero failures, zero additional sends while congested, next frame sends after congestion clears.
- Meta congestion mutation check: removing the send-buffer guard sends all 100 frames; restoring it sends zero during congestion, then resumes. The call remains listening.
- Playback RMS regression: no level events existed. Worklet now emits measured RMS every approximately 50ms; test verifies half-amplitude output and zero after drain. Flush resets the accumulator.
- Microphone recovery regression: ended track produced one stream and an error. Fixed: a second stream is acquired, old source disconnected/tracks stopped, replacement released on close. Devicechange uses the same serialized recovery path. Context interruption resumes contexts.

## Event contract

Timestamped JSON, no transcript text. Desktop now persists both `[voice event]` and `[voice meta event]`, plus their end lines.

Events added: micOpen, micClose, mute, audioChunk (sampled once per second: bytes/rms/frame count), micFrameGap (>200ms delivery gap), micSendDropped (first and every 32 drops), micRecoverStart, micRecoverComplete, micRecoverFailed, audioResume, ttsQueued, playbackFlushed, playbackComplete, sttResult (turn id/character count/rejected), stateTransition. Playback output RMS is delivered through optional sixth openVoiceAudio callback, onLevel(level), in normalized 0..1 units.

## Verification and limits

38 focused tests pass; npx tsc --noEmit passes. Full npm test: 3,160 tests, 3,155 passed, 2 failed, 3 skipped. Failures: assistant-float-browser.test.mjs (renderer script exception) and assistant-voice-lifetime.test.mjs (OS-close bridge identity assertion). Both pass when rerun serially with --test-concurrency=1 (2/2). The original full run remains a failed run; serial recheck suggests concurrency-sensitive Electron tests. Regression logs were captured in /tmp/null-voice-*.log and /tmp/null-audio-*.log on the test machine.

No installed-app acceptance run or package built by this worker. Ten long replies, full first word on interruption, 30 minutes muted, and actual audio-route/sleep recovery still require integrated acceptance.

Integration notes: coordinator.ts intentionally ends calls on Mac suspend and desktop shuts down the helper. Context resume here does not override that policy. The shared state-machine owner must add the sixth callback to its dependency type and feed real RMS into visuals. WebSocket send bounds prevent unbounded new buffering but cannot undo an already blocked renderer or guarantee no speech loss during a renderer stall. Mic gap events expose that remaining problem. Playback worklet's existing five-second capacity remains; helper credit-reset recovery must not be treated as proof that a stalled output device can drain audio.
