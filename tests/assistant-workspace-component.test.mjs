import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {assistantAppearance,createAssistantAppearance,projectIdentityKey} from '../src/assistantIdentity.ts';
import {runtimeProfile,textModels,reconcileEffort,validateAssistantDraft} from '../src/assistantWorkspaceModel.ts';
import {providerEnabled,providerForConfig} from '../src/providers.ts';
import {AGENT_COLORS} from '../src/identicon.ts';
const {transform}=createRequire(import.meta.url)('sucrase');
const source=fs.readFileSync(new URL('../src/AssistantWorkspace.tsx',import.meta.url),'utf8');
const compiled=transform(source.replace(/^import .*;\n/gm,'').replace(/^export /gm,''),{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)})};
const text=n=>typeof n==='string'||typeof n==='number'?String(n):n?.children?.map(text).join('')??'';
const find=(n,p)=>!n||typeof n!=='object'?null:p(n)?n:n.children?.map(c=>find(c,p)).find(Boolean)??null;
const all=(n,p)=>!n||typeof n!=='object'?[]:[...(p(n)?[n]:[]),...(n.children??[]).flatMap(c=>all(c,p))];
const Avatar=()=>null, HexColorPicker=()=>null,PersonalPanels=()=>null,PersonalBrowser=()=>null,AssistantAvatarEditor=()=>null;
const profile={id:'legacy',display_name:'Legacy',persona:'Legacy metadata retained',backend:{kind:'agent',tool:'codex',model:'old'},effort:'high',access:'ask',legacyLabel:'old custom label'};
const record={id:'a',hostId:'mac',revision:7,name:'Null',style:'Saved legacy style',look:{seed:'saved-seed',color:'#aabbcc',shape:'legacy-shape'},profile,messages:[],tasks:[],projects:[]};
function mount(overrides={}){
 const calls=[];const backend={sessionLoad:async()=>({profiles:[profile]}),detectAgents:async()=>[{key:'codex',found:true}],agentModels:async()=>[{id:'old',efforts:['low','high']},{id:'new',efforts:['low']}],supports:()=>false,...overrides.backend};
 const lane={name:'Null',hostName:'Mac',assistant:record,offline:false,configureWorkspace:async input=>calls.push(input),...overrides.lane};
 const props={backend,lane,hostId:'mac',profiles:[profile],projects:[],...overrides,backend,lane:overrides.lane===undefined&&Object.hasOwn(overrides,'lane')?undefined:lane};
 const states=[],deps=[],queued=[],cleanups=[];let cursor=0;
 const hooks={useRef(initial){const i=cursor++;return states[i]??(states[i]={current:initial});},useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],value=>states[i]=typeof value==='function'?value(states[i]):value];},useMemo(fn){cursor++;return fn();},useEffect(fn,next){const i=cursor++;if(!deps[i]||next.some((v,j)=>v!==deps[i][j])){deps[i]=next;queued.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
 const bindings={React,...hooks,Avatar,HexColorPicker,PersonalPanels,PersonalBrowser,AssistantAvatarEditor,assistantAppearance,createAssistantAppearance,projectIdentityKey,runtimeProfile,textModels,reconcileEffort,validateAssistantDraft,providerEnabled,providerForConfig,AGENT_COLORS,createAssistantAvatarApi:()=>undefined};
 const components=new Function(...Object.keys(bindings),`${compiled}\nreturn {AssistantEditor,AssistantWorkspace};`)(...Object.values(bindings));
 return{props,calls,unmount(){cleanups.forEach(fn=>fn?.());},render(){cursor=0;const tree=components.AssistantEditor(props);queued.splice(0).forEach(fn=>fn());return tree;},workspace(p){return components.AssistantWorkspace(p);},async ready(){for(let i=0;i<4;i++){this.render();await new Promise(r=>setImmediate(r));}return this.render();}};
}
const input=(tree,name)=>find(tree,n=>n.props?.['aria-label']===name);
const submit=async h=>{find(h.render(),n=>n.type==='form').props.onSubmit({preventDefault(){}});await new Promise(r=>setImmediate(r));};
test('settings validates name, saves offered runtime and Full access, preserves legacy metadata and appearance',async()=>{
 const h=mount();let tree=await h.ready();assert.doesNotMatch(text(tree),/Team Member Type|Work brief.*textarea/i);
 input(tree,'Assistant name').props.onChange({target:{value:' '}});assert.equal(find(h.render(),n=>n.type==='button'&&n.props.type==='submit').props.disabled,true);
 input(h.render(),'Assistant name').props.onChange({target:{value:'Renamed'}});input(h.render(),'Project tools').props.onChange({target:{value:'full'}});
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
 const created=[];const h=mount({lane:undefined,onCreate:async value=>created.push(value)});let tree=await h.ready();assert.ok(text(tree).indexOf('AI model')<text(tree).indexOf('Access'));assert.ok(text(tree).indexOf('Access')<text(tree).indexOf('Avatar'));assert.equal(created.length,0);
 input(tree,'Assistant name').props.onChange({target:{value:'Teammate'}});input(h.render(),'Project tools').props.onChange({target:{value:'full'}});await submit(h);assert.equal(created[0].workspaceVersion,4);assert.equal(typeof created[0].avatarDraftId,'string');assert.equal(created[0].avatarGenerationId,undefined);assert.equal(created[0].avatarAssetId,undefined);assert.equal(created[0].profile.access,'full');assert.match(created[0].look.color,/^#[\da-f]{6}$/);assert.ok(created[0].look.seed);
 const current=await mount().ready();assert.ok(text(current).indexOf('Connected context')>text(current).indexOf('Access'));assert.ok(text(current).indexOf('Skills & tools')<text(current).indexOf('Avatar'));
});
test('a conflict changes no draft fields and retains the captured revision for explicit retry',async()=>{
 const h=mount({lane:{configureWorkspace:async()=>{throw new Error('Revision conflict; refresh and retry');}}});let tree=await h.ready();input(tree,'Assistant name').props.onChange({target:{value:'Keep my draft'}});await submit(h);tree=h.render();assert.equal(input(tree,'Assistant name').props.value,'Keep my draft');assert.match(text(tree),/Revision conflict/);assert.equal(record.name,'Null');
});
test('Memory and Settings are main-pane views with Back to the same conversation',()=>{
 const h=mount();const opened=[];const tree=h.workspace({lane:{name:'Null',hostName:'Mac'},section:'memory',onNavigate:s=>opened.push(s),onBack(){},conversation:'Retained conversation',editor:'Settings editor',projects:[]});assert.equal(find(tree,n=>n.props.className==='assistant-workspace-content').props.hidden,true);find(tree,n=>n.type==='button'&&text(n)==='← Back to Conversation').props.onClick();assert.deepEqual(opened,['conversation']);assert.equal(find(tree,n=>n.type===PersonalPanels).props.initial,'memory');
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
test('project links pass the complete identity and explain unavailable exact destinations',()=>{
 const h=mount();const project={hostId:'host-b',workspaceId:'shared',cwd:'/b'};const opened=[];
 const props={lane:{name:'Null',hostName:'Mac'},section:'projects',onNavigate(){},onBack(){},projects:[{project,tools:'ask'}],onOpenProject:p=>opened.push(p)};
 let tree=h.workspace({...props,projectUnavailable:()=>undefined});find(tree,n=>n.type==='button'&&text(n).includes('/b')).props.onClick();assert.deepEqual(opened,[project]);
 tree=h.workspace({...props,projectUnavailable:()=>'Exact project unavailable. Reconnect its machine.'});assert.equal(find(tree,n=>n.type==='button'&&text(n).includes('/b')).props.disabled,true);assert.match(text(tree),/Exact project unavailable/);
});

test('conflict refresh updates only the expected revision and preserves the complete draft for retry',async()=>{
 const requests=[];let conflict=true;const h=mount({backend:{call:async(cmd,args)=>{assert.equal(cmd,'personal_get');assert.equal(args.assistantId,'a');return {...record,revision:9,name:'Remote name'};}},lane:{configureWorkspace:async value=>{requests.push(value);if(conflict)throw new Error('The assistant changed. Refresh before saving this draft.');}}});
 await h.ready();input(h.render(),'Assistant name').props.onChange({target:{value:'Keep my draft'}});input(h.render(),'Project tools').props.onChange({target:{value:'full'}});await submit(h);
 const refresh=find(h.render(),n=>n.type==='button'&&text(n).includes('Refresh revision'));assert.ok(refresh);await refresh.props.onClick();await tick();assert.equal(input(h.render(),'Assistant name').props.value,'Keep my draft');assert.equal(input(h.render(),'Project tools').props.value,'full');conflict=false;await submit(h);assert.equal(requests[1].expectedRevision,9);assert.equal(requests[1].settings.name,'Keep my draft');
});
test('applied creation image previews use the captured draft owner and generation',async()=>{
 const h=mount({lane:undefined});let tree=await h.ready();const editor=find(tree,n=>n.type===AssistantAvatarEditor);const image={assetId:'asset',sha256:'hash',mime:'image/png',width:512,height:512};editor.props.onAppearanceChange({...editor.props.appearance,kind:'image',image});editor.props.onApply({kind:'image',generationId:'gen',assetId:'asset'});tree=h.render();
 for(const preview of all(tree,n=>n.type===Avatar)){assert.deepEqual(preview.props.draftImage,{owner:editor.props.owner,generationId:'gen'});assert.deepEqual(preview.props.image,image);}
});
test('cached CLI models cannot make a missing installation ready',async()=>{
 const h=mount({backend:{detectAgents:async()=>[{key:'codex',found:false,program:'codex',label:'Codex'}]}});const tree=await h.ready();assert.match(text(tree),/not installed/i);await submit(h);assert.equal(h.calls.length,0);
});

test('unproven changed folders retain their saved assignment and cannot add a duplicate binding',async()=>{
 const assigned={project:{hostId:'mac',workspaceId:'w',cwd:'/private/tmp/p'},tools:'ask'};const h=mount({projects:[{id:'w',path:'/tmp/p',name:'P'}],lane:{assistant:{...record,projects:[assigned]}}});const tree=await h.ready();assert.equal(find(tree,n=>n.type==='input'&&n.props.type==='checkbox').props.disabled,true);assert.match(text(tree),/folder.*verified/i);await submit(h);assert.deepEqual(h.calls[0].projects,[assigned]);
});
