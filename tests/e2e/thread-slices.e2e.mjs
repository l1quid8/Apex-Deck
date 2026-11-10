import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceFixture } from './workspace-fixture.mjs';
import { ParticipantQueues } from '../../src/turnQueue.ts';
import { pickLead, namedIn } from '../../src/recipients.ts';

test('a one-send pick posts its mention and keeps the real daemon thread default', {timeout:60_000}, async t => {
  const fixture = await workspaceFixture(t, 'one-send');
  const host = await fixture.host('mac');
  const client = host.client;
  const participants = ['muck','null'].map(id => ({id,display_name:id,backend:{kind:'cli',program:'/bin/echo',args:['done']}}));
  await client.call('room_create', {id:'r',participants,options:{policy:'mention',max_bot_hops:0},cwd:null});
  await client.call('room_post', {id:'r',text:'@muck initial'});
  assert.deepEqual(await client.call('room_targets', {id:'r',text:''}), ['muck']);
  assert.deepEqual(await client.call('post_capabilities', {}), {keep_default_v1:true});
  const queue = new ParticipantQueues(
    text => client.call('room_targets',{id:'r',text}),
    async (text,to,_kind,_hops,_voice,oneOff) => {
      const named = namedIn(text,participants);
      const posted = oneOff ? pickLead(to.filter(id => !named.includes(id)),participants) + text : text;
      await client.call('room_post_to',{id:'r',text:posted,targets:to,...(oneOff ? {keep_default:true} : {})});
    }, async()=>{}, ()=>{},
  );
  await queue.sendOnce('check this', ['null']);
  assert.deepEqual(await client.call('room_targets',{id:'r',text:''}), ['muck']);
  const state = await client.call('room_state',{id:'r'});
  assert.ok(state.snapshot.transcript.some(message => message.speaker.kind === 'human' && message.text === '@null check this'));
});
