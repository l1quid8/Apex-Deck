# Apex Natural Speech Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement task by task. Subagents require explicit authorization; this plan does not authorize delegation. Steps use checkboxes for tracking.

**Goal:** Make existing assistant and selected Claude/Codex Thread replies sound natural through expressive streamed speech, with reliable cancellation.

**Architecture:** The existing agent creates and commits the answer. Its host synthesizes that committed text; connection-local audio frames feed a client PCM player. Device recognition and device TTS remain available, and the personal worker's structured reply/task boundary is preserved.

**Tech Stack:** React/TypeScript, Electron 44, Rust/Tokio daemon, existing reqwest/base64/key-store dependencies, Web Audio/AudioWorklet, optional Capacitor audio-session coordination.

**Spec:** [Natural voice design](../specs/2026-10-10-apex-natural-voice-design.md).

Status: proposed implementation plan; all checkboxes are intentionally unchecked. Initial baseline `22058d74693ecd451b393395b079ea514bb0d021`; source and contracts reviewed against `486f5f7` on 2026-10-10. Read the spec and recheck source before execution. Do not include unrelated mockups/planning files in a commit.

## Global Constraints

- Use the existing Electron + Rust daemon architecture; add no Tauri dependency.
- Keep cloud voice off until explicitly selected; preserve device speech and typed input.
- Keep API credentials on the execution host; reuse `OPENAI_API_KEY` through the existing key store.
- Keep raw audio, credentials, SDP, and live transport handles out of saved sessions, replay buffers, exports, and logs.
- Keep audio events scoped to the initiating connection; do not broadcast or replay them.
- Preserve participant identity, Thread routing, reasoning/access/persona settings, approvals, and task receipts.
- Stop local output immediately on output mute, interruption, disconnect, unmount, or End call; discard late audio by generation. Microphone mute affects input independently.
- Ending a call does not cancel existing agent work; cancellation remains a separate task action.
- A cloud-provider error is visible; switching to device speech requires an explicit user choice.
- Verify audio on a packaged native build; mocks and builds do not establish naturalness.

## Review Focus

- Cancellation during key lookup, HTTP startup, queued playback, and remount must leave no late audio (Tasks 2–3).
- A paired phone or second window must not hear/control another call or read its key (Task 2).
- Odd network chunk boundaries and 44.1/48 kHz output must not alter pitch or corrupt speech (Task 3).
- Poll/resync/reconnect and unrelated notices must not repeat or accidentally speak messages (Task 4).
- Privacy changes, cloud errors, and phone audio interruptions must be visible and stop cloud speech (Tasks 2, 4–5).

## File and interface map

| File | Responsibility |
| --- | --- |
| `src/voice/types.ts`, `settings.ts` | Persistable preferences, target and source identity, typed events. |
| `src/voice/spokenText.ts` | Reference text-normalization contract and shared golden fixtures. |
| `src/voice/pcm.ts`, `pcm-worklet.js`, `player.ts` | PCM framing, bounded playback, meters, cancellation. |
| `src/voice/controller.ts`, `lease.ts`, `lanes.ts` | Call lifetime, one audio owner, personal/Thread correlation. |
| `src/VoiceSettings.tsx`, `src/VoiceCall.tsx` | Voice audition, call controls, disclosure, errors. |
| `crates/apex-host/src/voice/{mod,speech,text,policy}.rs` | Verified source loading, synthesis, normalization, policy/cost. |
| `crates/apex-daemon/src/voice.rs` | Connection-local audio queue, acknowledgment window, ownership. |
| `tests/fixtures/voice-text.json` | One shared TS/Rust normalization oracle. |
| Existing shell/backend/settings/command/authority files | Narrow integration; preserve existing pathways. |

Public TS contract, defined in Task 1:

