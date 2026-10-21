# VPS Voice Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Call any agent in a VPS thread from the iPhone app's mic beside Send, with listening and speaking running on the VPS, so calls work with the Mac off.

**Architecture:** The phone keeps the existing call logic (controller, thread bridge, speech splitting, audio worklets). It reaches a voice helper on the VPS through its existing paired link, using `voice` lines scoped to one daemon session. The Linux `apex-daemon` installs a pinned CPU speech runtime on first use and runs the existing helper with a new CPU engine (faster-whisper `base.en`, Kokoro ONNX, Silero ONNX, Smart Turn). Transcripts post through the existing correlated voice-turn path, so history, tools and approvals work as they do on the Mac.

**Tech Stack:** Rust (tokio, tokio-tungstenite, reqwest, sha2), standalone CPython 3.11 (faster-whisper, ctranslate2, kokoro-onnx, onnxruntime, transformers, websockets), TypeScript/React phone app, Capacitor 8 with one small Swift plugin.

**Spec:** `docs/superpowers/specs/2026-10-21-vps-voice-helper-design.md`. It builds on `docs/superpowers/specs/2026-10-20-local-agent-voice-design.md` and the shipped Mac voice code in `src/voice/`, `voice-sidecar/` and `desktop/voiceRuntime.mjs`.

## Global Constraints

- Voice is off by default. The mic is live only between the person's Start and End: no wake word, no push-to-talk.
- The server helper is supported only on `linux` + `x86_64` daemons. Everywhere else `voice_server_status` says why, and `voice_server_v1` is not advertised.
- Models:
  - `Systran/faster-whisper-base.en` at revision `3d3d5dee26484f91867d81cb899cfcf72b96be6c` (`compute_type="int8"`, `beam_size=1`, `language="en"`).
  - `kokoro-v1.0.onnx` + `voices-v1.0.bin` from the kokoro-onnx release `model-files-v1.0`.
  - Smart Turn v3.2 CPU, using the Mac manifest's exact entry.
  - Silero VAD as `data/silero_vad.onnx` from the `silero-vad==6.2.3` wheel, run through onnxruntime.
- Runtime: `cpython-3.11.17+20261020-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz` from python-build-standalone.
- Pins: `faster-whisper==1.2.1`, `ctranslate2==4.8.3`, `kokoro-onnx==0.6.1`, `onnxruntime==1.31.0`, `transformers==5.20.2`, `websockets==17.3`, and `silero-vad==6.2.3` with no dependencies. Never `torch`, `torchaudio`, `triton`, `nvidia-*` or `mlx*`.
- Every downloaded file is sha256-checked against `voice-sidecar/runtime-manifest-linux-x86_64.json`.
- Install with `pip install --no-index --no-deps` into `<data>/voice-server/<version>`, through a staging folder and an atomic rename. No system Python, no model weights in Git.
- Audio formats don't change: 16 kHz mono PCM16 input in 512-sample frames, and 24 kHz mono PCM16 output. Helper protocol v1 gets additive fields only.
- `voice` frames go only to the session that opened the call. They never enter the host event bus, the replay buffer, saved sessions or logs.
- Limits:
  - Helper control objects: at most 64 KiB.
  - Mic frames: at most 32,012 decoded bytes.
  - Queued frames: at most 64 each way per call.
  - The phone stops sending mic frames at 96 unacknowledged and resumes below 32.
- One call per daemon; the same paired device may take over its own call.
- The helper unloads 600 s after the last call or warm-up. Daemon exit kills the helper.
- Authority:
  - `voice_server_status` and `voice_server_close` need ReadOnly, global read.
  - `voice_server_open` and `voice_server_warm` need Chat on `room`.
  - `voice_server_install` and `voice_server_install_cancel` need Full, global.
- The phone calls only while the app is on screen, and keeps the screen awake during a call. Leaving the app ends the audio with `keepWork: true`.
- Phone voice choices live in `localStorage` key `apex-deck.phone.voice.v1`.
- The Mac app's behaviour doesn't change; its local MLX helper stays the path for Mac calls.
- The repo is public: no transcripts of the human, hostnames, IP addresses, device ids or real-data screenshots in commits.
- AGENTS.md rules apply:
  - Work on `feat/vps-voice-helper` in the main folder.
  - Run `npx tsc --noEmit` before any merge.
  - Run the desktop dev build only via `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`.
  - Build DMGs only from `release/`.
  - Delete the branch after an authorized merge.
- Other bots edit this folder at the same time. Run `git status` before each commit and stage only this plan's files.
- Restarting the VPS daemon kills bots running there. Deploy only with the human's go, when no bot there is mid-reply.

## Review Focus

- **A cellular stall mid-call must not close the chat link.** The mic backs off, the call ends or recovers clearly, and no transcript is posted twice (tests in Tasks 5, 6 and 9).
- **A second phone, or the same phone reconnecting, while a call is open.** Another device can't take the call; the same device's new connection replaces its stale one (Tasks 4 and 5).
- **Interrupted setup** (cancel, bad hash, full disk, failed import check, a daemon restart mid-download). It never reports "installed" early, and a retry reuses verified downloads (Task 3).
- **A thread on the Mac, or a server running an older daemon.** The phone shows no mic and text chat is unchanged (Tasks 5 and 7).
- **Leaving the app, an incoming phone call, or the link dropping mid-reply.** The audio stops and the mic is released, but the agent's reply still lands in the thread (Tasks 6 and 7).

## Wire contract (used by Tasks 5, 6, 7 and 9)

Requests use the normal `{id, cmd, args}` frame and get a normal reply:

| `cmd` | `args` | `ok` |
| --- | --- | --- |
| `voice_server_status` | `{}` | `VoiceStatus` |
| `voice_server_install` | `{}` | `null` once setup has started, or at once if already installed |
| `voice_server_install_cancel` | `{}` | `null` |
| `voice_server_warm` | `{room}` | `null` once the helper is loaded |
| `voice_server_open` | `{room}` | `{channel, protocolVersion: 1}` |
| `voice_server_close` | `{channel, reason}` | `null`, also for an unknown or closed channel |

`VoiceStatus` is camelCase JSON:
`{supported, reason?, installed, installing?: {stage, downloaded, total}, failed?, running, busy, downloadBytes, requiredDiskBytes}`.

Voice frames are one JSON object per line under the key `voice`, never with `id` or `seq`:

| Direction | Frame | Meaning |
| --- | --- | --- |
| phone → daemon | `{"voice":{"channel":N,"ctl":{…}}}` | Helper control (`start`, `speak`, `cancel`, `playbackProgress`, `playbackComplete`, `end`). `auth` is refused. At most 64 KiB. |
| phone → daemon | `{"voice":{"channel":N,"bin":"<base64>"}}` | One helper audio frame: the 12-byte `DV` header plus PCM16, at most 32,012 decoded bytes |
| daemon → phone | `{"voice":{"channel":N,"ctl":{…}}}` | Helper event (`ready`, `speechStart`, `transcript`, `audioStart`, `audioEnd`, `timing`, `error`) |
| daemon → phone | `{"voice":{"channel":N,"bin":"<base64>"}}` | Helper audio |
| daemon → phone | `{"voice":{"channel":N,"rx":S}}` | Sent after every 16th mic frame relayed; `S` is that frame's sequence number (u32 LE at header bytes 8–11) |
| daemon → phone | `{"voice":{"channel":N,"closed":"<reason>"}}` | Sent once; nothing else follows for `N` |

Older daemons answer `voice_server_*` with an error. Older clients already drop id-less lines that have no `err` (`src/daemon/client.ts` `receive`).

---

### Task 1: Pin the Linux speech runtime

**Files:**
- Create: `voice-sidecar/requirements-linux.in`
- Create: `scripts/voice-linux-manifest.py`
- Create (generated, committed): `voice-sidecar/runtime-manifest-linux-x86_64.json`, `voice-sidecar/requirements-linux.lock`
- Test: `voice-sidecar/tests/test_linux_manifest.py`

**Interfaces:**
- Produces a manifest in the same schema as `voice-sidecar/runtime-manifest.json`, with `"version": "1"`, `"platform": "linux"` and `"arch": "x86_64"`. Task 3 embeds it.
- Produces `python3 -I scripts/voice-linux-manifest.py --sidecar DIR --work DIR [--install-to DIR]`. `--install-to` performs Task 3's install by hand, so Task 2 can run the real models.
- Import check, shared with Task 3:
  `import ctranslate2, faster_whisper, kokoro_onnx, onnxruntime, websockets; from transformers import WhisperFeatureExtractor; import importlib.util; assert importlib.util.find_spec("silero_vad"); print("ok")`

- [ ] **Step 1: Write the failing test**

```python
import json, pathlib, unittest
SIDE = pathlib.Path(__file__).resolve().parents[1]
WHISPER_REV = '3d3d5dee26484f91867d81cb899cfcf72b96be6c'

class LinuxManifestTests(unittest.TestCase):
    def setUp(self):
        self.m = json.loads((SIDE / 'runtime-manifest-linux-x86_64.json').read_text())

    def test_pins_platform_python_and_packages(self):
        m = self.m
        self.assertEqual((m['version'], m['platform'], m['arch']), ('1', 'linux', 'x86_64'))
        self.assertEqual(m['python']['url'], 'https://github.com/astral-sh/python-build-standalone/releases/download/20261020/cpython-3.11.17%2B20261020-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz')
        pins = {w['name'].lower(): w['version'] for w in m['wheels']}
        for name, version in {'faster-whisper': '1.2.1', 'ctranslate2': '4.8.3', 'kokoro-onnx': '0.6.1', 'onnxruntime': '1.31.0',
                              'transformers': '5.20.2', 'websockets': '17.3', 'silero-vad': '6.2.3'}.items():
            self.assertEqual(pins.get(name), version, name)
        self.assertEqual([n for n in pins if n in ('torch', 'torchaudio', 'triton') or n.startswith(('nvidia-', 'mlx'))], [])
        for w in m['wheels']:
            self.assertRegex(w['filename'], r'-(py3-none-any|py2\.py3-none-any|cp311-cp311-manylinux.*x86_64|cp3\d+-abi3-manylinux.*x86_64)\.whl$')

    def test_models_hashes_and_totals(self):
        m = self.m
        by_path = {x['path']: x for x in m['models']}
        self.assertEqual(set(by_path), {f'models/whisper-base-en/{f}' for f in ('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt')}
                         | {'models/kokoro/kokoro-v1.0.onnx', 'models/kokoro/voices-v1.0.bin', 'models/smart-turn/smart-turn-v3.2-cpu.onnx'})
        self.assertIn(f'/{WHISPER_REV}/', by_path['models/whisper-base-en/model.bin']['url'])
        self.assertEqual(by_path['models/whisper-base-en/model.bin']['sha256'], '2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef')
        self.assertEqual(by_path['models/kokoro/kokoro-v1.0.onnx']['sha256'], '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5')
        self.assertEqual(by_path['models/kokoro/voices-v1.0.bin']['sha256'], 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d')
        mac = json.loads((SIDE / 'runtime-manifest.json').read_text())
        smart = next(x for x in mac['models'] if x['path'] == 'models/smart-turn/smart-turn-v3.2-cpu.onnx')
        self.assertEqual(by_path[smart['path']], smart)
        items = [m['python'], *m['wheels'], *m['models']]
        for x in items:
            self.assertRegex(x['sha256'], r'^[0-9a-f]{64}$')
            self.assertGreater(x['size'], 0)
            self.assertTrue(x['url'].startswith('https://'))
        self.assertEqual(m['downloadBytes'], sum(x['size'] for x in items))
        self.assertEqual(m['requiredDiskBytes'], 3 * m['downloadBytes'])
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PYTHONPATH=voice-sidecar python3 -m unittest discover -s voice-sidecar/tests -p test_linux_manifest.py -v`
Expected: ERROR, `FileNotFoundError` for `runtime-manifest-linux-x86_64.json`.

