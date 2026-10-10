# Apex iPhone Background Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement task by task. Subagents require explicit authorization; this plan does not authorize delegation. Steps use checkboxes for tracking.

**Goal:** Keep a user-started, opted-in Live conversation listening and speaking while the iPhone runs other apps or has its screen locked, preserving Apex's Claude/Codex agents and task controls.

**Architecture:** An app-owned Swift coordinator owns native audio and a dedicated authenticated paired-host connection for the entire call. The Rust execution host bridges PCM to GPT-Live's primary WebSocket and reuses the existing authoritative transcript/delegation/usage services. React observes a bounded state snapshot; background media, control, acknowledgments, and agent dispatch never depend on JavaScript running.

**Tech Stack:** Existing Capacitor 8.5.2 wrapper, Swift/AVAudioSession/AVAudioEngine/AVAudioConverter/MediaPlayer, native iroh bridge, Rust/Tokio/tungstenite. No new native WebRTC SDK or Tauri dependency.

**Spec:** [Natural voice design](../specs/2026-10-10-apex-natural-voice-design.md). **Dependencies:** [Release 1](2026-10-10-apex-natural-speech.md) provides source/policy/private PCM contracts; [Release 2](2026-10-10-apex-live-voice.md) provides Live controls, authoritative transcripts, delegation ledger, and usage. Start with QR-paired iroh hosts; token/WebSocket hosts and browser/PWA background calls are unavailable in this release.

Status: planning only, revised 2026-10-10 against `f5e72e6`. No implementation or device validation has occurred. All implementation checkboxes remain unchecked. Preserve unrelated checkout changes and the design-only `ios/` and `mockups/ios/` projects; the production wrapper lives in `iphone/`.

## Global Constraints

- Use the existing Electron + Rust daemon architecture; add no Tauri dependency.
- Keep cloud voice off until explicitly selected; preserve device speech and typed input.
- Keep API credentials on the execution host; reuse `OPENAI_API_KEY` through the existing key store.
- Keep raw audio, credentials, SDP, and live transport handles out of saved sessions, replay buffers, exports, and logs.
- Keep audio events scoped to the initiating connection; do not broadcast or replay them.
- Preserve participant identity, Thread routing, reasoning/access/persona settings, approvals, and task receipts.
- Stop local output immediately on output mute, audio interruption, owner disconnect, or End call; discard late audio by generation. Web-owned calls also stop on unmount; native iPhone calls survive UI detachment. Microphone mute affects input independently.
- Ending a call does not cancel existing agent work; cancellation remains a separate task action.
- A cloud-provider error is visible; switching to device speech requires an explicit user choice.
- Verify audio on a packaged native build; mocks and builds do not establish naturalness.
- iPhone background Live calls require explicit opt-in and native audio/transport ownership; app switching, screen lock, and UI detachment do not end an opted-in active call.
- Start or resume microphone capture only through explicit user action; interruptions, lost ownership, and app termination require a new foreground start/resume.
- Background audio supports active voice use only; never use silent playback, background-task timers, or push notifications to keep an idle microphone alive.

## Review Focus

- A suspended/reloaded WKWebView cannot strand acknowledgments or interrupt an opted-in native call; foreground attachment must not restart capture or duplicate work (Tasks 1–2).
- An incoming call, Siri, media reset, or AirPods removal cannot unexpectedly reopen capture or play private speech on the speaker (Tasks 2–3).
- PCM chunks, sample-rate conversion, and stalled network queues cannot distort pitch or deliver old microphone audio later (Tasks 1, 3).
- Locked-screen credentials, host loss, device revocation, and app eviction cannot leave an unowned billed session; authoritative agent tasks remain intact (Tasks 1–2, 4).
- Background opt-out, remote Stop/Pause, budget expiry, and both-muted idle must work without React timers or JS event listeners (Tasks 2, 4).

## File and interface map

