import test from 'node:test';
import * as workspaceModel from '../src/assistantWorkspaceModel.ts';
import assert from 'node:assert/strict';
import { assistantNavigation, runtimeProfile, validateAssistantDraft, textModels, reconcileEffort, rosterMessage } from '../src/assistantWorkspaceModel.ts';
const a={hostId:'mac',assistantId:'a'},b={hostId:'mac',assistantId:'b'};
test('assistant navigation and Back retain owner and never mutate global panel state',()=>{
 const panel={open:true,active:'dashboard'};const state={mainView:{kind:'workspace'},panel};
 const selected=assistantNavigation(state,{kind:'open',assistant:a});assert.deepEqual(selected.panel,panel);
 const settings=assistantNavigation(selected,{kind:'section',section:'settings'});assert.deepEqual(settings.mainView,{kind:'assistant',assistant:a,section:'settings',previousSections:['chat']});
 assert.deepEqual(assistantNavigation(settings,{kind:'back'}).mainView,{kind:'assistant',assistant:a,section:'chat'});
 assert.deepEqual(assistantNavigation(settings,{kind:'open',assistant:b}).mainView.assistant,b);
});
test('runtime preserves legacy metadata and access while selecting offered model and effort',()=>{
 const p={id:'legacy',display_name:'Old',persona:'Legacy worker metadata',backend:{kind:'agent',tool:'codex',model:'old'},access:'ask',effort:'high',custom:'untouched'};
 const result=runtimeProfile(p,'New','new','full','low');assert.equal(result.persona,p.persona);assert.equal(result.custom,'untouched');assert.equal(result.access,'full');assert.equal(result.backend.model,'new');assert.equal(p.backend.model,'old');
 assert.deepEqual(textModels([{id:'text'},{id:'image',kind:'image'},{id:'video',kind:'video'}]).map(m=>m.id),['text']);
 assert.equal(reconcileEffort('high',{id:'new',efforts:['low']}), 'low');assert.equal(reconcileEffort('high',{id:'unknown'}),null);assert.equal(reconcileEffort('high',{id:'none',efforts:[]}),null);
});
test('invalid name, runtime or hex blocks save with concrete reason',()=>{
 const valid={name:'Null',color:'#aabbcc',profile:{backend:{kind:'agent',tool:'codex',model:'gpt'},access:'full'},model:{id:'gpt',efforts:['low']},effort:'low',providerReady:true};
 assert.equal(validateAssistantDraft(valid),null);assert.match(validateAssistantDraft({...valid,name:'x'.repeat(65)}),/64/);assert.equal(validateAssistantDraft({...valid,name:'😀'.repeat(64)}),null);assert.match(validateAssistantDraft({...valid,name:' '}),/name/i);assert.match(validateAssistantDraft({...valid,color:'#zzzzzz'}),/six/i);assert.match(validateAssistantDraft({...valid,providerReady:false}),/provider/i);assert.match(validateAssistantDraft({...valid,effort:'max'}),/reasoning/i);
});
test('roster empty, offline and errors have honest states',()=>{
 assert.match(rosterMessage([],[]),/No assistants/);assert.match(rosterMessage([],[{state:'error',problem:'Credentials unavailable'}]),/Credentials unavailable/);assert.match(rosterMessage([],[{state:'offline'}]),/offline/i);assert.equal(rosterMessage([{name:'Null'}],[]),null);
});

test('project resolution requires authenticated host, exact workspace and folder',()=>{
 assert.equal(typeof workspaceModel.resolveAssistantProject,'function');
 const rows=[{id:'shared',hostId:'route-a',path:'/a',name:'A'},{id:'shared',hostId:'route-b',path:'/b',name:'B'}];
 const hosts=id=>({'route-a':'host-a','route-b':'host-b'})[id];const resolve=p=>workspaceModel.resolveAssistantProject(p,rows,hosts);
 assert.equal(resolve({hostId:'host-b',workspaceId:'shared',cwd:'/b'}),rows[1]);assert.equal(resolve({hostId:'host-b',workspaceId:'shared',cwd:'/a'}),null);assert.equal(resolve({hostId:'host-b',workspaceId:'changed',cwd:'/b'}),null);assert.equal(resolve({hostId:'route-b',workspaceId:'shared',cwd:'/b'}),null);
 assert.equal(workspaceModel.resolveAssistantProject({hostId:'host-b',workspaceId:'shared',cwd:'/b'},rows,()=>undefined),null);assert.equal(workspaceModel.resolveAssistantProject({hostId:'host-b',workspaceId:'shared',cwd:'/b'},[{...rows[1],hidden:true}],hosts),null);
});
test('Memory and Settings Back restore preceding subviews including nested overflow navigation',()=>{
 let state={mainView:{kind:'assistant',assistant:a,section:'work'}};
 state=assistantNavigation(state,{kind:'section',section:'memory'});state=assistantNavigation(state,{kind:'section',section:'settings'});
 state=assistantNavigation(state,{kind:'back'});assert.equal(state.mainView.section,'memory');state=assistantNavigation(state,{kind:'back'});assert.equal(state.mainView.section,'work');
});

