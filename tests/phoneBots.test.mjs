import test from 'node:test';
import assert from 'node:assert/strict';
import { botChangeGate, botSendGate } from '../src/phoneBots.ts';
test('bot changes require full access and idle removals, including last bot', () => {
  assert.equal(botChangeGate(true, false, false), '');
  assert.match(botChangeGate(false, false, false), /Full access/);
  assert.match(botChangeGate(true, true, false), /Stop/);
  assert.match(botChangeGate(true, false, true), /Saving/);
});
test('send is disabled for an empty crew without losing machine refusal', () => {
  assert.deepEqual(botSendGate({enabled:true,reason:''}, 0), {enabled:false,reason:'No bots yet. Add a bot to send a message.'});
  assert.deepEqual(botSendGate({enabled:false,reason:'Offline'}, 0), {enabled:false,reason:'Offline'});
  assert.equal(botSendGate({enabled:true,reason:''}, 1).enabled, true);
});
