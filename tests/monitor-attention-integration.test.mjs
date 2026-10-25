import {assistantIdentityKey, assistantAppearance} from '../src/assistantIdentity.ts';
import {assistantSidebarPanes, assistantThreadKey} from '../src/assistantSidebar.ts';
import {rosterMessage} from '../src/assistantWorkspaceModel.ts';
import {assistantStatus} from '../src/assistantStatus.ts';
import {subscribeToImports} from '../src/legacyImportRefresh.ts';
import {chatFolder, mountWorktree} from "../src/worktreeMount.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { transform } from 'sucrase';
import * as assistantWorkspaceModel from '../src/assistantWorkspaceModel.ts';
import * as attention from '../src/attention.ts';
import { loadStartupState } from '../src/startupState.ts';
import * as monitorAttention from '../src/monitorAttention.ts';
import * as canvasPanes from '../src/canvasPanes.ts';
import * as layout from '../src/layout.ts';
import * as paneHost from '../src/paneHost.ts';
import * as themes from '../src/themes.ts';
import * as assistantRegistry from '../src/assistantRegistry.ts';
import * as overviewModel from '../src/apexAgentOverview.ts';
import * as rightPanelModel from '../src/rightPanelModel.ts';
import * as assistantTaskModel from '../src/assistantTaskModel.ts';
import * as assistantName from '../src/assistantName.ts';

const appUrl = new URL('../src/App.tsx', import.meta.url);
const appSource = await fs.readFile(appUrl, 'utf8');
const compiled = transform(appSource.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), {
  transforms: ['typescript', 'jsx'], jsxRuntime: 'classic',
}).code;

const project = { id: 'project-a', name: 'Project A', hostId: 'host-a', path: '/work/project-a' };
const pane = { id: 'thread-a', workspaceId: project.id, kind: 'chat', title: 'Ordinary thread', closed: false };
const evidence = { sourceId: 'file:README.md', label: 'README.md', observedAt: 1_700_000_000_000, excerpt: 'A release is blocked.' };
const blocker = {
  workspaceId: project.id, conversationId: 'monitor-a', cwd: project.path, hostId: 'host-a', profileId: 'profile-a',
  responsibility: 'Track release readiness', nextStep: 'Resolve the release blocker', decisions: [], preferences: [], files: ['README.md'], threads: [],
  paused: false, completed: false, revision: 3,
  messages: [{ id: 'message-a', role: 'assistant', text: 'The release is blocked.', at: evidence.observedAt, evidence: [evidence] }],
  findings: [{ id: 'finding-a', summary: 'Release gate is failing', reason: 'The required check is failing.', confidence: 'observed', nextStep: 'Repair the check', evidence: [evidence], status: 'open', firstSeenAt: evidence.observedAt, lastSeenAt: evidence.observedAt, lastNotifiedAt: 0, snoozedUntil: null }],
  activity: [{ at: evidence.observedAt, kind: 'finding_opened', summary: 'Release gate is failing' }],
  lastCheckedAt: evidence.observedAt, nextCheckAt: null, wakeReason: null, evidenceFingerprint: 'fingerprint-a', activeCheck: null, error: null,
};
const resolvedBlocker = { ...blocker, findings: blocker.findings.map(f => ({ ...f, status: 'resolved' })) };

