"""Bounded Silero endpoint policy. Silence-based; semantic endpointing is not claimed."""
from collections import deque
# Speech that starts while the agent is audible must be clearer and longer (~320 ms), so speaker echo or room noise does not cut it off.
OVER_AGENT_RUN=10
OVER_AGENT_PROB=.85
class EndpointDetector:
 def __init__(self,silence_ms=100,semantic=False):
  self.semantic=semantic;self.last_candidate=0;self.silence_ms=max(100,min(2000,silence_ms));self.audio=[];self.ring=deque(maxlen=20);self.active=False;self.run=0;self.quiet=0;self.voiced=0;self.chunk=None;self.over_agent=False
 def push(self,pcm,prob,agent_audible=False):
  events=[]
  if not self.active:
   need,floor=(OVER_AGENT_RUN,OVER_AGENT_PROB) if agent_audible else (4,.6)
   self.ring.append(pcm);self.run=self.run+1 if prob>=floor else 0
   if self.run<need:return events
   self.active=True;self.over_agent=agent_audible;self.audio=list(self.ring);self.ring.clear();self.voiced=self.run;self.quiet=0;self.last_candidate=0;events.append('speechStart')
  else:
   self.audio.append(pcm)
   if prob>=.35:self.quiet=0;self.last_candidate=0;self.voiced+=1
   else:self.quiet+=1
  if len(self.audio)>=int(25000/32) and self.quiet*32<self.silence_ms:
   self.chunk=b''.join(self.audio);self.audio=self.audio[-20:];events.append('partial-ready')
  if self.quiet*32>=self.silence_ms:
   if self.semantic and self.quiet*32<2000:
    # Ask Smart Turn as soon as the pause is reached, then every ~100 ms (3 frames) until 2 s.
    if not self.last_candidate or self.quiet-self.last_candidate>=3:
     self.last_candidate=self.quiet;events.append('candidate')
    return events
   self.active=False;self.run=0
   if self.voiced>=6:events.append('complete')
   else:self.audio=[]
  return events
 def take(self):
  audio=b''.join(self.audio);self.audio=[];return audio

 def take_chunk(self):
  chunk=self.chunk;self.chunk=None;return chunk