```ts
export type VoiceScope =
  | { kind: 'personal'; assistantId: string }
  | { kind: 'thread'; roomId: string; participantId: string };
export type VoiceSettings = {
  mode: 'device' | 'natural'; voice: 'marin' | 'cedar';
  style: 'conversational' | 'calm'; backgroundNotices: boolean;
};
export type VoiceSource =
  | { kind: 'personal'; messageId: string; textHash: string }
  | { kind: 'thread'; messageSeq: number; textHash: string };
export type SpeechRequest = {
  callId: string; generation: number; requestId: string;
  scope: VoiceScope; source: VoiceSource; voice: 'marin' | 'cedar';
  style: 'conversational' | 'calm';
};
export type VoiceData = {
  callId: string; generation: number; requestId: string; chunkSeq: number;
} & (
  | { kind: 'pcm'; data: string; rate: 24000; channels: 1 }
  | { kind: 'done'; usage: { source: 'reported' | 'estimated' | 'unknown'; micros?: number } }
  | { kind: 'error'; code: string; message: string }
);
export type VoiceTurnReceipt =
  | { kind: 'personal'; requestId: string; eventId: string; duplicate: boolean }
  | { kind: 'thread'; requestId: string; userMessageSeq: number; duplicate: boolean };
export type VoiceCapabilities = {
  speech: { supported: boolean; ready: boolean; reason?: string };
  live: { supported: boolean; ready: boolean; reason?: string };
  voices: string[];
};
```

Commands: `voice_capabilities`, `voice_speech_start`, `voice_preview_start`, `voice_audio_ack`, `voice_speech_cancel`. Start answers acceptance, not playback completion. Preview uses a fixed server sentence and existing selected scope for policy checks. Each generation is monotonic for a connection's call; cancellation is idempotent. Source kind must match scope, and textHash must be the lowercase hexadecimal SHA-256 of the original UTF-8 message, verified by the host before normalization.

Wire arguments: start uses `{request: SpeechRequest}`; preview uses `{callId, generation, requestId, scope, voice, style}`; ack uses `{callId, generation, requestId, consumedChunkSeq}`; cancel uses `{callId, generation}`. Both start commands answer `{accepted: true, requestId}`. Capabilities takes `{scope}` and returns `VoiceCapabilities`, with `live.supported = false` until Release 2. Policy management uses `voice_policy_save({policy: VoiceBudgetPolicy})` and is local-administrator only. Rust wire structs use camelCase serde names. Error codes are `unavailable`, `unauthorized`, `policy_denied`, `missing_key`, `provider_denied`, `rate_limited`, `stale_source`, `canceled`, `invalid_audio`, and `stream_stalled`; sanitize messages before sending them to the client.

Cancel retires all jobs through the supplied generation and writes a connection-local generation tombstone before returning. A delayed start at or below that tombstone is rejected, including one whose key/HTTP lookup completes afterward. The client increments its generation synchronously, then cancels the previous generation. A request ID is unique within its call/generation; retries return the existing acceptance or terminal state, and cannot start another billed synthesis. Keep request records until the call/connection closes.

`voice_data` frames use `{type:'voice_data', payload:VoiceData}` and no replay sequence. Add `Backend.onVoiceData(cb): Promise<() => void>`; `DaemonClient` dispatches these separately from numbered host events. Advertise `voice_speech_v1`. `Backend.onPersonalChanged(cb)` exposes the already-existing durable personal change event. Unknown-capability hosts keep device speech available.

## Task 1: Preferences, speech contract, and text fidelity

**Files:** Create `src/voice/types.ts`, `src/voice/settings.ts`, `src/voice/spokenText.ts`, `tests/voice-settings.test.mjs`, `tests/voice-text.test.mjs`, `tests/fixtures/voice-text.json`. Modify `src/settings.ts`. Create `crates/apex-host/src/voice/text.rs`.

**Interfaces:** `readVoiceSettings(value: unknown): VoiceSettings`; `speechSegments(text: string): string[]`, each ≤700 characters, normalized but semantically faithful. Rust `segments(&str) -> Vec<String>` produces the same fixture results. Neither function mutates chat records. `AppSettings.voice` is optional when reading older files.

Host-only Thread policy is persisted as `VoiceBudgetPolicy { daily_limit_micros: Option<u64>, unknown_cost_ok: bool, allow_cloud: bool }` under the host's voice policy document. Defaults: no daily monetary cap, unknown cost disallowed, cloud disabled. Explicit voice setup records the cloud choice and whether unknown-priced calls are allowed; setting a monetary cap requires a dated rate or reported usage. The personal scope also applies the assistant's stricter existing budget/privacy/spending settings. No credentials belong in this policy document.

