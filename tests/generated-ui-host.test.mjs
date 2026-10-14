import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeCapability, checkedBounds, collectOwnership, recheckOwnedProcess, bootstrapRequestAllowed } from '../desktop/generated-ui/policy.mjs';
import { revisionDigest, readRuntimeMessage, MessageBudget, readRunRequest } from '../desktop/generated-ui/protocol.mjs';
import { ADAPTER_VERSION, SECURITY_POLICY_VERSION } from '../desktop/generated-ui/frame-content.mjs';
import { createGeneratedUIManager } from '../desktop/generated-ui/host.mjs';
const code = { adapterVersion: ADAPTER_VERSION, securityPolicyVersion: SECURITY_POLICY_VERSION };

test('main converts approved CSS geometry to owner zoom before native placement',()=>{
  const css={x:20,y:80,width:500,height:300};
  assert.deepEqual(checkedBounds(css,{width:900,height:700},0.8),{x:16,y:64,width:400,height:240});
  assert.deepEqual(checkedBounds(css,{width:1800,height:1400},2),{x:40,y:160,width:1000,height:600});
  for(const zoom of [0,NaN,Infinity,-1])assert.equal(checkedBounds(css,{width:900,height:700},zoom),null);
  assert.equal(checkedBounds(css,{width:900,height:700},2),null);
});

const card = { schemaVersion: 1, kind: 'generated', cardId: 'a', title: 'A', summary: 'Summary', html: '<p>A</p>', css: '', js: '', fallback: 'Fallback' };
const identity = { threadId: 'thread', seq: 3, cardId: 'a', hostId: 'local' };
const requestId = 'request'.repeat(4);
const binding = { runId: 'a'.repeat(32), revisionDigest: 'b'.repeat(64) };
const envelope = (type, extra = {}) => ({ protocolVersion: 1, ...binding, type, ...extra });
const frame = (pid, node, url = 'about:srcdoc') => ({ osProcessId: pid, frameTreeNodeId: node, detached: false, url });
const contents = (id, frames) => ({ id, isDestroyed: () => false, mainFrame: { ...frames[0], framesInSubtree: frames } });

test('background, hidden and minimized Deck windows cannot create an automatic interface',async()=>{
  for(const flags of [{focused:false,visible:true,minimized:false},{focused:true,visible:false,minimized:false},{focused:true,visible:true,minimized:true}]){
    let allocations=0;
    const manager=createGeneratedUIManager({electron:{app:{},session:{fromPartition(){allocations++;throw Error('Allocated a background host');}},webContents:{}},emit(){},testPolicy:{testOnly:true,enabled:true,ledger:{count:0}}});
    const mainFrame={};const win={id:1,isDestroyed:()=>false,isFocused:()=>flags.focused,isVisible:()=>flags.visible,isMinimized:()=>flags.minimized,webContents:{mainFrame,getZoomFactor:()=>1},getContentBounds:()=>({width:900,height:700})};
    await assert.rejects(manager.run({win,frame:mainFrame},{requestId,source:JSON.stringify(card),identity,bounds:{x:20,y:80,width:500,height:300}}),/foreground/);
    assert.equal(allocations,0);
  }
});

test('production capability cannot be enabled by environment or incomplete evidence', () => {
  process.env.APEX_DECK_GENERATED_UI = '1';
  assert.equal(runtimeCapability().enabled, false);
  assert.equal(runtimeCapability(code, { electron: '44.5.1', chrome: 'x', network: true }, 'darwin', 'arm64').enabled, false);
  delete process.env.APEX_DECK_GENERATED_UI;
});

test('only the reviewed adapter, policy, runtime and platform enable Run', () => {
  const versions = { electron: '44.5.1', chrome: '152.0.7977.130' };
  const enabled = runtimeCapability(code, versions, 'darwin', 'arm64');
  assert.equal(enabled.enabled, true);
  assert.deepEqual(enabled.guidance, { protocolVersion: 1, ...code, electronVersion: '44.5.1', chromiumVersion: '152.0.7977.130', platform: 'darwin', arch: 'arm64' });
  // A changed adapter or policy is unreviewed even though the registry still names its old pair.
  for (const changed of [{ ...code, adapterVersion: `${ADAPTER_VERSION}-next` }, { ...code, securityPolicyVersion: `${SECURITY_POLICY_VERSION}-next` }, undefined]) {
    assert.equal(runtimeCapability(changed, versions, 'darwin', 'arm64').enabled, false);
  }
  assert.equal(runtimeCapability(code, { ...versions, electron: '44.5.2' }, 'darwin', 'arm64').enabled, false);
  assert.equal(runtimeCapability(code, versions, 'darwin', 'x64').enabled, false);
  assert.equal(runtimeCapability(code, versions, 'linux', 'arm64').enabled, false);
});

test('bounds reject control overlap and out-of-window or stale geometry', () => {
  const rect = { x: 20, y: 80, width: 500, height: 300 };
  assert.deepEqual(checkedBounds(rect, { width: 900, height: 600 }), rect);
  for (const bad of [{ ...rect, y: 0 }, { ...rect, width: 1000 }, { ...rect, height: 801 }, { ...rect, x: NaN }, { ...rect, extra: 0 }]) {
    assert.equal(checkedBounds(bad, { width: 900, height: 600 }), null);
  }
});

test('bootstrap request permission cannot be reused for subframes or another URL', () => {
  const url = `https://generated-ui.invalid/${binding.runId}`;
  assert.equal(bootstrapRequestAllowed({ url, resourceType: 'mainFrame' }, url, true), true);
  for (const request of [{ url, resourceType: 'subFrame' }, { url: `${url}?x`, resourceType: 'mainFrame' }, { url: 'http://127.0.0.1/', resourceType: 'xhr' }]) {
    assert.equal(bootstrapRequestAllowed(request, url, true), false);
  }
  assert.equal(bootstrapRequestAllowed({ url, resourceType: 'mainFrame' }, url, false), false);
});

