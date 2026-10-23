import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'sucrase';
import * as model from '../src/workspaceTasks.ts';
import * as identity from '../src/assistantIdentity.ts';
const source=await fs.readFile(new URL('../src/WorkspaceTasksScreen.tsx',import.meta.url),'utf8');
const code=transform(source.replace(/^import .*;\n/gm,'').replace(/export (function|const)/g,'$1'),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const {WorkspaceTasks}=new Function('React','useState','model','identity',`const {filterWorkspaceTasks}=model; const {assistantIdentityKey,projectIdentityKey}=identity; ${code}; return {WorkspaceTasks};`)(React,React.useState,model,identity);
const row={key:'row',source:'project',assistant:null,project:{hostId:'host',workspaceId:'project',cwd:'/project'},taskId:'t1',title:'Preserve owner',status:'queued',updatedAt:100,observedAt:200,offline:true,group:'working',assistantName:'Unassigned',projectName:'Project',owner:{hostId:'host',workspaceId:'project',cwd:'/project',conversationId:'m1'},revision:4};
test('global task list labels filters, owner, stale observation and real lifecycle without a composer',()=>{
  const html=renderToStaticMarkup(React.createElement(WorkspaceTasks,{rows:[row],renderDetail:()=>null}));
  for(const label of ['Search tasks','Filter by assistant','Filter by project','Task status']) assert.match(html,new RegExp(`aria-label="${label}"`));
  assert.match(html,/Preserve owner/); assert.match(html,/Project/); assert.match(html,/Unassigned/); assert.match(html,/Offline/); assert.match(html,/Last updated/);
  assert.match(html,/Working/); assert.doesNotMatch(html,/<textarea|contenteditable|Send message/);
});
test('global empty state distinguishes no tasks from unavailable sources',()=>{
  const html=renderToStaticMarkup(React.createElement(WorkspaceTasks,{rows:[],problems:['Project host unavailable'],renderDetail:()=>null}));
  assert.match(html,/Project host unavailable/); assert.match(html,/No saved tasks/);
});
