import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { CLASS_LABEL, MODE_LABEL, TASK_STATUS } from '../src/personalAssistant.ts';

const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/PersonalPanels.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const textOf = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(textOf).join('') ?? '';
const find = (node, predicate) => !node || typeof node !== 'object' ? null : predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean) ?? null;
const findAll = (node, predicate, out = []) => { if (!node || typeof node !== 'object') return out; if (predicate(node)) out.push(node); node.children?.forEach(child => findAll(child, predicate, out)); return out; };
const button = (tree, label) => find(tree, node => node.type === 'button' && textOf(node) === label);
const settle = () => new Promise(resolve => setImmediate(resolve));

const now = Date.now();
const record = {
  id: 'pa-1', hostId: 'vps-1', name: 'Assistant', style: 'Brief', timezone: 'Europe/London', allowedFolders: [], revision: 7, messages: [],
  modes: { read: 'auto', write: 'ask', send: 'handOff', spend: 'ask' },
  budget: { unknownCostOk: false }, privacy: { localOnly: false, allowedEndpoints: [] }, contextBudgetChars: 8000,
  tasks: [
    { id: 't1', goal: 'Check the invoice inbox', completionCriteria: [], targetHost: 'vps-1', status: 'waiting', wait: { kind: 'timer', at: now + 3600000 }, receipts: [], lastUpdate: 'Waiting for its next run', updatedAt: now - 1000, runsDone: 2 },
    { id: 't2', goal: 'Draft the vendor reply', completionCriteria: [], targetHost: 'vps-1', status: 'needsYou', receipts: [{ opId: 'o1', phase: 'verified', outputExcerpt: 'Draft ready for review', rerunAfterRestart: false, startedAt: now - 5000 }], updatedAt: now },
  ],
  schedules: [
    { id: 's1', goal: 'Summarize the inbox', argv: [], everyMs: 30 * 60000, status: 'active', createdAt: now, nextAt: now + 60000, runs: 3 },
    { id: 's2', goal: 'Old job', argv: [], dailyAt: '08:00', status: 'cancelled', createdAt: now, runs: 0 },
  ],
  facts: [
    { id: 'f1', text: 'Prefers morning meetings', kind: 'preference', explicit: true, confidence: 100, source: {}, createdAt: now },
    { id: 'f2', text: 'Office is in Leeds', kind: 'fact', explicit: false, confidence: 60, source: {}, createdAt: now, supersededBy: 'f1' },
  ],
  rules: [{ id: 'r1', text: 'Ask before emailing clients', class: 'send', mode: 'handOff', createdAt: now }],
  costs: [
    { at: now, purpose: 'reply', kind: 'text', source: 'reported', micros: 12300, bytesOut: 2048, endpoint: 'venice' },
    { at: now, purpose: 'helper', kind: 'text', source: 'estimated', micros: 10000, bytesOut: 1024, endpoint: 'venice' },
    { at: now, purpose: 'check', kind: 'text', source: 'unknown', bytesOut: 512, endpoint: 'local' },
  ],
  notices: [],
};

function fakeLane(overrides = {}) {
  const calls = [];
  const spy = (name) => async (...args) => { calls.push([name, ...args]); };
  const lane = {
    name: 'Assistant', hostName: 'VPS', assistant: structuredClone(record), offline: false,
    send: spy('send'), decide: spy('decide'), cancel: spy('cancel'),
    configure: spy('configure'), cancelSchedule: spy('cancelSchedule'), removeRule: spy('removeRule'),
    addRule: spy('addRule'), remember: spy('remember'), correctFact: spy('correctFact'),
    forgetFact: spy('forgetFact'), seeNotices: spy('seeNotices'),
    ...overrides,
  };
  return { lane, calls };
}

function mount(props) {
  const states = [];
  let cursor = 0;
  const useState = (initial) => {
    const i = cursor++;
    if (!(i in states)) states[i] = initial;
    return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
  };
  const useEffect = (effect) => { cursor++; effect(); };
  const component = new Function('React', 'useState', 'useEffect', 'PersonalBrowser', 'TASK_STATUS', 'CLASS_LABEL', 'MODE_LABEL', `${compiled}\nreturn PersonalPanels;`)(React, useState, useEffect, () => null, TASK_STATUS, CLASS_LABEL, MODE_LABEL);
  return { render() { cursor = 0; return component({ onClose() {}, ...props }); } };
}

