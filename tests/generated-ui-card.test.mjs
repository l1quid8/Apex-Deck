import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transform } from 'sucrase';
import { readCard } from '../src/interactiveAnswers/schema.ts';
import { cardKey,fingerprint } from '../src/interactiveAnswers/contract.ts';
import { GeneratedRun,latestCardVersion } from '../src/interactiveAnswers/generatedRun.ts';
const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)})};
const src=fs.readFileSync(new URL('../src/interactiveAnswers/GeneratedAnswerCard.tsx',import.meta.url),'utf8');
const code=transform(src.replace(/^import .*;\n/gm,'').replace(/^export /gm,''),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const mockWindow={apexDeck:{generatedUI:{}}};
let renderedState;
const {GeneratedAnswerCard}=new Function('React','useState','useRef','useEffect','useLayoutEffect','GeneratedRun','latestCardVersion','window',code+'\nreturn {GeneratedAnswerCard};')(React,x=>[renderedState??x,()=>{}],x=>({current:x}),()=>{},()=>{},GeneratedRun,latestCardVersion,mockWindow);
const card={schemaVersion:1,kind:'generated',cardId:'flow',title:'<h1>Flow</h1>',summary:'**Literal summary**',fallback:'<script>never()</script>',html:'<div>code secret</div>',css:'',js:'dangerous()'};
const props={card,source:JSON.stringify(card),version:1,author:'Null',identity:{threadId:'t',seq:1,cardId:'flow',hostId:'local'},historical:false,readOnly:false};
function walk(node,fn){if(!node||typeof node!=='object')return;fn(node);for(const c of node.children??[])walk(c,fn);}
function text(node){return node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.children??node).map(text).join('');}
test('generated fallback is literal trusted text and never an iframe or innerHTML in chat',()=>{
 const tree=GeneratedAnswerCard(props);assert.match(text(tree),/\*\*Literal summary\*\*/);assert.match(text(tree),/<script>never\(\)<\/script>/);assert.doesNotMatch(text(tree),/code secret|dangerous/);
 walk(tree,n=>{assert.notEqual(n.type,'iframe');assert.equal(n.props.dangerouslySetInnerHTML,undefined);});
});
test('automatic interfaces do not ask the user for an initial Run click',()=>{
 try {
  for(const enabled of [false,true]){
   renderedState={enabled,phase:'idle',reason:'',height:300,discuss:'',attempted:false};
   let buttons=0;walk(GeneratedAnswerCard(props),n=>{if(n.type==='button')buttons++;});assert.equal(buttons,0);
  }
 }finally{renderedState=undefined;}
});
test('a running card exposes Stop and a stopped card exposes Restart',()=>{
 try {
  for(const [phase,label] of [['running','Stop'],['idle','Restart']]){
   renderedState={enabled:true,phase,reason:'',height:300,discuss:'',attempted:true};
   const buttons=[];walk(GeneratedAnswerCard(props),n=>{if(n.type==='button')buttons.push(text(n));});
   assert.deepEqual(buttons,[label]);
  }
 }finally{renderedState=undefined;}
});
test('chat revokes generated execution whenever its host is disconnected or its room is not ready',()=>{
 const chat=fs.readFileSync(new URL('../src/ChatPane.tsx',import.meta.url),'utf8');
 const expression=chat.match(/executionAllowed=\{([^}]+)\}/)[1];
 const allowed=new Function('focused','ready',`return (${expression});`);
 assert.equal(allowed(true,true),true);
 assert.equal(allowed(true,false),false);
 assert.equal(allowed(false,true),false);
});
test('Retry and Revert invalidate a generated run before an asynchronous history mutation starts',()=>{
 const chat=fs.readFileSync(new URL('../src/ChatPane.tsx',import.meta.url),'utf8');
 const fn=chat.slice(chat.indexOf('  const runGoBack ='),chat.indexOf('  const answerGoBack ='));
 const body=transform(fn,{transforms:['typescript']}).code;
 const calls=[];
 const run=new Function('setGoingBack','goBackRequest','backend','pane','setGoneBack',body+'\nreturn runGoBack;')(()=>{},()=>({chat:true,files:[]}),{roomRevert(){calls.push('revert');return new Promise(()=>{});}},{id:'thread'},()=>calls.push('invalidate'));
 run('revert',{seq:1,speaker:{kind:'human'}},{},'both',[]);
 assert.deepEqual(calls,['invalidate','revert']);
});
test('phone/browser read-only and historical revisions have no Run controls',()=>{
 for(const patch of [{readOnly:true},{historical:true},{executionAllowed:false}]){let buttons=0;walk(GeneratedAnswerCard({...props,...patch}),n=>{if(n.type==='button')buttons++;});assert.equal(buttons,0);}
});