- [ ] **Step 3: Write `voice-sidecar/requirements-linux.in`**

```
faster-whisper==1.2.1
ctranslate2==4.8.3
kokoro-onnx==0.6.1
onnxruntime==1.31.0
transformers==5.20.2
websockets==17.3
```

- [ ] **Step 4: Write `scripts/voice-linux-manifest.py` (standard library only)**

1. **Python.** Download the pinned archive (URL as in the test) into `--work/cache/` and extract it to `--work/python`.
2. **Resolve.** Run
   `--work/python/bin/python3 -I -m pip install --dry-run --ignore-installed --only-binary=:all: --report <work>/report.json -r <sidecar>/requirements-linux.in`.
   Using the pinned interpreter makes the wheel tags `cp311` manylinux x86_64.
3. **Wheels.** From each `install` entry, take `download_info.url`, `download_info.archive_info.hashes.sha256`, `metadata.name` and `metadata.version`. For the licence, use `metadata.license_expression`, else the first 80 characters of `metadata.license`, else `"See wheel dist-info"`.
4. **Extra wheel, no dependencies.** Add `silero-vad` 6.2.3 as the `py3-none-any` file listed at `https://pypi.org/pypi/silero-vad/6.2.3/json`.
5. **Refuse forbidden packages.** Exit 1, naming the package, if any name is `torch`, `torchaudio` or `triton`, or starts with `nvidia-` or `mlx`.
6. **Models.**
   - `https://huggingface.co/Systran/faster-whisper-base.en/resolve/3d3d5dee26484f91867d81cb899cfcf72b96be6c/{config.json,model.bin,tokenizer.json,vocabulary.txt}` → `models/whisper-base-en/<file>`
   - `https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/{kokoro-v1.0.onnx,voices-v1.0.bin}` → `models/kokoro/<file>`
   - Copy the Smart Turn entry from `<sidecar>/runtime-manifest.json` exactly.
7. **Hash everything.** Download each file in 1 MiB chunks, compute sha256 and size, and stop if a wheel's hash differs from the report.
8. **Write the outputs.** Write the manifest (wheels sorted by name, `downloadBytes` = python + wheels + models, `requiredDiskBytes` = 3 × that) and `requirements-linux.lock` (`name==version`, one per line, sorted).
9. **`--install-to DIR`.**
   - Extract Python to `DIR/python`.
   - Run `DIR/python/bin/python3 -I -m pip install --no-index --no-deps --disable-pip-version-check <every wheel file>` with `PYTHONNOUSERSITE=1`.
   - Copy the models to `DIR/<path>`.
   - Run the import check and print its `ok`.

- [ ] **Step 5: Generate on the VPS, in a scratch folder (leave `/var/tmp/voice-bench` alone)**

```bash
VPS=<the ssh host you pass to scripts/vps-deploy.sh>
SSH_OPTS=(-o BatchMode=yes -o RemoteCommand=none -o ClearAllForwardings=yes)
ssh "${SSH_OPTS[@]}" "$VPS" 'mkdir -p /var/tmp/voice-manifest'
scp "${SSH_OPTS[@]}" -r voice-sidecar scripts/voice-linux-manifest.py "$VPS":/var/tmp/voice-manifest/
ssh "${SSH_OPTS[@]}" "$VPS" 'cd /var/tmp/voice-manifest && python3 -I voice-linux-manifest.py --sidecar voice-sidecar --work work --install-to runtime'
scp "${SSH_OPTS[@]}" "$VPS":/var/tmp/voice-manifest/voice-sidecar/runtime-manifest-linux-x86_64.json "$VPS":/var/tmp/voice-manifest/voice-sidecar/requirements-linux.lock voice-sidecar/
```

Expected: the last remote line is `ok`, and both files arrive. Note `downloadBytes`; roughly 0.7–0.9 GB is expected.

- [ ] **Step 6: Run the test and confirm it passes**

Run the Step 2 command. Expected: 2 tests OK.

- [ ] **Step 7: Commit**

```bash
git add voice-sidecar/requirements-linux.in voice-sidecar/requirements-linux.lock voice-sidecar/runtime-manifest-linux-x86_64.json voice-sidecar/tests/test_linux_manifest.py scripts/voice-linux-manifest.py
git commit -m "feat(voice): pin the Linux CPU speech runtime"
```

---

### Task 2: CPU speech engine in the helper

**Files:**
- Create: `voice-sidecar/voice_sidecar/pieces.py`, `voice-sidecar/voice_sidecar/engines_cpu.py`, `docs/voice-server-verification.md`
- Modify: `voice-sidecar/voice_sidecar/pipeline.py`, `voice-sidecar/voice_sidecar/server.py`, `voice-sidecar/README.md` (add a "Linux servers" section)
- Test: create `voice-sidecar/tests/test_pieces.py` and `voice-sidecar/tests/test_engines_cpu.py`; extend `voice-sidecar/tests/test_pipeline.py` and `voice-sidecar/tests/test_server.py`

**Interfaces:**
- Consumes: Task 1's `--install-to` runtime (`/var/tmp/voice-manifest/runtime` on the VPS) for the real-model test.
- Produces:
  - `server.py --engine {mlx,cpu}`. The default stays `mlx`, because the desktop passes no flag.
  - `speech_pieces(text: str, first: int = 8, rest: int = 14) -> list[str]`.
  - `Pipeline(send, synth, pieces=None)`. `speak(request_id, segment_id, text, voice)` returns the milliseconds until its first audio chunk was sent, or `None` if cancelled before any audio.
  - The speaker's `timing` event gains `ttsFirstMs`.
  - `engines_cpu.Engines(root)` has the same members as `engines.Engines` (`voices`, `semantic_session`, `probability`, `reset`, `transcribe`, `synthesize`, `complete`) plus `pieces(text)`.
  - `engines_cpu.SileroOnnx(session)` with `__call__(pcm: bytes) -> float`, `reset()`, and `SileroOnnx.load() -> SileroOnnx`.

- [ ] **Step 1: Write the failing tests**

`voice-sidecar/tests/test_pieces.py`:
```python
import unittest
from voice_sidecar.pieces import speech_pieces
class PiecesTests(unittest.TestCase):
    def test_short_segments_stay_whole(self):
        self.assertEqual(speech_pieces('Done.'), ['Done.'])
        self.assertEqual(speech_pieces('one two three four five six seven eight nine ten eleven'), ['one two three four five six seven eight nine ten eleven'])
    def test_first_piece_ends_at_a_clause(self):
        self.assertEqual(speech_pieces('I checked the build on main, and the failure comes from the type checker, not the tests.'),
                         ['I checked the build on main,', 'and the failure comes from the type checker, not the tests.'])
    def test_a_hard_cut_never_ends_on_a_small_word(self):
        self.assertEqual(speech_pieces('Please open the settings page and change the default voice to the British one for this agent'),
                         ['Please open the settings page and change', 'the default voice to the British one for this agent'])
    def test_no_tail_under_four_words_and_later_pieces_cap_at_fourteen(self):
        self.assertEqual([len(p.split()) for p in speech_pieces('one two three four five six seven eight nine ten eleven twelve')], [8, 4])
        self.assertEqual([len(p.split()) for p in speech_pieces(' '.join(f'w{i}' for i in range(1, 23)))], [8, 14])
```

Add to `voice-sidecar/tests/test_pipeline.py`:
```python
class PiecePipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_pieces_share_one_start_and_end_with_100ms_between(self):
        sent = []
        async def send(e): sent.append(e)
        async def synth(text, voice): return b'\1\0' * (2400 if text == 'a b c' else 1200)
        pipe = Pipeline(send, synth, lambda text: ['a b c', 'd e f g']); pipe.start('c', 0)
        first_ms = await pipe.speak('r', 1, 'a b c d e f g', 'am_michael')
        kinds = [e['type'] for e in sent]
        self.assertEqual((kinds[0], kinds[-1], kinds.count('audioStart')), ('audioStart', 'audioEnd', 1))
        self.assertEqual(b''.join(e['pcm'] for e in sent if e['type'] == 'audio'), b'\1\0' * 2400 + b'\0' * 4800 + b'\1\0' * 1200)
        self.assertIsInstance(first_ms, int)
    async def test_cancel_between_pieces_sends_nothing_more(self):
        sent = []
        async def send(e): sent.append(e)
        pipe = Pipeline(send, None, lambda text: ['one two three', 'four five six'])
        async def synth(text, voice):
            if text == 'four five six': pipe.cancel(1)
            return b'\0' * 1024
        pipe.synth = synth; pipe.start('c', 0)
        await pipe.speak('r', 1, 'x', 'am_michael')
        self.assertNotIn('audioEnd', [e['type'] for e in sent])
        self.assertEqual(sum(len(e['pcm']) for e in sent if e['type'] == 'audio'), 1024)
    async def test_without_pieces_the_mac_path_is_unchanged(self):
        sent = []
        async def send(e): sent.append(e)
        async def synth(text, voice): return b'\1\0' * 3000
        pipe = Pipeline(send, synth); pipe.start('c', 0)
        await pipe.speak('r', 1, 'a b c d e f g h i j k l m', 'am_michael')
        self.assertEqual(b''.join(e['pcm'] for e in sent if e['type'] == 'audio'), b'\1\0' * 3000)
```

Add to `voice-sidecar/tests/test_server.py` a `CpuEngineTests(SocketTests)` that sets `engine='cpu'` on the args, patches `voice_sidecar.engines_cpu.Engines` with `FakeEngines`, and asserts:
- `start` gets `ready`.
- A `speak` is followed by a `timing` event with an integer `ttsFirstMs`.

`SocketTests` must read the engine with `getattr(self, 'engine', 'mlx')`, so the existing tests keep running the MLX path.

