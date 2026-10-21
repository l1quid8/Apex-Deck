"""Native inference is never forcibly canceled; generations invalidate its results."""
import time


class Pipeline:
    def __init__(self, send, synth, pieces=None):
        self.send = send
        self.synth = synth
        self.pieces = pieces
        self.call_id = ''
        self.generation = 0

    def start(self, call_id, generation):
        self.call_id = call_id
        self.generation = generation

    def cancel(self, generation):
        if generation <= self.generation:
            raise ValueError('Generation must increase')
        self.generation = generation

    async def speak(self, request_id, segment_id, text, voice):
        generation, call_id = self.generation, self.call_id
        started = time.monotonic()
        first_ms = None
        base = dict(callId=call_id, generation=generation, requestId=request_id, segmentId=segment_id)
        pieces = self.pieces(text) if self.pieces else [text]
        for i, piece in enumerate(pieces):
            if (generation, call_id) != (self.generation, self.call_id):
                return first_ms
            audio = await self.synth(piece, voice)
            if (generation, call_id) != (self.generation, self.call_id):
                return first_ms
            if i == 0:
                await self.send(dict(base, type='audioStart', sampleRate=24000))
            else:
                await self.send(dict(base, type='audio', pcm=b'\0' * 4800))
            for offset in range(0, len(audio), 4800):
                if (generation, call_id) != (self.generation, self.call_id):
                    return first_ms
                await self.send(dict(base, type='audio', pcm=audio[offset:offset + 4800]))
                if first_ms is None:
                    first_ms = round((time.monotonic() - started) * 1000)
        if pieces and (generation, call_id) == (self.generation, self.call_id):
            await self.send(dict(base, type='audioEnd'))
        return first_ms
