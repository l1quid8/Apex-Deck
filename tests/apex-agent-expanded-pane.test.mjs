import {createRequire} from 'node:module';
const {transform}=createRequire(import.meta.url)('sucrase');
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const app = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
test('assistant routing keeps the human pane tree mounted inside a hidden workspace container', () => {
 assert.match(app,/workspace-canvas-content/);
 assert.match(app,/display:mainView.kind==='workspace'/);
 assert.match(app,/<div ref=\{gridArea\}/);
 assert.match(app,/chat=\{<ApexAgentAll/);
 assert.doesNotMatch(app,/<ApexAgentWidget|apex-agent-float|apexAgentFull/);
});
test('global Agents leaves the assistant view and manages only reusable worker profiles', () => {
 const navigation=app.match(/<SectionNavigation\b[^\n]*?\/>/)?.[0];assert.ok(navigation);
 const React={createElement:(type,props)=>({type,props})},SectionNavigation=Symbol('SectionNavigation');
 const changes=[];const scope={React,SectionNavigation,mainView:{kind:'assistant'},creatingAssistant:false,section:'agents',sectionFlags:{},openAttention(){},setAttention(){},clearReady(){},decideApproval(){},setMainView:value=>changes.push(['mainView',value]),setCreatingAssistant:value=>changes.push(['creating',value]),setSettingsOpen(){},setSection:value=>changes.push(['section',value]),setPicking(){},setMaximized(){},setOpenChat(){}};
 const code=transform(`return (${navigation});`,{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
 const render=()=>new Function(...Object.keys(scope),code)(...Object.values(scope));
 let nav=render();assert.equal(nav.props.section,null,'an assistant clears the global selection');nav.props.onChange('agents');
 assert.deepEqual(changes,[['mainView',{kind:'workspace'}],['creating',false],['section','agents']]);
 scope.mainView={kind:'workspace'};nav=render();assert.equal(nav.props.section,'agents');
 const workers=app.match(/<AgentsSection\b[^\n]*?\/>/)?.[0];assert.ok(workers);
 const agents=[],profiles=[],backend={},workerScope={React,AgentsSection:Symbol('AgentsSection'),agents,profiles,backend,disabledProviders:[],saveAgents(){},newAgentRequest:0,settings:{voice:{}}};
 const workerCode=transform(`return (${workers});`,{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
 const worker=new Function(...Object.keys(workerScope),workerCode)(...Object.values(workerScope));
 assert.equal(worker.props.agents,agents);assert.equal(worker.props.profiles,profiles);assert.equal(worker.props.backend,backend);
 for(const forbidden of ['onCreateAssistant','onOpenAssistant','assistants','assistantFlags'])assert.equal(Object.hasOwn(worker.props,forbidden),false,forbidden);
});
test('Memory and Settings route into the assistant main canvas', () => {
 assert.match(app,/lane=\{selectedAssistant\} section=\{mainView.section\}/);
 assert.match(app,/onNavigatePanel=\{panel=>navigateAssistant\(panel==='activity'\?'chat':panel\)\}/);
 assert.match(app,/editor=\{assistantBackend \? <AssistantEditor/);
});
test('project source setup occupies the main canvas without a floating dock', () => {
 assert.match(app,/<aside className="assistant-source-view"/);
 assert.ok(app.indexOf('<aside className="assistant-source-view"')<app.indexOf('</main>'));
});

test('App keeps tool-lane hooks above its loading return', () => {
  const loadingReturn = app.indexOf('  if (!backend) return (');
  assert.notEqual(loadingReturn, -1, 'the loading boundary exists');
  const afterLoading = app.slice(loadingReturn);
  assert.deepEqual(afterLoading.match(/\buse(?:State|Effect|Memo|Callback|Ref|LayoutEffect|SyncExternalStore)\s*\(/g), null,
    'App does not add hooks only after the backend loads');

  const monitorsAt = app.indexOf('const assistantMonitors = Object.values(monitorAttention)');
  const toolContextAt = app.indexOf('const toolContextKey = assistantMonitors.map');
  const toolStateAt = app.indexOf('const [serversByLane, setServersByLane] = useState');
  const statusStateAt = app.indexOf('const [serverStatusByLane, setServerStatusByLane] = useState');
  const toolsEffectAt = app.indexOf('useEffect(() => {', toolContextAt);
  assert.ok(monitorsAt >= 0 && monitorsAt < loadingReturn, 'assistant monitors are derived before the loading return');
  assert.ok(toolContextAt >= 0 && toolContextAt < toolsEffectAt, 'the tool context key is derived before its effect');
  assert.ok(toolStateAt >= 0 && toolStateAt < loadingReturn, 'serversByLane state is initialized before the loading return');
  assert.ok(statusStateAt >= 0 && statusStateAt < loadingReturn, 'serverStatusByLane state is initialized before the loading return');
  assert.ok(toolsEffectAt >= 0 && toolsEffectAt < loadingReturn, 'the lane tools effect is registered before the loading return');
  const effect = app.slice(toolsEffectAt, app.indexOf('}, [backend, toolContextKey, hostList]);', toolsEffectAt));
  assert.match(effect, /if \(!backend\) return;/, 'the effect waits until a backend is available');
});