`voice-sidecar/tests/test_engines_cpu.py`:
```python
import importlib.util, json, os, unittest
@unittest.skipUnless(importlib.util.find_spec('numpy'), 'needs numpy')
class SileroOnnxTests(unittest.TestCase):
    def test_context_state_and_rate_carry_between_frames(self):
        import numpy as np
        from voice_sidecar.engines_cpu import SileroOnnx
        calls = []
        class Session:
            def run(self, _outputs, feeds):
                calls.append({k: np.array(v, copy=True) for k, v in feeds.items()})
                return [np.array([[0.75]], np.float32), np.full((2, 1, 128), len(calls), np.float32)]
        vad = SileroOnnx(Session()); frame = np.arange(512, dtype='<i2').tobytes()
        self.assertAlmostEqual(vad(frame), 0.75); vad(frame)
        self.assertEqual((calls[0]['input'].shape, int(calls[0]['sr'])), ((1, 576), 16000))
        self.assertTrue((calls[0]['state'] == 0).all() and (calls[1]['state'] == 1).all())
        np.testing.assert_allclose(calls[1]['input'][0, :64], np.arange(448, 512) / 32768, rtol=1e-6)
        vad.reset(); vad(frame)
        self.assertTrue((calls[2]['state'] == 0).all() and (calls[2]['input'][0, :64] == 0).all())

@unittest.skipUnless(os.environ.get('VOICE_CPU_ROOT'), 'set VOICE_CPU_ROOT to an installed Linux runtime')
class RealModelTests(unittest.TestCase):
    def test_round_trip_names_and_turn_check(self):
        import time, numpy as np
        from voice_sidecar.engines_cpu import Engines
        t = time.monotonic(); e = Engines(os.environ['VOICE_CPU_ROOT']); load = time.monotonic() - t
        self.assertEqual(len(e.voices), 28); self.assertIn('am_michael', e.voices); self.assertIsNotNone(e.semantic_session)
        t = time.monotonic(); spoken = e.synthesize('Hey Null, can you check why the build failed on main?', 'am_michael'); tts = time.monotonic() - t
        a = np.frombuffer(spoken, '<i2').astype(np.float32)
        pcm = np.interp(np.arange(0, len(a), 1.5), np.arange(len(a)), a).astype('<i2').tobytes()
        t = time.monotonic(); text = e.transcribe(pcm, ['Null', 'Muck', 'Jigga', 'Apex Deck']).lower(); stt = time.monotonic() - t
        self.assertIn('null', text); self.assertIn('build', text)
        self.assertGreater(max(e.probability(pcm[i:i + 1024]) for i in range(0, len(pcm) - 1024, 1024)), 0.6)
        t = time.monotonic(); self.assertIsInstance(e.complete(pcm), bool); turn = time.monotonic() - t
        piece = e.pieces('I checked the build on main, and the failure comes from the type checker, not the tests.')[0]
        t = time.monotonic(); e.synthesize(piece, 'am_michael'); first = time.monotonic() - t
        print(json.dumps({'loadS': round(load, 2), 'ttsS': round(tts, 2), 'firstPieceS': round(first, 2), 'sttS': round(stt, 2), 'smartTurnMs': round(turn * 1000)}))
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `PYTHONPATH=voice-sidecar python3 -m unittest discover -s voice-sidecar/tests -v`
Expected: ERROR, `ModuleNotFoundError: voice_sidecar.pieces`. Also `TypeError` from `Pipeline(..., pieces)`.

- [ ] **Step 3: Implement `speech_pieces` in `voice-sidecar/voice_sidecar/pieces.py`**

```
words = text.split(); if not words: return []
if len(words) <= first + 3: return [' '.join(words)]
pieces, start, limit = [], 0, first
while len(words) - start > limit:
    window = words[start:start + limit]
    cut = last i >= 3 (1-based) where window[i-1] ends with ',', ';' or ':' or is '—', '–' or '-'
    if no such i: cut = limit, then step back while cut > 3 and window[cut-1].lower().strip('.,;:!?') is in
        SMALL = {a, an, the, to, of, and, or, but, for, in, on, at, with, from, by, my, your, our, their, this, that}
    if len(words) - (start + cut) < 4: break        # keep a short tail with this piece
    pieces.append(' '.join(window[:cut])); start += cut; limit = rest
pieces.append(' '.join(words[start:])); return pieces
```

- [ ] **Step 4: Stream pieces in `pipeline.py` and select the engine in `server.py`**

**`Pipeline.speak`:**
- Synthesize each piece in turn.
- After each `synth`, keep the existing `(generation, call_id)` check.
- Send `audioStart` once, before the first piece's audio.
- Before each later piece's audio, send 4,800 zero bytes (100 ms at 24 kHz).
- Send `audioEnd` once, after the last piece.
- Return the milliseconds from the call until the first audio chunk was sent.

**`server.py`:**
- Add `--engine` (`choices=['mlx', 'cpu']`, default `mlx`). Read it with `getattr(args, 'engine', 'mlx')`, because existing tests build `args` without it, and import `Engines` from `.engines_cpu` or `.engines`.
- Build `Pipeline(send, synth, getattr(engines, 'pieces', None))`.
- Add `ttsFirstMs` to the speaker loop's `timing` event when `speak` returns a number.

- [ ] **Step 5: Implement `voice-sidecar/voice_sidecar/engines_cpu.py` with these pinned values**

- `threads = max(2, (os.cpu_count() or 4) - 2)`.
- **Whisper.**
  - Load with `WhisperModel(str(root/'models'/'whisper-base-en'), device='cpu', compute_type='int8', cpu_threads=threads)`.
  - `transcribe(pcm, hints)` calls `model.transcribe(audio, language='en', beam_size=1, temperature=0.0, condition_on_previous_text=False, initial_prompt=', '.join(hints) or None, vad_filter=False)` and consumes the segments.
  - It returns `''` when there are no segments, or when every segment has `no_speech_prob > .8`, as `engines.py` does.
- **Kokoro.**
  - Load an `onnxruntime.InferenceSession(str(root/'models'/'kokoro'/'kokoro-v1.0.onnx'), sess_options, providers=['CPUExecutionProvider'])` with `intra_op_num_threads=threads` and `inter_op_num_threads=1`.
  - Wrap it with `Kokoro.from_session(session, str(root/'models'/'kokoro'/'voices-v1.0.bin'))`.
  - `voices` holds the sorted names from `get_voices()` that match `[ab][fm]_[a-z]+` (28 on v1.0).
  - `synthesize` calls `create(text, voice=voice, speed=1.0, lang='en-us' if voice[0] == 'a' else 'en-gb')`, raises `ValueError` unless the rate is 24000, and converts to int16 as `engines.py` does.
- **Silero.**
  - `SileroOnnx.load()` opens `importlib.util.find_spec('silero_vad').submodule_search_locations[0] + '/data/silero_vad.onnx'` with a 1-thread session. Never `import silero_vad`, because it imports torch.
  - Inputs: `input` float32 `(1, 576)` (64 context samples plus the frame ÷ 32768), `state` float32 `(2, 1, 128)` and `sr` int64 16000.
  - Outputs: `output` `(1, 1)` and `stateN`. `reset()` zeroes the state and the context.
- **Smart Turn.** Copy `engines.py` lines 15–21 and 42–48 exactly, with a 1-thread session. Leave `engines.py` itself untouched: this copy is deliberate, so the shipped Mac path doesn't change.
- **Warm-up.** In `__init__`, transcribe 1 s of zeros and synthesize `"Ready."` with `am_michael`, as `engines.py` does.
- `pieces = staticmethod(speech_pieces)`.

- [ ] **Step 6: Run the unit tests on the Mac**

```bash
PYTHONPATH=voice-sidecar python3 -m unittest discover -s voice-sidecar/tests -v
PYTHONPATH=voice-sidecar "$HOME/Library/Application Support/dev.apexdeck.app/voice/2/python/bin/python3" -m unittest discover -s voice-sidecar/tests -v
```

Expected: all pass. The second command also runs the socket and `SileroOnnxTests`; `RealModelTests` skips.

- [ ] **Step 7: Run the real models on the VPS, five times**

```bash
scp "${SSH_OPTS[@]}" -r voice-sidecar "$VPS":/var/tmp/voice-manifest/src
ssh "${SSH_OPTS[@]}" "$VPS" 'cd /var/tmp/voice-manifest/src && for i in 1 2 3 4 5; do PYTHONPATH=. VOICE_CPU_ROOT=/var/tmp/voice-manifest/runtime /var/tmp/voice-manifest/runtime/python/bin/python3 -m unittest discover -s tests -p test_engines_cpu.py 2>&1 | grep loadS; done'
```

Expected: five JSON lines and no failures.
- Record the median and the worst of each figure in `docs/voice-server-verification.md`, under "Engine on the VPS", with the date and the CPU model only.
- If `smartTurnMs` p95 is over 200, say so there. The engine then ships with Smart Turn, and the human decides whether to turn it off.

- [ ] **Step 8: Document and commit**

Add a short "Linux servers" section to `voice-sidecar/README.md` covering the engine flag, the models, the daemon-managed install and the fact that there is no torch on Linux. Then:

```bash
git add voice-sidecar/voice_sidecar/pieces.py voice-sidecar/voice_sidecar/engines_cpu.py voice-sidecar/voice_sidecar/pipeline.py voice-sidecar/voice_sidecar/server.py voice-sidecar/README.md voice-sidecar/tests/test_pieces.py voice-sidecar/tests/test_engines_cpu.py voice-sidecar/tests/test_pipeline.py voice-sidecar/tests/test_server.py docs/voice-server-verification.md
git commit -m "feat(voice): add a CPU speech engine for Linux servers"
```

---

### Task 3: Daemon voice setup (manifest, install, status)

**Files:**
- Create: `crates/apex-daemon/src/voice/mod.rs`, `crates/apex-daemon/src/voice/manifest.rs`, `crates/apex-daemon/src/voice/install.rs`
- Modify:
  - `crates/apex-daemon/src/lib.rs` (`pub mod voice;`)
  - `crates/apex-daemon/src/protocol.rs` (`pub voice: Arc<crate::voice::VoiceServer>` on `Daemon`, built in `Daemon::start` from `paths.data`)
  - `crates/apex-daemon/Cargo.toml` (`reqwest = { version = "0.13", features = ["stream"] }`, `async-trait.workspace = true`)
- Test: unit tests in `manifest.rs`, `install.rs` and `mod.rs`

**Interfaces:**
- Consumes: `voice-sidecar/runtime-manifest-linux-x86_64.json`, as `manifest::LINUX_X86_64 = include_str!("../../../../voice-sidecar/runtime-manifest-linux-x86_64.json")`.
- Produces (used by Tasks 4 and 5):

```rust
// manifest.rs
pub struct Manifest { pub version: String, pub platform: String, pub arch: String, pub python: Item, pub wheels: Vec<Wheel>, pub models: Vec<Model>, pub download_bytes: u64, pub required_disk_bytes: u64 }
pub struct Item { pub url: String, pub sha256: String, pub size: u64 }
pub struct Wheel { pub name: String, pub version: String, pub filename: String, pub item: Item }   // item flattened in JSON
pub struct Model { pub path: String, pub item: Item }
pub fn parse(text: &str) -> Result<Manifest, String>;   // refuses non-https urls, non-hex sha256, size 0, model paths not under models/ or with "..", wrong totals
// install.rs
#[async_trait] pub trait Fetch: Send + Sync { async fn fetch(&self, url: &str, max_bytes: u64, to: &Path, progress: &(dyn Fn(u64) + Send + Sync), cancel: &Cancel) -> Result<(), String>; }
#[async_trait] pub trait Run: Send + Sync { async fn run(&self, program: &Path, args: &[OsString], env: &[(&str, String)], cancel: &Cancel) -> Result<(), String>; }
#[derive(Clone, Default)] pub struct Cancel(Arc<AtomicBool>);
// mod.rs
pub struct Deps { pub fetch: Arc<dyn Fetch>, pub run: Arc<dyn Run>, pub free_bytes: Arc<dyn Fn(&Path) -> Result<u64, String> + Send + Sync> }
#[derive(Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub struct Progress { pub stage: String, pub downloaded: u64, pub total: u64 }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct VoiceStatus { pub supported: bool, pub reason: Option<String>, pub installed: bool, pub installing: Option<Progress>, pub failed: Option<String>, pub running: bool, pub busy: bool, pub download_bytes: u64, pub required_disk_bytes: u64 }
impl VoiceServer {
    pub fn new(data: &Path) -> Arc<VoiceServer>;  // real Deps, platform_support(), manifest::LINUX_X86_64
    pub fn with(data: &Path, support: Result<(), String>, manifest_text: &str, deps: Deps) -> Arc<VoiceServer>;
    pub fn status(&self) -> VoiceStatus;
    pub fn install(self: &Arc<Self>) -> Result<(), String>;  // Ok at once when already installed; spawns otherwise
    pub fn cancel_install(&self);
}
```

- **Paths:**
  - root = `<data>/voice-server`
  - install = `<root>/<version>`
  - staging = `<root>/<version>.staging`
  - download cache = `<root>/downloads/<sha256>`
- **Installed** means `<root>/<version>/complete.json` exists and its `manifestSha256` equals the sha256 of the manifest text.
- **`platform_support()`:**
  - Linux x86_64: `Ok(())`.
  - macOS: `Err("Phone calls to threads on this Mac aren't built yet. Use the mic in the Mac app, or call from a thread on your server.")`.
  - Elsewhere: `Err("Phone voice calls need a Linux x86-64 server for now.")`.
- **Fixed messages:**
  - Two installs at once: `"Voice setup is already running."`
  - Cancelled: `"Voice setup canceled."`
  - Disk space: `"Not enough free disk space for voice: it needs {need:.1} GB and {free:.1} GB is free."`

- [ ] **Step 1: Write the failing tests**

They use a `Test` fixture with a small inline manifest (`version "t1"`, three tiny files whose sha256 are computed in the test).
- `FakeFetch` serves bytes from a map, counts fetches per URL, and can pause on a chosen URL until released.
- `FakeRun` records commands. For `tar` it creates `<stage>/python/bin/python3`, and it can fail any command whose arguments contain a given substring.
- The fixture sets `free_bytes`.

```rust
#[test] fn the_embedded_linux_manifest_is_valid() {
    let m = manifest::parse(manifest::LINUX_X86_64).unwrap();
    assert_eq!((m.platform.as_str(), m.arch.as_str()), ("linux", "x86_64"));
    assert!(m.models.iter().any(|x| x.path == "models/whisper-base-en/model.bin"));
}
#[test] fn a_manifest_that_escapes_models_or_miscounts_is_refused() {
    for bad in [Test::manifest_with_model_path("../x"), Test::manifest_with_model_path("models/../../x"), Test::manifest_with_download_bytes(1), Test::manifest_with_sha("abc")] {
        assert!(manifest::parse(&bad).is_err());
    }
}
#[tokio::test] async fn setup_counts_as_installed_only_after_the_import_check() {
    let t = Test::new(); t.run.fail_on("find_spec"); t.server.install().unwrap(); t.settled().await;
    let s = t.server.status(); assert!(!s.installed); assert!(s.failed.unwrap().contains("failed")); assert!(!t.root().join("t1").exists());
}
#[tokio::test] async fn a_download_with_the_wrong_hash_installs_nothing() {
    let t = Test::new(); t.fetch.corrupt(Test::WHEEL_URL); t.server.install().unwrap(); t.settled().await;
    assert!(t.server.status().failed.unwrap().contains("hash")); assert!(!t.root().join("t1").exists());
}
#[tokio::test] async fn cancelling_keeps_verified_downloads_for_the_next_try() {
    let t = Test::new(); t.fetch.pause_on(Test::MODEL_URL); t.server.install().unwrap(); t.fetch.paused().await;
    t.server.cancel_install(); t.fetch.release(); t.settled().await;
    assert_eq!(t.server.status().failed.as_deref(), Some("Voice setup canceled."));
    t.server.install().unwrap(); t.settled().await;
    let counts = t.fetch.counts();   // python and the wheel finished before the pause; only the model is fetched again
    assert!(t.server.status().installed); assert_eq!(counts[Test::MODEL_URL], 2);
    assert!(counts.iter().filter(|(url, _)| *url != Test::MODEL_URL).all(|(_, n)| *n == 1));
}
#[tokio::test] async fn a_staging_folder_left_by_a_crash_is_cleared() {
    let t = Test::new(); t.write_file("t1.staging/half-written", b"x"); t.server.install().unwrap(); t.settled().await;
    assert!(t.server.status().installed); assert!(!t.root().join("t1.staging").exists());
}
#[tokio::test] async fn too_little_disk_space_is_refused_before_any_download() {
    let t = Test::with_free(Test::REQUIRED - 1); t.server.install().unwrap(); t.settled().await;
    assert!(t.server.status().failed.unwrap().starts_with("Not enough free disk space")); assert!(t.fetch.counts().is_empty());
}
#[tokio::test] async fn a_second_setup_while_one_runs_is_refused() {
    let t = Test::new(); t.fetch.pause_on(Test::MODEL_URL); t.server.install().unwrap(); t.fetch.paused().await;
    assert_eq!(t.server.install().unwrap_err(), "Voice setup is already running."); t.fetch.release(); t.settled().await;
}
#[test] fn an_unsupported_machine_says_why_and_never_installs() {
    let t = Test::unsupported("nope"); let s = t.server.status();
    assert!(!s.supported); assert_eq!(s.reason.as_deref(), Some("nope")); assert_eq!(t.server.install().unwrap_err(), "nope");
}
#[test] fn an_install_from_another_manifest_does_not_count() {
    let t = Test::new(); t.write_complete_json("t1", &"0".repeat(64)); assert!(!t.server.status().installed);
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `TMPDIR=/tmp cargo test -p apex-daemon voice::`
Expected: compile error, because module `voice` doesn't exist yet.

