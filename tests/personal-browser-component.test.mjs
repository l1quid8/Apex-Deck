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
  const useEffect = (effect, deps) => {
    const i = cursor++;
    const previous = states[i];
    if (!previous || !deps || deps.some((value, index) => value !== previous.deps?.[index])) {
      previous?.cleanup?.();
      states[i] = { deps, cleanup: effect() };
    }
  };
  const component = new Function('React', 'useState', 'useRef', 'useEffect', `${compiled}\nreturn PersonalBrowser;`)(React, useState, useRef, useEffect);
  return { render(next = {}) { props = { ...props, ...next }; cursor = 0; return component({ onClose() {}, ...props }); } };
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


test('closing a taken-over browser hides the view without returning control', async () => {
  const { lane } = browserLane();
  let closed = 0;
  const h = mount({ lane, onClose() { closed++; } });
  h.render(); await settle();
  button(h.render(), 'Take over').props.onClick(); await settle();
  button(h.render(), 'Close').props.onClick(); await settle();
  assert.equal(closed, 1);
  assert.equal((await lane.browserView()).takenOver, true);
});

test('popup expansion and return preserve the page, control and unsent browser text', async () => {
  const { lane, inputs } = browserLane();
  let expanded = 0, returned = 0;
  const h = mount({ lane, presentation: 'popup', onExpand() { expanded++; }, onReturnToChat() { returned++; } });
  h.render(); await settle();
  button(h.render(), 'Take over').props.onClick(); await settle();
  find(h.render(), node => node.props?.['aria-label'] === 'Type on the page').props.onChange({ target: { value: 'unsent sign-in text' } });
  button(h.render(), 'Expand browser').props.onClick();
  assert.equal(expanded, 1);
  let tree = h.render({ presentation: 'expanded' });
  assert.equal(find(tree, node => node.props?.['aria-label'] === 'Type on the page').props.value, 'unsent sign-in text');
  assert.equal(find(tree, node => node.type === 'img').props.src, 'data:image/jpeg;base64,AAAA');
  button(tree, 'Return to chat').props.onClick();
  assert.equal(returned, 1);
  tree = h.render({ presentation: 'popup' });
  assert.ok(button(tree, 'Hand back to assistant'));
  assert.deepEqual(inputs, []);
});

test('unavailable browser reports its actual failure and offers retry without claiming control', async () => {
  const { lane } = browserLane();
  lane.browserView = async () => { throw new Error('Chromium is unavailable on this machine.'); };
  const h = mount({ lane });
  h.render(); await settle();
  const tree = h.render();
  assert.match(textOf(find(tree, node => node.props?.role === 'alert')), /Chromium is unavailable/);
  assert.doesNotMatch(textOf(tree), /Assistant is browsing/);
  assert.ok(button(tree, 'Retry'));
});

test('offline browser never polls or sends input and explains its saved-profile context', async () => {
  const { lane, inputs } = browserLane();
  lane.offline = true;
  let polls = 0;
  lane.browserView = async () => { polls++; throw new Error('must not poll'); };
  const h = mount({ lane });
  const tree = h.render(); await settle();
  assert.equal(polls, 0);
  assert.deepEqual(inputs, []);
  assert.match(textOf(tree), /Offline/);
  assert.match(textOf(tree), /Shared assistant profile on apex-terminal/);
  assert.match(textOf(tree), /Profile selection.*not supported/);
  assert.equal(button(tree, 'Take over').props.disabled, true);
});


test('hidden browser keeps its draft and resumes polling after an in-flight action', async () => {
  const { lane } = browserLane();
  const h = mount({ lane });
  h.render(); await settle();
  button(h.render(), 'Take over').props.onClick(); await settle();
  find(h.render(), node => node.props?.['aria-label'] === 'Type on the page').props.onChange({ target: { value: 'keep me' } });
  let finish;
  lane.browserInput = () => new Promise(resolve => { finish = resolve; });
  button(h.render(), 'Enter').props.onClick();
  h.render({ active: false });
  finish({ url: 'https://old.example', title: 'Old action', image: 'OLD', width: 1280, height: 640, takenOver: true });
  await settle();
  h.render({ active: true }); await settle();
  const tree = h.render();
  assert.equal(find(tree, node => node.props?.['aria-label'] === 'Type on the page').props.value, 'keep me');
  assert.equal(button(tree, 'Enter').props.disabled, false);
  assert.equal(find(tree, node => node.type === 'img').props.src, 'data:image/jpeg;base64,AAAA');
});

test('changing assistant identity discards its browser draft and ignores an old host response', async () => {
  const { lane } = browserLane();
  lane.ref = { hostId: 'host-a', assistantId: 'assistant-a' };
  let finish;
  lane.browserView = () => new Promise(resolve => { finish = resolve; });
  const h = mount({ lane });
  h.render();
  const next = browserLane().lane;
  next.ref = { hostId: 'host-b', assistantId: 'assistant-b' };
  next.hostName = 'Other machine';
  h.render({ lane: next }); await settle();
  finish({ url: 'https://old.example', title: 'Private old page', image: 'OLD', width: 1280, height: 640, takenOver: true });
  await settle();
  const tree = h.render();
  assert.doesNotMatch(textOf(tree), /Private old page/);
  assert.equal(find(tree, node => node.type === 'img').props.src, 'data:image/jpeg;base64,AAAA');
  assert.match(textOf(tree), /Other machine/);
});