function importedNames() {
  return [...appSource.matchAll(/^import\s+(.+?)\s+from\s+["'](.+?)["'];?$/gm)].flatMap(([, clause, specifier]) => {
    if (clause.startsWith('type ')) return [];
    const body = clause.startsWith('{') ? clause.slice(1, clause.lastIndexOf('}')) : clause;
    return body.split(',').map(part => part.trim()).filter(part => part && !part.startsWith('type ')).map(part => ({
      name: part.includes(' as ') ? part.split(' as ')[1].trim() : part,
      imported: part.includes(' as ') ? part.split(' as ')[0].trim() : part,
      specifier,
    }));
  });
}

function appHarness() {
  const states = [], refs = [], effects = [];
  const stored = new Map(); let requestSequence = 0;
  let cursor = 0, alive = true, props;
  const listeners = new Map();
  let sessionChanged;
  const connectionStates = new Map();
  const connectionListeners = new Map();
  function connectionFor(hostId) {
    if (!connectionStates.has(hostId)) connectionStates.set(hostId, { status: { kind: 'connected', hostId }, revision: 1 });
    if (!connectionListeners.has(hostId)) connectionListeners.set(hostId, new Set());
    return {
      get: () => ({ hostId, name: `Host ${hostId}`, ...connectionStates.get(hostId), agents: [], discovery: 'ready' }),
      subscribe: fn => { const listeners = connectionListeners.get(hostId); listeners.add(fn); return () => listeners.delete(fn); },
    };
  }
  const session = { workspaces: [project], panes: [pane], activeWorkspace: project.id, focusedPane: null, section: 'threads', profiles: [] };
  let backend;
  const hostBackends = new Map();
  const backendForHost = hostId => {
    if (hostId === 'host-a') return backend;
    if (!hostBackends.has(hostId)) hostBackends.set(hostId, { ...backend, host: { id: hostId, connection: connectionFor(hostId) } });
    return hostBackends.get(hostId);
  };
  backend = {
    demo: false, host: { id: 'host-a', connection: connectionFor('host-a') },
    machines: {
      get: id => backendForHost(id),
      connection: id => connectionFor(id ?? 'host-a'),
      discover: async () => [], legacySession: async () => null,
    },
    hosts: { list: async () => [], references: async () => {} },
    detectAgents: async () => [], startupFolders: async () => [], sessionLoad: async () => session,
    settingsLoad: async () => null, sessionSave: async () => {}, settingsSave: async () => {},
    flagAttention: async () => {}, requestCriticalAttention: async () => {},
    onQuitRequested: async () => () => {},
    onSessionChanged: async fn => { sessionChanged = fn; return () => { sessionChanged = undefined; }; },
    call: async (command) => command === 'monitor_get' ? null : { workspaceId: project.id, revision: 0, tasks: [], executions: [] },
  };
  const React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { if (alive) states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial }; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) { const i = cursor++; const prev = effects[i]; if (!prev || !deps || deps.some((v, j) => !Object.is(v, prev.deps[j]))) effects[i] = { fn, deps, changed: true }; },
    useLayoutEffect(fn, deps) { hooks.useEffect(fn, deps); },
    useSyncExternalStore(_subscribe, get) { cursor++; return get(); },
  };
  const mountSource = fsSync.readFileSync(new URL('../src/useWorktreeMount.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function');
  const mountCode = transform(mountSource, {transforms:['typescript']}).code;
  const useWorktreeMount = new Function('useEffect','useRef','useState','mountWorktree',mountCode+';return useWorktreeMount;')(hooks.useEffect,hooks.useRef,hooks.useState,mountWorktree);
  const assistantRef={hostId:project.hostId,assistantId:'assistant-a'};
  const personalRecord={id:'assistant-a',hostId:project.hostId,name:'Null',revision:1,messages:[],tasks:[],projects:[{project:{hostId:project.hostId,workspaceId:project.id,cwd:project.path},tools:'ask'}]};
  const personalLane={ref:assistantRef,draftKey:assistantIdentityKey(assistantRef),name:'Null',hostName:'Mac',assistant:personalRecord,offline:false,send:async()=>{}};
  const assistantCollection={archivedAssistants:[],restoreAssistant:async()=>{},assistants:[{ref:assistantRef,name:'Null',hostName:'Mac',offline:false,paused:false,personalTasks:[],projects:[]}],selected:assistantRef,hosts:[{hostId:project.hostId,routeHostId:project.hostId,name:'Mac',state:'ready'}],lane:()=>personalLane,pendingLane:()=>null,emptyLane:()=>null,select(){},refresh:async()=>{}};
  const defaults = {
    ...assistantWorkspaceModel,
    assistantIdentityKey,rosterMessage,assistantSidebarPanes,assistantThreadKey,
    usePersonalAssistants:()=>assistantCollection,

    subscribeToImports,
    chatFolder, useWorktreeMount,
    getBackend: async () => backend,
    DEFAULT_SETTINGS: { disabledProviders: [], theme: 'dark' },
    readSettings: () => ({ disabledProviders: [] }),
    connection: { subscribe: () => () => {}, get: () => ({ status: { kind: 'connected' } }) },
    statusWords: {},
    modHost: { start() {} },
    startHub: async () => () => {},
    approvalSnapshot: () => ({}), subscribeApprovals: () => () => {},
    openCards: () => [], dueEscalations: () => [], escalationKey: () => '',
    remoteSessionEdit: (_local, remote) => remote,
    normalizeWorkspaces: ws => ws ?? [], loadedPanes: ps => ps ?? [], migrateCanvasLayouts: value => ({ layouts: value.layouts ?? {} }),
    restoredLayouts: () => ({}), savedLayouts: () => ({}), savedPanes: ps => ps,
    shownWorkspaces: ws => ws, listedPanes: (ps, ws) => ps.filter(p => ws.some(w => w.id === p.workspaceId)),
    workspaceHost: w => w.hostId ?? 'local', workspaceFamily: (_ws, id) => id,
    addFolders: list => ({ list, ids: [] }),
    canvasPanes: () => [],
    activeAfter: (_list, active) => active,
    loadWidths: () => ({ rail: null, details: null }), saveWidths: () => {},
    SIDEBAR_DEFAULT: { details: 300 },
    SIDEBAR_DEFAULT: { details: 300 },
    detailsOverlay: () => false, detailsThread: () => null, noteFocus: (recent, id) => [id, ...(recent ?? []).filter((item) => item !== id)],
    approvalState: {},
    ...attention,
    ...monitorAttention,
    ...canvasPanes,
    ...layout,
    loadStartupState,
    ...paneHost,
    ...themes,
    ...assistantRegistry,
    ...assistantTaskModel,
    ...assistantName,
    ...overviewModel,
    ...rightPanelModel,
    selectCurrentAssistantRegistry: assistantRegistry.currentAssistantRegistry,
    hostTints: () => new Map(),
    usePaneDrag: () => ({ dragging: false }),
    layoutKey: () => '',
    pickerRows: () => [], workInRows: () => [],
  };
  const componentNames = new Set(['HostPane','HostAgents','HostMonitors','SettingsPage','ThreadName','ChatPane','ModOverlays','ModStatuses','SectionNavigation','AgentsSection','ApexAgentSources','ApexAgentAll','ApexAgentTasks','ApexAgentWidget','AssistantWorkspace','AssistantEditor','LibraryView','DeckIcon','NewMenu','TerminalPane','PreviewPane','ProjectSidebar','ConnectionDialog','MenuList','Glyph','ProjectFolder','Dividers','ConfirmDialog','PathPrompt','SidebarHandle','RightPanel']);
  const globalValues = {
    localStorage: { getItem: key => stored.get(key) ?? null, setItem(key, value) { stored.set(key, value); }, removeItem(key) { stored.delete(key); } },
    crypto: { randomUUID: () => `request-${++requestSequence}` },
    window: { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {} },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, hasFocus: () => false, activeElement: null, body: {}, querySelector: () => null },
    navigator: { platform: 'Linux', userAgent: 'node' },
    ResizeObserver: class { observe() {} disconnect() {} },
    setInterval: () => 1, clearInterval() {}, requestAnimationFrame: fn => fn(),
    setTimeout, clearTimeout, queueMicrotask, Date, Math, JSON, Object, Array, Set, Map, Promise, Error, String, Number, RegExp, Intl, console,
  };
  const names = importedNames();
  const bindings = new Map();
  for (const { name, imported, specifier } of names) {
    if (specifier === 'react') continue;
    if (imported === 'type') continue;
    const known = defaults[name];
    if (known !== undefined) bindings.set(name, known);
    else if (componentNames.has(name)) { const component = function StubComponent() {}; component.displayName = name; bindings.set(name, component); }
    else bindings.set(name, (..._args) => undefined);
  }
  const scopeNames = ['React', ...Object.keys(hooks), ...names.filter(n => n.specifier !== 'react').map(n => n.name), ...Object.keys(globalValues)];
  const scopeValues = [React, ...Object.values(hooks), ...names.filter(n => n.specifier !== 'react').map(n => bindings.get(n.name)), ...Object.values(globalValues)];
  const App = new Function(...scopeNames, `${compiled}; return App;`)(...scopeValues);
  function render() {
    cursor = 0;
    const tree = App(props);
    for (const effect of effects) if (effect?.changed) { effect.changed = false; effect.cleanup?.(); effect.cleanup = effect.fn(); }
    return tree;
  }
  function unmount() { alive = false; for (const effect of effects) effect?.cleanup?.(); }
  return {
    render, unmount, backend, session, stored, assistantRef, personalLane, assistantCollection,
    emitSession(workspaces) { sessionChanged?.({ ...session, workspaces, panes: session.panes }); },
    setConnection(status, hostId = 'host-a') {
      const previous = connectionStates.get(hostId) ?? { status: { kind: 'connected' }, revision: 1 };
      connectionStates.set(hostId, { status: status.kind === 'connected' && !status.hostId ? { ...status, hostId } : status, revision: previous.revision + 1 });
      connectionListeners.get(hostId)?.forEach(fn => fn());
    },
  };
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of [...(node.children ?? []),node.props?.chat,node.props?.work,node.props?.editor]) { const found = find(child, predicate); if (found) return found; }
  return null;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const child = (tree, name) => find(tree, node => typeof node.type === 'function' && (node.type.displayName ?? node.type.name) === name);