- [ ] Write fixture cases for paragraphs, code fences, link labels, negative numbers/decimals, emoji, acronyms, and long replies. Include exact expected output, not a generated mirror of the implementation.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { speechSegments } from '../src/voice/spokenText.ts';
test('paragraphs and negation survive speech preparation', () => {
  const spoken = speechSegments('Do not delete it.\n\nThe total is 42.5 GB.').join('\n\n');
  assert.equal(spoken, 'Do not delete it.\n\nThe total is 42.5 GB.');
});
```

- [ ] Run `node --experimental-strip-types --test tests/voice-text.test.mjs tests/voice-settings.test.mjs`; establish failure because new exports do not exist.
- [ ] Implement normalization and parsing. Defaults are device/Marin/conversational/notices off. Reject unsupported settings individually without dropping unrelated saved settings. Use punctuation and paragraph boundaries; one code pointer per fence. Rust tests consume the same JSON fixture with `include_str!`.
- [ ] Define the types above, Rust serde equivalents, and serialization fixtures. Add `voice` to settings persistence without changing the settings version solely for this optional field.
- [ ] Run the focused JS tests and `cargo test -p apex-host voice::text`. Verify fixtures independently rather than snapshotting implementation output.
- [ ] Commit only this task's files: `feat(voice): define natural speech settings and text contract`.

## Task 2: Host synthesis and private streaming transport

**Files:** Create `crates/apex-host/src/voice/mod.rs`, `speech.rs`, `policy.rs`, `tests.rs`; create `crates/apex-daemon/src/voice.rs`. Modify `crates/apex-host/src/{lib,host,command}.rs`, `crates/apex-daemon/src/{main,protocol,authority}.rs`, `src/backend.ts`, `src/commandBackend.ts`, `src/daemon/client.ts`. Extend `tests/daemon-client.test.mjs` and daemon protocol/authority tests.

**Interfaces:** Host `resolve_source(scope, source)` verifies source kind, ID/sequence, speaker, and content hash, then returns committed speakable text. `start_speech(owner, SpeechRequest, sink)` owns an abort handle. `owner` comes from authenticated connection state, never renderer arguments. `sink` emits the defined VoiceData; `cancel_speech(owner, call_id, generation)` aborts only that owner's jobs. Preview has fixed content. Connection state stores credits and cancellation handles; Host's replay Bus contains no audio.

Keep voice variants in the typed `Command` enum so exhaustive authority checks classify them. In `protocol.rs`, intercept these variants after authorization and before the ordinary `Host::call` runner, supplying a connection-generated owner ID and private sink to the voice service. The ordinary `Host::call` arms for owner-dependent voice commands return `unavailable` without a connection context. Do not add a renderer-controlled owner field or broadcast audio through `HostEvent`. Policy save additionally checks `Trust::Local`, since LAN-token connections bypass device-tier checks. Capabilities and every outgoing private frame recheck the authorized scope; revoke/tier narrowing aborts upstream work.

- [ ] Write Rust fake-HTTP tests for valid PCM, 401/403/429, timeout after acceptance, malformed content, canceled startup, blocked endpoint, changed privacy, missing source, mismatched scope, and a Thread sequence reused after rewind with a different hash. Test no request leaves the host before policy acceptance. Inject a provider endpoint in test construction only; production endpoint is fixed.
- [ ] Write daemon tests with two authenticated connections: owner receives chunks; the other receives none and cannot cancel/ack them; a reconnect sees no old chunks. Add an authority test for every new command, retaining `ApiKeySave = Never` remotely and personal Full/global checks.
- [ ] Run `cargo test -p apex-host voice` and `cargo test -p apex-daemon voice`; establish the missing-feature failures.
- [ ] Implement synthesis using existing host dependencies. The provider request is constructed from approved settings and host-loaded text:

```rust
let body = serde_json::json!({
    "model": "gpt-4o-mini-tts",
    "voice": request.voice,
    "input": segment,
    "instructions": style_instruction,
    "response_format": "pcm",
    "stream_format": "audio"
});
```

Here `request` is the defined SpeechRequest, `segment` is returned by `voice::text::segments`, and `style_instruction` is the fixed string selected by `style`. Use `apex_adapters::keys::lookup("OPENAI_API_KEY")` on a blocking host task. Post to `https://api.openai.com/v1/audio/speech`; validate the response before treating bytes as PCM. A final unmatched byte is `invalid_audio`. Never serialize the key or upstream response headers to a client. [Speech API guidance](https://developers.openai.com/api/docs/guides/text-to-speech)

