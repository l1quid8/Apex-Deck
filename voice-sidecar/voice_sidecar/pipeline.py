"""Native inference is never forcibly canceled; generations invalidate its results."""
class Pipeline:
 def __init__(self,send,synth):self.send=send;self.synth=synth;self.call_id='';self.generation=0
 def start(self,call_id,generation):self.call_id=call_id;self.generation=generation
 def cancel(self,generation):
  if generation<=self.generation:raise ValueError('Generation must increase')
  self.generation=generation
 async def speak(self,request_id,segment_id,text,voice):
  generation=self.generation;call_id=self.call_id
  audio=await self.synth(text,voice)
  if (generation,call_id)!=(self.generation,self.call_id):return
  base=dict(callId=call_id,generation=generation,requestId=request_id,segmentId=segment_id)
  await self.send(dict(base,type='audioStart',sampleRate=24000))
  for offset in range(0,len(audio),4800):
   if generation!=self.generation:return
   await self.send(dict(base,type='audio',pcm=audio[offset:offset+4800]))
  await self.send(dict(base,type='audioEnd'))