test('model delivery requires both generated frames and exclusive OS ownership', () => {
  const wrapper = frame(11, 1, 'https://generated-ui.invalid/run');
  const child = frame(12, 2);
  const generated = contents(1, [wrapper, child]);
  const deck = contents(2, [frame(10, 3, 'app://deck/')]);
  const metrics = [{ pid: 11, creationTime: 1 }, { pid: 12, creationTime: 2 }];
  const owner = collectOwnership(generated, [generated, deck], metrics);
  assert.equal(owner.ok, true);
  assert.deepEqual(owner.records.map(record => record.pid).sort(), [11, 12]);
  assert.equal(collectOwnership(contents(1, [wrapper]), [deck], metrics).ok, false);
  assert.equal(collectOwnership(generated, [generated, contents(2, [frame(12, 3)])], metrics).ok, false);
});

test('termination refuses a reused PID or a PID now shared with Deck', () => {
  const generated = contents(1, [frame(11, 1, 'https://generated-ui.invalid/run'), frame(12, 2)]);
  const metrics = [{ pid: 11, creationTime: 1 }, { pid: 12, creationTime: 2 }];
  const owner = collectOwnership(generated, [generated], metrics);
  const record = owner.records.find(value => value.pid === 12);
  assert.equal(recheckOwnedProcess(record, generated, [generated], metrics), true);
  assert.equal(recheckOwnedProcess(record, generated, [generated, contents(2, [frame(12, 4)])], metrics), false);
  assert.equal(recheckOwnedProcess(record, generated, [generated], [{ pid: 12, creationTime: 99 }]), false);
});

test('approval digest binds every payload field, identity, and adapter/security versions', () => {
  const digest = revisionDigest(card, identity, { adapter: '1', security: '1' });
  assert.match(digest, /^[a-f0-9]{64}$/);
  for (const field of Object.keys(card)) assert.notEqual(revisionDigest({ ...card, [field]: `${card[field]} changed` }, identity, { adapter: '1', security: '1' }), digest);
  assert.notEqual(revisionDigest(card, { ...identity, seq: 4 }, { adapter: '1', security: '1' }), digest);
  assert.notEqual(revisionDigest(card, identity, { adapter: '2', security: '1' }), digest);
  assert.notEqual(revisionDigest(card, identity, { adapter: '1', security: '2' }), digest);
});

test('runtime messages reject stale authority, unknown keys, ports, and oversized UTF8 text', () => {
  assert.equal(readRuntimeMessage(envelope('ready'), binding).ok, true);
  assert.equal(readRuntimeMessage(envelope('resize', { height: Infinity }), binding).ok, false);
  assert.equal(readRuntimeMessage(envelope('discuss', { text: '💬'.repeat(2100) }), binding).ok, false);
  assert.equal(readRuntimeMessage(envelope('pong', { nonce: 'c'.repeat(32) }), binding).ok, true);
  for (const bad of [{ ...envelope('ready'), extra: true }, { ...envelope('ready'), runId: 'd'.repeat(32) }, envelope('send'), envelope('ready', { ports: [] })]) assert.equal(readRuntimeMessage(bad, binding).ok, false);
  assert.equal(readRuntimeMessage(envelope('ready'), binding, [1]).ok, false);
});

test('trusted wrapper fault only admits the fixed flood code', () => {
  assert.equal(readRuntimeMessage(envelope('fault', { code: 'message-flood' }), binding).ok, true);
  assert.equal(readRuntimeMessage(envelope('fault', { code: 'run-script' }), binding).ok, false);
  assert.equal(readRuntimeMessage(envelope('fault', { code: 'message-flood', text: 'send' }), binding).ok, false);
});

test('message budget coalesces resize and stops a persistent storm', () => {
  const budget = new MessageBudget();
  assert.equal(budget.accept('resize', 0), 'accept');
  assert.equal(budget.accept('resize', 10), 'drop');
  assert.equal(budget.accept('resize', 101), 'accept');
  for (let i = 0; i < 26; i++) budget.accept('pong', 200);
  assert.equal(budget.accept('pong', 200), 'accept');
  assert.equal(budget.accept('pong', 200), 'drop');
  for (let i = 0; i < 30; i++) budget.accept('pong', 200);
  assert.equal(budget.accept('pong', 200), 'stop');
});

test('a persistent 31-per-second flood stops in the next over-limit window', () => {
  const budget = new MessageBudget();
  for (let i = 0; i < 30; i++) assert.equal(budget.accept('pong', 0), 'accept');
  assert.equal(budget.accept('pong', 0), 'drop');
  for (let i = 0; i < 30; i++) assert.equal(budget.accept('pong', 1000), 'accept');
  assert.equal(budget.accept('pong', 1000), 'stop');
});

test('run requests bind card identity and reject unknown keys before host creation', () => {
  const bounds = { x: 20, y: 80, width: 500, height: 300 };
  assert.equal(readRunRequest({ requestId, source: JSON.stringify(card), identity, bounds }).ok, true);
  assert.equal(readRunRequest({ requestId, source: JSON.stringify(card), identity: { ...identity, cardId: 'wrong' }, bounds }).ok, false);
  assert.equal(readRunRequest({ requestId, source: JSON.stringify(card), identity, bounds, execute: true }).ok, false);
  assert.equal(readRunRequest({ source: JSON.stringify(card), identity, bounds }).ok, false);
});