// Global attention lives in the section tabs' hover lists; a monitor blocker is
// one Threads row keyed by its workspace.
const attentionMenuOf = tree => child(tree, 'SectionNavigation');
const monitorRowsOf = tree => (attentionMenuOf(tree)?.props.flags?.threads?.rows ?? []).filter(row => row.key.startsWith('apex-monitor:'));
const monitorRowFor = (tree, workspaceId) => monitorRowsOf(tree).find(row => row.key === `apex-monitor:${workspaceId}`);
const hasMonitorAttention = tree => Boolean(monitorRowFor(tree, project.id));
// The avatar opens one conversation for every project; project setup opens from it.
const agentOf = (h, tree) => {
  const all = child(tree, 'ApexAgentAll');
  if (all && !child(tree, 'ApexAgentSources')) { all.props.onSetUp(project.id); tree = h.render(); }
  return child(tree, 'ApexAgentSources');
};
const monitorAttentionItem = tree => monitorRowFor(tree, project.id);

test('Your team opens durable assistants in the main canvas and Back restores workspace panes',async()=>{
 const h=appHarness();let tree=h.render();await tick();tree=h.render();
 assert.equal(child(tree,'ProjectSidebar').props.assistants[0].ref.assistantId,'assistant-a');
 child(tree,'ProjectSidebar').props.onOpenAssistant(h.assistantRef);tree=h.render();
 const view=child(tree,'AssistantWorkspace');assert.ok(view);assert.equal(view.props.lane.ref.assistantId,'assistant-a');assert.equal(child(tree,'ApexAgentWidget'),null);
 {const rail=child(tree,'ProjectSidebar').props;assert.ok(rail.panes.length,'harness has a pane');rail.onOpenPane(rail.panes[0]);};tree=h.render();assert.equal(child(tree,'AssistantWorkspace'),null);assert.ok(child(tree,'ProjectSidebar'));
 h.unmount();
});
test('assistant navigation leaves global panel selection and open state unchanged',async()=>{
 const h=appHarness();let tree=h.render();await tick();tree=h.render();
 const before=child(tree,'RightPanel')?.props.state;
 child(tree,'ProjectSidebar').props.onOpenAssistant(h.assistantRef);tree=h.render();
 child(tree,'AssistantWorkspace').props.onNavigate('memory');tree=h.render();
 assert.deepEqual(child(tree,'RightPanel')?.props.state,before);assert.equal(child(tree,'AssistantWorkspace').props.section,'memory');h.unmount();
});
test('main assistant project reply retains its request ID until the exact assignment response is confirmed', async () => {
  const h = appHarness(); let tree = h.render(); await tick(); tree = h.render();
  const requests = [];
  let wrongOwner = true;
  h.backend.call = async (command, args) => {
    if (command === 'monitor_get') return blocker;
    if (command === 'assistant_message') {
      requests.push(args);
      return { monitor: wrongOwner ? { ...blocker, conversationId: 'old-assignment' } : blocker };
    }
    return { workspaceId: project.id, revision: 0, tasks: [], executions: [] };
  };
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef);tree=h.render();
  const reply = child(tree, 'ApexAgentAll').props.onReply;
  await assert.rejects(reply(project.id, 'Check the release'), /assignment|conversation/i);
  const key = assistantTaskModel.pendingRequestStorageKey({ workspaceId: project.id, cwd: project.path, hostId: project.hostId, conversationId: blocker.conversationId });
  assert.ok(h.stored.has(key), 'an unconfirmed response retains durable retry identity');
  wrongOwner = false;
  await reply(project.id, 'Check the release');
  assert.equal(requests[0].requestId, requests[1].requestId, 'retry reuses the same human request');
  assert.equal(h.stored.has(key), false, 'only an exact confirmed response clears it');
  h.unmount();
});