| File | Responsibility |
| --- | --- |
| `crates/apex-host/src/voice/primary.rs` | GPT-Live primary WebSocket, startup, PCM forwarding, shared delegation/usage. |
| `crates/apex-daemon/src/voice.rs`, `protocol.rs`, `authority.rs` | Native PCM start command, private input/output/control frames, authenticated owner checks. |
| `iphone/ApexRemote/Sources/ApexRemote/NativeRemoteCore.swift` | App-owned iroh FFI lifetime, native event subscriptions, per-handle ownership. |
| `iphone/ApexRemote/Sources/ApexRemote/ApexRemotePlugin.swift` | Existing JS facade over the core; detachment must not destroy native voice leases. |
| `iphone/ApexRemote/Sources/ApexRemote/NativeVoiceRPC.swift` | Dedicated paired-host hello/RPC/private frames, timeouts and disconnects outside JS. |
| `iphone/ApexRemote/Sources/ApexRemote/VoiceLifecycle.swift` | Pure transitions for foreground/background, interruption, mute, End, and reattachment. |
| `iphone/ApexRemote/Sources/ApexRemote/VoiceCallCoordinator.swift` | App-owned call generation, native RPC/audio lifetime and bounded snapshot. |
| `iphone/ApexRemote/Sources/ApexRemote/VoiceAudioEngine.swift` | Voice-processing capture, resampling, PCM playback, route rebuilding and meters. |
| `iphone/ApexRemote/Sources/ApexRemote/VoiceNowPlaying.swift` | Privacy-preserving Now Playing metadata and native Stop/Pause handlers. |
| `iphone/ApexRemote/Sources/ApexRemote/ApexVoicePlugin.swift` | Thin Capacitor capability/start/control/snapshot facade, no media callbacks. |
| `iphone/ApexRemote/Package.swift`, `Tests/ApexRemoteTests/` | Native linking/test target and coordinator/audio/RPC tests. |
| `iphone/App/App/{SceneDelegate,SpeechPlugin}.swift`, `Info.plist`, `App.xcodeproj/project.pbxproj` | Register plugins on actual scene controller, exclusive audio ownership, lifecycle, background mode and device-test target. |
| `src/voice/{nativeTypes,nativeClient}.ts`, `settings.ts`, `VoiceSettings.tsx`, `VoiceCall.tsx`, `src/phone/PhoneApp.tsx` | Capability-aware opt-in, explicit controls, snapshot attachment, truthful per-mode copy. |
| `docs/voice-ios-verification.md`, `README.md` | Installed-device evidence, setup, persistence limits and accepted build ID. |

The current scene installs `AppBridgeViewController` in `SceneDelegate.swift`. The other `MainViewController` in `SpeechPlugin.swift` is not the active registration point. Move speech registration to the scene controller rather than adding another competing root controller. `ApexRemotePlugin` currently owns Rust callback registration/shutdown and forwards events to JS; extract its core lifetime before claiming native call ownership.

## Shared native and host contracts

Create these TS types in Task 1; `VoiceScope`, `VoiceLiveData`, and `LiveControl` come from Releases 1–2. Swift Codable equivalents and Rust serde equivalents use the same camelCase wire names. Runtime handles stay native and out of AppSettings.

