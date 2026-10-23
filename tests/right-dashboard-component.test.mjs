import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'sucrase';
import * as model from '../src/dashboardModel.ts';

const source = await fs.readFile(new URL('../src/RightDashboard.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replace('export function RightDashboard', 'function RightDashboard'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const textOf = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (Array.isArray(node) ? node : node.children ?? []).map(textOf).join(' ');
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node) && predicate(node)) return node;
  for (const child of Array.isArray(node) ? node : node.children ?? []) { const found = find(child, predicate); if (found) return found; }
  return null;
};
const row = (id, status, project = 'Apex Deck') => ({ id, title: id, status, project, kind: 'chat', note: '' });

function harness(rows, storage = new Map()) {
  const states = [], effects = []; let cursor = 0, props = { rows, onOpen: (id, destination) => opened.push(destination ? [id, destination] : id) }; const opened = [];
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
  const useState = initial => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; };
  const useEffect = (fn, deps) => { const i = cursor++; if (!effects[i] || deps.some((value, index) => value !== effects[i].deps[index])) effects[i] = { fn, deps, pending: true }; };
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const Component = new Function('React', 'useState', 'useEffect', 'localStorage', 'MenuList', 'createPortal', 'document', ...Object.keys(model), `${code}; return RightDashboard;`)(React, useState, useEffect, localStorage, 'MenuList', node => node, { body: {} }, ...Object.values(model));
  return { opened, storage, setRows(rows) { props = { ...props, rows }; }, setVisible(visible) { props = { ...props, visible }; }, render() { cursor = 0; const tree = Component(props); for (const effect of effects) if (effect?.pending) { effect.pending = false; effect.fn(); } return tree; } };
}
const groupButton = (tree, label) => find(tree, node => node.type === 'button' && node.props['aria-expanded'] !== undefined && textOf(node).includes(label));
const visibleList = (tree, label) => {
  const group = find(tree, node => node.type === 'section' && !!groupButton(node, label));
  return find(group, node => node.type === 'ul' && !node.props.hidden);
};

test('collapsed categories survive row updates, filtering, grouping, and a remount', () => {
  const rows = [row('Release review', 'working', 'Working'), row('Research', 'idle')];
  const h = harness(rows); let tree = h.render();
  const toggle = groupButton(tree, 'Working');
  assert.ok(toggle, 'each Dashboard group has a collapse button');
  toggle.props.onClick(); tree = h.render();
  assert.equal(groupButton(tree, 'Working').props['aria-expanded'], false);
  assert.equal(visibleList(tree, 'Working'), null);
  assert.ok(visibleList(tree, 'Idle'));
  h.setRows(rows.filter(item => item.status === 'idle')); h.render(); h.setRows(rows); tree = h.render();
  assert.equal(groupButton(tree, 'Working').props['aria-expanded'], false);
  find(tree, node => node.type === 'input').props.onChange({ target: { value: 'Release' } }); tree = h.render();
  assert.equal(groupButton(tree, 'Working').props['aria-expanded'], false);
  find(tree, node => node.type === 'select').props.onChange({ target: { value: 'project' } }); tree = h.render();
  assert.equal(groupButton(tree, 'Working').props['aria-expanded'], true, 'project names do not collide with collapsed status keys');
  const restored = harness(rows, h.storage); tree = restored.render();
  assert.equal(groupButton(tree, 'Working').props['aria-expanded'], false);
  groupButton(tree, 'Working').props.onClick(); tree = restored.render();
  assert.ok(visibleList(tree, 'Working'));
});

test('attention rows keep their project context and open the selected thread', () => {
  const item = { ...row('Review release', 'needs_input'), note: 'Approve the release checklist', needsCount: 1 };
  const h = harness([item]); const tree = h.render();
  const button = find(tree, node => node.type === 'button' && textOf(node).includes(item.title));
  assert.match(textOf(button), /Apex Deck/);
  assert.match(textOf(button), /Approve the release checklist/);
  button.props.onClick();
  assert.deepEqual(h.opened, [item.id]);
});