- [ ] Stream body bytes through a bounded queue. Enforce raw chunk ≤32 KiB, outstanding raw audio ≤144,000 bytes, chunk sequence ordering, one synthesis per call, 10-second stalled-credit timeout, and immediate abort on owner disconnect. `voice_audio_ack` accepts only the owner's monotonic consumed sequence; it cannot grant credit for unsent bytes. Reserve a separate control path so `cancel` is not queued behind audio.
- [ ] Add connection-local VoiceData parsing and subscription without incrementing `lastSeq`, filling host replay, or setting a pending RPC result. Keep ≤64 KiB encoded frames. Add a fake-link test injecting a malformed frame and an ordinary control reply amid audio.
- [ ] Add reported/unknown cost records, the defined host VoiceBudgetPolicy for Thread scope, and the personal assistant's existing spending/privacy checks. Advertise policy/readiness through `voice_capabilities`; write policy through `voice_policy_save` on an administrator/local connection only, preserving remote key/policy-management restrictions. Return visible typed errors; do not guess costs or use CLI account tokens.
- [ ] Reserve a priced request's maximum estimated cost atomically against the daily cap before sending it; reconcile with reported/estimated final cost afterward. Test two simultaneous calls that individually fit but together exceed the remaining budget, and cancellation after request submission. Unknown-price approval must be explicit and cannot imply a guaranteed monetary cap. Do not retry an ambiguous billed request automatically.
- [ ] Run `cargo test -p apex-host voice`, `cargo test -p apex-daemon`, and `node --experimental-strip-types --test tests/daemon-client.test.mjs`. Commit `feat(voice): stream host-owned speech with scoped cancellation`.

## Task 3: PCM playback and call lifetime

**Files:** Create `src/voice/pcm.ts`, `pcm-worklet.js`, `player.ts`, `controller.ts`, `lease.ts`; create `tests/voice-pcm.test.mjs`, `voice-controller.test.mjs`, `voice-lease.test.mjs`. Modify `src/personalSpeech.ts` only to expose the existing device adapter and settle pending operations consistently.

**Interfaces:** `Pcm16Decoder.push(Uint8Array): Float32Array`, retaining one trailing byte; `reset(): void`. `PcmPlayer.enqueue(data, generation)`, `stop(generation)`, `queuedMs()`, `dispose()`; asynchronous startup may not revive a disposed player. Controller tracks input/output/work independently, owns the current generation and AudioLease, and exposes `stopSpeaking()`, `setOutputMuted(boolean)`, `end()`.

- [ ] Write the sample-boundary test plus 44.1/48 kHz timing tests, cancellation before AudioContext resume, late data after mute, End during startup, double-End, and competing preview/call lease tests. Include final audio shorter than the prebuffer and a network `done` event while audio remains queued: the short tail plays, and playback completion is reported only after audible drain or cancellation.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pcm16Decoder } from '../src/voice/pcm.ts';
test('PCM decoder retains an incomplete sample across HTTP chunks', () => {
  const decoder = new Pcm16Decoder();
  assert.equal(decoder.push(Uint8Array.of(0)).length, 0);
  assert.deepEqual([...decoder.push(Uint8Array.of(128, 255, 127))], [-1, 32767 / 32768]);
});
```

- [ ] Run `node --experimental-strip-types --test tests/voice-pcm.test.mjs tests/voice-controller.test.mjs tests/voice-lease.test.mjs`; establish missing-export failures.
- [ ] Implement playback in an AudioWorklet with input sample-rate conversion appropriate to the output context. Transport chunk boundaries are not audio frame boundaries. Accumulate 150–300 ms initially and maintain a ≤3-second ring buffer; flush a valid final tail even if it is shorter than the prebuffer. Load the bundled worklet with `new URL('./pcm-worklet.js', import.meta.url)`. Remove nodes/sources on dispose, resolve pending awaits, and retain an audible-progress clock separate from network completion.
- [ ] Start network cancellation and local stop concurrently. Increment generation before awaiting anything; discard every late frame from older calls/generations. Ack consumed frames only as playback frees credit; cancel frees the whole lease. Surface synthesis/decoder errors rather than reporting success.
- [ ] Verify the three focused suites. Add a browser audio fixture with a known-frequency PCM tone: duration/frequency remain correct at 44.1/48 kHz, queued buffer never exceeds the cap, and cancellation stops output rather than only future enqueueing.
- [ ] Commit `feat(voice): add bounded PCM playback and interruption-safe controller`.

## Task 4: Call UI, personal change events, and selected Thread replies

**Files:** Create `src/VoiceSettings.tsx`, `src/VoiceCall.tsx`, `src/voice/lanes.ts`, `src/voice/voice.css`; modify `src/{PersonalCall,SettingsPage,ApexAgentAll,ChatPane}.tsx`, `src/{personalAssistant,backend,commandBackend,types}.ts`, `crates/apex-host/src/{host,command,storage}.rs`, `crates/apex-core/src/{types,room}.rs`. Extend `tests/personal-call-component.test.mjs`; create `tests/voice-routing.test.mjs`, `voice-settings-component.test.mjs`, `personal-change-events.test.mjs`, and Rust tracked-post tests in the owning modules.

**Interfaces:** `VoiceLane.send(text: string, requestId: string): Promise<VoiceTurnReceipt>` exposes host/scope and committed source subscriptions. Personal lane exposes the existing `personal_send` receipt (`eventId`, `duplicate`) instead of discarding it in the hook, and matches `PersonalMessage.eventId`. Add `Backend.roomPostToTracked(id, text, targets, requestId): Promise<VoiceTurnReceipt>` mapping to `room_post_to` with optional `requestId`; preserve the old `roomPostTo` method and untracked command behavior. Thread messages gain Rust `source_request_id: Option<String>` with `#[serde(rename = "sourceRequestId", default, skip_serializing_if = "Option::is_none")]`, and optional TS `sourceRequestId`. Propagate it through the human post, batch, and committed participant replies. Incoming `message_added` supplies sequence/speaker/text; hash the original text. Device and Natural modes consume the same lane.

