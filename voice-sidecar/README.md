# Local agent calls

Optional Apple Silicon macOS speech service. Voice is off until a person starts a call with the mic beside Send. Deck owns the microphone and playback, Whisper transcribes, the existing thread agent does the work, and Kokoro speaks prose. No independent chat model or agent credentials run here.

## Setup

Open a thread and click the mic beside Send. Choose a recipient if the thread has several agents. On an unprepared Mac, accept the local voice download; Deck downloads a private Python, pinned dependencies and model files without system Python, pip or terminal commands. Download progress, cancel/retry and explicit Start are in the call panel. The manifest records the actual bytes and requires three times that space during installation. Models are not bundled in Git or the DMG.

Use the in-call voice selector and Preview for each agent. Preferences and spoken aliases use stable host/participant/thread keys. Say `call <name>` at the beginning of an utterance to switch among agents in open threads on the same host. Ambiguous names require a choice. `stop listening`, End, window close and suspend close the microphone. Mute discards partial input; unmuting does not send old speech. No spoken utterance approves tools; use the thread's approval cards.

The pause slider applies on the next call. Silero detects onset; pinned Smart Turn v3.2 analyzes incomplete thoughts during silence and may defer until two seconds quiet. Whisper is chunked, not a native streaming STT model; long input is assembled before one dispatch. Speech is limited to eight 25-second overlapping chunks, then the call ends rather than sending an incomplete command.

## Boundaries

Helper binds only 127.0.0.1 on a random port. Main sends a per-process token through stdin, then hands the port/token only to trusted Deck pages. The socket authenticates before audio; no HTTP UI, arbitrary agent URL, key access or agent execution exists. Input frames and playback credits are bounded; overload closes the call. MLX uses one executor. Torch VAD runs independently so synthesis does not block interruption detection. Inference cancellation invalidates generations rather than attempting to kill a native kernel.

STT defaults to English with available agent names as hints. Kokoro exposes installed English voices. Local speech does not make cloud agents offline: transcripts still go to the selected agent's provider. An assistant task execution conversation retains its separate owner orchestration and is currently rejected; call its agent in a regular thread.

Default logs contain status and timings, not audio/transcripts. Installation resources live under `~/Library/Application Support/dev.apexdeck.app/voice/`; runtime versions activate atomically. End releases the owner immediately after voice-owned agent cleanup; helper exits after 120 seconds idle. App quit stops it. Text chat works if installation, permission or helper startup fails.

## Developer verification

```bash
PYTHONPATH=voice-sidecar python3 -m unittest discover -s voice-sidecar/tests -v
node --experimental-strip-types --test tests/voice-*.test.mjs
node --experimental-strip-types --test tests/e2e/voice.e2e.mjs
```

The deterministic tests use fake speech engines. Real-model results and remaining acoustic/package gates are in `docs/voice-local-verification.md`. Keep the independently running `/tmp/voice-test` demo untouched.

## Pinned components and notices

`runtime-manifest.json` contains immutable model revisions, standalone Python archive hash, wheel URLs/hashes/sizes and dependency license metadata. `requirements.lock` snapshots the tested environment. `wheels/docopt-0.6.2-py2.py3-none-any.whl` is a cached pure-Python build of the MIT-licensed PyPI docopt 0.6.2 sdist; it is included because PyPI distributes no wheel. Its hash is in the manifest; no locally compiled native extension is bundled.

| Component | License / source |
| --- | --- |
| CPython standalone | Python PSF and bundled-library notices, included in the runtime archive; astral-sh/python-build-standalone 20261020 |
| Whisper turbo weights | MIT, mlx-community/whisper-large-v3-turbo; revision a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb |
| Kokoro weights/voices | Apache-2.0, mlx-community/Kokoro-82M-bf16; revision a71e4d38b236d968966a2002c4c895dbd12b1c3c |
| Smart Turn v3.2 CPU | BSD-2-Clause, pipecat-ai/smart-turn-v3; revision f766f81d3cfdf7737ac64aad813d91bbfd56bf93 |
| Silero VAD | MIT; pinned silero-vad wheel includes weights |
| MLX / MLX Whisper | MIT |
| MLX Audio | MIT |
| English spaCy model | MIT; pinned en_core_web_sm 3.8.0 wheel |
| Phonemizer / eSpeak-ng linguistic assets | phonemizer-fork and espeakng-loader contain GPL-family components; preserve their wheel/license notices; distribution/legal review remains a release gate |

Pipecat was considered. A small asyncio transport retains the measured demo's MLX behavior without adding a second frame/lifecycle abstraction. The Smart Turn model is reused directly through ONNX Runtime and WhisperFeatureExtractor, following its upstream inference implementation. An orchestration framework would not remove Deck's thread-correlation or browser-audio responsibilities.
