import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);const {transform}=require('sucrase');
const source=fs.readFileSync(new URL('../src/AssistantPermissions.tsx',import.meta.url),'utf8');
const code=transform(source.replace(/^import .*;\n/gm,'').replace(/^export /gm,''),{transforms:['typescript','jsx','imports'],jsxRuntime:'automatic',production:true}).code;
function harness(){
 const state=[];let cursor=0;const useState=initial=>{const i=cursor++;if(!(i in state))state[i]=initial;return[state[i],value=>state[i]=value];};
 const Panel=new Function('require','useState',`${code};return AssistantPermissions;`)(require,useState);
 const calls=[];const lane={setPermission:async(...args)=>calls.push(args),assistant:{projects:[{project:{hostId:'owner',cwd:'/repo'}}],permissions:{grants:[]}},currentThread:{id:'thread',title:'Checkout',project:{hostId:'owner',cwd:'/repo'}}};
 return{calls,render(){cursor=0;return Panel({lane});}};
}
const nodes=(tree)=>{const out=[];const walk=n=>{if(Array.isArray(n))return n.forEach(walk);if(!n||typeof n!=='object')return;out.push(n);walk(n.props?.children);};walk(tree);return out;};

test('scoped permission controls disclose native-only adapters and disable unsupported browser computer and publishing',()=>{
 const h=harness();let tree=h.render();nodes(tree).find(n=>n.type==='select'&&!n.props['aria-label']).props.onChange({target:{value:'thread'}});tree=h.render();
 const selects=nodes(tree).filter(n=>n.type==='select');
 for(const label of ['Use browser permission','Use computer permission','Publish in delegated requests permission','Create threads permission'])assert.equal(selects.find(n=>n.props['aria-label']===label).props.disabled,true,label);
 for(const label of ['Run commands and tests','Read files','Spend']){
  const control=selects.find(n=>n.props['aria-label']===`${label} · native thread requests only permission`);assert.ok(control);assert.equal(control.props.disabled,false);
 }
 const html=renderToStaticMarkup(tree);assert.match(html,/Raw commands can access outside their working folder/);assert.match(html,/Scoped Ask restrictions conservatively hold unscoped calls/);
});

test('a displayed thread Ask saves the exact thread scope and capability',async()=>{
 const h=harness();let tree=h.render();nodes(tree).find(n=>n.type==='select'&&!n.props['aria-label']).props.onChange({target:{value:'thread'}});tree=h.render();
 nodes(tree).find(n=>n.props['aria-label']==='Spend · native thread requests only permission').props.onChange({target:{value:'ask'}});await Promise.resolve();
 assert.deepEqual(h.calls,[['spend',{kind:'thread',host:'owner',cwd:'/repo',thread:'thread'},'ask',false]]);
});
