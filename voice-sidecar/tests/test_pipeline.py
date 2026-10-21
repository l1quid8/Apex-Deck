import unittest, asyncio, struct
from voice_sidecar.protocol import decode_audio, encode_audio, validate_control
from voice_sidecar.endpoint import EndpointDetector
from voice_sidecar.pipeline import Pipeline
class ProtocolTests(unittest.TestCase):
 def test_tagged_audio_and_limits(self):
  frame=encode_audio(3,2,b'\0'*1024)
  self.assertEqual(decode_audio(frame),(3,2,b'\0'*1024))
  for bad in [b'',frame[:8],b'bad'+frame,encode_audio(3,2,b'\0'*32002)]:
   with self.assertRaises(ValueError):decode_audio(bad)
 def test_controls(self):
  with self.assertRaises(ValueError):validate_control('{"type":"speak","text":'+ '"'+ 'x'*70000+'"}')
class EndpointTests(unittest.TestCase):
 def test_noise_preroll_pause_and_limit(self):
  e=EndpointDetector(700)
  for i in range(30):self.assertEqual(e.push(b'\0'*1024,.01),[])
  events=[]
  for i in range(8):events+=e.push(b'\0'*1024,.9)
  self.assertIn('speechStart',events)
  for i in range(10):self.assertNotIn('complete',e.push(b'\0'*1024,.01))
  self.assertNotIn('complete',e.push(b'\0'*1024,.9))
  for i in range(23):events+=e.push(b'\0'*1024,.01)
  self.assertEqual(events.count('complete'),1)
  self.assertLessEqual(len(e.audio),int(30000/32))
class PipelineTests(unittest.IsolatedAsyncioTestCase):
 async def test_late_synthesis_cannot_publish_after_cancel(self):
  entered=asyncio.Event(); release=asyncio.Event(); sent=[]
  async def synth(text,voice):
   entered.set(); await release.wait(); return b'\0'*1024
  async def send(event):sent.append(event)
  p=Pipeline(send,synth); p.start('c',1)
  task=asyncio.create_task(p.speak('r',1,'Hello','am_michael'))
  await entered.wait(); p.cancel(2); release.set(); await task
  self.assertEqual(sent,[])
 async def test_new_generation_speaks_once(self):
  sent=[]
  async def synth(t,v):return b'\0'*1024
  async def send(e):sent.append(e)
  p=Pipeline(send,synth);p.start('c',1);await p.speak('r',1,'Hello','am_michael')
  self.assertEqual([x['type'] for x in sent],['audioStart','audio','audioEnd'])
class LongSpeechTests(unittest.TestCase):
 def test_long_speech_chunks_never_commit_mid_thought(self):
  e=EndpointDetector(700);events=[]
  for i in range(900):events+=e.push(b'\0'*1024,.9)
  self.assertIn('partial-ready',events);self.assertNotIn('complete',events)
  self.assertLess(len(e.audio),782)
class CreditTests(unittest.IsolatedAsyncioTestCase):
 async def test_six_second_output_flows_with_consumption_credits(self):
  from voice_sidecar.protocol import PlaybackCredits
  credits=PlaybackCredits(240000);sent=0
  async def produce():
   nonlocal sent
   for _ in range(60):await credits.reserve(4800);sent+=4800
  task=asyncio.create_task(produce());await asyncio.sleep(.01)
  self.assertEqual(sent,240000);credits.consumed(48000);await asyncio.wait_for(task,1);self.assertEqual(sent,288000)
class SemanticTests(unittest.TestCase):
 def test_incomplete_thought_defers_until_two_seconds_of_quiet(self):
  e=EndpointDetector(700,semantic=True)
  for i in range(8):e.push(b'\0'*1024,.9)
  events=[]
  for i in range(23):events+=e.push(b'\0'*1024,.01)
  self.assertIn('candidate',events);self.assertNotIn('complete',events)
  self.assertTrue(e.active)
  for i in range(41):events+=e.push(b'\0'*1024,.01)
  self.assertIn('complete',events)

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

class CancelDuringSendTests(unittest.IsolatedAsyncioTestCase):
 async def test_cancel_on_last_chunk_does_not_synthesize_the_next_piece(self):
  calls=[]
  async def synth(text, voice):
   calls.append(text)
   return b'\0' * 1024
  async def send(event):
   if event['type']=='audio': pipe.cancel(1)
  pipe=Pipeline(send,synth,lambda text:['first piece','second piece'])
  pipe.start('call',0)
  await pipe.speak('reply',1,'ignored','am_michael')
  self.assertEqual(calls,['first piece'])
