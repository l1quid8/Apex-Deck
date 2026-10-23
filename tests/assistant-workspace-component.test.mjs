import {assistantTextProvider,assistantRuntimeModels,loadAssistantRuntimeProviders} from '../src/assistantRuntime.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {assistantAppearance,createAssistantAppearance,projectIdentityKey} from '../src/assistantIdentity.ts';
import {runtimeProfile,textModels,reconcileEffort,validateAssistantDraft,dirtyFields} from '../src/assistantWorkspaceModel.ts';
import {providerEnabled,providerForConfig} from '../src/providers.ts';
import {CALL_VOICES,defaultVoiceOf,readVoiceSettings} from '../src/voice/settings.ts';
import {CALL_LOOKS,voiceLabel} from '../src/voice/callView.ts';
import {AGENT_COLORS} from '../src/identicon.ts';
import {assistantStatus,accessLabel} from '../src/assistantStatus.ts';
const {transform}=createRequire(import.meta.url)('sucrase');
const source=['AssistantEditor.tsx','AssistantWorkspace.tsx'].map(file=>fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8').replace(/^export \{.*$/gm,'').replace(/^export type \{.*$/gm,'')).join('\n');
const compiled=transform(source.replace(/^import .*;\n/gm,'').replace(/^export /gm,''),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)})};
const text=n=>typeof n==='string'||typeof n==='number'?String(n):n?.children?.map(text).join('')??'';
const find=(n,p)=>!n||typeof n!=='object'?null:p(n)?n:[...(n.children??[]),n.props?.pixelControls].map(c=>find(c,p)).find(Boolean)??null;
const all=(n,p)=>!n||typeof n!=='object'?[]:[...(p(n)?[n]:[]),...[...(n.children??[]),n.props?.pixelControls].flatMap(c=>all(c,p))];
const VoiceSampleButton=()=>null;
const Avatar=()=>null, HexColorPicker=()=>null,PersonalPanels=()=>null,PersonalBrowser=()=>null,AssistantAvatarEditor=()=>null;
const profile={id:'legacy',display_name:'Legacy',persona:'Legacy metadata retained',backend:{kind:'agent',tool:'claude_code',model:'old'},effort:'high',access:'ask',legacyLabel:'old custom label'};
const record={id:'a',hostId:'mac',revision:7,name:'Null',style:'Saved legacy style',look:{seed:'saved-seed',color:'#aabbcc',shape:'legacy-shape'},profile,messages:[],tasks:[],projects:[]};
function mount(overrides={}){
 const calls=[];const backend={sessionLoad:async()=>({profiles:[profile]}),detectAgents:async()=>[{key:'claude',label:'Claude Code',program:'claude',found:true}],agentModels:async()=>[{id:'old',efforts:['low','high']},{id:'new',efforts:['low']}],supports:()=>false,...overrides.backend};
 let durable=overrides.lane?.assistant??record;
 const configure=overrides.lane?.configureWorkspace;
 const lane={name:'Null',hostName:'Mac',assistant:record,offline:false,...overrides.lane,configureWorkspace:async input=>{if(configure)await configure(input);else calls.push(input);durable={...durable,...input.settings,profile:input.profile??durable.profile,projects:input.projects??durable.projects,revision:input.expectedRevision+1};return durable;}};
 const props={backend,lane,hostId:'mac',profiles:[profile],projects:[],...overrides,backend,lane:overrides.lane===undefined&&Object.hasOwn(overrides,'lane')?undefined:lane};
 const states=[],deps=[],queued=[],cleanups=[];let cursor=0;
 const hooks={useRef(initial){const i=cursor++;return states[i]??(states[i]={current:initial});},useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],value=>states[i]=typeof value==='function'?value(states[i]):value];},useMemo(fn){cursor++;return fn();},useEffect(fn,next){const i=cursor++;if(!deps[i]||next.some((v,j)=>v!==deps[i][j])){deps[i]=next;queued.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
 const bindings={assistantTextProvider,assistantRuntimeModels,loadAssistantRuntimeProviders,VoiceSampleButton,CALL_VOICES,defaultVoiceOf,readVoiceSettings,CALL_LOOKS,voiceLabel,React,...hooks,Avatar,HexColorPicker,PersonalPanels,PersonalBrowser,AssistantAvatarEditor,assistantAppearance,createAssistantAppearance,projectIdentityKey,runtimeProfile,textModels,reconcileEffort,validateAssistantDraft,dirtyFields,providerEnabled,providerForConfig,AGENT_COLORS,createAssistantAvatarApi:()=>undefined,assistantStatus,accessLabel};
 const components=new Function(...Object.keys(bindings),`${compiled}\nreturn {AssistantEditor,AssistantWorkspace};`)(...Object.values(bindings));
 return{props,calls,unmount(){cleanups.forEach(fn=>fn?.());},render(){cursor=0;const tree=components.AssistantEditor(props);queued.splice(0).forEach(fn=>fn());return tree;},workspace(p){return components.AssistantWorkspace(p);},async ready(){for(let i=0;i<4;i++){this.render();await new Promise(r=>setImmediate(r));}return this.render();}};
}
const input=(tree,name)=>find(tree,n=>n.props?.['aria-label']===name);
const chooseFull=h=>{input(h.render(),'Project tools').props.onChange({target:{value:'full'}});find(h.render(),n=>n.type==='button'&&text(n)==='Use Full access').props.onClick();};
const submit=async h=>{find(h.render(),n=>n.type==='form').props.onSubmit({preventDefault(){}});await new Promise(r=>setImmediate(r));};
test('settings validates name, saves offered runtime and Full access, preserves legacy metadata and appearance',async()=>{
 const h=mount();let tree=await h.ready();assert.doesNotMatch(text(tree),/Team Member Type|Work brief.*textarea/i);
 input(tree,'Assistant name').props.onChange({target:{value:' '}});assert.equal(find(h.render(),n=>n.type==='button'&&n.props.type==='submit').props.disabled,true);
 input(h.render(),'Assistant name').props.onChange({target:{value:'Renamed'}});chooseFull(h);
 input(h.render(),'Assistant model').props.onChange({target:{value:'new'}});assert.equal(input(h.render(),'Assistant reasoning').props.value,'low');
 await submit(h);const saved=h.calls[0];assert.equal(saved.expectedRevision,7);assert.equal(saved.settings.name,'Renamed');assert.equal(saved.profile.backend.model,'new');assert.equal(saved.profile.access,'full');assert.equal(saved.profile.effort,'low');assert.equal(saved.profile.persona,profile.persona);assert.equal(saved.profile.legacyLabel,profile.legacyLabel);assert.deepEqual(saved.settings.look,record.look.kind?record.look:{...record.look,kind:'pixel'});
 const reloaded=mount({lane:{assistant:{...record,revision:8,name:saved.settings.name,profile:saved.profile,look:saved.settings.look}}});tree=await reloaded.ready();assert.equal(input(tree,'Assistant name').props.value,'Renamed');assert.equal(input(tree,'Project tools').props.value,'full');assert.equal(input(tree,'Assistant reasoning').props.value,'low');
});
test('invalid hex blocks Save and valid picker change persists color without changing seed',async()=>{
 const h=mount();let tree=await h.ready();const picker=find(tree,n=>n.type===HexColorPicker);picker.props.onValidityChange(false);await submit(h);assert.equal(h.calls.length,0);assert.match(text(h.render()),/six hexadecimal/);
 picker.props.onChange('#112233');picker.props.onValidityChange(true);tree=h.render();assert.equal(find(tree,n=>n.type===Avatar).props.color,'#112233');await submit(h);assert.equal(h.calls[0].settings.look.seed,'saved-seed');assert.equal(h.calls[0].settings.look.color,'#112233');assert.equal(h.calls[0].settings.look.shape,'legacy-shape');
});
test('missing credentials and unavailable models block saving the existing record',async()=>{
 const p={...profile,backend:{kind:'open_ai_compatible',base_url:'https://example.test/v1',api_key_env:'MISSING',model:'text'}};
 const h=mount({backend:{sessionLoad:async()=>({profiles:[p]}),apiKeyStatus:async()=>['missing'],apiModels:async()=>{throw new Error('must not discover without credential');}},lane:{assistant:{...record,profile:p}}});const tree=await h.ready();assert.match(text(tree),/credential is missing/);await submit(h);assert.equal(h.calls.length,0);
});
test('creation and Settings share ordered controls and create durable pixel/runtime fields only on Create',async()=>{
 const created=[];const h=mount({lane:undefined,onCreate:async value=>created.push(value)});let tree=await h.ready();assert.ok(text(tree).indexOf('Name')<text(tree).indexOf('Model'));assert.ok(text(tree).indexOf('Model')<text(tree).indexOf('In those projects it may'));assert.equal(created.length,0);
 input(tree,'Assistant name').props.onChange({target:{value:'Teammate'}});chooseFull(h);await submit(h);assert.equal(created[0].workspaceVersion,4);assert.equal(typeof created[0].avatarDraftId,'string');assert.equal(created[0].avatarGenerationId,undefined);assert.equal(created[0].avatarAssetId,undefined);assert.equal(created[0].profile.access,'full');assert.match(created[0].look.color,/^#[\da-f]{6}$/);assert.ok(created[0].look.seed);
 const current=text(await mount().ready());assert.ok(current.indexOf('Model')<current.indexOf('Projects & access'));assert.ok(current.indexOf('Projects & access')<current.indexOf('Tools & rules'));
});
test('a conflict changes no draft fields and retains the captured revision for explicit retry',async()=>{
 const h=mount({lane:{configureWorkspace:async()=>{throw new Error('Revision conflict; refresh and retry');}}});let tree=await h.ready();input(tree,'Assistant name').props.onChange({target:{value:'Keep my draft'}});await submit(h);tree=h.render();assert.equal(input(tree,'Assistant name').props.value,'Keep my draft');assert.match(text(tree),/Revision conflict/);assert.equal(record.name,'Null');
});
test('Memory and Settings are main-pane views with Back to the same conversation',()=>{
 const h=mount();const opened=[];const tree=h.workspace({lane:{name:'Null',hostName:'Mac'},section:'memory',onNavigate:s=>opened.push(s),onBack(){},chat:'Retained conversation',editor:'Settings editor',projects:[]});assert.equal(find(tree,n=>n.props.className==='assistant-workspace-content').props.hidden,true);find(tree,n=>n.type==='button'&&text(n)==='‹ Chat').props.onClick();assert.deepEqual(opened,['chat']);assert.equal(find(tree,n=>n.type===PersonalPanels).props.initial,'memory');
});

test('saved Keychain credentials are accepted and media models never enter the text picker',async()=>{
 const p={...profile,backend:{kind:'open_ai_compatible',base_url:'https://example.test/v1',api_key_env:'SAVED',model:'text'}};
 const h=mount({backend:{sessionLoad:async()=>({profiles:[p]}),apiKeyStatus:async()=>['saved'],apiModels:async()=>[{id:'text'},{id:'picture',kind:'image'},{id:'movie',kind:'video'}]},lane:{assistant:{...record,profile:p}}});
 const tree=await h.ready();assert.equal(input(tree,'Assistant model').props.disabled,false);assert.doesNotMatch(text(input(tree,'Assistant model')),/picture|movie/);assert.equal(all(input(tree,'Assistant reasoning'),n=>n.type==='option').length,1);await submit(h);assert.equal(h.calls[0].profile.backend.model,'text');assert.equal(h.calls[0].profile.effort,null);
});

const tick=()=>new Promise(r=>setImmediate(r));
test('a late save refreshes durable data but cannot navigate a newly opened owner editor',async()=>{
 let resolve;let committed=0;const navigation=[];
 const a=mount({lane:{configureWorkspace:()=>new Promise(r=>{resolve=r;})},onSaved:()=>navigation.push('a'),onCommitted:()=>committed++});
 await a.ready();await submit(a);a.unmount();
 const b=mount({lane:{assistant:{...record,id:'b',name:'B'}},onSaved:()=>navigation.push('b')});await b.ready();
 input(b.render(),'Assistant name').props.onChange({target:{value:'B unsaved'}});
 resolve();await tick();assert.deepEqual(navigation,[]);assert.equal(committed,1);assert.equal(input(b.render(),'Assistant name').props.value,'B unsaved');
});
test('leaving and reopening the same settings owner protects the new draft from late save',async()=>{
 let resolve;const navigation=[];const old=mount({lane:{configureWorkspace:()=>new Promise(r=>{resolve=r;})},onSaved:()=>navigation.push('old')});
 await old.ready();await submit(old);old.unmount();const reopened=mount();await reopened.ready();input(reopened.render(),'Assistant name').props.onChange({target:{value:'New draft'}});
 resolve();await tick();assert.deepEqual(navigation,[]);assert.equal(input(reopened.render(),'Assistant name').props.value,'New draft');
});
test('creation completion remains durable after navigation without stealing the active view',async()=>{
 let resolve;const created=[];const navigation=[];const h=mount({lane:undefined,onCreate:()=>new Promise(r=>{resolve=()=>{created.push('created');r({hostId:'mac',assistantId:'new'});};}),onSaved:ref=>navigation.push(ref)});
 await h.ready();input(h.render(),'Assistant name').props.onChange({target:{value:'New teammate'}});await submit(h);h.unmount();resolve();await tick();assert.deepEqual(created,['created']);assert.deepEqual(navigation,[]);
});
test('conflict refresh updates only the expected revision and preserves the complete draft for retry',async()=>{
 const requests=[];let conflict=true;const h=mount({backend:{call:async(cmd,args)=>{assert.equal(cmd,'personal_get');assert.equal(args.assistantId,'a');return {...record,revision:9,name:'Remote name'};}},lane:{configureWorkspace:async value=>{requests.push(value);if(conflict)throw new Error('The assistant changed. Refresh before saving this draft.');}}});
 await h.ready();input(h.render(),'Assistant name').props.onChange({target:{value:'Keep my draft'}});chooseFull(h);await submit(h);
 const refresh=find(h.render(),n=>n.type==='button'&&text(n).includes('Refresh revision'));assert.ok(refresh);await refresh.props.onClick();await tick();assert.equal(input(h.render(),'Assistant name').props.value,'Keep my draft');assert.equal(input(h.render(),'Project tools').props.value,'full');conflict=false;await submit(h);assert.equal(requests[1].expectedRevision,9);assert.equal(requests[1].settings.name,'Keep my draft');
});
test('applied image previews in Settings use the captured owner and generation',async()=>{
 const h=mount();let tree=await h.ready();const editor=find(tree,n=>n.type===AssistantAvatarEditor);const image={assetId:'asset',sha256:'hash',mime:'image/png',width:512,height:512};editor.props.onAppearanceChange({...editor.props.appearance,kind:'image',image});editor.props.onApply({kind:'image',generationId:'gen',assetId:'asset'});tree=h.render();
 for(const preview of all(tree,n=>n.type===Avatar)){assert.deepEqual(preview.props.draftImage,{owner:editor.props.owner,generationId:'gen'});assert.deepEqual(preview.props.image,image);}
});
test('cached CLI models cannot make a missing installation ready',async()=>{
 const h=mount({backend:{detectAgents:async()=>[{key:'claude',found:false,program:'claude',label:'Claude Code'}]}});const tree=await h.ready();assert.match(text(tree),/not installed/i);await submit(h);assert.equal(h.calls.length,0);
});

test('unproven changed folders retain their saved assignment and cannot add a duplicate binding',async()=>{
 const assigned={project:{hostId:'mac',workspaceId:'w',cwd:'/private/tmp/p'},tools:'ask'};const h=mount({projects:[{id:'w',path:'/tmp/p',name:'P'}],lane:{assistant:{...record,projects:[assigned]}}});const tree=await h.ready();assert.equal(find(tree,n=>n.type==='input'&&n.props.type==='checkbox').props.disabled,true);assert.match(text(tree),/folder.*verified/i);await submit(h);assert.deepEqual(h.calls[0].projects,[assigned]);
});

test('creation exposes an explicit folder boundary and later Settings can assign a project inside it',async()=>{
 for(const hostId of ['mac','remote-host']){
  const created=[];const h=mount({lane:undefined,hostId,onCreate:async value=>{created.push(value);}});let tree=await h.ready();const folder=input(tree,'Allowed project folder');assert.ok(folder);assert.equal(folder.props.value,'~/apex-assistant');assert.match(text(tree),/selected machine/i);
  input(tree,'Assistant name').props.onChange({target:{value:'Project teammate'}});folder.props.onChange({target:{value:' /Users/me/Downloads/work '}});chooseFull(h);await submit(h);assert.equal(created[0].folder,'/Users/me/Downloads/work');assert.deepEqual(created[0].projects,[]);
  const settings=mount({hostId,lane:{assistant:{...record,hostId,allowedFolders:[created[0].folder],projects:[]}},projects:[{id:'existing',name:'Existing project',path:'/Users/me/Downloads/work/existing'}]});tree=await settings.ready();const choice=find(tree,n=>n.type==='input'&&n.props.type==='checkbox');assert.equal(choice.props.disabled,false);choice.props.onChange({target:{checked:true}});await submit(settings);assert.deepEqual(settings.calls[0].projects,[{project:{hostId,workspaceId:'existing',cwd:'/Users/me/Downloads/work/existing'},tools:'ask'}]);assert.equal(settings.calls[0].settings.folder,undefined);
 }
});
test('blank, relative and control-character folder boundaries block creation without changing the default scope',async()=>{
 const created=[];const h=mount({lane:undefined,onCreate:async value=>created.push(value)});await h.ready();input(h.render(),'Assistant name').props.onChange({target:{value:'Teammate'}});
 for(const folder of ['', 'relative/project','~somebody/project','/projects/\u0000invalid']){input(h.render(),'Allowed project folder').props.onChange({target:{value:folder}});await submit(h);assert.equal(created.length,0);assert.match(text(h.render()),/full path|home-relative/i);}
 input(h.render(),'Allowed project folder').props.onChange({target:{value:'~/Documents/work'}});await submit(h);assert.equal(created[0].folder,'~/Documents/work');
});

 test('creation offers only text providers accepted by the assistant host',async()=>{
 const profiles=[
  {...profile,id:'codex',display_name:'Codex',backend:{kind:'agent',tool:'codex'}},
  {...profile,id:'grok',display_name:'Grok',backend:{kind:'agent',tool:'grok'}},
  {...profile,id:'gemini',display_name:'Gemini',backend:{kind:'agent',tool:'gemini'}},
  {...profile,id:'media',display_name:'Media',media:{kind:'image'},backend:{kind:'open_ai_compatible',base_url:'https://media.example/v1'}},
  profile,
  {...profile,id:'api',display_name:'Text API',backend:{kind:'open_ai_compatible',base_url:'https://text.example/v1'}},
 ];
 const h=mount({lane:undefined,backend:{sessionLoad:async()=>({profiles})}});
 const tree=await h.ready();
 const options=all(input(tree,'Assistant provider'),n=>n.type==='option').map(text);
 assert.deepEqual(options,['Codex · codex','Grok · grok','Gemini · gemini','Legacy · claude_code','Text API · api']);
 assert.equal(input(tree,'Assistant model').props.disabled,false);
 });


const textApi={id:'api',display_name:'Text API',persona:'',backend:{kind:'open_ai_compatible',base_url:'https://text.test/v1',api_key_env:'SAVED',model:'configured-text'},access:'ask'};
test('creation defaults to a verified text API ahead of a missing Claude install and preserves its offered configured model',async()=>{
 const created=[];let catalogs=0;let installations=0;
 const h=mount({lane:undefined,onCreate:async value=>created.push(value),backend:{sessionLoad:async()=>({profiles:[profile,textApi]}),detectAgents:async()=>{installations++;return[];},apiKeyStatus:async()=>['saved'],apiModels:async()=>{catalogs++;return[{id:'first-text'},{id:'configured-text',efforts:['low','high']},{id:'image-only',kind:'image'}];}}});
 let tree=await h.ready();assert.equal(input(tree,'Assistant provider').props.value,1);assert.equal(input(tree,'Assistant model').props.value,'configured-text');assert.equal(input(tree,'Assistant reasoning').props.value,'low');assert.equal(catalogs,1);assert.equal(installations,1);
 input(tree,'Assistant name').props.onChange({target:{value:'Working default'}});await submit(h);assert.equal(created.length,1);assert.equal(created[0].profile.backend.base_url,textApi.backend.base_url);assert.equal(created[0].profile.backend.model,'configured-text');
});
test('creation skips missing API credentials and image-only catalogs before using an installed Claude provider',async()=>{
 const missing={...textApi,id:'missing',backend:{...textApi.backend,base_url:'https://missing.test/v1',api_key_env:'MISSING'}};
 const images={...textApi,id:'images',backend:{...textApi.backend,base_url:'https://images.test/v1'}};
 const catalogs=[];
 const h=mount({lane:undefined,backend:{sessionLoad:async()=>({profiles:[missing,images,profile]}),apiKeyStatus:async([key])=>[key==='MISSING'?'missing':'saved'],apiModels:async url=>{catalogs.push(url);return[{id:'picture',kind:'image'}];}}});
 const tree=await h.ready();assert.equal(input(tree,'Assistant provider').props.value,2);assert.equal(input(tree,'Assistant model').props.value,'old');assert.equal(input(tree,'Assistant model').props.disabled,false);assert.deepEqual(catalogs,['https://images.test/v1']);
});
test('a late viable API discovery cannot override an explicit same-provider choice during creation',async()=>{
 let resolveCatalog;
 const h=mount({lane:undefined,backend:{sessionLoad:async()=>({profiles:[profile,textApi]}),detectAgents:async()=>[],apiKeyStatus:async()=>['saved'],apiModels:()=>new Promise(resolve=>{resolveCatalog=resolve;})}});
 h.render();await tick();h.render();await tick();assert.equal(typeof resolveCatalog,'function');
 input(h.render(),'Assistant provider').props.onChange({target:{value:'0'}});h.render();await tick();resolveCatalog([{id:'configured-text'}]);await tick();const tree=await h.ready();assert.equal(input(tree,'Assistant provider').props.value,0);assert.equal(input(tree,'Assistant model').props.disabled,true);assert.match(text(tree),/claude_code is not installed/);assert.doesNotMatch(text(tree),/Loading offered models/);
});
test('Settings keeps an unavailable saved provider instead of silently replacing it with an available API',async()=>{
 let catalogs=0;const h=mount({backend:{sessionLoad:async()=>({profiles:[profile,textApi]}),detectAgents:async()=>[],apiKeyStatus:async()=>['saved'],apiModels:async()=>{catalogs++;return[{id:'configured-text'}];}}});const tree=await h.ready();assert.equal(input(tree,'Assistant provider').props.value,0);assert.match(text(tree),/not installed/);assert.equal(catalogs,0);
});

test('Project tools offers exact mockup choices and Read only disables every saved and newly assigned project',async()=>{
 const projectA={hostId:'mac',workspaceId:'a',cwd:'/a'},projectB={hostId:'other',workspaceId:'b',cwd:'/b'};
 const h=mount({lane:{assistant:{...record,allowedFolders:['/c'],projects:[{project:projectA,tools:'full'},{project:projectB,tools:'ask'}]}},projects:[{id:'c',name:'New project',path:'/c'}]});let tree=await h.ready();
 assert.deepEqual(all(input(tree,'Project tools'),n=>n.type==='option').map(text),['Ask first','Full access','Read only']);
 input(tree,'Project tools').props.onChange({target:{value:'read'}});tree=h.render();find(tree,n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});await submit(h);
 assert.equal(h.calls[0].profile.access,'read');assert.equal(h.calls[0].projects.length,3);assert.ok(h.calls[0].projects.every(binding=>binding.tools==='off'));assert.deepEqual(h.calls[0].projects.map(binding=>binding.project),[projectA,projectB,{hostId:'mac',workspaceId:'c',cwd:'/c'}]);
 const reloaded=mount({lane:{assistant:{...record,profile:{...profile,access:'read'},projects:[{project:projectA,tools:'full'}]}}});await reloaded.ready();await submit(reloaded);assert.equal(reloaded.calls[0].projects[0].tools,'off');
});
test('legacy edits access stays explicit and is retained until the user chooses a supported mockup setting',async()=>{
 const binding={project:{hostId:'mac',workspaceId:'a',cwd:'/a'},tools:'ask'};
 const h=mount({lane:{assistant:{...record,profile:{...profile,access:'edits'},projects:[binding]}}});let tree=await h.ready();assert.equal(input(tree,'Project tools').props.value,'edits');assert.deepEqual(all(input(tree,'Project tools'),n=>n.type==='option').map(text),['Ask first','Full access','Read only','Allow edits (legacy)']);await submit(h);assert.equal(h.calls[0].profile.access,'edits');assert.deepEqual(h.calls[0].projects,[binding]);
 input(h.render(),'Project tools').props.onChange({target:{value:'ask'}});tree=h.render();assert.deepEqual(all(input(tree,'Project tools'),n=>n.type==='option').map(text),['Ask first','Full access','Read only']);await submit(h);assert.equal(h.calls[1].profile.access,'ask');assert.equal(h.calls[1].projects[0].tools,'ask');
});

test('failed and interrupted delegated work stays visible in assistant header attention status',()=>{
 for(const [status,label] of [['failed','Failed · 1'],['interrupted','Failed · 1'],['needs_clarification','Needs you · 1']]){
  const h=mount();const tree=h.workspace({lane:{name:'Null',hostName:'Mac',assistant:record,offline:false},section:'work',onNavigate(){},chat:'chat',work:'work',editor:'editor',delegatedTasks:[{status}]});
  assert.equal(text(find(tree,n=>n.props.className==='assistant-workspace-flag')),label);
 }
});

test('legacy assistants without project assignments load and save an empty binding list',async()=>{
 const legacy={...record,profile:{...profile,access:'read'}};delete legacy.projects;
 const h=mount({lane:{assistant:legacy}});const tree=await h.ready();assert.equal(input(tree,'Project tools').props.value,'read');await submit(h);assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].projects,[]);
});


