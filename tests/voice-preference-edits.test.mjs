import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {registerVoiceThread,voiceRegistration,scopeKey,unregisterVoiceThread} from '../src/voice/coordinator.ts';
import {readVoiceSettings,withChatPreference,chatVoice,preferenceFor,voiceFor,CALL_ENGINES,DEFAULT_REALTIME_MODEL,DEFAULT_REALTIME_VOICE,REALTIME_MODELS,REALTIME_VOICES,readRealtimeModel,readRealtimeVoice,realtimeVoiceLabel} from '../src/voice/settings.ts';
import {CALL_LOOKS,callClock,callLine,pickNote,pickRows,readCallLook,voiceLabel} from '../src/voice/callView.ts';
const {transform}=createRequire(import.meta.url)('sucrase');
const code=transform(fs.readFileSync(new URL('../src/voice/VoiceCallControls.tsx',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,''),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)})};
const text=node=>typeof node==='string'?node:node?.children?.map(text).join('')??'';
const find=(node,predicate)=>node&&typeof node==='object'?(predicate(node)?node:node.children?.map(child=>find(child,predicate)).find(Boolean)):undefined;
const scope={hostId:'preference-host',roomId:'chat',participantId:'agent'};
const candidate={...scope,profileId:'profile',name:'Helper',aliases:[]};
function harness(){
 let cursor=0;const states=[],effects=[];
 const useState=initial=>{const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],next=>states[i]=typeof next==='function'?next(states[i]):next];};
 const useRef=initial=>{const i=cursor++;return states[i]??(states[i]={current:initial});};
 const useEffect=(effect)=>{cursor++;effects.push(effect);};
 const bindings={React,useState,useRef,useEffect,useLayoutEffect(){},useSyncExternalStore(){},voiceController:{subscribe(){return()=>{};}},voiceRegistration,warmVoice(){},callEngine:()=>'local',CALL_ENGINES,DEFAULT_REALTIME_MODEL,DEFAULT_REALTIME_VOICE,REALTIME_MODELS,REALTIME_VOICES,readRealtimeModel,readRealtimeVoice,realtimeVoiceLabel,chatVoice,preferenceFor,voiceFor,withChatPreference,CALL_LOOKS,callClock,callLine,pickNote,pickRows,readCallLook,voiceLabel,Avatar(){},popoverTop(){},createPortal:node=>node};
 const components=new Function(...Object.keys(bindings),`${code};return {CallSettings,NicknameInput:typeof NicknameInput==='undefined'?null:NicknameInput};`)(...Object.values(bindings));
 return {render(){cursor=0;let tree=components.CallSettings({call:{scope,candidate,state:{voices:['am_michael','af_heart']},name:'Helper'},candidates:[candidate],onPickLook(){}});if(components.NicknameInput){const node=find(tree,node=>node.type===components.NicknameInput);if(node){const rendered=components.NicknameInput(node.props);Object.assign(node,rendered);}}effects.splice(0).forEach(effect=>effect());return tree;}};
}
test('consecutive call setting edits retain nickname text and preceding edits before registration effects run',()=>{
 const saved=[],initial=readVoiceSettings({enabled:true,preferences:{other:{voice:'af_heart',aliases:['Other']}}});
 registerVoiceThread(scopeKey(scope),{candidates:[candidate],settings:initial,save:settings=>saved.push(settings),focus(){},bridge(){}});
 try{const h=harness();let tree=h.render();let nickname=find(tree,node=>node.type==='input'&&node.props.type==='text');nickname.props.onFocus?.();
 for(const value of ['Q','QA','QA ','QA h','QA he','QA hel','QA help','QA helpe','QA helper']){nickname=find(h.render(),node=>node.type==='input'&&node.props.type==='text');nickname.props.onChange({target:{value}});assert.equal(find(h.render(),node=>node.type==='input'&&node.props.type==='text').props.value,value);}
 tree=h.render();find(tree,node=>node.type==='input'&&node.props.type==='range').props.onChange({target:{valueAsNumber:600}});tree=h.render();find(tree,node=>node.type==='button'&&text(node)==='Bar').props.onClick();
 const final=saved.at(-1);assert.equal(final.silenceMs,600);assert.equal(final.look,'bar');assert.deepEqual(final.preferences[JSON.stringify(['preference-host','profile','chat','agent'])].aliases,['QA helper']);assert.deepEqual(final.preferences.other,{voice:'af_heart',aliases:['Other']});
 }finally{unregisterVoiceThread(scopeKey(scope));}
});
test('a voice settings save immediately reaches other open thread registrations before their effects refresh',()=>{
 const other={...scope,roomId:'other-chat'},initial=readVoiceSettings({enabled:true}),saved=[];
 const registration={candidates:[candidate],settings:initial,save:settings=>saved.push(settings),focus(){},bridge(){}};
 registerVoiceThread(scopeKey(scope),registration);registerVoiceThread(scopeKey(other),registration);
 try{const a=voiceRegistration(scope);a.save(withChatPreference(a.settings,scope.hostId,'profile',scope.roomId,scope.participantId,{voice:'af_heart'}));const b=voiceRegistration(other);b.save(withChatPreference(b.settings,other.hostId,'profile',other.roomId,other.participantId,{aliases:['Friend']}));assert.equal(Object.keys(saved.at(-1).preferences).length,2);}finally{unregisterVoiceThread(scopeKey(scope));unregisterVoiceThread(scopeKey(other));}
});
