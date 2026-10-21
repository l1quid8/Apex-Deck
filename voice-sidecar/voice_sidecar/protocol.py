"""v1 little-endian header: magic (DV), version (u16), generation/sequence (u32)."""
import json, struct
HEADER=struct.Struct('<2sHII')
def encode_audio(generation, sequence, pcm):
 return HEADER.pack(b'DV',1,generation,sequence)+pcm
def decode_audio(frame):
 if len(frame)<HEADER.size+2 or len(frame)>HEADER.size+32000 or len(frame)%2:raise ValueError('Invalid audio length')
 magic,version,generation,sequence=HEADER.unpack_from(frame)
 if magic!=b'DV' or version!=1:raise ValueError('Invalid protocol')
 return generation,sequence,frame[HEADER.size:]
def validate_control(raw):
 if not isinstance(raw,str) or len(raw.encode())>65536:raise ValueError('Control too large')
 value=json.loads(raw)
 if not isinstance(value,dict) or value.get('type') not in ('auth','start','speak','cancel','playbackComplete','playbackProgress','end'):raise ValueError('Unknown control')
 return value

class PlaybackCredits:
 """Bound pending PCM by bytes actually consumed, not by synthesis completion."""
 def __init__(self,capacity=240000):
  import asyncio
  self.capacity=capacity;self.pending=0;self.wake=asyncio.Event()
 async def reserve(self,size):
  import asyncio
  if size>self.capacity:raise ValueError('Audio chunk exceeds playback window')
  while self.pending+size>self.capacity:
   self.wake.clear();await asyncio.wait_for(self.wake.wait(),10)
  self.pending+=size
 def consumed(self,size):
  if not isinstance(size,int) or size<0 or size>self.capacity:raise ValueError('Invalid playback credit')
  self.pending=max(0,self.pending-size);self.wake.set()
 def reset(self):self.pending=0;self.wake.set()