test('outside project requires exact-folder confirmation and refreshes revision while preserving draft',async()=>{
 const grants=[];const project={id:'outside',name:'Outside project',path:'/other/exact'};
 const h=mount({projects:[project],backend:{supports:cap=>cap==='assistant_project_folder_grant_v1',call:async(cmd,args)=>{grants.push([cmd,args]);return {assistant:{...record,allowedFolders:['/existing','/other/exact'],revision:8}};}},lane:{assistant:{...record,allowedFolders:['/existing']}}});
 let tree=await h.ready();input(tree,'Assistant name').props.onChange({target:{value:'My unsaved draft'}});
 const choice=()=>find(h.render(),n=>n.type==='input'&&n.props.type==='checkbox');
 choice().props.onChange({target:{checked:true}});tree=h.render();
 assert.match(text(tree),/\/other\/exact/);assert.equal(grants.length,0);assert.equal(choice().props.checked,false);
 find(tree,n=>n.type==='button'&&text(n)==='Cancel').props.onClick();assert.equal(grants.length,0);assert.equal(choice().props.checked,false);
 choice().props.onChange({target:{checked:true}});
 await find(h.render(),n=>n.type==='button'&&text(n)==='Allow this folder').props.onClick();
 assert.deepEqual(grants,[['personal_workspace_configure',{assistantId:'a',expectedRevision:7,folderGrant:{hostId:'mac',workspaceId:'outside',cwd:'/other/exact'}}]]);
 tree=h.render();assert.equal(input(tree,'Assistant name').props.value,'My unsaved draft');assert.equal(choice().props.checked,true);
 await submit(h);assert.equal(h.calls[0].expectedRevision,8);assert.equal(h.calls[0].settings.name,'My unsaved draft');assert.equal(h.calls[0].folderGrant,undefined);assert.equal(h.calls[0].projects.length,1);assert.equal(h.calls[0].projects[0].project.cwd,'/other/exact');
});
test('older host explains missing grant capability without enabling outside project',async()=>{
 const h=mount({projects:[{id:'outside',name:'Outside',path:'/other/exact'}],lane:{assistant:{...record,allowedFolders:['/existing']}}});const tree=await h.ready();
 assert.equal(find(tree,n=>n.type==='input'&&n.props.type==='checkbox').props.disabled,true);assert.match(text(tree),/Update.*service.*folder/i);
});