const rowButton = (tree, title) => find(tree, node => node.type === 'button' && !!find(node, child => child.props.className === 'dash-title' && textOf(child) === title));
const contextEvent = () => ({ clientX: 300, clientY: 200, currentTarget: { getBoundingClientRect: () => ({ right: 400, bottom: 250 }) }, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });

test('Dashboard right-click exposes pane destinations without opening or starting a session', () => {
  const item = { ...row('Release review', 'working'), navigation: { targets: [{ id: 'other', title: 'Pane 2 · Research' }] } };
  const h = harness([item]); let tree = h.render();
  const event = contextEvent();
  assert.equal(typeof rowButton(tree, item.title).props.onContextMenu, 'function');
  rowButton(tree, item.title).props.onContextMenu(event); tree = h.render();
  assert.ok(event.prevented && event.stopped);
  assert.deepEqual(h.opened, []);
  const menu = find(tree, node => node.type === 'MenuList');
  assert.ok(menu);
  assert.deepEqual(menu.props.anchor, { x: 300, y: 200 });
  const entries = menu.props.entries;
  assert.deepEqual(entries.map(entry => entry.label), ['Open in New Pane', 'Open in External Pane', 'Open in Pane…']);
  entries[0].onSelect(); entries[1].onSelect(); entries[2].submenu[0].onSelect();
  assert.deepEqual(h.opened, [[item.id, { kind: 'new' }], [item.id, { kind: 'external' }], [item.id, { kind: 'pane', paneId: 'other' }]]);
  menu.props.onClose();
  assert.equal(find(h.render(), node => node.type === 'MenuList'), null);
});

test('keyboard context menu works and unavailable destinations explain why', () => {
  const item = { ...row('Task thread', 'idle'), navigation: { targets: [], externalReason: 'Task threads stay in Deck for now.' } };
  const h = harness([item]); let tree = h.render();
  const event = { ...contextEvent(), key: 'F10', shiftKey: true };
  assert.equal(typeof rowButton(tree, item.title).props.onKeyDown, 'function');
  rowButton(tree, item.title).props.onKeyDown(event); tree = h.render();
  const menu = find(tree, node => node.type === 'MenuList');
  assert.ok(event.prevented);
  assert.deepEqual(menu.props.anchor, { rect: { right: 400, bottom: 250 } });
  assert.equal(menu.props.entries[1].disabled, true);
  assert.equal(menu.props.entries[1].reason, item.navigation.externalReason);
  assert.equal(menu.props.entries[2].disabled, true);
  h.setRows([]);
  assert.equal(find(h.render(), node => node.type === 'MenuList'), null, 'stale menus vanish when the row disappears');
});

test('an externally opened row cannot be duplicated in Deck and collapsing its group closes its menu', () => {
  const item = { ...row('Research', 'working'), navigation: { targets: [{ id: 'other', title: 'Pane 1' }], inDeckReason: 'Close its external pane to return it to Deck.', externalReason: 'Already open in an external pane.' } };
  const h = harness([item]); let tree = h.render();
  rowButton(tree, item.title).props.onContextMenu(contextEvent()); tree = h.render();
  const menu = find(tree, node => node.type === 'MenuList');
  assert.equal(menu.props.entries[0].disabled, true);
  assert.equal(menu.props.entries[2].disabled, true);
  groupButton(tree, 'Working').props.onClick(); tree = h.render();
  assert.equal(find(tree, node => node.type === 'MenuList'), null);
});

test('switching away from Dashboard closes its menu even though the panel stays mounted', () => {
  const h = harness([row('Review', 'idle')]); let tree = h.render();
  rowButton(tree, 'Review').props.onContextMenu(contextEvent()); tree = h.render();
  assert.ok(find(tree, node => node.type === 'MenuList'));
  h.setVisible(false); tree = h.render();
  assert.equal(find(tree, node => node.type === 'MenuList'), null);
  h.setVisible(true);
  assert.equal(find(h.render(), node => node.type === 'MenuList'), null);
});
