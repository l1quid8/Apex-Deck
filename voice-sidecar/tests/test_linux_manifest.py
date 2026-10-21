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
            self.assertRegex(w['filename'], r'-(py3-none-any|py3-none-manylinux.*x86_64|py2\.py3-none-any|cp311-cp311-manylinux.*x86_64|cp3\d+-abi3-manylinux.*x86_64)\.whl$')

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
