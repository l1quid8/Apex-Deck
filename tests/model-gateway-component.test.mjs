import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transform } from 'sucrase';
import * as model from '../src/modelGateway.ts';

const source=fs.readFileSync(new URL('../src/ModelGatewaySettings.tsx',import.meta.url),'utf8');
const compiled=transform(source.replace(/^import .*;\n/gm,'').replace('export function ModelGatewaySettings','function ModelGatewaySettings'),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
function harness() {
  const states=[],effects=[];let cursor=0;
  const React={createElement:(type,props,...children)=>({type,props:props??{},children})};
  const hooks={
    useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},
    useRef(initial){const i=cursor++;return states[i]??={current:initial};},
    useMemo(fn,deps){const i=cursor++;const old=states[i];if(!old||deps.some((d,j)=>d!==old.deps[j]))states[i]={value:fn(),deps};return states[i].value;},
    useCallback(fn,deps){return this.useMemo(()=>fn,deps);},
    useEffect(fn,deps){const i=cursor++;const old=effects[i];if(!old||deps.some((d,j)=>d!==old.deps[j]))effects[i]={fn,deps,changed:true,cleanup:old?.cleanup};},
  };
  const built=new Function('React','useState','useEffect','useMemo','useCallback','useRef','gatewayApi','gatewayOwner','issueGatewaySpec','ConfirmDialog',`${compiled};return {ModelGatewaySettings,OwnerGateway};`)(React,hooks.useState,hooks.useEffect,hooks.useMemo,hooks.useCallback.bind(hooks),hooks.useRef,model.gatewayApi,model.gatewayOwner,model.issueGatewaySpec,()=>null);
  return { wrapper:built.ModelGatewaySettings,render(backend){cursor=0;const tree=built.OwnerGateway({backend});for(const e of effects)if(e?.changed){e.changed=false;e.cleanup?.();e.cleanup=e.fn();}return tree;},unmount(){for(const e of effects)e?.cleanup?.();} };
}
const tick=()=>new Promise(r=>setTimeout(r,0));
function find(n,p){if(!n||typeof n!=='object')return null;if(Array.isArray(n)){for(const c of n){const result=find(c,p);if(result)return result;}return null;}if(p(n))return n;return find(n.children,p);}
const text=n=>n==null?'':typeof n!=='object'?String(n):Array.isArray(n)?n.map(text).join(''):(n.children??[]).map(text).join('');
const button=(tree,label)=>find(tree,n=>n.type==='button'&&text(n)===label);
const labelInput=(tree,label)=>find(find(tree,n=>n.type==='label'&&text(n).startsWith(label)),n=>n.type==='input');
function backend(){const issued={token:'apx_sk_test_secret',key:{id:'one',label:'Test rig',prefix:'apx_sk_...fake',scopes:['api'],turns_today:0,spend_micros_month:0,max_turns_per_day:100,max_usd_micros_per_month:25000000,last_used_at:null}};const sent=[];let keys=[];return{sent,demo:false,gatewayAdmin:true,host:{id:'local'},call:async(cmd,args)=>{sent.push([cmd,args]);if(cmd==='gateway_status')return{enabled:false,bind:'127.0.0.1',port:8787,baseUrl:null};if(cmd==='gateway_keys_list')return{keys};if(cmd==='gateway_providers')return{providers:[{id:'codex',name:'Codex',kind:'Subscription CLI',available:true,detail:'Installed; login not checked.'}]};if(cmd==='gateway_keys_issue'){keys=[issued.key];return issued;}if(cmd==='gateway_keys_revoke'){keys=[];return{revoked:true};}throw Error('Unexpected command '+cmd);}};}

test('remote viewers cannot render owner controls or trigger management calls',()=>{const b=backend();b.host.id='remote';const h=harness();const tree=h.wrapper({backend:b});assert.match(text(tree),/Only the local host owner/);assert.equal(find(tree,n=>n.type==='button'),null);assert.equal(b.sent.length,0);});

test('owner issues once, sees secret until dismissal, and confirms revocation',async()=>{const b=backend(),h=harness();let tree=h.render(b);await tick();tree=h.render(b);assert.match(text(tree),/No gateway keys yet/);button(tree,'Create key').props.onClick();tree=h.render(b);labelInput(tree,'Device or person').props.onChange({target:{value:'Test rig'}});tree=h.render(b);find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});await tick();tree=h.render(b);assert.equal(b.sent.filter(([cmd])=>cmd==='gateway_keys_issue').length,1);assert.equal(labelInput(tree,'API key').props.value,'apx_sk_test_secret');assert.match(text(tree),/Until revoked/);button(tree,'Done').props.onClick();tree=h.render(b);assert.equal(labelInput(tree,'API key'),null);button(tree,'Revoke').props.onClick();tree=h.render(b);const dialog=find(tree,n=>n.props.question);assert.equal(b.sent.filter(([cmd])=>cmd==='gateway_keys_revoke').length,0);dialog.props.question.onConfirm();await tick();tree=h.render(b);assert.equal(b.sent.filter(([cmd])=>cmd==='gateway_keys_revoke').length,1);assert.match(text(tree),/No gateway keys yet/);h.unmount();});

test('provider view shows actual configuration, and failed creation preserves the form',async()=>{const b=backend(),h=harness();const call=b.call;b.call=async(cmd,args)=>{if(cmd==='gateway_keys_issue')throw Error('Disk full');return call(cmd,args);};let tree=h.render(b);await tick();tree=h.render(b);button(tree,'Providers').props.onClick();tree=h.render(b);assert.match(text(tree),/Codex/);assert.match(text(tree),/login not checked/);button(tree,'API keys').props.onClick();tree=h.render(b);button(tree,'Create key').props.onClick();tree=h.render(b);labelInput(tree,'Device or person').props.onChange({target:{value:'Test rig'}});tree=h.render(b);find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});await tick();tree=h.render(b);assert.match(text(tree),/Disk full/);assert.ok(find(tree,n=>n.type==='form'));assert.equal(labelInput(tree,'API key'),null);h.unmount();});
