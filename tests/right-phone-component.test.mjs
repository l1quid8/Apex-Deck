// tests/right-phone-component.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'sucrase';
import * as phoneModel from '../src/phoneModel.ts';

const source = await fs.readFile(new URL('../src/RightPhone.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replace(/export (function|const)/g, '$1'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const modelNames = Object.keys(phoneModel);
const load = (R, useEffect, useRef, useState) => new Function('React', 'useEffect', 'useRef', 'useState', 'phoneModel', `const { ${modelNames.join(', ')} } = phoneModel; ${code}; return RightPhone;`)(R, useEffect, useRef, useState, phoneModel);

// Real React, for what a first render shows. A static render runs no effects.
const RightPhone = load(React, React.useEffect, React.useRef, React.useState);
const render = (props) => renderToStaticMarkup(React.createElement(RightPhone, props));

const STATUS = { on: true, starting: false, device: 'Apex Deck Phone 1a2b', udid: 'U', width: 603, height: 1311, problem: null };
const off = (extra = {}) => ({ ...STATUS, on: false, device: null, udid: null, width: 0, height: 0, holder: { kind: 'free' }, ...extra });
const on = (holder = { kind: 'free' }) => ({ ...STATUS, holder });

function fakePhone(over = {}) {
  const calls = [];
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return typeof result === 'function' ? result(...args) : Promise.resolve(result); };
  const phone = {
    calls,
    status: record('status', on()),
    start: record('start', on()),
    stop: record('stop', off()),
    view: record('view', { status: on(), frame: null }),
    input: record('input', on({ kind: 'human', secondsLeft: 10 })),
    giveBack: record('giveBack', on()),
    chatQueued: record('chatQueued', undefined),
    ...over,
  };
  return phone;
}

test('without a phone api it says what it needs', () => {
  assert.match(render({ visible: true }), /The phone needs the Deck app on a Mac\./);
});

test('a phone that is off offers Turn on', () => {
  const html = render({ visible: true, phone: fakePhone(), initial: { on: false, starting: false, holder: { kind: 'free' }, width: 0, height: 0, device: null, udid: null, problem: 'Xcode isn\'t installed.' } });
  assert.match(html, />Turn on</);
  assert.match(html, /role="alert"[^>]*>Xcode isn&#x27;t installed\./);
  assert.match(html, />Phone</);
  assert.match(html, /One simulated iPhone that you and the bots share\. The first start takes about a minute\./);
});

test('a phone that is turning on says so', () => {
  const html = render({ visible: true, phone: fakePhone(), initial: off({ starting: true }) });
  assert.match(html, /Turning on…/);
  assert.doesNotMatch(html, />Turn on</);
});

test('a phone that is on shows who has it, its buttons and the typing note', () => {
  const html = render({ visible: true, phone: fakePhone(), initial: on({ kind: 'bot', name: 'Jigga' }) });
  assert.match(html, /role="status" class="right-phone-state">Jigga is using the phone\. Tap the screen to take over\./);
  for (const label of ['Home', 'Lock', 'Turn off']) assert.match(html, new RegExp(`>${label}<`));
  assert.doesNotMatch(html, />Give back</);
  assert.match(html, /Typing works while the screen is selected\. Plain keyboard characters only\./);
  const mine = render({ visible: true, phone: fakePhone(), initial: on({ kind: 'human', secondsLeft: 7 }) });
  assert.match(mine, />Give back</);
  assert.match(mine, /You have the phone\. The bots get it back after 7s without a tap\./);
});

// A small stand-in for React that keeps hook state between calls and runs effects with their cleanups,
// so polling and typing can be driven with fake timers. Tests call render() after something changed.
function mount(props) {
  const Fake = { Fragment: 'fragment', createElement: (type, p, ...children) => ({ type, props: p ?? {}, children: children.flat(Infinity) }) };
  const slots = [];
  let cursor = 0;
  let pending = [];
  const useState = (initial) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { value: initial };
    return [slots[i].value, (next) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }];
  };
  const useRef = (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; };
  const useEffect = (effect, deps) => { pending.push({ i: cursor++, effect, deps }); };
  const component = load(Fake, useEffect, useRef, useState);
  let current = props;
  const api = {
    set(next) { current = { ...current, ...next }; },
    render() {
      cursor = 0; pending = [];
      const tree = component(current);
      for (const { i, effect, deps } of pending) {
        const prev = slots[i];
        if (prev && deps && prev.deps && deps.every((d, k) => Object.is(d, prev.deps[k]))) continue;
        prev?.cleanup?.();
        slots[i] = { deps, cleanup: effect() };
      }
      return tree;
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
  return api;
}
const textOf = (node) => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(textOf).join('') ?? '';
const find = (node, test) => !node || typeof node !== 'object' ? null : test(node) ? node : node.children?.map((child) => find(child, test)).find(Boolean) ?? null;
const button = (tree, label) => find(tree, (n) => n.type === 'button' && textOf(n) === label);
const screen = (tree) => find(tree, (n) => n.type === 'img');
const alertText = (tree) => textOf(find(tree, (n) => n.props.role === 'alert'));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
const frame = (seq) => ({ seq, image: `IMG${seq}`, width: 603, height: 1311 });
const key = (name, extra = {}) => { const e = { key: name, metaKey: false, ctrlKey: false, altKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra }; return e; };
const BOX = { left: 0, top: 0, width: 400, height: 600 };
let focused = 0;
const pointer = (x, y) => ({ clientX: x, clientY: y, currentTarget: { getBoundingClientRect: () => BOX, focus() { focused++; } } });
const views = (phone) => phone.calls.filter(([name]) => name === 'view');
const inputs = (phone) => phone.calls.filter(([name]) => name === 'input').map(([, input]) => input);

test('polling asks for the picture with the last seq, one call at a time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const waiting = [];
  const phone = fakePhone({ view: (since) => { phone.calls.push(['view', since]); return new Promise((resolve) => waiting.push(resolve)); } });
  const ui = mount({ phone, visible: true });
  ui.render();
  assert.deepEqual(views(phone), [['view', 0]]);
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(views(phone).length, 1, 'no second call while the first has not answered');
  waiting.shift()({ status: on(), frame: frame(7) });
  await settle();
  assert.equal(views(phone).length, 1, 'waits one interval after an answer');
  t.mock.timers.tick(phoneModel.POLL_MS);
  await settle();
  assert.deepEqual(views(phone), [['view', 0], ['view', 7]]);
  const shown = ui.render();
  assert.equal(screen(shown).props.src, 'data:image/jpeg;base64,IMG7');
  ui.unmount();
});

test('polling stops when the tab is hidden, and starts again when it is shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const phone = fakePhone({ view: (since) => { phone.calls.push(['view', since]); return Promise.resolve({ status: on(), frame: frame(3) }); } });
  const ui = mount({ phone, visible: true });
  ui.render();
  await settle();
  t.mock.timers.tick(phoneModel.POLL_MS);
  await settle();
  const before = views(phone).length;
  assert.ok(before >= 2);
  ui.set({ visible: false });
  ui.render();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(views(phone).length, before, 'no calls while hidden');
  ui.set({ visible: true });
  ui.render();
  await settle();
  assert.equal(views(phone).length, before + 1);
  assert.deepEqual(views(phone).at(-1), ['view', 3]);
  ui.unmount();
});

