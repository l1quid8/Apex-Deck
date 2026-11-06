import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createComposerHistory } from '../src/composerHistory.ts';
const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/useComposerHistory.ts', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript'] }).code;
function harness() {
  const refs = [];
  let cursor = 0, effects = [], text = 'draft', scope = 'a', history = ['old', 'new'];
  const hook = new Function('useRef', 'useLayoutEffect', 'createComposerHistory', `${compiled}; return useComposerHistory;`)(
    initial => refs[cursor++] ??= { current: initial }, fn => effects.push(fn), createComposerHistory);
  const input = { value: text, selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; } };
  const render = () => {
    cursor = 0; effects = [];
    const api = hook(scope, text, value => { text = typeof value === 'function' ? value(text) : value; }, () => history);
    input.value = text; effects.forEach(fn => fn()); return api;
  };
  return { input, render, switchScope(value) { scope = value; }, external(value) { text = value; }, history(value) { history = value; }, event(key = 'ArrowUp', extra = {}) { return { key, currentTarget: input, nativeEvent: {}, preventDefault() { this.defaultPrevented = true; }, ...extra }; } };
}

test('hook applies recalled caret and restores draft selection after controlled text commit', () => {
  const h = harness(); let api = h.render();
  h.input.selectionStart = h.input.selectionEnd = 2;
  const up = h.event(); assert.equal(api.onKeyDown(up), true); assert.equal(up.defaultPrevented, true);
  api = h.render(); assert.equal(h.input.value, 'new'); assert.equal(h.input.selectionStart, 3);
  api.onKeyDown(h.event('ArrowDown')); h.render();
  assert.equal(h.input.value, 'draft'); assert.equal(h.input.selectionStart, 2);
});

test('all ordinary writes, including same-text replacements and send clearing, reset recall', () => {
  for (const value of ['edited', 'new', '']) {
    const h = harness(); let api = h.render(); api.onKeyDown(h.event()); api = h.render();
    api.setText(value); api = h.render();
    assert.equal(api.onKeyDown(h.event('ArrowDown')), false);
    api.onKeyDown(h.event()); api = h.render(); api.onKeyDown(h.event('ArrowDown')); h.render();
    assert.equal(h.input.value, value);
  }
});

test('conversation switches and external store updates discard browsing', () => {
  for (const change of [h => h.switchScope('b'), h => h.external('external')]) {
    const h = harness(); let api = h.render(); api.onKeyDown(h.event()); h.render(); change(h);
    api = h.render(); assert.equal(api.onKeyDown(h.event('ArrowDown')), false);
  }
});

test('duplicates still move caret when React can skip an equal-value update', () => {
  const h = harness(); h.history(['new', 'new']); let api = h.render();
  api.onKeyDown(h.event()); api = h.render(); h.input.selectionStart = h.input.selectionEnd = 0;
  assert.equal(api.onKeyDown(h.event()), true); assert.equal(h.input.selectionStart, 3);
});

test('native IME state and previously handled arrows are not consumed', () => {
  const h = harness(), api = h.render();
  for (const extra of [{ nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }, { defaultPrevented: true }]) {
    assert.equal(api.onKeyDown(h.event('ArrowUp', extra)), false);
  }
});

// Execute the actual textarea handlers to protect menu/question priority and
// ensure both desktop surfaces consume recalls before their send handling.
for (const file of ['ChatPane.tsx', 'ApexAgentAll.tsx']) {
  test(`${file} gives menus and questions priority over recall without submitting`, () => {
    const src = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const start = src.indexOf('onKeyDown={', src.indexOf('aria-label="Message the room"') >= 0 ? src.indexOf('aria-label="Message the room"') : src.indexOf('className="apex-agent-all-input"'));
    const end = file === 'ChatPane.tsx' ? src.indexOf('\n          rows={1}', start) : src.indexOf(' /></div>', start);
    const expression = src.slice(start + 'onKeyDown={'.length, end).trim().replace(/}$/, '');
    let menu = false, question = false, recalls = 0, submits = 0;
    const handler = new Function('composerMenu', 'formKeys', 'composerHistory', 'send', 'tldr', 'setTldr', 'toggleTldr', 'pendingReply', 'personal', 'busy', 'stopBots', 'run', 'text', transform(`return (${expression});`, { transforms: ['typescript'] }).code)(
      { current: { key: () => menu } }, () => question, { onKeyDown: () => { recalls++; return true; } }, () => submits++, false, () => {}, () => {}, null, null, false, () => {}, () => {}, 'draft');
    const event = { key: 'ArrowUp', currentTarget: { form: { requestSubmit() { submits++; } } }, preventDefault() {} };
    menu = true; handler(event); assert.equal(recalls, 0);
    menu = false;
    if (file === 'ChatPane.tsx') { question = true; handler(event); assert.equal(recalls, 0); question = false; }
    handler(event); assert.equal(recalls, 1); assert.equal(submits, 0);
  });
}
