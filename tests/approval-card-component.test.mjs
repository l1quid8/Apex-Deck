import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import * as choices from '../src/approvalChoices.ts';

const source = readFileSync(new URL('../src/ApprovalCard.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replaceAll('export ', ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) { const match = find(child, predicate); if (match) return match; }
  return null;
};
function harness(kind = 'plan') {
  const states = []; let cursor = 0; const decisions = [];
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
  const useState = initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; };
  const Card = new Function('React', 'useState', 'useRef', 'useId', 'Markdown', ...Object.keys(choices), `${code}; return ApprovalCard;`)(React, useState, value => ({ current: value }), () => 'test-id', 'Markdown', ...Object.values(choices));
  return { decisions, render() { cursor = 0; return Card({ action: { kind, title: 'Start the work?', detail: '# Full plan\n\nReview every step.', risky: false }, name: 'Builder', onDecide: (...args) => decisions.push(args) }); } };
}
test('plan expands and collapses without answering the approval', () => {
  const h = harness(); let tree = h.render();
  let toggle = find(tree, n => n.type === 'button' && n.props['aria-expanded'] !== undefined);
  assert.ok(toggle, 'plan needs an expansion control');
  assert.equal(toggle.props['aria-expanded'], false);
  const detailId = toggle.props['aria-controls'];
  assert.ok(detailId);
  toggle.props.onClick(); tree = h.render();
  toggle = find(tree, n => n.type === 'button' && n.props['aria-expanded'] !== undefined);
  assert.equal(toggle.props['aria-expanded'], true);
  assert.equal(find(tree, n => n.props.id === detailId).props['data-expanded'], true);
  assert.deepEqual(h.decisions, []);
  assert.ok(find(tree, n => n.props['data-answer'] === 'once'));
  toggle.props.onClick(); tree = h.render();
  assert.equal(find(tree, n => n.props.id === detailId).props['data-expanded'], false);
  assert.deepEqual(h.decisions, []);
});
test('command approvals retain their existing presentation', () => {
  const tree = harness('command').render();
  assert.equal(find(tree, n => n.props['aria-expanded'] !== undefined), null);
  assert.ok(find(tree, n => n.type === 'pre' && n.props.className === 'approval-detail'));
});
