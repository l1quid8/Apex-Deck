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

Local Python suite: 28 tests passed, including CPU selection/timing, cancellation
and socket/long-reply coverage;
one Linux-only real-model test skipped on Mac and passed on the VPS in each of
the five runs. The full 24-test suite also passed on Linux before the final
cancellation and CPU-socket additions.

## Rehearsal

Pending: daemon-managed installation, two sets of ten synthetic voice turns,
channel isolation/access tests, flow-control stall, memory, idle unload and
process cleanup. No deployment or device testing is claimed from engine tests.

## iPhone

Pending after the isolated rehearsal and explicit live-service deployment and
iPhone installation approval. Check Wi-Fi/cellular, speaker echo (ten turns),
interruptions, routing, mute, approvals, airplane-mode recovery, foreground exit,
voice persistence and twenty timed turns with the Mac unavailable.
