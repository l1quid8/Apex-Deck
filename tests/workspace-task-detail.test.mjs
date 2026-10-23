import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { transform } from 'sucrase';
import { personalTaskForRow } from '../src/workspaceTasks.ts';
const source=await fs.readFile(new URL('../src/PersonalWorkspaceTaskDetail.tsx',import.meta.url),'utf8');
const code=transform(source.replace(/^import .*;\n/gm,'').replace(/export (function|const)/g,'$1'),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const Detail=new Function('React','useState','personalTaskForRow','TASK_STATUS',`${code}; return PersonalWorkspaceTaskDetail;`)(React,initial=>[initial,()=>{}],personalTaskForRow,{needsYou:'Needs you'});
const row={source:'personal',assistant:{hostId:'owner',assistantId:'asst-1'},taskId:'pt-1',offline:false};
const task={id:'pt-1',goal:'Original work',status:'needsYou',completionCriteria:[],receipts:[],decision:{id:'decision-1',paramsHash:'sha256:original',status:'open',prompt:'Approve original?'}};
function buttons(node) { if(!node||typeof node!=='object')return[];if(Array.isArray(node))return node.flatMap(buttons);return [...(node.type==='button'?[node]:[]),...buttons(node.props?.children)]; }
test('task detail approves the inspected owner decision hash and cancels only its own task',async()=>{
 const called=[]; const lane={assistant:{hostId:'owner',id:'asst-1',tasks:[task]},offline:false,decide:async(...args)=>{called.push(['decide',...args]);},cancel:async(...args)=>{called.push(['cancel',...args]);}};
 const controls=buttons(Detail({row,lane}));
 controls.find(button=>button.props.children==='Approve').props.onClick(); await Promise.resolve();
 controls.find(button=>button.props.children==='Cancel task').props.onClick(); await Promise.resolve();
 assert.deepEqual(called,[['decide','decision-1','sha256:original',true],['cancel','pt-1']]);
});
test('offline details disable every mutation even with cached approvals',()=>{
 const controls=buttons(Detail({row:{...row,offline:true},lane:{assistant:{hostId:'owner',id:'asst-1',tasks:[task]},offline:false}}));
 assert.equal(controls.length,3);assert.ok(controls.every(button=>button.props.disabled));
});
test('same task ID on another assistant never exposes its approval controls',()=>{
 const controls=buttons(Detail({row,lane:{assistant:{hostId:'owner',id:'asst-2',tasks:[task]},offline:false}}));
 assert.equal(controls.length,0);
});