test('an answer that arrives after the tab was hidden does not start more polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const waiting = [];
  const phone = fakePhone({ view: (since) => { phone.calls.push(['view', since]); return new Promise((resolve) => waiting.push(resolve)); } });
  const ui = mount({ phone, visible: true });
  ui.render();
  ui.set({ visible: false });
  ui.render();
  waiting.shift()({ status: on(), frame: frame(1) });
  await settle();
  assert.equal(screen(ui.render()), null, 'a late answer is not drawn');
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(views(phone).length, 1);
  // Shown again while nothing is in flight: one new call.
  ui.set({ visible: true });
  ui.render();
  await settle();
  assert.equal(views(phone).length, 2);
  ui.unmount();
});

test('showing the tab again never overlaps a call that is still waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const waiting = [];
  const phone = fakePhone({ view: (since) => { phone.calls.push(['view', since]); return new Promise((resolve) => waiting.push(resolve)); } });
  const ui = mount({ phone, visible: true });
  ui.render();
  ui.set({ visible: false }); ui.render();
  ui.set({ visible: true }); ui.render();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(views(phone).length, 1, 'still the first call only');
  waiting.shift()({ status: on(), frame: null });
  await settle();
  t.mock.timers.tick(phoneModel.POLL_MS);
  await settle();
  assert.equal(views(phone).length, 2);
  ui.unmount();
});