test('settings completion navigates only its captured owner and expected section',()=>{
 const saved=workspaceModel.assistantSettingsSaved;assert.equal(typeof saved,'function');const other={kind:'assistant',assistant:b,section:'settings'};assert.equal(saved(other,a),other);
 const left={kind:'assistant',assistant:a,section:'work'};assert.equal(saved(left,a),left);assert.equal(saved({kind:'assistant',assistant:a,section:'settings'},a).section,'chat');
});

test('canonical project metadata reconciles host path aliases without accepting a different owner',()=>{
 const w={id:'w',hostId:'route',path:'/tmp/p',name:'P'},p={hostId:'host',workspaceId:'w',cwd:'/private/tmp/p'};const host=()=> 'host';const resolve=(metadata)=>workspaceModel.resolveAssistantProject(p,[w],host,()=>metadata);
 assert.equal(resolve(p),w);assert.equal(resolve({...p,hostId:'other'}),null);assert.equal(resolve({...p,workspaceId:'other'}),null);assert.equal(resolve({...p,cwd:'/elsewhere'}),null);assert.equal(workspaceModel.resolveAssistantProject(p,[w],()=>undefined,()=>p),null);
});

test('host folder read proves an ambiguous binding and rejects late path or authenticated identity changes',async()=>{
 const resolve=workspaceModel.resolveAssistantProjectFolder;assert.equal(typeof resolve,'function');const project={hostId:'host',workspaceId:'w',cwd:'/private/tmp/p'},workspace={id:'w',hostId:'route',path:'/tmp/p',name:'P'};let status={kind:'connected',hostId:'host'};let finish;let calls=0;let current=true;
 const backend={host:{connection:{get:()=>({status})}},listFolder:path=>{assert.equal(path,'/tmp/p');calls++;return new Promise(r=>{finish=r;});}};
 let pending=resolve(project,workspace,backend,()=>current);finish({path:'/private/tmp/p'});assert.deepEqual(await pending,project);
 pending=resolve(project,workspace,backend,()=>current);current=false;finish({path:'/private/tmp/p'});assert.equal(await pending,null);
 current=true;pending=resolve(project,workspace,backend,()=>current);status={kind:'connected',hostId:'other'};finish({path:'/private/tmp/p'});assert.equal(await pending,null);
 status={kind:'connected',hostId:'host'};pending=resolve(project,workspace,backend,()=>current);finish({path:'/different'});assert.equal(await pending,null);
 assert.equal(await resolve({...project,hostId:'other'},workspace,backend,()=>true),null);assert.equal(calls,4);
});

test('fresh unassigned projects are canonicalized by their authenticated host without a task snapshot or coordinator',async()=>{
 const workspace={id:'fresh-project',hostId:'local',path:'/Users/tylercaldwell/apex-assistant/fidelity-qa',name:'fidelity-qa'};
 const reads=[];let status={kind:'connected',hostId:'mac-host'};let current=true;let finish;
 const backend={host:{connection:{get:()=>({status})}},listFolder:path=>{reads.push(path);return new Promise(resolve=>{finish=resolve;});}};
 let pending=workspaceModel.discoverAssistantProjectFolder(workspace,'mac-host',backend,()=>current);finish({path:workspace.path});
 assert.deepEqual(await pending,{hostId:'mac-host',workspaceId:workspace.id,cwd:workspace.path});assert.deepEqual(reads,[workspace.path]);
 pending=workspaceModel.discoverAssistantProjectFolder(workspace,'mac-host',backend,()=>current);current=false;finish({path:workspace.path});assert.equal(await pending,null);
 current=true;pending=workspaceModel.discoverAssistantProjectFolder(workspace,'mac-host',backend,()=>current);status={kind:'connected',hostId:'replacement-host'};finish({path:workspace.path});assert.equal(await pending,null);
 status={kind:'connected',hostId:'mac-host'};pending=workspaceModel.discoverAssistantProjectFolder(workspace,'mac-host',backend,()=>current);finish({path:'relative/path'});await assert.rejects(pending,/absolute/);
 assert.equal(await workspaceModel.discoverAssistantProjectFolder({...workspace,hidden:true},'mac-host',backend,()=>true),null);
});

