# VPS voice verification

## Engine on the VPS — 2026-10-21

Isolated scratch runtime on Intel Xeon E3-1270 v6, CPU only. No live daemon
restart or agent service modification. Five fresh-process real-model tests
passed. Each synthesized a fixed test command, resampled it to 16 kHz, checked
transcription for Null/build, exercised Silero and Smart Turn, and synthesized
the first clause of a longer reply. No human microphone input was recorded.

| Stage | Median | Worst of five |
| --- | ---: | ---: |
| Load and warm engines | 2.97 s | 3.08 s |
| Full command synthesis | 1.34 s | 1.34 s |
| First short clause synthesis | 0.78 s | 0.79 s |
| Transcribe synthetic command | 0.60 s | 0.62 s |
| Smart Turn | 105 ms | 113 ms |

Smart Turn remained below 200 ms in all five runs. This does not measure room
noise, acoustic echo, phone transport latency, agent response latency, or human
turn-ending accuracy. Those require the end-to-end rehearsal and device checks.

The generated runtime downloads 707,312,382 bytes; installation reserves
2,121,937,146 bytes. All Python/wheel/model artifacts have manifest SHA-256
values. Offline import check passed with no torch, CUDA or MLX dependencies.
`espeakng-loader` uses a `py3-none-manylinux…x86_64` wheel, accepted alongside
CPython and abi3 manylinux wheels after the pinned interpreter resolved it.

The helper suite contains 31 tests, including exclusive daemon authentication,
CPU selection/timing, cancellation and socket/long-reply coverage. The Linux-only
real-model test skips on Mac and passed on the VPS in each of the five runs. The final full 31-test suite also passed on Linux, including the daemon-only
authentication acknowledgment. Peak engine-test RSS was 837,908 KiB (818 MiB).

## Rehearsal — 2026-10-21

A second Linux release daemon used separate scratch data, a loopback-only port
and an SSH tunnel. The live daemon, agents, paired devices and saved threads
were not modified. The Node smoke client used the same daemon link and voice
transport as the phone, without microphone capture or agent-message dispatch.

- Daemon-managed setup: **707,312,382 bytes in 26.422 seconds**, including offline
  wheel install, model verification and the import check before activation.
- Baseline: **20/20 synthetic audio round trips** across a cold and warm call.
- Call open: **3,249 ms cold**, **175 ms warm**.
- Synthesis to first audio: **1,319 ms p50**, **1,332 ms p95** for the complete
  fixed command (shorter than the chunk-splitting threshold).
- Speech end to transcript: **1,432 ms p50**, **1,485 ms p95**, including pause
  detection and the test client's network trip; no agent thinking time included.
- Helper RSS sampled during the run: **851,520 KiB (832 MiB)**.
- Four-second tunnel stall: client reported weak, then recovered; **2/2 turns
  passed**, the following warm call worked, and no daemon panic appeared.
- Daemon shutdown during a turn: helper stopped within **20 ms**; the test client
  reported disconnection rather than pretending that audio was still live.
- After restart: **2/2 more turns passed**, cold open 3,252 ms and warm 169 ms.
- Ten-minute idle unload: observed stopped at **601 seconds** (two-second
  sampling). The helper stayed loaded at 541 seconds, and the daemon logged
  its unload. The rehearsal daemon, tunnel and scratch install were removed;
  the separate model-generation and original benchmark folders were retained.

The synthetic utterance was: “Hey Null, can you check why the build failed on
main?” The smoke runner prints only timings and assertions, never transcripts,
audio, tokens or device identities. Real microphone/noise/echo and agent latency
remain device acceptance work, not claims from this transport rehearsal.

## Regression and build checks

- TypeScript: `npx tsc --noEmit` passed.
- JavaScript: **1,832 passed**, including real Chromium call-sheet interactions.
- Mac Rust: **1,192 passed**, eight existing ignored tests.
- Linux Rust: **1,186 passed**, five existing ignored tests.
- Python: **31 passed on Linux**; 30 passed plus the Linux-only real-model skip
  with the managed Mac Python.
- Remote-feature voice tests and compilation passed.
- `npm run iphone:sync` and unsigned generic-device `xcodebuild` passed. This is
  a build check; it does not validate audio on a physical iPhone.
- Five 393×852 dark UI states were rendered and inspected outside Git.

Two existing test-environment issues were corrected: the Linux Docker image
needed Python for CLI fixtures, and a scripted gateway fixture requested API
scopes that caused real Mac Keychain access. That fixture now requests only its
scripted-profile scope; production gateway behavior is unchanged.

## Review decisions and fixes

- CPU wheel validation accepts `py3-none-manylinux…x86_64` for the bundled
  eSpeak linguistic library, as well as CPython/abi3 manylinux wheels. Hashes,
  platform resolution and offline import checks still apply.
- A saturated voice relay ends only that voice channel clearly, preserving the
  chat link; it does not queue unlimited audio or silently keep a dead call live.
- The daemon-only helper authentication acknowledgment proves exclusive socket
  ownership before a new call opens. Same-device takeover aborts the stale relay
  and retries only its explicit busy response; the Mac helper path is unchanged.
- Runtime cleanup carries the acquired runtime identity, preventing a late
  reconnect from leaking its channel or closing a newer call.
- Review regressions cover cancellation before the next synthesis piece and
  resolving ambiguous spoken agent names while a call remains active.

## iPhone

Pending after the isolated rehearsal and explicit live-service deployment and
iPhone installation approval. Check Wi-Fi/cellular, speaker echo (ten turns),
interruptions, routing, mute, approvals, airplane-mode recovery, foreground exit,
voice persistence and twenty timed turns with the Mac unavailable.