test('main assistant project reply refuses an assignment changed while sending and keeps its original receipt', async () => {
  const h = appHarness(); let tree = h.render(); await tick(); tree = h.render();
  let liveMonitor = blocker, finish, sent;
  h.backend.call = (command, args) => {
    if (command === 'monitor_get') return Promise.resolve(liveMonitor);
    if (command === 'assistant_message') { sent = args; return new Promise(resolve => { finish = resolve; }); }
    return Promise.resolve({ workspaceId: project.id, revision: 0, tasks: [], executions: [] });
  };
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef);tree=h.render();
  const promise = child(tree, 'ApexAgentAll').props.onReply(project.id, 'Check the release');
  await tick();
  liveMonitor = { ...blocker, conversationId: 'new-assignment' };
  finish({ monitor: blocker });
  await assert.rejects(promise, /assignment|conversation|changed/i);
  assert.equal(JSON.parse(h.stored.get(assistantTaskModel.pendingRequestStorageKey(sent))).requestId, sent.requestId);
  assert.equal(hasMonitorAttention(h.render()), false, 'the old conversation cannot restore attention');
  h.unmount();
});

test('monitor blockers survive conversation visits and pane attention cleanup, then clear on resolution', async () => {
  const h = appHarness();
  let tree = h.render(); await tick(); tree = h.render();
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef); tree = h.render();
  const apex = agentOf(h, tree);
  assert.ok(apex, 'ApexAgent is present after opening its workspace');
  apex.props.onMonitorChange?.(project.id, project.hostId, blocker);
  tree = h.render();
  const attentionMenu = attentionMenuOf(tree);
  assert.ok(hasMonitorAttention(tree), 'App exposes the blocker in global attention');
  assert.equal(child(tree, 'ProjectSidebar')?.props.monitorAttention?.[project.id]?.blocking, true, 'the workspace sidebar marks the blocker before reading the conversation');

  attentionMenu.props.onMarkReadySeen();
  tree = h.render();
  assert.ok(hasMonitorAttention(tree), 'clearing ordinary Ready flags leaves monitor attention');
  assert.equal(child(tree, 'ProjectSidebar')?.props.monitorAttention?.[project.id]?.blocking, true, 'clearing Ready flags leaves the workspace blocker visible');

  const monitorItem = monitorAttentionItem(tree);
  const open = attentionMenuOf(tree);
  open.props.onOpen(monitorItem.paneId);
  tree = h.render();
  const openedAgent = agentOf(h, tree);
  openedAgent.props.onClose(); tree = h.render();
  assert.ok(hasMonitorAttention(tree), 'closing the monitor conversation leaves the blocker active');
  assert.equal(child(tree, 'ProjectSidebar')?.props.monitorAttention?.[project.id]?.blocking, true, 'opening and closing the conversation does not clear the workspace blocker');

  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef);
  tree = h.render();
  const reopenedAgent = agentOf(h, tree);
  reopenedAgent.props.onMonitorChange?.(project.id, project.hostId, resolvedBlocker);
  tree = h.render();
  assert.equal(hasMonitorAttention(tree), false, 'an explicit resolved snapshot removes monitor attention');
  h.unmount();
});

test('monitor snapshots are accepted only for the rendered workspace, host, and path', async () => {
  const h = appHarness();
  let tree = h.render(); await tick(); tree = h.render();
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef);
  tree = h.render();
  const apex = agentOf(h, tree);
  assert.equal(typeof apex.props.onMonitorChange, 'function');
  apex.props.onMonitorChange('workspace-other', project.hostId, { ...blocker, workspaceId: 'workspace-other' });
  apex.props.onMonitorChange(project.id, 'host-other', { ...blocker, hostId: 'host-other' });
  apex.props.onMonitorChange(project.id, project.hostId, { ...blocker, cwd: '/work/another-project' });
  tree = h.render();
  assert.equal(hasMonitorAttention(tree), false, 'snapshots from a different workspace, host, or path are rejected');
  apex.props.onMonitorChange(project.id, project.hostId, blocker);
  tree = h.render();
  assert.equal(hasMonitorAttention(tree), true, 'the current workspace snapshot is accepted');
  h.unmount();
});

test('an ApexAgent callback from an old workspace path cannot add or clear attention', async () => {
  const h = appHarness();
  let tree = h.render(); await tick(); tree = h.render();
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef);
  tree = h.render();
  const staleChange = agentOf(h, tree).props.onMonitorChange;
  staleChange(project.id, project.hostId, blocker);
  tree = h.render();
  assert.equal(hasMonitorAttention(tree), true);

  h.emitSession([{ ...project, path: '/work/project-a-moved' }]);
  await tick(); tree = h.render();
  staleChange(project.id, project.hostId, resolvedBlocker);
  staleChange(project.id, project.hostId, blocker);
  tree = h.render();
  assert.equal(hasMonitorAttention(tree), false, 'both stale blocker and null/resolution callbacks are ignored after the cwd changes');
  h.unmount();
});

test('an ApexAgent callback from a removed workspace is ignored, including null', async () => {
  const h = appHarness();
  let tree = h.render(); await tick(); tree = h.render();
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef);
  tree = h.render();
  const staleChange = agentOf(h, tree).props.onMonitorChange;
  staleChange(project.id, project.hostId, blocker);
  tree = h.render();
  assert.equal(hasMonitorAttention(tree), true);

  h.emitSession([]);
  await tick(); tree = h.render();
  staleChange(project.id, project.hostId, null);
  staleChange(project.id, project.hostId, blocker);
  tree = h.render();
  assert.equal(hasMonitorAttention(tree), false, 'a removed workspace callback cannot recreate durable attention');
  h.unmount();
});

