import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'sucrase';
import { aggregateFindingCount, assistantSourceOwnerKey, clampWidgetPosition, firstActiveFinding, isQuietHours, parseAssistantSourceDrop, sameWidgetPosition, shouldShowFindingBubble, widgetCoordinates, widgetSidePanelPosition, widgetStatus, widgetStatusLabel, checkFailureReason } from '../src/apexAgentWidgetModel.ts';

const workspace = { id: 'project-a', name: 'Project A', path: '/work/a', hostId: 'host-a' };
const finding = (id, status = 'open', snoozedUntil = null) => ({ id, summary: id, reason: '', confidence: 'observed', nextStep: '', evidence: [], status, firstSeenAt: 0, lastSeenAt: 0, lastNotifiedAt: 0, snoozedUntil });
const monitor = (overrides = {}) => ({ workspaceId: workspace.id, hostId: workspace.hostId, cwd: workspace.path, paused: false, completed: false, activeCheck: null, error: null, files: [], threads: [], findings: [], ...overrides });

test('widget position clamps to viewport margins and reports edge coordinates', () => {
  assert.deepEqual(clampWidgetPosition({ edge: 'right', y: 900 }, { width: 500, height: 400 }), { edge: 'right', y: 328 });
  assert.deepEqual(widgetCoordinates({ edge: 'left', y: -10 }, { width: 500, height: 400 }), { left: 16, top: 16 });
});

test('same avatar coordinates are stable across observer driven rerenders', () => {
  assert.equal(sameWidgetPosition({ edge: 'right', y: 200 }, { edge: 'right', y: 200 }), true);
  assert.equal(sameWidgetPosition({ edge: 'right', y: 200 }, { edge: 'left', y: 200 }), false);
});

test('panel placement stays inside narrow windows at either avatar edge', () => {
  const right = widgetSidePanelPosition('right', 288, 360, 256);
  const rightLeft = 360 - right.right - 256;
  assert.equal(right.right, 84);
  assert.ok(rightLeft >= 12);
  assert.ok(rightLeft + 256 <= 360 - 12);
  const left = widgetSidePanelPosition('left', 16, 360, 250);
  assert.equal(left.left, 84);
  assert.ok(left.left >= 12);
  assert.ok(left.left + 250 <= 360 - 12);
});

test('source feedback owner key includes host and path as well as workspace ID', () => {
  assert.notEqual(assistantSourceOwnerKey(workspace), assistantSourceOwnerKey({ ...workspace, path: '/work/moved' }));
  assert.notEqual(assistantSourceOwnerKey(workspace), assistantSourceOwnerKey({ ...workspace, hostId: 'host-b' }));
});

test('aggregate count includes only unsnoozed open findings across known projects', () => {
  const projects = new Set(['project-a', 'project-b']);
  const total = aggregateFindingCount([
    monitor({ findings: [finding('one'), finding('done', 'resolved'), finding('sleeping', 'open', 500)] }),
    monitor({ workspaceId: 'project-b', findings: [finding('two')] }),
    monitor({ workspaceId: 'removed', findings: [finding('three')] }),
  ], projects, 100);
  assert.equal(total, 2);
});

test('status reports checking, needs-you, paused, failed, offline and off from monitor facts', () => {
  assert.equal(widgetStatus(workspace, undefined), 'off');
  assert.equal(widgetStatus(workspace, monitor({ activeCheck: { id: 'c' } })), 'checking');
  assert.equal(widgetStatus(workspace, monitor({ findings: [finding('f')] })), 'needs-you');
  assert.equal(widgetStatus(workspace, monitor({ paused: true })), 'paused');
  assert.equal(widgetStatus(workspace, monitor(), ['project-a']), 'offline');
  assert.equal(widgetStatus(workspace, monitor({ error: 'network' })), 'failed');
  assert.equal(widgetStatus(workspace, monitor({ error: 'network', activeCheck: { id: 'retry' } })), 'checking');
  assert.equal(widgetStatus(workspace, monitor({ error: 'network' }), ['project-a']), 'offline');
  assert.equal(widgetStatusLabel('failed'), 'Last check failed');
  assert.equal(widgetStatusLabel('needs-you'), 'needs you');
});