test('cold restart restores the exact selected assistant and section while retaining unrelated sidebar preferences',()=>{
 const items=new Map([['apex-right-panel',JSON.stringify({open:true,active:'dashboard'})]]);
 const storage={getItem:key=>items.get(key)??null,setItem:(key,value)=>items.set(key,value)};
 for(const section of ['chat','work','memory','settings']){
  workspaceModel.saveMainView({kind:'assistant',assistant:b,section,previousSections:['work'],grants:['ignored']},storage);
  assert.deepEqual(workspaceModel.loadMainView(storage),{kind:'assistant',assistant:b,section});
 }
 assert.equal(items.size,2);assert.equal(items.get('apex-right-panel'),JSON.stringify({open:true,active:'dashboard'}));
 workspaceModel.saveMainView({kind:'workspace'},storage);assert.deepEqual(workspaceModel.loadMainView(storage),{kind:'workspace'});
});
test('main-view persistence rejects malformed records and strips non-navigation data',()=>{
 for(const raw of [null,'bad JSON','null','[]','42',JSON.stringify({kind:'other'}),JSON.stringify({kind:'assistant',assistant:a,section:'admin'}),JSON.stringify({kind:'assistant',assistant:{hostId:' mac ',assistantId:'a'},section:'conversation'}),JSON.stringify({kind:'assistant',assistant:{hostId:'mac',assistantId:'a\u0000'},section:'conversation'}),JSON.stringify({kind:'assistant',assistant:{hostId:'mac'},section:'conversation'}),JSON.stringify({kind:'assistant',assistant:{hostId:'mac',assistantId:'a'.repeat(1025)},section:'conversation'})])assert.deepEqual(workspaceModel.parseMainView(raw),{kind:'workspace'});
 const record={kind:'assistant',assistant:{...a,role:'admin'},section:'settings',projects:[{tools:'full'}],previousSections:['memory']};assert.deepEqual(workspaceModel.parseMainView(JSON.stringify(record)),{kind:'assistant',assistant:a,section:'settings'});
 const unavailable={getItem(){throw new Error('storage disabled');},setItem(){throw new Error('storage disabled');}};assert.deepEqual(workspaceModel.loadMainView(unavailable),{kind:'workspace'});assert.doesNotThrow(()=>workspaceModel.saveMainView({kind:'assistant',assistant:a,section:'memory'},unavailable));
});

test('opening a project chooses and maximizes its own saved chat instead of the previously focused foreign thread',()=>{
 const workspace={id:'qa',hostId:'local',path:'/Users/tylercaldwell/apex-assistant/fidelity-qa',name:'fidelity-qa'};
 const unrelated={id:'apex-dot',workspaceId:'apex-deck',kind:'chat',title:'Apex-Dot'};
 const own={id:'qa-worker',workspaceId:'qa',kind:'chat',title:'QA worker'};
 const second={id:'qa-other',workspaceId:'qa',kind:'chat',title:'Other QA'};
 const result=workspaceModel.assistantProjectCanvasDestination(workspace,[unrelated,second,own],unrelated.id,[unrelated.id,own.id]);
 assert.equal(result.workspaceId,'qa');assert.equal(result.pane,own);assert.equal(result.focusedPane,own.id);assert.equal(result.maximized,own.id);assert.equal(result.section,'threads');assert.equal(result.picking,false);
 assert.equal(workspaceModel.assistantProjectCanvasDestination(workspace,[own,second],second.id,[own.id]).pane,second);
});

