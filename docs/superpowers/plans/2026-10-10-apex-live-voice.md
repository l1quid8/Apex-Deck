# Apex Live Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement task by task. Subagents require explicit authorization; this plan does not authorize delegation. Steps use checkboxes for tracking.

**Goal:** Add natural hands-free conversation that continues while Apex's Claude/Codex agents work.

**Architecture:** GPT-Live carries the spoken conversation over client WebRTC; the authenticated Rust host creates the session, attaches a sideband, and owns client delegation into Apex. Durable conversations/tasks and voice transport have separate lifetimes. Release 1's exact-read speech stays available.

**Tech Stack:** Electron/React, Rust reqwest/Tokio/tungstenite, WebRTC media/data channel, existing host storage, authority, agent adapters, and mobile audio-session adapter.

**Spec:** [Natural voice design](../specs/2026-10-10-apex-natural-voice-design.md). **Dependency:** [Release 1](2026-10-10-apex-natural-speech.md) provides call UI/controller, audio lease, settings, key/policy boundary, and connection-local events. No separate Realtime adapter is required.

Status: proposed implementation plan; no tasks completed. Source/protocol review completed 2026-10-10 against `486f5f7`. Revalidate official Live schemas during execution; do not mix Responses delegation, client delegation, or legacy Realtime events.

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

- A delegation event contains metadata, not the spoken task; partial/late transcript or a correction must not dispatch guessed work (Task 3).
- Browser and sideband may observe the same request; only the host may execute it (Tasks 1, 3).
- Barge-in and End may overlap an approved task; audio control must preserve work (Tasks 2–4).
- A dropped transport or host restart must not duplicate a Thread post, side effect, or old audio (Tasks 3–4).
- Changing privacy, permissions, output route, or phone background state must close capture without automatic restart (Tasks 2, 4–5).

## File and interface map

| File | Responsibility |
| --- | --- |
| `src/voice/liveTypes.ts`, `liveClient.ts` | Typed Live setup/events; primary WebRTC lifetime. |
| `src/voice/liveController.ts` | Independent capture/output/work state; mode coordination. |
| `crates/apex-host/src/voice/live.rs`, `sideband.rs` | Provider session startup/closure, server control. |
| `crates/apex-host/src/voice/transcript.rs` | Timed fragments, immutable context snapshots, deduplication. |
| `crates/apex-host/src/voice/delegation.rs`, `ledger.rs` | Durable dispatch decisions, correlation, recovery. |
| `crates/apex-host/src/voice/usage.rs` | Cumulative duration, budget, closure confidence. |
| Existing personal/room storage and command modules | Backward-compatible request/result linkage. |
| `docs/voice-verification.md` | Native acoustic/provider/cancellation evidence for both releases. |

Define these contracts in Task 1; keep runtime/opaque handles out of AppSettings:

```ts
export type LiveStart = {
  callId: string; generation: number; scope: VoiceScope;
  offerSdp: string; voice: 'marin' | 'cedar';
};
export type LiveStarted = { sessionId: string; answerSdp: string };
export type LiveControl =
  | { action: 'muteInput'; muted: boolean }
  | { action: 'stopSpeaking' }
  | { action: 'resumeSpeaking' }
  | { action: 'end' };
export type LiveUiState = {
  connection: 'starting' | 'connected' | 'closing' | 'closed' | 'error';
  microphone: 'off' | 'listening' | 'muted';
  output: 'silent' | 'playing' | 'muted' | 'suppressed';
  work: 'idle' | 'pending' | 'running' | 'needsYou';
};
export type VoiceLiveData = {
  callId: string; generation: number; sessionId: string;
} & (
  | { kind: 'state'; connection: LiveUiState['connection'];
      inputMute: 'pending' | 'muted' | 'unmuted' }
  | { kind: 'transcript'; eventId: string; speaker: 'human' | 'voice'; delta: string;
      startMs: number; endMs: number }
  | { kind: 'work'; requestId: string; receipt?: VoiceTurnReceipt;
      state: 'pending' | 'running' | 'needsYou' | 'completed' | 'uncertain' }
  | { kind: 'usage'; seconds: number; finalization: 'pending' | 'confirmed' | 'unconfirmed' }
  | { kind: 'error'; code: string; message: string }
);
```

`VoiceScope` comes from Release 1. Commands: `voice_live_start`, `voice_live_control`, `voice_live_status`. They require authorized scope plus connection ownership. Add `voice_live_v1` to capabilities only when supported by the host build; readiness additionally requires key, provider access, and privacy permission. `voice_capabilities` returns build support, current readiness/reason, and supported voice names without credentials.