test('a failed check names its reason in a few words', () => {
  assert.equal(checkFailureReason('Venice API returned 402 Payment Required: Insufficient USD or Diem balance'), 'out of credit');
  assert.equal(checkFailureReason("ApexAgent's API key is missing on this machine."), 'API key missing');
  assert.equal(checkFailureReason('401 Unauthorized'), 'API key not accepted');
  assert.equal(checkFailureReason('ApexAgent returned invalid check JSON.'), "reply wasn't readable");
  assert.equal(checkFailureReason('ApexAgent has no saved profile.'), 'no profile');
  assert.equal(checkFailureReason('x'.repeat(80)).length, 60);
});

test('drop payload is project and machine scoped, valid and duplicate safe', () => {
  const encode = (payload) => JSON.stringify({ workspaceId: workspace.id, hostId: workspace.hostId, cwd: workspace.path, kind: 'file', sourceId: 'docs/plan.md', ...payload });
  assert.deepEqual(parseAssistantSourceDrop(encode({}), workspace, monitor()), { workspaceId: workspace.id, hostId: workspace.hostId, cwd: workspace.path, kind: 'file', sourceId: 'docs/plan.md' });
  assert.equal(parseAssistantSourceDrop(encode({ sourceId: 'docs/PLAN.md' }), workspace, monitor({ files: ['docs/plan.md'] })), null);
  assert.equal(parseAssistantSourceDrop(encode({ hostId: 'other' }), workspace, monitor()), null);
  assert.equal(parseAssistantSourceDrop(encode({}), workspace, monitor({ cwd: '/changed' })), null);
  assert.equal(parseAssistantSourceDrop('not json', workspace, monitor()), null);
});

test('first active finding follows visible project order and ignores settled findings', () => {
  const first = monitor({ workspaceId: 'project-a', findings: [finding('resolved', 'resolved')] });
  const second = monitor({ workspaceId: 'project-b', findings: [finding('needs-you')] });
  const projects = [{ id: 'project-b' }, { id: 'project-a' }];
  assert.equal(firstActiveFinding([first, second], projects)?.finding.id, 'needs-you');
  assert.equal(firstActiveFinding([first], projects), null);
});

test('quiet hours support overnight and daytime intervals and can be disabled', () => {
  const local = (hour, minute) => new Date(2026, 0, 1, hour, minute);
  assert.equal(isQuietHours(true, '22:00', '08:00', local(23, 30)), true);
  assert.equal(isQuietHours(true, '22:00', '08:00', local(7, 59)), true);
  assert.equal(isQuietHours(true, '22:00', '08:00', local(8, 0)), false);
  assert.equal(isQuietHours(true, '09:00', '17:00', local(12, 0)), true);
  assert.equal(isQuietHours(true, '09:00', '17:00', local(17, 0)), false);
  assert.equal(isQuietHours(false, '22:00', '08:00', local(23, 0)), false);
});

test('finding bubble stays hidden while quiet, dismissed, or the conversation is open', () => {
  assert.equal(shouldShowFindingBubble(true, false, false, false), true);
  assert.equal(shouldShowFindingBubble(true, false, true, false), false);
  assert.equal(shouldShowFindingBubble(true, true, false, false), false);
  assert.equal(shouldShowFindingBubble(true, false, false, true), false);
});

