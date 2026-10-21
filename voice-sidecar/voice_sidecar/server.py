"""Authenticated loopback audio service; never handles agent credentials or execution."""
import argparse,asyncio,concurrent.futures,json,os,secrets,sys,time
from .protocol import validate_control,decode_audio,encode_audio,PlaybackCredits
from .endpoint import EndpointDetector
from .pipeline import Pipeline

async def run(args):
 from websockets.asyncio.server import serve
 from .engines import Engines
 token=os.read(args.token_fd,256).decode().strip();os.close(args.token_fd)
 if len(token)<32:raise ValueError('Missing runtime token')
 pool=concurrent.futures.ThreadPoolExecutor(max_workers=1)
 loop=asyncio.get_running_loop()
 engines=await loop.run_in_executor(pool,Engines,args.root)
 owner=None
 async def handle(ws):
  nonlocal owner
  origin=ws.request.headers.get('Origin','')
  if origin not in args.origin:await ws.close(1008,'Origin rejected');return
  try:
   auth=validate_control(await asyncio.wait_for(ws.recv(),5))
   if auth.get('type')!='auth' or not secrets.compare_digest(str(auth.get('token','')),token):await ws.close(1008,'Authentication failed');return
   if owner is not None:await ws.close(1008,'Call already active');return
   owner=ws
   sequence=0;last_input=-1;pending=set();chunks=[];speech_queue=asyncio.Queue(maxsize=512)
   async def send(event):
    nonlocal sequence
    if event['type']=='audio':
     window=credits;await window.reserve(len(event['pcm']))
     if event['generation']!=pipe.generation:return
     sequence+=1
     await ws.send(encode_audio(event['generation'],sequence,event['pcm']))
    else:await ws.send(json.dumps(event))
   async def synth(t,v):return await loop.run_in_executor(pool,engines.synthesize,t,v)
   pipe=Pipeline(send,synth);endpoint=EndpointDetector();voice='am_michael';hints=[];credits=PlaybackCredits()
   async def speaker():
    while True:
     gen,rid,sid,text,v=await speech_queue.get()
     if gen==pipe.generation:
      t=time.monotonic();await pipe.speak(rid,sid,text,v)
      await send(dict(type='timing',callId=pipe.call_id,generation=pipe.generation,ttsMs=round((time.monotonic()-t)*1000)))
   speaker_task=asyncio.create_task(speaker())
   async def transcribe_chunk(pcm):
    return await loop.run_in_executor(pool,engines.transcribe,pcm,hints)
   async def transcript(tasks,gen,call):
    t=time.monotonic();parts=await asyncio.gather(*tasks);words=[]
    for part in parts:
     next_words=part.split();overlap=0
     for n in range(1,min(30,len(words),len(next_words))+1):
      if [w.lower().strip('.,!?') for w in words[-n:]]==[w.lower().strip('.,!?') for w in next_words[:n]]:overlap=n
     words.extend(next_words[overlap:])
    text=' '.join(words)
    if gen==pipe.generation and call==pipe.call_id and text:
     await send(dict(type='transcript',callId=call,generation=gen,utteranceId=secrets.token_hex(12),text=text))
     await send(dict(type='timing',callId=call,generation=gen,sttMs=round((time.monotonic()-t)*1000)))
   async for raw in ws:
    if isinstance(raw,bytes):
     gen,seq,pcm=decode_audio(raw)
     if gen!=pipe.generation:continue
     if not pipe.call_id or seq<=last_input or len(pcm)!=1024:raise ValueError('Invalid capture sequence')
     last_input=seq
     prob=await asyncio.to_thread(engines.probability,pcm)
     events=endpoint.push(pcm,prob)
     if 'candidate' in events:
      complete=await loop.run_in_executor(pool,engines.complete,b''.join(endpoint.audio))
      if complete:
       endpoint.active=False;endpoint.run=0;events.append('complete')
     for event in events:
      if event=='speechStart':await send(dict(type='speechStart',callId=pipe.call_id,generation=gen))
      elif event=='partial-ready':
       if len(chunks)>=8:raise ValueError('Utterance too long; please pause')
       chunks.append(asyncio.create_task(transcribe_chunk(endpoint.take_chunk())))
      elif event=='complete':
       if len(pending)>=2:raise ValueError('Speech processing overloaded')
       chunks.append(asyncio.create_task(transcribe_chunk(endpoint.take())))
       task=asyncio.create_task(transcript(list(chunks),gen,pipe.call_id));chunks.clear();pending.add(task);task.add_done_callback(pending.discard)
    else:
     msg=validate_control(raw);kind=msg['type']
     if kind=='start':
      if pipe.call_id:raise ValueError('Call already started')
      call=msg.get('callId');gen=msg.get('generation')
      if not isinstance(call,str) or not 1<=len(call)<=128 or not isinstance(gen,int) or not 0<=gen<2**32:raise ValueError('Invalid call')
      voice=msg.get('voice','am_michael')
      if not isinstance(voice,str) or len(voice)>64:raise ValueError('Invalid voice')
      silence=msg.get('silenceMs',700)
      if not isinstance(silence,(int,float)) or not 300<=silence<=2000:raise ValueError('Invalid endpoint')
      raw_hints=msg.get('nameHints',[])
      if not isinstance(raw_hints,list) or len(raw_hints)>64 or any(not isinstance(h,str) or len(h)>64 for h in raw_hints):raise ValueError('Invalid hints')
      hints=raw_hints;endpoint=EndpointDetector(silence,semantic=engines.semantic_session is not None);await loop.run_in_executor(pool,engines.reset)
      pipe.start(call,gen);await send(dict(type='ready',callId=call,generation=gen,voices=engines.voices,semantic=engines.semantic_session is not None))
     elif msg.get('callId')==pipe.call_id:
      if kind=='cancel':
       gen=msg.get('generation')
       if not isinstance(gen,int) or not 0<=gen<2**32:raise ValueError('Invalid generation')
       pipe.cancel(gen);credits.reset();credits=PlaybackCredits()
       if msg.get("resetInput") is True:
        endpoint=EndpointDetector(endpoint.silence_ms,semantic=engines.semantic_session is not None)
        for task in chunks:task.cancel()
        chunks.clear();await asyncio.to_thread(engines.reset)
       while not speech_queue.empty():speech_queue.get_nowait()
      elif msg.get('generation')==pipe.generation:
       if kind=='speak':
        text=msg.get('text','');v=msg.get('voice',voice);sid=msg.get('segmentId');rid=msg.get('requestId')
        if not isinstance(text,str) or len(text)>2048 or len(text.split())>22 or v not in engines.voices or not isinstance(sid,int) or not isinstance(rid,str) or len(rid)>128:raise ValueError('Invalid speech segment')
        # Long replies stream in faster than Kokoro speaks; a full queue drops the segment, never the call.
        if speech_queue.full():print(json.dumps({'type':'speechDropped'}),file=sys.stderr,flush=True)
        else:speech_queue.put_nowait((pipe.generation,rid,sid,text,v))
       elif kind=='playbackProgress':credits.consumed(msg.get('bytes'))
       elif kind=='playbackComplete':pass
       elif kind=='end':break
    if speaker_task.done():await speaker_task
  except Exception as error:
   # Never log transcripts, tokens, or audio.
   # ValueError messages are our own fixed strings, so they are safe to log.
   print(json.dumps({'type':'sessionError','class':type(error).__name__,'message':str(error)[:200] if isinstance(error,ValueError) else ''}),file=sys.stderr,flush=True)
   await ws.close(1011,'Voice session ended')
  finally:
   if owner is ws:
    owner=None
    if 'pipe' in locals():pipe.generation+=1
    for task in list(locals().get('pending',[]))+list(locals().get('chunks',[])):task.cancel()
    if 'speaker_task' in locals():speaker_task.cancel()
 async with serve(handle,'127.0.0.1',args.port,max_size=65536,max_queue=32,write_limit=65536) as server:
  print(json.dumps({'type':'ready','port':server.sockets[0].getsockname()[1],'protocolVersion':1}),flush=True)
  await asyncio.Future()

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=0);p.add_argument('--token-fd',type=int,required=True);p.add_argument('--root',required=True);p.add_argument('--origin',action='append',default=[])
 asyncio.run(run(p.parse_args()))