```ts
export type IPhoneVoicePreferences = {
  continueInBackground: boolean; // default false; separate from backgroundNotices
  maxSessionMinutes: 10 | 30 | 60; // default 10; no automatic renewal
};
export type NativeVoiceConfig = IPhoneVoicePreferences & {
  callId: string; generation: number;
  hostEndpointId: string; addrs: string[];
  scope: VoiceScope; voice: 'marin' | 'cedar';
};
export type NativeVoiceSnapshot = {
  revision: number; callId?: string; generation: number;
  phase: 'idle' | 'starting' | 'active' | 'closing' | 'interrupted' | 'ended' | 'error';
  microphone: 'off' | 'listening' | 'muted';
  output: 'silent' | 'playing' | 'muted' | 'suppressed';
  work: 'idle' | 'pending' | 'running' | 'needsYou';
  visibility: 'foreground' | 'background';
  continueInBackground: boolean; sessionId?: string; hostName?: string;
  agentLabel?: string; remainingSeconds?: number; reason?: string;
};
export type NativeVoiceControl = LiveControl
  | { action: 'muteOutput'; muted: boolean }
  | { action: 'background'; enabled: boolean };
export interface NativeVoiceClient {
  capabilities(): Promise<{ nativeLive: boolean; background: boolean; reason?: string }>;
  start(config: NativeVoiceConfig): Promise<NativeVoiceSnapshot>;
  control(callId: string, generation: number, control: NativeVoiceControl): Promise<NativeVoiceSnapshot>;
  snapshot(): Promise<NativeVoiceSnapshot>;
  attach(cb: (snapshot: NativeVoiceSnapshot) => void): Promise<() => void>;
  claimForegroundAudio(ownerId: string): Promise<void>;
  releaseForegroundAudio(ownerId: string): Promise<void>;
}
export type VoiceLivePcmStart = {
  callId: string; generation: number; scope: VoiceScope;
  voice: 'marin' | 'cedar'; maxSessionMinutes: 10 | 30 | 60;
};
export type VoiceInputAudio = {
  callId: string; generation: number; chunkSeq: number;
  data: string; rate: 24000; channels: 1;
};
export type VoiceLivePcmData = {
  callId: string; generation: number; chunkSeq: number;
  data: string; rate: 24000; channels: 1;
};
```

Host `voice_live_pcm_start({request: VoiceLivePcmStart})` returns `{sessionId, maxSeconds}` after `session.started`, without SDP or a provider key. It advertises `voice_live_pcm_v1`. Existing `voice_live_control`/`voice_live_status` retain connection-local ownership. Native `hello` negotiates protocol/capabilities/access on a dedicated paired connection; scope is independently authorized by the host. A renderer-supplied call ID or endpoint is never an authority claim.

Input is `{type:'voice_input_audio', payload:VoiceInputAudio}`; native output is `{type:'voice_live_pcm_data', payload:VoiceLivePcmData}`. Both are connection-local, strictly ordered, generation-bound, validated after authentication, and excluded from durable replay. Add `{type:'voice_input_ack', payload:{callId,generation,consumedChunkSeq}}` when the host successfully forwards bytes to the upstream socket. This acknowledges Apex's forwarding only; the provider gives no audio-append acknowledgment. Output uses Release 1's `voice_audio_ack`, extended to the Live PCM job. Native consumes all media frames before JS routing and emits only sanitized snapshot changes to JS.

Capture emits 20 ms frames (960 raw bytes); allow at most 100 ms/4,800 raw bytes per input frame and 200 ms/9,600 outstanding input bytes. Native tracks local frame age: when backpressure would send captured audio older than 200 ms, stop capture, discard queued input, and end voice with `stream_stalled`; do not drop arbitrary speech frames and continue pretending the turn is intact. Host enforces its own bounded input queue and sequence/size checks. Output retains the ≤3-second/144,000-byte raw window and 150–300 ms prebuffer from Release 1. Input, output and control have separate bounded queues; End is never queued behind PCM.

The native core exposes `retain(owner:)`, `release(owner:)`, `connect(hostEndpointId:addrs:)`, `send(handle:line:)`, `close(handle:)`, and `subscribe(handle:receiver:) -> unsubscribe`. Owners are native-created UUIDs. Releasing a plugin owner closes only its handles; the coordinator retains its voice handle until End/failure. The last owner shuts down FFI. Native RPC exposes `open(config:)`, `call(command:args:)`, `sendInput(frame:)`, `onMedia`, `onControl`, `onClosed`, and `close()`. Pending RPCs are bounded to 32 with 10-second deadlines; IDs are unique per connection, and mutating requests are never retried after an ambiguous failure. The coordinator also owns one atomic native audio lease: `claimForegroundAudio` reserves it for web playback/preview and `releaseForegroundAudio` releases only the matching UI owner. Native Live start and native Apple recognition use that same lease; a failed claim cannot start audio. A UI owner ID is a local lease identifier, never host authorization.