Host `room_post_to_request(id, text, targets, request_id)` returns the tracked receipt and reuses the existing routing/assistant-continue path. Persist request ID, scope, payload hash, post sequence, and acceptance state before scheduling work. Reusing an ID with another scope/text/target is rejected. Crash recovery reads back the committed post and execution records; an ambiguous dispatch remains uncertain rather than being reposted. Preserve the legacy `room_post_to` signature for existing callers.

- [ ] Write tests for committed reply spoken once, old history silent, unrelated helper/notice silent by default, changed host canceling speech, two agents replying, approval-pointer text, output mute without mic mute, offline errors, and unknown capabilities. Include an unrelated post from another window between this caller's post and reply; only the matching `eventId`/`sourceRequestId` and selected speaker may be spoken. Keep the existing PersonalCall injection tests working or replace them with equivalent lifecycle coverage.
- [ ] Test tracked-post retry across host restart, conflicting payload under the same request ID, and crashes before/after durable post/acceptance. Verify old saved messages still deserialize, untracked posts keep their existing return behavior, and assistant-managed Threads retain their continuation path.
- [ ] Write an event test: `personal-changed` causes an immediate refresh; repeated revision does not duplicate speech; 2.5-second polling remains a fallback. Assert committed personal JSON/task output is never submitted to TTS as partial bytes.
- [ ] Run the focused Node suites; establish failures for new UI/routing behavior.
- [ ] Add the Voice section and audition buttons. Persist selected mode/voice/style, show execution host and credential status, and provide user-selected device fallback after an API error. Preview is an explicit potentially billed action and shares the local audio lease.
- [ ] Replace call ownership with the new controller while preserving the personal task UI and existing ApexAgent layout. Use independent mic/output controls and End. Wire typed Backend change/audio subscriptions and cleanup. Update privacy copy for cloud TTS and device recognition.
- [ ] Implement the tracked Thread receipt and `sourceRequestId` propagation before enabling automatic speech for Thread replies. Filter by accepted request and chosen participant; a later bot-to-bot reply is silent unless explicitly requested. Use the shared call generation to retire superseded receipts.
- [ ] Add a small Call/Read reply control to a Thread using its selected participant; do not redesign the composer or change reply policy. Use committed source references and per-call baseline so model-to-model rounds are not automatically spoken. Distinguish participant identity from speech voice.
- [ ] Run focused suites and `npm run build`; commit `feat(voice): integrate natural speech into calls and selected threads`.

Personal receipt adapter in `lanes.ts`, with `backend`, `scope`, and `requestId` supplied by the lane/controller:

```ts
const accepted = await backend.call<{ eventId: string; duplicate: boolean }>('personal_send', {
  assistantId: scope.assistantId, requestId, text,
});
const receipt: VoiceTurnReceipt = {
  kind: 'personal', requestId, eventId: accepted.eventId, duplicate: accepted.duplicate,
};
```

The committed-reply filter compares the stored message's `eventId` to this receipt. Thread filtering compares `sourceRequestId` to the tracked request ID and `speaker` to the selected participant. Do not infer acceptance from “the next reply.”

## Task 5: Native quality gate, regression, and platform delivery

**Files:** Create `desktop/run-voice-smoke.mjs`, `docs/voice-verification.md`; update `electron-builder.yml`, `desktop/main.mjs` only where trusted UI media permissions are required, `README.md`, and `package.json` with a `desktop:smoke:voice` script. For phone delivery, create `iphone/App/App/VoiceAudioSessionPlugin.swift`, update `SpeechPlugin.swift` registration/audio release, and add a matching typed optional client adapter.

**Interfaces:** Native smoke takes explicit execution-host/scope/test-profile parameters and an isolated data directory. It uses fixed prompts and an acoustic fixture. `VoiceAudioSession` exposes `activate({duplex:boolean})`, `deactivate()`, and `interrupted`/`routeChanged` events; it never contains provider credentials. Human listening evidence is recorded separately from automated fixture evidence.

- [ ] Add tests that microphone permissions apply only to the trusted Apex UI, browser panes remain denied, output mute releases buffers, and interruption closes the audio session. Add macOS `NSMicrophoneUsageDescription` through package configuration. Do not add camera permission for voice.
- [ ] Run the focused tests, `npm test`, `cargo test --workspace`, `npm run build`, then `npm run desktop:package`. Record failures with their actual scope; do not claim live integration from these commands.
- [ ] Run the packaged app with a fixed six-reply comparison: device voice, Marin, Cedar. Listen through built-in speakers and a headset; record chosen voice, clarity, pauses, emotional range, and pronunciation. Use the same text for all voices to avoid confounding agent output.
- [ ] Test a real Claude Thread and a real Codex Thread: first ask it to remember a harmless nonce; then ask it to recall it. Confirm text identity, correct speaker, audible reply once, clean Stop speaking, and unchanged conversation history after End/reopen. Use isolated workspaces and no tool actions for these checks.
- [ ] Measure at least 20 speech starts on a recorded network and hardware setup: reply commit, request acceptance, first received sample, first audible sample, stop intent, last audible sample. Evaluate spec latency goals and report misses without hiding agent generation time.
- [ ] Exercise missing/invalid key, quota limit fixture, slow provider, host restart, reconnect, revoked device, End during startup, and privacy changes. Verify no stale speech or credential/audio values in logs, persisted sessions, or replay.
- [ ] If shipping phone support, rebuild/install on a physical iPhone. Test Apple recognition cleanup → Natural playback, speaker/Bluetooth/headset switching, incoming call/background interruptions, and typed fallback. Keep phone support labeled pending if that gate fails; desktop Release 1 may ship independently.
- [ ] Record exact packaged build ID/path, test output, real provider evidence, latency table, human listening choice, and remaining limitations in `docs/voice-verification.md`. Commit `test(voice): verify packaged natural speech and document results`.

Use these six fixed audition texts, in this order, in the smoke fixture and report:

```json
[
  "Want me to check that file before we continue?",
  "That sounds frustrating. We can take this one step at a time.",
  "Do not delete the folder. The total is 42.5 gigabytes, and the change is minus 3.2 percent.",
  "Claude and Codex use separate accounts. The API key belongs to the speech provider.",
  "The first check passed.\n\nNext, restart the app and confirm the conversation is still there.",
  "Here is the command.\n```sh\npwd\n```\nI've also saved the result in the chat."
]
```

The new smoke runner accepts `--host`, `--scope`, `--profile`, `--data-dir`, and `--mode` (`device`, `natural`, or later `live`). It fails if required values are missing and writes timing/status JSON without credentials/audio. Live-provider scenarios are explicitly labeled and never substituted with the tone/fake-provider fixture. Native listening results record the human's choice separately from machine timing.

## Release decision

Release 1 is ready only when the spec's Natural speech gates pass in the packaged app. Shipping TTS does not establish full-duplex conversation or streaming agent tokens. The next implementation handoff is [Release 2](2026-10-10-apex-live-voice.md).