Extend `VoiceSettings.mode` and its parser to accept `live` while retaining `device` as the default. Natural speech and Live each validate the chosen voice against capabilities; unsupported values show a configuration error. Live initially defaults to Marin, with Cedar available for audition. A running Live session's voice is immutable; changes apply to the next call, with that behavior stated in settings.

Wire arguments: start uses `{request: LiveStart}`; control uses `{callId, generation, control: LiveControl}`; status uses `{callId}`. Start returns `LiveStarted`; control returns `{accepted: true}`, which confirms host acceptance only, while state events report provider acknowledgments. Add `Backend.onVoiceLiveData(cb): Promise<() => void>` for connection-local `{type:'voice_live_data', payload:VoiceLiveData}` frames. Route them through DaemonClient/Transport separately from replay events, as with Release 1 PCM. These frames carry no SDP, credentials, reflected audio, or raw tool results. One bounded control queue holds at most 256 frames/512 KiB; overflow closes the call visibly. Only client media observations establish capture/playback states; host frames establish connection, input-mute acknowledgment, and agent work. Deduplicate transcript IDs before rendering either path.

## Task 1: Documented Live session creation and owned sideband

**Files:** Create `src/voice/liveTypes.ts`; create `crates/apex-host/src/voice/live.rs`, `sideband.rs`. Modify voice registry/policy, `src/{backend,commandBackend}.ts`, `src/daemon/client.ts`, and command/authority/protocol files from Release 1. Add `tests/voice-live-contract.test.mjs`, extend `tests/daemon-client.test.mjs`, and add Rust fake-provider session tests.

**Interfaces:** `start_live(owner, LiveStart) -> LiveStarted`; `control_live(owner, call_id, generation, LiveControl)`; `live_status(owner, call_id)` returns scope-safe readiness/state. Sideband startup buffers early control events until the session mapping is registered. Session IDs remain opaque.

- [ ] Add fake-provider tests for 201 JSON session/SDP answer, missing key, denied model, invalid SDP/oversize offer, sideband failure after creation, End before start completes, and startup timeout. A fake created session must be closed when the caller disappears before its answer arrives.
- [ ] Add ownership/authority tests: another window/device cannot attach, inspect, steer, or close a session. Neither renderer nor logs receive the API key. Unknown-capability hosts display an update-required state.
- [ ] Run `cargo test -p apex-host voice::live` and `cargo test -p apex-daemon voice`; confirm missing-feature failures.
- [ ] Create the provider request from fixed server policy. `start` is the defined LiveStart and `conversation_prompt` is an Apex-specific short prompt:

```rust
let body = serde_json::json!({
  "session": {
    "model": "gpt-live-1",
    "instructions": conversation_prompt,
    "store": false,
    "audio": { "output": { "voice": start.voice } },
    "delegation": { "type": "client" }
  },
  "transport": { "type": "webrtc", "sdp": start.offer_sdp }
});
```

Use `POST https://api.openai.com/v1/live/sessions`; HTTP 201 JSON has `session.id` and `transport.sdp`. Attach with `wss://api.openai.com/v1/live/sessions/{session_id}/attach`, preserving the returned ID unchanged. Both use host Bearer authentication. Omit explicit PCM format for WebRTC. Revalidate these headers and schemas from the linked reference before execution.

- [ ] Use reqwest/tungstenite already in the host; supervise sideband receive/send separately. API credentials stay in server headers. Assign a single server owner for delegation and context updates, forward sanitized state to the client, and discard reflected raw audio instead of saving it.
- [ ] Add the defined private Live event route and subscription. Test that frames do not advance replay sequence or reach another connection; malformed events and queue overflow close the call while ordinary RPC replies remain responsive. Attach the sideband and install its bounded receiver before returning the SDP answer, so the browser cannot start media before the host is ready to observe it. If that attach-before-media sequence is rejected by the provider, fail the live readiness probe and revise startup explicitly; do not assume historical event replay.
- [ ] Run focused suites and commit `feat(voice): create owned GPT-Live sessions and sideband control`.

