import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const app = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const styles = await fs.readFile(new URL('../src/apex-agent-dock.css', import.meta.url), 'utf8');

test('expanded ApexAgent hides the canvas while keeping its pane tree mounted', () => {
  assert.match(app, /className=\{`body[\s\S]*?apexAgentFull && \(apexAgentAllOpen \|\| !!apexWorkspace\) \? " apex-agent-dock-expanded"/);
  assert.match(app, /<main ref=\{canvasRef\} className=\{`canvas section-\$\{section\}`\} inert=\{\(sidePanelFull \|\| \(apexAgentFull && \(apexAgentAllOpen \|\| !!apexWorkspace\)\)\) \? true : undefined\} aria-hidden=\{\(sidePanelFull \|\| \(apexAgentFull && \(apexAgentAllOpen \|\| !!apexWorkspace\)\)\) \? true : undefined\}>/);
  assert.match(styles, /\.body\.apex-agent-dock-expanded > \.canvas \{ display: none; \}/);
  assert.match(styles, /\.body\.apex-agent-dock-expanded > \.apex-agent-dock\.apex-agent-full/);
  assert.match(app, /<main[^>]*>[\s\S]*?<div ref=\{gridArea\} className=\{`grid/);
  assert.match(app, /<\/main>\s*\{!apexWorkspace && apexAgentAllOpen && <aside/);
});

test('expansion and collapse only change ApexAgent presentation, preserving canvas and layout state', () => {
  const line = app.split('\n').find(value => value.includes('const toggleApexAgentFull ='));
  const expression = line?.slice(line.indexOf('=') + 1).trim().replace(/;$/, '');
  assert.ok(expression, 'the full-screen toggle exists');
  const writes = [];
  let full = false;
  const toggle = new Function('setApexAgentFull', 'localStorage', `return ${expression};`)(
    update => { full = update(full); },
    { setItem: (key, value) => writes.push([key, value]) },
  );
  assert.equal(typeof toggle, 'function');
  toggle();
  assert.equal(full, true);
  toggle();
  assert.equal(full, false);
  assert.deepEqual(writes, [['apex-agent-full-screen', '1'], ['apex-agent-full-screen', '0']]);
  assert.doesNotMatch(expression, /setTree|setFocusedPane|setMaximized|focusPane|arrange\(/,
    'expansion does not rewrite the canvas layout, selected pane, or maximized pane');
  assert.match(app, /const \[apexAgentFull, setApexAgentFull\]/);
  assert.match(app, /onClose=\{apexAgentFull \? toggleApexAgentFull : closeApexAgentAndReturnFocus\}/,
    'the avatar close action collapses the expanded panel without closing the assistant');
});

test('all-project and project views use the same expanded dock mode', () => {
  const allPath = app.match(/\{!apexWorkspace && apexAgentAllOpen && <aside([\s\S]*?)<\/aside>\}/)?.[1];
  const projectPath = app.match(/\{apexWorkspace && <aside([\s\S]*?)<\/aside>\}/)?.[1];
  assert.ok(allPath, 'the all-project conversation dock renders');
  assert.ok(projectPath, 'the selected-project sources dock renders');
  for (const [name, path] of [['all-project', allPath], ['project', projectPath]]) {
    assert.match(path, /apex-agent-dock apex-agent-float\$\{apexAgentFull \? " apex-agent-full" : ""\}/, `${name} view uses the full dock class`);
  }
  assert.match(allPath, /<ApexAgentAll[\s\S]*?fullScreen=\{apexAgentFull\} onFullScreen=\{toggleApexAgentFull\}/,
    'the all-project conversation toggles the shared expansion state');
  assert.match(projectPath, /onClick=\{toggleApexAgentFull\}[\s\S]*?aria-label=\{apexAgentFull \? "Collapse ApexAgent" : "Expand ApexAgent"\}/,
    'the project setup view exposes an accessible expand and collapse control');
  assert.doesNotMatch(allPath, /key=.*apexAgentFull/);
  assert.doesNotMatch(projectPath, /key=.*apexAgentFull/);
});

test('the floating avatar stays mounted and available while ApexAgent is expanded', () => {
  const widget = app.match(/<ApexAgentWidget([\s\S]*?)\/>/)?.[1];
  assert.ok(widget, 'the avatar widget remains in the app shell');
  assert.match(widget, /open=\{!!apexWorkspace \|\| apexAgentAllOpen\}/);
  assert.match(widget, /onClose=\{apexAgentFull \? toggleApexAgentFull : closeApexAgentAndReturnFocus\}/);
  assert.ok(app.indexOf('<ApexAgentWidget') < app.indexOf('<div className={`body'),
    'the avatar remains outside the canvas area hidden by expanded mode');
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
