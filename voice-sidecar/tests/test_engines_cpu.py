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
