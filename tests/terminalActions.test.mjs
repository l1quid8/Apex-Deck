import test from 'node:test';
import assert from 'node:assert/strict';
import { copyLastOutput, endTerminal, renameTerminal, resizePhoneTerminal } from '../src/phone/terminalActions.ts';

test('rename and End call their backend commands', async () => {
  const calls = [];
  const backend = { ptyRename: async (...args) => calls.push(['rename', ...args]), ptyKill: async (...args) => calls.push(['kill', ...args]) };
  await renameTerminal(backend, 'term-1', 'tests');
  await endTerminal(backend, 'term-1');
  assert.deepEqual(calls, [['rename', 'term-1', 'tests'], ['kill', 'term-1']]);
});

test('Copy last output uses only the supplied clipboard stub', async () => {
  const calls = [];
  const clipboard = async (text) => { calls.push(text); return true; };
  assert.equal(await copyLastOutput('recent output', clipboard), true);
  assert.deepEqual(calls, ['recent output']);
});

test('terminal resize never changes a Mac-owned pane', async () => {
  const calls = [];
  const backend = { ptyResize: async (...args) => calls.push(args) };
  assert.equal(await resizePhoneTerminal(backend, 'pane-1', 80, 24), false);
  assert.deepEqual(calls, []);
  assert.equal(await resizePhoneTerminal(backend, 'phone-1', 80, 24), true);
  assert.deepEqual(calls, [['phone-1', 80, 24]]);
});
