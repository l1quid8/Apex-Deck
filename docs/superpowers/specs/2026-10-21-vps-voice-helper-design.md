# Phone voice calls through a server's voice helper

Status: direction approved by the human on 2026-10-21 ("build the VPS voice helper first with base.en + Kokoro ONNX so phone calls work without my Mac"). Planning only; nothing is implemented. Plan: `docs/superpowers/plans/2026-10-21-vps-voice-helper.md`.

## Goal and agreed requirements

From the iPhone app, call any agent in a thread that lives on the VPS, using a mic beside Send, with the Mac asleep or off. The call behaves like a Mac call (`docs/superpowers/specs/2026-10-20-local-agent-voice-design.md`): the mic is live only between the person's Start and End, the agent keeps its thread history, tools and approval cards, each agent has its own voice, a leading `call <name>` switches agents, `stop listening` ends the call, and talking over the agent interrupts it.

Listening (faster-whisper `base.en`) and speaking (Kokoro ONNX) run on the VPS next to the agents. Voice stays off until someone starts a call. The first call on a machine asks for a one-time download onto that machine (about 0.8 GB; the manifest records the exact bytes), started from the phone. The Mac app does not change: it keeps its own local helper for every thread.

## Measured facts (2026-10-21)

VPS: Intel Xeon E3-1270 v6, 8 threads, 30 GB memory, no GPU, otherwise idle. Clips were clean synthetic speech (3 s, 8.5 s, 25 s).

| Part | Result |
| --- | --- |
| faster-whisper `base.en`, int8, beam 1 | 0.63 s / 0.80 s / 1.2 s for the three clips, 0.44 GB, every word right including "Null" and "Jigga" with the name hint list |
| `small.en` / `large-v3-turbo` | 1.9 s / 7.7 s for the 3 s clip: too slow, rejected |
| Kokoro ONNX fp32 (kokoro-onnx 0.6.1) | 8-word line in 0.8 s (2.2 s of speech); 4-sentence reply in 3.5 s (10.4 s of speech), about 3x faster than playback; 0.5 GB; the int8 model was no faster |
| Loading | about 1 s for Kokoro, 1–3 s for Whisper |

Expected cost before the agent starts thinking: about 1.4 s of speech work, plus the 0.7 s pause wait, plus the phone-to-VPS trip. That total is an estimate. Not measured yet: real microphone and room-noise accuracy, Smart Turn and Silero cost on this CPU, network delay, and iPhone echo removal.

## Architecture

```
iPhone app ── existing paired link (iroh or WebSocket) ── VPS apex-daemon ── 127.0.0.1 WebSocket ── voice helper
 mic, echo removal,       "voice" lines, this            installs + runs           Silero, Smart Turn,
 playback, call logic     session only                   the helper, relays        Whisper base.en, Kokoro ONNX
```

Transcripts come back to the phone, which posts them to the thread through the existing correlated voice-turn path (`room_post_to` with `client_turn_id` and `max_bot_hops: 0`). The daemon's normal checks apply to those posts.

### Decisions