## Task 1: Primary WebSocket bridge and native-owned paired RPC

**Files:** Create `crates/apex-host/src/voice/primary.rs`, `src/voice/nativeTypes.ts`, `iphone/ApexRemote/Sources/ApexRemote/{NativeRemoteCore,NativeVoiceRPC}.swift`, native RPC/core tests, and `tests/voice-native-contract.test.mjs`. Modify existing voice registry, command/authority/protocol/private transport, mobile plugin, `iphone/ApexRemote/Package.swift`, and `crates/iroh-mobile/src/lib.rs` only if separate control/media queue support is required.

**Interfaces:** Implement the types, frames, native core and RPC signatures above. Rust `start_primary(owner, request, media_sink, control_sink)` returns session ID/maxSeconds and feeds the same transcript/delegation/usage services as Release 2. One primary connection is the authoritative consumer; no second sideband dispatch.

- [ ] Add contract fixtures and fake-provider tests: PCM before started rejected; valid start/PCM/close; malformed base64, odd samples, wrong generation, oversized input, stale input/backpressure, output stall, expired provider session and duplicate delegation. Include privacy/budget rejection before the socket connects. A second authenticated phone receives no media and cannot mute/End/ack the first phone's call.

```rust
#[test]
fn input_frame_size_is_bounded() {
    assert!(validate_input_pcm(&vec![0; 4_800]).is_ok());
    assert!(validate_input_pcm(&vec![0; 4_802]).is_err());
    assert!(validate_input_pcm(&[0]).is_err());
}
```

`validate_input_pcm(&[u8]) -> Result<(), String>` is defined in `primary.rs`; it rejects empty/odd/oversized decoded samples. Production checks call/generation/sequence/authorization in the daemon before this decoder. Test endpoint injection is construction-only.

- [ ] Run `cargo test -p apex-host voice::primary` and `cargo test -p apex-daemon voice`; establish missing-contract failures. Add a Swift test target in `iphone/ApexRemote/Package.swift` with `.testTarget(name: "ApexRemoteTests", dependencies: ["ApexRemote"])` and run it on an iOS simulator using the package's generated ApexRemote scheme; this package imports UIKit and is not a macOS `swift test` target.
- [ ] Build the primary WebSocket request through the existing host key/policy boundary:

```rust
let first = serde_json::json!({
  "type": "session.start",
  "event_id": start_event_id,
  "session": {
    "model": "gpt-live-1", "store": false,
    "instructions": conversation_prompt,
    "audio": {"format": {"type": "audio/pcm", "rate": 24000},
              "output": {"voice": request.voice}},
    "delegation": {"type": "client"}
  }
});
```

`start_event_id` is a new unique ID, `conversation_prompt` is Release 2's Apex prompt, and `request` is VoiceLivePcmStart. Connect to `wss://api.openai.com/v1/live/sessions` with host Bearer authentication, send the first event once, and wait for `session.started` before forwarding input. Use `session.input_audio.append` with `audio` and `session.output_audio.delta` with `delta`. Do not apply this startup sequence to WebRTC. [Official primary WebSocket contract](https://developers.openai.com/api/reference/resources/live/primary-websocket)
- [ ] Decode/split provider output into bounded private frames. On the same upstream socket, process Live transcripts/delegations/usage through Release 2's services and controls through their existing documented semantics. Native PCM path uses no WebRTC initialization reservation unless a current provider contract explicitly requires it; reuse cumulative usage and budget accounting with transport-specific charging.
- [ ] Extract plugin-owned callback/FFI state into NativeRemoteCore, preserving endpoint identity and pairing behavior. Native callbacks route by handle to the coordinator before any JS listener. Plugin unload/UI reload releases its owner only. Native call release closes its dedicated handle; FFI shuts down after the last owner. Update existing JS facade tests so pairing, ordinary handles and shutdown retain their behavior.
- [ ] Implement native hello/RPC/PCM consumption and acknowledgments; retain authorized welcome state. A wrong host, revoked device, scope narrowing or owner loss closes voice. Add Swift fake-link cases for plugin destruction while a native owner exists, UI with zero listeners, hello timeout, mismatched replies, queue overflow, and exactly one final closure. Test key lookup/access while locked during device acceptance; never change Keychain accessibility broadly for this feature.
- [ ] Run focused Rust/Node/native tests and `npm run iphone:sync` to rebuild/check the FFI artifact. Commit only task files: `feat(voice): add primary Live PCM bridge and native paired RPC`.

