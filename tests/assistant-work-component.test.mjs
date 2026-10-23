import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/AssistantWork.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const text = n => n == null || typeof n === 'boolean' ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : n.children?.map(text).join('') ?? '';
const find = (n, p) => !n || typeof n !== 'object' ? null : p(n) ? n : (n.children ?? []).map(c => find(c, p)).find(Boolean) ?? null;
const all = (n, p) => !n || typeof n !== 'object' ? [] : [...(p(n) ? [n] : []), ...(n.children ?? []).flatMap(c => all(c, p))];
const { AssistantWork } = new Function('React', `${compiled}\nreturn {AssistantWork};`)(React);

const item = (taskId, extra = {}) => ({ key: `delegated:${taskId}`, source: 'delegated', taskId, title: `Task ${taskId}`, projectName: 'apex-deck', worker: 'hyke', status: 'ready_for_review', atMs: Date.UTC(2026, 9, 23, 7, 55), ...extra });
const empty = { needsYou: [], working: [], finished: [], cancelled: [] };
const work = (items = {}, extra = {}) => AssistantWork({ items: { ...empty, ...items }, projects: 'Project cards', onOpenTask() {}, ...extra });

test('sections appear in urgency order', () => {
  const headings = all(work({ needsYou: [item('a')], finished: [item('b', { status: 'done' })] }), n => n.type === 'h2').map(text);
  assert.deepEqual(headings.map(h => h.replace(/\d+$/, '')), ['Needs you', 'Working', 'Projects', 'Finished']);
});

test('empty working shows a hint', () => {
  assert.match(text(work()), /Nothing running\. New tasks you start in Chat show up here\./);
});

test('finished is collapsed and groups cancelled tasks', () => {
  const tree = work({ finished: [item('d', { status: 'done' })], cancelled: [item('c1', { status: 'cancelled' }), item('c2', { status: 'cancelled' }), item('c3', { status: 'cancelled' })] });
  const details = find(tree, n => n.type === 'details');
  assert.ok(details);
  assert.notEqual(details.props.open, true);
  assert.match(text(details), /3 cancelled tasks/);
  assert.match(text(details), /Task d/);
});

test('review opens the task', () => {
  const opened = [];
  const target = item('a');
  find(work({ needsYou: [target] }, { onOpenTask: i => opened.push(i) }), n => n.type === 'button' && text(n) === 'Review').props.onClick();
  assert.deepEqual(opened, [target]);
});

test('a row shows project, worker and words for the status', () => {
  const row = text(work({ needsYou: [item('a'), item('f', { status: 'failed' })] }));
  assert.match(row, /Task a/);
  assert.match(row, /apex-deck · hyke/);
  assert.match(row, /Failed/);
});

test('the projects slot is rendered', () => {
  assert.match(text(work()), /Project cards/);
});
