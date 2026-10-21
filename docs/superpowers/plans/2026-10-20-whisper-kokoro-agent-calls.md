# Whisper + Kokoro Agent Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the design first; no product implementation has started.

**Goal:** Call any conversational Deck agent from the mic beside Send, using its existing thread, tools and a saved per-agent local voice.

**Architecture:** Deck captures and plays audio; an optional local Python helper runs Silero, Whisper and Kokoro. Transcripts go through Deck's normal participant queue and daemon adapters, with explicit recipient and request correlation. Electron owns helper installation/lifetime on the client Mac; the helper never executes agents.

**Tech Stack:** React/TypeScript, Electron, existing Rust host/core/adapters, Python asyncio/WebSockets, MLX Whisper large-v3-turbo, MLX Kokoro, Silero, evaluated local Smart Turn.

**Spec:** `docs/superpowers/specs/2026-10-20-local-agent-voice-design.md`

## Global constraints

- Default OFF. Listening is continuous only between explicit Start and End; no push-to-talk, background wake word, or terminal setup.
- macOS Apple Silicon first; any existing conversational agent provider, one recipient at a time. Speech runs on the client even for remote agents.
- Models: `mlx-community/whisper-large-v3-turbo`, `mlx-community/Kokoro-82M-bf16`; pin revisions and dependencies from the tested environment.
- First-use setup includes download size/progress/cancel/retry. No model weights in Git or the DMG; no reliance on system Python or `/tmp` for shipped operation.
- Input 16 kHz mono PCM16, 512-sample frames; output 24 kHz mono PCM16. Start with 700 ms endpoint silence, adjustable 300–2000 ms; 640 ms preroll; 22-word maximum speech pieces.
- Browser AEC must be acoustically verified; STT gating is a degraded fallback, not full-duplex echo cancellation.
- Aliases resolve stable host/thread/participant identities; only leading `call <name>` switches. `stop listening` ends the call. Never infer approvals from speech.
- Single active desktop call; helper idle shutdown after 120 seconds; app quit kills helper. No automatic microphone restart after failure/sleep/reload.
- Keep the human's running `/tmp/voice-test` demo intact. Preserve unrelated checkout files. Use a new implementation branch after plan approval.
- Only start development here with `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`; reuse an existing dev window.
- Production DMG builds start only from `/Users/tylercaldwell/Downloads/apex-deck/release`. Require `npx tsc --noEmit` before merge; delete task branch after an authorized merge.

## Review focus

- Late synthesis/room events after interruption, recipient switch or disconnect must never speak or dispatch twice (Tasks 2, 4, 5).
- Concurrent typed messages from another window/client must never be mistaken for the voice agent's reply (Task 4).
- Speaker echo, coughs and resumed speech must not create autonomous agent turns (Tasks 2, 3, 7).
- Same-name agents, renamed profiles and remote-host identity changes must not reroute speech silently (Tasks 1, 5).
- Missing runtime, denied microphone or canceled downloads must leave text chat and saved state usable (Tasks 3, 6, 7).

## Existing integration map

| Existing file | Verified responsibility / integration |
| --- | --- |
| `src/ChatPane.tsx` | `send()` around 2372, `dispatch.current` around 1492, `ParticipantQueues` around 1506; composer Send around 3720; room subscription and approval rendering. Extract reusable submission behavior instead of driving the text field. |
| `src/turnQueue.ts` | `ParticipantQueues.send`, per-recipient scheduling, steer and stop. Add explicit-target voice submissions without changing text target resolution. |
| `src/App.tsx` | Host-specific backend selection and `focusPane` around 2122; mount a single call coordinator above panes. |
| `src/backend.ts`, `src/commandBackend.ts` | `roomPostTo`, `roomStop`, `onRoomEvent`; preserve existing daemon route. |
| `src/types.ts`, `src/settings.ts`, `src/SettingsPage.tsx` | Participant identity, room events, settings parsing/defaults and UI. |
| `crates/apex-host/src/command.rs`, `host.rs`, `events.rs` | Room commands, dispatch/event envelope and recovery. Add optional turn correlation. |
| `crates/apex-core/src/concurrent.rs`, `room.rs` | Turn tickets and progress events; propagate origin through actual execution, not a mutable per-agent global. |
| `desktop/main.mjs`, `desktop/preload.cjs`, `scripts/package-mac.mjs` | Trusted desktop IPC, local helper owner, microphone permission, runtime resources/signing. Use the existing trusted sender validation in `handle()`; previews have no Deck preload. |
| `src/PersonalCall.tsx`, `src/personalSpeech.ts` | Separate personal assistant/system speech. Leave independent. |

