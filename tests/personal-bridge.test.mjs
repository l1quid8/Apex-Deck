import test from 'node:test';
import assert from 'node:assert/strict';
import { linkThisMacOn, runMachineBridge } from '../src/personalAssistant.ts';

/** A backend that logs each call and answers from `handlers`; a handler that throws makes the call fail. */
const fakeBackend = (name, log, handlers) => ({
  call: async (cmd, args) => {
    log.push([name, cmd, args]);
    const handler = handlers[cmd];
    if (!handler) throw new Error(`unexpected ${cmd}`);
    return handler(args);
  },
});

const op = { taskId: 't1', opId: 'o1', operation: { tool: 'host.command', host: 'mac-1', cwd: '/Users/me/apex-assistant', argv: ['echo', 'hi'] } };

test('a claimed command runs on this Mac, and its result is posted once', async () => {
  const log = [];
  let claims = 0;
  const vps = fakeBackend('vps', log, {
    personal_machine_claim: () => (claims++ === 0 ? [op] : []),
    personal_machine_result: () => ({}),
  });
  const local = fakeBackend('local', log, { personal_execute_local: () => ({ exitCode: 0, output: 'hi\n' }) });
  const base = { local, vps, assistantId: 'a1', assistantHostId: 'vps', localHostId: 'mac-1' };
  assert.equal(await runMachineBridge(base), 1);
  assert.equal(await runMachineBridge(base), 0, 'a second pass has nothing new to claim');
  const executed = log.filter(([, cmd]) => cmd === 'personal_execute_local');
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0][2], { assistantId: 'a1', assistantHostId: 'vps', operation: op.operation });
  const posted = log.filter(([, cmd]) => cmd === 'personal_machine_result');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0][2], { assistantId: 'a1', hostId: 'mac-1', taskId: 't1', opId: 'o1', exitCode: 0, output: 'hi\n' });
});

test('a command that fails here is posted back as an error, not as a result', async () => {
  const log = [];
  const vps = fakeBackend('vps', log, {
    personal_machine_claim: () => [op],
    personal_machine_result: () => ({}),
  });
  const local = fakeBackend('local', log, { personal_execute_local: () => { throw new Error('Folder is missing'); } });
  await runMachineBridge({ local, vps, assistantId: 'a1', assistantHostId: 'vps', localHostId: 'mac-1' });
  const posted = log.filter(([, cmd]) => cmd === 'personal_machine_result');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0][2], { assistantId: 'a1', hostId: 'mac-1', taskId: 't1', opId: 'o1', error: 'Folder is missing' });
});

test('linking this Mac allows the folder here first, then tells the assistant host', async () => {
  const log = [];
  const local = fakeBackend('local', log, {
    personal_machine_allow: (args) => ({ hostId: 'mac-1', assistantId: args.assistantId, assistantHostId: args.assistantHostId, folder: '/Users/me/apex-assistant' }),
  });
  const vps = fakeBackend('vps', log, { personal_machine_link: () => ({ assistant: { id: 'a1' } }) });
  const linked = await linkThisMacOn({ local, vps, assistantId: 'a1', assistantHostId: 'vps', folder: '~/apex-assistant' });
  assert.deepEqual(log.map(([who, cmd]) => `${who}:${cmd}`), ['local:personal_machine_allow', 'vps:personal_machine_link']);
  assert.deepEqual(log[1][2], { assistantId: 'a1', hostId: 'mac-1', name: 'Mac', folder: '/Users/me/apex-assistant' });
  assert.equal(linked.hostId, 'mac-1');
});

test('if the Mac refuses the folder, the assistant host is not told', async () => {
  const log = [];
  const local = fakeBackend('local', log, { personal_machine_allow: () => { throw new Error('Folder is outside your home'); } });
  const vps = fakeBackend('vps', log, { personal_machine_link: () => ({ assistant: { id: 'a1' } }) });
  await assert.rejects(linkThisMacOn({ local, vps, assistantId: 'a1', assistantHostId: 'vps', folder: '/etc' }), /outside your home/);
  assert.deepEqual(log.map(([who, cmd]) => `${who}:${cmd}`), ['local:personal_machine_allow']);
});