test('unmounting stops polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const phone = fakePhone();
  const ui = mount({ phone, visible: true });
  ui.render();
  await settle();
  ui.unmount();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(views(phone).length, 1);
});

test('a refused view shows its message and polling goes on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let fail = true;
  const phone = fakePhone({ view: (since) => { phone.calls.push(['view', since]); return fail ? Promise.reject(new Error('The helper is not answering.')) : Promise.resolve({ status: on(), frame: frame(2) }); } });
  const ui = mount({ phone, visible: true, initial: on() });
  ui.render();
  await settle();
  assert.equal(alertText(ui.render()), 'The helper is not answering.');
  t.mock.timers.tick(phoneModel.POLL_MS);
  await settle();
  assert.equal(views(phone).length, 2);
  fail = false;
  t.mock.timers.tick(phoneModel.POLL_MS);
  await settle();
  assert.equal(views(phone).length, 3);
  assert.equal(find(ui.render(), (n) => n.props.role === 'alert'), null, 'the message goes at the next good answer');
  ui.unmount();
});

test('a refused tap shows its message until something works, and a good poll does not hide it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let refuse = true;
  const phone = fakePhone({ input: (input) => { phone.calls.push(['input', input]); return refuse ? Promise.reject(new Error('Turn the phone on first.')) : Promise.resolve(on({ kind: 'human', secondsLeft: 10 })); } });
  const ui = mount({ phone, visible: true, initial: on() });
  let tree = ui.render();
  await settle();
  button(tree, 'Home').props.onClick();
  await settle();
  t.mock.timers.tick(phoneModel.POLL_MS * 3);
  await settle();
  assert.equal(alertText(ui.render()), 'Turn the phone on first.');
  refuse = false;
  button(ui.render(), 'Home').props.onClick();
  await settle();
  assert.equal(find(ui.render(), (n) => n.props.role === 'alert'), null);
  ui.unmount();
});

test('Turn on, Turn off, Give back, Home and Lock call the phone', async () => {
  const phone = fakePhone();
  const idle = mount({ phone, visible: false, initial: off() });
  button(idle.render(), 'Turn on').props.onClick();
  await settle();
  const running = mount({ phone, visible: false, initial: on({ kind: 'human', secondsLeft: 4 }) });
  const tree = running.render();
  button(tree, 'Give back').props.onClick();
  button(tree, 'Home').props.onClick();
  button(tree, 'Lock').props.onClick();
  button(tree, 'Turn off').props.onClick();
  await settle();
  assert.deepEqual(phone.calls.map(([name, arg]) => name === 'input' ? `input:${arg.button}` : name), ['start', 'giveBack', 'input:home', 'input:lock', 'stop']);
});

test('a press and release on the picture tap or swipe; one outside does nothing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const phone = fakePhone({ view: () => Promise.resolve({ status: on(), frame: frame(1) }) });
  const ui = mount({ phone, visible: true, initial: on() });
  ui.render();
  await settle();
  const img = screen(ui.render());
  assert.equal(img.props.tabIndex, 0);
  assert.equal(img.props.draggable, false);
  assert.equal(img.props.alt, "Phone screen. Click to tap, drag to swipe, type while it's selected.");
  focused = 0;
  img.props.onPointerDown(pointer(250, 300));
  assert.equal(focused, 1, 'pressing focuses the screen');
  t.mock.timers.tick(60);
  img.props.onPointerUp(pointer(250, 300));
  img.props.onPointerDown(pointer(250, 500));
  t.mock.timers.tick(400);
  img.props.onPointerUp(pointer(250, 100));
  img.props.onPointerDown(pointer(10, 300));
  img.props.onPointerUp(pointer(10, 300));
  img.props.onPointerDown(pointer(250, 300));
  img.props.onPointerUp(pointer(10, 300));
  img.props.onPointerDown(pointer(10, 300));
  img.props.onPointerUp(pointer(250, 300));
  img.props.onPointerUp(pointer(250, 300));
  await settle();
  assert.deepEqual(inputs(phone), [
    { kind: 'tap', x: 410, y: 655 },
    { kind: 'swipe', x1: 410, y1: 1092, x2: 410, y2: 218, ms: 400 },
  ]);
  assert.equal(find(ui.render(), (n) => n.props.role === 'alert'), null, 'a press outside the picture is not an error');
  ui.unmount();
});

