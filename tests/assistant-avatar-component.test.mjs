import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createAvatarEditor,reduceAvatarEditor,avatarOwnerKey} from '../src/assistantAvatar.ts';
const {transform}=createRequire(import.meta.url)('sucrase');
const code=transform(fs.readFileSync(new URL('../src/AssistantAvatarEditor.tsx',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,''),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)})};
const text=n=>typeof n==='string'?n:n?.children?.map(text).join('')??'';
const find=(n,p)=>n&&typeof n==='object'?(p(n)?n:n.children?.map(c=>find(c,p)).find(Boolean)):undefined;
const button=(n,label)=>find(n,n=>n.type==='button'&&text(n)===label);
const settle=()=>new Promise(r=>setImmediate(r));
function mount(props){
 let cursor=0;const state=[],effects=[],cleanup=[],deps=[];
 const useState=initial=>{const i=cursor++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];};
 const useReducer=(reducer,initial,init)=>{const i=cursor++;if(!(i in state))state[i]=init?init(initial):initial;return[state[i],e=>state[i]=reducer(state[i],e)];};
 const useEffect=(fn,dep)=>{const i=cursor++;if(deps[i]&&dep.every((v,j)=>v===deps[i][j]))return;deps[i]=dep;effects.push(()=>{cleanup[i]?.();cleanup[i]=fn();});};
 const component=new Function('React','useState','useReducer','useEffect','Avatar','createAppearance','avatarOwnerKey','createAvatarEditor','reduceAvatarEditor',`${code};return OwnedEditor;`)(React,useState,useReducer,useEffect,()=>null,()=>({seed:'new'}),avatarOwnerKey,createAvatarEditor,reduceAvatarEditor);
 return {render(){cursor=0;const n=component(props);effects.splice(0).forEach(f=>f());return n;},close(){cleanup.forEach(f=>f?.());}};
}
const owner={kind:'creation',hostId:'host',draftId:'draft'};
const candidate={assetId:'asset',sha256:'hash',mime:'image/png',width:512,height:512};
test('real editor generates a preview, requires Apply and emits immutable creation owner',async()=>{
 const calls=[],applied=[],appearance=[];
 const api={options:async()=>({options:[{providerProfileId:'p',modelId:'image',label:'Provider · image',estimatedCostMicros:null}]}),generate:async input=>{calls.push(input);return {...input,state:'preview',candidate};},asset:async()=>new Blob(['fixture'],{type:'image/png'}),cancel:async()=>{},status:async()=>assert.fail('completed job should not poll')};
 const h=mount({owner,appearance:{seed:'s',color:'#123456'},api,onApply:s=>applied.push(s),onAppearanceChange:s=>appearance.push(s)});
 let tree=h.render();await settle();tree=h.render();button(tree,'AI generate').props.onClick();tree=h.render();assert.match(text(tree),/Cost unknown/);
 find(tree,n=>n.type==='textarea').props.onChange({target:{value:'Blue robot'}});tree=h.render();button(tree,'Generate preview').props.onClick();assert.equal(applied.length,0);await settle();tree=h.render();await settle();tree=h.render();
 assert.equal(applied.length,0);assert.equal(appearance.length,0);assert.equal(button(tree,'Apply avatar').props.disabled,false);
 button(tree,'Apply avatar').props.onClick();assert.deepEqual(applied,[{kind:'image',generationId:calls[0].generationId,assetId:'asset'}]);assert.deepEqual(calls[0].owner,owner);assert.equal(appearance[0].seed,'s');
 h.close();
});
test('pixel tab navigation preserves an image; explicit reset emits pixel',()=>{
 const applied=[],appearance=[];const h=mount({owner,appearance:{seed:'s',color:'#123456',kind:'image',image:candidate},onApply:s=>applied.push(s),onAppearanceChange:s=>appearance.push(s)});
 let tree=h.render();button(tree,'AI generate').props.onClick();tree=h.render();button(tree,'Pixel pattern').props.onClick();tree=h.render();assert.equal(applied.length,0);
 button(tree,'Use pixel pattern').props.onClick();assert.deepEqual(applied,[{kind:'pixel'}]);assert.equal(appearance[0].seed,'s');assert.equal(appearance[0].color,'#123456');assert.equal(appearance[0].image,undefined);h.close();
});
test('Cancel discards an applied unsaved candidate and restores the initial appearance',async()=>{
 const applied=[],looks=[];const original={seed:'s',color:'#123456'};
 const api={options:async()=>({options:[{providerProfileId:'p',modelId:'i',label:'Image',estimatedCostMicros:1}]}),generate:async input=>({...input,state:'preview',candidate}),asset:async()=>new Blob(['fixture']),cancel:async()=>({})};
 const h=mount({owner,appearance:original,api,onApply:s=>applied.push(s),onAppearanceChange:s=>looks.push(s)});
 let tree=h.render();await settle();tree=h.render();button(tree,'AI generate').props.onClick();tree=h.render();find(tree,n=>n.type==='textarea').props.onChange({target:{value:'robot'}});tree=h.render();button(tree,'Generate preview').props.onClick();await settle();tree=h.render();await settle();tree=h.render();button(tree,'Apply avatar').props.onClick();tree=h.render();button(tree,'Cancel').props.onClick();assert.equal(applied.at(-1),undefined);assert.deepEqual(looks.at(-1),original);h.close();
});

test('pixel color controls stay inside the pixel tab and opening AI does not select or generate an avatar',async()=>{
 const applied=[],requests=[];const marker=React.createElement('div',{'data-pixel-controls':true},'Pixel colors');
 const h=mount({owner,appearance:{seed:'s',color:'#123456'},pixelControls:marker,api:{options:async()=>({options:[]}),generate:async input=>requests.push(input)},onApply:value=>applied.push(value),onAppearanceChange(){}});
 let tree=h.render();assert.ok(find(tree,n=>n.props?.['data-pixel-controls']));button(tree,'AI generate').props.onClick();tree=h.render();assert.equal(find(tree,n=>n.props?.['data-pixel-controls']),undefined);assert.ok(find(tree,n=>n.type==='textarea'));assert.equal(requests.length,0);assert.equal(applied.length,0);button(tree,'Pixel pattern').props.onClick();assert.ok(find(h.render(),n=>n.props?.['data-pixel-controls']));h.close();
});
