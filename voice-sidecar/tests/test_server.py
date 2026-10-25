"""Run these with the managed Python to exercise the real WebSocket server."""
import asyncio, contextlib, importlib.util, io, json, os, types, unittest
from unittest.mock import patch

class FakeEngines:
 def __init__(self,root):self.voices=['am_michael'];self.semantic_session=None
 def reset(self):pass
 def probability(self,pcm):return 0
 def transcribe(self,pcm,hints):return ''
 def synthesize(self,text,voice):return b'\0'*1024

@unittest.skipUnless(importlib.util.find_spec('websockets'),'Socket tests require the managed runtime')
class SocketTests(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  from voice_sidecar.server import run
  read,write=os.pipe();self.token='a'*64;os.write(write,self.token.encode());os.close(write)
  args=types.SimpleNamespace(token_fd=read,root='unused',port=0,origin=['app://deck','apex-daemon'])
  if getattr(self,'engine',None):args.engine=self.engine
  module='engines_cpu' if getattr(self,'engine',None)=='cpu' else 'engines'
  self.patch=patch('voice_sidecar.'+module+'.Engines',getattr(self,'engines_class',FakeEngines));self.patch.start()
  self.output=io.StringIO();self.redirect=contextlib.redirect_stdout(self.output);self.redirect.__enter__()
  self.task=asyncio.create_task(run(args))
  for i in range(100):
   if self.output.getvalue():break
   if self.task.done():await self.task
   await asyncio.sleep(.01)
  self.url='ws://127.0.0.1:'+str(json.loads(self.output.getvalue().strip())['port'])
 async def asyncTearDown(self):
  self.task.cancel()
  with contextlib.suppress(asyncio.CancelledError):await self.task
  self.redirect.__exit__(None,None,None);self.patch.stop()
 async def test_wrong_origin_and_token_rejected(self):
  from websockets.asyncio.client import connect
  for origin,token in [('https://untrusted.example',self.token),('app://deck','wrong')]:
   async with connect(self.url,origin=origin) as ws:
    with contextlib.suppress(Exception):await ws.send(json.dumps({'type':'auth','token':token}))
    await asyncio.wait_for(ws.wait_closed(),2);self.assertEqual(ws.close_code,1008)
 async def test_one_owner_and_tagged_input_validation(self):
  from websockets.asyncio.client import connect
  async with connect(self.url,origin='app://deck') as first:
   await first.send(json.dumps({'type':'auth','token':self.token}));await first.send(json.dumps({'type':'start','callId':'c','generation':0,'voice':'am_michael'}))
   ready=json.loads(await asyncio.wait_for(first.recv(),2));self.assertEqual(ready['type'],'ready')
   async with connect(self.url,origin='app://deck') as second:
    await second.send(json.dumps({'type':'auth','token':self.token}));await asyncio.wait_for(second.wait_closed(),2);self.assertEqual(second.close_code,1008)
   await first.send(b'malformed');await asyncio.wait_for(first.wait_closed(),2);self.assertEqual(first.close_code,1011)

@unittest.skipUnless(importlib.util.find_spec('websockets'),'Socket tests require the managed runtime')
class LongReplyTests(SocketTests):
 async def asyncSetUp(self):
  import time
  FakeEngines.synthesize=lambda self,text,voice:(time.sleep(.05),b'\0'*1024)[1]
  await super().asyncSetUp()
 async def asyncTearDown(self):
  FakeEngines.synthesize=lambda self,text,voice:b'\0'*1024
  await super().asyncTearDown()
 async def test_long_reply_does_not_drop_call(self):
  from websockets.asyncio.client import connect
  async with connect(self.url,origin='app://deck') as ws:
   await ws.send(json.dumps({'type':'auth','token':self.token}));await ws.send(json.dumps({'type':'start','callId':'c','generation':0,'voice':'am_michael'}))
   self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(),2))['type'],'ready')
   for i in range(40):await ws.send(json.dumps({'type':'speak','callId':'c','generation':0,'requestId':'r','segmentId':i+1,'text':'Sentence number %d.'%i}))
   await ws.send(json.dumps({'type':'playbackComplete','callId':'c','generation':0}))
   await asyncio.sleep(.2);await ws.send(json.dumps({'type':'end','callId':'c','generation':0}))
   # The server closes with 1000 after a clean end; an overflowed queue closes with 1011.
   with contextlib.suppress(Exception):
    while True:await asyncio.wait_for(ws.recv(),3)
   self.assertNotEqual(ws.close_code,1011)

