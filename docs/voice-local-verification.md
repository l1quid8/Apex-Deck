# Local agent voice verification

Implementation branch: `feat/voice-calls`; packaged validation fixes: `fix/voice-packaged-validation`. Unmerged, unpublished development work. Signed isolated test apps were built for validation; no release DMG or installed-app replacement was performed.

## Implemented

- Composer microphone immediately beside Send; one agent starts directly, multiple agents show a recipient picker.
- Continuous input only during explicitly initiated calls, mute and End; name/alias switching among open same-host threads and pane focus.
- Existing participant queues, thread history and daemon adapters. Correlated core tickets identify voice-owned events and cancellation; max_bot_hops=0 prevents follow-on agent dispatch. Typed chat and trusted approvals remain independent.
- Saved per-agent/thread voices and aliases, preview, adjustable silence threshold, concise speech segments, markdown/code exclusion and local acknowledgment.
- Browser microphone AEC constraints and worklet capture/playback, bounded tagged PCM frames, per-generation flush, consumption-based flow control. The presence of AEC in track settings is not acoustic proof.
- Managed optional CPython 3.11.17, pinned MLX Whisper 0.4.3, MLX Audio 0.6.1/Kokoro, Silero 6.2.3, and Smart Turn v3.2 CPU. Downloads total **2,406,693,430 bytes**; installer requires **7,220,080,290 free bytes** while staging. No system Python or terminal setup is used by the app.
- Loopback authentication/origin/one-owner checks; single desktop window lease, idle shutdown, suspend/app-quit handling, atomic installation and stale installation-lock recovery.
- Timing-only browser diagnostics (`[voice timing]`): queue-to-start, first agent text, first speech submission, playback start, helper STT wait and speech generation/send. Transcript/audio/token values are excluded. Helper generation/send time includes output backpressure; it is not a pure inference number.

## Verified in this run

Commands and raw results are kept locally under `.superpowers/sdd/2026-10-20-whisper-kokoro-agent-calls/` (ignored scratch, not model data).

- `npx tsc --noEmit`: passed.
- `npm test`: passed; final count in `npm-final.log`.
- `TMPDIR=/tmp cargo test -p apex-core -p apex-adapters -p apex-host -p apex-daemon`: passed. The daemon authority matrix includes both new commands and checks every tier/scope.
- Managed Python `-m unittest discover -s voice-sidecar/tests -v`: **10 passed**, including actual loopback WebSockets with fake engines, wrong origins/tokens, exclusive ownership and malformed input.
- `node --experimental-strip-types --test tests/e2e/voice.e2e.mjs`: passed against a real daemon, real shell CLI adapter and local HTTP mock implementing the OpenAI streaming protocol. Verified API thread history/guidance, correlated deltas, request idempotence, conflicting-ID rejection, request-specific cancellation and no group fanout. A mock API is not evidence of a paid external provider's credentials or availability.
- The managed installer downloaded and installed the standalone Python and all pinned wheels, verified imports, then activated immutable runtime versions. Version 2 preserved version 1. Previously downloaded demo model files were copied and hash-verified, leaving the running `/tmp/voice-test` demo untouched. Version 2 reused matching immutable files from version 1. This verifies model integrity/offline reuse, not a full fresh-machine model download.
- Installed private runtime produced actual 24 kHz PCM: **252 ms** to first chunk after **14.7 s** warmup in one smoke. A 9.05-second spoken piece completed with consumption credits; under concurrent load it took **1,346 ms** to first chunk and **25.1 s** warmup. Binary receipt is not physical audible playback.
- Desktop UI inspection verified mic placement, multi-agent recipient picker, active microphone state, saved voice selection, Smart Turn ready status, and real saved human messages with responses from the test thread agent. A live Luna/Codex call was also observed with its own saved voice. Those observed calls were user-driven; no claim is made that every acoustic condition or agent provider was independently exercised.

## Measurements

20 turns in the installed runtime using the demo's clean synthetic 3-second question and a fixed short spoken reply; concurrent local Qwen and another live call were present:

| Measurement | Result |
| --- | --- |
| STT + TTS compute p50 | 807 ms |
| STT + TTS compute p95 | 841 ms |
| Startup with engine warmup | 8,983 ms |
| Peak process RSS | 1,359,413,248 bytes |
| Smart Turn v3.2 analysis p50 / p95 | 39.1 / 49.1 ms (20 analyses) |
| Smart Turn complete probability on the finished test question | 0.945 |

These exclude endpoint waiting, agent thinking/queue, transport and actual device playback. RSS is not total unified/GPU memory. Clean synthesized speech does not establish noisy-room accuracy, natural-pause behavior or full-duplex AEC. The proposed <=1.8-second warm echo p50 threshold is not yet established from actual audible output.

## Review and fixes

A fresh reviewer found and reproduced deferred-dispatch cancellation races, repeated-barge-in stale dispatch, a five-second playback-credit deadlock, microphone-denial lease leakage, hidden scoped errors and stale install locks. Regression tests were run failing before fixes and passing afterward. UI testing additionally found a scope comparison that wrongly included display metadata; identity now compares stable host/room/participant fields. The daemon end-to-end test exposed missing snake_case field aliases, corrected before final verification. Long utterances now chunk without dispatching partial commands.

## Remaining release gates