test('typed characters go as one piece after a pause, and a key sends them first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const phone = fakePhone({ view: () => Promise.resolve({ status: on(), frame: frame(1) }) });
  const ui = mount({ phone, visible: true, initial: on() });
  ui.render();
  await settle();
  const img = screen(ui.render());
  const events = ['h', 'i', ' ', 'y', 'o'].map((k) => key(k));
  for (const event of events) { img.props.onKeyDown(event); t.mock.timers.tick(phoneModel.TYPE_FLUSH_MS - 50); }
  assert.deepEqual(inputs(phone), [], 'nothing is sent while characters keep coming');
  assert.ok(events.every((e) => e.prevented), 'handled keys are kept from the page');
  t.mock.timers.tick(50);
  await settle();
  assert.deepEqual(inputs(phone), [{ kind: 'type', text: 'hi yo' }]);
  // A key flushes the buffer first, then goes itself, in that order.
  img.props.onKeyDown(key('a'));
  const enter = key('Enter');
  img.props.onKeyDown(enter);
  assert.ok(enter.prevented);
  await settle();
  assert.deepEqual(inputs(phone).slice(1), [{ kind: 'type', text: 'a' }, { kind: 'key', key: 'enter' }]);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(inputs(phone).length, 3, 'the flushed text is not sent twice');
  ui.unmount();
});

test('the key waits for the typed text to be accepted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const waiting = [];
  const phone = fakePhone({
    view: () => Promise.resolve({ status: on(), frame: frame(1) }),
    input: (input) => { phone.calls.push(['input', input]); return new Promise((resolve) => waiting.push(resolve)); },
  });
  const ui = mount({ phone, visible: true, initial: on() });
  ui.render();
  await settle();
  const img = screen(ui.render());
  img.props.onKeyDown(key('a'));
  img.props.onKeyDown(key('Enter'));
  await settle();
  assert.deepEqual(inputs(phone), [{ kind: 'type', text: 'a' }]);
  waiting.shift()(on());
  await settle();
  assert.deepEqual(inputs(phone), [{ kind: 'type', text: 'a' }, { kind: 'key', key: 'enter' }]);
  ui.unmount();
});

test('keys the phone does not use are left alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const phone = fakePhone({ view: () => Promise.resolve({ status: on(), frame: frame(1) }) });
  const ui = mount({ phone, visible: true, initial: on() });
  ui.render();
  await settle();
  const img = screen(ui.render());
  const paste = key('v', { metaKey: true });
  const shift = key('Shift');
  img.props.onKeyDown(paste);
  img.props.onKeyDown(shift);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(paste.prevented, false);
  assert.equal(shift.prevented, false);
  assert.deepEqual(inputs(phone), []);
  ui.unmount();
});

test('typing that is waiting is dropped when the tab is hidden or closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const phone = fakePhone({ view: () => Promise.resolve({ status: on(), frame: frame(1) }) });
  const ui = mount({ phone, visible: true, initial: on() });
  ui.render();
  await settle();
  screen(ui.render()).props.onKeyDown(key('a'));
  ui.set({ visible: false });
  ui.render();
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(inputs(phone), [], 'hiding drops what was waiting');
  ui.set({ visible: true });
  ui.render();
  await settle();
  screen(ui.render()).props.onKeyDown(key('b'));
  ui.unmount();
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(inputs(phone), [], 'closing drops it too');
});

test('typing dropped by hiding does not come back with the next typing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const phone = fakePhone({ view: () => Promise.resolve({ status: on(), frame: frame(1) }) });
  const ui = mount({ phone, visible: true, initial: on() });
  ui.render();
  await settle();
  screen(ui.render()).props.onKeyDown(key('a'));
  ui.set({ visible: false });
  ui.render();
  ui.set({ visible: true });
  ui.render();
  await settle();
  screen(ui.render()).props.onKeyDown(key('b'));
  t.mock.timers.tick(phoneModel.TYPE_FLUSH_MS);
  await settle();
  assert.deepEqual(inputs(phone), [{ kind: 'type', text: 'b' }]);
  ui.unmount();
});