test('late folder grant cannot update an unmounted draft or a different owner',async()=>{
 let resolve;const changed=[];const h=mount({projects:[{id:'p',name:'P',path:'/exact'}],backend:{supports:()=>true,call:()=>new Promise(r=>{resolve=r;})},lane:{assistant:{...record,allowedFolders:[]}},onCommitted:()=>changed.push('committed')});await h.ready();
 find(h.render(),n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});const promise=find(h.render(),n=>n.type==='button'&&text(n)==='Allow this folder').props.onClick();h.unmount();resolve({assistant:{...record,revision:8,allowedFolders:['/exact']}});await promise;assert.deepEqual(changed,['committed']);assert.equal(find(h.render(),n=>n.type==='input'&&n.props.type==='checkbox').props.checked,false);
 const wrong=mount({projects:[{id:'p',name:'P',path:'/exact'}],backend:{supports:()=>true,call:async()=>({assistant:{...record,id:'other',revision:8,allowedFolders:['/exact']}})},lane:{assistant:{...record,allowedFolders:[]}}});await wrong.ready();find(wrong.render(),n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});await find(wrong.render(),n=>n.type==='button'&&text(n)==='Allow this folder').props.onClick();assert.match(text(wrong.render()),/owner could not be verified/);assert.equal(find(wrong.render(),n=>n.type==='input'&&n.props.type==='checkbox').props.checked,false);
});