Proposed files: `src/voice/{types,settings,routing,controller,threadBridge,speechText,audio,localClient}.ts`, `src/voice/VoiceCallControls.tsx`, `src/voice/capture-worklet.js`, `src/voice/playback-worklet.js`, `desktop/voiceRuntime.mjs`, `voice-sidecar/pyproject.toml`, `voice-sidecar/requirements.lock`, `voice-sidecar/voice_sidecar/{protocol,server,pipeline,endpoint,stt,tts}.py`, `voice-sidecar/tests/`, `docs/voice-local-verification.md`. Keep model data in the local Deck data directory, not these folders.

## Contracts to establish in Task 1

```ts
type CallScope = { hostId: string; roomId: string; participantId: string };
type VoiceTurn = { callId: string; generation: number; utteranceId: string;
  requestId: string; scope: CallScope; text: string };
type VoicePreferences = { voice: string; aliases: string[] };
```

`createVoiceController(deps)` exposes `start(scope)`, `mute(boolean)`, `switchAgent(scope)`, `end()` and subscribable state. States: off/setup/warming/listening/hearing/waiting/speaking/needs-attention/error. Capture, playback and work status are separate fields; speaking does not imply the microphone is closed.

`ThreadVoiceBridge.submit(turn: VoiceTurn): Promise<{requestId: string}>`, `cancel(requestId): Promise<void>`, `subscribe(listener): Unlisten`. Bridge events carry requestId/scope plus started, text delta, approval, question, done, failed or canceled. Acceptance does not mean agent completion.

Helper protocol v1: trusted IPC obtains `{port, token, protocolVersion}`; authenticate the loopback WebSocket before audio. Client controls: start(callId, generation, voice, silenceMs, nameHints), speak(requestId, segmentId, text), cancel(generation), playbackComplete(segmentId), end. Server events: ready(voices), speechStart, partial, transcript(utteranceId, text), audioStart(segmentId, sampleRate), audioEnd, state, timing, error. Every event includes callId/generation and every speech segment its requestId. Binary audio header contains protocol version, generation, stream/segment sequence; no unlabeled binary blocks. Limit control frames to 64 KiB, input to one second of backlog and output to five seconds; overflow ends the call visibly rather than accumulating latency. Partial transcripts are display-only. Do not send agent IDs to the helper as authority.

## Task 1: Contracts, settings and name resolution

**Files:** Create `src/voice/types.ts`, `settings.ts`, `routing.ts`; modify `src/settings.ts`; create `tests/voice-routing.test.mjs`, `tests/voice-settings.test.mjs`.

**Interfaces:** Produces the contracts above, `resolveCallCommand(text, candidates)` returning ordinary text / unique switch with remaining text / ambiguity / end, and `voicePreferenceKey(hostId, profileId, roomId?, participantId?)`.

- [ ] Write failing tests: default disabled; old settings load; distinct preferences for same name on two hosts; rename preserves voice; a profile default has a thread override; aliases collide visibly; `call Jigga check the build` switches and returns the remainder; `I'll call Null later` stays ordinary; exact `stop listening` ends. Bound aliases to 16 entries of 64 characters and validate voice against the runtime catalog.
- [ ] Run `node --experimental-strip-types --test tests/voice-routing.test.mjs tests/voice-settings.test.mjs`; confirm new behavior fails before implementation.
- [ ] Implement contracts/parsers and deterministic resolution. Candidate list contains available conversational participants in open threads on the active host; do not create threads or switch hosts implicitly. Multiple matches require visible choice.
- [ ] Re-run those tests; require pass. Commit only the task files as `feat: define local voice settings and routing`.

## Task 2: Extract the local pipeline with cancellation and endpointing

**Files:** Create `voice-sidecar/` files listed above, `voice-sidecar/README.md` and tests for protocol, endpointing and synthesis. Read/copy only relevant demo behavior; remove its Qwen HTTP adapter and web UI.