@unittest.skipUnless(importlib.util.find_spec('websockets'),'Socket tests require the managed runtime')
class CpuEngineTests(SocketTests):
 engine='cpu'
 async def test_cpu_stream_emits_first_audio_timing(self):
  from websockets.asyncio.client import connect
  async with connect(self.url,origin='app://deck') as ws:
   await ws.send(json.dumps({'type':'auth','token':self.token}))
   await ws.send(json.dumps({'type':'start','callId':'cpu','generation':0,'voice':'am_michael'}))
   self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(),2))['type'],'ready')
   await ws.send(json.dumps({'type':'speak','callId':'cpu','generation':0,'requestId':'r','segmentId':1,'text':'Ready.'}))
   events=[];audio=[]
   while not any(e.get('type')=='timing' for e in events):
    raw=await asyncio.wait_for(ws.recv(),2)
    if isinstance(raw,bytes):audio.append(raw)
    else:events.append(json.loads(raw))
   self.assertTrue(audio)
   self.assertEqual([e['type'] for e in events],['audioStart','audioEnd','timing'])
   self.assertIsInstance(events[-1]['ttsFirstMs'],int)

@unittest.skipUnless(importlib.util.find_spec('websockets'),'Socket tests require the managed runtime')
class DaemonAuthTests(SocketTests):
 async def test_daemon_auth_acknowledges_exclusive_ownership(self):
  from websockets.asyncio.client import connect
  async with connect(self.url,origin='apex-daemon') as first:
   await first.send(json.dumps({'type':'auth','token':self.token}))
   ack=json.loads(await asyncio.wait_for(first.recv(),.3))
   self.assertEqual(ack,{'type':'authenticated','protocolVersion':1})
   async with connect(self.url,origin='apex-daemon') as second:
    await second.send(json.dumps({'type':'auth','token':self.token}))
    await asyncio.wait_for(second.wait_closed(),1)
    self.assertEqual(second.close_code,1008)

class EchoEngines(FakeEngines):
 def probability(self,pcm):return .95 if pcm[:1]==b'\1' else 0
 def transcribe(self,pcm,hints):return 'Thank you.'

@unittest.skipUnless(importlib.util.find_spec('websockets'),'Socket tests require the managed runtime')
class EchoTests(SocketTests):
 engines_class=EchoEngines
 async def utterance(self,agent_speaking):
  from websockets.asyncio.client import connect
  from voice_sidecar.protocol import encode_audio
  async with connect(self.url,origin='app://deck') as ws:
   await ws.send(json.dumps({'type':'auth','token':self.token}));await ws.send(json.dumps({'type':'start','callId':'c','generation':0,'voice':'am_michael'}))
   self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(),2))['type'],'ready')
   if agent_speaking:
    await ws.send(json.dumps({'type':'speak','callId':'c','generation':0,'requestId':'r','segmentId':1,'text':'Keep the phone open.'}))
    while not isinstance(await asyncio.wait_for(ws.recv(),2),bytes):pass
   for i in range(40):await ws.send(encode_audio(0,i,(b'\1' if i<20 else b'\0')*1024))
   events=[]
   with contextlib.suppress(asyncio.TimeoutError):
    while True:
     raw=await asyncio.wait_for(ws.recv(),.5)
     if not isinstance(raw,bytes):events.append(json.loads(raw))
   return [e for e in events if e['type']=='transcript']
 async def test_stock_phrase_over_the_agent_never_reaches_the_chat(self):
  self.assertEqual(await self.utterance(True),[])
 async def test_stock_phrase_in_a_quiet_room_is_kept(self):
  self.assertEqual([e['text'] for e in await self.utterance(False)],['Thank you.'])