const headerLane=(over={})=>({name:'Apex Assistant',hostName:'Mac',offline:false,pause:async()=>{},assistant:{...record,name:'Apex Assistant',paused:false,profile:{...profile,backend:{kind:'open_ai_compatible',base_url:'x',model:'deepseek-v4.1-flash'},access:'ask'},projects:[{project:{hostId:'mac',workspaceId:'w',cwd:'/r'},tools:'ask'}],tasks:[],...over}});
const header=(lane,extra={})=>mount().workspace({lane,section:'chat',onNavigate(){},chat:'chat',work:'work',editor:'editor',...extra});
test('header shows model, access and project count',()=>{
 assert.match(text(find(header(headerLane()),n=>n.props?.className==='assistant-workspace-meta')),/^deepseek-v4\.1-flash · high · Asks first · 1 project$/);
 const two=headerLane({projects:[{project:{hostId:'mac',workspaceId:'w',cwd:'/r'},tools:'ask'},{project:{hostId:'mac',workspaceId:'v',cwd:'/s'},tools:'ask'}]});
 assert.match(text(header(two)),/2 projects/);assert.doesNotMatch(text(header(two)),/Ongoing conversation|Assistant ·/);
});
test('tabs are Chat and Work with an attention count',()=>{
 const tree=header(headerLane({tasks:[{id:'t',status:'needsYou',goal:'g',updatedAt:1}]}),{delegatedTasks:[{id:'d',status:'failed',originalRequest:'x',workers:[],updatedAtMs:1}]});
 assert.deepEqual(all(find(tree,n=>n.props?.role==='tablist'),n=>n.props?.role==='tab').map(text),['Chat','Work2']);
 assert.match(text(find(tree,n=>n.props?.className==='assistant-workspace-flag')),/Needs you · 1/);
});
test('a ready assistant shows no status flag',()=>{assert.equal(find(header(headerLane()),n=>n.props?.className==='assistant-workspace-flag'),null);});
test('menu holds Projects, Browser, Memory, Settings and Pause',()=>{
 assert.deepEqual(all(header(headerLane()),n=>n.props?.role==='menuitem').map(text),['Projects','Browser','Memory','Settings','Pause']);
});
test('pause is a labelled button',()=>{
 assert.ok(find(header(headerLane()),n=>n.type==='button'&&text(n)==='Pause'));
 assert.ok(find(header(headerLane({paused:true})),n=>n.type==='button'&&text(n)==='Resume'));
});
test('subview back says Chat or Work',()=>{
 const opened=[];const tree=header(headerLane(),{section:'memory',previousSection:'work',onNavigate:s=>opened.push(s)});
 find(tree,n=>n.type==='button'&&text(n)==='‹ Work').props.onClick();assert.deepEqual(opened,['work']);
});
test('work panel renders the work slot',()=>{
 assert.match(text(header(headerLane(),{section:'work',work:'Work content'})),/Work content/);
});

