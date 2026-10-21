# Local voice (Moshi)

Click the microphone next to the ApexAgent call button. Voice is off until clicked. On first use, approve the approximately 5.2 GB model download; Deck also installs its own Python runtime. Setup status appears in Deck. There is no terminal command, system Python requirement, API key, or remote server to configure.

A separate local call window opens and asks for microphone access. Use headphones. Mute microphone sends silence; End call or closing the voice window stops audio and the complete helper process group. Quitting Deck also stops it. Calls last up to 30 minutes; Start again starts a fresh helper and conversation. This is a direct conversation with Moshi: it does not read your chats, call Deck tools, or replace the existing assistant call. Moshi may speak while you are still speaking; this integration does not add a response-delay control.

Supported: Apple Silicon Macs. Runtime, model cache, and assets live under `~/Library/Application Support/dev.apexdeck.app/voice/moshi` (or `APEX_DECK_DATA_DIR/voice/moshi`). They remain after calls. First setup needs internet; inference uses the cached files with Hugging Face offline mode enabled. Cloud voice connectors are a separate integration.

## Implementation and attribution

Electron manages the client-local helper independently of the selected daemon/host. The isolated call window has no preload and only permits authenticated loopback traffic and microphone permission. All other permissions and external navigation are denied.

The installer verifies the pinned uv 0.9.4 macOS arm64 archive's SHA-256, installs managed Python 3.12 and `moshi_mlx==0.3.0`, then downloads the q4 model and Mimi codec. Python dependencies are installed as wheels. Kyutai's concurrent model/Mimi inference pipeline is unchanged; the small transport adapter replaces Opus packets with float32 mono PCM at 24 kHz. The AudioWorklet resamples the device input and bounds outgoing/incoming queues. This adapter is coupled to the pinned runner version and must be smoke-tested when upgrading.

- [Kyutai Moshi and MLX inference](https://github.com/kyutai-labs/moshi): MIT / Apache-2.0 upstream; the installed moshi_mlx package includes its MIT license.
- [Moshiko MLX q4 model](https://huggingface.co/kyutai/moshiko-mlx-q4): Kyutai, CC BY 4.0. Attribution is also shown in the call window.
- [uv](https://github.com/astral-sh/uv): MIT / Apache-2.0.

## Verification

`npm test` covers lifecycle, cancellation/retry, audio framing/resampling/backpressure and the launch UI. `npx tsc --noEmit` checks the renderer integration. Run the Python adapter tests with a Moshi environment: `<voice-root>/venv/bin/python tests/moshi_runner_test.py`.

For an actual model handshake and streaming audio check:

```sh
MOSHI_SMOKE_ROOT="/path/to/voice/moshi" node tests/moshi-smoke.mjs
```

An empty root can test first-use installation with `MOSHI_SMOKE_INSTALL=1`; it downloads the runtime and model. The smoke verifies unauthorized HTTP/WebSocket rejection, authenticated handshake, five finite 24 kHz audio frames, and helper shutdown. It does not substitute for an audible microphone/playback test in the packaged app.
