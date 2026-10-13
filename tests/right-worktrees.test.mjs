import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'sucrase';

const source = await fs.readFile(new URL('../src/RightWorktrees.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replace(/export function/g, 'function'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const { RightWorktreesTab, WorktreeRow, worktreeErrorMessage } = new Function('React', 'useEffect', 'useRef', 'useState', code + '; return { RightWorktreesTab, WorktreeRow, worktreeErrorMessage };')(React, React.useEffect, React.useRef, React.useState);
const render = (node) => renderToStaticMarkup(node);
const row = (overrides = {}) => ({ path: '/repo', head: '12345678abcdef', branch: 'main', main: false, locked: false, prunable: false, changes: 0, task: false, ...overrides });

test('worktree rows show branch, full path title, and state labels', () => {
  const html = render(React.createElement(WorktreeRow, { item: row({ branch: null, main: true, changes: 3, locked: true, task: true }), busy: false, confirm: false, onOpen() {}, onRemove() {}, onCancel() {} }));
  for (const text of ['detached · 12345678', 'Main', 'Changes · 3', 'Locked', 'ApexAgent task']) assert.ok(html.includes(text), text);
  assert.match(html, /title="\/repo"/);
  assert.doesNotMatch(html, />Remove</);
});

test('main and ApexAgent task rows cannot be removed', () => {
  for (const item of [row({ main: true }), row({ task: true })]) {
    const html = render(React.createElement(WorktreeRow, { item, busy: false, confirm: false, onOpen() {}, onRemove() {}, onCancel() {} }));
    assert.doesNotMatch(html, />Remove</);
  }
});

test('present rows offer Prune and Remove; missing rows offer Prune only', () => {
  const noop = () => {};
  const present = render(React.createElement(WorktreeRow, { item: row(), busy: false, confirm: false, onOpen: noop, onRemove: noop, onPrune: noop, onCancel: noop }));
  assert.match(present, /<summary[^>]*aria-label="Worktree actions"/);
  assert.match(present, /<details[^>]*>[\s\S]*>Open folder<[\s\S]*<hr\s*\/?>[\s\S]*>Remove<[\s\S]*>Prune<[\s\S]*<\/details>/);
  assert.match(present, />Prune</);
  assert.match(present, />Remove</);
  const missing = render(React.createElement(WorktreeRow, { item: row({ prunable: true }), busy: false, confirm: false, onOpen: noop, onRemove: noop, onPrune: noop, onCancel: noop }));
  assert.match(missing, />Prune</);
  assert.doesNotMatch(missing, />Remove</);
});

test('main and ApexAgent task rows offer neither Prune nor Remove', () => {
  const noop = () => {};
  for (const item of [row({ main: true }), row({ task: true })]) {
    const html = render(React.createElement(WorktreeRow, { item, busy: false, confirm: false, onOpen: noop, onRemove: noop, onPrune: noop, onCancel: noop }));
    assert.doesNotMatch(html, />Remove</);
    assert.doesNotMatch(html, />Prune</);
  }
});

test('has-changes confirmation retries pruning with force', () => {
  let force;
  const tree = WorktreeRow({ item: row(), busy: false, confirm: false, pruneConfirm: true, onOpen() {}, onRemove() {}, onPrune(value) { force = value; }, onCancel() {} });
  const find = (node) => { if (!node || typeof node !== 'object') return null; if (node.type === 'button' && node.props.children === 'Prune anyway') return node; for (const child of React.Children.toArray(node.props?.children)) { const found = find(child); if (found) return found; } return null; };
  find(tree).props.onClick();
  assert.equal(force, true);
});

test('has-changes confirmation retries removal with force', () => {
  let force;
  const tree = WorktreeRow({ item: row(), busy: false, confirm: true, onOpen() {}, onRemove(value) { force = value; }, onCancel() {} });
  const find = (node) => { if (!node || typeof node !== 'object') return null; if (node.type === 'button' && node.props.children === 'Remove anyway') return node; for (const child of React.Children.toArray(node.props?.children)) { const found = find(child); if (found) return found; } return null; };
  find(tree).props.onClick();
  assert.equal(force, true);
});

test('empty root and offline states are visible', () => {
  const noRoot = render(React.createElement(RightWorktreesTab, { root: null, backend: null, visible: true, onOpen() {} }));
  const offline = render(React.createElement(RightWorktreesTab, { root: '/repo', backend: null, visible: true, onOpen() {} }));
  assert.match(noRoot, /This project has no folder/);
  assert.match(offline, /This project machine is unavailable/);
});

test('old service errors get a plain update message and other errors never expose service text', () => {
  assert.equal(worktreeErrorMessage(new Error("unknown variant `worktree_list`, expected one of `session_load`")), "This machine's Deck service is out of date. Update Deck to manage worktrees.");
  assert.equal(worktreeErrorMessage(new Error('git path /private/repo: permission denied')), "Couldn't manage worktrees. Check the service and try again.");
});
