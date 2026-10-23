import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transform } from 'sucrase';
import { gitGates, reconcileSelection, selectTurnFiles } from '../src/gitChanges.ts';
const source = fs.readFileSync(new URL('../src/GitChangesMenu.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^import '\.\/gitChanges.css';\n/m, '').replace('export function GitChangesMenu', 'function GitChangesMenu'), {transforms:['typescript','jsx'], jsxRuntime:'classic'}).code;
const tick = () => new Promise(resolve => setImmediate(resolve));
const state = () => ({root:'/repo',head:'abc',tree:'tree',branch:'feat/test',target:'main',targetHead:'base',ahead:2,behind:0,checksPassed:false,clean:false,files:[{path:'a.ts',added:2,removed:1,patch:'+a',stagedOnly:false},{path:'b.ts',added:1,removed:0,patch:'+b',stagedOnly:false}]});
function harness(backend) {
  const slots=[]; let cursor=0; const effects=[]; const timers=new Map(); const listeners=new Map(); let timer=0;
  const fakeWindow={innerWidth:360,innerHeight:500,setInterval(fn){timers.set(++timer,fn);return timer;},clearInterval(id){timers.delete(id);},addEventListener(name,fn){listeners.set(name,fn);},removeEventListener(name,fn){if(listeners.get(name)===fn)listeners.delete(name);}};
  const effect=(fn,deps)=>{const i=cursor++;const old=slots[i];const changed=!old||!deps||deps.some((v,k)=>v!==old.deps[k]);slots[i]={deps,cleanup:old?.cleanup};if(changed)effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});};
  const hooks={
    useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},
    useRef(initial){const i=cursor++;return slots[i]??=( {current:initial} );},
    useId(){cursor++;return 'git-menu';},
    useCallback(fn,deps){const i=cursor++;const old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k]))slots[i]={fn,deps};return slots[i].fn;},
    useEffect:effect,useLayoutEffect:effect,
  };
  const fakeDocument={body:{},activeElement:null};
  const React={Fragment:'fragment',createElement(type,props,...children){const node={type,props:props??{},children:children.flat(Infinity),style:{},focus(){this.focused=true;fakeDocument.activeElement=this;},contains(node){return node===this||Boolean(node?.props.id&&node.props.id===this.props.id);},getBoundingClientRect(){return{left:0,right:350,top:25,bottom:50,width:320,height:300};}};if(props?.ref&&typeof props.ref==='object')props.ref.current=node;return node;}};
  const component = new Function('React',...Object.keys(hooks),'createPortal','Diff','popoverTop','gitGates','reconcileSelection','selectTurnFiles','window','document','ResizeObserver','HTMLElement',compiled+'; return GitChangesMenu;')(React,...Object.values(hooks),(child)=>child,'Diff',()=>55,gitGates,reconcileSelection,selectTurnFiles,fakeWindow,fakeDocument,class{observe(){}disconnect(){}},Object);
  let props={backend,room:'room',cwd:'/repo',active:true,ready:true,revision:0,request:null,target:{},canOpen:true,onOpen(){props={...props,request:{paths:null,nonce:Date.now()}};},onClose(){props={...props,request:null};},onReview(){},onChanged(){}};
  return {render(){cursor=0;const tree=component(props);while(effects.length)effects.shift()();return tree;},setProps(next){props={...props,...next};},poll(){for(const fn of timers.values())fn();},key(e){listeners.get('keydown')?.(e);},unmount(){for(const slot of slots)slot?.cleanup?.();}};
}
function findAll(node, predicate){if(!node||typeof node!=='object')return[];return[...(predicate(node)?[node]:[]),...(node.children??[]).flatMap(child=>findAll(child,predicate))];}
function find(node,predicate){return findAll(node,predicate)[0];}
function text(node){if(typeof node==='string'||typeof node==='number')return String(node);return(node?.children??[]).map(text).join('');}
const button=(tree,label)=>find(tree,n=>n.type==='button'&&text(n)===label);
const checkboxes=tree=>findAll(tree,n=>n.type==='input'&&n.props.type==='checkbox');
const listed=tree=>checkboxes(tree).map(n=>String(n.props['aria-label']).replace(/^Include /,'').replace(/ in commit$/,''));
async function loaded(h){h.render();await tick();return h.render();}

test('turn chip request opens live menu with only matching files selected and submits that scope', async()=>{
  let live=state(); const calls=[];
  const h=harness({call:async(cmd,args)=>{if(cmd==='room_git_status')return live;calls.push(args.action);live={...live,head:'def',files:[live.files[1]]};return{state:live,message:'Committed.'};}});
  await loaded(h);h.setProps({request:{paths:['/repo/a.ts','already-committed.ts'],nonce:1}});let tree=await loaded(h);
  assert.deepEqual(listed(tree),['a.ts'],'only the scoped file is listed');
  assert.ok(button(tree,'▶ 1 unselected file'),'unselected files start collapsed');
  button(tree,'▶ 1 unselected file').props.onClick();tree=h.render();
  assert.deepEqual(listed(tree),['a.ts','b.ts'],'expanding reveals the unselected file');
  assert.deepEqual(checkboxes(tree).map(n=>n.props.checked),[true,false]);
  const message=find(tree,n=>n.type==='input'&&n.props['aria-label']==='Commit message');message.props.onChange({target:{value:'Selected file'}});tree=h.render();
  const form=find(tree,n=>n.type==='form');form.props.onSubmit({preventDefault(){}});await tick();tree=h.render();
  assert.deepEqual(calls[0].paths,['a.ts']);assert.equal(calls[0].expected.head,'abc');
  assert.equal(button(tree,'Merge').props.disabled,true);h.unmount();
});

