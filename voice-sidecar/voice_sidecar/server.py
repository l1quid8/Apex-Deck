"""Authenticated loopback audio service; never handles agent credentials or execution."""
import argparse,asyncio,concurrent.futures,json,math,os,re,secrets,struct,sys,time
from collections import deque
from .protocol import validate_control,decode_audio,encode_audio,PlaybackCredits
from .endpoint import EndpointDetector
from .pipeline import Pipeline
from .made_up import STOCK_PHRASES, made_up, stock_phrase, words_of

def _voice_log(event, call_id='', generation=None, **fields):
    payload = {'ts': time.time(), 'type': 'voiceLog', 'event': event}
    if call_id:
        payload['callId'] = call_id
    if generation is not None:
        payload['generation'] = generation
    for k, v in fields.items():
        if k in ('text','transcript','utterance'):
            continue
        payload[k] = v
    print(json.dumps(payload), file=sys.stderr, flush=True)

def _rms(pcm_bytes: bytes) -> int:
    try:
        n = len(pcm_bytes)//2
        if n==0:
            return 0
        fmt = '<' + 'h'*n
        samples = struct.unpack(fmt, pcm_bytes[:n*2])
        s=0
        for v in samples:
            s+=v*v
        return int(math.sqrt(s/n)) if n else 0
    except Exception:
        return 0

def _normalize_words(text: str):
    return [w.lower().strip('.,!?;:"\'') for w in text.split() if w.strip('.,!?;:"\'')]

def _is_echo(transcript: str, recent_texts: deque) -> bool:
    t_words=_normalize_words(transcript)
    if not t_words:
        return False
    t_joined=' '.join(t_words)
    for recent in recent_texts:
        r_words=_normalize_words(recent)
        if not r_words:
            continue
        r_joined=' '.join(r_words)
        if t_joined and t_joined in r_joined:
            return True
        if len(t_words)<=len(r_words):
            for i in range(len(r_words)-len(t_words)+1):
                if r_words[i:i+len(t_words)]==t_words:
                    return True
        if len(t_words)>=2:
            common=len(set(t_words)&set(r_words))
            if common/len(set(t_words))>=0.8 and len(t_words)<=6:
                return True
    return False