const settingsMount=(over={})=>mount({projects:[{id:'p',name:'Granted',path:'/existing/p'},{id:'q',name:'Outside',path:'/other/q'}],backend:{supports:cap=>cap==='assistant_project_folder_grant_v1',call:async()=>({assistant:{...record,allowedFolders:['/existing','/other/q'],revision:8}})},lane:{assistant:{...record,allowedFolders:['/existing']}},...over});
test('settings is one short column in page order',async()=>{
 const t=text(await settingsMount().ready());
 const order=['General','Model','Projects & access','Memory','Tools & rules'].map(label=>t.indexOf(label));
 assert.ok(order.every(i=>i>=0),String(order));assert.deepEqual([...order].sort((a,b)=>a-b),order);
 assert.doesNotMatch(t,/Make .* yours|Connected context|Skills & tools/);
});
test('provider is hidden when only one provider is configured',async()=>{
 assert.equal(input(await settingsMount().ready(),'Assistant provider'),null);
});
test('Project tools names read-only access the way the header does',async()=>{
 assert.deepEqual(all(input(await settingsMount().ready(),'Project tools'),n=>n.type==='option').map(text),['Ask first','Full access','Read only']);
});
test('switching on a granted project adds it',async()=>{
 const h=settingsMount();let tree=await h.ready();
 const sw=input(tree,'Use Granted');assert.equal(sw.props.role,'switch');assert.equal(sw.props.disabled,false);
 sw.props.onChange({target:{checked:true}});await submit(h);assert.equal(h.calls[0].projects[0].project.cwd,'/existing/p');
});
test('switching on an ungranted project asks first and connects after the grant',async()=>{
 const h=settingsMount();let tree=await h.ready();
 assert.equal(find(tree,n=>n.type==='button'&&text(n)==='Allow this folder…'),null,'no separate allow button');
 input(tree,'Use Outside').props.onChange({target:{checked:true}});tree=h.render();
 assert.match(text(tree),/Allow Null to access this folder and its subfolders\?/);assert.equal(input(tree,'Use Outside').props.checked,false);
 await find(tree,n=>n.type==='button'&&text(n)==='Allow this folder').props.onClick();tree=h.render();
 assert.equal(input(tree,'Use Outside').props.checked,true);
});
test('failed folder grant leaves switch off',async()=>{
 const h=settingsMount({backend:{supports:()=>true,call:async()=>{throw new Error('Grant refused');}}});let tree=await h.ready();
 input(tree,'Use Outside').props.onChange({target:{checked:true}});await find(h.render(),n=>n.type==='button'&&text(n)==='Allow this folder').props.onClick();tree=h.render();
 assert.equal(input(tree,'Use Outside').props.checked,false);assert.match(text(tree),/Grant refused/);await submit(h);assert.deepEqual(h.calls[0]?.projects??[],[]);
});
test('the save bar counts changes and Discard restores saved values',async()=>{
 const h=settingsMount();let tree=await h.ready();assert.match(text(find(tree,n=>n.props?.className==='assistant-save-summary')),/No unsaved changes/);
 input(tree,'Assistant name').props.onChange({target:{value:'Renamed'}});tree=h.render();
 assert.equal(text(find(tree,n=>n.props?.className==='assistant-save-summary')),'1 unsaved change · Name');
 find(tree,n=>n.type==='button'&&text(n)==='Discard').props.onClick();tree=h.render();
 assert.equal(input(tree,'Assistant name').props.value,'Null');
});
test('settings subview back restores the same unsaved main draft',async()=>{
 const h=settingsMount();let tree=await h.ready();input(tree,'Assistant name').props.onChange({target:{value:'Unsaved name'}});
 find(h.render(),n=>n.type==='button'&&n.props?.className==='assistant-settings-link'&&text(n).includes('Personal notes')).props.onClick();tree=h.render();
 const panel=find(tree,n=>n.type===PersonalPanels&&n.props.initial==='memory');assert.ok(panel);assert.equal(find(tree,n=>n.props.className==='assistant-settings-main').props.hidden,true);
 find(tree,n=>n.type==='button'&&text(n)==='‹ Settings').props.onClick();tree=h.render();assert.equal(input(tree,'Assistant name').props.value,'Unsaved name');assert.equal(find(tree,n=>n.props.className==='assistant-settings-main').props.hidden,false);assert.equal(h.calls.length,0);
});

