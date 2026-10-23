import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/AssistantTeamRow.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(text).join('') ?? '';
const find = (n, p) => !n || typeof n !== 'object' ? null : p(n) ? n : (n.children ?? []).map(c => find(c, p)).find(Boolean) ?? null;
const Avatar = () => null;
const bindings = { React, Avatar, useMemo: fn => fn(), assistantAppearance: () => ({ seed: 's', color: '#123456', kind: 'pixel' }), assistantIdentityKey: r => `${r.hostId}/${r.assistantId}`, createAssistantAvatarApi: () => undefined };
const { AssistantTeamRow } = new Function(...Object.keys(bindings), `${compiled}\nreturn {AssistantTeamRow};`)(...Object.values(bindings));
const assistant = { ref: { hostId: 'mac', assistantId: 'a' }, name: 'Apex Assistant', hostName: 'Mac', offline: false, revision: 1, lastSeen: 0, paused: false, personalTasks: [], projects: [] };
const status = (state, label) => ({ state, label, needsYou: 0, failed: 0, working: 0 });
const row = (s, extra = {}) => AssistantTeamRow({ assistant, status: s, selected: false, onOpen() {}, ...extra });

test('ready row has no subtitle', () => {
  const tree = row(status('ready', 'Ready'));
  assert.equal(text(tree), 'Apex Assistant');
  assert.equal(find(tree, n => n.props.className === 'assistant-team-subtitle'), null);
});

test('needs-you row shows words and count', () => {
  const sub = find(row(status('needs_you', 'Needs you · 1')), n => n.props.className === 'assistant-team-subtitle');
  assert.equal(text(sub), 'Needs you · 1');
  assert.equal(sub.props['data-state'], 'needs_you');
});

test('offline row says Offline and never says Assistant ·', () => {
  const tree = row(status('offline', 'Offline'));
  assert.match(text(tree), /Offline/);
  assert.doesNotMatch(text(tree), /Assistant ·/);
});

test('selected row is the current page and opens on click', () => {
  const opened = [];
  const tree = row(status('ready', 'Ready'), { selected: true, onOpen: r => opened.push(r) });
  assert.equal(tree.props['aria-current'], 'page');
  tree.props.onClick();
  assert.deepEqual(opened, [assistant.ref]);
});