test('activity lists the waiting reason and the Stop task button cancels that task', async () => {
  const { lane, calls } = fakeLane();
  const h = mount({ lane });
  let tree = h.render();
  const waiting = textOf(tree);
  assert.match(waiting, /Next run at \d\d:\d\d/);
  assert.ok(find(tree, node => node.props?.['data-status'] === 'waiting'), 'status chip carries data-status');
  const row = findAll(tree, node => node.props?.className === 'personal-panels-row').find(node => textOf(node).includes('Check the invoice inbox'));
  button(row, 'Stop task').props.onClick();
  await settle();
  assert.deepEqual(calls, [['cancel', 't1']]);
});

test('the activity row expands to show the latest receipt output', () => {
  const { lane } = fakeLane();
  const h = mount({ lane });
  let tree = h.render();
  const goal = find(tree, node => node.type === 'button' && textOf(node).includes('Draft the vendor reply'));
  goal.props.onClick();
  tree = h.render();
  assert.match(textOf(tree), /Draft ready for review/);
});

test('scheduled lists live schedules only and Cancel schedule calls cancelSchedule', async () => {
  const { lane, calls } = fakeLane();
  const h = mount({ lane, initial: 'scheduled' });
  const tree = h.render();
  assert.match(textOf(tree), /Every 30 min/);
  assert.doesNotMatch(textOf(tree), /Old job/);
  button(tree, 'Cancel schedule').props.onClick();
  await settle();
  assert.deepEqual(calls, [['cancelSchedule', 's1']]);
});

test('memory hides the superseded fact from the main list and Forget calls forgetFact after confirm', async () => {
  const { lane, calls } = fakeLane();
  const savedWindow = globalThis.window;
  globalThis.window = { confirm: () => true };
  try {
    const h = mount({ lane });
    let tree = h.render();
    const tab = find(tree, node => node.props?.role === 'tab' && textOf(node) === 'Memory');
    tab.props.onClick();
    tree = h.render();
    const rows = findAll(tree, node => node.props?.className === 'personal-panels-row');
    assert.ok(rows.some(row => textOf(row).includes('Prefers morning meetings')));
    assert.ok(!rows.some(row => textOf(row).includes('Office is in Leeds')), 'superseded fact is not in the main list');
    const older = find(tree, node => node.type === 'details');
    assert.match(textOf(older), /Office is in Leeds/);
    assert.match(textOf(tree), /You said/);
    const forget = rows.find(row => textOf(row).includes('Prefers morning meetings'));
    button(forget, 'Forget').props.onClick();
    await settle();
    assert.deepEqual(calls, [['forgetFact', 'f1']]);
  } finally {
    globalThis.window = savedWindow;
  }
});

test('costs show the unknown-cost count without adding it as $0', () => {
  const { lane } = fakeLane();
  const h = mount({ lane, initial: 'costs' });
  const tree = h.render();
  const text = textOf(tree);
  assert.match(text, /\$0\.0123/);
  assert.match(text, /est\. \$0\.01/);
  assert.match(text, /1 reply with unknown cost/);
  assert.match(text, /Sent to model providers: 3\.5 KB/);
  assert.ok(findAll(tree, node => node.type === 'td' && textOf(node) === 'unknown').length === 1);
});

test('changing a rule class mode calls configure with the full modes map', async () => {
  const { lane, calls } = fakeLane();
  const h = mount({ lane, initial: 'rules' });
  const tree = h.render();
  const select = find(tree, node => node.type === 'select' && node.props['aria-label'] === CLASS_LABEL.send);
  select.props.onChange({ target: { value: 'ask' } });
  await settle();
  assert.deepEqual(calls, [['configure', { modes: { read: 'auto', write: 'ask', send: 'ask', spend: 'ask' } }]]);
});

test('a failed mutation shows its message in the alert line', async () => {
  const { lane } = fakeLane({ cancel: async () => { throw new Error('Host refused the stop'); } });
  const h = mount({ lane });
  let tree = h.render();
  const row = findAll(tree, node => node.props?.className === 'personal-panels-row').find(node => textOf(node).includes('Check the invoice inbox'));
  button(row, 'Stop task').props.onClick();
  await settle();
  tree = h.render();
  const alert = find(tree, node => node.props?.role === 'alert');
  assert.match(textOf(alert), /Host refused the stop/);
});
