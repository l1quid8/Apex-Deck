import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace
import numpy as np

spec = importlib.util.spec_from_file_location('runner', Path(__file__).parents[1] / 'desktop/moshi/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class AudioTests(unittest.TestCase):
    def test_worker_failure_signals_the_parent_instead_of_hanging(self):
        signalled = []
        def fail():
            raise RuntimeError('model failed')
        with self.assertRaises(RuntimeError):
            runner.run_worker(fail, (), lambda: signalled.append(True))
        self.assertEqual(signalled, [True])

    def test_native_worker_exit_is_detected_even_without_finally(self):
        self.assertFalse(runner.worker_exited([SimpleNamespace(pid=None, exitcode=None), SimpleNamespace(pid=10, exitcode=None)]))
        self.assertTrue(runner.worker_exited([SimpleNamespace(pid=10, exitcode=-9)]))

    def test_pcm_round_trip(self):
        pcm = np.linspace(-1, 1, 1920, dtype=np.float32)
        data = runner.PCMWriter(24000).append_pcm(pcm)
        np.testing.assert_array_equal(runner.PCMReader(24000).append_bytes(data), pcm)

    def test_rejects_bad_audio(self):
        reader = runner.PCMReader(24000)
        for data in [b'123', b'0' * 100000, np.array([float('nan')], dtype='<f4').tobytes()]:
            with self.assertRaises(ValueError):
                reader.append_bytes(data)

    def test_requires_secret_and_same_origin(self):
        self.assertTrue(runner.authorized({'X-Apex-Voice-Token': 'secret', 'Origin': 'http://127.0.0.1:8998'}, 'secret', '127.0.0.1:8998'))
        for headers in [{}, {'X-Apex-Voice-Token': 'wrong'}, {'X-Apex-Voice-Token': 'secret', 'Origin': 'https://evil.test'}]:
            self.assertFalse(runner.authorized(headers, 'secret', '127.0.0.1:8998'))


if __name__ == '__main__':
    unittest.main()
