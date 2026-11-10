import test from 'node:test';
import assert from 'node:assert/strict';
import { dockTarget } from '../src/composerTarget.ts';
test('dock target follows focus, recent available threads, then first candidate', () => {
 const base = {focused:'a',recent:['b','a'],candidates:['a','b','c'],popped:new Set()};
 assert.equal(dockTarget(base),'a');
 assert.equal(dockTarget({...base,focused:'preview'}),'b');
 assert.equal(dockTarget({...base,focused:'preview',popped:new Set(['b'])}),'a');
 assert.equal(dockTarget({...base,focused:null,recent:[]}),'a');
 assert.equal(dockTarget({...base,candidates:[]} ),null);
 assert.equal(dockTarget({...base,popped:new Set(['a','b','c'])}),null);
});
