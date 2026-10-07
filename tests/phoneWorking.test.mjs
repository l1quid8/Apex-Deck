import test from 'node:test';
import assert from 'node:assert/strict';
import { CUT_GAP, applyCutEvent, applyTurnEvent, busyAfter, cutLine, cutOff, endedLine, resumeCut, turnWords, workingFrom } from '../src/phoneWorking.ts';

const bot = (id, text = 'done') => ({ type: 'message_added', message: { seq: 1, speaker: { kind: 'bot', id }, text } });

test('a bot shows as working from turn start, with its reply filling in, until the reply lands', () => {
  let w = applyTurnEvent({}, { type: 'turn_started', id: 'null' }, 100);
  assert.deepEqual(w.null, { startedAt: 100, phase: 'thinking', step: '', text: '' });
  w = applyTurnEvent(w, { type: 'activity', id: 'null', text: 'Reading PhoneApp.tsx' }, 200);
  assert.equal(turnWords(w.null, false, false), 'Reading PhoneApp.tsx');
  w = applyTurnEvent(w, { type: 'delta', id: 'null', text: 'Hel' }, 300);
  w = applyTurnEvent(w, { type: 'delta', id: 'null', text: 'lo' }, 400);
  assert.equal(w.null.text, 'Hello');
  assert.equal(turnWords(w.null, false, false), 'Writing');
  w = applyTurnEvent(w, bot('null'), 500);
  assert.deepEqual(w, {});
});

test('two bots stay separate, and each clears on its own ending', () => {
  let w = applyTurnEvent({}, { type: 'turn_started', id: 'null' }, 1);
  w = applyTurnEvent(w, { type: 'turn_started', id: 'jigga' }, 2);
  w = applyTurnEvent(w, { type: 'delta', id: 'jigga', text: 'Hi' }, 3);
  assert.equal(w.null.text, '');
  w = applyTurnEvent(w, { type: 'failed', id: 'null', error: 'boom' }, 4);
  assert.deepEqual(Object.keys(w), ['jigga']);
  w = applyTurnEvent(w, { type: 'passed', id: 'jigga' }, 5);
  assert.deepEqual(w, {});
});

test('a human message leaves bots working; stopped and idle clear everyone', () => {
  const w = workingFrom(['null', 'jigga'], 9);
  const human = { type: 'message_added', message: { seq: 2, speaker: { kind: 'human' }, text: 'hi' } };
  assert.equal(applyTurnEvent(w, human, 10), w);
  assert.deepEqual(applyTurnEvent(w, { type: 'stopped' }, 10), {});
  assert.deepEqual(applyTurnEvent(w, { type: 'idle' }, 10), {});
  const none = {};
  assert.equal(applyTurnEvent(none, { type: 'idle' }, 10), none);
});

test('waiting on an approval and Plan read differently from thinking', () => {
  const turn = { startedAt: 0, phase: 'tool', step: 'Waiting for approval: rm -rf', text: '' };
  assert.equal(turnWords(turn, true, false), 'Waiting for you');
  assert.equal(turnWords(turn, false, false), 'Working');
  assert.equal(turnWords({ ...turn, phase: 'thinking' }, false, true), 'Planning');
});

test('the interrupted line names who was cut off and which machine', () => {
  assert.equal(cutLine(['Null'], 'Apex-Terminal'), 'Lost Apex-Terminal while Null was working. The reply shows here once Apex-Terminal is back.');
  assert.match(cutLine(['Null', 'Jigga'], 'Mac'), /Null and Jigga were working/);
});

test('the thread list only changes when a turn starts or ends, not per streamed word', () => {
  const ids = busyAfter([], { type: 'turn_started', id: 'null' });
  assert.deepEqual(ids, ['null']);
  assert.equal(busyAfter(ids, { type: 'delta', id: 'null', text: 'x' }), ids);
  assert.deepEqual(busyAfter(['jigga'], { type: 'delta', id: 'null', text: 'x' }), ['jigga', 'null']);
  assert.deepEqual(busyAfter(ids, bot('null')), []);
  assert.deepEqual(busyAfter(['a', 'b'], { type: 'idle' }), []);
});

test('a reply cut off by a drop survives the reload, and goes only when that bot\'s reply lands', () => {
  const said = (seq, id) => ({ seq, speaker: { kind: 'bot', id } });
  let cut = cutOff({}, { null: { startedAt: 1, phase: 'writing', step: '', text: 'Half a reply' } }, 4);
  assert.deepEqual(cut, { null: { text: 'Half a reply', after: 4 } });
  // A second drop before anything new was written keeps the first text.
  cut = cutOff(cut, { null: { startedAt: 2, phase: 'thinking', step: '', text: '' } }, 4);
  assert.equal(cut.null.text, 'Half a reply');
  // Back online, still working: the text stays above the live turn. An older reply by it doesn't count.
  const back = resumeCut(cut, ['null'], [said(3, 'null')]);
  assert.deepEqual(back, { null: { text: 'Half a reply', after: 4, ended: false } });
  assert.equal(applyCutEvent(back, { type: 'delta', id: 'null', text: 'x' }), back);
  assert.deepEqual(applyCutEvent(back, bot('jigga')), back);
  assert.deepEqual(applyCutEvent(back, bot('null')), {});
  // The reply landed while the phone was away: gone on reload.
  assert.deepEqual(resumeCut(cut, [], [said(5, 'null')]), {});
  // It ended with no reply: kept, marked ended.
  assert.equal(resumeCut(cut, [], []).null.ended, true);
  assert.equal(applyCutEvent(back, { type: 'stopped' }).null.ended, true);
  assert.equal(endedLine(['Null']), 'Null stopped before finishing this reply.');
});

test('a second drop in the same turn keeps both parts of the reply', () => {
  const writing = (text) => ({ null: { startedAt: 1, phase: 'writing', step: '', text } });
  let cut = cutOff({}, writing('I checked the composer'), 4);
  cut = resumeCut(cut, ['null'], []);
  cut = cutOff(cut, writing('runs.'), 6);
  assert.deepEqual(cut, { null: { text: `I checked the composer${CUT_GAP}runs.`, after: 4 } });
  // A third drop with nothing new written changes nothing.
  assert.equal(cutOff(cut, writing(''), 7).null.text, cut.null.text);
  // A turn that already ended doesn't get the next turn's text glued on.
  const ended = { null: { text: 'Old turn', after: 4, ended: true } };
  assert.deepEqual(cutOff(ended, writing('New turn'), 8), { null: { text: 'New turn', after: 8 } });
});