**Interfaces:** Produces `python -m voice_sidecar.server --port 0 --token-fd <fd>` and protocol v1. `EndpointDetector.push(pcm, now_ms)` yields speechStart/partial-ready/turn-complete; `STT.transcribe(audio, hints)` returns text; `TTS.generate(text, voice)` yields PCM chunks. Every result retains generation.

- [ ] Snapshot installed distribution versions and immutable model revisions from `/tmp/voice-test` without modifying it; resolve a reproducible dependency lock and notices. Confirm local Smart Turn's runtime/license and disk footprint. Use its analyzer only, not a second transport stack. Document its selected version and measured added endpoint latency. If unsupported, retain the explicit silence control and mark semantic endpointing blocked rather than claiming it exists.
- [ ] Write failing Python tests with fake engines: auth/origin rejection; oversized/malformed frames; one owner; continuous input; quiet/noise rejected; natural pause resumes without duplicate turn; semantic incomplete turn deferred; long speech chunks merge once; stale STT/TTS discarded; bounded queues; disconnect during synthesis; cancellation followed by a new generation cannot leak old audio. No real models in unit tests.
- [ ] Run `voice-sidecar/.venv/bin/python -m pytest voice-sidecar/tests -q`; confirm expected failures.
- [ ] Implement small asyncio pipeline with one MLX executor, bounded sentence synthesis and explicit endpoint policy. Treat `Future.cancel()` as result invalidation; active native inference can finish but cannot publish stale data. Reuse the measured MLX cache cap; measure residency with both models rather than summing model file sizes. Avoid an ever-growing audio buffer and remove the demo's hardcoded transcript suppression list.
- [ ] Re-run tests and a real-model echo smoke on an alternate port. Record real mic latency/memory, including semantic endpointing overhead. Commit as `feat: add isolated local speech pipeline`.

## Task 3: Client audio, playback and interruption

**Files:** Create `src/voice/audio.ts`, `localClient.ts`, capture/playback worklets and audio tests; modify trusted Deck microphone handling in `desktop/main.mjs` and packaging entitlements as needed.

**Interfaces:** `openVoiceAudio(onFrame, onSpeech): Promise<VoiceAudio>` returns capture/playback/flush/close handles. `connectLocalVoice(runtime, handlers)` implements authenticated v1 frames. `flush(generation)` drops all queued audio and reports actual playback drain separately from audio receipt.

- [ ] Write tests for resampling actual 44.1/48 kHz capture to 16 kHz; 512-sample framing; bounded playback at 24 kHz; no callback after close; missing AudioWorklet/permission; mute blocks frames; generation flush; playbackComplete only after drain. Use real browser integration for APIs that Node mocks cannot establish.
- [ ] Run the focused tests; confirm failure, then implement capture with echoCancellation/noiseSuppression/autoGainControl and playback in the same audio graph. Limit permission to the trusted Deck UI; never grant microphone access to previews/generated cards merely to enable calls.
- [ ] Make speech onset flush playback immediately, before STT completes. Preserve preroll through interruption. Distinguish AEC capability from effective acoustic results; expose degraded gated-input mode if needed.
- [ ] Run focused tests and record speaker/headphone acoustic trials: no self-transcribed replies across 20 turns; start speaking mid-reply and verify first words survive. If normal speaker mode fails, stop rollout here and implement/test macOS voice-processing I/O rather than advertise full duplex.
- [ ] Commit as `feat: add continuous call audio and barge-in`.

## Task 4: Correlated normal thread dispatch

**Files:** Modify `src/turnQueue.ts`, `ChatPane.tsx`, `backend.ts`, `commandBackend.ts`, `types.ts`; host `command.rs`, `host.rs`, `events.rs`; core `concurrent.rs`/`room.rs`; daemon client event decoding; create `src/voice/threadBridge.ts`, focused queue/wire/host tests.

**Interfaces:** Produces `ThreadVoiceBridge`. Extend queue acceptance with explicit recipients and optional request metadata, leaving existing `send(text, kind)` callers valid. Add optional `client_turn_id` and `max_bot_hops` to `room_post_to`, and propagate the ID on the corresponding turn's events through host and client decoding. Add `room_stop_request {id, participant, client_turn_id}`: the host atomically stops only a still-active matching request and returns stopped/already-ended/mismatch; never implement voice cancellation as an unchecked `roomStop(participant)`. Add capability `voice_turn_correlation_v1`; disable voice dispatch on hosts without it, while text still works.