- Signed packaged app: fresh microphone prompt and denial/retry, clean-Mac setup without developer tools, and final End/app-quit microphone/process release. See the packaged validation evidence below for the narrower microphone/audio checks that were completed.
- Controlled speaker/headphone AEC and self-transcription tests, coughing/background noise, real natural pauses, measured interruption flush <=150 ms, and at least 20 actual microphone turns with audible p50/p95 latency. Do not infer success from track constraints or generated WAVs.
- Real external OpenAI-compatible API credentials, remote-host call and multi-window owner smoke; deterministic tests alone do not establish these deployment paths.
- Redistribution review of all pinned binary wheels and linguistic assets, especially eSpeak/phonemizer GPL-family components.

## Deliberate limits

Assistant task-execution conversations retain their owner orchestration and reject voice posts; use a regular conversational agent thread. Correlation IDs are retained in a process-local bounded 4,096-entry table, rejecting new requests when full rather than allowing an old replay to execute; host restart loses this table. Lost posts are never automatically retried. Semantic model behavior was benchmarked and deterministic pause-deferral tested, but natural human pause quality is still an acoustic gate. This is development-ready work, not a release certification.

## Packaged validation follow-up, 2026-10-20

User-authorized packaged tests ran from `release`, on branch `fix/voice-packaged-validation`, with isolated daemon/profile data in `/tmp/apex-voice-packaged-validation`. The installed app and its live conversation were preserved. Test apps used bundle ID `dev.apexdeck.voicevalidation`; the final app's display name is **Apex Deck Voice Test**. The existing verified voice runtime/models were reused. This does not test a clean-machine installation.

### Observed evidence

- Developer ID signing and `codesign --verify --deep --strict` passed. The final package is `release/voice-validation-verified/mac-arm64/Apex Deck.app`. Its microphone usage description is present. Its signed test-only `LSEnvironment` selects the isolated profile when launched through Launch Services. None of these overrides were added to the production packaging configuration.
- Composer mic calls captured actual microphone speech in the signed test app. Two read-only shell fixtures (Atlas/Birch) were prepared to make routing observable; a real authenticated Codex CLI participant was also added. The real Codex participant received microphone turns, answered, and recalled the `lunar apricot` history marker from its earlier text turn. Shell fixtures are not real model providers; Codex is the external CLI path exercised here.
- macOS output was switched from M260VA HDMI to MacBook Pro Speakers, with the built-in MacBook microphone as input. A native AVAudioEngine tap recorded exactly 1,200,000 frames at 48 kHz over 25 seconds. The recording contains Kokoro's complete preview sentence and part of an agent reply. The app's saved human messages in that interval contain the person's words, rather than the audible preview sentence. This is one observed speaker/AEC case, not a controlled multi-volume or headphone certification.
- A trimmed recording containing only the generated preview is available at `release/kokoro-packaged-speaker-preview.wav`. Full local audio/transcripts, command logs and content hashes remain ignored under `.superpowers/sdd/voice-packaged-validation/`; do not commit them.
- An earlier FFmpeg AVFoundation recording had inconsistent sample timing and cannot support acoustic latency measurements. It was superseded by the native recorder, not counted as a passing measurement.
- One unexpected non-English transcript appeared during the uncontrolled room/synthetic-input test. Its source was not established; noisy-input and false-transcript behavior remain gates rather than a claimed pass.

### Reproduced failures and changes

1. **Punctuation after a routing name was rejected.** `Call Jigga. check the build` returned `unknown`. The parser now accepts punctuation/whitespace boundaries while rejecting partial-name matches such as `Jiggabot`. The regression failed before the change and passes afterward. A final acoustic spoken-switch retest remains pending.
2. **Normal quit orphaned the helper.** The original packaged app exited while its Python helper remained alive with parent PID 1. `finishQuit()` uses `app.exit()`, which bypasses `will-quit`; it now explicitly awaits voice shutdown before exiting. A test executes the production quit function with resource stubs and verifies shutdown before exit; the original function fails that assertion. The final packaged UI quit/process retest remains pending. Orphaned test helpers were explicitly terminated; this cleanup is not evidence that normal quit is fixed acoustically/end to end.
3. **The call panel could extend above the window in split layouts.** The screenshot reproduced this in a top-right pane. It now portals to the body and uses the existing viewport-clamped popover positioning, with resize/scroll tracking and bounded scrolling. TypeScript/build pass; the final packaged visual retest remains pending.

### Verification and blockers

- TypeScript passed. Full JavaScript suite passed **1,795 tests** after the parser/panel/quit implementation changes; the subsequently added direct-exit regression and existing quit cases passed **6/6** separately. No Rust or Python implementation changed in this follow-up.
- The final signed archive's main entry, 142 UI assets and sidecar sources were compared with the checkout/build outputs and matched (`package-content.json`).
- A permission reset was limited to the test bundle ID. Initial direct-executable launches may inherit their launcher’s macOS responsibility context, so successful microphone capture does **not** establish the fresh app-specific permission flow. The later Launch Services call remained in `warming`; no fresh OS prompt/denial was independently observed.
- Computer Use refused access to `com.apple.UserNotificationCenter` “for safety reasons.” A manual denial was requested, but no response was received in this run. Desktop automation subsequently failed repeatedly with `Sky Computer Use native pipe startup failed`, including after a kernel reset. It could not complete denial/retry, final package layout/quit checks, or restore the original HDMI output.
- The running test app/helper were terminated explicitly after automation disconnected, to avoid leaving a test microphone session open. The installed app was left running. **Audio output remains on MacBook Pro Speakers; the original output was M260VA.**
- Still unverified: fresh permission denial/recovery; final packaged routing/layout/quit fixes; controlled headphone/multiple speaker-volume and background-noise cases; <=150 ms physical interruption flush; and 20 controlled microphone turns with audible p50/p95 latency. No latency percentile is claimed from this run.
