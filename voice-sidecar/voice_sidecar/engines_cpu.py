"""CPU speech inference. Imports no torch/MLX and never downloads during calls."""
import importlib.util
import os
import pathlib
import re
from .made_up import made_up
from .pieces import speech_pieces


class SileroOnnx:
    def __init__(self, session):
        self.session = session
        self.reset()

    def reset(self):
        import numpy as np
        self.state = np.zeros((2, 1, 128), np.float32)
        self.context = np.zeros((1, 64), np.float32)

    def __call__(self, pcm):
        import numpy as np
        frame = np.frombuffer(pcm, '<i2').astype(np.float32).reshape(1, -1) / 32768
        if frame.shape != (1, 512):
            raise ValueError('Expected a 512-sample VAD frame')
        audio = np.concatenate((self.context, frame), axis=1)
        output, self.state = self.session.run(None, {'input': audio, 'state': self.state, 'sr': np.array(16000, np.int64)})
        self.context = frame[:, -64:].copy()
        return float(output.reshape(-1)[0])

    @classmethod
    def load(cls):
        import onnxruntime as ort
        spec = importlib.util.find_spec('silero_vad')
        root = pathlib.Path(next(iter(spec.submodule_search_locations)))
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        return cls(ort.InferenceSession(str(root / 'data/silero_vad.onnx'), sess_options=options, providers=['CPUExecutionProvider']))


class Engines:
    pieces = staticmethod(speech_pieces)

    def __init__(self, root):
        import numpy as np
        import onnxruntime as ort
        from faster_whisper import WhisperModel
        from kokoro_onnx import Kokoro
        from transformers import WhisperFeatureExtractor
        self.root = pathlib.Path(root)
        threads = max(2, (os.cpu_count() or 4) - 2)
        self.stt = WhisperModel(str(self.root / 'models/whisper-base-en'), device='cpu', compute_type='int8', cpu_threads=threads)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        tts_path = self.root / 'models/kokoro'
        session = ort.InferenceSession(str(tts_path / 'kokoro-v1.0.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
        self.tts = Kokoro.from_session(session, str(tts_path / 'voices-v1.0.bin'))
        self.voices = sorted(v for v in self.tts.get_voices() if re.fullmatch(r'[ab][fm]_[a-z]+', v))
        self.vad = SileroOnnx.load()
        self.semantic_session = None
        semantic_path = self.root / 'models/smart-turn/smart-turn-v3.2-cpu.onnx'
        if semantic_path.exists():
            options = ort.SessionOptions()
            options.intra_op_num_threads = options.inter_op_num_threads = 1
            self.semantic_session = ort.InferenceSession(str(semantic_path), sess_options=options, providers=['CPUExecutionProvider'])
            self.extractor = WhisperFeatureExtractor(chunk_length=8)
        self.transcribe(np.zeros(16000, dtype='<i2').tobytes(), [])
        self.synthesize('Ready.', 'am_michael')

    def probability(self, pcm):
        return self.vad(pcm)

    def reset(self):
        self.vad.reset()

    def transcribe(self, pcm, hints):
        import numpy as np
        audio = np.frombuffer(pcm, '<i2').astype(np.float32) / 32768
        segments, _ = self.stt.transcribe(audio, language='en', beam_size=1, temperature=0.0,
                                        condition_on_previous_text=False, initial_prompt=', '.join(hints) or None, vad_filter=False)
        segments = list(segments)
        if not segments or all(s.no_speech_prob > .8 for s in segments):
            return ''
        text = ' '.join(s.text.strip() for s in segments).strip()
        return '' if made_up(text, hints, [s.compression_ratio for s in segments],
                             [s.no_speech_prob for s in segments], [s.avg_logprob for s in segments]) else text

    def synthesize(self, text, voice):
        import numpy as np
        if voice not in self.voices:
            raise ValueError('Choose an installed voice')
        audio, rate = self.tts.create(text, voice=voice, speed=1.0, lang='en-us' if voice[0] == 'a' else 'en-gb')
        if rate != 24000:
            raise ValueError('Expected 24 kHz speech')
        return (np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()

    def complete(self, pcm):
        if self.semantic_session is None:
            return True
        import numpy as np
        audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32)[-128000:] / 32768
        audio = np.pad(audio, (max(0, 128000 - len(audio)), 0))
        inputs = self.extractor(audio, sampling_rate=16000, return_tensors='np', padding='max_length', max_length=128000, truncation=True, do_normalize=True)
        return float(self.semantic_session.run(None, {'input_features': inputs.input_features.astype(np.float32)})[0].reshape(-1)[0]) > .5
