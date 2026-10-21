#!/usr/bin/env node
// Synthetic voice only: never captures a microphone or posts an agent message.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { DaemonClient } from '../src/daemon/client.ts';
import { webSocketConnect } from '../src/daemon/webSocketLink.ts';
import { serverVoiceLink, connectServerVoice } from '../src/voice/serverClient.ts';
const {values} = parseArgs({options: {
  url: {type:'string',default:'ws://127.0.0.1:7499'},
  'token-file': {type:'string'}, install:{type:'boolean'}, turns:{type:'string',default:'10'},
}});
if (!values['token-file']) throw Error('--token-file is required');
const count = Number(values.turns);
if (!Number.isInteger(count) || count < 1 || count > 100) throw Error('--turns must be 1–100');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (a,p) => [...a].sort((a,b)=>a-b)[Math.ceil(a.length*p)-1];
const client = new DaemonClient(webSocketConnect(values.url), {token:readFileSync(values['token-file'],'utf8').trim()});
const link = serverVoiceLink(client);
let failure;
async function until(test, timeout=15000) {
  const start = performance.now();
  while (!test()) {
    if (failure) throw failure;
    if (performance.now()-start>timeout) throw Error('Voice smoke timed out');
    await sleep(10);
  }
}
const results=[], opens=[];
try {
  await client.start();
  let status = await link.status();
  if (!status.supported) throw Error(status.reason);
  if (!status.installed && values.install) {
    await link.install(); const start = performance.now();
    while (!(status = await link.status()).installed) {
      if (status.failed) throw Error(status.failed);
      if (performance.now()-start>1200000) throw Error('Install timeout');
      console.log(JSON.stringify({setup:status.installing})); await sleep(1000);
    }
  }
  if (!status.installed) throw Error('Voice is not installed; pass --install');
  for (let run=0; run<2; run++) {
    const start = performance.now(), runtime=await link.open('smoke');
    opens.push(Math.round(performance.now()-start));
    let events=[], chunks=[], firstAudioAt;
    const transport=await connectServerVoice(link,runtime,e=>events.push({...e,_receivedAt:performance.now()}),pcm=>{
      firstAudioAt ??= performance.now();
      chunks.push(new Int16Array(pcm));
      transport.send({type:'playbackProgress',callId:'smoke',generation:0,bytes:pcm.byteLength});
    },e=>{failure=e;},weak=>console.log(JSON.stringify({weak})));
    transport.send({type:'start',callId:'smoke',generation:0,voice:'am_michael',silenceMs:700,nameHints:['Null','Muck','Jigga','Apex Deck']});
    await until(()=>events.some(e=>e.type==='ready'));
    const turns = count;
    for (let turn=0;turn<turns;turn++) {
      events=[]; chunks=[]; firstAudioAt=undefined;
      const started = performance.now();
      transport.send({type:'speak',callId:'smoke',generation:0,requestId:`r${run}-${turn}`,segmentId:turn,text:'Hey Null, can you check why the build failed on main?',voice:'am_michael'});
      await until(()=>events.some(e=>e.type==='audioEnd'));
      const first=events.find(e=>e.type==='timing' && e.ttsFirstMs!==undefined)?.ttsFirstMs;
      const output=Int16Array.from(chunks.flatMap(p=>Array.from(p)));
      const input=new Int16Array(Math.floor(output.length*2/3));
      for (let i=0;i<input.length;i++) {
        const p=i*1.5, j=Math.floor(p), f=p-j;
        input[i]=Math.round(output[j]*(1-f)+(output[j+1]??output[j])*f);
      }
      console.log(JSON.stringify({captureStart:{run,turn}}));
      for (let offset=0;offset<input.length;offset+=512) {
        const frame=new Int16Array(512);frame.set(input.subarray(offset,offset+512));transport.audio(frame,0);await sleep(32);
      }
      const ended=performance.now();
      for (let i=0;i<64;i++) {transport.audio(new Int16Array(512),0); await sleep(32);}
      await until(()=>events.some(e=>e.type==='transcript'),10000);
      const transcript=events.find(e=>e.type==='transcript');
      // The polling loop timestamp excludes the following silence wait.
      const ok=/null/i.test(transcript.text) && /build/i.test(transcript.text);
      const row={run,turn,ok,ttsFirstMs:first??Math.round(firstAudioAt-started),speechEndToTranscriptMs:Math.round(transcript._receivedAt-ended)};
      results.push(row);console.log(JSON.stringify(row));
      if (!ok) throw Error('Expected names absent from synthetic transcript');
    }
    transport.close('smoke complete'); await sleep(100);
  }
  const metric=key=>({p50:percentile(results.map(r=>r[key]),.5),p95:percentile(results.map(r=>r[key]),.95)});
  console.log(JSON.stringify({openMs:{cold:opens[0],warm:opens[1]},ttsFirstMs:metric('ttsFirstMs'),speechEndToTranscriptMs:metric('speechEndToTranscriptMs'),ok:results.filter(r=>r.ok).length,turns:results.length}));
} finally { client.close(); }
