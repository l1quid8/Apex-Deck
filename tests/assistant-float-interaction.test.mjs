import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../src/assistantFloat.ts';

test('drag click guard never leaves a minimized avatar stuck after a drag without click',()=>{
  assert.equal(typeof model.createAssistantFloatDragGuard,'function');
  let now=1000;const guard=model.createAssistantFloatDragGuard(()=>now);
  guard.pointerDown();guard.dragged();
  // Native window drag may finish without producing any DOM click.
  guard.pointerDown();assert.equal(guard.consumeClick(1),false,'fresh pointer gesture restores normally');
  guard.dragged();assert.equal(guard.consumeClick(0),false,'keyboard activation is never discarded');
  guard.dragged();now+=501;assert.equal(guard.consumeClick(1),false,'a missing click cannot poison a later activation');
  guard.dragged();assert.equal(guard.consumeClick(1),true,'the immediate click emitted by a drag is discarded once');
  assert.equal(guard.consumeClick(1),false);
});

test('float actions accept only bounded presentations and thread identity changes',()=>{
  assert.equal(model.validFloatAction({type:'assistant-present',presentation:'minimized'}),true);
  assert.equal(model.validFloatAction({type:'assistant-present',presentation:'custom',width:9000}),false);
  assert.equal(model.validFloatAction({type:'assistant-follow',threadIds:['a','b']}),true);
  assert.equal(model.validFloatAction({type:'assistant-follow',threadIds:['a','a']}),false);
  assert.equal(model.validFloatAction({type:'assistant-active-thread',threadId:'a'}),true);
  assert.equal(model.validFloatAction({type:'assistant-active-thread',threadId:''}),false);
  assert.equal(model.validFloatAction({type:'assistant-hide'}),true);
});

test('pin action accepts boolean choices only',()=>{assert.equal(model.validFloatAction({type:'assistant-pin',on:true}),true);assert.equal(model.validFloatAction({type:'assistant-pin',on:false}),true);for(const on of [undefined,'true',1,null])assert.equal(model.validFloatAction({type:'assistant-pin',on}),false)});
