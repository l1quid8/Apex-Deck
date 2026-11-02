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

    async def _session(self, ws):
        await ws.send(json.dumps({'type':'auth','token':self.token}))
        await ws.send(json.dumps({'type':'start','callId':'c','generation':0,'voice':'am_michael','silenceMs':100}))
        self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(),2))['type'],'ready')

    async def _speak_frames(self, ws, frames, seq=0):
        from voice_sidecar.protocol import encode_audio
        for pcm in frames:
            seq+=1
            await ws.send(encode_audio(0, seq, pcm))
            await asyncio.sleep(0.005)
        events=[]
        with contextlib.suppress(asyncio.TimeoutError):
            while True:
                raw=await asyncio.wait_for(ws.recv(),0.8)
                if not isinstance(raw, bytes):
                    events.append(json.loads(raw))
        return events

    async def test_playback_waits_for_a_stalled_device_and_loses_nothing(self):
        """R1: a paused or stalled player holds speech back; nothing beyond the five-second buffer is sent, the call stays up, and all of it arrives once playback moves."""
        from websockets.asyncio.client import connect
        async with connect(self.url, origin='app://deck') as ws:
            await self._session(ws)
            for i in range(12):
                await ws.send(json.dumps({'type':'speak','callId':'c','generation':0,'requestId':'r','segmentId':i+1,'text':f'Sentence {i}.'}))
            audio_bytes = 0
            async def pump():
                nonlocal audio_bytes
                async for m in ws:
                    if isinstance(m, bytes):
                        audio_bytes+=len(m)-12
            p = asyncio.create_task(pump())
            await asyncio.sleep(4.5)
            self.assertIsNone(ws.close_code, "call ended during a stall")
            self.assertLessEqual(audio_bytes, 240000, "sent more than the player can hold")
            for _ in range(8):
                await ws.send(json.dumps({'type':'playbackProgress','callId':'c','generation':0,'bytes':48000}))
                await asyncio.sleep(0.05)
            await asyncio.sleep(0.3)
            p.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await p
            self.assertEqual(audio_bytes, 576000)

    async def test_speech_too_short_to_transcribe_is_reported(self):
        """A start of speech that never completes must not leave the client waiting: a paused reply resumes on this event."""
        from websockets.asyncio.client import connect
        async with connect(self.url, origin='app://deck') as ws:
            await self._session(ws)
            self.Fake.instance.probs = [0.9]*4 + [0]*8
            events = await self._speak_frames(ws, [b'\1\0'*512]*12)
            self.assertEqual([e['type'] for e in events], ['speechStart','transcriptRejected'])
            self.assertEqual(events[1]['reason'], 'tooShort')

    async def test_short_loud_word_survives_a_silent_tail(self):
        """The energy check reads the speech, not the quiet frame that ended it."""
        from websockets.asyncio.client import connect
        async with connect(self.url, origin='app://deck') as ws:
            await self._session(ws)
            self.Fake.instance.stt_delay = 0
            self.Fake.instance.transcribe = lambda pcm, hints: {'text':'Cancel', 'no_speech':[0.1], 'logprob':[-0.2], 'ratio':[1.0]}
            self.Fake.instance.probs = [0.9]*7 + [0]*6
            events = await self._speak_frames(ws, [b'\0\x20'*512]*7 + [b'\0\0'*512]*6)
            self.assertEqual([e.get('text') for e in events if e['type']=='transcript'], ['Cancel'], events)

    async def test_answering_the_agents_question_is_not_echo(self):
        """Quiet playback: repeating a word the agent said is an answer, not the speakers."""
        from websockets.asyncio.client import connect
        async with connect(self.url, origin='app://deck') as ws:
            await self._session(ws)
            await ws.send(json.dumps({'type':'speak','callId':'c','generation':0,'requestId':'r','segmentId':1,'text':'Say yes or say cancel.'}))
            while not isinstance(await asyncio.wait_for(ws.recv(),2), bytes): pass
            await ws.send(json.dumps({'type':'playbackProgress','callId':'c','generation':0,'bytes':48000}))
            await asyncio.sleep(0.05)
            self.Fake.instance.stt_delay = 0
            self.Fake.instance.transcribe = lambda pcm, hints: {'text':'Yes.', 'no_speech':[0.1], 'logprob':[-0.2], 'ratio':[1.0]}
            self.Fake.instance.probs = [0.9]*12 + [0]*6
            events = await self._speak_frames(ws, [b'\0\x20'*512]*18)
            self.assertEqual([e.get('text') for e in events if e['type']=='transcript'], ['Yes.'], events)

    async def test_frame_logging_is_sampled(self):
        """Per-frame audio lines would flood the log; about one a second is enough."""
        from websockets.asyncio.client import connect
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            async with connect(self.url, origin='app://deck') as ws:
                await self._session(ws)
                await self._speak_frames(ws, [b'\1\0'*512]*62)
        chunks = [l for l in err.getvalue().splitlines() if '"audioChunk"' in l]
        self.assertEqual(len(chunks), 2)

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
