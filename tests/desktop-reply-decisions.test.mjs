import test from 'node:test';
import { withAppearanceApp } from './helpers/appearance-app.mjs';

const fixture = {
  name: 'desktop-reply-decisions',
  enforce: 'pre',
  transform(_code, id) {
    if (!id.endsWith('/src/App.tsx')) return;
    return `import React from 'react';
import {ChatPane} from './ChatPane';
import {getBackend} from './backend';
import {ReplySuggestionsSetting} from './ReplySuggestionsSetting';
import {recordQuestion} from './questions';
let mode = 'decision_card', kind = 'merge', generation = 1;
const bot = {id:'bot',display_name:'Builder',persona:'',access:'read',backend:{kind:'scripted',lines:[]}};
const head = 'a'.repeat(40);
const checkout = {repo:'example/deck',branch:'fix/alert',root:'/repo',generation};
const snapshot = {participants:[bot],options:{policy:'mention',max_bot_hops:0},changes:[],transcript:[
  {seq:0,speaker:{kind:'bot',id:'bot'},text:'Earlier reply.'},
  {seq:1,speaker:{kind:'bot',id:'bot'},text:'I traced the delay.\\nDeck asks: Add a timestamp to the trace? | Add logging'}]};
const cards = {
  merge:{question:'Merge into main?',context:'Reviewed · CI passed',primary:'Merge to main'},
  merging:{question:'Merging…',cancellable:true},
  question:{question:'Add a timestamp to the trace?',primary:'Add logging',to:'bot',prompt:'Add logging'},
  fix_checks:{question:'Send the failed check to the builder?',primary:'Ask agent to fix',detail:'Windows failed'}
};
const listeners = new Set();
function changed(){ for (const cb of listeners) cb({replySuggestions:mode}); }
window.scene = next => {kind=next;changed();};
window.actions=[];
window.steps=()=>recordQuestion('r',{type:'next_steps',id:'bot',steps:[{label:'Measure',prompt:'Measure again'}],pending:false});
const backend = {...await getBackend(),demo:false,
  roomState:async()=>({snapshot,active:[],approvals:[],questions:[],mounts:[]}),roomClose:async()=>{},
  onSettingsChanged:async cb=>{listeners.add(cb);return ()=>listeners.delete(cb);},
  call:async(cmd,args)=>{
    if(cmd==='settings_load') return {replySuggestions:mode};
    if(cmd==='settings_reply_suggestions_set'){mode=args.mode;changed();return {mode};}
    if(cmd==='room_reply_decision') return {mode,replySeq:1,checkout,decision:cards[kind] && (mode==='decision_card'||kind==='merging') ?
      {kind,key:kind+'-1',head,turns:['question','fix_checks'].includes(kind)?1:0,dismissible:kind!=='merging',...cards[kind]} : null};
    if(cmd==='room_git_status') return {head,files:[],workflow:{head,...checkout}};
    if(cmd==='room_thread_git_action'){window.actions.push(args.action.kind);kind=args.action.kind==='merge_ready'?'merging':'none';return {message:'Action recorded'};}
    if(cmd==='room_post_to'){window.actions.push(args);kind='none';return {};}
    if(cmd==='room_reply_decision_dismiss'){window.actions.push(args.key);kind='none';return {};}
  }};
export function App(){return <main className="rail" style={{display:'block',width:'100%'}}>
  <ReplySuggestionsSetting backend={backend}/>
  <ChatPane pane={{id:'r',workspaceId:'w',kind:'chat',title:'Thread'}} backend={backend} agents={[]} focused onActivity={()=>{}} profiles={[]} onProfilesChange={()=>{}} disabledProviders={[]}/>
</main>;}`;
  },
};

test('desktop switches suggestion modes, dispatches once and keeps Cancel accessible', { timeout: 150000 }, async () => {
  await withAppearanceApp('reply-decisions-desktop', String.raw`
    const card = '.bubble.bot.completed[data-seq="1"] .reply-decision';
    const click = selector => run('document.querySelector('+JSON.stringify(selector)+').click()');
    const choose = async mode => { await run('(()=>{const s=document.getElementsByTagName("select")[0];s.value='+JSON.stringify(mode)+';s.dispatchEvent(new Event("change",{bubbles:true}));})()');await frame(); };
    await until('!!document.querySelector('+JSON.stringify(card)+')');
    assert.equal(await run('document.querySelectorAll(".reply-decision").length'),1);
    assert.equal(await run('document.body.textContent.includes("Deck asks:")'),false);
    await shot('desktop-merge-ready');
    await run('(()=>{const b=document.querySelector(".reply-decision .primary");b.click();b.click();})()');
    await until('document.querySelector(".reply-decision .primary")?.textContent==="Cancel"');
    assert.deepEqual(await run('window.actions'),['merge_ready']);
    await choose('off');
    await click(card+' .primary');
    await until('!document.querySelector(".reply-decision")');
    assert.deepEqual(await run('window.actions'),['merge_ready','cancel_merge']);
    await choose('next_steps');await run('window.steps()');
    await until('!!document.querySelector(".reply-next-step")');
    await choose('off');await until('!document.querySelector(".reply-next-step")');
    await choose('decision_card');
    await run('window.scene("fix_checks")');
    await until('document.querySelector(".reply-decision small")?.textContent==="1 model turn"');
    await click(card+' summary');
    assert.match(await run('document.querySelector(".reply-decision pre").innerText'),/Windows failed/);
    await click(card+' .primary');await until('!document.querySelector(".reply-decision")');
    assert.equal(await run('window.actions.at(-1)'),'fix_checks');
    await run('window.scene("question")');
    await until('document.querySelector(".reply-decision .primary")?.textContent==="Add logging"');
    await click(card+' .primary');await until('!document.querySelector(".reply-decision")');
    assert.deepEqual(await run('window.actions.at(-1)'),{id:'r',text:'Add logging',targets:['bot'],decisionKey:'question-1'});
    await run('window.scene("question")');await until('!!document.querySelector(".reply-decision .dismiss")');
    await click(card+' .dismiss');await until('!document.querySelector(".reply-decision")');
    assert.equal(await run('window.actions.at(-1)'),'question-1');
  `, { plugins: [fixture] });
});
