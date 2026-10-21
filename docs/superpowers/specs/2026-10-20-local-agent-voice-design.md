# Local agent voice calls

Status: proposed implementation; user tested the standalone demo successfully. No product implementation is authorized by this document alone.

## Intent and agreed requirements

Call any conversational Deck agent from a microphone button beside Send, retaining that thread's history, tools, permissions, and saved messages. Whisper transcribes the human, the selected Deck agent thinks, and Kokoro speaks its reply in a separately saved voice. Voice is OFF by default. Listening is continuous only between explicit Start and End; no push-to-talk, background wake word, or terminal setup. Existing system read-aloud remains available independently.

During a call, a leading `call <name>` switches the recipient and focuses its pane. Resolve spoken names and explicit aliases to stable host/thread/participant identities; ambiguity must prompt a choice instead of guessing. One conversational agent receives each turn. Names occurring inside ordinary sentences do not switch agents. `stop listening` ends the call. A local speech pipeline does not make a cloud agent offline: transcripts still reach the selected agent's configured provider.

## Current evidence

- `/tmp/voice-test/live/live_demo.py`, `page.html`, and `mic-worklet.js` provide a working browser microphone → Silero → mlx-whisper → Kokoro → browser playback prototype. The human confirmed it works. Preserve this running demo throughout planning and implementation.
- Its pinned model names are `mlx-community/whisper-large-v3-turbo` and `mlx-community/Kokoro-82M-bf16`; tested package metadata identifies mlx-whisper 0.4.3 and mlx-audio 0.6.1. Record the full environment and model revisions before reuse, rather than assuming current upstream matches it.
- The demo buffers speech until a silence threshold; it is not native streaming Whisper and does not implement semantic end-of-turn detection. It serializes MLX work on one executor thread, generates bounded speech pieces, and uses generations to invalidate canceled replies.
- Earlier benchmark numbers are reported context, not independently repeated here. Existing demo logs contain materially different delays under load; none is a packaged Deck performance guarantee.
- `ChatPane.tsx` owns participants, `ParticipantQueues`, `roomPostTo`, approvals and `RoomEvent` subscriptions. `App.tsx` owns host selection and `focusPane`. `ParticipantConfig.backend` supports built-in CLI adapters, arbitrary CLI programs, and OpenAI-compatible agents.
- Current room deltas identify the participant but not the originating voice request. They cannot safely identify voice output when another client posts to the same agent concurrently. Add correlation before speaking live agent replies.
- `PersonalCall.tsx` and `personalSpeech.ts` provide a separate turn-based personal assistant experience. They do not provide this continuous thread call.

## Recommended implementation decisions

These are builder recommendations, not additional user decisions.

