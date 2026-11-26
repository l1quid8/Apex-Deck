import test from 'node:test';
import assert from 'node:assert/strict';
import { addWithAgentsFullAccess, addWithAgentFullAccess, confirmAgentFullAccess } from '../src/agentFullAccess.ts';

const agent = { id: 'null', display_name: 'Null', access: 'full' };
function host(initial = false) {
  let approved = initial;
  const calls = [];
  return { calls, supports: () => true, async call(cmd, args) {
    calls.push([cmd, args]);
    if (args.confirm) approved = true;
    return { approved };
  } };
}
test('explicit confirmation grants once on the selected host and survives another thread', async () => {
  const backend = host(); let prompts = 0;
  const confirm = message => { prompts++; assert.match(message, /code written by other agents/); return true; };
  await confirmAgentFullAccess(backend, agent, confirm);
  await confirmAgentFullAccess(backend, agent, confirm);
  assert.equal(prompts, 1);
  assert.equal(backend.calls.filter(([, args]) => args.confirm).length, 1);
  const other = host();
  await confirmAgentFullAccess(other, agent, confirm);
  assert.equal(prompts, 2);
});
test('canceling confirmation never sends a grant', async () => {
  const backend = host();
  await assert.rejects(confirmAgentFullAccess(backend, agent, () => false), /not confirmed/);
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0][1].confirm, undefined);
});
test('restricted access never requests or inherits a Full grant', async () => {
  const backend = host(true);
  for (const access of ['read', 'ask', 'edits']) await confirmAgentFullAccess(backend, { ...agent, access }, () => assert.fail('No confirmation for restricted access'));
  assert.equal(backend.calls.length, 0);
});
test('old services, failed writes and unacknowledged grants do not report success', async () => {
  await assert.rejects(confirmAgentFullAccess({ supports: () => false }, agent), /Update/);
  const backend = host();
  backend.call = async (_, args) => { if (args.confirm) throw new Error('offline'); return { approved: false }; };
  await assert.rejects(confirmAgentFullAccess(backend, agent, () => true), /offline/);
  backend.call = async () => ({ approved: false });
  await assert.rejects(confirmAgentFullAccess(backend, agent, () => true), /did not save/);
});

test('older services permit unchanged Full edits but reject elevation', async () => {
  const backend = { supports: () => false, call: () => assert.fail('Unsupported command') };
  await confirmAgentFullAccess(backend, agent, () => assert.fail('Unchanged access'), 'full');
  await assert.rejects(confirmAgentFullAccess(backend, agent, () => true, 'ask'), /Update/);
});

test('legacy copied agents consent before creation and grant after identity is saved', async () => {
  const events = [];
  const backend = { supports: () => true, call: async (_, args) => {
    events.push(args.confirm ? 'grant' : 'query');
    if (args.confirm) assert.ok(events.includes('add'));
    return { approved: !!args.confirm };
  } };
  const warning = await addWithAgentFullAccess(backend, agent, async () => { events.push('add'); }, () => { events.push('consent'); return true; });
  assert.equal(warning, undefined);
  assert.deepEqual(events, ['query', 'consent', 'add', 'grant']);
});
test('canceling an add creates nothing; failed grant reports the agent already added', async () => {
  const backend = host(); let added = 0;
  await assert.rejects(addWithAgentFullAccess(backend, agent, async () => { added++; }, () => false), /not confirmed/);
  assert.equal(added, 0);
  backend.call = async (_, args) => { if (args.confirm) throw Error('offline'); return { approved: false }; };
  const warning = await addWithAgentFullAccess(backend, agent, async () => { added++; }, () => true);
  assert.equal(added, 1);
  assert.match(warning, /was added.*settings to retry/);
});

test('a new phone thread collects every consent before creating any agent', async () => {
  const backend = host(); let prompts = 0;
  await assert.rejects(addWithAgentsFullAccess(backend, [agent, { ...agent, id: 'second' }], async () => assert.fail('Canceled thread must not be created'), () => ++prompts === 1), /not confirmed/);
  assert.equal(prompts, 2);
  assert.equal(backend.calls.filter(([, args]) => args.confirm).length, 0);
});
