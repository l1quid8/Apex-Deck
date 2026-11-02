import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { connectLocalVoice } from '../src/voice/localClient.ts';

test('local capture congestion drops bounded audio without ending call and resumes', async () => {
  class Socket {
    static OPEN = 1;
    readyState = 1; bufferedAmount = 40000; sent = [];
    constructor() { Socket.last = this; queueMicrotask(() => this.onopen()); }
    send(x) { this.sent.push(x); } close() {}
  }
  globalThis.WebSocket = Socket;
  const failures = [];
  const c = await connectLocalVoice({protocolVersion:1,port:1,token:'t'}, () => {}, () => {}, e => failures.push(e));
  for (let i=0;i<100;i++) c.audio(new Int16Array(512), 1);
  assert.equal(failures.length, 0);
  assert.equal(Socket.last.sent.length, 1);
  Socket.last.bufferedAmount = 0;
  c.audio(new Int16Array(512), 1);
  assert.equal(Socket.last.sent.length, 2);
  c.close();
});
test('playback worklet reports real output RMS including silence', () => {
  let Processor;
  const messages=[];
  vm.runInNewContext(readFileSync(new URL('../src/voice/playback-worklet.js',import.meta.url),'utf8'), {
    AudioWorkletProcessor: class {port={postMessage:m=>messages.push(m)};},
    registerProcessor:(_n,p)=>Processor=p, sampleRate:24000,
  });
  const p=new Processor();
  p.port.onmessage({data:{type:'audio',pcm:new Int16Array(2400).fill(16384),generation:0}});
  for(let i=0;i<19;i++) p.process([],[[new Float32Array(128)]]);
  assert.ok(messages.some(m=>m.type==='level' && m.rms>0.4 && m.rms<=0.5));
  for(let i=0;i<20;i++) p.process([],[[new Float32Array(128)]]);
  assert.equal(messages.filter(m=>m.type==='level').at(-1).rms,0);
});
test('ended microphone track reacquires input and close releases replacement', async () => {
  const { openVoiceAudio } = await import('../src/voice/audio.ts');
  const old = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const streams=[];
  const track = () => ({getSettings:()=>({echoCancellation:true}),stop(){this.stopped=true;}});
  const media = { async getUserMedia() { const t=track(); const s={getTracks:()=>[t],getAudioTracks:()=>[t]}; streams.push(s); return s; },addEventListener(){},removeEventListener(){} };
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:media}});
  class Node {port={postMessage(){}}; gain={value:0};connect(){return this;}disconnect(){} }
  class Context { audioWorklet={addModule:async()=>{}};state='running';createMediaStreamSource(){return new Node();}createGain(){return new Node();}resume(){return Promise.resolve();}close(){return Promise.resolve();} }
  globalThis.AudioContext=Context; globalThis.AudioWorkletNode=Node;
  const errors=[];
  try {
    const audio=await openVoiceAudio(()=>{},()=>{},()=>{},e=>errors.push(e));
    streams[0].getTracks()[0].onended();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(streams.length,2);
    assert.equal(errors.length,0);
    audio.close();
    assert.equal(streams[1].getTracks()[0].stopped,true);
  } finally { if(old)Object.defineProperty(globalThis,'navigator',old);else delete globalThis.navigator; delete globalThis.AudioContext;delete globalThis.AudioWorkletNode; }
});
