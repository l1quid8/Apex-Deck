import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantNavigation, runtimeProfile, validateAssistantDraft, textModels, reconcileEffort, rosterMessage } from '../src/assistantWorkspaceModel.ts';
const a={hostId:'mac',assistantId:'a'},b={hostId:'mac',assistantId:'b'};
test('assistant navigation and Back retain owner and never mutate global panel state',()=>{
 const panel={open:true,active:'dashboard'};const state={mainView:{kind:'workspace'},panel};
 const selected=assistantNavigation(state,{kind:'open',assistant:a});assert.deepEqual(selected.panel,panel);
 const settings=assistantNavigation(selected,{kind:'section',section:'settings'});assert.deepEqual(settings.mainView,{kind:'assistant',assistant:a,section:'settings'});
 assert.deepEqual(assistantNavigation(settings,{kind:'back'}).mainView,{kind:'assistant',assistant:a,section:'conversation'});
 assert.deepEqual(assistantNavigation(settings,{kind:'open',assistant:b}).mainView.assistant,b);
});
test('runtime preserves legacy metadata and access while selecting offered model and effort',()=>{
 const p={id:'legacy',display_name:'Old',persona:'Legacy worker metadata',backend:{kind:'agent',tool:'codex',model:'old'},access:'ask',effort:'high',custom:'untouched'};
 const result=runtimeProfile(p,'New','new','full','low');assert.equal(result.persona,p.persona);assert.equal(result.custom,'untouched');assert.equal(result.access,'full');assert.equal(result.backend.model,'new');assert.equal(p.backend.model,'old');
 assert.deepEqual(textModels([{id:'text'},{id:'image',kind:'image'},{id:'video',kind:'video'}]).map(m=>m.id),['text']);
 assert.equal(reconcileEffort('high',{id:'new',efforts:['low']}), 'low');assert.equal(reconcileEffort('high',{id:'unknown'}),null);assert.equal(reconcileEffort('high',{id:'none',efforts:[]}),null);
});
test('invalid name, runtime or hex blocks save with concrete reason',()=>{
 const valid={name:'Null',color:'#aabbcc',profile:{backend:{kind:'agent',tool:'codex',model:'gpt'},access:'full'},model:{id:'gpt',efforts:['low']},effort:'low',providerReady:true};
 assert.equal(validateAssistantDraft(valid),null);assert.match(validateAssistantDraft({...valid,name:'x'.repeat(65)}),/64/);assert.equal(validateAssistantDraft({...valid,name:'😀'.repeat(64)}),null);assert.match(validateAssistantDraft({...valid,name:' '}),/name/i);assert.match(validateAssistantDraft({...valid,color:'#zzzzzz'}),/six/i);assert.match(validateAssistantDraft({...valid,providerReady:false}),/provider/i);assert.match(validateAssistantDraft({...valid,effort:'max'}),/reasoning/i);
});
test('roster empty, offline and errors have honest states',()=>{
 assert.match(rosterMessage([],[]),/No assistants/);assert.match(rosterMessage([],[{state:'error',problem:'Credentials unavailable'}]),/Credentials unavailable/);assert.match(rosterMessage([],[{state:'offline'}]),/offline/i);assert.equal(rosterMessage([{name:'Null'}],[]),null);
});
