import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { suggestionsMode, visibleReply } from '../src/replyDecision.ts';
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
import {ShipOfferCard} from './ShipOfferCard';
let mode = 'decision_card', kind = 'merge', generation = 1;
const bot = {id:'bot',display_name:'Builder',persona:'',access:'read',backend:{kind:'scripted',lines:[]}};
const head = 'a'.repeat(40);
const checkout = {repo:'example/deck',branch:'fix/alert',root:'/repo',generation};
const snapshot = {participants:[bot],options:{policy:'mention',max_bot_hops:0},changes:[],transcript:[
  {seq:0,speaker:{kind:'bot',id:'bot'},text:'Earlier reply.'},
  {seq:1,speaker:{kind:'bot',id:'bot'},text:'I traced the delay.\\nDeck asks: Add a timestamp to the trace? | Add logging'}]};
const rows = (required, conflicts) => [{label:'Checks',text:'26 passed',state:'ok'},{label:'Required checks',...required},{label:'Conflicts',...conflicts},{label:'Review',text:'not required',state:'ok'}];
const passed = {text:'passed',state:'ok'}, clean = {text:'none',state:'ok'};
const cards = {
  merge:{question:'Merge into main?',context:'PR #84 · checks passed',primary:'Ship it',pr:84,status:rows(passed,clean)},
  ship_blocked:{kind:'merge',question:"This can't merge yet.",context:'PR #84 · main has no required checks on GitHub',primary:'Ship it',pr:84,blocked:'main has no required checks on GitHub',status:rows({text:'main has none set on GitHub',state:'bad'},clean)},
  ship_conflict:{kind:'merge',question:"This can't merge yet.",context:'PR #84 · It conflicts with main',primary:'Ship it',pr:84,blocked:'It conflicts with main',status:rows(passed,{text:'conflicts with main',state:'bad'})},
  ship_waiting:{kind:'merge',question:'Merge into main once the checks pass?',context:'PR #84 · 3 checks are still running',primary:'Ship when checks pass',pr:84,status:[{label:'Checks',text:'3 still running, 23 passed',state:'wait'},{label:'Required checks',text:'waiting for all-checks-passed',state:'wait'},{label:'Conflicts',...clean},{label:'Review',text:'not required',state:'ok'}]},
  merging:{question:'Merging…',cancellable:true,context:'Waiting for checks on PR #84…'},
  question:{question:'Add a timestamp to the trace?',primary:'Add logging',to:'bot',prompt:'Add logging'},
  fix_checks:{question:'Send the failed check to the builder?',primary:'Ask agent to fix',detail:'Windows failed'}
};
const listeners = new Set();
function changed(){ for (const cb of listeners) cb({replySuggestions:mode}); }
window.scene = next => {kind=next;changed();};
window.actions=[];window.expected=[];
window.steps=()=>recordQuestion('r',{type:'next_steps',id:'bot',steps:[{label:'Measure',prompt:'Measure again'}],pending:false});
const backend = {...await getBackend(),demo:false,
  roomState:async()=>({snapshot,active:[],approvals:[],questions:[],mounts:[]}),roomClose:async()=>{},
  onSettingsChanged:async cb=>{listeners.add(cb);return ()=>listeners.delete(cb);},
  call:async(cmd,args)=>{
    if(cmd==='settings_load') return {replySuggestions:mode};
    if(cmd==='settings_reply_suggestions_set'){mode=args.mode;changed();return {mode};}
    if(cmd==='room_reply_decision') return {mode,replySeq:1,checkout,decision:cards[kind] && (mode==='decision_card'||kind==='merging') ?
      {kind,key:kind+'-1',head,turns:['question','fix_checks'].includes(kind)?1:0,dismissible:kind!=='merging',cancellable:false,...cards[kind]} : null};
    if(cmd==='room_git_status') return {head,files:[],workflow:{head,...checkout}};
    if(cmd==='room_thread_git_action'){window.actions.push(args.action.kind);window.expected.push(args.action.expected);kind=args.action.kind==='merge_ready'?'merging':'none';return {message:'Action recorded'};}
    if(cmd==='room_post_to'){window.actions.push(args);kind='none';return {};}
    if(cmd==='room_reply_decision_dismiss'){window.actions.push(args.key);kind='none';return {};}
  }};
// Alfred's conversation: the same pull request under a reply that names it.
window.shipped=[];
const lane = {offline:false,
  ship:async(pr,head)=>{window.shipped.push({pr,head});if(window.refuse)throw new Error("Couldn't ship PR #84: main has no required checks on GitHub. Nothing was merged.");return {message:'Deck is merging PR #84 (commit aaaaaaaa on fix/alert). The result will be posted here.'};},
  cancelShip:async(room,expected)=>{window.shipped.push({room,expected});return {message:'Confirming cancellation with GitHub…'};}};