test('the create form is short: name, model, access, first brief, then more options',async()=>{
 const t=text(await mount({lane:undefined,onCreate:async()=>{},machinePicker:'MACHINE PICKER'}).ready());
 const order=['Name','Model','In those projects it may','First brief','More options'].map(label=>t.indexOf(label));
 assert.ok(order.every(i=>i>=0),String(order));assert.deepEqual([...order].sort((a,b)=>a-b),order);
 assert.doesNotMatch(t,/AI generate|Connected context|Each assistant has its own conversation/);
 assert.ok(t.indexOf('MACHINE PICKER')>t.indexOf('More options'),'machine lives under More options');
});
test('create offers full avatar customization while preserving its brief and runtime draft',async()=>{
 const creation=mount({lane:undefined,onCreate:async()=>{}});let creationTree=await creation.ready();
 input(creationTree,'Assistant name').props.onChange({target:{value:'My teammate'}});input(creation.render(),'First brief').props.onChange({target:{value:'Draft only'}});
 const avatar=find(creation.render(),n=>n.type===AssistantAvatarEditor);assert.ok(avatar,'creation exposes the full pixel and AI editor');
 avatar.props.onAppearanceChange({...avatar.props.appearance,kind:'image',image:{assetId:'a',sha256:'h',mime:'image/png',width:512,height:512}});avatar.props.onApply({kind:'image',generationId:'g',assetId:'a'});
 assert.equal(input(creation.render(),'Assistant name').props.value,'My teammate');assert.equal(input(creation.render(),'First brief').props.value,'Draft only');
 assert.equal(avatar.props.owner.kind,'creation');assert.equal(avatar.props.owner.hostId,'mac');
 const h=mount({lane:undefined,onCreate:async()=>{}});let tree=await h.ready();
 const before=find(tree,n=>n.type===Avatar).props.seed;find(tree,n=>n.type==='button'&&n.props['aria-label']==='New avatar pattern').props.onClick();
 assert.notEqual(find(h.render(),n=>n.type===Avatar).props.seed,before);
 assert.equal(text(find(h.render(),n=>n.type==='button'&&n.props.type==='submit')),'Add teammate');
});
test('the first brief is handed over with Create and never sent',async()=>{
 const created=[];const h=mount({lane:undefined,onCreate:async value=>created.push(value)});let tree=await h.ready();
 input(tree,'Assistant name').props.onChange({target:{value:'Fidelity QA'}});
 const brief=input(h.render(),'First brief');assert.equal(brief.props.placeholder,'e.g. Run the test suite every morning and tell me what broke.');
 brief.props.onChange({target:{value:'  Keep the tests green.  '}});await submit(h);
 assert.equal(created[0].firstBrief,'Keep the tests green.');assert.match(text(h.render()),/Added to its chat, ready to send\./);
});


