import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveCallCommand} from '../src/voice/routing.ts';
const a = {hostId:'h',roomId:'r',participantId:'j',name:'Jigga',aliases:['jiga']};
test('only leading commands route, retaining remaining words',()=>{
 assert.deepEqual(resolveCallCommand('call jiga check the build',[a]),{kind:'switch',candidate:a,text:'check the build'});
 assert.equal(resolveCallCommand("I'll call Jigga later",[a]).kind,'text');
 assert.equal(resolveCallCommand('stop listening',[a]).kind,'end');
 assert.equal(resolveCallCommand('stop listening to that',[a]).kind,'text');
});
test('ambiguous aliases require a choice and unknown calls cannot dispatch',()=>{
 assert.equal(resolveCallCommand('call Jigga',[a,{...a,participantId:'b'}]).kind,'ambiguous');
 assert.equal(resolveCallCommand('call Unknown',[a]).kind,'unknown');
});
