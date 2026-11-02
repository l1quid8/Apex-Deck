"""Regression tests for voice-pipeline overhaul: logging, stall recovery, in-flight preservation, echo & rejected events."""
import asyncio, contextlib, importlib.util, io, json, os, types, unittest
from unittest.mock import patch

@unittest.skipUnless(importlib.util.find_spec('websockets'), 'requires managed runtime')
class RobustnessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from voice_sidecar.server import run
        read, write = os.pipe()
        self.token = 'a'*64
        os.write(write, self.token.encode())
        os.close(write)
        args = types.SimpleNamespace(token_fd=read, root='unused', port=0, origin=['app://deck'])
        # Fake engines that let us control transcription
        class Fake:
            def __init__(self, root):
                self.voices = ['am_michael']
                self.semantic_session = None
                self.probs = []
                self.calls = []
                self.stt_delay = 0.3
            def reset(self): pass
            def probability(self, pcm):
                return self.probs.pop(0) if self.probs else 0
            def transcribe(self, pcm, hints):
                import time
                time.sleep(self.stt_delay)
                self.calls.append(len(pcm))
                # return dict per new API
                idx = len(self.calls)
                return {'text': f'utterance{idx}', 'no_speech': [0.1], 'logprob': [-0.2], 'ratio': [1.0]}
            def synthesize(self, text, voice):
                return b'\0'*48000
        self.Fake = Fake
        Fake.instance = None
        def fake_ctor(root):
            inst = Fake(root)
            Fake.instance = inst
            return inst
        # Patch the engines module that server imports based on engine name
        self.patch = patch('voice_sidecar.engines.Engines', fake_ctor)
        self.patch.start()
        self.output = io.StringIO()
        self.redir = contextlib.redirect_stdout(self.output)
        self.redir.__enter__()
        self.task = asyncio.create_task(run(args))
        for _ in range(100):
            if self.output.getvalue():
                break
            await asyncio.sleep(0.01)
        self.url = 'ws://127.0.0.1:' + str(json.loads(self.output.getvalue().strip())['port'])

    async def asyncTearDown(self):
        self.task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.task
        self.redir.__exit__(None, None, None)
        self.patch.stop()

    async def test_resume_during_whisper_keeps_both(self):
        """R3: if user pauses and resumes while Whisper works, both fragments are delivered."""
        from websockets.asyncio.client import connect
        from voice_sidecar.protocol import encode_audio
        Fake = self.Fake
        # Ensure transcribe delay so second utterance starts before first finishes
        async with connect(self.url, origin='app://deck') as ws:
            await ws.send(json.dumps({'type':'auth','token':self.token}))
            await ws.send(json.dumps({'type':'start','callId':'c','generation':0,'voice':'am_michael','silenceMs':100}))
            self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(),2))['type'],'ready')
            # Set up probs: 12 voiced + 6 silence twice
            Fake.instance.probs = ([0.9]*12 + [0]*6) + ([0.9]*12 + [0]*6)
            gen = 0
            seq = 0
            got = []
            async def rx():
                nonlocal gen
                async for m in ws:
                    if isinstance(m, str):
                        e = json.loads(m)
                        if e['type']=='speechStart':
                            gen+=1
                            await ws.send(json.dumps({'type':'cancel','callId':'c','generation':gen,'resetInput':False}))
                        if e['type']=='transcript':
                            got.append(e['text'])
            r = asyncio.create_task(rx())
            # Send audio frames
            for _ in range(36):
                seq+=1
                await ws.send(encode_audio(gen, seq, b'\1\0'*512))
                await asyncio.sleep(0.032)
            await asyncio.sleep(2.5)
            r.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await r
            # Should have both utterances, not just second
            self.assertIn('utterance1', got, f"first fragment lost, got {got}")
            self.assertIn('utterance2', got, f"second fragment lost, got {got}")

    async def test_playback_without_progress_is_recoverable(self):
        """R1: if client never sends playbackProgress, TTS should still flow via stallRecover, not close with 1011."""
        from websockets.asyncio.client import connect
        async with connect(self.url, origin='app://deck') as ws:
            await ws.send(json.dumps({'type':'auth','token':self.token}))
            await ws.send(json.dumps({'type':'start','callId':'c','generation':0,'voice':'am_michael'}))
            self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(),2))['type'],'ready')
            for i in range(12):
                await ws.send(json.dumps({'type':'speak','callId':'c','generation':0,'requestId':'r','segmentId':i+1,'text':f'Sentence {i}.'}))
            audio_bytes = 0
            async def pump():
                nonlocal audio_bytes
                try:
                    async for m in ws:
                        if isinstance(m, bytes):
                            audio_bytes+=len(m)-12
                except (asyncio.CancelledError, Exception):
                    return
            p = asyncio.create_task(pump())
            # Never send playbackProgress, but send playbackComplete occasionally to mimic original repro
            for _ in range(5):
                await asyncio.sleep(1)
                with contextlib.suppress(Exception):
                    await ws.send(json.dumps({'type':'playbackComplete','callId':'c','generation':0}))
                if ws.close_code:
                    break
            p.cancel()
            with contextlib.suppress(Exception):
                await p
            # All 12 sentences = 12 * 48000 = 576000 bytes = 12 sec
            # With recovery, should deliver close to 12 sec, not 5 sec, and not close with 1011
            self.assertNotEqual(ws.close_code, 1011, "call ended with overload 1011")
            self.assertGreaterEqual(audio_bytes, 48000*10, f"only {audio_bytes/48000:.1f}s delivered, expected >=10s")

    async def test_transcript_rejected_event_and_echo(self):
        """New events: transcriptRejected and echo detection."""
        from websockets.asyncio.client import connect
        from voice_sidecar.protocol import encode_audio
        async with connect(self.url, origin='app://deck') as ws:
            await ws.send(json.dumps({'type':'auth','token':self.token}))
            await ws.send(json.dumps({'type':'start','callId':'c','generation':0,'voice':'am_michael'}))
            self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(),2))['type'],'ready')
            # Agent says something
            await ws.send(json.dumps({'type':'speak','callId':'c','generation':0,'requestId':'r','segmentId':1,'text':'Keep the phone open.'}))
            # Wait for audio
            while True:
                raw = await asyncio.wait_for(ws.recv(),2)
                if isinstance(raw, bytes):
                    break
            # Configure engine for echo test: high VAD prob and echo transcript
            def echo_transcribe(pcm, hints):
                return {'text':'Keep the phone open.', 'no_speech':[0.1], 'logprob':[-0.2], 'ratio':[1.0]}
            self.Fake.instance.transcribe = echo_transcribe
            self.Fake.instance.probs = [0.95]*25 + [0]*10
            # Now user says same phrase (echo)
            for i in range(35):
                await ws.send(encode_audio(0, i+1, b'\1\0'*512))
                await asyncio.sleep(0.02)
            events=[]
            with contextlib.suppress(asyncio.TimeoutError):
                while True:
                    raw=await asyncio.wait_for(ws.recv(),1.0)
                    if not isinstance(raw, bytes):
                        events.append(json.loads(raw))
            rejected=[e for e in events if e['type']=='transcriptRejected']
            transcripts=[e for e in events if e['type']=='transcript']
            self.assertEqual(len(transcripts),0, f"echo should be rejected, got transcripts {transcripts}, all {events}")
            self.assertTrue(any(e.get('reason')=='echo' for e in rejected), f"expected echo rejection, got {rejected}")