test('advanced preferences are staged in the single revision-bound Save transaction and Discard resets them',async()=>{
 const h=settingsMount({lane:{assistant:{...record,style:'Original style',timezone:'UTC',quietHours:{start:'21:00',end:'08:00'},budget:{dailyLimitMicros:2000000,unknownCostOk:false},privacy:{localOnly:false,allowedEndpoints:['https://saved.test']},contextBudgetChars:24000}}});let tree=await h.ready();
 assert.ok(input(tree,'Reply style'),'reply style remains available in Settings');
 input(tree,'Reply style').props.onChange({target:{value:'Concise'}});input(h.render(),'Timezone').props.onChange({target:{value:'America/Los_Angeles'}});input(h.render(),'Quiet hours start').props.onChange({target:{value:'22:00'}});input(h.render(),'Daily spend limit').props.onChange({target:{value:'4.25'}});input(h.render(),'Allow unknown reply costs').props.onChange({target:{checked:true}});input(h.render(),'Local only').props.onChange({target:{checked:true}});input(h.render(),'Allowed model endpoints').props.onChange({target:{value:' https://one.test \nhttps://two.test'}});input(h.render(),'Context budget').props.onChange({target:{value:'12000'}});
 assert.equal(h.calls.length,0);assert.equal(all(h.render(),n=>n.type==='form').length,1);
 await submit(h);assert.equal(h.calls[0].expectedRevision,7);assert.deepEqual(h.calls[0].settings,{name:'Null',look:{...record.look,kind:'pixel'},style:'Concise',timezone:'America/Los_Angeles',quietHours:{start:'22:00',end:'08:00'},budget:{dailyLimitMicros:4250000,unknownCostOk:true},privacy:{localOnly:true,allowedEndpoints:['https://one.test','https://two.test']},contextBudgetChars:12000});
 find(h.render(),n=>n.type==='button'&&text(n)==='Discard').props.onClick();tree=h.render();assert.equal(input(tree,'Reply style').props.value,'Concise');assert.equal(input(tree,'Daily spend limit').props.value,'4.25');assert.equal(input(tree,'Local only').props.checked,true);
});
test('incomplete quiet hours and invalid settings cannot persist a partial main draft',async()=>{
 const h=settingsMount();let tree=await h.ready();assert.ok(input(tree,'Quiet hours start'));
 input(tree,'Quiet hours start').props.onChange({target:{value:'22:00'}});await submit(h);assert.equal(h.calls.length,0);assert.match(text(h.render()),/both quiet hours/i);
 input(h.render(),'Quiet hours end').props.onChange({target:{value:'07:00'}});input(h.render(),'Context budget').props.onChange({target:{value:'0'}});await submit(h);assert.equal(h.calls.length,0);assert.match(text(h.render()),/whole number/i);
});
test('settings exposes costs, schedules, notices, connections and rules without replacing the main draft',async()=>{
 const h=settingsMount();let tree=await h.ready();
 for(const [label,panel] of [['Costs & privacy','costs'],['Schedules','scheduled'],['Notices','notices'],['Connections','connections'],['Rules','rules']]){
  const route=find(tree,n=>n.type==='button'&&text(n).startsWith(label));assert.ok(route,label);route.props.onClick();tree=h.render();const mounted=find(tree,n=>n.type===PersonalPanels&&n.props.initial===panel);assert.ok(mounted,panel);
  find(tree,n=>n.type==='button'&&text(n)==='‹ Settings').props.onClick();tree=h.render();assert.ok(find(tree,n=>n.type===PersonalPanels&&n.props.initial===panel),'visited panel stays mounted to preserve drafts');
 }
});


test('Full access requires a separate confirmation and cancellation retains existing project access',async()=>{
 for(const lane of [undefined,{assistant:record}]){const h=mount({lane});await h.ready();input(h.render(),'Project tools').props.onChange({target:{value:'full'}});assert.equal(input(h.render(),'Project tools').props.value,'ask');assert.match(text(h.render()),/does not grant.*folders/i);find(h.render(),n=>n.type==='button'&&text(n)==='Keep current access').props.onClick();assert.equal(input(h.render(),'Project tools').props.value,'ask');chooseFull(h);assert.equal(input(h.render(),'Project tools').props.value,'full');assert.equal(h.calls.length,0);}
});
test('clearing quiet hours emits explicit null so JSON transport turns the schedule off',async()=>{
 const h=settingsMount({lane:{assistant:{...record,quietHours:{start:'22:00',end:'07:00'}}}});await h.ready();input(h.render(),'Quiet hours start').props.onChange({target:{value:''}});input(h.render(),'Quiet hours end').props.onChange({target:{value:''}});await submit(h);assert.equal(JSON.parse(JSON.stringify(h.calls[0])).settings.quietHours,null);
});
test('shared voice defaults remain staged until Save and retain current chat overrides',async()=>{
 const saved=[],voiceSettings={enabled:true,defaultVoice:'af_bella',silenceMs:100,look:'pill',preferences:{chat:{voice:'am_michael',aliases:['Pal']}}};
 const h=settingsMount({voiceSettings,onVoiceSettings:value=>saved.push(value)});let tree=await h.ready();assert.ok(input(tree,'Voice for calls'));assert.equal(input(tree,'Voice for calls').props.value,'af_bella');
 input(tree,'Voice for calls').props.onChange({target:{value:'am_echo'}});input(h.render(),'Pause before reply').props.onChange({target:{value:'600'}});input(h.render(),'Call controls').props.onChange({target:{value:'bar'}});assert.deepEqual(saved,[]);await submit(h);assert.deepEqual(saved,[{...voiceSettings,defaultVoice:'am_echo',silenceMs:600,look:'bar'}]);
 find(h.render(),n=>n.type==='button'&&text(n)==='Discard').props.onClick();assert.equal(input(h.render(),'Voice for calls').props.value,'af_bella');
});