- [ ] **Step 3: Implement `manifest.rs`, `install.rs` and the setup half of `mod.rs`**

Install order:
1. Remove any stale staging folder.
2. Check free space (`statvfs` via `libc`) against `required_disk_bytes` before anything else.
3. Fetch the python archive, every wheel and every model into the download cache. Reuse cached files whose sha256 already matches. Verify size ≤ manifest size and the sha256, writing to `.partial` and renaming. Stage `"Downloading"`, counting bytes.
4. Extract Python: `tar -xzf <cache file> -C <staging>` (`/usr/bin/tar`). Stage `"Unpacking Python"`.
5. Copy the wheels to `<staging>/wheels/<filename>`. Then run `<staging>/python/bin/python3 -I -m pip install --no-index --no-deps --disable-pip-version-check <wheels…>` with `PYTHONNOUSERSITE=1` and `PIP_NO_INDEX=1`. Stage `"Installing speech engines"`.
6. Copy the models to `<staging>/<path>`, then run the import check from Task 1. Stage `"Checking"`.
7. Write `complete.json` `{version, manifestSha256}`. Refuse if `<root>/<version>` already exists. Rename staging to the version folder, then remove the download cache.

Cancellation is checked between files and inside `fetch`; it removes the staging folder and keeps the cache. `Run` failures read `"Voice setup command failed (<code>): <last 2000 bytes of stderr>"`. Real `Fetch` uses reqwest streaming with a 120 s connect/read timeout.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `TMPDIR=/tmp cargo test -p apex-daemon voice::`
Expected: all tests listed above pass. Then run `TMPDIR=/tmp cargo test -p apex-daemon`: no regressions.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-daemon/src/voice/mod.rs crates/apex-daemon/src/voice/manifest.rs crates/apex-daemon/src/voice/install.rs crates/apex-daemon/src/lib.rs crates/apex-daemon/src/protocol.rs crates/apex-daemon/Cargo.toml Cargo.lock
git commit -m "feat(daemon): set up the server voice runtime from a pinned manifest"
```

---

### Task 4: Daemon runs the helper (launch, one call at a time, idle unload, call log)

**Files:**
- Create: `crates/apex-daemon/src/voice/helper.rs`, `crates/apex-daemon/src/voice/sources.rs`
- Modify: `crates/apex-daemon/src/voice/mod.rs`, `docs/daemon-ubuntu.md` (add a "Voice calls from the phone" section)
- Test: unit tests in `helper.rs`, `sources.rs` and `mod.rs`

**Interfaces:**
- Consumes: Task 3's `VoiceServer` and `Deps`, extended with `launch: Arc<dyn Launch>` and `idle: Duration`. Update Task 3's fixture so it fills them in.
- Produces (used by Task 5):

```rust
pub struct Running { pub port: u16, pub token: String }        // Debug shows the port only
#[async_trait] pub trait Launch: Send + Sync { async fn launch(&self, version: &Path) -> Result<(Running, Box<dyn Helper>), String>; }
pub trait Helper: Send { fn exited(&mut self) -> BoxFuture<'_, String>; }   // dropping it kills the process
pub struct Owner { pub session: u64, pub device: Option<String>, pub label: String }
pub struct Lease { /* … */ }                                    // Drop: frees the call and arms the idle timer
impl Lease { pub fn running(&self) -> &Running; pub fn ended(&mut self) -> BoxFuture<'_, String>; }
impl VoiceServer {
    pub async fn warm(self: &Arc<Self>) -> Result<(), String>;
    pub async fn acquire(self: &Arc<Self>, owner: Owner) -> Result<Lease, String>;
    pub fn log(&self, event: &str, fields: serde_json::Value);  // one line in <root>/calls.log: {"at": <crate::log_time UTC>, "event", ...fields}
}
pub const IDLE: Duration = Duration::from_secs(600);
pub const READY_WAIT: Duration = Duration::from_secs(90);
// sources.rs
pub const FILES: &[(&str, &str)];   // ("server.py", include_str!("../../../../voice-sidecar/voice_sidecar/server.py")), … every voice_sidecar/*.py
```

- **Fixed messages:**
  - Another device holds the call: `"A voice call is already open on another device. End it there first."`
  - Takeover: `"taken over by a newer connection from this device"`
  - The helper stopped: `"voice helper stopped"`
  - Not set up: `"Voice isn't set up on this machine yet."`
  - Warm-up timeout: `"Voice took too long to start on this machine."`
- **Real launch:**
  - Write `FILES` to `<version>/app/<first 16 hex of the sha256 over all names and contents>/voice_sidecar/`, writing to a temp file and renaming.
  - Spawn `<version>/python/bin/python3` with `-I -c 'import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module("voice_sidecar.server",run_name="__main__")' <app dir> --root <version> --engine cpu --token-fd 0 --origin apex-daemon`.
  - The environment is cleared, then set to exactly `HOME`, `PATH=/usr/bin:/bin`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_HOME=<version>/cache`, `PYTHONNOUSERSITE=1` and `TOKENIZERS_PARALLELISM=false`.
  - The token is `crate::identity::random_hex(32)`, written to stdin followed by `\n`, then stdin is closed. It never goes in argv or the log.
  - Use `kill_on_drop(true)`. On Linux, `pre_exec` sets `prctl(PR_SET_PDEATHSIG, SIGTERM)`.
  - The ready line is the first stdout JSON `{"type":"ready","port":1..65535,"protocolVersion":1}` within `READY_WAIT`. Stop reading after 64 KiB.
  - From stderr, log only JSON lines whose `type` is `sessionError` or `speechDropped`, as the desktop does.
- **Calls and idle unload:**
  - `acquire` shares a single in-flight launch between callers, cancels the idle timer, and refuses or takes over as described above.
  - When the last lease drops or a warm-up finishes without a call, the idle timer starts. When it fires, the `Helper` is dropped and the line `"unloaded"` is logged.
  - When the helper exits, `Running` is cleared and the open lease's `ended()` resolves with `"voice helper stopped"`.

- [ ] **Step 1: Write the failing tests**

They use a `FakeLaunch` that counts launches and returns `Running{port: 1, token: "t".repeat(64)}`, plus a `FakeHelper` whose exit the test triggers. Time tests use `#[tokio::test(start_paused = true)]`.

```rust
async fn another_device_is_refused_while_a_call_is_open()      // acquire(device A) ok; acquire(device B) == Err(the fixed message)
async fn the_same_device_takes_over_its_own_call()             // a1 = acquire(A); a2 = acquire(A) ok; a1.ended().await == "taken over by a newer connection from this device"
async fn a_token_connection_never_takes_over()                 // acquire(device None) ok; acquire(device None) is Err
async fn calls_and_warm_ups_at_once_launch_one_helper()        // join(acquire(A), warm()) → FakeLaunch count == 1
async fn the_helper_unloads_ten_minutes_after_the_last_call()  // drop lease; advance 599 s → status().running; advance 2 s → !running and FakeHelper dropped
async fn a_warm_up_without_a_call_unloads_after_ten_minutes()  // warm(); advance 601 s → !running
async fn a_helper_that_stops_ends_the_call_and_the_next_call_relaunches() // trigger exit → lease.ended() == "voice helper stopped"; acquire → launch count 2
async fn the_call_log_never_holds_the_token()                  // acquire, log("open", …), drop; calls.log has no "tttt…" substring
#[cfg(unix)] async fn launch_passes_the_token_on_stdin_and_reads_the_ready_line()
    // the fake python3 is a shell script: writes "$@" to argv, reads one line to token, prints {"type":"ready","port":4321,"protocolVersion":1}, sleeps 30
    // assert running.port == 4321; token file == running.token; argv has no token; argv contains "--engine","cpu","--origin","apex-daemon","--token-fd","0";
    // <version>/app/<hash>/voice_sidecar/server.py equals sources::FILES server.py
#[cfg(unix)] async fn a_helper_that_never_says_ready_is_stopped()  // script only sleeps; with a 200 ms ready wait → Err("Voice took too long to start on this machine.") and the process is gone
fn every_helper_module_is_embedded()                           // each voice-sidecar/voice_sidecar/*.py (read from CARGO_MANIFEST_DIR/../../voice-sidecar/voice_sidecar) is in FILES with identical text
```

- [ ] **Step 2: Run them and watch them fail**

Run: `TMPDIR=/tmp cargo test -p apex-daemon voice::`
Expected: compile errors for `Launch`, `acquire` and `sources`.

- [ ] **Step 3: Implement `sources.rs`, `helper.rs` and the call half of `mod.rs`, per the bullets above**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `TMPDIR=/tmp cargo test -p apex-daemon voice::`. Expected: pass. Then run `TMPDIR=/tmp cargo test -p apex-daemon` and `scripts/linux-test.sh`. Expected: both pass. The Linux run compiles the `prctl` path.

- [ ] **Step 5: Document and commit**

Add the "Voice calls from the phone" section to `docs/daemon-ubuntu.md`:
- Setup happens from the phone and needs Full access.
- The download is about 0.8 GB, and setup needs 3× that free while it runs.
- Files live in `~/.local/share/dev.apexdeck.app/voice-server/`; the log is `voice-server/calls.log`.
- The helper unloads after 10 idle minutes.
- To remove voice, delete the folder while no call is open.

```bash
git add crates/apex-daemon/src/voice/helper.rs crates/apex-daemon/src/voice/sources.rs crates/apex-daemon/src/voice/mod.rs docs/daemon-ubuntu.md
git commit -m "feat(daemon): run the voice helper with one call at a time and idle unload"
```

---

### Task 5: Voice channel on the daemon link

**Files:**
- Create: `crates/apex-daemon/src/voice/relay.rs`, `crates/apex-daemon/src/voice/session.rs`, `crates/apex-daemon/src/voice/test_helper.rs` (`#[cfg(test)]`)
- Modify: `crates/apex-daemon/src/protocol.rs`, `crates/apex-daemon/src/authority.rs`
- Test: unit tests in `relay.rs` and `session.rs`; protocol tests in `protocol.rs`'s test module; authority tests in `authority.rs`

**Interfaces:**
- Consumes: `VoiceServer::{status, install, cancel_install, warm, acquire, log}`, `Lease` and `Running` (Tasks 3–4), and the wire contract above.
- Produces:

```rust
// session.rs
#[derive(Debug, Deserialize)] #[serde(tag = "cmd", content = "args", rename_all = "snake_case")]
pub enum VoiceRequest { VoiceServerStatus {}, VoiceServerInstall {}, VoiceServerInstallCancel {}, VoiceServerWarm { room: String }, VoiceServerOpen { room: String }, VoiceServerClose { channel: u32, #[serde(default)] reason: String } }
pub struct VoiceSession { /* … */ }
impl VoiceSession {
    pub fn new(server: Arc<VoiceServer>, owner: Owner) -> VoiceSession;
    pub fn room(&self) -> Option<&str>;
    pub fn attach(&mut self, room: String, lease: Lease, relay: Relay) -> u32;   // channels count from 1 per session; closes an open one with "replaced by a new call"
    pub fn frame(&mut self, voice: &serde_json::Value);                          // a client "voice" object; a wrong channel or shape is dropped and logged once
    pub fn close(&mut self, channel: u32, reason: &str);                         // the client asked: no "closed" frame back; logs the reason (≤ 200 chars)
    pub fn close_all(&mut self, reason: &str);
    pub async fn next_line(&mut self) -> Option<String>;                         // outgoing voice lines; pending forever without a channel
}
// relay.rs
pub enum FromHelper { Ctl(serde_json::Value), Bin(Vec<u8>) }
impl Relay {
    pub async fn connect(running: &Running) -> Result<Relay, String>;   // ws://127.0.0.1:<port>, header Origin: apex-daemon, first message {"type":"auth","token"}, 5 s timeout
    pub fn send_ctl(&self, ctl: serde_json::Value) -> bool;             // false = queue (64) full, frame dropped
    pub fn send_bin(&self, frame: Vec<u8>) -> bool;
    pub async fn recv(&mut self) -> Option<FromHelper>;                  // None once the helper closed
}
// authority.rs
pub fn voice_needs(request: &VoiceRequest) -> Need;   // values in Global Constraints
```

- **Changes in `protocol.rs`:**
  - `read_request` turns an object with a `voice` key and no `id` into `Request::VoiceFrame(Value)`, before the id check. Any `cmd` starting with `voice_server_` becomes `Request::Voice(VoiceRequest)`. `voice_capabilities` still reaches the host.
  - `serve()` creates one `VoiceSession`. The `Owner` gets a process-wide session counter, the device id for `Trust::Device`, and a label: the registry label, `"this machine"` or `"a token connection"`.
  - For a device, every `Request::Voice` is checked with `authority::check(&device, &voice_needs(..))`. The answers:
    - `status`, `install`, `install_cancel` and `close` answer in the loop.
    - `warm` and `open` run on spawned tasks (`in_flight += 1`) and report back over an mpsc.
    - `open` attaches only if the session is still reading and the device still passes the check; otherwise it drops the lease and refuses.
  - `Request::VoiceFrame` goes to `voice.frame`. A device whose access no longer passes `chat(thread(room))` gets its channel closed with `"this device's access changed"`.
  - A new `select!` arm writes `voice.next_line()` lines through `send()`, so revocation still applies.
  - When input ends, the loop calls `close_all("connection closed")`.
  - The welcome `capabilities` gain `"voice_server_v1"` only when `daemon.voice.status().supported`.
- **Relay pumping:**
  - Client `ctl` objects over 64 KiB, or with `type == "auth"`, are dropped.
  - `bin` frames must decode to 14–32,012 bytes.
  - After every 16th `bin` relayed, queue the `rx` line with that frame's sequence number.
  - Helper text becomes `ctl`, helper binary becomes `bin` (base64, `crate` already has `base64`), and a helper close becomes one `closed` line.
  - Helper `timing` events are also logged (numbers only).

- [ ] **Step 1: Write the failing tests**

`test_helper.rs` provides:
- `fake_helper(token) -> (Running, JoinHandle<()>)`: a tokio-tungstenite server on 127.0.0.1:0 that requires `Origin: apex-daemon` and the auth token. It echoes binary frames, answers `{"type":"start",callId,generation}` with `{"type":"ready",callId,generation,"voices":["am_michael"],"semantic":true}`, and closes on `end`.
- `server_with_helper(data, running) -> Arc<VoiceServer>`: supported, installed, and a `FakeLaunch` returning `running`.
- `bin(generation, seq) -> String`: base64 of a `DV` v1 frame with 512 zero samples.

Protocol tests replace the voice server with `Arc::get_mut(&mut daemon).unwrap().voice = server_with_helper(..)` before connecting, and use the existing `daemon()`, `connect_to`, `connect_device`, `add`, `Client::{hello, send, until_reply}` and `frames_for`.

```rust
async fn voice_frames_stay_on_the_session_that_opened_the_call() {
    // a and b connect; a opens room "r" → ok.channel; a sends 40 {"voice":{"channel":c,"bin":bin(0,n)}}
    // a gets 40 echoed bin frames and exactly 2 rx frames (16, 32); b gets no frame with a "voice" key;
    // daemon.host.events().last_seq() is unchanged
}
async fn a_client_resuming_after_a_drop_is_not_replayed_voice_frames()   // reconnect with since → nothing in replay has a "voice" key
async fn voice_requests_need_the_right_tier()
    // read_only device: open/warm refused, status ok; chat device: install/install_cancel refused, open ok;
    // a chat device limited to thread "mine" cannot open room "other"
async fn closing_the_connection_ends_the_call_so_another_device_can_open_one()
async fn the_same_device_reconnecting_replaces_its_stale_call()          // device A session 1 open; session 2 open → ok; session 1 gets {"voice":{"channel":1,"closed":"taken over by a newer connection from this device"}}
async fn frames_for_a_channel_this_session_does_not_own_are_ignored()    // bin for channel 99 → no echo, session stays open
async fn a_full_input_queue_drops_frames_instead_of_blocking_the_session() // fake helper stops reading; 200 bin frames sent; a command sent afterwards still gets its reply within 1 s
async fn a_helper_that_closes_sends_one_closed_frame()                   // send ctl {"type":"end"} → exactly one "closed" line, then nothing for that channel
async fn voice_capabilities_still_reaches_the_host()                     // {"cmd":"voice_capabilities"} answers ok with voice_turn_correlation_v1
async fn the_welcome_lists_voice_server_v1_only_where_supported()        // supported → in capabilities; VoiceServer::with(Err(..)) → absent
```

- [ ] **Step 2: Run them and watch them fail**

Run: `TMPDIR=/tmp cargo test -p apex-daemon voice`
Expected: compile errors for `VoiceRequest`, `Relay` and `voice_needs`.

- [ ] **Step 3: Implement `relay.rs`, `session.rs`, `voice_needs` and the `protocol.rs` changes, per the bullets above**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `TMPDIR=/tmp cargo test -p apex-core -p apex-adapters -p apex-host -p apex-daemon`
Expected: 0 failed.

- [ ] **Step 5: Commit**

```bash
git add crates/apex-daemon/src/voice/relay.rs crates/apex-daemon/src/voice/session.rs crates/apex-daemon/src/voice/test_helper.rs crates/apex-daemon/src/voice/mod.rs crates/apex-daemon/src/protocol.rs crates/apex-daemon/src/authority.rs
git commit -m "feat(daemon): relay one voice call per session over the client link"
```

---

### Task 6: Phone voice link and shared call changes

**Files:**
- Create: `src/voice/serverClient.ts`
- Modify: `src/daemon/client.ts`, `src/voice/types.ts`, `src/voice/controller.ts`, `src/voice/localClient.ts`, `src/phoneBackend.ts`
- Test: create `tests/daemon-voice-frames.test.mjs` and `tests/voice-server-client.test.mjs`; extend `tests/voice-controller.test.mjs`

**Interfaces:**
- Consumes: the wire contract above.
- Produces (used by Tasks 7 and 9):

```ts
// types.ts
export type VoiceFrame = { channel: number } & ({ ctl: Record<string, unknown> } | { bin: string } | { rx: number } | { closed: string });
export type ServerVoiceRuntime = { channel: number; protocolVersion: 1 };
export type ServerVoiceStatus = { supported: boolean; reason?: string; installed: boolean; installing?: { stage: string; downloaded: number; total: number };
  failed?: string; running: boolean; busy: boolean; downloadBytes: number; requiredDiskBytes: number };
export interface ServerVoiceLink {
  status(): Promise<ServerVoiceStatus>; install(): Promise<void>; cancelInstall(): Promise<void>;
  warm(room: string): Promise<void>; open(room: string): Promise<ServerVoiceRuntime>; close(channel: number, reason: string): Promise<void>;
  /** Delivers frames that arrived for `channel` before this call (latest 64), then live ones; a channel already closed reports it at once. */
  attach(channel: number, cb: (frame: VoiceFrame) => void): () => void;
  send(frame: VoiceFrame): boolean;
  /** Fires when the link stops being connected; any open channel belonged to that session and is gone. */
  onLost(cb: (reason: string) => void): () => void;
}
// client.ts (DaemonClient)
sendVoice(frame: VoiceFrame): boolean;               // one line {"voice":frame}, no id; false when not connected
onVoice(cb: (frame: VoiceFrame) => void): () => void; // only while ready; never to event listeners
// serverClient.ts
export const SEND_LIMIT = 96, RESUME_AT = 32;
export function serverVoiceLink(client: DaemonClient): ServerVoiceLink;
export function connectServerVoice(link: ServerVoiceLink, runtime: ServerVoiceRuntime, event: (e: HelperEvent) => void,
  audio: (pcm: Int16Array, generation: number) => void, failure: (e: Error) => void, weak?: (weak: boolean) => void): Promise<LocalVoiceClient>;
// controller.ts
export interface VoiceDependencies<R = VoiceRuntime> { runtime: { status(): Promise<{ installed: boolean; supported: boolean; reason?: string }>; start(): Promise<R>; stop(): Promise<unknown> };
  connect(runtime: R, event: …, audio: …, error: …): Promise<LocalVoiceClient>; /* other members unchanged */ }
export function createVoiceController<R = VoiceRuntime>(deps: VoiceDependencies<R>): { /* as today */ end(reason?: string, options?: { keepWork?: boolean }): Promise<void> };
export type VoiceController<R = VoiceRuntime> = ReturnType<typeof createVoiceController<R>>;
// localClient.ts
LocalVoiceClient.close(reason?: string): void
// phoneBackend.ts (PhoneHost)
voice: ServerVoiceLink; supports(capability: string): boolean;
```

- **`connectServerVoice` behaviour:**
  - **Control.** `send(m)` sends `{channel, ctl: m}` and throws `Error("Voice disconnected")` when not sent.
  - **Mic frames.** `audio(pcm, gen)` sends `{channel, bin: toBase64(new Uint8Array(encodeAudio(gen, ++seq, pcm)))}`, using `toBase64` from `src/daemon/transport.ts`. If `seq - acked >= SEND_LIMIT`, it drops the frame without raising `seq` and calls `weak(true)` once.
  - **Acks.** An `rx` frame sets `acked = max(acked, rx)`. While weak, once `seq - acked < RESUME_AT`, it calls `weak(false)` and sending resumes.
  - **Helper messages.** `ctl` goes to `event`. `bin` is decoded with `fromBase64` + `decodeAudio` and passed to `audio`.
  - **Endings.** A `closed` frame or `onLost` reaches `failure` as `disconnected(...)` (name `VoiceDisconnected`), unless the client closed first.
  - **Closing.** `close(reason)` calls `link.close(channel, reason ?? "closed")` exactly once.
  - **Already closed.** If `attach` reports `closed` immediately, the returned promise rejects with `disconnected(...)`.
- **Controller changes:**
  - A non-supported status throws `Error(status.reason ?? "Local calls require Apple Silicon macOS")`.
  - `end(reason, { keepWork: true })` detaches from the active turn without `bridge.cancel`.
  - `end` and the reconnect path pass their reason to `client.close`.
  - A helper `timing` event with `ttsFirstMs` logs the metric `"speech-first-audio"`.

- [ ] **Step 1: Write the failing tests**

`tests/daemon-voice-frames.test.mjs` uses a fake `Link`, as `tests/daemon-client.test.mjs` does:
```js
test("a voice line reaches voice listeners only", async () => {
  // after the welcome, the link delivers '{"voice":{"channel":3,"ctl":{"type":"ready"}}}'
  // assert onVoice got [{ channel: 3, ctl: { type: "ready" } }]; an on("ready") / on("voice") event listener got nothing
});
test("sendVoice writes one line without an id and refuses when offline", async () => {
  // before the welcome: sendVoice({ channel: 3, bin: "AAAA" }) === false
  // after: true, and JSON.parse(lastSent) deepEquals { voice: { channel: 3, bin: "AAAA" } }
});
```

`tests/voice-server-client.test.mjs` uses a fake `ServerVoiceLink` that records `sent`, `closed` and `attach` callbacks:
```js
test("helper events and audio reach the controller callbacks", async () => { /* deliver ctl → event(ctl); deliver bin of encodeAudio(0,1,pcm) → audio(pcm, 0) */ });
test("mic frames carry rising sequence numbers", async () => { /* audio(pcm,2) twice → decoded headers seq 1, 2 with generation 2 */ });
test("the mic backs off when the machine stops acknowledging", async () => {
  // 96 frames sent; the 97th is not sent and weak(true) fires once; deliver { rx: 80 } → weak(false); next frame is sent with seq 97
});
test("a closed channel or a lost link ends with VoiceDisconnected", async () => { /* closed → failure.name === "VoiceDisconnected"; separately onLost → same */ });
test("close tells the machine why, once", async () => { /* close("ended by user"); close() → link.close calls deepEqual [[5, "ended by user"]] */ });
test("frames that arrived before attach are delivered, and a closed channel rejects connect", async () => { /* serverVoiceLink over a fake DaemonClient */ });
```

Add to `tests/voice-controller.test.mjs` (extend `fixture()` with a `status` option and record `close` reasons):
```js
test("an unsupported machine's reason is shown", async () => {
  // status → { supported: false, installed: false, reason: "Phone voice calls need a Linux x86-64 server for now." }
  // after start: getState().status === "error" and getState().error === that reason
});
test("ending with keepWork leaves the agent's turn running", async () => {
  // start, ready, transcript → posted; end("app left the screen", { keepWork: true }) → stopped.length === 0
  // a second fixture with end("ended by user") → stopped.length === 1
});
test("the end reason reaches the helper connection", async () => { /* end("spoken stop phrase") → closeReasons includes it */ });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types --test tests/daemon-voice-frames.test.mjs tests/voice-server-client.test.mjs tests/voice-controller.test.mjs`
Expected: the new tests fail (missing exports and methods); the existing controller tests still pass.

- [ ] **Step 3: Implement the changes in `client.ts`, `serverClient.ts`, `types.ts`, `controller.ts`, `localClient.ts` and `phoneBackend.ts`, per the bullets above**

- [ ] **Step 4: Run all checks and confirm they pass**

Run: `node --experimental-strip-types --test tests/daemon-voice-frames.test.mjs tests/voice-server-client.test.mjs tests/voice-*.test.mjs && npx tsc --noEmit && npm test`
Expected: all pass, with 0 TypeScript errors. The desktop `coordinator.ts` compiles unchanged, because `R` defaults to `VoiceRuntime`.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/client.ts src/voice/serverClient.ts src/voice/types.ts src/voice/controller.ts src/voice/localClient.ts src/phoneBackend.ts tests/daemon-voice-frames.test.mjs tests/voice-server-client.test.mjs tests/voice-controller.test.mjs
git commit -m "feat(voice): reach a server voice helper over the daemon link"
```

---

### Task 7: Phone call logic

**Files:**
- Create: `src/phone/phoneVoice.ts`, `src/phone/phonePost.ts`, `src/phone/callScreen.ts`
- Modify: `src/phone/PhoneApp.tsx` (wiring only)
- Test: `tests/phone-voice.test.mjs`, `tests/phone-post.test.mjs`

**Interfaces:**
- Consumes: `ServerVoiceLink`, `connectServerVoice`, `createVoiceController<ServerVoiceRuntime>` and `PhoneHost.{voice, supports}` (Task 6); `createThreadVoiceBridge`, `readVoiceSettings`, `preferenceFor` and `openVoiceAudio` (existing); `ParticipantQueues.sendTo/items/remove` (existing).
- Produces (used by Task 8):

```ts
// phonePost.ts
export async function postFromPhone(backend: Pick<Backend, "roomPostTo">, paneId: string, text: string, to: string[], manual: boolean | undefined, voice?: { requestId: string }): Promise<void>;
// callScreen.ts
export function keepAwake(on: boolean): void;   // CallScreen.keepAwake({on}) when the native plugin exists; otherwise nothing
// phoneVoice.ts
export const PHONE_VOICE_KEY = "apex-deck.phone.voice.v1", PHONE_VOICE_USED_KEY = "apex-deck.phone.voice.used.v1";
export interface PhoneVoiceHost { name: string; backend: Backend; voice: ServerVoiceLink; canCall(): boolean; whenConnected(timeoutMs: number): Promise<void> }
export interface PhoneVoiceDeps {
  host(hostId: string): PhoneVoiceHost | null;
  queue(hostId: string, roomId: string): ParticipantQueues;
  participants(hostId: string, roomId: string): readonly { id: string; display_name: string; media?: unknown }[];
  onScreen(hostId: string, roomId: string): boolean;
  storage: Pick<Storage, "getItem" | "setItem">;
  keepAwake(on: boolean): void;
  openAudio?: VoiceDependencies["openAudio"]; connect?: typeof connectServerVoice; now?: () => number;
}
export interface PhoneVoice {
  controller: VoiceController<ServerVoiceRuntime>;
  canCall(hostId: string): boolean;
  candidates(hostId: string, roomId: string): VoiceCandidate[];
  settings(): VoiceSettings; save(settings: VoiceSettings): void;
  view(): { weak: boolean; attention: boolean }; subscribe(fn: () => void): () => void;
  failed(hostId: string, roomId: string, participantId: string, requestId: string, error: unknown): void;
  threadOpened(hostId: string, roomId: string): void;
  leftScreen(): void;
}
export function createPhoneVoice(deps: PhoneVoiceDeps): PhoneVoice;
```

- **Controller dependencies:**
  - `runtime.start` reads `controller.getState().scope`, waits up to 10 s for `whenConnected`, then `voice.open(scope.roomId)` and remembers the channel.
  - `runtime.stop` closes a remembered channel that's still open, with the reason `"call ended"`.
  - `connect` = `connectServerVoice`, and its `weak` callback updates `view().weak`.
  - `openAudio` = `openVoiceAudio`.
  - `candidates` = non-media participants of the call's thread, with aliases from `preferenceFor`.
  - `bridge(scope)` is cached per host, room and participant. It uses `createThreadVoiceBridge` with `enqueue` = `queue(...).sendTo(turn.text, [participantId], {requestId, canceled})`, and `remove` deletes the queue item whose `voice.requestId` matches.
  - `voice` and `silence` come from the phone's settings.
  - `focus(scope)` never navigates. It sets `attention` when that thread isn't on screen; `threadOpened` for it clears `attention`.
- **Lifecycle:**
  - Call `keepAwake(true)` when the status leaves `off` and `keepAwake(false)` when it returns to `off`.
  - On the first `listening`, add the host to `PHONE_VOICE_USED_KEY`.
  - `threadOpened` calls `voice.warm(roomId)` only for a host in `PHONE_VOICE_USED_KEY`, at most once per 60 s per host, ignoring errors.
  - `leftScreen` calls `controller.end("app left the screen", { keepWork: true })` when a call is on.
  - `failed` calls that bridge's `fail(requestId, error)`.
- **`canCall(hostId)`** is true only when the host exists, advertises `voice_server_v1`, and its access tier isn't `read_only`.
- **`PhoneApp` builds each `PhoneVoiceHost`** from its `PhoneHost`:
  - `canCall` = `host.supports("voice_server_v1") && host.access()?.tier !== "read_only"`. `access()` is `null` over a LAN token link, which means full access.
  - `whenConnected(ms)` resolves once `host.connection.get().status.kind === "connected"`, watching via `connection.subscribe`. It rejects after `ms` with `Error("Can't reach {machine name} right now.")`.
- **`PhoneApp.tsx` wiring:**
  - Create one `PhoneVoice` (`useRef`), with dependencies reading `hostsRef`, `queueFor` and a `participantsRef` map that is updated whenever a thread's room state loads.
  - The queue's post callback calls `postFromPhone(backend(), paneId, text, to, manual, voice)`. For a voice item, a failure calls `phoneVoice.failed(hostId, paneId, to[0], voice.requestId, error)` and rethrows; the typed-message failure handling stays as it is.
  - On `visibilitychange` to `hidden`, call `phoneVoice.leftScreen()`.
  - Opening a thread calls `phoneVoice.threadOpened(hostId, roomId)`.

- [ ] **Step 1: Write the failing tests**

`tests/phone-post.test.mjs`:
```js
test("a voice turn posts with its request id and no bot hops", async () => {
  const calls = []; await postFromPhone({ roomPostTo: async (...a) => { calls.push(a); } }, "room", "hi", ["null"], true, { requestId: "v1" });
  assert.deepEqual(calls, [["room", "hi", ["null"], false, false, { client_turn_id: "v1", max_bot_hops: 0 }]]);
});
test("a typed message posts as before", async () => {
  const calls = []; await postFromPhone({ roomPostTo: async (...a) => { calls.push(a); } }, "room", "hi", ["null"], false);
  assert.deepEqual(calls, [["room", "hi", ["null"], true]]);
});
```

`tests/phone-voice.test.mjs` uses fakes for the host (a recording `ServerVoiceLink`, `canCall`, `whenConnected`), `connect` (a client that records sent controls and exposes the helper callback), `openAudio` (as in `voice-controller.test.mjs`) and storage (a Map), plus a real `ParticipantQueues` with a recording post:
```js
test("the mic shows only where the machine offers server voice and the phone may chat", () => { /* canCall false: missing host, no capability, read_only; true otherwise */ });
test("a call opens a channel for the thread and queues the transcript for the chosen agent", async () => {
  // controller.start(scope) → link.open called with "room"; helper ready + transcript "check the build"
  // → the queue's post got ("check the build", ["null"], …, voice.requestId set)
});
test("leaving the screen ends the audio but leaves the agent's turn running", async () => {
  // after the transcript is posted: leftScreen() → state off, backend.roomStopRequest never called, link.close reason "app left the screen"
});
test("an approval while another thread is shown marks the call and does not switch screens", async () => {
  // bridge emits approval → view().attention === true; threadOpened(host, room) → false
});
test("voices and aliases are kept on the phone", () => {
  // save(settings with a voice for null) → storage key "apex-deck.phone.voice.v1"; a new createPhoneVoice reads it back; candidates carry the aliases
});
test("opening a thread warms its machine only after a call there, at most once a minute", () => { /* warm not called before a call; called once; again only after now() + 60_000 */ });
test("the screen stays awake only during a call", async () => { /* keepAwake calls deepEqual [true, false] across start → end */ });
test("a failed post for a voice turn ends that turn with an error", async () => { /* failed(...) → state.status === "error" */ });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --experimental-strip-types --test tests/phone-voice.test.mjs tests/phone-post.test.mjs`
Expected: FAIL, because the modules don't exist.

- [ ] **Step 3: Implement `phonePost.ts`, `callScreen.ts` (`registerPlugin("CallScreen")`, guarded by `Capacitor.isPluginAvailable("CallScreen")`) and `phoneVoice.ts`, then the `PhoneApp.tsx` wiring**

- [ ] **Step 4: Run all checks and confirm they pass**

Run: `node --experimental-strip-types --test tests/phone-voice.test.mjs tests/phone-post.test.mjs && npx tsc --noEmit && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/phone/phoneVoice.ts src/phone/phonePost.ts src/phone/callScreen.ts src/phone/PhoneApp.tsx tests/phone-voice.test.mjs tests/phone-post.test.mjs
git commit -m "feat(phone): run voice calls against the thread's machine"
```

---

### Task 8: Phone call screens and keep-awake

**Files:**
- Create: `src/phone/voiceCallView.ts`, `src/phone/VoiceCall.tsx`, `src/phone/voice-call.css`, `iphone/App/App/CallScreenPlugin.swift`
- Modify:
  - `src/phone/PhoneApp.tsx` (mic in `.ph-input` right before `.ph-send`, the call sheet and setup sheet via the existing `Sheet`, the call bar at the app root)
  - `iphone/App/App/SpeechPlugin.swift` (`bridge?.registerPluginInstance(CallScreenPlugin())` in `MainViewController.capacitorDidLoad`)
  - `iphone/App/App.xcodeproj/project.pbxproj` (four entries mirroring `SpeechPlugin.swift`'s: a PBXBuildFile, a PBXFileReference, the group child and the Sources phase, each with new unique 24-hex ids)
- Test: `tests/phone-voice-view.test.mjs`

**Interfaces:**
- Consumes: `PhoneVoice` (Task 7) and `ServerVoiceStatus` (Task 6).
- Produces:

```ts
export function voiceCallView(input: { state: VoiceState; agent: string; machine: string; weak: boolean; attention: boolean;
  setup?: ServerVoiceStatus; canSetUp: boolean }): { status: string; mic: { label: string; active: boolean }; bar: string | null;
  setup: null | { title: string; body: string; button: string | null; progress: string | null; note: string | null } };
export function voiceSize(bytes: number): string;   // ≥ 1e9 → "1.2 GB" (one decimal); otherwise "812 MB" (whole MB)
```

**Exact copy:**
- **Status words:**
  - `warming` → `Starting voice on {machine}…`
  - `listening` → `Listening`
  - `hearing` → `Hearing you`
  - `waiting` → `{agent} is thinking`
  - `speaking` → `{agent} is speaking`
  - `needs-attention` → `state.error`, or `{agent} needs you in the thread`
  - `error` → `state.error`, or `The call ended`
  - `muted` replaces `Listening` with `Muted`
  - `weak` replaces `Listening`/`Hearing you` with `Weak connection — some words may be lost`
- **Mic label:** off → `Call {agent}` (`Start a voice call` when the thread has several agents and none is addressed); on → `Call controls`.
- **Call bar:** `On call with {agent}`, plus ` · needs you` when `attention`.
- **Setup sheet:**
  - Title: `Voice calls on {machine}`
  - Body: `Calls in this machine's threads listen and speak on {machine}, so they work with your Mac off. Setup downloads about {voiceSize(downloadBytes)} to {machine} once.`
  - Button: `Set up voice`. While installing, there's no button and progress reads `{stage} · {voiceSize(downloaded)} of {voiceSize(total)}`. After a failure: note `Setup stopped: {failed}` and button `Try again`.
  - Without Full access: no button, and the note `Only a phone with Full access can set this up. Change it on the Mac in Settings → Paired devices.`

**Behaviour:**
- **Tapping the mic:**
  - With one agent, or one addressed agent, the call starts. With several agents, the sheet lists them to choose.
  - With a call on, the call sheet toggles; hiding it never ends the call.
  - With setup needed (`status === "setup"`), the setup sheet opens.
  - The mic is disabled while the thread's machine is offline, the same as Send.
  - The setup sheet polls `voice.status()` every 1 s while it is open and installing.
- **Call sheet:** recipient, status, Mute, End call, the voice list with Preview (enabled only in a call), the pause slider (300–2000 ms, step 100, `Applies to the next call`) and Hide.
- **Rows:** plain rows, one state dot, quiet labels; no boxed rows.
- **`CallScreenPlugin.keepAwake({on})`** sets `UIApplication.shared.isIdleTimerDisabled = on` on the main queue, then resolves.

- [ ] **Step 1: Write the failing test**

```js
test("status words follow the call state", () => { /* every state above, weak and muted overrides, with agent "Null" and machine "Server" */ });
test("the setup sheet explains, shows progress, then a retry", () => {
  // installed false, canSetUp → body contains "about 812 MB to Server" for 812_000_000; installing → progress "Downloading · 300 MB of 812 MB", button null;
  // failed "Voice setup canceled." → note "Setup stopped: Voice setup canceled.", button "Try again"; canSetUp false → button null + the Full-access note
});
test("the mic and call bar name the agent", () => { /* off → "Call Null"; on → "Call controls"; bar with attention → "On call with Null · needs you" */ });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --experimental-strip-types --test tests/phone-voice-view.test.mjs`. Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement `voiceCallView.ts`, `VoiceCall.tsx`, `voice-call.css`, the Swift plugin, its registration and the pbxproj entries, plus the `PhoneApp.tsx` placement**

- [ ] **Step 4: Run the test and the full checks**

Run: `node --experimental-strip-types --test tests/phone-voice-view.test.mjs && npx tsc --noEmit && npm test`. Expected: pass.

Then run: `npm run iphone:sync && xcodebuild -project iphone/App/App.xcodeproj -scheme App -destination 'generic/platform=iOS' -derivedDataPath /tmp/apex-iphone-dd CODE_SIGNING_ALLOWED=NO build`
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Look before installing**

Render `VoiceCall` in a throwaway Vite harness under `/tmp` with fake state, as was done for `ThreadList`, at 393×852 and dark theme. Screenshot five states:
- the thread with the mic beside Send
- the setup sheet while installing
- the call sheet listening
- the call sheet speaking with weak connection
- the call bar over the thread list

View every PNG. Fix any clipping or misalignment; the mic must be centred and the same size as Send. Keep the screenshots out of Git.

- [ ] **Step 6: Commit**

```bash
git add src/phone/voiceCallView.ts src/phone/VoiceCall.tsx src/phone/voice-call.css src/phone/PhoneApp.tsx iphone/App/App/CallScreenPlugin.swift iphone/App/App/SpeechPlugin.swift iphone/App/App.xcodeproj/project.pbxproj tests/phone-voice-view.test.mjs
git commit -m "feat(phone): mic beside Send, call sheet, voice setup and call bar"
```

---

### Task 9: Rehearsal on the VPS with a throwaway daemon

This task runs before the live service is touched. A second daemon with its own data folder and port runs next to the real one, and nothing else on the VPS changes.

**Files:**
- Create: `scripts/voice-server-smoke.mjs`
- Modify: `docs/voice-server-verification.md` (add a "Rehearsal" section)

**Interfaces:**
- Consumes: `DaemonClient`, `webSocketConnect`, `serverVoiceLink` and `connectServerVoice` (Task 6); the Linux daemon from Tasks 3–5; the CPU engine from Task 2.
- Produces: `node --experimental-strip-types scripts/voice-server-smoke.mjs --url ws://127.0.0.1:7499 --token-file FILE [--install] [--turns N]`, which works as follows.
  - It sets up voice if `--install` is given, printing progress.
  - It opens a channel on room `"smoke"` and starts a call with `am_michael`, a 700 ms pause and the hints Null, Muck, Jigga and Apex Deck.
  - Each turn:
    - Asks the helper to speak `Hey Null, can you check why the build failed on main?`, collects the 24 kHz audio, and returns playback credits as received.
    - Resamples the audio to 16 kHz and streams it as 512-sample frames paced at 32 ms, followed by 1.5 s of silence.
    - Waits up to 10 s for the transcript.
  - It prints one JSON line per turn and a summary: `openMs` cold and warm, `ttsFirstMs` p50 and p95, `speechEndToTranscriptMs` p50 and p95, and `ok/turns`.
  - It exits 1 if any transcript lacks "null" or "build".

- [ ] **Step 1: Write `scripts/voice-server-smoke.mjs` as described**

- [ ] **Step 2: Build the Linux daemon and start a throwaway instance**

```bash
scripts/linux-build.sh amd64
ssh "${SSH_OPTS[@]}" "$VPS" 'mkdir -p /var/tmp/voice-e2e/data'
scp "${SSH_OPTS[@]}" target/linux-amd64/apex-daemon "$VPS":/var/tmp/voice-e2e/apex-daemon
ssh "${SSH_OPTS[@]}" "$VPS" 'cd /var/tmp/voice-e2e && (setsid ./apex-daemon serve --data-dir /var/tmp/voice-e2e/data --port 7499 > daemon.log 2>&1 < /dev/null &) && sleep 2 && grep listening daemon.log'
ssh "${SSH_OPTS[@]}" "$VPS" cat /var/tmp/voice-e2e/data/daemon-token > /tmp/voice-e2e-token && chmod 600 /tmp/voice-e2e-token
ssh -o RemoteCommand=none -o ExitOnForwardFailure=yes -N -L 7499:127.0.0.1:7499 "$VPS" &
```

Expected: `apex-daemon: listening on ws://127.0.0.1:7499 …`.

- [ ] **Step 3: Set up voice for real, then run 10 turns cold and 10 warm**

Run: `node --experimental-strip-types scripts/voice-server-smoke.mjs --url ws://127.0.0.1:7499 --token-file /tmp/voice-e2e-token --install --turns 10`, then the same command without `--install`.
Expected: setup reaches installed, both runs print `10/10 ok`, and `openMs.warm` is under 1,000.

- [ ] **Step 4: Check memory, the stall, the idle unload and the daemon exit**

- **Memory:** `ssh … "$VPS" 'ps -o rss=,args= -C python3 | grep voice_sidecar'` during a run. Record the RSS.
- **Stall:** during a run, `kill -STOP` the tunnel's ssh for 4 s, then `kill -CONT` it. Expected: the smoke prints `weak` then recovers, or ends that turn clearly; the daemon log shows no panic; later turns pass.
- **Idle:** 11 minutes after the last run, `pgrep -fa voice_sidecar.server` on the VPS prints nothing.
- **Exit:** start a run, then `kill -TERM` the throwaway daemon. Within 2 s, `pgrep -fa voice_sidecar.server` prints nothing.

- [ ] **Step 5: Record and clean up**

- Add a "Rehearsal" section to `docs/voice-server-verification.md`: setup bytes and seconds, cold and warm open times, `ttsFirstMs` and speech-end-to-transcript p50/p95, RSS, and the stall, idle and exit results. Only the fixed test sentence appears; no hostnames or addresses.
- Stop the tunnel, `rm -rf /var/tmp/voice-e2e` and `/tmp/voice-e2e-token`.
- If the human approves, also remove `/var/tmp/voice-manifest`.
- Then commit:

```bash
git add scripts/voice-server-smoke.mjs docs/voice-server-verification.md
git commit -m "test(voice): rehearse server voice calls on a throwaway daemon"
```

---

### Task 10: Deploy to the VPS and test on the iPhone

**Files:**
- Modify: `docs/voice-server-verification.md` (add an "iPhone" section), and any files a fix touches

- [ ] **Step 1: Run every gate on the branch**

```bash
npx tsc --noEmit && npm test
TMPDIR=/tmp cargo test -p apex-core -p apex-adapters -p apex-host -p apex-daemon
PYTHONPATH=voice-sidecar "$HOME/Library/Application Support/dev.apexdeck.app/voice/2/python/bin/python3" -m unittest discover -s voice-sidecar/tests -v
```

Expected: 0 failures everywhere.

- [ ] **Step 2: Get the human's go, then deploy the VPS daemon when no bot there is mid-reply**

1. Find the service's main PID: `ssh … "$VPS" 'systemctl show -p MainPID --value apex-daemon@$USER'`.
2. Wait until `pgrep -P <pid> -l` shows no `claude`, `codex`, `gemini`, `grok` or `muse`.
3. Run `scripts/vps-deploy.sh "$VPS"`.

Expected: the script's verification passes, and the running build matches `HEAD`.

- [ ] **Step 3: Install a Debug build on the human's iPhone (it must be unlocked)**

```bash
npm run iphone:sync
xcodebuild -project iphone/App/App.xcodeproj -scheme App -configuration Debug -destination id=<UDID> -derivedDataPath /tmp/apex-iphone-dd -allowProvisioningUpdates build
xcrun devicectl device install app --device <UDID> /tmp/apex-iphone-dd/Build/Products/Debug-iphoneos/App.app
```

A Debug build lets Safari's Web Inspector read the `[voice timing]` lines.

- [ ] **Step 4: The human runs the acceptance list from the spec, with the Mac asleep**

- Set up voice from a VPS thread.
- Run calls on Wi-Fi and on cellular, on the speaker and with headphones.
- Check:
  - There is no self-transcription across 10 speaker turns.
  - Interrupting works, and "call Muck" switches agents.
  - Mute keeps the reply going, and End stops it.
  - An approval is announced and approved by tapping.
  - Two seconds of airplane mode doesn't break chat.
  - Switching apps mid-reply ends the audio, and the reply still lands in the thread.
  - Voices survive an app restart.
- Take 20 timed turns: read the phone timings in Web Inspector and the helper timings in `voice-server/calls.log`.

- [ ] **Step 5: Fix what fails, retest, and record**

Known fallbacks, used only if the device shows the problem:

| Problem on the device | Fix |
| --- | --- |
| Quiet earpiece playback | Add `CallScreen.speaker({on})` → `AVAudioSession.overrideOutputAudioPort(.speaker)` after capture starts |
| `getSettings().echoCancellation` not `true`, but the speaker test passes | Phone deps only skip that check (add `requireEchoCancellationSetting: false` to `VoiceDependencies`, default `true`) |
| Self-transcription on the speaker | Gate the mic during playback and tell the human it's a headphones-recommended mode |
| Audio contexts stay suspended after the open wait | Create and resume them on the mic tap before awaiting `open` |
| `base.en` mishears names | Add aliases, then benchmark `distil-small.en` on the VPS before switching models |

Record the results in the "iPhone" section of `docs/voice-server-verification.md`: p50/p95 for each stage, a pass or fail for each check, and the iOS version, with no transcripts. Commit any fixes with their tests.

- [ ] **Step 6: Merge, push and TestFlight only with the human's go**

1. Run `npx tsc --noEmit` again.
2. Merge with a `Merge branch 'feat/vps-voice-helper'` commit, using the merge-tree recipe if another worktree holds `main`.
3. Push.
4. For TestFlight: bump the build number and upload with Homebrew stripped from `PATH`.
5. Delete the branch.

No DMG is needed: the Mac app's behaviour doesn't change, and the next DMG picks up the shared code.

---

## Order and checkpoints

Tasks 1–2 (Python) and 3–5 (Rust) can run in parallel with separate owners. Task 6 depends on the wire contract only. Task 7 needs 6, Task 8 needs 7, and Task 9 needs 2–6. Task 10 is the only step that touches the live VPS service and the human's phone, and both need the human's go.

## Facts checked while planning (2026-10-21)

- **VPS bench environment:** faster-whisper 1.2.1, ctranslate2 4.8.3, onnxruntime 1.31.0, kokoro-onnx 0.6.1.
- **Kokoro ONNX:** `Kokoro.create(text, voice, speed, lang, …) -> (float32 samples, 24000)`; `get_voices()` lists 54 voices, 28 of them matching `[ab][fm]_`; `from_session` exists; `lang="en-gb"` works for `bf_*`.
- **faster-whisper:** `WhisperModel.transcribe` accepts `initial_prompt`, `vad_filter`, `condition_on_previous_text` and `temperature`; `Segment` has `no_speech_prob`.
- **`base.en` files** at revision `3d3d5dee…`: `config.json`, `model.bin` (145,216,508 bytes), `tokenizer.json`, `vocabulary.txt`.
- **Silero:** `silero-vad` 6.2.3 ships `data/silero_vad.onnx` with inputs `input [N, T]`, `state [2, N, 128]` and `sr` (int64), and outputs `output [N, 1]` and `stateN`.
- **Capacitor 8.5.2:** `WebViewDelegationHandler` grants web-view microphone capture, `NSMicrophoneUsageDescription` is already in `iphone/App/App/Info.plist`, and `UIBackgroundModes` is absent, which is why calls are foreground-only.
- **Phone iroh bridge:** it queues at most 256 lines (16 MiB) per connection, and `send` failing with "busy" makes `irohLink` close the link. That is the reason for D6.
- **Second daemon:** `apex-daemon serve` with no `--remote` and no gateway port binds only `127.0.0.1:<port>` and the socket in its own data folder, so the Task 9 rehearsal can't clash with the live service.
