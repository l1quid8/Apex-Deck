import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantFloatBounds, movedAssistantFloatBounds } from '../desktop/assistantFloatLayout.mjs';
const areas=[{x:0,y:25,width:1440,height:875}];
test('preset changes keep one bottom-right anchor and bound every presentation',()=>{
 const pill=assistantFloatBounds({x:700,y:700,width:298,height:104},'pill',areas);
 const picker=assistantFloatBounds(pill,'threads',areas);
 assert.equal(picker.x+picker.width,pill.x+pill.width);assert.equal(picker.y+picker.height,pill.y+pill.height);
 assert.deepEqual(assistantFloatBounds(picker,'pill',areas),pill);
 const min=assistantFloatBounds(pill,'minimized',areas);assert.equal(min.width,76);assert.equal(min.height,76);
 assert.equal(assistantFloatBounds(pill,'untrusted',areas),null);assert.equal(assistantFloatBounds(pill,'constructor',areas),null);assert.equal(assistantFloatBounds(pill,'__proto__',areas),null);
 const edge=assistantFloatBounds({x:-100,y:-100,width:76,height:76},'chat',areas);
 assert.ok(edge.x>=0&&edge.y>=25&&edge.width<=1440&&edge.height<=875);
});
test('drag deltas are bounded and clamped to a real display',()=>{
 const at={x:700,y:700,width:298,height:104};
 assert.equal(movedAssistantFloatBounds(at,{dx:Infinity,dy:0},areas),null);
 assert.equal(movedAssistantFloatBounds(at,{dx:90000,dy:0},areas),null);
 const next=movedAssistantFloatBounds(at,{dx:1000,dy:1000},areas);
 assert.equal(next.x+next.width,1440);assert.equal(next.y+next.height,900);
});