const threadSource=fs.readFileSync(new URL('../src/interactiveAnswers/ThreadCard.tsx',import.meta.url),'utf8');
const threadCode=transform(threadSource.replace(/^import .*;\n/gm,'').replace(/^export /gm,''),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const {ThreadCard}=new Function('React','Component','useEffect','useMemo','useState','AnswerCard','CardFallback','cardKey','fingerprint','readCard','GeneratedAnswerCard','latestCardVersion',threadCode+'\nreturn {ThreadCard};')(React,class{},f=>f(),f=>f(),x=>[x,()=>{}],()=>{},()=>{},cardKey,fingerprint,readCard,GeneratedAnswerCard,latestCardVersion);
test('generated ThreadCard never subscribes, reads or writes comparison settings',()=>{
 const answers=new Proxy({}, {get(){throw Error('comparison settings read');}});
 const shown=ThreadCard({source:JSON.stringify(card),seq:1,author:'Null',versions:new Map([['1:flow',1],['9:flow',2]]),answers,onOpen(){},threadId:'thread-a',hostId:'server'});
 assert.equal(shown.type,GeneratedAnswerCard);assert.equal(shown.props.historical,true);
 assert.deepEqual(shown.props.identity,{threadId:'thread-a',seq:1,cardId:'flow',hostId:'server'});
});
test('ThreadCard passes automatic opening only to the latest generated message/card',()=>{
 const base={source:JSON.stringify(card),seq:1,author:'Null',versions:new Map([['1:flow',1]]),answers:null,onOpen(){},threadId:'t'};
 assert.equal(ThreadCard({...base,autoStartKey:'1:flow'}).props.autoStart,true);
 assert.equal(ThreadCard({...base,autoStartKey:'9:other'}).props.autoStart,false);
});

test('a reconnect, Retry or Revert, or a new folder remounts a generated card, so its run stops',()=>{
 const shown=executionEpoch=>ThreadCard({source:JSON.stringify(card),seq:1,author:'Null',versions:new Map([['1:flow',1]]),answers:null,onOpen(){},threadId:'thread-a',hostId:'local',executionEpoch}).props.key;
 const keys=['1:0:/a','2:0:/a','1:1:/a','1:0:/b'].map(shown);
 assert.equal(new Set(keys).size,keys.length);
 assert.equal(shown('1:0:/a'),keys[0]);
});

test('browser without the generated desktop bridge is text-only even when ChatPane readOnly is false',()=>{
 const saved=mockWindow.apexDeck;delete mockWindow.apexDeck;
 try{let buttons=0,slots=0;walk(GeneratedAnswerCard(props),n=>{if(n.type==='button')buttons++;if(n.props.className==='generated-slot')slots++;});assert.equal(buttons,0);assert.equal(slots,0);}finally{mockWindow.apexDeck=saved;}
});
const geometrySource=src.slice(src.indexOf('export function visibleGeneratedBounds'),src.indexOf('/** Code is never'));
const geometryCode=transform(geometrySource.replace(/^export /gm,''),{transforms:['typescript']}).code;
test('a trusted menu anywhere on screen prevents a native generated view from covering it',()=>{
 const rect={left:20,top:80,right:520,bottom:380,width:500,height:300};
 const slot={isConnected:true,parentElement:null,getBoundingClientRect:()=>rect,contains:n=>n===slot};
 let overlay=[];
 const document={visibilityState:'visible',elementFromPoint:()=>slot,querySelectorAll:selector=>{assert.match(selector,/role=menu/);return overlay;}};
 const bounds=new Function('document','getComputedStyle','innerWidth','innerHeight',geometryCode+'\nreturn visibleGeneratedBounds;')(document,()=>({visibility:'visible'}),1000,800);
 assert.deepEqual(bounds(slot),{x:20,y:80,width:500,height:300});
 overlay=[{getClientRects:()=>[{left:75,top:160,width:20,height:20}]}];assert.equal(bounds(slot),null);
 document.visibilityState='hidden';overlay=[];assert.equal(bounds(slot),null);
});

test('a small ApexAgent overlay between sample points hides only an intersecting native card',()=>{
 const rect={left:20,top:80,right:520,bottom:380,width:500,height:300};
 const slot={isConnected:true,parentElement:null,getBoundingClientRect:()=>rect,contains:n=>n===slot};
 let overlayRect={left:75,top:160,right:95,bottom:180,width:20,height:20};
 const overlay={hasAttribute:name=>name==='data-apex-agent-overlay',getClientRects:()=>[overlayRect],getBoundingClientRect:()=>overlayRect};
 const document={visibilityState:'visible',elementFromPoint:()=>slot,querySelectorAll:selector=>selector.includes('data-apex-agent-overlay')?[overlay]:[]};
 const bounds=new Function('document','getComputedStyle','innerWidth','innerHeight',geometryCode+'\nreturn visibleGeneratedBounds;')(document,()=>({visibility:'visible',display:'block',opacity:'1'}),1000,800);
 assert.equal(bounds(slot),null);
 overlayRect={left:800,top:160,right:820,bottom:180,width:20,height:20};
 assert.deepEqual(bounds(slot),{x:20,y:80,width:500,height:300});
});

test('a rejected generated card hides raw code in desktop and phone fallbacks',()=>{
 const invalid={...card, extra:'nope'};
 const shown=ThreadCard({source:JSON.stringify(invalid),seq:1,author:'Null',versions:new Map(),answers:null,readOnly:true,onOpen(){}});
 assert.equal(shown.props.hideSource,true);
});

test('partially clipped cards use the visible scrollable viewport instead of refusing to open',()=>{
 let rect={left:20,top:80,right:520,bottom:680,width:500,height:600};
 const parent={parentElement:null,getBoundingClientRect:()=>({left:0,top:120,right:700,bottom:500})};
 const slot={isConnected:true,parentElement:parent,getBoundingClientRect:()=>rect,contains:n=>n===slot};
 const document={visibilityState:'visible',elementFromPoint:()=>slot,querySelectorAll:()=>[]};
 const bounds=new Function('document','getComputedStyle','innerWidth','innerHeight',geometryCode+'\nreturn visibleGeneratedBounds;')(document,()=>({visibility:'visible',display:'block',opacity:'1',overflowY:'auto',overflowX:'hidden'}),1000,800);
 assert.deepEqual(bounds(slot),{x:20,y:120,width:500,height:380});
 rect={left:20,top:-100,right:520,bottom:400,width:500,height:500};
 assert.deepEqual(bounds(slot),{x:20,y:120,width:500,height:280});
 rect={left:20,top:450,right:520,bottom:750,width:500,height:300};
 assert.equal(bounds(slot),null,'less than the minimum usable height must stay hidden');
});

test('scrolling a running card updates its visible bounds without stopping it',()=>{
 const effects=[],listeners=new Map(),calls=[];
 const slot={isConnected:true,parentElement:null,getBoundingClientRect:()=>({left:20,top:80,right:520,bottom:380}),contains:n=>n===slot};
 const document={visibilityState:'visible',body:{},elementFromPoint:()=>slot,querySelectorAll:()=>[],addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener(){}};
 const window={apexDeck:{generatedUI:{}},addEventListener(){},removeEventListener(){},setInterval:()=>0};
 class Run {
  state={phase:'running'};
  checkCapability(){}
  place(bounds){calls.push(bounds);}
 }
 let ref=0;
 const component=new Function('React','useState','useRef','useEffect','GeneratedRun','window','document','getComputedStyle','innerWidth','innerHeight','MutationObserver',code+'\nreturn GeneratedAnswerCard;')(
  React,x=>[x,()=>{}],x=>({current:ref++===1?slot:x}),fn=>effects.push(fn),Run,window,document,()=>({visibility:'visible'}),1000,800,class{observe(){} disconnect(){}});
 component(props);effects.forEach(fn=>fn());
 listeners.get('scroll')();
 assert.deepEqual(calls,[{x:20,y:80,width:500,height:300}]);
});
