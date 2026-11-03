import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { transform } from 'sucrase';
import { projectIdentityKey } from '../src/assistantIdentity.ts';
import { workspaceTaskHostMatches, guardWorkspaceTaskBackend } from '../src/workspaceTasks.ts';
const source=await fs.readFile(new URL('../src/WorkspaceTaskDetails.tsx',import.meta.url),'utf8');
const code=transform(source.replace(/^import .*;\n/gm,'').replace(/export (function|const)/g,'$1'),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const project={hostId:'host',workspaceId:'project',cwd:'/project'},assistant={hostId:'host',assistantId:'assistant'},record={id:'assistant',hostId:'host',name:'Alfred',revision:2,projects:[]};
const row={key:'task',source:'project',taskId:'task',owner:{...project,conversationId:'monitor'},project,assistant,verifiedHostId:'host',offline:false};
const backend={supports:()=>false,host:{connection:{get:()=>({status:{kind:'connected',hostId:'host'}})}}};
function detail(props){let stateIndex=0;const useState=initial=>[stateIndex++===0?record:typeof initial==='function'?initial():initial,()=>{}];const Projects=()=>null;const component=new Function('React','useState','useMemo','useEffect','AssistantProjects','workspaceTaskHostMatches','guardWorkspaceTaskBackend','projectIdentityKey','PROJECT_MEMORY_CAPABILITY',`${code};return WorkspaceTaskDetails;`)(React,useState,fn=>fn(),()=>{},Projects,workspaceTaskHostMatches,guardWorkspaceTaskBackend,projectIdentityKey,'assistant_project_memory_v1');return component({row,backend,profiles:[],...props});}
test('linked task details forward project, notebook, worker creation and keep-conversation actions',async()=>{
 const calls=[];const profile={id:'worker',display_name:'Worker'};
 const rendered=detail({onOpenProject:project=>calls.push(['project',project]),onOpenNotebook:project=>calls.push(['notebook',project]),onCreateWorkerThread:async(project,profile)=>{calls.push(['worker',project,profile]);return 'new-thread';},onKeepThread:(project,id)=>calls.push(['keep',project,id])});
 assert.equal(typeof rendered.props.onCreateWorkerThread,'function');
 assert.equal(await rendered.props.onCreateWorkerThread(project,profile),'new-thread');
 rendered.props.onOpenProject(project);rendered.props.onOpenNotebook(project);rendered.props.onKeepThread(project,'thread');
 assert.deepEqual(calls,[['worker',project,profile],['project',project],['notebook',project],['keep',project,'thread']]);
});