- [ ] Write failing tests: one transcript posts once to `[participantId]`; selected agent receives existing history/tools/access; group policy does not fan out voice turns; normal typed send is unchanged; other-client same-agent replies have another/no ID and are not spoken; replayed events do not repeat speech; request-specific cancellation refuses a newly started unrelated turn even if the participant is the same; max_bot_hops=0 prevents follow-on bots; connection loss after post is uncertain and never auto-retried.
- [ ] Run `node --experimental-strip-types --test tests/turn-queue.test.mjs tests/voice-thread-bridge.test.mjs` and targeted core/host wire tests; establish failures.
- [ ] Extract shared prompt-submit validation/mod hooks from composer submission for voice reuse, preserving the user's unsent draft/attachments/TL;DR choice. Voice submits plain transcripts, bypasses slash/mod-command execution, uses explicit targets and zero automatic bot-to-bot hops; do not concatenate spoken names into hidden @mentions. Add ephemeral call guidance for concise speakable opening/completion text through existing adapter context; leave personas unchanged.
- [ ] Apply max_bot_hops=0 to the initial post batch itself (the current post command lacks this option); do not implement it as a second roomTurn. Carry origin metadata on actual core turn tickets and their progress closures, through buffering and recovery; do not infer origin from the last message or a global participant map. Bound duplicate request handling to the call lifetime, reject mismatched reuse, and preserve canceled terminal state. Map existing approval/question events into the correlated bridge; approval still requires `roomDecide`/`roomAnswer` from existing trusted UI.
- [ ] Re-run focused tests, `TMPDIR=/tmp cargo test -p apex-core -p apex-adapters -p apex-host`, and `npx tsc --noEmit`; require pass. Commit as `feat: route voice turns through correlated agent threads`.

## Task 5: Call controller, composer mic, agent voices and pane focus

**Files:** Create `controller.ts`, `speechText.ts`, `VoiceCallControls.tsx`; modify `App.tsx`, `ChatPane.tsx`, `SettingsPage.tsx` and existing styles; add controller, speech-text and component tests.

**Interfaces:** Consumes bridge/audio/runtime and produces controller interface from Task 1. `speakableSegments(delta, final)` incrementally emits plain-prose pieces up to 22 words while retaining parse state across deltas. `App` registers live pane bridges by host/room; controller stores scope independently of visual focus.

- [ ] Write failing tests for first-use mic/setup; one-bot immediate call; multi-bot recipient picker; empty thread; stable per-agent voice and preview; call-name switch invalidates old speech and focuses the right pane; tab changes don't silently reroute; closing active pane ends; ambiguous aliases don't dispatch; stop phrase; muted input; sleep; approval waits; stale completion cannot leave error state; two windows cannot both capture.
- [ ] Write speech tests splitting markdown fences/inline code across deltas, code-only replies, long unpunctuated text, numeric lists, already-spoken final text and failed replies. Speak no tool arguments/code and emit the fallback once for code-only output.
- [ ] Run focused `tests/voice-*.test.mjs`; establish failures. Implement singleton coordinator and mic immediately beside Send, with visible recipient/input state, mute and End. Keep a setup entry available before runtime exists. Add voice selection and audition keyed as Task 1 defines.
- [ ] Implement onset flush → correlated stop → terminal/cleanup wait → replacement dispatch; safe agent switching and explicit ambiguous-name UI. Speak `On it` once after 800 ms only while waiting for first agent speech, never as a saved agent response. Announce approval/question once and focus existing cards without making decisions. End invalidates audio and queued turns immediately even if work cancellation takes longer.
- [ ] Re-run focused tests and a mock-thread UI smoke; commit as `feat: call thread agents from the composer mic`.

## Task 6: Managed installation and packaged lifecycle

**Files:** Create `desktop/voiceRuntime.mjs`, runtime manifest/install script under `scripts/`, runtime tests; modify `desktop/main.mjs`, actual preload, `scripts/package-mac.mjs`, and voice setup UI.

**Interfaces:** Trusted preload methods `voiceStatus()`, `voiceInstall()`, `voiceCancelInstall()`, `voiceStart()`, `voiceStop()` and progress subscription. Electron main validates sender and owns installation/process/global capture lease; agent host backends never run these commands remotely.

