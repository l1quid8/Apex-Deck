import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeCapability, checkedBounds, collectOwnership, recheckOwnedProcess, bootstrapRequestAllowed } from '../desktop/generated-ui/policy.mjs';
import { revisionDigest, readRuntimeMessage, MessageBudget, readRunRequest } from '../desktop/generated-ui/protocol.mjs';

const card = { schemaVersion: 1, kind: 'generated', cardId: 'a', title: 'A', summary: 'Summary', html: '<p>A</p>', css: '', js: '', fallback: 'Fallback' };
const identity = { threadId: 'thread', seq: 3, cardId: 'a', hostId: 'local' };
const requestId = 'request'.repeat(4);
const binding = { runId: 'a'.repeat(32), revisionDigest: 'b'.repeat(64) };
const envelope = (type, extra = {}) => ({ protocolVersion: 1, ...binding, type, ...extra });
const frame = (pid, node, url = 'about:srcdoc') => ({ osProcessId: pid, frameTreeNodeId: node, detached: false, url });
const contents = (id, frames) => ({ id, isDestroyed: () => false, mainFrame: { ...frames[0], framesInSubtree: frames } });

test('production capability cannot be enabled by environment or incomplete evidence', () => {
  process.env.APEX_DECK_GENERATED_UI = '1';
  assert.equal(runtimeCapability().enabled, false);
  assert.equal(runtimeCapability({ electron: '44.5.1', chromium: 'x', network: true }).enabled, false);
  delete process.env.APEX_DECK_GENERATED_UI;
});

test('bounds reject control overlap and out-of-window or stale geometry', () => {
  const rect = { x: 20, y: 80, width: 500, height: 300 };
  assert.deepEqual(checkedBounds(rect, { width: 900, height: 600 }), rect);
  for (const bad of [{ ...rect, y: 0 }, { ...rect, width: 1000 }, { ...rect, height: 801 }, { ...rect, x: NaN }, { ...rect, extra: 0 }]) {
    assert.equal(checkedBounds(bad, { width: 900, height: 600 }), null);
  }
});

test('bootstrap request permission cannot be reused for subframes or another URL', () => {
  const url = `https://generated-ui.invalid/${binding.runId}`;
  assert.equal(bootstrapRequestAllowed({ url, resourceType: 'mainFrame' }, url, true), true);
  for (const request of [{ url, resourceType: 'subFrame' }, { url: `${url}?x`, resourceType: 'mainFrame' }, { url: 'http://127.0.0.1/', resourceType: 'xhr' }]) {
    assert.equal(bootstrapRequestAllowed(request, url, true), false);
  }
  assert.equal(bootstrapRequestAllowed({ url, resourceType: 'mainFrame' }, url, false), false);
});

test('model delivery requires both generated frames and exclusive OS ownership', () => {
  const wrapper = frame(11, 1, 'https://generated-ui.invalid/run');
  const child = frame(12, 2);
  const generated = contents(1, [wrapper, child]);
  const deck = contents(2, [frame(10, 3, 'app://deck/')]);
  const metrics = [{ pid: 11, creationTime: 1 }, { pid: 12, creationTime: 2 }];
  const owner = collectOwnership(generated, [generated, deck], metrics);
  assert.equal(owner.ok, true);
  assert.deepEqual(owner.records.map(record => record.pid).sort(), [11, 12]);
  assert.equal(collectOwnership(contents(1, [wrapper]), [deck], metrics).ok, false);
  assert.equal(collectOwnership(generated, [generated, contents(2, [frame(12, 3)])], metrics).ok, false);
});

test('termination refuses a reused PID or a PID now shared with Deck', () => {
  const generated = contents(1, [frame(11, 1, 'https://generated-ui.invalid/run'), frame(12, 2)]);
  const metrics = [{ pid: 11, creationTime: 1 }, { pid: 12, creationTime: 2 }];
  const owner = collectOwnership(generated, [generated], metrics);
  const record = owner.records.find(value => value.pid === 12);
  assert.equal(recheckOwnedProcess(record, generated, [generated], metrics), true);
  assert.equal(recheckOwnedProcess(record, generated, [generated, contents(2, [frame(12, 4)])], metrics), false);
  assert.equal(recheckOwnedProcess(record, generated, [generated], [{ pid: 12, creationTime: 99 }]), false);
});