test('polling preserves deselection and stale refresh cannot replace a newer turn selection', async()=>{
  let defer;let deferred=false;const live=state();
  const h=harness({call:async()=>deferred?new Promise(resolve=>{defer=resolve;}):live});
  let tree=await loaded(h);find(tree,n=>n.type==='button'&&n.props.className?.includes('git-changes-trigger')).props.onClick();tree=await loaded(h);
  assert.deepEqual(listed(tree),['a.ts','b.ts']);
  checkboxes(tree)[1].props.onChange({target:{checked:false}});h.render();h.poll();await tick();tree=h.render();
  assert.deepEqual(listed(tree),['a.ts'],'a deselected file moves into the collapsed group and stays out of the commit');
  assert.ok(button(tree,'▶ 1 unselected file'));
  deferred=true;h.poll();const old=defer;deferred=false;
  h.setProps({request:{paths:['/repo/b.ts'],nonce:2}});tree=await loaded(h);old({...live,head:'outdated'});await tick();tree=h.render();
  assert.deepEqual(listed(tree),['b.ts'],'a stale poll cannot replace the newer turn selection');h.unmount();
});

test('merge requires an explicit confirmation and refreshed HEAD cancels it', async()=>{
  let live={...state(),files:[],clean:true,checksPassed:true};const actions=[];
  const h=harness({call:async(cmd,args)=>cmd==='room_git_status'?live:(actions.push(args.action),{state:live,message:'Merged'})});
  await loaded(h);h.setProps({request:{paths:null,nonce:1}});let tree=await loaded(h);
  button(tree,'Merge').props.onClick();tree=h.render();assert.ok(button(tree,'Confirm merge'));assert.equal(actions.length,0);
  live={...live,head:'new-unreviewed-head',checksPassed:true};h.poll();await tick();tree=h.render();
  assert.equal(button(tree,'Confirm merge'),undefined,'a changed HEAD needs a fresh merge review');h.unmount();
});

test('slow status polls are coalesced and still populate the open menu', async()=>{
  const pending=[];let calls=0;
  const h=harness({call:()=>{calls++;return new Promise(resolve=>pending.push(resolve));}});
  h.render();h.setProps({request:{paths:['/repo/b.ts'],nonce:1}});h.render();h.poll();h.poll();
  assert.equal(calls,1,'polling must not starve the original slow request');
  pending[0](state());await tick();const tree=h.render();
  assert.deepEqual(listed(tree),['b.ts']);h.unmount();
});

test('a disconnected host disables actions on an already-open menu', async()=>{
  const actions=[];const live={...state(),files:[],clean:true,checksPassed:true};
  const h=harness({call:async(cmd,args)=>cmd==='room_git_status'?live:(actions.push(args.action),{state:live,message:'done'})});
  await loaded(h);h.setProps({request:{paths:null,nonce:1}});let tree=await loaded(h);
  h.setProps({ready:false});tree=h.render();
  assert.equal(button(tree,'Merge').props.disabled,true);assert.equal(button(tree,'Open PR').props.disabled,true);h.unmount();
});

test('read errors remove actionable state and Escape closes the inline card', async()=>{
  let fail=false;const h=harness({call:async()=>{if(fail)throw Error('offline');return state();}});
  await loaded(h);h.setProps({request:{paths:null,nonce:1}});let tree=await loaded(h);fail=true;h.poll();await tick();tree=h.render();
  assert.equal(button(tree,'Merge'),undefined);assert.match(text(tree),/offline/);assert.ok(button(tree,'Thread diff'));
  h.key({key:'Escape',preventDefault(){},stopPropagation(){}});tree=h.render();assert.equal(find(tree,n=>n.props.role==='region'),undefined);h.unmount();
});


test('top-bar opening clears turn markers and renders a closable live inline card', async()=>{
  const h=harness({call:async()=>state()});
  await loaded(h);h.setProps({request:{paths:['/repo/a.ts'],nonce:1}});let tree=await loaded(h);
  assert.equal(findAll(tree,n=>n.props.className==='git-turn-mark').length,1);
  assert.ok(find(tree,n=>n.props.role==='region'));
  assert.match(text(tree),/live now/);
  find(tree,n=>n.props['aria-label']==='Close changes').props.onClick();tree=h.render();
  assert.equal(find(tree,n=>n.props.role==='region'),undefined);
  find(tree,n=>n.props.className?.includes('git-changes-trigger')).props.onClick();tree=await loaded(h);
  assert.equal(findAll(tree,n=>n.props.className==='git-turn-mark').length,0);
  assert.deepEqual(checkboxes(tree).map(n=>n.props.checked),[true,true]);h.unmount();
});


test('/diff opens the latest eligible reply or falls back to Thread diff without a chip', ()=>{
  const chat=fs.readFileSync(new URL('../src/ChatPane.tsx',import.meta.url),'utf8');
  const body=chat.slice(chat.indexOf('case "diff":')+'case "diff":'.length,chat.indexOf('case "plan":'));
  const run=new Function('latestGitSeq','setText','openGitCard','setTurnPaths','setFocusPath','details','loadDiff',body);
  for(const seq of [42,null]){
    const calls=[];run(seq,()=>{},(...args)=>calls.push(['card',...args]),()=>{},()=>{},{show:name=>calls.push(['panel',name])},()=>calls.push(['diff']));
    assert.deepEqual(calls,seq===null?[['panel','changes'],['diff']]:[['card',42,null]]);
  }
});
