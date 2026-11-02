import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createRoomRecovery, representedRoomEvent } from '../src/roomRecovery.ts';
import { applyQuestionEvent } from '../src/questions.ts';
import { applyCutEvent, applyTurnEvent, workingFrom } from '../src/phoneWorking.ts';

const { transform } = createRequire(import.meta.url)('sucrase');

test('a phone replays a journal warning after loading without ending an active turn', async () => {
  // Run PhoneApp's actual event handler, as the thread-identity tests do.
  const source = fs.readFileSync(new URL('../src/phone/PhoneApp.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('    const applyEvent = (event: RoomEvent) => {');
  const end = source.indexOf('    const recovery =', start);
  assert.ok(start >= 0 && end > start);
  const code = transform(source.slice(start, end), { transforms: ['typescript'] }).code;
  const working = workingFrom(['null'], 100);
  const asks = { questions: [], offer: null };
  let room = { id: 'r', working, asks };
  let cuts = {};
  const notices = [];
  const env = {
    live: true, openPane: { id: 'r' }, key: 'r',
    setNotice: text => notices.push(text),
    setCuts: update => { cuts = update(cuts); },
    setRoom: update => { room = update(room); },
    applyQuestionEvent, applyCutEvent, applyTurnEvent,
  };
  const applyEvent = new Function('env', `with(env) { ${code}; return applyEvent; }`)(env);
  const recovery = createRoomRecovery({
    load: async () => ({ recovery_seq: 10, active: ['null'] }),
    apply: () => {}, fail: error => { throw error; },
    event: applyEvent, represented: representedRoomEvent,
  });
  recovery.capture({ type: 'journal_warning', error: 'Journal text may still be readable.', recovery_seq: 5 });
  await recovery.refresh();
  assert.deepEqual(notices, ['Journal text may still be readable.']);
  assert.equal(room.working, working);
  assert.equal(room.asks, asks);
  assert.deepEqual(cuts, {});
});