## Task 2: Native call owner, lifecycle, settings and lock controls

**Files:** Create `VoiceLifecycle.swift`, `VoiceCallCoordinator.swift`, `VoiceNowPlaying.swift`, `ApexVoicePlugin.swift` in the native package, their native tests, `src/voice/nativeClient.ts`, `tests/voice-native-client.test.mjs`, and `tests/voice-background-settings.test.mjs`. Modify native package linking, `SceneDelegate.swift`, `SpeechPlugin.swift`, `Info.plist`, Xcode project configuration, `src/voice/settings.ts`, `VoiceSettings.tsx`, `VoiceCall.tsx`, and `src/phone/PhoneApp.tsx`.

**Interfaces:** `VoiceLifecycle` consumes events `start`, `started`, `background`, `foreground`, `detachUI`, `disableBackground`, `interruptionBegan`, `interruptionEnded`, `unsafeRoute`, `ownerLost`, `muteBoth`, `end`. Its effects are `keepAudio`, `stopAudio`, `closeHost`, `publishSnapshot`; terminal/late events never emit capture-start. `VoiceCallCoordinator.shared` owns NativeVoiceRPC, a monotonic generation, and the audio service in Task 3. NativeVoiceClient implements the shared contract, and `attach()` unsubscribes UI observation without calling End.

- [ ] Write pure lifecycle tests before integrating audio. Test opt-in on/off, app switch/lock, UI detach/reload, background opt-out, End during startup, late started, route loss, interruption `.shouldResume`, owner loss, repeated End and restored snapshots. Native control accepts the matching call/generation only.

```swift
func testBackgroundPolicyAndInterruption() {
    var allowed = VoiceLifecycle(active: true, continueInBackground: true)
    XCTAssertEqual(allowed.apply(.background), [.keepAudio, .publishSnapshot])
    XCTAssertEqual(allowed.apply(.detachUI), [.publishSnapshot])
    XCTAssertEqual(allowed.apply(.interruptionBegan), [.stopAudio, .closeHost, .publishSnapshot])
    XCTAssertEqual(allowed.apply(.interruptionEnded), [.publishSnapshot])
    var foregroundOnly = VoiceLifecycle(active: true, continueInBackground: false)
    XCTAssertEqual(foregroundOnly.apply(.background), [.stopAudio, .closeHost, .publishSnapshot])
}
```

`VoiceLifecycle.init(active:continueInBackground:)` and `apply(_:) -> [VoiceEffect]` are the pure interfaces defined by this task. Interruption-ended changes the explanation only; it never implies microphone authorization.

- [ ] Test TS settings migration: persist preferences under optional `AppSettings.voice.iphone: IPhoneVoicePreferences`; missing/invalid background preference → false, invalid limit →10, existing backgroundNotices unaffected. Test unsupported Native/Safari/token-host modes cannot enable the switch. Test `attach` after reload reads snapshot without invoking `start`, `personal_send`, or Thread post. Run the new Node suites and native lifecycle test target to establish failures.
- [ ] Register `ApexVoicePlugin` and `SpeechRecognitionPlugin` alongside existing remote/scanner plugins on the actual AppBridgeViewController. App/scene lifecycle forwards visibility/interruption events to the coordinator; React unmount is observation detachment. Request mic permission while foregrounded before starting media. App termination performs best-effort local shutdown; host owner-loss cleanup is authoritative when termination callbacks do not run.
- [ ] Add the background audio capability to the production app, preserving existing plist keys and camera pairing usage:

