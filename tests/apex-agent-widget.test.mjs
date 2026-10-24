import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_WIDGET_COLORS, aggregateFindingCount, assistantSourceOwnerKey, clampWidgetPosition, firstActiveFinding, isQuietHours, lookColor, normalizeHexColor, parseAssistantSourceDrop, sameWidgetPosition, shouldShowFindingBubble, widgetCoordinates, widgetSidePanelPosition, widgetStatus, widgetStatusLabel, checkFailureReason } from '../src/apexAgentWidgetModel.ts';

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

test('hex color normalizes short and long forms and rejects bad input', () => {
  assert.equal(normalizeHexColor('#AbC'), '#aabbcc');
  assert.equal(normalizeHexColor(' #F00 '), '#ff0000');
  assert.equal(normalizeHexColor('#a3e635'), '#a3e635');
  assert.equal(normalizeHexColor('#a3e635FF'), null);
  assert.equal(normalizeHexColor('a3e635'), null);
  assert.equal(normalizeHexColor('#12g45f'), null);
  assert.equal(normalizeHexColor(''), null);
  assert.equal(normalizeHexColor(42), null);
});

test('lookColor maps legacy named colours and falls back to the default', () => {
  assert.equal(lookColor('mint'), '#54efaa');
  assert.equal(lookColor('cyan'), '#43d8ed');
  assert.equal(lookColor('violet'), '#b29aff');
  assert.equal(lookColor('amber'), '#ffca57');
  assert.equal(lookColor('#Ff0'), '#ffff00');
  assert.equal(lookColor('not-a-color'), '#54efaa');
  assert.equal(lookColor(undefined), '#54efaa');
  assert.equal(lookColor(null, '#a3e635'), '#a3e635');
  assert.equal(AGENT_WIDGET_COLORS[0], '#54efaa');
});

test('finding bubble stays hidden while quiet, dismissed, or the conversation is open', () => {
  assert.equal(shouldShowFindingBubble(true, false, false, false), true);
  assert.equal(shouldShowFindingBubble(true, false, true, false), false);
  assert.equal(shouldShowFindingBubble(true, true, false, false), false);
  assert.equal(shouldShowFindingBubble(true, false, false, true), false);
});
