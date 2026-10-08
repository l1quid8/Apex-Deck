import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadMod} from '../../src/mods/runtime.ts';
import {parseFeed,totals} from '../hooks/feed.ts';
const report=new URL('../../scripts/decision-report.py',import.meta.url).pathname;
const row={at_ms:1000000,room:'room',message_index:0,choices:{bot_0:['null'],nobody:[]},deck_targets:['null'],suggested_targets:['null'],result:{choice:'bot_0',probabilities:{bot_0:.8},latency_ms:1000,usage:{cost:.001}}};
const fixture=[row,{...row,suggested_targets:[],result:{...row.result,choice:'nobody',latency_ms:2000,usage:{cost:.002}}},{...row,stale:true},{...row,result:undefined,error:'provider failed'},{kind:'thinking',room:'room',message_index:0,at_ms:1000000,agent:'null',backup:'ultra',auto:true,observe_only:true,thinking:{choice:'high',probabilities:{high:.87}},usage:{cost:.01}},{kind:'thinking',stale:true,error:'thinking-only failure'}].map(r=>JSON.stringify(r)).join('\n')+'\nmalformed\n';
function compare(text,file){const t=totals(parseFeed(text));const output=execFileSync('python3',[report,file],{encoding:'utf8'});assert.ok(output.includes(`Observations: ${t.checked}; usable: ${t.usable}; stale: ${t.stale}; errors: ${t.errors}`));assert.ok(output.includes(`Agreement with Deck: ${t.agree}/${t.usable}`));if(t.usable){assert.ok(Math.abs(Number(output.match(/Mean latency: (\d+) ms/)[1])-t.latency)<=.5);const parsed=parseFeed(text);const cost=parsed.reduce((sum,r)=>sum+((r.kind==='thinking'?r.usage?.cost:r.result?.usage?.cost)??0),0);assert.ok(output.includes(`Reported cost: $${cost.toFixed(6)}`));}return {t,output};}
test('mixed fixture totals match Python report',()=>{const dir=mkdtempSync(join(tmpdir(),'clef-feed-'));try{const f=join(dir,'fixture.jsonl');writeFileSync(f,fixture);const {t}=compare(fixture,f);assert.deepEqual(t,{checked:4,usable:2,agree:1,errors:1,stale:1,latency:1500,cost:.003});}finally{rmSync(dir,{recursive:true});}});
const files=Object.fromEntries(['hooks/hooks.json','hooks/feed.ts','hooks/register.tsx'].map(p=>[p,readFileSync(new URL('../'+p,import.meta.url),'utf8')]));
const texts=n=>typeof n==='string'?[n]:(n?.c??[]).flatMap(texts);
const tick=()=>new Promise(r=>setTimeout(r,50));
test('runtime registers panel, safely reads and renders all row types, then updates',async()=>{
 const calls=[],errors=[],trees={};let status='',active=0,maxActive=0,log=fixture;
 const dir='/test/data';
 const host={call:async(method,args)=>{calls.push({method,args});if(method==='env.get')return '/test';assert.equal(method,'process.run');assert.equal(args.timeoutMs,5000);const [program,...rest]=args.argv;assert.ok(['/usr/bin/stat','/bin/cat'].includes(program));const path=rest.at(-1);assert.ok(path.startsWith(dir+'/'));active++;maxActive=Math.max(active,maxActive);await new Promise(r=>setTimeout(r,2));active--;if(program==='/usr/bin/stat')return {exitCode:0,stdout:String(log.length)};let value=path.endsWith('decisions.jsonl')?log:path.endsWith('settings.json')?JSON.stringify({decision:{enabled:true,provider:'openrouter'}}):path.endsWith('session.json')?JSON.stringify({panes:[{id:'room',title:'Trial'}]}):JSON.stringify({snapshot:{transcript:[{speaker:{kind:'human'},at:999999,text:'A safe snippet'}]}});return {exitCode:0,stdout:value};},command:()=>{},open:p=>assert.equal(p.focus,false),close:()=>{},tree:(id,t)=>trees[id]=t,status:s=>status=s,toast:()=>{},error:e=>errors.push(e)};
 const mod=loadMod({files,modules:['./register.tsx'],name:'clef-feed',options:{dataDir:'~/data'},host});
 try{await mod.dispatch('session.start',{});assert.deepEqual(mod.commands(),['clef']);assert.deepEqual(await mod.dispatch('command.run',{command:'clef'}),{});await tick();let text=texts(trees.feed).join('\n');assert.match(text,/4 checked · agrees 1\/2 · 1 errors · 1 stale · avg 1.5s · \$0.0030/);for(const value of ['Observer on · OpenRouter / Clef','A safe snippet','provider failed','you moved on before it answered','✗'])assert.ok(text.includes(value));assert.equal(status,'Clef ✓ 1/2');assert.ok(text.indexOf('Thinking recommendations')<text.indexOf('Routing'));for(const value of ['Thinking recommendations','2 checks · 1 recommendations · 1 errors · 1 stale','Clef: high 87%','Backup: ultra','Auto · log only','thinking-only failure'])assert.ok(text.includes(value),value);log=log.replace('provider failed','provider healed');await new Promise(r=>setTimeout(r,2100));await tick();assert.ok(texts(trees.feed).join('\n').includes('provider healed'));assert.ok(!texts(trees.feed).join('\n').includes('provider failed'));log+='\n'+JSON.stringify(row);await new Promise(r=>setTimeout(r,2100));await tick();assert.match(texts(trees.feed).join('\n'),/5 checked · agrees 2\/3/);assert.equal(maxActive,1);assert.deepEqual(errors,[]);}finally{mod.stop();}
});
test('missing log gives no observations and off status',async()=>{
 const trees={};let status='';const host={call:async(m,a)=>m==='process.run'&&a.argv.at(-1).endsWith('settings.json')?{exitCode:0,stdout:'{"decision":{"enabled":false}}'}:{exitCode:1,stdout:''},command:()=>{},open:()=>{},close:()=>{},tree:(id,t)=>trees[id]=t,status:s=>status=s,toast:()=>{},error:()=>{}};
 const mod=loadMod({files,modules:['./register.tsx'],name:'clef-feed',options:{dataDir:'/test/data'},host});try{await mod.dispatch('session.start',{});await mod.dispatch('command.run',{command:'clef'});await tick();assert.match(texts(trees.feed).join('\n'),/No observations yet/);assert.equal(status,'Clef: observer off');}finally{mod.stop();}
});
test('real log read-only comparison',()=>{const path=join(homedir(),'Library/Application Support/dev.apexdeck.app/decisions.jsonl');const before=readFileSync(path,'utf8');const {output}=compare(before,path);assert.equal(readFileSync(path,'utf8').startsWith(before),true);console.log('REAL LOG REPORT\n'+output);});