```xml
<key>UIBackgroundModes</key>
<array><string>audio</string></array>
```

Update `NSMicrophoneUsageDescription` to “Talk to your assistant. With background conversation enabled, the microphone stays active while you use other apps or lock the screen.” Correct speech-recognition disclosure so it does not guarantee local-only Apple recognition. Add no `voip` mode, PushKit, always-on wake word, or artificial keepalive audio.
- [ ] Add “Continue conversation in background” and 10/30/60-minute selection with the spec's exact disclosure. The switch is enabled only for a native Live call on a compatible paired host; `backgroundNotices` remains a separate setting. Disabling it while already backgrounded ends voice immediately. A selected longer limit applies at the next start and is clamped by host budget/provider expiry; show the selected limit before starting and the effective limit on host acceptance. Disable duration choices exceeding verified provider limits.
- [ ] Add a compact persistent in-app call indicator with mic/output/End controls and correct voice/agent/host attribution. Modify `src/voice/lease.ts` so iPhone web playback/preview atomically calls `claimForegroundAudio` before audio starts and releases on completion/disposal; SpeechRecognitionPlugin uses the same native lease. Native call ownership blocks competing web recognition, TTS previews, and other calls until its lease ends; test simultaneous starts and a preview attempted while the call UI is detached. On foreground return, attach native snapshot and resync durable host chat/task history; do not automatically retry prior sends or replay audio. Privacy changes arriving from the host stop the native stream. An approval requested while locked remains `needsYou`; direct the human to unlock and use the existing card. Spoken assent executes nothing.
- [ ] Implement Now Playing metadata without transcript/room/task titles by default. Native Stop → End; native Pause → mic+output mute and release inactive audio as needed; Play/Resume directs the human to foreground confirmation before capture. Register only controls actually supported, remove handlers on End, and verify Control Center/headset mappings on device rather than assuming HFP button behavior. Local stop is immediate even when the host is offline.
- [ ] Enforce host-owned caps while UI is suspended: 30-second warning and effective expiry are reported as sanitized controls. An enabled output plays one brief cap warning; output mute suppresses that warning. Both-muted idle closes within the existing 60-second ceiling, or immediately if the native audio session becomes inactive in background. Do not depend on a JS countdown. Keep agent work running after every voice closure.
- [ ] Run native/Node focused tests, `npm run build`, and `npm run iphone:sync`; compile the signed app. Commit `feat(voice): own iPhone background calls natively with explicit controls`.

## Task 3: Native voice-processing PCM and route-safe playback

**Files:** Create `VoiceAudioEngine.swift` and native audio tests in the package. Modify coordinator/audio lease integration and `SpeechPlugin.swift` cleanup. Link `AVFAudio`/`MediaPlayer` through package framework settings as required by the imports; keep the existing iOS deployment floor unless a reviewed dependency requires changing it.

**Interfaces:** `VoiceAudioEngine.start(onInput:)`, `enqueue(frame:generation:)`, `setInputMuted(_:)`, `setOutputMuted(_:)`, `stopSpeaking()`, `stop()`, and `snapshot()` run under one coordinator-owned lifecycle. Input callback delivers PCM directly to NativeVoiceRPC. `onConsumed(chunkSeq:)` acknowledges actual playback drain; `onFailure(reason:)` ends the coordinator generation. The engine never handles provider credentials or agent dispatch.