test('voice defaults saved after a host roundtrip preserve chat overrides changed during that roundtrip',async()=>{
 let complete;const saved=[],voiceSettings={enabled:true,defaultVoice:'af_bella',silenceMs:100,look:'pill',preferences:{}};
 const h=settingsMount({voiceSettings,onVoiceSettings:value=>saved.push(value),lane:{configureWorkspace:()=>new Promise(resolve=>{complete=resolve;})}});await h.ready();input(h.render(),'Voice for calls').props.onChange({target:{value:'am_echo'}});await submit(h);
 h.props.voiceSettings={...voiceSettings,preferences:{call:{voice:'af_heart',aliases:['Friend']}}};h.render();complete();await tick();assert.deepEqual(saved[0].preferences,{call:{voice:'af_heart',aliases:['Friend']}});assert.equal(saved[0].defaultVoice,'am_echo');
});

test('Remove assistant requires explicit confirmation and only notifies navigation after host persistence',async()=>{
 const calls=[],removed=[];let complete;const h=settingsMount({lane:{archiveAssistant:revision=>{calls.push(revision);return new Promise(resolve=>{complete=resolve;});}},onArchived:()=>removed.push('removed')});let tree=await h.ready();const remove=find(tree,n=>n.type==='button'&&text(n)==='Remove assistant');assert.ok(remove);remove.props.onClick();assert.equal(calls.length,0);tree=h.render();assert.match(text(tree),/history.*notes.*projects.*retained/i);const confirm=find(tree,n=>n.type==='button'&&text(n)==='Remove and keep history');assert.ok(confirm);const promise=confirm.props.onClick();assert.deepEqual(calls,[7]);assert.deepEqual(removed,[]);complete();await promise;assert.deepEqual(removed,['removed']);
});
test('Remove assistant explains unfinished work and cannot cancel or hide it implicitly',async()=>{
 const calls=[];const h=settingsMount({lane:{assistant:{...record,tasks:[{id:'running',status:'running',receipts:[]}]},archiveAssistant:async()=>calls.push('archive')}});const tree=await h.ready();const remove=find(tree,n=>n.type==='button'&&text(n)==='Remove assistant');assert.ok(remove);assert.equal(remove.props.disabled,true);assert.match(text(tree),/cancel.*tasks.*first/i);assert.deepEqual(calls,[]);
});


test('saving a kept-mounted editor advances its revision and Discard returns to the successfully saved baseline',async()=>{
 const h=settingsMount();await h.ready();input(h.render(),'Assistant name').props.onChange({target:{value:'First saved'}});await submit(h);assert.match(text(find(h.render(),n=>n.props.className==='assistant-save-summary')),/No unsaved changes/);
 input(h.render(),'Assistant name').props.onChange({target:{value:'Second saved'}});await submit(h);assert.deepEqual(h.calls.map(call=>call.expectedRevision),[7,8]);input(h.render(),'Assistant name').props.onChange({target:{value:'Unwanted third edit'}});find(h.render(),n=>n.type==='button'&&text(n)==='Discard').props.onClick();assert.equal(input(h.render(),'Assistant name').props.value,'Second saved');
});
test('a clean kept-mounted settings draft follows newer saved runtime while a dirty draft keeps its revision',async()=>{
 const h=settingsMount();await h.ready();h.props.lane={...h.props.lane,assistant:{...record,revision:8,name:'Changed in header',profile:{...profile,backend:{...profile.backend,model:'new'},effort:'low'}}};await h.ready();assert.equal(input(h.render(),'Assistant name').props.value,'Changed in header');assert.equal(input(h.render(),'Assistant model').props.value,'new');
 input(h.render(),'Assistant name').props.onChange({target:{value:'My unsaved edit'}});h.props.lane={...h.props.lane,assistant:{...h.props.lane.assistant,revision:9,name:'Another remote save'}};await h.ready();assert.equal(input(h.render(),'Assistant name').props.value,'My unsaved edit');await submit(h);assert.equal(h.calls[0].expectedRevision,8);
});

test('unset shared voice preferences still expose real call defaults and save only explicit edits',async()=>{
 const saved=[];const h=mount({onVoiceSettings:value=>saved.push(value)});const tree=await h.ready();
 assert.ok(input(tree,'Voice for calls'));assert.equal(input(tree,'Voice for calls').props.value,'am_michael');
 assert.equal(input(tree,'Pause before reply').props.value,100);assert.equal(input(tree,'Call controls').props.value,'pill');
 await submit(h);assert.deepEqual(saved,[]);
 input(h.render(),'Call controls').props.onChange({target:{value:'bar'}});await submit(h);
 assert.equal(saved.length,1);assert.deepEqual(saved[0],{...readVoiceSettings(undefined),look:'bar'});
});

test('creating an assistant with a CLI provider default persists null instead of inventing a model id',async()=>{
 const created=[];
 const h=mount({lane:undefined,onCreate:async value=>created.push(value),backend:{sessionLoad:async()=>({profiles:[]}),detectAgents:async()=>[{key:'claude',label:'Claude Code',program:'claude',found:true}],agentModels:async()=>[]}});
 let tree=await h.ready();assert.equal(input(tree,'Assistant model').props.value,'');
 input(tree,'Assistant name').props.onChange({target:{value:'Default provider QA'}});await submit(h);
 assert.equal(created.length,1);assert.equal(created[0].profile.backend.kind,'agent');assert.equal(created[0].profile.backend.model,null);assert.equal(created[0].profile.effort,null);
});