1. Initially support packaged macOS Apple Silicon. Keep speech local on the client Mac even when the selected agent runs on a remote Deck host. Other clients show unsupported status without breaking text chat. Cross-platform speech engines and cloud speech are later work.
2. Electron main manages the local helper process and installation, independent of remote agent daemons. The trusted Deck renderer owns capture/playback so microphone permission and browser AEC apply to the same acoustic path. Only daemon routing executes agent turns. A helper crash cannot stop Deck text chat.
3. Use a small asyncio WebSocket pipeline extracted from the validated demo. Pipecat was considered: it supplies transports, Silero and Smart Turn, but introduces a second lifecycle/frame system plus custom MLX adapters and dependency cost. For this first integration retain the tested pipeline and isolate turn detection behind an interface; use Pipecat's local Smart Turn analyzer if its pinned package runs within budget. This is a scoped choice, not a claim Pipecat cannot work.
4. First click offers a one-time local voice download with size, progress, cancel/retry and an explanation that agent traffic follows existing settings. Install a versioned, verified Python runtime/dependencies and pinned model snapshots under Deck's local data directory; no system pip/Homebrew/terminal, model weights in Git, or required startup download. Once ready, clicking the mic starts the helper automatically. Release must work on a clean Mac without developer Python installed.
5. The composer mic remains discoverable on supported desktop builds even before installation, since hiding it until a helper exists prevents first-use setup. Disabled capability has explanatory copy. Calls show recipient, input status, mute, End and errors. No automatic microphone reopening after errors, sleep, reload or relaunch. Unload helper after 120 seconds without a call, and on app quit.
6. Use 16 kHz mono PCM16 input and 24 kHz mono PCM16 output, explicit sample rates, 512-sample input frames and bounded queues. Silero detects starts; initial 700 ms quiet threshold is adjustable 300–2000 ms. Add and measure a local semantic turn analyzer before claiming smart endpointing; incomplete thoughts can defer commitment up to 2000 ms quiet. Keep a 640 ms preroll. Long utterances use overlapping 25-second chunks with stable-prefix assembly; partial text never dispatches actions.
7. Require effective echo cancellation and full-duplex barge-in for normal speaker mode. Request echo cancellation/noise suppression/AGC, inspect actual track settings, and test acoustically in the packaged app. Constraints alone prove nothing. If AEC fails, gate transcription during playback as an explicitly degraded mode and recommend headphones; this mode cannot claim full-duplex interruption. If necessary, implement a native macOS voice-processing audio path before shipping normal speaker mode.
8. On speech onset, flush local playback immediately and invalidate queued synthesis. Stop only a correlated voice-owned agent turn through existing cancellation, then wait for its terminal/cleanup state before dispatching the replacement. Do not stop unrelated text work or assume a canceled Python future stops an active MLX kernel. End stops audio immediately, removes pending voice turns, and stops only voice-owned work; it never undoes effects already performed.
9. Preserve actual agent text in history. Speak plain prose incrementally after sentence boundaries, skipping fenced/inline code, tool arguments and paths; bound chunks to 22 words. For slow turns, speak a local `On it` once after 800 ms without agent speech. Request a concise plain-language opening/summary through call-specific adapter guidance, without permanently rewriting personas. If a response contains only code, say `The result is in the thread` rather than fabricate a summary. Approvals/questions stay in Deck controls; announce and focus them, never interpret a spoken yes as approval.
10. Persist voice and aliases by stable host/profile identity with thread-participant override; renames preserve the voice and unrelated same-named bots do not share it. Default recommendation: `am_michael`, freely configurable from the installed voice catalog, with an audition button. Unknown/removed voices show a choice instead of silently replacing preferences.

## Boundaries and observability

Single active desktop call across windows; switching recipient invalidates old audio before changing scope. Authenticated, loopback-only helper socket with per-run random token, exact allowed Deck origins, schema/length limits, one owner and bounded audio/control queues. No helper HTTP page, arbitrary URL, API keys, or agent execution. Tokens cross trusted IPC only and are not written to logs. The helper accepts audio/text and emits transcripts/audio/timing; Deck decides agent identities.

Use call ID, generation, utterance ID and agent request ID throughout; deduplicate transcript commits and reject stale audio/events. Do not replay sends after an ambiguous disconnect. Preserve normal thread history on interruption and track heard audio separately; never truncate the saved agent answer to what was heard.

Log durations only by default: endpoint wait, STT, queue, agent first text, first speakable sentence, TTS first chunk, actual playback start, interruption flush and peak memory. Audio/transcript debug capture requires explicit opt-in. No fabricated sub-second promise: speech-only echo and real-agent latency must be reported separately, with p50/p95 and load conditions.

## Acceptance

A clean packaged install can set up voice, call a CLI or API agent in an existing thread, retain tools/history, hear a distinct saved voice, interrupt safely, switch agents by name, handle an approval and end with the microphone closed. Speaker playback must not send its own words to an agent; noise, coughing and natural pauses need real microphone tests. Remote agents must use the same local speech helper. Text-only startup must remain unchanged when disabled, installation fails or the helper is missing.

Target warm speech-only echo p50 ≤1.8 s with the 700 ms threshold on this Mac, measuring p95 rather than asserting it; target local playback flush ≤150 ms after confirmed speech onset. These are proposed release thresholds, not observed results. Any failure must be reported before merge/release. API and CLI thinking time remains separately measured. No merge, push, app replacement or DMG is part of writing this plan.