- [ ] Write failing tests: absent/system Python; canceled/partial download; wrong hash/arch; insufficient disk; two install callers; helper timeout/crash; port collision; owner window close; idle 120-second exit; app quit; failed setup leaves text chat available. Lock runtime directory; stage and atomically activate versioned installs, preserving previous valid install until success.
- [ ] Run runtime tests with fake download/process adapters; establish failures. Implement manifest-pinned downloadable standalone Python plus pre-resolved dependencies/model revisions, hash verification, bounded retries and a health/version handshake. Inventory runtime, wheels, linguistic assets and model redistribution licenses; disclose actual download/disk sizes from manifests. No `pip install latest`, system mutation or privileged helper.
- [ ] Add least-privilege IPC and per-run socket token/owner enforcement. Keep credentials out of logs. Install helper source as a signed app resource, writable dependencies/models in local Deck data. Verify microphone usage description and signing entitlements on the built artifact.
- [ ] Re-run tests and installation on a clean user environment without developer Python. Measure warmup/progress/offline reuse; commit as `feat: manage local voice setup and helper lifecycle`.

## Task 7: End-to-end verification and release evidence

**Files:** Create `docs/voice-local-verification.md`, sidecar setup/troubleshooting README; add meaningful end-to-end checks where the existing harness supports them.

- [ ] Record per-stage monotonic timing with call/request IDs but no transcript/audio by default. Use actual renderer playback start for first-sound latency; helper synthesis completion is not audible output. Report p50/p95, memory active/peak, startup, CPU load and sample count over at least 20 turns.
- [ ] Run `npx tsc --noEmit`, `npm test`, `TMPDIR=/tmp cargo test -p apex-core -p apex-adapters -p apex-host`, and Python tests. Require zero failures; inspect Git diff/status and preserve unrelated files.
- [ ] Test through the existing desktop dev window: one CLI agent, one OpenAI-compatible API agent and one remote-host agent; same thread history, tools/approval, no cross-agent speech, saved voices after rename/restart, spoken agent switch, pause/resume, speaker echo, headphones, mute/end, crash/disconnect and no duplicate sends. Check ordinary typed messages during calls and across windows.
- [ ] With release authorization, build only from the required release directory using the repository's packaging procedure; do not start a production build at the root or a worktree. On the signed packaged artifact, test a fresh microphone permission prompt, denial/retry, audible physical playback, clean runtime installation, offline speech reuse and End/app quit releasing microphone/processes. A WAV file or permission checkbox does not establish these outcomes.
- [ ] Record proposed thresholds: warm echo p50 ≤1.8 seconds at 700 ms silence; playback flush ≤150 ms after confirmed speech onset. Report agent thinking/queue separately and expose p95; do not promise an end-to-end API answer under one second. Fail the release gate for self-transcription, unintended routing, duplicate dispatch or stale speech. If semantic endpointing or speaker AEC is blocked, report that explicitly before shipping.
- [ ] Commit evidence and docs as `test: verify packaged local agent voice calls`. Merge/push/DMG distribution only when authorized; rerun TypeScript before merge, then delete the merged task branch.

## Upstream references checked during planning

- MLX Whisper interface: https://github.com/ml-explore/mlx-examples/blob/main/whisper/mlx_whisper/transcribe.py — window-based transcription; continuous mic capture requires our own endpoint/chunk assembly.
- MLX Audio streaming guide: https://github.com/Blaizzy/mlx-audio/blob/main/docs/guides/streaming.md — audio generation streaming exists; test the exact pinned Kokoro implementation instead of assuming every model behaves identically.
- Pipecat transports: https://github.com/pipecat-ai/docs/blob/main/pipecat/learn/transports.mdx — custom WebSocket transport is supported; local pipeline choice above is about integration scope.
- Pipecat Smart Turn: https://github.com/pipecat-ai/docs/blob/main/api-reference/server/utilities/turn-detection/smart-turn-overview.mdx — local analyzer exists; packaging, latency and pause behavior still require this Mac's tests.

## Handoff and checkpoints

Review this design/plan before implementation. Implement Tasks 1–3 and the runtime groundwork for Task 6 first, then verify the local audio/endpointing gate; do not wire real agent actions into an acoustically broken pipeline. Tasks 4–5 bind it to agents; finish Task 6 and packaged Task 7 before claiming the feature works. There is no requirement to identify or reuse Claude's private speech backend. Cloud speech providers may later implement the same controller/audio/bridge boundaries without duplicating agent adapters.
