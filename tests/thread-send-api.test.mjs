import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerRefusal, leaveRefusal } from '../src/threadSendApi.ts';
test('ownership refuses external move and in-flight move popout',()=>{assert.equal(ownerRefusal('move','Thread',{outside:true,moving:false}),"Close Thread's external pane to return it to Deck first.");assert.equal(ownerRefusal('pop out','Thread',{outside:false,moving:true}),'Wait until Thread has moved, then open it in a new window.');assert.equal(ownerRefusal('move','Thread',{outside:false,moving:false}),null);});
test('leaving waits for every unfinished item',()=>{assert.equal(leaveRefusal({unsent:()=>1},'Thread','move it'),"Wait until Thread has sent what's waiting, or remove it, then move it.");assert.equal(leaveRefusal({unsent:()=>0},'Thread','pop it out'),null);assert.equal(leaveRefusal(undefined,'Thread','move it'),null);});