test('approval digest binds every payload field, identity, and adapter/security versions', () => {
  const digest = revisionDigest(card, identity, { adapter: '1', security: '1' });
  assert.match(digest, /^[a-f0-9]{64}$/);
  for (const field of Object.keys(card)) assert.notEqual(revisionDigest({ ...card, [field]: `${card[field]} changed` }, identity, { adapter: '1', security: '1' }), digest);
  assert.notEqual(revisionDigest(card, { ...identity, seq: 4 }, { adapter: '1', security: '1' }), digest);
  assert.notEqual(revisionDigest(card, identity, { adapter: '2', security: '1' }), digest);
  assert.notEqual(revisionDigest(card, identity, { adapter: '1', security: '2' }), digest);
});

test('runtime messages reject stale authority, unknown keys, ports, and oversized UTF8 text', () => {
  assert.equal(readRuntimeMessage(envelope('ready'), binding).ok, true);
  assert.equal(readRuntimeMessage(envelope('resize', { height: Infinity }), binding).ok, false);
  assert.equal(readRuntimeMessage(envelope('discuss', { text: '💬'.repeat(2100) }), binding).ok, false);
  assert.equal(readRuntimeMessage(envelope('pong', { nonce: 'c'.repeat(32) }), binding).ok, true);
  for (const bad of [{ ...envelope('ready'), extra: true }, { ...envelope('ready'), runId: 'd'.repeat(32) }, envelope('send'), envelope('ready', { ports: [] })]) assert.equal(readRuntimeMessage(bad, binding).ok, false);
  assert.equal(readRuntimeMessage(envelope('ready'), binding, [1]).ok, false);
});

test('trusted wrapper fault only admits the fixed flood code', () => {
  assert.equal(readRuntimeMessage(envelope('fault', { code: 'message-flood' }), binding).ok, true);
  assert.equal(readRuntimeMessage(envelope('fault', { code: 'run-script' }), binding).ok, false);
  assert.equal(readRuntimeMessage(envelope('fault', { code: 'message-flood', text: 'send' }), binding).ok, false);
});

test('message budget coalesces resize and stops a persistent storm', () => {
  const budget = new MessageBudget();
  assert.equal(budget.accept('resize', 0), 'accept');
  assert.equal(budget.accept('resize', 10), 'drop');
  assert.equal(budget.accept('resize', 101), 'accept');
  for (let i = 0; i < 26; i++) budget.accept('pong', 200);
  assert.equal(budget.accept('pong', 200), 'accept');
  assert.equal(budget.accept('pong', 200), 'drop');
  for (let i = 0; i < 30; i++) budget.accept('pong', 200);
  assert.equal(budget.accept('pong', 200), 'stop');
});

test('a persistent 31-per-second flood stops in the next over-limit window', () => {
  const budget = new MessageBudget();
  for (let i = 0; i < 30; i++) assert.equal(budget.accept('pong', 0), 'accept');
  assert.equal(budget.accept('pong', 0), 'drop');
  for (let i = 0; i < 30; i++) assert.equal(budget.accept('pong', 1000), 'accept');
  assert.equal(budget.accept('pong', 1000), 'stop');
});

test('run requests bind card identity and reject unknown keys before host creation', () => {
  const bounds = { x: 20, y: 80, width: 500, height: 300 };
  assert.equal(readRunRequest({ requestId, source: JSON.stringify(card), identity, bounds }).ok, true);
  assert.equal(readRunRequest({ requestId, source: JSON.stringify(card), identity: { ...identity, cardId: 'wrong' }, bounds }).ok, false);
  assert.equal(readRunRequest({ requestId, source: JSON.stringify(card), identity, bounds, execute: true }).ok, false);
  assert.equal(readRunRequest({ source: JSON.stringify(card), identity, bounds }).ok, false);
});