const offer = (state, card, extra={}) => ({pr:84,messageId:'pm-1',state,room:'r',checkout,card:card&&{key:state,kind:'merge',head,turns:0,dismissible:true,cancellable:false,...card},...extra});
const offers = [
  offer('ready',cards.merge),
  offer('blocked',cards.ship_blocked),
  offer('merging',{kind:'merging',question:'Merging when checks pass…',context:'Waiting for checks on PR #84…',cancellable:true,dismissible:false}),
  offer('merged',null,{message:"Merged PR #84 into main at 1a2b3c4d. Your Mac's main is updated and your 3 local changes there were kept. Awaiting your test."}),
];
function Alfred(){
  const [on,setOn]=React.useState(false);
  React.useEffect(()=>{window.alfred=()=>setOn(true);},[]);
  return on ? <div id="alfred" style={{maxWidth:520,padding:12}}>{offers.map(o=><ShipOfferCard key={o.state} offer={o} lane={lane} refresh={()=>{}}/>)}</div> : null;
}
export function App(){return <main className="rail" style={{display:'block',width:'100%'}}>
  <ReplySuggestionsSetting backend={backend}/>
  <Alfred/>
  <ChatPane pane={{id:'r',workspaceId:'w',kind:'chat',title:'Thread'}} backend={backend} agents={[]} focused onActivity={()=>{}} profiles={[]} onProfilesChange={()=>{}} disabledProviders={[]}/>
</main>;}`;
  },
};

test('old Next steps settings read as On and Tab fills the draft through the suggestion handler', () => {
  assert.equal(suggestionsMode({ replySuggestions: 'next_steps' }), 'decision_card');
  const source = fs.readFileSync('src/ChatPane.tsx', 'utf8');
  assert.match(source, /formKey\(key, text === "", form, highlighted\)/);
  assert.match(source, /act\.act === "fill" && form\.kind === "steps"\) fillStep\(/);
});

test('a Deck asks line is hidden while a trailing ship or built receipt stays', () => {
  const sha = 'e'.repeat(40);
  const asks = 'Done.\nDeck asks: Show the setting on the phone too? | Show it on the phone';
  assert.equal(visibleReply(`${asks}\nDeck ship ${sha}`), `Done.\nDeck ship ${sha}`);
  assert.equal(visibleReply(`${asks}\nDeck built ${sha}`), `Done.\nDeck built ${sha}`);
  assert.equal(visibleReply(asks), 'Done.');
});

test('the Git card under a reply follows a Deck ship receipt as well as Deck built', () => {
  const source = fs.readFileSync('src/ChatPane.tsx', 'utf8');
  const line = source.split('\n').find(text => text.includes('const latestGitReply ='));
  assert.ok(line, 'latestGitReply is defined');
  const pattern = new RegExp(line.match(/\/\(\?:\^\|\\n\)(.+?)\/\.test/)[1]);
  assert.ok(pattern.test(`Fixed.\nDeck ship ${'f'.repeat(40)}`) && pattern.test(`Fixed.\nDeck built ${'f'.repeat(40)}`));
});

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
    // The card names the merge request it showed: no Git status read first.
    const shownKey = {repo:'example/deck',branch:'fix/alert',root:'/repo',generation:1,head:'a'.repeat(40)};
    assert.deepEqual(await run('window.expected[0]'),shownKey);
    await choose('off');
    await click(card+' .primary');
    await until('!document.querySelector(".reply-decision")');
    assert.deepEqual(await run('window.actions'),['merge_ready','cancel_merge']);
    assert.deepEqual(await run('window.expected[1]'),shownKey);
    const input = 'document.querySelector(".composer textarea")';
    const hint = input + '.placeholder.includes("Measure · Tab to use")';
    const key = key => run(input + '.dispatchEvent(new KeyboardEvent("keydown",{key:'+JSON.stringify(key)+',bubbles:true,cancelable:true}))');
    await choose('decision_card');
    await run('window.scene("merge");window.steps()');
    await until('!!document.querySelector(".reply-decision")');
    assert.equal(await run(hint),false);
    await run('window.scene("none")');
    await until(hint);
    await shot('desktop-suggestion-hint');
    await key('Tab');await until(input+'.value==="Measure again"');
    await shot('desktop-suggestion-filled');
    await run('(()=>{const el='+input+';Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"");el.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await until(input+'.value===""');
    assert.equal(await run(hint),false,'clearing the filled draft keeps the hint dismissed');
    await run('window.steps()');await until(hint);
    await key('Escape');await until('!'+hint);
    await shot('desktop-suggestion-dismissed');
    await run('window.steps()');await until(hint);
    await choose('off');await until('!'+hint);
    await choose('decision_card');
    await run('window.scene("fix_checks")');
    await until('document.querySelector(".reply-decision small")?.textContent==="1 model turn"');
    await click(card+' summary');
    assert.match(await run('document.querySelector(".reply-decision pre").innerText'),/Windows failed/);
    await click(card+' .primary');await until('!document.querySelector(".reply-decision")');
    assert.equal(await run('window.actions.at(-1)'),'fix_checks');
    assert.deepEqual(await run('window.expected.at(-1)'),shownKey);
    // What GitHub would refuse is on the card before any tap: the button is off and says why.
    for (const [scene, why] of [['ship_blocked','main has no required checks on GitHub'],['ship_conflict','It conflicts with main']]) {
      await run('window.scene('+JSON.stringify(scene)+')');
      await until('document.querySelector(".reply-decision .primary")?.disabled===true');
      assert.equal(await run('document.querySelector(".reply-decision small").textContent'),why);
      assert.equal(await run('document.querySelectorAll(".reply-decision .pull-status li").length'),4);
      assert.equal(await run('document.querySelectorAll(".reply-decision .pull-status li.bad").length'),1);
      const before = await run('window.actions.length');
      await click(card+' .primary');await frame();
      assert.equal(await run('window.actions.length'),before,'a disabled Ship it sends nothing');
      await shot('desktop-'+scene.replace('_','-'));
    }
    await run('window.scene("ship_waiting")');
    await until('document.querySelector(".reply-decision .primary")?.textContent==="Ship when checks pass"');
    assert.equal(await run('document.querySelector(".reply-decision .primary").disabled'),false);
    await shot('desktop-ship-waiting');
    await click(card+' .primary');
    await until('document.querySelector(".reply-decision .primary")?.textContent==="Cancel"');
    assert.equal(await run('window.actions.at(-1)'),'merge_ready');
    await click(card+' .primary');await until('!document.querySelector(".reply-decision")');
    await run('window.scene("question")');
    await until('document.querySelector(".reply-decision .primary")?.textContent==="Add logging"');
    await click(card+' .primary');await until('!document.querySelector(".reply-decision")');
    assert.deepEqual(await run('window.actions.at(-1)'),{id:'r',text:'Add logging',targets:['bot'],decisionKey:'question-1'});
    await run('window.scene("question")');await until('!!document.querySelector(".reply-decision .dismiss")');
    await click(card+' .dismiss');await until('!document.querySelector(".reply-decision")');
    assert.equal(await run('window.actions.at(-1)'),'question-1');
  `, { plugins: [fixture] });
});

