import test from 'node:test';
import assert from 'node:assert/strict';
import { age, appendTail, arrowCode, controlCode, dotState, fromPhone, groupForSheet, isYesNo, lastLine, nextDotChange, stripAnsi, stripOrder, swipeIntent } from '../src/phone/phoneTerminals.ts';

const terminal = (id, machineId = 'm1', project = 'apex-deck', extra = {}) => ({
  id, name: id, machineId, machineName: machineId, project, cwd: null, tail: '', matched: undefined,
  state: 'running', exitCode: null, lastActivity: 10_000, cursor: 1, firstSeen: 1, ...extra,
});

test('terminal output helpers strip ANSI and recognize status prompts', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(lastLine('old\rnew\n'), 'new');
  assert.equal(isYesNo('Delete local test data? (y/N)'), true);
  assert.equal(dotState(terminal('t', 'm1', 'p', { tail: 'Delete local test data? (y/N)', lastActivity: 0 }), 2000), 'ask');
});

test('a quiet running terminal is due a redraw when it may be asking, then when it goes idle', () => {
  const items = [terminal('a', 'm1', 'p', { lastActivity: 10_000 }), terminal('done', 'm1', 'p', { state: 'exited', exitCode: 0, lastActivity: 9_000 })];
  assert.equal(nextDotChange(items, 10_000), 11_500);
  assert.equal(nextDotChange(items, 11_500), 15_000);
  assert.equal(nextDotChange(items, 15_000), null);
});

test('status and source helpers classify completed and phone terminals', () => {
  assert.equal(dotState(terminal('t', 'm1', 'p', { state: 'exited', exitCode: 1 })), 'fail');
  assert.equal(fromPhone('phone-1'), true);
  assert.equal(age(0, 120_000), '2m');
});

test('sheet groups prioritize the current machine and project then recent activity', () => {
  const items = [terminal('older', 'm2', 'other'), terminal('newer', 'm1', 'apex-deck', { lastActivity: 20_000 })];
  const groups = groupForSheet([{ id: 'm2', name: 'B' }, { id: 'm1', name: 'A' }], items, { machineId: 'm1', project: 'apex-deck' });
  assert.equal(groups[0].machine.id, 'm1');
  assert.equal(groups[0].terminals[0].id, 'newer');
  assert.deepEqual(stripOrder([...items].reverse(), 'm1', 'apex-deck').map((item) => item.id), ['newer']);
});

test('swipe intent rejects vertical gestures and commits only clear horizontal drags', () => {
  assert.equal(swipeIntent(8, 0), null);
  assert.equal(swipeIntent(40, 30), null);
  assert.equal(swipeIntent(-40, 5), 'left');
  assert.equal(swipeIntent(40, 5), 'right');
});

test('control latch and arrows produce terminal key sequences', () => {
  assert.equal(controlCode('c'), '\x03');
  assert.equal(controlCode('['), '\x1b');
  assert.equal(arrowCode('A', false), '\x1b[A');
  assert.equal(arrowCode('A', true), '\x1bOA');
});

test('recent output stays within an 8 KiB UTF-8 boundary', () => {
  const tail = appendTail('💥'.repeat(3000), '✓');
  assert.ok(new TextEncoder().encode(tail).length <= 8192);
  assert.ok(!tail.includes('\uFFFD'));
});
