import {commandBackend} from '../src/commandBackend.ts';
import {assistantVoiceKeeperOwner} from '../src/voice/assistantVoiceOwner.ts';
import {statusWords} from '../src/connection.ts';
import * as companionContext from '../src/assistantCompanionContext.ts';
import * as floatModel from '../src/assistantFloat.ts';
import * as composerDrafts from '../src/assistantComposerDrafts.ts';
import {PersonalAssistantsCollection} from '../src/usePersonalAssistants.ts';
import {closeTrashedPanes,withoutTrashedPanes} from '../src/threadTrash.ts';
import {emptyCatalog,parseChatList,withListedRooms,findRoom} from '../src/chatCatalog.ts';
import {workThreadPlace,reconcileWorkPanes} from '../src/desktopChats.ts';
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
import { remoteProfileEdit } from '../src/sessionSync.ts';
import * as monitorAttention from '../src/monitorAttention.ts';
import * as canvasPanes from '../src/canvasPanes.ts';
import * as layout from '../src/layout.ts';
import * as paneArrangement from '../src/paneArrangement.ts';
import { paneSection, restoredArrangements, savedArrangements } from '../src/closing.ts';
import { migrateCanvasLayouts } from '../src/hostSession.ts';
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

function appHarness(options = {}) {
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
  let floatOptions,personalOptions,floatControls;
  const popoutRecords={opens:[],updates:[],visibility:[],layout:[]};
  const floatActions=new Set(),floatClosed=new Set();
  const bridge={
    open:async snapshot=>{popoutRecords.opens.push(snapshot);return {token:'companion-token'};},
    update:async(token,patch)=>{popoutRecords.updates.push({token,patch});},
    onClosed:fn=>{floatClosed.add(fn);return ()=>floatClosed.delete(fn);},
    onAction:fn=>{floatActions.add(fn);return ()=>floatActions.delete(fn);},
    assistantVisibility:async(token,visible)=>{popoutRecords.visibility.push({token,visible});},
    assistantLayout:async(token,presentation)=>{popoutRecords.layout.push({token,presentation});},
    alwaysOnTop:async()=>false,close:async token=>{for(const fn of floatClosed)fn(token);},
  };
  const voiceCalls=[];const voiceState={status:'idle',muted:false};
  const voiceController={subscribe:()=>()=>{},getState:()=>voiceState,start:async candidate=>voiceCalls.push(candidate),mute(){},end:async()=>{}};
  const floatWindow={apexDeck:{popout:bridge}};
  const floatSource=fsSync.readFileSync(new URL('../src/useAssistantFloat.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
  const floatCode=transform(floatSource,{transforms:['typescript']}).code;
  const hookScope={...hooks,...floatModel,...composerDrafts,assistantIdentityKey,assistantAppearance,createAssistantAvatarApi:()=>undefined,voiceController,window:floatWindow};
  const realUseAssistantFloat=new Function(...Object.keys(hookScope),`${floatCode};return useAssistantFloat;`)(...Object.values(hookScope));
  const assistantRef={hostId:project.hostId,assistantId:'assistant-a'};
  const personalRecord={id:'assistant-a',hostId:project.hostId,name:'Null',revision:1,messages:[],tasks:[],projects:[{project:{hostId:project.hostId,workspaceId:project.id,cwd:project.path},tools:'ask'}]};
  const personalLane={ref:assistantRef,draftKey:assistantIdentityKey(assistantRef),name:'Null',hostName:'Mac',assistant:personalRecord,offline:false,send:async()=>{}};
  const assistantCollection={archivedAssistants:[],restoreAssistant:async()=>{},assistants:[{ref:assistantRef,name:'Null',hostName:'Mac',offline:false,paused:false,personalTasks:[],projects:options.companion?personalRecord.projects:[]}],selected:assistantRef,hosts:[{hostId:project.hostId,routeHostId:project.hostId,name:'Mac',state:'ready'}],lane:()=>personalLane,pendingLane:()=>null,emptyLane:()=>null,select(){},refresh:async()=>{}};
  const chatCollection={online:()=>true,catalog:emptyCatalog(),rows:[],archived:[],machines:[],rooms:{},problems:{},machineName:id=>id,backendOf:backendForHost};
  const defaults = {
    closeTrashedPanes,withoutTrashedPanes,findRoom,workThreadPlace,reconcileWorkPanes,
    ...companionContext,
    assistantVoiceKeeperOwner,voiceController,
    useAssistantFloat:args=>{floatOptions=args;floatControls=options.companion?realUseAssistantFloat(args):{open:async()=>{}};return floatControls;},
    ...assistantWorkspaceModel,
    assistantIdentityKey,rosterMessage,assistantSidebarPanes,assistantThreadKey,
    usePersonalAssistants:args=>{personalOptions=args;return assistantCollection;},
    useDesktopChats:()=>chatCollection,
    readOpenChat:()=>null,restoredChat:()=>'unknown',

    subscribeToImports,
    chatFolder, useWorktreeMount,
    getBackend: async () => backend,
    DEFAULT_SETTINGS: { disabledProviders: [], theme: 'dark', newThread:options.newThread??{policy:'mention',max_bot_hops:3} },
    readSettings: () => ({ disabledProviders: [], newThread:options.newThread??{policy:'mention',max_bot_hops:3} }),
    connection: { subscribe: () => () => {}, get: () => ({ status: { kind: 'connected' } }) },
    statusWords,
    modHost: { start() {} },
    startHub: async () => () => {},
    approvalSnapshot: () => ({}), subscribeApprovals: () => () => {},
    openCards: () => [], dueEscalations: () => [], escalationKey: () => '',
    remoteSessionEdit: (_local, remote) => remote, remoteProfileEdit,
    normalizeWorkspaces: ws => ws ?? [], loadedPanes: ps => ps ?? [], migrateCanvasLayouts,
    paneSection, restoredArrangements, savedArrangements, savedPanes: ps => ps,
    shownWorkspaces: ws => ws, listedPanes: (ps, ws) => ps.filter(p => ws.some(w => w.id === p.workspaceId)),
    workspaceHost: w => w.hostId ?? 'local', workspaceFamily: (_ws, id) => id,
    addFolders: list => ({ list, ids: [] }),
    canvasPanes: () => [],
    activeAfter: (_list, active) => active,
    loadWidths: () => ({ rail: null, details: null }), saveWidths: () => {},
    useAppearanceDraft: () => ({ pending: [] }),
    SIDEBAR_DEFAULT: { details: 300 },
    SIDEBAR_DEFAULT: { details: 300 },
    detailsOverlay: () => false, detailsThread: () => null, noteFocus: (recent, id) => [id, ...(recent ?? []).filter((item) => item !== id)],
    approvalState: {},
    ...attention,
    ...monitorAttention,
    ...canvasPanes,
    ...layout,
    ...paneArrangement,
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
  const componentNames = new Set(['HostPane','HostAgents','HostMonitors','SettingsPage','ThreadName','ChatPane','ModOverlays','ModStatuses','SectionNavigation','AgentsSection','ApexAgentSources','ApexAgentAll','ApexAgentTasks','ApexAgentWidget','AssistantWorkspace','AssistantVoiceKeeper','AssistantEditor','LibraryView','DeckIcon','NewMenu','TerminalPane','PreviewPane','ProjectSidebar','ThreadTrash','ConnectionDialog','MenuList','Glyph','ProjectFolder','Dividers','ConfirmDialog','PathPrompt','SidebarHandle','RightPanel','ChatRail','ChatView','NewChatDialog']);
  const globalValues = {
    localStorage: { getItem: key => stored.get(key) ?? null, setItem(key, value) { stored.set(key, value); }, removeItem(key) { stored.delete(key); } },
    crypto: { randomUUID: () => `request-${++requestSequence}` },
    window: { ...(options.companion?{apexDeck:{popout:bridge}}:{}), addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {} },
    document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, hasFocus: () => Boolean(options.focused), activeElement: null, body: {}, querySelector: () => null },
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
    render, unmount, backend, session, stored, chatCollection, assistantRef, personalLane, assistantCollection,
    floatOptions:()=>floatOptions,personalOptions:()=>personalOptions,floatControls:()=>floatControls,
    popoutRecords,voiceCalls,route:backendForHost,
    setVoice(next){Object.assign(voiceState,next);},
    emitFloat(action){for(const fn of floatActions)fn('companion-token',action);},
    emitSession(workspaces, changes = {}) { sessionChanged?.({ ...session, workspaces, panes: session.panes, ...changes }); },
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
  // PaneMap owns geometry; this App harness follows its render callback to
  // keep testing the real pane content and its owner callbacks.
  const paneChildren = typeof node.props?.renderPane === 'function'
    ? (node.props.mounted ?? []).map(id => node.props.renderPane(id, {x:0,y:0,w:1200,h:800}, true)) : [];
  for (const child of [...(node.children ?? []), ...paneChildren, node.props?.chat,node.props?.work,node.props?.editor]) { const found = find(child, predicate); if (found) return found; }
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

test('a focused thread scrolled out of view keeps its attention until it is seen again', async () => {
  const h = appHarness({ focused:true });
  h.session.focusedPane = pane.id;
  let tree = h.render(); await tick(); tree = h.render();
  const map = find(tree, node => typeof node.props?.renderPane === 'function');
  assert.ok(map, 'the pane map is mounted');
  map.props.onVisiblePanes?.([]);
  tree = h.render();
  const host = find(tree, node => typeof node.type === 'function' && node.type.displayName === 'HostPane' && node.props.backend);
  const chat = find(host.children.find(c => typeof c === 'function')?.([]), node => typeof node.type === 'function' && node.type.displayName === 'ChatPane' && node.props.pane?.id === pane.id);
  chat.props.onSignal(pane.id, 'done', 'Finished off screen');
  tree = h.render(); tree = h.render();
  const rows = attentionMenuOf(tree).props.flags.threads.rows;
  assert.ok(rows.some(row => row.paneId === pane.id), 'the off-screen focused thread still reports Ready');
  map.props.onVisiblePanes?.([pane.id]);
  tree = h.render(); tree = h.render();
  assert.ok(!attentionMenuOf(tree).props.flags.threads.rows.some(row => row.paneId === pane.id), 'returning the thread to the viewport settles its flag');
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


test('native Trash hides a saved Work pane and Restore returns it closed without opening or sending',async()=>{
 const h=appHarness();h.render();await tick();let tree=h.render();
 const before=child(tree,'ProjectSidebar').props.panes.find(p=>p.id==='thread-a');assert.ok(before);
 h.chatCollection.catalog=withListedRooms(emptyCatalog(),'host-a','Owner',parseChatList('host-a',{rooms:[{id:'thread-a',kind:'work',cwd:project.path,title:'Ordinary thread',trashedAt:42}]}),1);
 tree=h.render();assert.equal(child(tree,'ProjectSidebar').props.panes.some(p=>p.id==='thread-a'),false);
 tree=h.render();const restore=child(tree,'ProjectSidebar').props.trash.props.onRestore;
 const calls=[];h.chatCollection.setTrashed=async(row,trashed)=>{
  calls.push([row.hostId,row.id,trashed]);
  h.chatCollection.catalog=withListedRooms(emptyCatalog(),'host-a','Owner',parseChatList('host-a',{rooms:[{...row,trashedAt:undefined}]}),2);
 };
 await restore(findRoom(h.chatCollection.catalog,'host-a','thread-a'));
 tree=h.render();const restored=child(tree,'ProjectSidebar').props.panes.find(p=>p.id==='thread-a');
 assert.equal(restored.closed,true);assert.deepEqual(calls,[['host-a','thread-a',false]]);
 assert.equal(child(tree,'ChatPane'),null);h.unmount();
});


test('a native-created Work thread appears closed and the actual sidebar opens it without a provider turn',async()=>{
 const h=appHarness();h.render();await tick();h.render();
 const calls=[];h.backend.call=async(command,args)=>{calls.push([command,args]);return command==='monitor_get'?null:{workspaceId:project.id,revision:0,tasks:[],executions:[]};};
 h.chatCollection.catalog=withListedRooms(emptyCatalog(),'host-a','Owner',parseChatList('host-a',{rooms:[{id:'created-by-alfred',kind:'work',cwd:project.path,title:'New native task',titleExplicit:true,metadataRevision:1}]}),1);
 h.render();let tree=h.render();let sidebar=child(tree,'ProjectSidebar');
 const created=sidebar.props.panes.find(p=>p.id==='created-by-alfred');assert.ok(created,'native room is discoverable in desktop sidebar');assert.equal(created.closed,true);
 sidebar.props.onOpenPane(created);tree=h.render();sidebar=child(tree,'ProjectSidebar');
 assert.equal(sidebar.props.panes.find(p=>p.id===created.id).closed,false);
 const section=find(tree,node=>node.props?.['data-pane-id']==='created-by-alfred');
 const host=child(section,'HostPane');assert.ok(host);
 const mounted=host.children.find(item=>typeof item==='function')([]);
 assert.equal(mounted.props.pane.id,'created-by-alfred');assert.equal(mounted.props.pane.closed,false);
 assert.ok(!calls.some(([cmd])=>['room_turn','room_post','room_post_to'].includes(cmd)));h.unmount();
});

async function companionAppHarness(options={}) {
  const h=appHarness({companion:true,...options});
  h.assistantCollection.hosts[0].routeHostId='route-a';
  h.setConnection({kind:'connected',hostId:'host-a'},'route-a');
  h.session.focusedPane='thread-a';
  h.session.panes=[{...pane},{id:'closed-pin',workspaceId:project.id,kind:'chat',title:'Closed local',closed:true}];
  h.chatCollection.catalog=withListedRooms(emptyCatalog(),'route-a','Owner',parseChatList('route-a',{rooms:[
    {id:'thread-a',kind:'work',title:'Host fallback',cwd:project.path,participants:[]},
    {id:'closed-pin',kind:'work',title:'Pinned closed',titleExplicit:true,cwd:project.path,participants:[]},
    {id:'talk-bound',kind:'chat',title:'Project discussion',titleExplicit:true,cwd:project.path,participants:[]},
    {id:'foreign-project',kind:'work',title:'Private other project',cwd:'/not-assigned',participants:[]},
    {id:'trash',kind:'work',title:'Trash',cwd:project.path,trashedAt:42},
    {id:'unbound-talk',kind:'chat',title:'Unbound talk',cwd:null},
  ]}),1);
  h.chatCollection.catalog=withListedRooms(h.chatCollection.catalog,'host-b','Foreign machine',parseChatList('host-b',{rooms:[{id:'thread-a',kind:'work',title:'Foreign collision',cwd:project.path}]}),1);
  h.render();await tick();let tree=h.render();
  const rail=child(tree,'ProjectSidebar').props;
  assert.equal(typeof rail.onOpenAssistant,'function');assert.equal(typeof rail.onPopOutAssistant,'function');
  assert.notEqual(rail.onOpenAssistant,rail.onPopOutAssistant,'opening the main conversation and opening its native float are separate actions');
  rail.onPopOutAssistant(h.assistantRef);await tick();tree=h.render();await tick();tree=h.render();
  return {h,tree};
}

test('actual App passes eligible owner threads to the real companion hook, keeps follow membership separate from a closed active pin, and consumes the owner callback at typed and voice sends',async()=>{
  const {h,tree}=await companionAppHarness();
  assert.equal(child(tree,'AssistantWorkspace'),null,'sidebar pop-out leaves the workspace selected');
  assert.ok(child(tree,'AssistantVoiceKeeper'),'main window keeps the floated owner’s voice controller mounted');
  assert.deepEqual(h.floatOptions().float.ref,h.assistantRef);
  assert.equal(h.popoutRecords.opens[0].hostId,'host-a');assert.equal(h.popoutRecords.opens[0].assistantId,'assistant-a');
  assert.deepEqual(h.floatOptions().threadContext.threads.map(thread=>thread.id).sort(),['closed-pin','talk-bound','thread-a']);
  assert.equal(h.floatOptions().threadContext.threads.find(thread=>thread.id==='thread-a').title,'Ordinary thread');
  assert.deepEqual(h.floatOptions().threadContext.followedThreadIds,['thread-a']);
  const published=h.popoutRecords.updates.at(-1).patch.float.context;
  assert.deepEqual(published,h.floatOptions().threadContext);
  h.emitFloat({type:'assistant-follow',threadIds:['foreign-project']});h.render();
  assert.deepEqual(h.floatOptions().threadContext.followedThreadIds,['thread-a'],'ungranted ids are refused at the native action boundary');
  h.emitFloat({type:'assistant-active-thread',threadId:'closed-pin'});h.render();
  h.emitFloat({type:'assistant-follow',threadIds:['talk-bound']});h.render();
  assert.equal(h.floatOptions().threadContext.activeThreadId,'closed-pin');
  assert.deepEqual(h.floatOptions().threadContext.followedThreadIds,['talk-bound']);
  const scoped=h.personalOptions().viewContext('route-a','host-a',h.assistantRef);
  assert.equal(scoped.focusedThreadId,'closed-pin');assert.deepEqual(scoped.openThreadIds,['thread-a']);assert.deepEqual(scoped.followedThreadIds,['talk-bound']);
  assert.equal(h.personalOptions().currentThread('route-a','host-a',h.assistantRef).title,'Pinned closed');
  const sends=[],route=h.route('route-a');route.supports=capability=>['assistant_live_context_v1','assistant_voice_v1'].includes(capability);
  route.call=async(command,args)=>{
    if(command==='personal_list')return [h.personalLane.assistant];
    assert.equal(command,'personal_send');sends.push(structuredClone(args));return {assistant:h.personalLane.assistant,eventId:`event-${sends.length}`};
  };
  // The real collection consumes the actual App callbacks on both send paths.
  const collection=new PersonalAssistantsCollection({hosts:[{id:'route-a',name:'Owner',remote:true}],hostBackend:()=>route,offlineHost:()=>false,storage:{getItem:key=>h.stored.get(key)??null,setItem:(key,value)=>h.stored.set(key,value)},
    viewContext:(...args)=>h.personalOptions().viewContext(...args),currentThread:(...args)=>h.personalOptions().currentThread(...args)});
  await collection.refresh();const lane=collection.lane(h.assistantRef);assert.ok(lane);
  await lane.send('Typed request');await lane.sendRequest('Voice request','voice-request-1');
  assert.equal(sends.length,2);for(const sent of sends){assert.equal(sent.assistantId,h.assistantRef.assistantId);assert.deepEqual(sent.viewContext,scoped);}
  h.emitFloat({type:'assistant-active-thread',threadId:null});h.render();
  await lane.sendRequest('Follow the current view','voice-request-2');
  assert.equal(sends[2].viewContext.focusedThreadId,'thread-a');assert.deepEqual(sends[2].viewContext.followedThreadIds,['talk-bound']);
  assert.equal(sends[0].viewContext.focusedThreadId,'closed-pin','already-created requests retain their own immutable snapshot');
  h.emitFloat({type:'assistant-active-thread',threadId:'foreign-project'});h.render();
  assert.equal(h.floatOptions().threadContext.activeThreadId,null,'ungranted arbitrary ids never become an active pin');
  h.emitFloat({type:'assistant-hide'});const hidden=h.render();
  assert.deepEqual(h.floatOptions().float.ref,h.assistantRef,'Hide retains the float owner reference');
  assert.equal(h.floatControls().visible,false);assert.ok(child(hidden,'AssistantVoiceKeeper'),'Hide does not unmount the voice owner');
  assert.deepEqual(h.popoutRecords.visibility.at(-1),{token:'companion-token',visible:false});
  h.setConnection({kind:'connected',hostId:'host-b'},'route-a');h.render();
  assert.equal(h.floatOptions().threadContext.threads.length,0,'a transport alias rebound to another durable machine exposes no owner context');
  await assert.rejects(()=>lane.send('Do not redirect this request'),/machine is offline|identity changed/);
  assert.equal(sends.length,3,'the changed alias never receives a send for the previous owner');
  h.setConnection({kind:'connected',hostId:'host-a'},'route-a');h.render();
  h.setVoice({status:'listening',scope:{hostId:'host-a',roomId:'assistant:assistant-a',participantId:'assistant-a'}});
  h.emitFloat({type:'assistant-return'});await tick();const returned=h.render();
  assert.equal(h.floatOptions().float,null,'returning the companion closes its view');
  assert.ok(child(returned,'AssistantVoiceKeeper'),'the active call keeps its actual owner after its companion view closes');
  h.unmount();
});

test('actual App New thread creates a zero-bot native room on the exact active project route and focuses it without starting a reply',async()=>{
  const settingsOptions={policy:'everyone',max_bot_hops:7};
  const {h}=await companionAppHarness({newThread:settingsOptions});h.emitFloat({type:'assistant-active-thread',threadId:'closed-pin'});h.render();
  const calls=[],route=h.route('route-a');let created;
  route.call=async(command,args)=>{
    calls.push({command,args:structuredClone(args)});
    if(command==='room_create'){
      assert.ok(['mention','everyone','round_robin'].includes(args.options?.policy),'native room_create requires RoomOptions.policy');
      assert.ok(Object.hasOwn(args.options,'max_bot_hops'),'native request preserves configured max_bot_hops');
      created={id:args.id,kind:'work',cwd:args.cwd,title:'New thread',participants:[]};return {participants:[],options:args.options,transcript:[]};}
    if(command==='chat_update_meta')return {title:args.title};
    throw new Error(`Unexpected mutation ${command}`);
  };
  const typed=commandBackend({call:route.call,listen:async()=>()=>{},saveAttachment:async()=>{throw Error('No attachment expected');},readAttachment:async()=>{throw Error('No attachment expected');}},{});
  let typedCreates=0;
  route.roomCreate=(...args)=>{typedCreates++;return typed.roomCreate(...args);};
  h.chatCollection.refresh=async routeHostId=>{
    calls.push({command:'refresh',routeHostId});
    assert.equal(routeHostId,'route-a');
    const rows=h.chatCollection.catalog.hosts['route-a'].rooms;
    h.chatCollection.catalog=withListedRooms(h.chatCollection.catalog,'route-a','Owner',parseChatList('route-a',{rooms:[...rows,created]}),2);
  };
  const result=await h.floatOptions().onNewThread();let tree=h.render();await tick();tree=h.render();
  assert.ok(result.id.startsWith('pane-'));assert.deepEqual(calls.map(call=>call.command),['room_create','chat_update_meta','refresh']);
  assert.deepEqual(calls[0].args,{id:result.id,participants:[],options:settingsOptions,cwd:project.path});
  assert.equal(typedCreates,1,'App uses the existing typed native roomCreate route');
  assert.deepEqual(calls[1].args,{id:result.id,title:'New thread'});
  assert.equal(h.floatOptions().threadContext.activeThreadId,result.id);assert.ok(h.floatOptions().threadContext.followedThreadIds.includes(result.id));
  const createdPane=child(tree,'ProjectSidebar').props.panes.find(p=>p.id===result.id);assert.ok(createdPane);assert.equal(createdPane.workspaceId,project.id);assert.equal(Boolean(createdPane.closed),false);
  assert.equal(child(tree,'ProjectSidebar').props.focusedPane,result.id);
  assert.equal(calls.some(call=>/room_turn|chat_post|personal_send/.test(call.command)),false);
  assert.deepEqual(h.personalOptions().viewContext('route-a','host-a',h.assistantRef).focusedThreadId,result.id);
  h.unmount();
});

test('actual App rolls back a rejected native rename, clears its pending title, and then converges to an authoritative remote rename',async()=>{
  const h=appHarness();const requests=[];let rejectRename;
  const failed=new Promise((_,reject)=>{rejectRename=reject;});
  const original=h.backend.call;
  h.backend.call=(command,args)=>{
    if(command==='chat_update_meta'){requests.push(structuredClone(args));return failed;}
    return original(command,args);
  };
  h.render();await tick();let tree=h.render();
  child(tree,'ProjectSidebar').props.onRenamePane('thread-a','Rejected local title');tree=h.render();
  let current=child(tree,'ProjectSidebar').props.panes.find(p=>p.id==='thread-a');
  assert.equal(current.title,'Rejected local title');assert.equal(current.hostTitlePending,'Rejected local title');
  assert.deepEqual(requests,[{id:'thread-a',title:'Rejected local title'}]);
  rejectRename(new Error('The machine refused this rename'));await tick();tree=h.render();
  current=child(tree,'ProjectSidebar').props.panes.find(p=>p.id==='thread-a');
  assert.equal(current.hostTitlePending,undefined,'a failed save must not suppress later host metadata');
  assert.equal(current.title,pane.title,'the optimistic title is rolled back after its own save fails');
  h.chatCollection.catalog=withListedRooms(emptyCatalog(),'host-a','Owner',parseChatList('host-a',{rooms:[{id:'thread-a',kind:'work',cwd:project.path,title:'Authoritative remote rename',titleExplicit:true,metadataRevision:7}]}),7);
  h.render();tree=h.render();current=child(tree,'ProjectSidebar').props.panes.find(p=>p.id==='thread-a');
  assert.equal(current.title,'Authoritative remote rename');assert.equal(current.hostTitlePending,undefined);
  h.unmount();
});

test('actual App ignores an older failed rename while a newer rename is still in flight',async()=>{
  const h=appHarness();const requests=[];let rejectOlder,resolveNewer;
  const older=new Promise((_,reject)=>{rejectOlder=reject;}),newer=new Promise(resolve=>{resolveNewer=resolve;});
  const original=h.backend.call;
  h.backend.call=(command,args)=>{
    if(command==='chat_update_meta'){requests.push(structuredClone(args));return requests.length===1?older:newer;}
    return original(command,args);
  };
  h.chatCollection.refresh=async()=>{};
  h.render();await tick();let tree=h.render();
  child(tree,'ProjectSidebar').props.onRenamePane('thread-a','Older optimistic title');tree=h.render();
  child(tree,'ProjectSidebar').props.onRenamePane('thread-a','Newer optimistic title');tree=h.render();
  rejectOlder(new Error('The first save failed late'));await tick();tree=h.render();
  let current=child(tree,'ProjectSidebar').props.panes.find(p=>p.id==='thread-a');
  assert.equal(current.title,'Newer optimistic title');assert.equal(current.hostTitlePending,'Newer optimistic title','the old failure must not clear the newer request’s pending marker');
  resolveNewer({title:'Newer optimistic title',metadataRevision:8});await tick();tree=h.render();
  current=child(tree,'ProjectSidebar').props.panes.find(p=>p.id==='thread-a');
  assert.equal(current.title,'Newer optimistic title');assert.equal(current.hostTitlePending,undefined);
  assert.deepEqual(requests.map(request=>request.title),['Older optimistic title','Newer optimistic title']);
  h.unmount();
});

test('actual App an older failed rename cannot consume a newer request that reused the same title',async()=>{
  const h=appHarness();const requests=[];let rejectFirst;
  const first=new Promise((_,reject)=>{rejectFirst=reject;});
  const newer=new Promise(()=>{});
  const original=h.backend.call;
  h.backend.call=(command,args)=>{
    if(command==='chat_update_meta'){requests.push(structuredClone(args));return requests.length===1?first:newer;}
    return original(command,args);
  };
  h.render();await tick();let tree=h.render();
  for(const title of ['Reused title','Intermediate title','Reused title']){
    child(tree,'ProjectSidebar').props.onRenamePane('thread-a',title);tree=h.render();
  }
  assert.deepEqual(requests.map(request=>request.title),['Reused title','Intermediate title','Reused title']);
  rejectFirst(new Error('The oldest save failed after the latest edit'));await tick();tree=h.render();
  const current=child(tree,'ProjectSidebar').props.panes.find(p=>p.id==='thread-a');
  assert.equal(current.title,'Reused title');assert.equal(current.hostTitlePending,'Reused title','request ownership must not be inferred only from equal title text');
  h.unmount();
});

test('actual App an older successful rename cannot clear a newer request that reused the same title',async()=>{
  const h=appHarness();const requests=[];let resolveFirst;
  const first=new Promise(resolve=>{resolveFirst=resolve;}),newer=new Promise(()=>{});
  const original=h.backend.call;
  h.backend.call=(command,args)=>{
    if(command==='chat_update_meta'){requests.push(structuredClone(args));return requests.length===1?first:newer;}
    return original(command,args);
  };
  h.chatCollection.refresh=async()=>{};
  h.render();await tick();let tree=h.render();
  for(const title of ['Reused title','Intermediate title','Reused title']){
    child(tree,'ProjectSidebar').props.onRenamePane('thread-a',title);tree=h.render();
  }
  resolveFirst({title:'Reused title',metadataRevision:8});await tick();tree=h.render();
  const current=child(tree,'ProjectSidebar').props.panes.find(p=>p.id==='thread-a');
  assert.equal(current.title,'Reused title');assert.equal(current.hostTitlePending,'Reused title','the older acknowledgement does not own the latest equal-text request');
  h.unmount();
});

test('actual App companion lists a legacy zero-agent Work row without explicit metadata and can create in its focused project despite two grants',async()=>{
  const h=appHarness({companion:true});h.assistantCollection.hosts[0].routeHostId='local';
  h.personalLane.assistant.projects.push({project:{hostId:'host-a',workspaceId:'ios',cwd:'/work/ios'},tools:'full'});
  h.assistantCollection.assistants[0].projects=h.personalLane.assistant.projects;
  h.session.focusedPane='thread-a';
  // Store::chat_list's legacy Work shape: no managed title/metadata required,
  // no providers needed, and transport `local` differs from durable host-a.
  const raw={id:'thread-a',kind:'work',cwd:project.path,title:'New chat',participants:[],updatedAt:0,archived:false};
  h.chatCollection.catalog=withListedRooms(emptyCatalog(),'local','This Mac',parseChatList('local',{rooms:[raw]}),1);
  h.render();await tick();let tree=h.render();
  child(tree,'ProjectSidebar').props.onPopOutAssistant(h.assistantRef);await tick();h.render();await tick();tree=h.render();
  const context=h.floatOptions().threadContext;
  assert.equal(context.threads.length,1,'a real listed Work room must not require chat metadata or an attached bot');
  assert.equal(context.threads[0].id,'thread-a');assert.equal(context.threads[0].title,'Ordinary thread');
  assert.equal(context.threads[0].hostId,'host-a');assert.equal(context.threads[0].projectId,project.id);
  assert.deepEqual(context.followedThreadIds,['thread-a']);assert.equal(context.canCreateThread,true,'the focused native thread disambiguates two enabled projects');
  const payload=h.personalOptions().viewContext('local','host-a',h.assistantRef);
  assert.equal(payload.focusedThreadId,'thread-a');assert.deepEqual(payload.openThreadIds,['thread-a']);
  assert.deepEqual(h.popoutRecords.updates.at(-1).patch.float.context,context);
  h.unmount();
});


test('actual App receives CLI agents even when project and thread registries are unchanged', async () => {
  const h = appHarness();
  h.session.section = 'agents';
  const saves = [];
  h.backend.sessionSave = async session => { saves.push(session); };
  h.render(); await tick(); h.render(); await tick();
  const profiles = [{ id: 'null', display_name: 'Null', persona: 'from CLI', access: 'ask', backend: { kind: 'agent', tool: 'codex' } }];
  h.emitSession([project], { profiles, profileRevision: 2, profileSavedBy: 'agent-profile', savedBy: 'agent-profile' });
  let tree = h.render(); await tick();
  assert.deepEqual(child(tree, 'AgentsSection').props.profiles, profiles);
  assert.equal(saves.at(-1).profileRevision, 2);
  assert.deepEqual(saves.at(-1).profiles, profiles);
  h.emitSession([project], { profiles: [], profileRevision: 1, profileSavedBy: 'agent-profile' });
  tree = h.render();
  assert.deepEqual(child(tree, 'AgentsSection').props.profiles, profiles, 'late events must not regress profiles');
  h.unmount();
});
