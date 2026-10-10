import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/PersonalCall.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const textOf = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(textOf).join('') ?? '';
const find = (node, predicate) => !node || typeof node !== 'object' ? null : predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean) ?? null;
const button = (tree, label) => find(tree, node => node.type === 'button' && textOf(node) === label);
const settle = () => new Promise(resolve => setImmediate(resolve));

/** A fake speech engine: `heard` is what listening resolves with; `log` records what was spoken. */
function fakeSpeech({ canListen = true, heard = '' } = {}) {
  const log = { spoken: [], cancelled: 0, stopped: 0 };
  const speech = {
    canListen,
    listen: async (onPartial) => { onPartial(heard.slice(0, 5)); return heard; },
    stop() { log.stopped += 1; },
    speak: async (text) => { log.spoken.push(text); },
    cancelSpeak() { log.cancelled += 1; },
  };
  return { speech, log };
}

function callLane(messages = []) {
  const sent = [];
  const lane = {
    name: 'Assistant', hostName: 'apex-terminal', offline: false,
    assistant: { id: 'asst-1', hostId: 'vps', paused: false, messages, tasks: [] },
    send: async (text) => { sent.push(text); },
  };
  return { lane, sent };
}

/** Hooks keep their state between renders, and effects run on every render, as they do in the app. */
function mount(props) {
  const states = [];
  let cursor = 0;
  const useState = (initial) => {
    const i = cursor++;
    if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
    return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
  };
  const useRef = (initial) => { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; };
  const useEffect = (effect) => { cursor++; effect(); };
  const component = new Function('React', 'useState', 'useRef', 'useEffect', 'getSpeech', `${compiled}\nreturn PersonalCall;`)(React, useState, useRef, useEffect, () => fakeSpeech({ canListen: false }).speech);
  return { render() { cursor = 0; return component({ onEnd() {}, ...props }); } };
}

test('Tap to talk sends the final words to the assistant', async () => {
  const { lane, sent } = callLane();
  const { speech } = fakeSpeech({ heard: 'What is free on the disk?' });
  const h = mount({ lane, speech });
  button(h.render(), 'Tap to talk').props.onClick();
  await settle();
  assert.deepEqual(sent, ['What is free on the disk?']);
});

test('a new reply is spoken once, and history from before the call is not', async () => {
  const old = { id: 'old', role: 'assistant', kind: 'chat', text: 'Old reply', at: 1 };
  const { lane, sent } = callLane([old]);
  const { speech, log } = fakeSpeech({ heard: 'Status?' });
  const h = mount({ lane, speech });
  h.render();
  button(h.render(), 'Tap to talk').props.onClick();
  await settle();
  lane.assistant.messages.push({ id: 'r1', role: 'assistant', kind: 'chat', text: 'It is 42 GB free.', at: Date.now() });
  for (let i = 0; i < 3; i++) { h.render(); await settle(); }
  assert.deepEqual(sent, ['Status?']);
  assert.deepEqual(log.spoken, ['It is 42 GB free.']);
});

test('End call closes the call and stops speech without sending anything', () => {
  const { lane, sent } = callLane();
  const { speech, log } = fakeSpeech();
  let ended = 0;
  const h = mount({ lane, speech, onEnd: () => { ended += 1; } });
  button(h.render(), 'End call').props.onClick();
  assert.equal(ended, 1);
  assert.deepEqual(sent, []);
  assert.ok(log.cancelled > 0);
});

test('without speech input, the text box sends a typed message', async () => {
  const { lane, sent } = callLane();
  const { speech } = fakeSpeech({ canListen: false });
  const h = mount({ lane, speech });
  let tree = h.render();
  assert.equal(button(tree, 'Tap to talk'), null);
  find(tree, node => node.props?.['aria-label'] === 'Type instead').props.onChange({ target: { value: 'Text question' } });
  tree = h.render();
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await settle();
  assert.deepEqual(sent, ['Text question']);
});