References: [session creation](https://developers.openai.com/api/reference/resources/live/methods/create), [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [sideband](https://developers.openai.com/api/docs/guides/voice-server-controls).

## Task 2: WebRTC media, truthful live UI, and local interruption

**Files:** Create `src/voice/liveClient.ts`, `liveController.ts`, `tests/voice-live-client.test.mjs`, `voice-live-controller.test.mjs`. Modify `src/VoiceCall.tsx`, `VoiceSettings.tsx`, voice styles, and trusted media permission handling.

**Interfaces:** `createLiveClient({backend, media, peerFactory, audioOutput})` exposes `start(LiveStart without offerSdp)`, `setInputMuted`, `setOutputMuted`, `stopSpeaking`, `end`, and `onState`. `waitForIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void>` owns a 10-second timer and removes its listener on every exit. Dependencies are injected for deterministic startup/late-media tests; actual credentials never enter this object. It shares the Release 1 audio lease.

- [ ] Test End before getUserMedia resolves, late SDP answer, muted input during connect, output-only mute, repeated closure, failed autoplay, audio route loss, and two simultaneous call attempts. Assert every late-acquired track stops. Test pending ICE gathering, timeout, and abort; the sent SDP must be `localDescription.sdp` after gathering, rather than the initial offer string.
- [ ] Run `node --experimental-strip-types --test tests/voice-live-client.test.mjs tests/voice-live-controller.test.mjs` and establish failures for the missing implementation.
- [ ] Implement WebRTC using an `RTCPeerConnection`, mic media track, and `oai-events` data channel. The dependency `backend` sends `voice_live_start`, returning LiveStarted. Core negotiation sequence:

```ts
const offer = await peer.createOffer();
await peer.setLocalDescription(offer);
await waitForIce(peer, signal);
const offerSdp = peer.localDescription?.sdp;
if (!offerSdp) throw new Error('Missing local SDP offer');
const started = await backend.call<LiveStarted>('voice_live_start', {
  request: { ...start, offerSdp },
});
await peer.setRemoteDescription({ type: 'answer', sdp: started.answerSdp });
```

Here `peer` is the injected peer instance, `signal` belongs to the call's AbortController, and `start` holds call ID/generation/scope/voice. Create `oai-events` and register listeners before `createOffer`. A generation/disposed check guards every await; `session.started` establishes connected state. No `bridge.start`, WebRTC `session.start`, or old Realtime turn-commit messages are sent.

Implement the abortable ICE helper in `liveClient.ts`:

```ts
export function waitForIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', changed);
      signal.removeEventListener('abort', aborted);
      error ? reject(error) : resolve();
    };
    const changed = () => {
      if (peer.iceGatheringState === 'complete') finish();
    };
    const aborted = () => finish(new Error('Voice startup canceled'));
    const timer = setTimeout(() => finish(new Error('ICE gathering timed out')), 10_000);
    peer.addEventListener('icegatheringstatechange', changed);
    signal.addEventListener('abort', aborted, { once: true });
    signal.aborted ? aborted() : changed();
  });
}
```

- [ ] Render independent capture/output/work indicators. Use actual media level/output activity for Speaking. Keep transcript timestamps independent from playback; there is no invented final transcript/spoken-response event. Show `Voice: GPT-Live` plus selected agent and host. Keep exact-read TTS disabled while the live media lease is active.
- [ ] Mic mute disables capture immediately and sends `session.input_audio.mute` through the host; correlate `session.input_audio.muted.client_event_id`. Unmute uses the corresponding unmute/unmuted pair and reacquires capture only from explicit user action if tracks were stopped. Output mute silences local playback independently. Stop speaking sets a local output suppression latch and sends `session.instructions.append` with `delegation_id: null`; an acknowledgment alone must not release the latch or imply buffered audio was discarded. Keep output suppressed until an explicit Resume action after a new user utterance and measured silence; if stale-buffer clearance cannot be established on the native transport, require a new call. Show this limitation during acceptance. End stops capture/output immediately but retains peer/data/sideband reception until finalization or timeout.
- [ ] Run focused suites and `npm run build`; commit `feat(voice): add full-duplex WebRTC call and independent controls`.

## Task 3: Versioned transcripts and delegation into existing agents

**Files:** Create `crates/apex-host/src/voice/transcript.rs`, `delegation.rs`, `ledger.rs`, and their tests. Extend the personal/Thread tracked-request APIs and tests created in Release 1 Task 4. Add `tests/voice-delegation.test.mjs` for client correlation and UI attribution.

**Interfaces:** `TranscriptTimeline::append(event)` stores speaker/text/start/end/event ID and a revision. `context_at(offset_ms)` returns a bounded versioned snapshot or an incomplete result. `DelegationLedger::claim(session_id, delegation_id, scope, revision) -> Result<bool, String>` durably reserves one dispatch. `dispatch_personal` reuses `personal_send` with request ID `voice:<sessionId>:<delegationId>` and correlates the accepted event through existing `PersonalMessage.eventId`. Thread dispatch uses Release 1's tracked host post and `sourceRequestId`. Build a compact opaque local request ID if upstream IDs exceed Apex's allowed request length; persist its exact upstream mapping, never truncate IDs or permit collisions.

- [ ] Write a fixture where delegation arrives before its transcript, then repeated transcript events, a correction, and reordered timestamps. Assert zero dispatch before usable context; one dispatch when usable; clarification on a 2-second missing-context timeout. Preserve fragment whitespace rather than reconstructing each fragment as a separate utterance.
- [ ] Test identical browser/sideband delegation, same ID with a changed scope, correction before dispatch, a late result after a newer correction, and crash between reservation/post/acceptance. Test Thread deduplication across restart, not only within an in-memory Map.

```rust
#[test]
fn reservation_survives_reload() {
    let dir = tempfile::tempdir().unwrap();
    let mut ledger = DelegationLedger::open(dir.path()).unwrap();
    assert!(ledger.claim("session_1", "delegation_1", "thread:room_1:codex", 7).unwrap());
    drop(ledger);
    let mut ledger = DelegationLedger::open(dir.path()).unwrap();
    assert!(!ledger.claim("session_1", "delegation_1", "thread:room_1:codex", 7).unwrap());
}
```

`DelegationLedger::open(&Path) -> Result<Self, String>` and `claim(&str, &str, &str, u64)` are defined by this task. Use a dev-only tempfile dependency if absent; do not add it to production. The scope string is a canonical serialization of the defined VoiceScope, not a renderer authority claim. An already-claimed ID with a changed scope is an error, not another dispatch.

- [ ] Run `cargo test -p apex-host voice::transcript`, `cargo test -p apex-host voice::ledger`, and `cargo test -p apex-host voice::delegation`; establish missing-type/behavior failures.
- [ ] Implement timeline assembly and durable request states `reserved`, `accepted`, `waiting`, `completed`, `superseded`, `uncertain`. A delegation's offset/metadata does not supply its task text. Use application transcript/task context; unfinished or ambiguous intent asks for clarification. Full structured output stays in the backend.
- [ ] Implement one selected target per delegation: personal assistant or chosen Thread participant. Honor existing routing, persona/reasoning/access, and normal task approvals. A delegated workspace action cannot execute in the voice layer. A verbal “yes” is not an approval; point to the existing card.
- [ ] Read back acceptance/eventId or Thread sourceRequestId to correlate committed replies. Return a short result grounded in those records, with the originating delegation ID, using client-delegation commentary/thinking updates. Never send Responses-only function results or `response.create` in client mode. Exact wording remains available in chat; the Live transcript is attributed to GPT-Live.
- [ ] Bound transcript context to 24,000 characters and the current delegation's relevant task state. Preserve fragments/timestamps and speaker identity; reject impossible intervals or oversize events. Appends are strings of at most 400 UTF-8 bytes (including labels), split at fact/code-point boundaries; this conservative byte cap stays below the documented 500-token content limit without a new tokenizer dependency. Use the upstream delegation ID unchanged for task-specific updates, null for general instructions. Correlate append acknowledgments; a late result for a superseded request stays in Apex history and cannot replace the current task result.
- [ ] Run the focused suites and existing personal-worker/room-persistence tests. Commit `feat(voice): delegate live requests through durable Apex agent routing`.

Protocol source: [client delegation](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client). Consult this source together with the spec; do not copy BridgeMind's nested Responses handler.

## Task 4: Session cleanup, budgets, and recovery without duplicate work

**Files:** Create `crates/apex-host/src/voice/usage.rs`; modify session registry/ledger/controller and policy from previous tasks. Extend Rust voice tests, `tests/voice-live-controller.test.mjs`, and `tests/e2e/voice-lifecycle.e2e.mjs` (new).

**Interfaces:** `LiveUsage::observe(seconds)` stores the latest cumulative duration; it never sums repeated totals. Closure stores `confirmed` or `unconfirmed` final usage. Session records reference durable agent events/tasks, while runtime handles and media bytes remain memory-only. Start of a new call restores permitted context and references existing work; it never blindly reposts old requests.

- [ ] Test cumulative usage 12 →15 →15 seconds equals 15, owner disconnect closes upstream, privacy revocation stops cloud media/control, cap exhaustion closes voice, and close acknowledgment timeout records uncertainty. Test a task still running after End/Stop speaking/mic mute and only changing to canceled after an explicit task cancel.

```rust
#[test]
fn duration_updates_are_cumulative() {
    let mut usage = LiveUsage::default();
    usage.observe(12.0);
    usage.observe(15.0);
    usage.observe(15.0);
    assert_eq!(usage.seconds(), 15.0);
}
```

- [ ] Run `cargo test -p apex-host voice::usage` and lifecycle suites; establish the intended failures.
- [ ] Add 10-minute maximum session, 30-second warning, 60-second mic+output-muted idle close, and shorter budget-derived caps where a dated rate is known. Keep task costs separate; unknown rates display duration/unknown cost. Muting is not reported as stopping billing.
- [ ] Reserve the documented WebRTC initialization duration before creation, reconcile it against cumulative running usage, and avoid double-counting its credit. Test failed startup after HTTP creation, 15 seconds credited into a longer call, reordered cumulative usage, and two concurrent calls against a shared daily budget. An HTTP timeout is an uncertain billed outcome; do not silently retry it.
- [ ] Register `session.closed` listeners before sending close, stop local media immediately, allow 12 seconds for final acknowledgment, and record unconfirmed outcome on timeout. Host-owner loss triggers upstream cleanup within 15 seconds. A sideband loss that prevents authoritative delegation ends the voice session; it cannot continue running untracked agent requests.
- [ ] Implement explicit reconnect/new-call only. Never reopen the microphone after app restart, network recovery, or permission change. On restored ledger state, reconcile accepted requests with host records; preserve ambiguous outcome as uncertain. Permit durable work to finish while the call is closed, and show the stored result on reopen.
- [ ] Run focused suites plus `cargo test -p apex-daemon` and `npm run build`. Commit `fix(voice): enforce budgets cleanup and nonduplicating session recovery`.

## Task 5: Native live conversation and provider acceptance

**Files:** Extend `desktop/run-voice-smoke.mjs`, `docs/voice-verification.md`; add `tests/e2e/voice-delegation.e2e.mjs`. Modify iPhone audio-session plugin/client only if physical-device WebRTC requires it. Update README voice modes and setup.

**Interfaces:** A live test scenario records build/host/model/voice, timestamps, selected scope, text/delegation IDs, audible observations, and confirmed/unknown usage. Fixture tests and actual upstream audio are labeled separately. No recording is persisted unless the human specifically requests one for evaluation.

- [ ] Run deterministic fake-provider failure scenarios first: delayed transcript, duplicate delegation, partial result, approval wait, late completion, Sideband loss, route interruption, and connection close before `session.closed`.
- [ ] Run `npm test`, `cargo test --workspace`, `npm run build`, and `npm run desktop:package`. Record the actual packaged build ID/path and host capability read-back.
- [ ] Start a real GPT-Live call with Claude selected. Complete two conversational turns, ask a harmless workspace question, interrupt mid-speech, add a correction, and verify the selected agent handles the delegated question exactly once. Repeat with Codex. Capture final text and authoritative event/task linkage; hearing Live say an answer is not proof the selected agent ran.
- [ ] In an isolated test workspace, start an approved benign long-running fixture task. Interrupt/mute/End; verify the host task keeps running and its result survives reopen. Then start another and explicitly cancel it through the existing task control; verify real task state and process cleanup.
- [ ] Test one request that needs an approval. The call directs the human to the existing card and remains conversational; a spoken “yes” alone executes nothing. Confirm normal visible approval works without a duplicate dispatch.
- [ ] Test built-in speakers, headset, Bluetooth route changes, overlapping speech, silence, output mute, mic mute, network interruption, provider access rejection, cap warning, and reconnect. Listen for echo loops, clipped words, repeated clauses, stale audio, and unexpected agent switches.
- [ ] Measure conversational acknowledgment latency on at least 20 turns separately from delegated-agent first/last result. Report p50/p95, interruption stop time, actual network/hardware, and sound quality. Missed targets are visible release findings.
- [ ] For phone release, rebuild and install on the physical iPhone; test WKWebView media negotiation, foreground/background, lock/incoming calls, and headset/Bluetooth. Do not reuse Apple speech recognition simultaneously. Returning foreground must require a new call. If native media bridging is necessary, test the same contracts and mark phone pending until passing.
- [ ] Verify credentials/SDP/raw PCM are absent from logs, storage, replay, and exported chats; verify unauthorized/limited devices cannot use the session. Record final upstream closure confidence.
- [ ] Commit `test(voice): verify live conversation with Claude Codex and native audio` only after evidence supports the report.

## Release decision and rollback

Enable Live only after client-delegation correctness, packaged listening, actual Claude/Codex attribution, work continuity, and graceful-close evidence pass. The user chooses Device, Natural speech, or Live conversation explicitly. Model access errors remain provider errors, not Pro gates.

Rollback disables new Live calls and closes active sessions while retaining Natural speech, all committed transcripts, and durable agent work. A voice call closing is not a task-cancel command.