test('opening an empty project clears foreign focus and shows its picker without creating or reassigning any chat',()=>{
 const workspace={id:'qa',name:'QA',path:'/qa'},panes=[{id:'foreign',workspaceId:'other',kind:'chat',title:'Foreign'},{id:'terminal',workspaceId:'qa',kind:'terminal',title:'Terminal'},{id:'archived',workspaceId:'qa',kind:'chat',title:'Archived',archived:true},{id:'external',workspaceId:'qa',kind:'chat',title:'External'}];
 const before=structuredClone(panes);const result=workspaceModel.assistantProjectCanvasDestination(workspace,panes,'foreign',['foreign'],new Set(['external']));
 assert.deepEqual(result,{workspaceId:'qa',pane:null,focusedPane:null,maximized:null,picking:true,section:'threads'});assert.deepEqual(panes,before);
 const closed={id:'closed',workspaceId:'qa',kind:'chat',title:'Saved',closed:true};assert.equal(workspaceModel.assistantProjectCanvasDestination(workspace,[closed],'foreign',[]).pane,closed);
 assert.throws(()=>workspaceModel.assistantProjectCanvasDestination({...workspace,hidden:true},panes,null,[]),/unavailable/);
});

test('worker thread route isolates the exact task pane and rejects foreign or unavailable pane identities',()=>{
 const workspace={id:'qa',name:'QA',path:'/qa'},foreign={id:'old-thread',workspaceId:'apex-deck',kind:'chat',title:'Apex Dot'},other={id:'qa-other',workspaceId:'qa',kind:'chat',title:'Other QA'},worker={id:'execution-task-4',workspaceId:'qa',kind:'chat',title:'Task 4',closed:true};
 const result=workspaceModel.assistantWorkerThreadDestination(workspace,worker.id,[foreign,other,worker]);assert.equal(result.pane,worker);assert.equal(result.focusedPane,worker.id);assert.equal(result.maximized,worker.id);assert.equal(result.picking,false);assert.equal(result.workspaceId,'qa');
 assert.equal(workspaceModel.assistantWorkerThreadDestination(workspace,foreign.id,[foreign,other,worker]),null);assert.equal(workspaceModel.assistantWorkerThreadDestination(workspace,worker.id,[worker],new Set([worker.id])),null);assert.equal(workspaceModel.assistantWorkerThreadDestination({...workspace,hidden:true},worker.id,[worker]),null);
});

test('legacy sections migrate to Chat and Work',()=>{
 const view=section=>workspaceModel.parseMainView(JSON.stringify({kind:'assistant',assistant:{hostId:'h',assistantId:'a'},section}));
 assert.equal(view('conversation').section,'chat');assert.equal(view('projects').section,'work');assert.equal(view('activity').section,'work');
 assert.equal(view('memory').section,'memory');assert.equal(view('admin').kind,'workspace');
});
test('opening an assistant lands on chat; memory then back returns to work',()=>{
 const a={hostId:'h',assistantId:'a'};let state=workspaceModel.assistantNavigation({mainView:{kind:'workspace'}},{kind:'open',assistant:a});assert.equal(state.mainView.section,'chat');
 state=workspaceModel.assistantNavigation(state,{kind:'section',section:'work'});state=workspaceModel.assistantNavigation(state,{kind:'section',section:'memory'});
 assert.equal(workspaceModel.assistantNavigation(state,{kind:'back'}).mainView.section,'work');
});

test('dirtyFields lists changed settings in page order',()=>{
 const saved={name:'A',model:'m1',effort:'low',access:'ask',projects:['/a'],look:{seed:'s',color:'#111111',kind:'pixel'}};
 assert.deepEqual(workspaceModel.dirtyFields(saved,{...saved}),[]);
 assert.deepEqual(workspaceModel.dirtyFields(saved,{...saved,model:'m2',effort:'high'}),['Model','Reasoning']);
 assert.deepEqual(workspaceModel.dirtyFields(saved,{...saved,name:'B',look:{...saved.look,color:'#222222'},access:'full',projects:['/a','/b']}),['Name','Avatar','Project tools','Projects']);
 assert.deepEqual(workspaceModel.dirtyFields(saved,{...saved,projects:['/a']}),[],'same projects in a new array is not a change');
});
test('an unchanged image avatar is not counted as a change',()=>{
 const look=()=>({seed:'s',color:'#111111',kind:'image',image:{assetId:'a1',sha256:'x'}});
 const saved={name:'A',model:'m',effort:null,access:'ask',projects:[],look:look()};
 assert.deepEqual(workspaceModel.dirtyFields(saved,{...saved,look:look()}),[]);
 assert.deepEqual(workspaceModel.dirtyFields(saved,{...saved,look:{...look(),image:{assetId:'a2',sha256:'y'}}}),['Avatar']);
});