const componentSource = await fs.readFile(new URL('../src/ApexAgentWidget.tsx', import.meta.url), 'utf8');
const componentCompiled = transform(componentSource.replace(/^import .*;\n/gm, '').replace(/^export type .*;\n/gm, '').replace(/^export \{.*\n/gm, '').replace('export function ApexAgentWidget', 'function ApexAgentWidget'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
function shellHarness() {
  let state = [], cursor = 0;
  const timeouts = [];
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const component = new Function('React', 'useState', 'useEffect', 'useMemo', 'useRef', 'useCallback', 'ASSISTANT_SOURCE_MIME', 'activeMonitorFindings', 'aggregateFindingCount', 'assistantSourceOwnerKey', 'firstActiveFinding', 'isQuietHours', 'parseAssistantSourceDrop', 'sameWidgetPosition', 'shouldShowFindingBubble', 'widgetCoordinates', 'widgetSidePanelPosition', 'widgetStatus', 'widgetStatusLabel', 'checkFailureReason', 'window', 'document', 'localStorage', `${componentCompiled}; return ApexAgentWidget;`)(
    React,
    (initial) => { const index = cursor++; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial; return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; },
    () => { cursor++; }, (fn) => { cursor++; return fn(); }, (initial) => { cursor++; return { current: initial }; }, (fn) => { cursor++; return fn; },
    'application/x-apex-agent-source', (m) => m?.findings ?? [], aggregateFindingCount, assistantSourceOwnerKey, firstActiveFinding, isQuietHours, parseAssistantSourceDrop, sameWidgetPosition, shouldShowFindingBubble, widgetCoordinates, widgetSidePanelPosition, widgetStatus, widgetStatusLabel, checkFailureReason,
    { innerWidth: 1200, innerHeight: 800, setTimeout: (callback, delay) => { timeouts.push({ callback, delay }); return timeouts.length; } }, { querySelector: () => null }, { getItem: () => null, setItem() {} },
  );
  let props;
  return { render(next = props) { props = next; cursor = 0; return component(props); }, timeouts, runTimeout(index) { timeouts[index]?.callback(); } };
}
const findNode = (node, predicate) => {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const item of node) { const found = findNode(item, predicate); if (found) return found; } return null; }
  if (predicate(node)) return node;
  for (const child of node.children ?? []) { const found = findNode(child, predicate); if (found) return found; }
  return null;
};

test('focused avatar tooltip is removed while the conversation panel is open', () => {
  const harness = shellHarness();
  const props = { workspaces: [workspace], workspaceId: workspace.id, open: false, monitors: [monitor()], onOpen() {}, onClose() {}, onSelect() {}, onAddSource: async () => {}, children: 'conversation' };
  let tree = harness.render(props);
  findNode(tree, (node) => node.type === 'button' && String(node.props.className).includes('apex-widget-hit')).props.onFocus();
  tree = harness.render(props);
  assert.ok(findNode(tree, (node) => node.props?.['data-apex-agent-overlay'] === 'tooltip'));
  const opened = { ...props, open: true };
  tree = harness.render(opened);
  findNode(tree, (node) => node.type === 'button' && String(node.props.className).includes('apex-widget-hit')).props.onFocus();
  tree = harness.render(opened);
  assert.equal(findNode(tree, (node) => node.props?.['data-apex-agent-overlay'] === 'tooltip'), null);
});

test('drop result remains with its captured project while the user switches projects mid-save', async () => {
  const projectB = { id: 'project-b', name: 'Project B', path: '/work/b', hostId: 'host-b' };
  const monitorB = { ...monitor(), workspaceId: projectB.id, hostId: projectB.hostId, cwd: projectB.path };
  let resolveAdd;
  const added = [];
  const pending = new Promise((resolve) => { resolveAdd = resolve; });
  const harness = shellHarness();
  const baseProps = { workspaces: [workspace, projectB], workspaceId: workspace.id, open: true, monitors: [monitor(), monitorB], onOpen() {}, onClose() {}, onSelect() {}, onAddSource: (payload) => { added.push(payload); return pending; }, children: 'conversation' };
  let tree = harness.render(baseProps);
  const catcher = findNode(tree, (node) => node.type === 'div' && node.props['data-apex-agent-overlay'] === 'avatar');
  const payload = { workspaceId: workspace.id, hostId: workspace.hostId, cwd: workspace.path, kind: 'file', sourceId: 'plan.md' };
  await catcher.props.onDrop({ preventDefault() {}, dataTransfer: { getData: (kind) => kind === 'application/x-apex-agent-source' ? JSON.stringify(payload) : '' } });
  assert.equal(added[0].workspaceId, workspace.id);
  tree = harness.render({ ...baseProps, workspaceId: projectB.id });
  assert.equal(findNode(tree, (node) => node.props?.role === 'status'), null, 'project A feedback stays out of project B');
  resolveAdd(); await pending;
  tree = harness.render({ ...baseProps, workspaceId: projectB.id });
  assert.equal(findNode(tree, (node) => node.props?.role === 'status'), null);
  tree = harness.render(baseProps);
  assert.equal(findNode(tree, (node) => node.props?.role === 'status')?.children?.[0]?.children?.[0], 'Added');
  assert.equal(harness.timeouts[0]?.delay, 4_000);
  harness.runTimeout(0);
  assert.equal(findNode(harness.render(baseProps), (node) => node.props?.role === 'status'), null, 'success feedback auto-dismisses after its delay');
});

test('drop feedback does not follow a reused workspace ID after its host or path changes', async () => {
  const movedWorkspace = { ...workspace, path: '/work/a-moved' };
  const movedMonitor = { ...monitor(), cwd: movedWorkspace.path };
  let resolveAdd;
  const pending = new Promise((resolve) => { resolveAdd = resolve; });
  const harness = shellHarness();
  const originalProps = { workspaces: [workspace], workspaceId: workspace.id, open: true, monitors: [monitor()], onOpen() {}, onClose() {}, onSelect() {}, onAddSource: () => pending, children: 'conversation' };
  const tree = harness.render(originalProps);
  const avatar = findNode(tree, (node) => node.type === 'div' && node.props['data-apex-agent-overlay'] === 'avatar');
  const payload = { workspaceId: workspace.id, hostId: workspace.hostId, cwd: workspace.path, kind: 'file', sourceId: 'release.md' };
  await avatar.props.onDrop({ preventDefault() {}, dataTransfer: { getData: (kind) => kind === 'application/x-apex-agent-source' ? JSON.stringify(payload) : '' } });
  const movedProps = { ...originalProps, workspaces: [movedWorkspace], monitors: [movedMonitor] };
  assert.equal(findNode(harness.render(movedProps), (node) => node.props?.role === 'status'), null);
  resolveAdd(); await pending;
  assert.equal(findNode(harness.render(movedProps), (node) => node.props?.role === 'status'), null);
  assert.equal(findNode(harness.render(originalProps), (node) => node.props?.role === 'status')?.children?.[0]?.children?.[0], 'Added');
  const newPayload = { ...payload, sourceId: 'another-source.md' };
  const currentAvatar = findNode(harness.render(originalProps), (node) => node.type === 'div' && node.props['data-apex-agent-overlay'] === 'avatar');
  await currentAvatar.props.onDrop({ preventDefault() {}, dataTransfer: { getData: (kind) => kind === 'application/x-apex-agent-source' ? JSON.stringify(newPayload) : '' } });
  harness.runTimeout(0);
  assert.equal(findNode(harness.render(originalProps), (node) => node.props?.role === 'status')?.children?.[0]?.children?.[0], 'Added', 'an older timer cannot dismiss newer feedback for the same owner');
});

test('a failed check shows Last check failed with its reason and a Retry that asks for a check', async () => {
  const text = (node) => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : (node.children ?? []).map(text).join('');
  const retried = [];
  let finish;
  const harness = shellHarness();
  const props = { workspaces: [workspace], workspaceId: workspace.id, open: true, monitors: [monitor({ error: '402 Payment Required: Insufficient USD or Diem balance' })], onOpen() {}, onClose() {}, onSelect() {}, onAddSource: async () => {}, onRetry: (id) => { retried.push(id); return new Promise((resolve) => { finish = resolve; }); }, children: 'conversation' };
  let tree = harness.render(props);
  const footer = findNode(tree, (node) => node.type === 'footer');
  assert.match(text(footer), /Last check failed: out of credit/);
  assert.doesNotMatch(text(tree), /Offline/i);
  assert.equal(text(findNode(tree, (node) => String(node.props?.className).includes('apex-widget-status'))), 'Last check failed');
  findNode(footer, (node) => node.type === 'button').props.onClick();
  assert.deepEqual(retried, [workspace.id]);
  tree = harness.render(props);
  const sending = findNode(findNode(tree, (node) => node.type === 'footer'), (node) => node.type === 'button');
  assert.equal(text(sending), 'Retrying…');
  assert.equal(sending.props.disabled, true);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  tree = harness.render(props);
  assert.equal(text(findNode(findNode(tree, (node) => node.type === 'footer'), (node) => node.type === 'button')), 'Retry');
});
