import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {assistantOutputs, outputKindLabel, outputMark, outputName, outputsLine} from '../src/assistantOutputs.ts';
const {transform}=createRequire(import.meta.url)('sucrase');
const source=fs.readFileSync(new URL('../src/AssistantDetails.tsx',import.meta.url),'utf8');
const compiled=transform(source.replace(/^import .*;\n/gm,'').replace(/^export /gm,''),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)})};
const text=n=>typeof n==='string'||typeof n==='number'?String(n):n?.children?.map(text).join('')??'';
const find=(n,p)=>!n||typeof n!=='object'?null:p(n)?n:[...(n.children??[])].map(c=>find(c,p)).find(Boolean)??null;
const all=(n,p)=>!n||typeof n!=='object'?[]:[...(p(n)?[n]:[]),...(n.children??[]).flatMap(c=>all(c,p))];

const patch=[
 'diff --git a/src/App.tsx b/src/App.tsx',
 'index 1111111..2222222 100644',
 '--- a/src/App.tsx',
 '+++ b/src/App.tsx',
 '@@ -1,2 +1,3 @@',
 '-const title = "Deck";',
 '+const title = "Apex Deck";',
 '+export default null;',
 ' export {};',
 'diff --git a/docs/release-notes.md b/docs/release-notes.md',
 'new file mode 100644',
 'index 0000000..3333333',
 '--- /dev/null',
 '+++ b/docs/release-notes.md',
 '@@ -0,0 +1,2 @@',
 '+# Notes',
 '+Two lines.',
].join('\n')+'\n';

function mount(overrides={}){
 const props={lane:{name:'Null',hostName:'Mac',offline:false,assistant:{id:'a',hostId:'mac',name:'Null',profile:{},tasks:[]}},tasks:[{id:'task-1',resultData:{reviewDiff:patch}}],onClose:()=>{},onNavigate:()=>{},onOpenBrowser:()=>{},...overrides};
 const states=[];let cursor=0;
 const hooks={
  useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},
  useMemo(make){cursor++;return make();},
 };
 const bindings={React,...hooks,Avatar:()=>null,createAssistantAvatarApi:()=>undefined,assistantAppearance:()=>({seed:'a',color:'#fff'}),assistantStatus:()=>({state:'ready',label:'Ready',working:0,needsYou:0,failed:0}),assistantOutputs,outputKindLabel,outputMark,outputName,outputsLine};
 const Component=new Function(...Object.keys(bindings),`${compiled}\nreturn AssistantDetails;`)(...Object.values(bindings));
 return{props,render(){cursor=0;return Component(props);}};
}

test('Outputs lists the files the recorded review patches name, with counts and totals',()=>{
 const tree=mount().render();
 assert.match(text(tree),/Outputs/);
 assert.match(text(tree),/2 files · \+4 −1/);
 const rows=all(tree,n=>n.props?.className==='assistant-output');
 assert.deepEqual(rows.map(r=>[text(find(r,n=>n.props?.className==='assistant-output-mark')),text(find(r,n=>n.props?.className==='assistant-output-name'))]),[
  ['A','release-notes.mddocs'],
  ['M','App.tsxsrc'],
 ]);
 assert.deepEqual(rows.map(r=>text(find(r,n=>n.props?.className==='assistant-output-count'))),['+2 −0','+2 −1']);
});

test('a row opens that file’s patch and closes again on a second press',()=>{
 const h=mount();let tree=h.render();
 const row=()=>all(tree,n=>n.props?.className==='assistant-output').find(n=>text(n).startsWith('M'));
 assert.equal(row().props['aria-expanded'],false);
 assert.equal(find(tree,n=>n.type==='pre'),null);
 row().props.onClick();tree=h.render();
 assert.equal(all(tree,n=>n.props?.className==='assistant-output').find(n=>text(n).startsWith('M')).props['aria-expanded'],true);
 const pre=find(tree,n=>n.type==='pre');
 assert.ok(pre,'the patch is shown');
 assert.match(text(pre),/\+const title = "Apex Deck";/);
 assert.equal(pre.props.tabIndex,0,'the patch can be read with the keyboard');
 assert.match(text(tree),/Changed by 1 task/);
 all(tree,n=>n.props?.className==='assistant-output').find(n=>text(n).startsWith('M')).props.onClick();tree=h.render();
 assert.equal(find(tree,n=>n.type==='pre'),null);
});

test('a task with no recorded patch shows the honest empty line, never a blank box',()=>{
 for(const tasks of [[],[{id:'read-only',resultData:{}}],[{id:'blank',resultData:{reviewDiff:'  '}}],[{id:'none'}]]){
  const tree=mount({tasks}).render();
  assert.match(text(tree),/No files yet\. When a task records a review patch/);
  assert.equal(find(tree,n=>n.props?.className==='assistant-output'),null);
 }
});

test('Outputs folds shut and reports its state to assistive technology',()=>{
 const h=mount();let tree=h.render();
 const fold=()=>find(tree,n=>n.props?.className==='assistant-details-fold'&&text(n).includes('Outputs'));
 assert.equal(fold().props['aria-expanded'],true);
 assert.equal(fold().props['aria-controls'],'assistant-details-outputs');
 assert.ok(find(tree,n=>n.props?.id==='assistant-details-outputs'));
 fold().props.onClick();tree=h.render();
 assert.equal(fold().props['aria-expanded'],false);
 assert.equal(find(tree,n=>n.props?.id==='assistant-details-outputs'),null);
});

test('the footer opens the three subviews and the close button closes',()=>{
 const seen=[];let closed=0;
 const tree=mount({onNavigate:s=>seen.push(s),onClose:()=>{closed++;}}).render();
 for(const label of ['Memory','Projects & access','Settings']) find(tree,n=>n.type==='button'&&text(n)===label).props.onClick();
 assert.deepEqual(seen,['memory','projects','settings']);
 find(tree,n=>n.props?.['aria-label']==='Close details').props.onClick();
 assert.equal(closed,1);
});

test('the Browser card opens the assistant browser and is disabled without one',()=>{
 const seen=[];const open=mount({onOpenBrowser:()=>seen.push('browser'),lane:{name:'Null',hostName:'Mac',assistant:{id:'a',hostId:'mac',name:'Null',profile:{},tasks:[]},browserView:async()=>{}}});
 const button=find(open.render(),n=>n.props?.className==='assistant-details-browser');
 assert.equal(button.props.disabled,false);
 button.props.onClick();assert.deepEqual(seen,['browser']);
 const closed=mount({});
 assert.equal(find(closed.render(),n=>n.props?.className==='assistant-details-browser').props.disabled,true);
});