async def run(args):
 from websockets.asyncio.server import serve
 if getattr(args,'engine','mlx')=='cpu':
  from .engines_cpu import Engines
 else:
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
  end_reason='unknown'
  call_started_at=None
  mic_open=False
  try:
   auth=validate_control(await asyncio.wait_for(ws.recv(),5))
   if auth.get('type')!='auth' or not secrets.compare_digest(str(auth.get('token','')),token):await ws.close(1008,'Authentication failed');return
   if owner is not None:await ws.close(1008,'Call already active');return
   owner=ws
   if origin=='apex-daemon':await ws.send(json.dumps({'type':'authenticated','protocolVersion':1}))
   sequence=0;last_input=-1;pending=set();chunks=[];speech_queue=asyncio.Queue(maxsize=512);last_cancel_reset=None
   recent_agent=deque(maxlen=10)
   recent_agent_full=deque(maxlen=5)
   last_agent_concat=''
   # Playback stall tracking
   stall_since=None
   async def send(event):
    nonlocal sequence
    if event['type']=='audio':
     window=credits
     waited=0.0
     while True:
      if window.pending + len(event['pcm']) <= window.capacity:
       break
      # No space: wait for consumption, log stall each second
      _voice_log('playbackStall', pipe.call_id if 'pipe' in locals() else '', pipe.generation if 'pipe' in locals() else None, pendingBytes=window.pending, requested=len(event['pcm']), waitedSec=round(waited,1))
      try:
       await asyncio.wait_for(window.wake.wait(), 1.0)
       window.wake.clear()
      except asyncio.TimeoutError:
       pass
      waited+=1.0
      if waited>=3.0:
       # Recoverable: client never consumed (e.g. Meta path missing onConsumed). Reset to allow progress and log.
       _voice_log('playbackStallRecover', pipe.call_id if 'pipe' in locals() else '', pipe.generation if 'pipe' in locals() else None, pendingBefore=window.pending, waitedSec=round(waited,1))
       window.reset()
       break
     if event['generation']!=pipe.generation:
      # Generation moved after we waited, don't send stale audio but credit already accounted? We haven't reserved yet.
      # Reserve now only if gen still valid
      pass
     try:
      await window.reserve(len(event['pcm']))
     except ValueError:
      _voice_log('ttsChunkTooLarge', pipe.call_id if 'pipe' in locals() else '', pipe.generation if 'pipe' in locals() else None, bytes=len(event['pcm']))
      return
     if event['generation']!=pipe.generation:
      window.consumed(len(event['pcm']))
      return
     sequence+=1
     await ws.send(encode_audio(event['generation'],sequence,event['pcm']))
     _voice_log('ttsChunkSent', event.get('callId',''), event.get('generation'), bytes=len(event['pcm']), sequence=sequence)
    else:
     await ws.send(json.dumps(event))
   async def synth(t,v):
    _voice_log('ttsSynthStart', pipe.call_id if 'pipe' in locals() else '', pipe.generation if 'pipe' in locals() else None, charLen=len(t))
    audio=await loop.run_in_executor(pool,engines.synthesize,t,v)
    _voice_log('ttsSynthDone', pipe.call_id if 'pipe' in locals() else '', pipe.generation if 'pipe' in locals() else None, bytes=len(audio))
    return audio
   pipe=Pipeline(send,synth,getattr(engines,'pieces',None));endpoint=EndpointDetector();voice='am_michael';hints=[];credits=PlaybackCredits()
   async def speaker():
    while True:
     gen,rid,sid,text,v=await speech_queue.get()
     if gen==pipe.generation:
      t=time.monotonic();first_ms=await pipe.speak(rid,sid,text,v)
      _voice_log('ttsQueuedPlayed', pipe.call_id, gen, requestId=rid, segmentId=sid, charLen=len(text))
      await send(dict(type='timing',callId=pipe.call_id,generation=pipe.generation,ttsMs=round((time.monotonic()-t)*1000),**({'ttsFirstMs':first_ms} if first_ms is not None else {})))
     else:
      _voice_log('ttsDroppedStaleGen', pipe.call_id, pipe.generation, requestId=rid, queuedGen=gen)
   speaker_task=asyncio.create_task(speaker())
   async def transcribe_chunk(pcm, meta=None):
    # pcm is bytes, meta for logging
    try:
     result=await loop.run_in_executor(pool,engines.transcribe,pcm,hints)
    except Exception as e:
     _voice_log('sttError', pipe.call_id, pipe.generation, error=type(e).__name__)
     return {'text':'', 'no_speech':[], 'logprob':[], 'ratio':[], 'durationSec': len(pcm)/32000 if pcm else 0}
    # Normalize engines return: could be str (old) or dict/tuple
    text=''
    no_speech=[]
    logprob=[]
    ratio=[]
    if isinstance(result, dict):
     text=result.get('text','') or ''
     no_speech=result.get('no_speech',[]) or result.get('no_speech_probs',[])
     logprob=result.get('logprob',[]) or result.get('avg_logprob',[]) or result.get('avg_logprobs',[])
     ratio=result.get('ratio',[]) or result.get('compression_ratio',[]) or result.get('compression_ratios',[])
    elif isinstance(result, (list, tuple)) and len(result)>=2 and isinstance(result[0], str):
     text=result[0] or ''
     meta2=result[1] if isinstance(result[1], dict) else {}
     no_speech=meta2.get('no_speech',[]) or meta2.get('no_speech_probs',[])
     logprob=meta2.get('logprob',[]) or meta2.get('avg_logprobs',[])
     ratio=meta2.get('ratio',[]) or meta2.get('compression_ratios',[])
    else:
     text=result if isinstance(result, str) else ''
    duration=len(pcm)/32000 if pcm else 0
    return {'text':text, 'no_speech':no_speech, 'logprob':logprob, 'ratio':ratio, 'durationSec':duration}

   async def transcript(tasks,gen,call,over_agent=False, voiced_frames=0, avg_rms=0, last_cancel_reset_local=None):
    t=time.monotonic()
    # Gather all chunk results
    results=await asyncio.gather(*tasks, return_exceptions=True)
    parts=[]
    all_no_speech=[]
    all_logprob=[]
    all_ratio=[]
    total_dur=0.0
    for r in results:
     if isinstance(r, Exception):
      _voice_log('sttChunkError', call, gen, error=type(r).__name__)
      continue
     if not isinstance(r, dict):
      continue
     parts.append(r.get('text',''))
     all_no_speech.extend(r.get('no_speech',[]))
     all_logprob.extend(r.get('logprob',[]))
     all_ratio.extend(r.get('ratio',[]))
     total_dur+=r.get('durationSec',0)
    # Deduplicate overlapping words (existing behavior)
    words=[]
    for part in parts:
     next_words=part.split()
     overlap=0
     for n in range(1,min(30,len(words),len(next_words))+1):
      if [w.lower().strip('.,!?') for w in words[-n:]]==[w.lower().strip('.,!?') for w in next_words[:n]]:
       overlap=n
     words.extend(next_words[overlap:])
    text=' '.join(words)
    # Compute metrics for logging without logging text
    word_count=len(words)
    char_len=len(text)
    avg_no_speech=sum(all_no_speech)/len(all_no_speech) if all_no_speech else 0.0
    avg_logprob=sum(all_logprob)/len(all_logprob) if all_logprob else 0.0
    max_ratio=max(all_ratio) if all_ratio else 0.0
    _voice_log('sttResult', call, gen, wordCount=word_count, charLen=char_len, durationSec=round(total_dur,2), avgNoSpeechProb=round(avg_no_speech,3), avgLogprob=round(avg_logprob,3), maxCompRatio=round(max_ratio,2), overAgent=over_agent, voicedFrames=voiced_frames, avgRms=avg_rms)

    # Filtering pipeline
    reason=None
    if not text or not words:
     reason='empty'
    elif _is_echo(text, recent_agent_full):
     reason='echo'
    elif made_up(text, hints, all_ratio, all_no_speech, all_logprob):
     reason='madeUp'
    else:
     normalized=' '.join(_normalize_words(text))
     # Stock phrase handling: only drop when heard over agent or when doubtful / very low energy
     if normalized in STOCK_PHRASES:
      if over_agent:
       reason='stockOverAgent'
      elif any(p>0.3 for p in all_no_speech) or any(p<-0.7 for p in all_logprob):
       reason='stockLowConf'
      elif avg_rms<5 and voiced_frames<8:
       reason='stockLowEnergy'
     if reason is None and word_count<=2:
      # Very short utterance requires minimum voiced duration; allow real short thanks in quiet room if confident
      if voiced_frames<6:
       # But keep if it's a plausible short thank you with decent energy and no low-conf metrics
       if not (normalized in ('thank you','thanks') and avg_rms>=5 and not all_no_speech and not all_logprob):
        reason='tooShortLowEnergy'
      elif avg_rms<5 and voiced_frames<10 and word_count==1:
       reason='tooShortLowEnergy'
      elif any(p>0.5 for p in all_no_speech) or any(p<-1.0 for p in all_logprob):
       reason='tooShortLowConf'
     if reason is None and word_count==1 and len(normalized)<=2:
      reason='singleChar'

    # Acceptance of old generation if barge-in kept input
    # Allow current generation or previous generation when cancel kept endpoint (reset=False) and speech was active
    acceptable_gens={pipe.generation}
    if last_cancel_reset_local is False:
     acceptable_gens.add(pipe.generation-1)
    if last_cancel_reset_local is None:
     # initial case, also allow previous gen if endpoint was active during cancel (legacy)
     acceptable_gens.add(pipe.generation-1)

    if reason:
     _voice_log('transcriptRejected', call, gen, reason=reason, wordCount=word_count, charLen=char_len, genOk=(gen in acceptable_gens))
     try:
      await send(dict(type='transcriptRejected', callId=call, generation=gen, reason=reason, utteranceId=secrets.token_hex(6)))
     except Exception:
      pass
     return
    if call!=pipe.call_id:
     _voice_log('transcriptRejected', call, gen, reason='staleCallId', wordCount=word_count)
     return
    if gen not in acceptable_gens:
     # If not acceptable, still preserve if total duration suggests it started before cancel but we have active flag
     # For barge-in preservation we allow gen==pipe.generation-1 regardless of last_cancel_reset if over_agent was true
     if not (over_agent and gen==pipe.generation-1):
      _voice_log('transcriptRejected', call, gen, reason='staleGeneration', wordCount=word_count, currentGen=pipe.generation)
      return
    # Passed
    uid=secrets.token_hex(12)
    _voice_log('transcriptAccepted', call, pipe.generation, wordCount=word_count, charLen=char_len, utteranceIdHash=uid[:6])
    await send(dict(type='transcript',callId=call,generation=pipe.generation,utteranceId=uid,text=text))
    await send(dict(type='timing',callId=call,generation=pipe.generation,sttMs=round((time.monotonic()-t)*1000)))

   async for raw in ws:
    if isinstance(raw,bytes):
     gen,seq,pcm=decode_audio(raw)
     if not mic_open:
      mic_open=True
      call_started_at=call_started_at or time.time()
      _voice_log('micOpen', pipe.call_id, pipe.generation, seq=seq)
     if gen!=pipe.generation:
      if not (endpoint.active and last_cancel_reset is False and gen==pipe.generation-1):
       _voice_log('audioDroppedStaleGen', pipe.call_id, pipe.generation, incomingGen=gen, seq=seq)
       continue
      gen=pipe.generation
     if not pipe.call_id or seq<=last_input or len(pcm)!=1024: 
      _voice_log('audioInvalid', pipe.call_id, pipe.generation, seq=seq, last=last_input, len=len(pcm))
      raise ValueError('Invalid capture sequence')
     last_input=seq
     rms_val=_rms(pcm)
     prob=await asyncio.to_thread(engines.probability,pcm)
     _voice_log('audioChunk', pipe.call_id, pipe.generation, seq=seq, rms=rms_val, prob=round(prob,3), pendingAudio=len(endpoint.audio), creditsPending=credits.pending, agentAudible=credits.pending>0)
     events=endpoint.push(pcm,prob,credits.pending>0)
     if 'candidate' in events:
      complete=await loop.run_in_executor(pool,engines.complete,b''.join(endpoint.audio))
      _voice_log('vadCandidate', pipe.call_id, pipe.generation, complete=complete, quietFrames=endpoint.quiet, voicedFrames=endpoint.voiced)
      if complete:
       endpoint.active=False;endpoint.run=0;events.append('complete')
     for event in events:
      if event=='speechStart':
       _voice_log('vadStart', pipe.call_id, pipe.generation, overAgent=endpoint.over_agent, prob=round(prob,3), rms=rms_val)
       if credits.pending>0:
        _voice_log('bargeIn', pipe.call_id, pipe.generation, overAgent=True)
       await send(dict(type='speechStart',callId=pipe.call_id,generation=gen))
      elif event=='partial-ready':
       if len(chunks)>=8:
        _voice_log('sttChunkOverflow', pipe.call_id, pipe.generation, chunks=len(chunks))
        # Recoverable: drop oldest chunk
        try:
         oldest=chunks.pop(0)
         oldest.cancel()
        except Exception:
         pass
        try:
         await send(dict(type='transcriptRejected', callId=pipe.call_id, generation=pipe.generation, reason='utteranceTooLong'))
        except Exception:
         pass
        # Continue, don't raise
       pcm_chunk=endpoint.take_chunk()
       _voice_log('sttChunkQueued', pipe.call_id, pipe.generation, bytes=len(pcm_chunk), durationSec=round(len(pcm_chunk)/32000,2))
       chunks.append(asyncio.create_task(transcribe_chunk(pcm_chunk)))
      elif event=='complete':
       if len(pending)>=2:
        _voice_log('sttPendingOverflow', pipe.call_id, pipe.generation, pending=len(pending))
        # Recoverable: drop oldest pending transcript task
        try:
         oldest_pending=next(iter(pending))
         oldest_pending.cancel()
         pending.discard(oldest_pending)
        except Exception:
         pass
        # Also emit rejected
        try:
         await send(dict(type='transcriptRejected', callId=pipe.call_id, generation=pipe.generation, reason='processingOverloaded'))
        except Exception:
         pass
        # Continue processing current complete instead of raising
       pcm_full=endpoint.take()
       voiced=endpoint.voiced
       # Compute avg RMS for this utterance (simple: use last audio rms history? approximate as current rms)
       # We keep voiced frames count for filtering
       _voice_log('vadEnd', pipe.call_id, pipe.generation, voicedFrames=voiced, totalBytes=len(pcm_full), durationSec=round(len(pcm_full)/32000,2))
       # For accurate avg_rms we would need to track, use last rms as proxy
       chunks.append(asyncio.create_task(transcribe_chunk(pcm_full)))
       # Capture locals for transcript closure
       cur_last_cancel=last_cancel_reset
       cur_voiced=voiced
       cur_rms=rms_val
       cur_over=endpoint.over_agent
       task=asyncio.create_task(transcript(list(chunks),gen,pipe.call_id,cur_over, cur_voiced, cur_rms, cur_last_cancel));chunks.clear();pending.add(task);task.add_done_callback(pending.discard)
    else:
     msg=validate_control(raw);kind=msg['type']
     if kind=='start':
      if pipe.call_id:raise ValueError('Call already started')
      call=msg.get('callId');gen=msg.get('generation')
      if not isinstance(call,str) or not 1<=len(call)<=128 or not isinstance(gen,int) or not 0<=gen<2**32:raise ValueError('Invalid call')
      voice=msg.get('voice','am_michael')
      if not isinstance(voice,str) or len(voice)>64:raise ValueError('Invalid voice')
      silence=msg.get('silenceMs',100)
      if not isinstance(silence,(int,float)) or not 100<=silence<=2000:raise ValueError('Invalid endpoint')
      raw_hints=msg.get('nameHints',[])
      if not isinstance(raw_hints,list) or len(raw_hints)>64 or any(not isinstance(h,str) or len(h)>64 for h in raw_hints):raise ValueError('Invalid hints')
      hints=raw_hints;endpoint=EndpointDetector(silence,semantic=engines.semantic_session is not None);await loop.run_in_executor(pool,engines.reset)
      pipe.start(call,gen);recent_agent.clear();recent_agent_full.clear();last_agent_concat='';mic_open=False;last_input=-1;call_started_at=time.time()
      _voice_log('callStart', call, gen, silenceMs=silence, semantic=engines.semantic_session is not None, voice=voice)
      await send(dict(type='ready',callId=call,generation=gen,voices=engines.voices,semantic=engines.semantic_session is not None))
     elif msg.get('callId')==pipe.call_id:
      if kind=='cancel':
       gen=msg.get('generation')
       if not isinstance(gen,int) or not 0<=gen<2**32:raise ValueError('Invalid generation')
       last_cancel_reset = True if msg.get("resetInput") is True else False
       _voice_log('cancel', msg.get('callId',''), gen, resetInput=last_cancel_reset, speechQueueSize=speech_queue.qsize())
       pipe.cancel(gen);credits.reset();credits=PlaybackCredits()
       if last_cancel_reset is True:
        endpoint=EndpointDetector(endpoint.silence_ms,semantic=engines.semantic_session is not None)
        for task in chunks:task.cancel()
        chunks.clear();await asyncio.to_thread(engines.reset)
        _voice_log('inputCleared', msg.get('callId',''), gen, reason='resetInputTrue')
       while not speech_queue.empty():speech_queue.get_nowait()
      elif msg.get('generation')==pipe.generation:
       if kind=='speak':
        text=msg.get('text','');v=msg.get('voice',voice);sid=msg.get('segmentId');rid=msg.get('requestId')
        if not isinstance(text,str) or len(text)>2048 or len(text.split())>22 or v not in engines.voices or not isinstance(sid,int) or not isinstance(rid,str) or len(rid)>128:raise ValueError('Invalid speech segment')
        recent_agent.append(text)
        # Maintain full recent for echo detection: keep last few utterances
        recent_agent_full.append(text)
        # Also maintain a cumulative concat for longer responses
        last_agent_concat=(last_agent_concat+' '+text).strip()
        if len(last_agent_concat)>2000:
         # Push cumulative and reset to keep history bounded
         recent_agent_full.append(last_agent_concat)
         last_agent_concat=''
        _voice_log('ttsQueued', msg.get('callId',''), gen, requestId=rid, segmentId=sid, charLen=len(text), queueSize=speech_queue.qsize())
        if speech_queue.full():
         _voice_log('ttsDroppedQueueFull', msg.get('callId',''), gen, requestId=rid)
         print(json.dumps({'type':'speechDropped'}),file=sys.stderr,flush=True)
         try:
          await send(dict(type='speechDropped', callId=msg.get('callId'), generation=gen, requestId=rid, reason='queueFull'))
         except Exception:
          pass
        else:speech_queue.put_nowait((pipe.generation,rid,sid,text,v))
       elif kind=='playbackProgress':
        b=msg.get('bytes')
        credits.consumed(b) if isinstance(b,int) else None
        _voice_log('playbackProgress', pipe.call_id, pipe.generation, bytes=b, pending=credits.pending)
       elif kind=='playbackComplete':
        _voice_log('playbackComplete', pipe.call_id, pipe.generation)
       elif kind=='end':
        end_reason='clientEnd'
        _voice_log('callEnd', pipe.call_id, pipe.generation, reason=end_reason)
        break
   if speaker_task.done():
    exc=speaker_task.exception()
    if exc:
     _voice_log('speakerError', pipe.call_id if 'pipe' in locals() else '', None, error=type(exc).__name__)
    await speaker_task
  except Exception as error:
   end_reason=f'exception:{type(error).__name__}'
   _voice_log('sessionError', pipe.call_id if 'pipe' in locals() else '', pipe.generation if 'pipe' in locals() else None, errorClass=type(error).__name__, message=str(error)[:200] if isinstance(error,ValueError) else '', reason=end_reason)
   print(json.dumps({'type':'sessionError','class':type(error).__name__,'message':str(error)[:200] if isinstance(error,ValueError) else ''}),file=sys.stderr,flush=True)
   await ws.close(1011,'Voice session ended')
  finally:
   if mic_open:
    _voice_log('micClose', pipe.call_id if 'pipe' in locals() else '', pipe.generation if 'pipe' in locals() else None, reason=end_reason, durationSec=round(time.time()-call_started_at,2) if call_started_at else 0)
   if owner is ws:
    owner=None
    if 'pipe' in locals():pipe.generation+=1
    for task in list(locals().get('pending',[]))+list(locals().get('chunks',[])):task.cancel()
    if 'speaker_task' in locals():speaker_task.cancel()
    if end_reason=='unknown':
     end_reason='wsClosed'
     _voice_log('callEnd', pipe.call_id if 'pipe' in locals() else '', pipe.generation if 'pipe' in locals() else None, reason=end_reason)
 async with serve(handle,'127.0.0.1',args.port,max_size=65536,max_queue=32,write_limit=65536) as server:
  print(json.dumps({'type':'ready','port':server.sockets[0].getsockname()[1],'protocolVersion':1}),flush=True)
  await asyncio.Future()

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--engine',choices=['mlx','cpu'],default='mlx');p.add_argument('--port',type=int,default=0);p.add_argument('--token-fd',type=int,required=True);p.add_argument('--root',required=True);p.add_argument('--origin',action='append',default=[])
 asyncio.run(run(p.parse_args()))