- [ ] Write deterministic fixtures for 44.1/48 kHz input →24 kHz mono PCM16LE, output resampling, odd sample splits, final short tails, 200 ms capture-age cutoff, ≤3-second output buffers, and old-generation rejection. Test mute/End during route rebuild, stopped recognition releasing its tap/session, output drain versus network done, and missing voice-processing support. Use a 1 kHz fixture: a 1-second input/output remains 1 second and 1 kHz within documented conversion tolerances; do not snapshot the implementation as the oracle.
- [ ] Run native audio test target with injected formats/clock/transport; establish missing-engine failures. Add coordinator tests showing no mic bytes forwarded while muted and no acknowledgment granted for unsent/undrained chunks.
- [ ] Configure native audio on the control queue before installing taps; initialization code starts from this sequence:

```swift
let session = AVAudioSession.sharedInstance()
try session.setCategory(.playAndRecord, mode: .voiceChat,
                        options: [.defaultToSpeaker])
try session.setActive(true)
try engine.inputNode.setVoiceProcessingEnabled(true)
```

`.voiceChat` selects suitable Bluetooth voice routes; do not assume high-bandwidth A2DP supports simultaneous headset input. Explicit voice processing is required for echo cancellation; mode alone is insufficient. Query actual route formats after activation; convert with AVAudioConverter rather than forcing hardware to 24 kHz. [Apple voice-chat behavior](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/voicechat), [voice-processing API](https://developer.apple.com/documentation/avfaudio/avaudioionode/setvoiceprocessingenabled(_:))
- [ ] Take the native audio lease after stopping Apple recognition and removing its tap. Use a bounded real-time capture ring; resampling, base64, RPC and logging never run on the audio tap thread. Native AVAudioPlayerNode playback schedules correctly converted buffers and reports actual drain for output credits. Both directions bypass Capacitor/React callbacks. Voice-processing failure makes continuous speaker calls unavailable; show a foreground tap-to-talk/headset alternative, never silently run an echo loop.
- [ ] Rebuild safely on route/media-service changes, preserving mute, output suppression, generation and outstanding cancellation. Headset removal stops capture/playback and requests closure before any speaker fallback. Stable route migration may retain the active call only after the safe route/engine is verified; a failed rebuild requires foreground Resume/new call. No interruption-ended notification automatically starts capture.
- [ ] Stop output within the spec's ≤150 ms native goal on End/output mute/Stop speaking. Stop speaking clears scheduled buffers immediately and keeps an output suppression latch, using Release 2's documented host steering semantics. If a new utterance cannot be separated from stale provider audio, require a new call instead of releasing the latch on an acknowledgment. Mic mute removes/disables capture without changing unrelated host tasks.
- [ ] Run native focused tests and compile/install the app. Check known-frequency fixture through simulator tooling for conversion only; use physical-device listening for echo, route and stop-time claims. Commit `feat(voice): stream native voice-processing audio with bounded playback`.

## Task 4: Physical iPhone persistence, provider and recovery gate

**Files:** Create `docs/voice-ios-verification.md`; add an `AppVoiceTests` iOS test target/scheme in `iphone/App/App.xcodeproj/project.pbxproj`, `iphone/App/AppVoiceTests/VoiceBackgroundTests.swift`, and native failure fixtures. Update README and desktop verification with the separate phone gate.

**Interfaces:** Device report records signed build ID, physical model/iOS version, execution host/build/capabilities, transport route, voice/agent, call/session ID continuity, timestamps, task/event correlation, listening observations, final usage confidence, battery/thermal behavior, and failures. Audio is not recorded unless separately requested. A simulator report is labeled fixture evidence and cannot substitute for device acceptance.

- [ ] Run deterministic native/Rust/Node focused suites, then `npm test`, `cargo test --workspace`, `npm run build`, and `npm run iphone:sync`. Add a test scheme for app-linked native package tests. Example simulator commands, after confirming the named scheme/destination exist:

```sh
xcodebuild -list -project iphone/App/App.xcodeproj
xcodebuild -showdestinations -project iphone/App/App.xcodeproj -scheme AppVoiceTests
xcodebuild test -project iphone/App/App.xcodeproj -scheme AppVoiceTests -destination 'platform=iOS Simulator,name=iPhone 17'
```

Use an actually listed destination when the fixture machine differs. Physical tests use the connected device's UDID in `-destination 'platform=iOS,id=<device-udid>'`; the human selects that concrete device during execution. Record the exact resolved destination and signed build, never claim a build installed from an Xcode selection alone.
- [ ] Install the signed app on a physical iPhone, verify its build ID, pair to a reachable host, and confirm host readiness. Complete real Claude and Codex two-turn nonce/context tests while (a) foregrounded, (b) using another non-audio app, and (c) locked. Ask the second question after leaving Apex/locking. Show the agent's authoritative stored response and request linkage; Live saying the answer does not prove agent execution.
- [ ] Keep one opted-in call through repeated app switches and a full default 10-minute lifetime, including ≥5 locked minutes. Then explicitly select 30 minutes and exercise a 30-minute mostly locked call through its warning/cap. Confirm stable call/session IDs until cap, responsive speech after ordinary silence, no replay on unlock, and measured battery/thermal/network behavior. Do not chain new sessions automatically to satisfy duration.
- [ ] Suspend JS observers and reload the WKWebView while native capture is active. Verify media acknowledgments, native RPC, transcripts, host delegation, budgets and Stop remain functional. Reattach snapshot/history, with no new upstream session or duplicated user post. Trigger a background delegation needing approval; it remains pending until the existing visible card is used after unlocking.
- [ ] Test opt-out: background/lock ends a foreground-only call; turning off background continuation closes an active background call. Test native Stop/Pause from supported lock/Control Center/headset controls. Test both-muted idle, silent switch, denied mic permission, and low-power mode. Never expect a paused inactive call to receive guaranteed unlimited background execution.
- [ ] Test AirPods/headset removal, wired/Bluetooth route changes, incoming phone/FaceTime call, Siri, and media-services reset. Capture/output must stop on unsafe interruption, private audio must not jump to speaker, and foreground return offers explicit Resume without opening the mic. Speaker/mic echo, clipped words, robotic conversion, and stale output are auditory failures even if unit tests pass.
- [ ] Test Wi-Fi→cellular→Wi-Fi on the same iroh connection and a forced disconnect separately. Healthy native path migration retains the same call; a lost owner connection closes voice and host cleanup completes within 15 seconds. Host sleep/restart, revoked pairing, offline API, cap exhaustion and invalid key have visible recoverable results. No automatic billed reconnect/new mic capture occurs.
- [ ] Force quit and relaunch while backgrounded; repeat with simulated process eviction where practical. Unlock as required by iOS to relaunch. Voice ends and the host cleans up without relying on termination callbacks. Relaunch restores durable task/chat state and an ended/interrupted explanation, with no active mic or replayed request. An approved benign host task continues through lock/End/termination; only explicit task cancellation stops it.
- [ ] Repeat same-reply Device/Marin/Cedar listening comparison and ≥20 live acknowledgment/Stop measurements on native output. Record p50/p95 acknowledgment and delegated-agent latency separately; include 44.1/48 kHz routes, speaker and AirPods. Native background voice ships only when the human accepts its audible quality and persistence results.
- [ ] Check stored sessions, exports, replay, logs and native snapshot: no PCM, keys, SDP, runtime handles, or private lock-screen transcript. Record known cost/unknown finalization without guessing billing. Publish the device report and exact artifact location, then commit `test(voice): verify persistent iPhone calls with Claude and Codex`.

## Release decision and rollback

Desktop Natural and Live may ship before this release. iPhone background Live is accepted only when the signed installed build passes the physical-device matrix; plist configuration, simulator playback, provider mocks and foreground media are insufficient. Device/Natural turn-based conversation remains foreground-only and says so in settings.

Roll back by hiding the native background capability, closing native/upstream voice sessions, and releasing audio/Now Playing handlers. Preserve typed chat, foreground modes, pairing identity, committed transcripts and agent tasks. Call limits remain bounded; force quit, process eviction, exhausted budget, provider expiry and unreachable hosts end voice.
