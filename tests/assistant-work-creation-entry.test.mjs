import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');

test('Work header creation always establishes Work as the proposal Back destination',()=>{
 const callback=source.match(/onNewTask=\{([\s\S]*?)\} newTaskDisabledReason=/)?.[1];assert.ok(callback,'real Work header creation callback');
 for(const initialOrigin of ['chat','work']){
  let origin=initialOrigin,request=Date.now();const previous=request;
  const create=new Function('setWorkDetailOrigin','setWorkNewTaskRequest',`return (${callback});`)(value=>{origin=value;},update=>{request=update(request);});
  create();assert.equal(origin,'work','a new Work plan cannot inherit an earlier Chat origin');assert.ok(request>previous);
 }
});

test('changing assistant clears the previous assistant task origin and presentation',()=>{
 const body=source.match(/useEffect\(\(\)=>\{([^}]*)\},\[workFocusOwner\]\)/)?.[1];assert.ok(body,'real assistant owner-change effect');
 const state={origin:'chat',focus:{},chat:{},detail:true,projects:true,browser:'popup'};
 new Function('setWorkFocus','setChatFocus','setWorkDetail','setWorkProjectsOpen','setAssistantBrowser','setWorkDetailOrigin',body)(value=>state.focus=value,value=>state.chat=value,value=>state.detail=value,value=>state.projects=value,value=>state.browser=value,value=>state.origin=value);
 assert.deepEqual(state,{origin:'work',focus:null,chat:null,detail:false,projects:false,browser:'closed'});
});