test('a host poll snapshot from before a workspace binding change cannot restore stale attention', async () => {
  const h = appHarness();
  let tree = h.render(); await tick(); tree = h.render();
  const oldPoll = child(tree, 'HostMonitors');
  assert.ok(oldPoll, 'App mounts host monitor polling');
  assert.equal(typeof oldPoll.props.onMonitors, 'function');
  const oldVersion = oldPoll.props.getVersion?.(project.hostId);
  assert.equal(typeof oldVersion, 'number', 'App gives host polling an ownership version');

  h.emitSession([{ ...project, path: '/work/project-a-moved' }]);
  await tick(); tree = h.render();
  const currentPoll = child(tree, 'HostMonitors');
  assert.ok(currentPoll);
  const currentVersion = currentPoll.props.getVersion?.(project.hostId);
  assert.equal(typeof currentVersion, 'number');
  assert.notEqual(currentVersion, oldVersion, 'workspace path changes invalidate in-flight polls');
  oldPoll.props.onMonitors(project.hostId, [blocker]);
  tree = h.render();
  assert.equal(hasMonitorAttention(tree), false, 'an old cwd snapshot cannot reintroduce the blocker');
  h.unmount();
});

test('a successful host monitor snapshot adds attention and an empty snapshot clears that host', async () => {
  const h = appHarness();
  let tree = h.render(); await tick(); tree = h.render();
  const poll = child(tree, 'HostMonitors');
  assert.ok(poll, 'App mounts host monitor polling');
  assert.equal(typeof poll.props.onMonitors, 'function', 'App handles successful host snapshots');

  poll.props.onMonitors(project.hostId, [blocker]);
  tree = h.render();
  assert.ok(monitorAttentionItem(tree), 'a valid host snapshot adds global monitor attention');
  assert.equal(child(tree, 'ProjectSidebar')?.props.monitorAttention?.[project.id]?.blocking, true, 'the valid snapshot marks its workspace as blocked');

  const currentPoll = child(tree, 'HostMonitors');
  currentPoll.props.onMonitors(project.hostId, []);
  tree = h.render();
  assert.equal(hasMonitorAttention(tree), false, 'a successful empty snapshot clears that host’s monitor attention');
  assert.equal(child(tree, 'ProjectSidebar')?.props.monitorAttention?.[project.id]?.blocking, false, 'the empty snapshot clears the workspace blocker');
  h.unmount();
});

test('host monitor snapshots reconcile only their own host across multiple workspaces', async () => {
  const h = appHarness();
  let tree = h.render(); await tick(); tree = h.render();
  const secondProject = { id: 'project-b', name: 'Project B', hostId: 'host-b', path: '/work/project-b' };
  h.emitSession([project, secondProject]);
  await tick(); tree = h.render();

  const polls = [];
  const collect = node => {
    if (node && typeof node === 'object') {
      if (typeof node.type === 'function' && (node.type.displayName ?? node.type.name) === 'HostMonitors') polls.push(node);
      for (const childNode of node.children ?? []) collect(childNode);
    }
  };
  collect(tree);
  assert.deepEqual(polls.map(node => node.props.hostId).sort(), ['host-a', 'host-b'], 'App mounts one monitor poller for each active workspace host');

  const blockerB = { ...blocker, workspaceId: secondProject.id, hostId: secondProject.hostId, cwd: secondProject.path,
    findings: blocker.findings.map(finding => ({ ...finding, id: 'finding-b' })) };
  polls.find(node => node.props.hostId === 'host-a').props.onMonitors('host-a', [blocker]);
  polls.find(node => node.props.hostId === 'host-b').props.onMonitors('host-b', [blockerB]);
  tree = h.render();
  assert.deepEqual(monitorRowsOf(tree).map(row => row.key).sort(), [`apex-monitor:${project.id}`, `apex-monitor:${secondProject.id}`]);

  const currentPolls = [];
  collect(tree);
  currentPolls.push(...polls.splice(0));
  currentPolls.find(node => node.props.hostId === 'host-a').props.onMonitors('host-a', []);
  tree = h.render();
  assert.deepEqual(monitorRowsOf(tree).map(row => row.key), [`apex-monitor:${secondProject.id}`], 'an empty host A snapshot preserves host B attention');
  h.unmount();
});

test('an ApexAgent callback from before host reconnection cannot clear the current blocker', async () => {
  const h = appHarness();
  let tree = h.render(); await tick(); tree = h.render();
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef);
  tree = h.render();
  const staleChange = agentOf(h, tree).props.onMonitorChange;
  staleChange(project.id, project.hostId, blocker);
  tree = h.render();
  assert.equal(hasMonitorAttention(tree), true, 'the first connected snapshot is current');

  h.setConnection({ kind: 'failed', reason: 'connection lost' });
  tree = h.render();
  h.setConnection({ kind: 'connected' });
  tree = h.render();
  const currentChange = agentOf(h, tree)?.props.onMonitorChange;
  assert.equal(typeof currentChange, 'function');
  currentChange(project.id, project.hostId, blocker);
  tree = h.render();
  staleChange(project.id, project.hostId, null);
  tree = h.render();

  assert.equal(hasMonitorAttention(tree), true, 'a pre-reconnect null callback cannot clear the post-reconnect blocker');
  h.unmount();
});

