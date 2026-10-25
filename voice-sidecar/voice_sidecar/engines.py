"""One executor owns all MLX operations. No downloads during calls."""
import os, pathlib
from .made_up import made_up
class Engines:
 def __init__(self,root):
  import mlx.core as mx, torch
  from mlx_audio.tts.utils import load
  from mlx_whisper.transcribe import ModelHolder
  from silero_vad import load_silero_vad
  mx.set_cache_limit(256*1024*1024);torch.set_num_threads(1)
  self.root=pathlib.Path(root);self.stt_path=str(self.root/'models'/'whisper');self.tts_path=self.root/'models'/'kokoro'
  self.voices=sorted(p.stem for p in (self.tts_path/'voices').glob('[ab][fm]_*.safetensors'))
  ModelHolder.get_model(self.stt_path,mx.float16);self.tts=load(str(self.tts_path));self.vad=load_silero_vad()
  import numpy as np
  self.semantic_session=None
  semantic_path=self.root/'models'/'smart-turn'/'smart-turn-v3.2-cpu.onnx'
  if semantic_path.exists():
   import onnxruntime as ort
   from transformers import WhisperFeatureExtractor
   options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
   self.semantic_session=ort.InferenceSession(str(semantic_path),sess_options=options,providers=['CPUExecutionProvider'])
   self.extractor=WhisperFeatureExtractor(chunk_length=8)
  self.transcribe(np.zeros(16000,dtype="<i2").tobytes(),[])
  self.synthesize("Ready.","am_michael")
 def probability(self,pcm):
  import numpy as np, torch
  return self.vad(torch.from_numpy(np.frombuffer(pcm,dtype='<i2').astype(np.float32)/32768),16000).item()
 def reset(self):self.vad.reset_states()
 def transcribe(self,pcm,hints):
  import numpy as np
  from mlx_whisper import transcribe
  r=transcribe(np.frombuffer(pcm,dtype='<i2').astype(np.float32)/32768,path_or_hf_repo=self.stt_path,language='en',temperature=0.,condition_on_previous_text=False,initial_prompt=', '.join(hints),verbose=None)
  segments=r.get('segments') or []
  if not segments or all(s.get('no_speech_prob',0)>.8 for s in segments):return ''
  text=r['text'].strip()
  return '' if made_up(text,hints,[s.get('compression_ratio',0) for s in segments],[s.get('no_speech_prob',0) for s in segments],[s.get('avg_logprob',0) for s in segments]) else text
 def synthesize(self,text,voice):
  import numpy as np
  if voice not in self.voices:raise ValueError('Choose an installed voice')
  chunks=[np.asarray(r.audio,dtype=np.float32).reshape(-1) for r in self.tts.generate(text=text,voice=str(self.tts_path/'voices'/f'{voice}.safetensors'),speed=1.,lang_code=voice[0])]
  audio=np.concatenate(chunks) if chunks else np.zeros(0,np.float32)
  return (np.clip(audio,-1,1)*32767).astype('<i2').tobytes()

 def complete(self,pcm):
  if self.semantic_session is None:return True
  import numpy as np
  audio=np.frombuffer(pcm,dtype='<i2').astype(np.float32)[-128000:]/32768
  audio=np.pad(audio,(max(0,128000-len(audio)),0))
  inputs=self.extractor(audio,sampling_rate=16000,return_tensors='np',padding='max_length',max_length=128000,truncation=True,do_normalize=True)
  return float(self.semantic_session.run(None,{'input_features':inputs.input_features.astype(np.float32)})[0].reshape(-1)[0])>.5
