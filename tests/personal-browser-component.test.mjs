import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/PersonalBrowser.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const textOf = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(textOf).join('') ?? '';
const find = (node, predicate) => !node || typeof node !== 'object' ? null : predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean) ?? null;
const button = (tree, label) => find(tree, node => node.type === 'button' && textOf(node) === label);
const settle = () => new Promise(resolve => setImmediate(resolve));

// The page refreshes on a timer; the harness runs effects inline, so timers are stubbed out for this file.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

function mount(props) {
  const states = [];
  let cursor = 0;
  const useState = (initial) => {
    const i = cursor++;
    if (!(i in states)) states[i] = initial;
    return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
  };
  const useRef = (initial) => { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; };
  const useEffect = (effect) => { cursor++; effect(); };
  const component = new Function('React', 'useState', 'useRef', 'useEffect', `${compiled}\nreturn PersonalBrowser;`)(React, useState, useRef, useEffect);
  return { render() { cursor = 0; return component({ onClose() {}, ...props }); } };
}

/** A page 1280x640 on the host; `inputs` records what the browser was asked to do. */
function browserLane() {
  const state = { takenOver: false };
  const inputs = [];
  const view = () => ({ url: 'https://example.com/login', title: 'Sign in', image: 'AAAA', width: 1280, height: 640, takenOver: state.takenOver });
  const lane = {
    name: 'Assistant', hostName: 'apex-terminal', offline: false, assistant: null,
    send: async () => {}, decide: async () => {}, cancel: async () => {},
    browserView: async () => view(),
    browserTakeOver: async (on) => { state.takenOver = on; return view(); },
    browserInput: async (input) => { inputs.push(input); return view(); },
  };
  return { lane, inputs };
}

test('clicks do nothing until the person takes over, and then land scaled to the page', async () => {
  const { lane, inputs } = browserLane();
  const h = mount({ lane });
  h.render();
  await settle();
  let tree = h.render();
  assert.match(textOf(tree), /Take over to click and type, for example to sign in/);
  const picture = () => find(h.render(), node => node.type === 'img');
  const at = (clientX, clientY) => ({ clientX, clientY, currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }) } });
  picture().props.onClick(at(110, 70));
  await settle();
  assert.deepEqual(inputs, [], 'no click before take over');
  button(h.render(), 'Take over').props.onClick();
  await settle();
  tree = h.render();
  picture().props.onClick(at(110, 70));
  await settle();
  // (110-10, 70-20) on a 200x100 picture is (100, 50); scaled to 1280x640 that is (640, 320).
  assert.deepEqual(inputs, [{ kind: 'click', x: 640, y: 320 }]);
});