test('a stale callback after workspace host rebinding cannot clear the new host blocker', async () => {
  const h = appHarness();
  let tree = h.render(); await tick(); tree = h.render();
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef);
  tree = h.render();
  const oldHostChange = agentOf(h, tree).props.onMonitorChange;
  oldHostChange(project.id, 'host-a', blocker);
  tree = h.render();
  assert.equal(hasMonitorAttention(tree), true, 'the original host snapshot is accepted');

  h.emitSession([{ ...project, hostId: 'host-b' }]);
  await tick(); tree = h.render();
  const currentHostChange = agentOf(h, tree)?.props.onMonitorChange;
  assert.equal(agentOf(h, tree)?.props.backend?.host?.id, 'host-b', 'the rendered conversation follows the new workspace host');
  assert.equal(typeof currentHostChange, 'function');
  currentHostChange(project.id, 'host-b', { ...blocker, hostId: 'host-b' });
  tree = h.render();
  oldHostChange(project.id, 'host-a', null);
  tree = h.render();

  assert.equal(monitorAttentionItem(tree)?.hostName, 'Host host-b', 'a stale null from the prior host cannot clear the current host blocker');
  h.unmount();
});

// The tests above stub every child of App and inspect the props it hands
// them. These run the real SectionNavigation and ProjectSidebar code against
// those props, so they check what the screen would show.

const answerStrip = await import('../src/answerStrip.ts');
const approvals = await import('../src/approvals.ts');
const sidebarModel = await import('../src/sidebarModel.ts');
const hostSession = await import('../src/hostSession.ts');
const hostFacts = await import('../src/hostFacts.ts');

function stubComponent(name) { const component = function StubComponent() { return null; }; component.displayName = name; return component; }

/** Compile one component file and run it with a small hook runtime that keeps its own state between renders. */
function mountComponent(file, exportName, modules) {
  const source = fsSync.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const code = transform(source.replace(/^import [\s\S]*?;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
  const states = [], refs = [], effects = [];
  let cursor = 0;
  const React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) { const i = cursor++; const prev = effects[i]; if (!prev || !deps || deps.some((v, j) => !Object.is(v, prev.deps[j]))) effects[i] = { fn, deps, cleanup: prev?.cleanup, changed: true }; },
    useLayoutEffect(fn, deps) { hooks.useEffect(fn, deps); },
    useSyncExternalStore(_subscribe, get) { cursor++; return get(); },
  };
  const globals = {
    window: { addEventListener() {}, removeEventListener() {}, setTimeout: () => 0, clearTimeout() {} },
    // Vite defines these at build time.
    __APP_VERSION__: '0.0.0-test', __APP_BUILD__: 'test',
    document: { activeElement: null, body: {} },
    navigator: { platform: 'Linux', userAgent: 'node' },
    requestAnimationFrame: fn => fn(), CSS: { escape: s => s },
  };
  const scope = { React, ...hooks, ...globals, ...modules };
  const Component = new Function(...Object.keys(scope), `${code}; return ${exportName};`)(...Object.values(scope));
  return props => {
    cursor = 0;
    const tree = Component(props);
    for (const effect of effects) if (effect?.changed) { effect.changed = false; effect.cleanup?.(); effect.cleanup = effect.fn(); }
    return tree;
  };
}

const textOf = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.children ?? []).map(textOf).join('');
const classOf = node => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean);

function realSectionNavigation() {
  return mountComponent('SectionNavigation.tsx', 'SectionNavigation', {
    Diff: stubComponent('Diff'), nextLine: answerStrip.nextLine, stripView: answerStrip.stripView, ago: attention.ago,
  });
}
/** The Threads tab, and the hover list it opens when it has something waiting. */
const threadsTab = nav => find(nav, node => node.type === 'button' && classOf(node).includes('section-button') && classOf(node).includes('threads'));
function hoverThreads(drawNav, tree) {
  const props = child(tree, 'SectionNavigation').props;
  threadsTab(drawNav(props)).props.onMouseEnter?.({ currentTarget: { offsetLeft: 0 } });
  return drawNav(props);
}
const attentionRows = nav => {
  const rows = [];
  (function collect(node) { if (node && typeof node === 'object') { if (classOf(node).includes('attention-row')) rows.push(node); (node.children ?? []).forEach(collect); } })(nav);
  return rows;
};

function realSidebar() {
  return mountComponent('Sidebar.tsx', 'ProjectSidebar', {
    assistantIdentityKey,assistantAppearance,Avatar:stubComponent('Avatar'),createAssistantAvatarApi:()=>undefined,AssistantTeamRow:stubComponent('AssistantTeamRow'),assistantStatus,
    flagLabel: attention.label, workspaceFlag: attention.workspaceFlag,
    workspaceHost: hostSession.workspaceHost,
    ageWords: sidebarModel.ageWords, hostTints: sidebarModel.hostTints, projectGroups: sidebarModel.projectGroups, sidebarSections: sidebarModel.sidebarSections, twinPath: sidebarModel.twinPath,
    dotState: hostFacts.dotState,
    DOT_WORDS: hostFacts.DOT_WORDS, DeckIcon: stubComponent('DeckIcon'),
    MenuList: stubComponent('MenuList'), HoverCard: stubComponent('HoverCard'), ProjectCard: stubComponent('ProjectCard'), ThreadCard: stubComponent('ThreadCard'),
    useHoverCard: () => ({ target: null, enter() {}, leave() {}, hide() {}, keep() {} }),
    Glyph: stubComponent('Glyph'), ProjectFolder: stubComponent('ProjectFolder'), ThreadName: stubComponent('ThreadName'), WorkspaceHostMenu: stubComponent('WorkspaceHostMenu'),
  });
}

/** What the rendered sidebar shows for the project's attention badge, or null when there is none. */
const sidebarBadge = (drawSidebar, tree) => find(drawSidebar(child(tree, 'ProjectSidebar').props), node => classOf(node).includes('flag-count'));