test('the pull request card in the assistant conversation ships, cancels and reports', { timeout: 150000 }, async () => {
  await withAppearanceApp('ship-offers-desktop', String.raw`
    await run('window.scene("none");window.alfred()');
    await until('document.querySelectorAll("#alfred .ship-offer").length===4');
    const cardAt = n => '#alfred .ship-offer:nth-child('+n+')';
    const text = selector => run('document.querySelector('+JSON.stringify(selector)+')?.textContent');
    const click = selector => run('document.querySelector('+JSON.stringify(selector)+').click()');
    await shot('assistant-ship-cards');
    // Ready: one tap, for the commit the card showed.
    assert.equal(await text(cardAt(1)+' .primary'),'Ship it');
    // What the Mac itself says this pull request is, beside the assistant's words.
    assert.equal(await text(cardAt(1)+' .source'),'example/deck · fix/alert · commit aaaaaaaa');
    assert.equal(await run('document.querySelectorAll('+JSON.stringify(cardAt(1)+' .pull-status li')+').length'),4);
    await run('(()=>{const b=document.querySelector('+JSON.stringify(cardAt(1)+' .primary')+');b.click();b.click();})()');
    await until('!!document.querySelector('+JSON.stringify(cardAt(1)+' .result')+')');
    assert.deepEqual(await run('window.shipped'),[{pr:84,head:'a'.repeat(40)}]);
    assert.match(await text(cardAt(1)+' .result'),/^Deck is merging PR #84/);
    // Blocked: off, with the reason beside it.
    assert.equal(await run('document.querySelector('+JSON.stringify(cardAt(2)+' .primary')+').disabled'),true);
    assert.equal(await text(cardAt(2)+' small'),'main has no required checks on GitHub');
    await click(cardAt(2)+' .primary');
    assert.equal(await run('window.shipped.length'),1);
    // In flight: Cancel names the merge request the card showed.
    assert.equal(await text(cardAt(3)+' button'),'Cancel');
    await click(cardAt(3)+' button');
    await until('window.shipped.length===2');
    assert.deepEqual(await run('window.shipped[1]'),{room:'r',expected:{repo:'example/deck',branch:'fix/alert',root:'/repo',generation:1,head:'a'.repeat(40)}});
    // Merged: the result, and nothing to press.
    assert.match(await text(cardAt(4)+' strong'),/^Merged PR #84 into main at 1a2b3c4d\. Your Mac's main is updated and your 3 local changes there were kept\./);
    assert.equal(await run('document.querySelectorAll('+JSON.stringify(cardAt(4)+' button')+').length'),0);
    // A refusal from the Mac is shown on the card.
    await run('window.refuse=true');
    await click(cardAt(1)+' .primary');
    await until('document.querySelector('+JSON.stringify(cardAt(1)+' .result.error')+')?.textContent.includes("Nothing was merged")');
    await shot('assistant-ship-refused');
  `, { plugins: [fixture] });
});