test('invalid field rows are skipped while valid observations still render',async()=>{
 const trees={},errors=[];
 const invalid=[{error:{toString:null}},{deck_targets:42},{suggested_targets:{}},{deck_targets:[{}]},{choices:{bot_0:42}},{room:{}},{result:{choice:{}}},{result:{latency_ms:"bad"}},{thinking:{choice:{}}},{backup:{}},{result:{usage:{cost:"bad"}}}].map(patch=>({...row,...patch}));
 const log=[...invalid,row].map(r=>JSON.stringify(r)).join('\n');
 const host={call:async(m,a)=>({exitCode:0,stdout:a.argv[0]==='/usr/bin/stat'?String(log.length):a.argv.at(-1).endsWith('decisions.jsonl')?log:'{}'}),command:()=>{},open:()=>{},close:()=>{},tree:(id,t)=>trees[id]=t,status:()=>{},toast:()=>{},error:e=>errors.push(e)};
 const mod=loadMod({files,modules:['./register.tsx'],name:'clef-feed',options:{dataDir:'/test/data'},host});
 try{await mod.dispatch('session.start',{});await mod.dispatch('command.run',{command:'clef'});await tick();assert.deepEqual(errors,[]);assert.match(texts(trees.feed).join('\n'),/1 checked · agrees 1\/1/);}finally{mod.stop();}
});