test('a rendered sidebar chat drag carries its owning folder and machine', async () => {
  const h = appHarness(); let tree = h.render(); await tick(); tree = h.render();
  const sidebar = realSidebar()(child(tree, 'ProjectSidebar').props);
  const row = find(sidebar, node => node.props['data-pane-row'] === pane.id);
  assert.equal(row.props.draggable, true);
  const values = new Map(); const dataTransfer = { setData: (kind, text) => values.set(kind, text) };
  row.props.onDragStart({ dataTransfer });
  assert.equal(dataTransfer.effectAllowed, 'copy');
  assert.deepEqual(JSON.parse(values.get('application/x-apex-agent-source')), { workspaceId: project.id, hostId: project.hostId, cwd: project.path, kind: 'thread', sourceId: pane.id });
  h.unmount();
});

test('the rendered section alerts and sidebar badge keep an unresolved ApexAgent blocker after the conversation is read', async () => {
  const h = appHarness();
  const drawNav = realSectionNavigation();
  const drawSidebar = realSidebar();
  let tree = h.render(); await tick(); tree = h.render();
  assert.equal(classOf(threadsTab(drawNav(child(tree, 'SectionNavigation').props))).includes('has-attention'), false, 'nothing wants attention before ApexAgent reports');
  assert.equal(sidebarBadge(drawSidebar, tree), null, 'the project has no badge before ApexAgent reports');

  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef);
  tree = h.render();
  agentOf(h, tree).props.onMonitorChange(project.id, project.hostId, blocker);
  tree = h.render();

  // The Threads tab is underlined as needing you.
  let nav = drawNav(child(tree, 'SectionNavigation').props);
  assert.ok(classOf(threadsTab(nav)).includes('has-attention'));
  assert.ok(classOf(threadsTab(nav)).includes('needs_input'), 'the Threads tab is coloured as needing you');

  // Hovering it lists the blocker.
  nav = hoverThreads(drawNav, tree);
  let rows = attentionRows(nav);
  assert.equal(rows.length, 1, 'the hover list shows a row for the blocker');
  assert.match(textOf(rows[0]), /Track release readiness/);
  assert.match(textOf(rows[0]), /Assistant has 1 active blocker/);
  assert.match(textOf(rows[0]), /Project A · Threads/);
  assert.ok(classOf(find(rows[0], node => classOf(node).includes('dot'))).includes('needs_input'), 'the row dot shows needs you');

  // Sidebar badge on the project.
  let badge = sidebarBadge(drawSidebar, tree);
  assert.ok(badge, 'the project shows a badge');
  assert.ok(classOf(badge).includes('needs_input'));
  assert.equal(textOf(badge), '1');
  assert.equal(badge.props['aria-label'], '1 wants attention: 1 in Threads');

  // Read the conversation: open it from the row, then close it.
  rows[0].props.onClick();
  tree = h.render();
  const opened = agentOf(h, tree);
  assert.ok(opened, 'choosing the row opens the ApexAgent conversation');
  opened.props.onClose();
  tree = h.render();

  assert.ok(classOf(threadsTab(drawNav(child(tree, 'SectionNavigation').props))).includes('needs_input'), 'the Threads tab still shows the blocker after reading');
  assert.match(textOf(attentionRows(hoverThreads(drawNav, tree))[0]), /Assistant has 1 active blocker/, 'the row is still listed after reading');
  badge = sidebarBadge(drawSidebar, tree);
  assert.equal(textOf(badge), '1', 'the sidebar badge is still there after reading');

  // Resolving the blocker clears both.
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef);
  tree = h.render();
  agentOf(h, tree).props.onMonitorChange(project.id, project.hostId, resolvedBlocker);
  tree = h.render();
  assert.equal(classOf(threadsTab(drawNav(child(tree, 'SectionNavigation').props))).includes('has-attention'), false, 'the Threads alert disappears once the blocker is resolved');
  assert.equal(sidebarBadge(drawSidebar, tree), null, 'the sidebar badge disappears once the blocker is resolved');
  h.unmount();
});

test('the rendered Mark ready as seen button clears ordinary Ready flags but keeps the ApexAgent blocker', async () => {
  const h = appHarness();
  const drawNav = realSectionNavigation();
  const drawSidebar = realSidebar();
  let tree = h.render(); await tick(); tree = h.render();
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef);
  tree = h.render();
  agentOf(h, tree).props.onMonitorChange(project.id, project.hostId, blocker);
  tree = h.render();
  agentOf(h, tree).props.onClose();
  tree = h.render();

  // An ordinary thread finishes, as ChatPane reports it.
  child(tree, 'ProjectSidebar').props.onOpenPane(pane);
  tree = h.render();
  // HostPane is stubbed, so call its render function to reach the thread's ChatPane.
  const host = find(tree, node => typeof node.type === 'function' && node.type.displayName === 'HostPane' && node.props.backend);
  const chat = host && find(host.children.find(c => typeof c === 'function')?.([]), node => typeof node.type === 'function' && node.type.displayName === 'ChatPane' && node.props.pane?.id === pane.id);
  assert.ok(chat, 'the ordinary thread is on screen');
  chat.props.onSignal(pane.id, 'done', 'Finished');
  tree = h.render();

  let nav = hoverThreads(drawNav, tree);
  assert.ok(classOf(threadsTab(nav)).includes('needs_input'), 'the blocker outranks the ready thread');
  assert.equal(attentionRows(nav).length, 2, 'the hover list shows the blocker and the ready thread');
  assert.equal(textOf(sidebarBadge(drawSidebar, tree)), '2', 'the project badge counts the blocker and the ready thread');
  const markSeen = find(nav, node => node.type === 'button' && textOf(node) === 'Mark ready as seen');
  assert.ok(markSeen, 'the hover list offers Mark ready as seen');
  markSeen.props.onClick();
  tree = h.render();

  nav = hoverThreads(drawNav, tree);
  const rows = attentionRows(nav).map(textOf);
  assert.equal(rows.length, 1, 'only the blocker is left');
  assert.match(rows[0], /Assistant has 1 active blocker/);
  assert.equal(textOf(sidebarBadge(drawSidebar, tree)), '1', 'the sidebar badge drops to just the blocker');
  h.unmount();
});

