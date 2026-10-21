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
  args=types.SimpleNamespace(token_fd=read,root='unused',port=0,origin=['app://deck'])
  self.patch=patch('voice_sidecar.engines.Engines',FakeEngines);self.patch.start()
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
