import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMoshi, voiceRequestAllowed } from '../desktop/moshi.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { spawnVoiceProcess } from '../desktop/moshiRuntime.mjs';

test('voice requests require the exact loopback origin and secret', () => {
  assert.equal(voiceRequestAllowed('http://127.0.0.1:9876/api/chat', 'http://127.0.0.1:9876'), true);
  assert.equal(voiceRequestAllowed('ws://127.0.0.1:9876/api/chat', 'http://127.0.0.1:9876'), true);
  for (const url of ['http://127.0.0.1:9877/', 'https://evil.test/', 'file:///etc/passwd', 'http://127.0.0.1:9876.evil.test/']) {
    assert.equal(voiceRequestAllowed(url, 'http://127.0.0.1:9876'), false);
  }
});

test('worklet resamples 48 kHz capture into 24 kHz frames and mutes input', () => {
  let Processor; const sent = [];
  vm.runInNewContext(readFileSync(new URL('../desktop/moshi/audio-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: data => sent.push(data), onmessage: null }; },
    sampleRate: 48000, registerProcessor: (_name, type) => { Processor = type; }, Float32Array,
  });
  const processor = new Processor();
  const input = new Float32Array(128).fill(.5);
  for (let i = 0; i < 31; i++) processor.process([[input]], [[new Float32Array(128)]]);
  assert.equal(sent.length, 1); assert.equal(sent[0].audio.length, 1920);
  assert.equal(sent[0].audio.every(sample => sample === .5), true);
  processor.port.onmessage({ data: { mute: true } });
  for (let i = 0; i < 61; i++) processor.process([[input]], [[new Float32Array(128)]]);
  assert.equal(sent.at(-1).audio.every(sample => sample === 0), true);
});

test('worklet plays at the device rate and bounds its pending audio', () => {
  let Processor;
  vm.runInNewContext(readFileSync(new URL('../desktop/moshi/audio-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage() {}, onmessage: null }; },
    sampleRate: 48000, registerProcessor: (_name, type) => { Processor = type; }, Float32Array,
  });
  const processor = new Processor();
  processor.port.onmessage({ data: { audio: new Float32Array([.25, .5]) } });
  const out = new Float32Array(6); processor.process([], [[out]]);
  assert.deepEqual([...out], [.25, .25, .5, .5, 0, 0]);
  for (let i = 0; i < 100; i++) processor.port.onmessage({ data: { audio: new Float32Array(1920) } });
  assert.ok(processor.queued <= 24000 + 1920);
});

test('Moshi stays off, requires consent, and coalesces concurrent starts', async () => {
  let setups = 0, starts = 0, stops = 0;
  const voice = createMoshi({ supported: true, installed: async () => false,
    setup: async () => { setups++; }, launch: async () => { starts++; return { url: 'http://127.0.0.1:9876', stop: async () => { stops++; } }; } });
  assert.equal(voice.status().phase, 'off');
  await assert.rejects(voice.start(), /download/i);
  assert.equal(setups, 0);
  await Promise.all([voice.start(true), voice.start(true)]);
  assert.equal(setups, 1); assert.equal(starts, 1);
  assert.equal(voice.status().phase, 'ready');
  await voice.stop();
  assert.equal(stops, 1); assert.equal(voice.status().phase, 'off');
});

test('cancelling setup cannot launch later; retry remains possible', async () => {
  let release, starts = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const voice = createMoshi({ supported: true, installed: async () => false,
    setup: async () => gate, launch: async () => { starts++; return { stop: async () => {} }; } });
  const first = voice.start(true);
  await new Promise(resolve => setImmediate(resolve));
  const stop = voice.stop(); release();
  await Promise.allSettled([first, stop]);
  assert.equal(starts, 0); assert.equal(voice.status().phase, 'off');
  await voice.start(true); assert.equal(starts, 1); await voice.stop();
});

test('launch errors are visible and a subsequent start retries', async () => {
  let attempts = 0;
  const voice = createMoshi({ supported: true, installed: async () => true, setup: async () => {},
    launch: async () => { if (++attempts === 1) throw new Error('model failed'); return { stop: async () => {} }; } });
  await assert.rejects(voice.start(), /model failed/);
  assert.equal(voice.status().phase, 'error');
  await voice.start(); assert.equal(voice.status().phase, 'ready'); await voice.stop();
});

test('unsupported hardware never installs or starts anything', async () => {
  const voice = createMoshi({ supported: false });
  await assert.rejects(voice.start(true), /Apple Silicon/);
  assert.equal(voice.status().phase, 'off');
});

test('a start during teardown waits and returns a fresh helper', async () => {
  let launches = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const voice = createMoshi({ supported: true, installed: async () => true,
    launch: async () => ({ id: ++launches, stop: async () => gate }) });
  const first = await voice.start();
  const stopping = voice.stop();
  const restarting = voice.start();
  release(); await stopping;
  const second = await restarting;
  assert.notEqual(second.id, first.id); assert.equal(voice.status().phase, 'ready');
  await voice.stop();
});

test('a parent exit also kills grandchildren that hold its output pipes open', async () => {
  const job = spawnVoiceProcess(process.execPath, ['-e', `
    require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'});
    setTimeout(() => process.exit(1), 50);
  `], {}, new AbortController().signal);
  let timer;
  try {
    await assert.rejects(Promise.race([job.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Output pipes stayed open')), 1500); })]), /Local voice exited/);
  } finally { clearTimeout(timer); await job.stop(); }
});

test('runner diagnostics after readiness never revert the call to starting', async () => {
  let diagnostic;
  const voice = createMoshi({ supported: true, installed: async () => true,
    launch: async (_signal, report) => { diagnostic = report; return { stop: async () => {} }; } });
  await voice.start(); diagnostic('accepted connection');
  assert.equal(voice.status().phase, 'ready'); await voice.stop();
});