test('assistant conversation is owner-bound and never exposes the retired global coordinator',async()=>{
 const h=appHarness();let tree=h.render();await tick();tree=h.render();
 child(tree,'ProjectSidebar').props.onOpenAssistant(h.assistantRef);tree=h.render();const all=child(tree,'ApexAgentAll');
 assert.ok(all);assert.equal(all.props.embedded,true);assert.equal(all.props.personalLaneId,assistantIdentityKey(h.assistantRef));assert.equal(all.props.onOverview,undefined);assert.deepEqual(all.props.overviewEntries,[]);
 assert.equal(all.props.personal.ref.assistantId,'assistant-a');all.props.onClose();assert.equal(child(h.render(),'AssistantWorkspace'),null);h.unmount();
});

test('combined evidence opens file, saved thread and Git on their owning host', async () => {
  const h = appHarness(); let tree = h.render(); await tick(); tree = h.render();
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef); tree = h.render();
  const opened = []; h.backend.openTarget = async (...args) => opened.push(args);
  const open = child(tree, 'ApexAgentAll').props.onOpenEvidence;
  await open(project.id, evidence);
  await open(project.id, { ...evidence, sourceId: 'git:status' });
  assert.deepEqual(opened, [['README.md', project.path, false], [project.path, project.path, false]]);
  await assert.rejects(open(project.id, { ...evidence, sourceId: 'file:../secrets' }), /outside/);
  await open(project.id, { ...evidence, sourceId: `thread:${pane.id}` }); tree = h.render();
  assert.equal(opened.length, 2, 'saved threads navigate inside Deck');
  await assert.rejects(open(project.id, { ...evidence, sourceId: 'thread:missing' }), /no longer available/);
  h.unmount();
});

test('assistant project task cards include only exact host-qualified assignments',async()=>{
 const h=appHarness();let tree=h.render();await tick();tree=h.render();
 const other={id:'project-b',name:'Billing API',hostId:'host-b',path:'/work/billing'};
 h.emitSession([project,other]);tree=h.render();await tick();tree=h.render();
 child(tree,'HostMonitors').props.onMonitors(project.hostId,[blocker]);tree=h.render();
 child(tree,'ProjectSidebar').props.onOpenAssistant(h.assistantRef);tree=h.render();
 const all=child(tree,'ApexAgentAll');assert.deepEqual(all.props.workspaces.map(w=>w.id),[project.id]);assert.deepEqual(all.props.monitors.map(m=>m.workspaceId),[project.id]);
 assert.equal(all.props.tasks.some(n=>n.props?.projectName==='Billing API'),false);h.unmount();
});

test('failed project request recovers inline and explicit discard allows a new message', async () => {
  const h = appHarness(); let tree = h.render(); await tick(); tree = h.render();
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef); tree = h.render();
  let fail = true; const calls = [];
  h.backend.call = async (command, args) => {
    if (command === 'monitor_get') return blocker;
    if (command === 'assistant_message') { calls.push(args); if (fail) throw new Error('temporary provider error'); return { monitor: blocker }; }
    return { workspaceId: project.id, revision: 0, tasks: [], executions: [] };
  };
  await assert.rejects(child(tree, 'ApexAgentAll').props.onReply(project.id, 'Check parser'), /temporary provider/);
  tree = h.render();
  child(tree, 'HostMonitors').props.onMonitors(project.hostId, [blocker]); tree = h.render();
  const recovery = () => child(tree, 'ApexAgentAll').props.tasks.find(node => (node?.type?.displayName ?? node?.type?.name) === 'ApexAgentTasks').props.requestRecovery;
  assert.equal(recovery().pending.text, 'Check parser');
  await assert.rejects(recovery().retry(), /temporary provider/); tree = h.render();
  assert.deepEqual(calls[0], calls[1], 'retry keeps the original request identity and payload');
  await assert.rejects(child(tree, 'ApexAgentAll').props.onReply(project.id, 'Another question'), /previous request/);
  recovery().discard(); tree = h.render(); fail = false;
  await child(tree, 'ApexAgentAll').props.onReply(project.id, 'Another question'); tree = h.render();
  assert.notEqual(calls[2].requestId, calls[0].requestId);
  assert.equal(recovery().pending, null); h.unmount();
});


test('saved retry refuses a reassigned conversation and leaves its original request intact', async () => {
  const h = appHarness(); let tree = h.render(); await tick(); tree = h.render();
  child(tree, 'HostMonitors').props.onMonitors(project.hostId, [blocker]); tree = h.render();
  child(tree, 'ProjectSidebar').props.onOpenAssistant(h.assistantRef); tree = h.render();
  let current = blocker; let sends = 0;
  h.backend.call = async (command) => {
    if (command === 'monitor_get') return current;
    if (command === 'assistant_message') { sends++; throw new Error('lost response'); }
    return { workspaceId: project.id, revision: 0, tasks: [], executions: [] };
  };
  await assert.rejects(child(tree, 'ApexAgentAll').props.onReply(project.id, 'Original request'), /lost response/); tree = h.render();
  const recovery = child(tree, 'ApexAgentAll').props.tasks.find(node => node?.type?.displayName === 'ApexAgentTasks').props.requestRecovery;
  current = { ...blocker, conversationId: 'replacement' };
  await assert.rejects(recovery.retry(), /assignment changed/);
  assert.equal(sends, 1);
  assert.equal(JSON.parse(h.stored.get(assistantTaskModel.pendingRequestStorageKey(recovery.pending.owner))).requestId, recovery.pending.requestId);
  h.unmount();
});
