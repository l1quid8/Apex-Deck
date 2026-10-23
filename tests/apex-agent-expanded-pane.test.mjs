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
test('the four production destinations retain their existing Agents workflow', () => {
 assert.match(app,/<SectionNavigation section=\{section\}/);
 assert.match(app,/<AgentsSection agents=\{agents\} backend=\{backend\} profiles=\{profiles\}/);
 assert.match(app,/onCreateAssistant=/);
 assert.match(app,/onOpenAssistant=\{openAssistant\}/);
});
test('Memory and Settings route into the assistant main canvas', () => {
 assert.match(app,/lane=\{selectedAssistant\} section=\{mainView.section\}/);
 assert.match(app,/onNavigatePanel=\{panel=>navigateAssistant\(panel==='activity'\?'work':panel\)\}/);
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
