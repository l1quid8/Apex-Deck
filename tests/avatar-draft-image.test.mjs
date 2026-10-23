import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {avatarOwnerKey} from '../src/assistantAvatar.ts';
const {transform}=createRequire(import.meta.url)('sucrase');
const source=fs.readFileSync(new URL('../src/Avatar.tsx',import.meta.url),'utf8');
const compiled=transform(source.replace(/^import .*;\n/gm,'').replace(/^export /gm,''),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
function mount(api){
 const states=[],deps=[],effects=[],cleanups=[],revoked=[];let cursor=0,counter=0;
 const useState=initial=>{const i=cursor++;if(!(i in states))states[i]=initial;return[states[i],v=>states[i]=v];};
 const useEffect=(fn,next)=>{const i=cursor++;if(!deps[i]||next.some((v,j)=>v!==deps[i][j])){deps[i]=next;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}};
 const hook=new Function('useState','useEffect','avatarOwnerKey','REFILL_STAGGER_MS','URL',`${compiled}\nreturn useAvatarImage;`)(useState,useEffect,avatarOwnerKey,0,{createObjectURL:()=>`blob:${++counter}`,revokeObjectURL:url=>revoked.push(url)});
 return{revoked,render(assistant,image,draft){cursor=0;const result=hook(assistant,image,api,draft);effects.splice(0).forEach(fn=>fn());return result;},unmount(){cleanups.forEach(fn=>fn?.());}};
}
const image={assetId:'asset',sha256:'hash',mime:'image/png',width:512,height:512};
const tick=()=>new Promise(r=>setImmediate(r));
test('applied image loads from its creation draft and never reuses another draft URL',async()=>{
 const inputs=[];let complete;const h=mount({asset:input=>{inputs.push(input);return new Promise(r=>{complete=r;});}});
 const first={owner:{kind:'creation',hostId:'mac',draftId:'first'},generationId:'generation'};
 assert.equal(h.render(undefined,image,first),undefined);assert.deepEqual(inputs[0],{owner:first.owner,generationId:'generation',assetId:'asset',sha256:'hash'});complete(new Blob());await tick();assert.equal(h.render(undefined,image,first),'blob:1');
 const second={owner:{kind:'creation',hostId:'mac',draftId:'second'},generationId:'generation'};
 assert.equal(h.render(undefined,image,second),undefined);assert.deepEqual(h.revoked,['blob:1']);h.unmount();complete(new Blob());await tick();assert.deepEqual(h.revoked,['blob:1']);
});
test('saved avatar uses authenticated assistant asset route while switching host keeps pixel fallback',async()=>{
 const inputs=[];const h=mount({asset:async input=>{inputs.push(input);return new Blob();}});const a={hostId:'a',assistantId:'same'};
 assert.equal(h.render(a,image),undefined);await tick();assert.equal(h.render(a,image),'blob:1');assert.deepEqual(inputs[0],{assistantId:'same',assetId:'asset',sha256:'hash'});
 assert.equal(h.render({...a,hostId:'b'},image),undefined);assert.deepEqual(h.revoked,['blob:1']);h.unmount();
});
