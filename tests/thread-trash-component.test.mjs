import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {chatKey} from '../src/desktopChats.ts';
import {trashRows} from '../src/threadTrash.ts';
import {emptyCatalog,parseChatList,withListedRooms} from '../src/chatCatalog.ts';
const require=createRequire(import.meta.url);
const {transform}=require('sucrase');
const source=fs.readFileSync(new URL('../src/ThreadTrashPanel.tsx',import.meta.url),'utf8');
const code=transform(source.replace(/^import .*;\n/gm,'').replace(/^export /gm,''),{transforms:['typescript','jsx','imports'],jsxRuntime:'automatic',production:true}).code;
const make=useState=>new Function('require','useState','chatKey','trashRows',`${code};return ThreadTrash;`)(require,useState,chatKey,trashRows);
const ThreadTrash=make(React.useState);
function chats(supported,online,count=2){
 let catalog=emptyCatalog();
 for(const host of ['local','remote'])catalog=withListedRooms(catalog,host,host,parseChatList(host,{rooms:Array.from({length:count},(_,i)=>({id:`same-${i}`,kind:i%2?'chat':'work',trashedAt:i+1,title:`Saved ${i}`}))}),1);
 return {catalog,backendOf:()=>({supports:()=>supported}),online:()=>online,machineName:id=>id==='local'?'This Mac':'Other Mac'};
}

test('native recovery list names the owning machine, bounds its rows, and exposes only Restore',()=>{
 const html=renderToStaticMarkup(React.createElement(ThreadTrash,{chats:chats(true,true,30),onRestore:async()=>{}}));
 assert.match(html,/Trash \(60\)/);assert.match(html,/This Mac/);assert.match(html,/Other Mac/);
 assert.equal((html.match(/aria-label="Restore /g)||[]).length,50);
 assert.match(html,/Show more \(10\)/);assert.doesNotMatch(html,/Delete|Erase|Open thread/);
 assert.match(html,/leaves it closed/);
});

test('offline and older hosts have disabled Restore with an actionable reason',()=>{
 for(const [supported,online,reason]of [[false,true,/Update Apex Deck/],[undefined,true,/Update Apex Deck/],[true,false,/Reconnect/]]){
  const html=renderToStaticMarkup(React.createElement(ThreadTrash,{chats:chats(supported,online,1),onRestore:async()=>{}}));
  assert.match(html,/<button[^>]*disabled=""/);assert.match(html,reason);
 }
});

test('Restore selects the exact row when two machines share a room id and never opens it',async()=>{
 const states=[];const Panel=make(initial=>[initial,value=>states.push(value)]);
 const calls=[];const tree=Panel({chats:chats(true,true,1),onRestore:async row=>calls.push([row.hostId,row.id])});
 const buttons=[];const walk=node=>{if(Array.isArray(node))return node.forEach(walk);if(!node||typeof node!=='object')return;if(node.type==='button')buttons.push(node);walk(node.props?.children);};walk(tree);
 assert.equal(buttons.length,2);
 buttons[1].props.onClick();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,[['remote','same-0']]);
 assert.ok(states.includes(chatKey({hostId:'remote',room:'same-0'})));assert.equal(states.at(-1),null);
});