- **D1. The phone runs the call.** It reuses `createVoiceController`, `createThreadVoiceBridge`, `SpeechText`, `resolveCallCommand` and the audio worklets. Only the connection to the helper is new. One call implementation serves both apps, and the daemon stays a relay.
- **D2. The daemon owns the helper on Linux x86-64.** There is no Electron on a server, so a Rust port of `desktop/voiceRuntime.mjs` installs and runs it: a pinned manifest, sha256 checks, standalone CPython, `pip install --no-index --no-deps`, atomic versioned installs, one call at a time, and unloading after 10 idle minutes.
- **D3. Same helper, new CPU engine (`--engine cpu`).** faster-whisper `base.en`, kokoro-onnx, Silero VAD run through onnxruntime, and Smart Turn v3.2 through onnxruntime plus the transformers feature extractor (as on the Mac). There is no torch on Linux, because PyPI's Linux torch pulls gigabytes of CUDA libraries. The MLX engine file stays untouched.
- **D4. Shorter first pieces.** The CPU engine speaks a long segment in short pieces (the first is about 8 words), so the first sound comes about 0.8 s after the agent's first sentence instead of about 2 s.
- **D5. Audio rides the existing phone link.** Frames travel as base64 `voice` lines, only on the session that opened the call. They never enter the event bus, replay buffer, saved sessions or logs. This needs no native or iroh changes and no new ports. Load is about 44 KB/s up, plus about 64 KB/s down while the agent speaks, well under the relay's 512 KiB/s per-client limit.
- **D6. Back-pressure on input.** The daemon acknowledges input frames. When more than about 3 s are unacknowledged, the phone drops new mic frames and shows "Weak connection". A stalled cellular link then can't fill the phone's iroh send queue, whose "busy" error closes the whole chat connection.
- **D7. Authority.** Status is read-only. Opening or warming a call needs Chat on the call's thread. Setup and cancelling setup need Full. LAN-token and local clients keep full access, as today. The capability `voice_server_v1` is advertised only where the helper is supported, and the phone shows the mic only there.
- **D8. One call per daemon.** The same paired device can take over its own stale call (a phone reconnecting after a drop). Any other device is refused with a clear message.
- **D9. Foreground calls on the phone.** The screen stays awake during a call. Leaving the app, or losing the link past the retries, ends the audio, but the agent's reply keeps going and lands in the thread. End and `stop listening` behave as on the Mac (they stop voice-owned work).
- **D10. Phone voices stay on the phone.** Per-agent voices and aliases are saved on the phone with the desktop's key format and parser. Syncing them with the Mac is later work.
- **D11. Phone UI.** The mic sits beside Send. A call panel shows the recipient, status, Mute, End, voice choice with Preview, the pause slider and Hide. A setup sheet shows the size, progress and Cancel. A call bar appears on every screen while a call is active.

## Boundaries

- The helper binds 127.0.0.1 only, takes its token on stdin (never argv), and accepts only the Origin `apex-daemon`. The protocol is helper protocol v1, with additive fields only.
- Frame limits: control objects up to 64 KiB, input audio up to 32,012 decoded bytes, at most 64 queued frames each way per call. Overflow drops input frames and never blocks chat.
- The call log (`<data>/voice-server/calls.log`) holds times, channel numbers, room ids, device labels and reasons only. No audio, transcripts or tokens.
- Daemon exit kills the helper (Linux parent-death signal plus kill-on-drop).
- The phonemizer and eSpeak-ng packages carry GPL-family licences. As on the Mac, they are downloaded from PyPI onto the user's own server, never redistributed, and the legal review stays a release gate.

## Not in this work (later)

- Calls with the phone locked or in the background (native audio).
- Phone calls to threads on the Mac (Mac daemon plus MLX helper).
- The Mac app using a server helper.
- Syncing voices between devices.
- Opus compression.
- arm64 servers.
- Cloud voices.
- A more accurate model if `base.en` mishears real speech (try `distil-small.en` first).

## Acceptance

- From the iPhone 16 Pro, on Wi-Fi and on cellular, with the Mac asleep, call an agent in a VPS thread. Hear its saved voice. History and tools work, an approval is announced but never decided by voice, interrupting works, switching agents by name works, and Mute and End work. Voices survive an app restart.
- Speakerphone: no self-transcription across 10 turns. Repeat with headphones.
- 20 turns: end of speech to first sound, p50 and p95, split into pause wait, STT, agent first text, first speech piece and network.
- Two seconds of airplane mode mid-call: chat recovers, the call ends clearly or recovers, and nothing is sent twice.
- Text chat is unaffected when voice isn't set up, setup fails, or the helper crashes. The helper unloads after 10 idle minutes, and a daemon restart leaves no orphan helper.
