import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/AssistantDetails.tsx', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const compiled = transform(source.replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;

const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }) };
const all = (tree) => (tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(all)] : []);
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''));
const byClass = (tree, name) => all(tree).filter((node) => String(node.props?.className ?? '').split(' ').includes(name));
const byId = (tree, id) => all(tree).find((node) => node.props?.id === id);

const Avatar = (props) => React.createElement('span', { className: 'identicon', ...props });
const assistantAppearance = () => ({ seed: 'null', color: '#888888', kind: 'identicon' });
// The rendering contract only; the parsing itself is proven in assistant-outputs.test.mjs.
const OUTPUT_MARK = { doc: '▤', data: '{}', view: '◇' };
const OUTPUT_LABEL = { doc: 'Document', data: 'Data', view: 'View' };
const outputsLine = (list) => (list.length === 0 ? 'No deliverables yet' : list.length === 1 ? '1 deliverable' : `${list.length} deliverables`);
const previewSource = (artifact) => artifact.versions[artifact.versions.length - 1].source;

const lane = { name: 'Null', hostName: 'machine', ref: { hostId: 'host', assistantId: 'null' }, assistant: { hostId: 'host', id: 'null' } };
const brief = {
  id: 'artifact:a', name: 'brief.md', kind: 'doc', folder: 'notes', at: 5,
  artifact: { id: 'a', title: 'Brief', kind: 'markdown', versions: [{ n: 1, source: '# Brief', by: null, seq: 1, at: 5 }, { n: 2, source: '# Brief v2', by: null, seq: 2, at: 6 }] },
};
const data = { id: 'file:out/data.json', name: 'data.json', kind: 'data', folder: 'out', path: 'out/data.json', cwd: '/work/a', at: 0 };

function mount(props = {}) {
  const states = [];
  const events = [];
  let cursor = 0;
  const useState = (initial) => {
    const i = cursor++;
    if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
    return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
  };
  const harness = {
    events,
    render(extra = {}) {
      cursor = 0;
      const base = {
        lane,
        outputs: [brief, data],
        onClose: () => events.push('close'),
        onNavigate: (section) => events.push(`nav:${section}`),
        onOpenBrowser: () => events.push('browser'),
        onOpenFile: (path, cwd) => events.push(`file:${path}:${cwd}`),
      };
      return renderWith({ ...base, ...props, ...extra });    },
  };
  function renderWith(finalProps) {
    const local = new Function(
      'React', 'useState', 'Avatar', 'assistantAppearance', 'OUTPUT_MARK', 'OUTPUT_LABEL', 'outputsLine', 'previewSource',
      `${compiled}\nreturn AssistantDetails;`,
    )(React, useState, Avatar, assistantAppearance, OUTPUT_MARK, OUTPUT_LABEL, outputsLine, previewSource);
    return local(finalProps);
  }
  return harness;
}

const rowFor = (tree, name) => byClass(tree, 'assistant-output-row').find((row) => text(row).includes(name));

test('each output is one row with its mark, folder and version', () => {
  const tree = mount().render();
  const rows = byClass(tree, 'assistant-output-row');
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]), /brief\.md/);
  assert.match(text(rows[0]), /notes · Document · v2/);
  assert.match(text(rows[1]), /out · Data$/);
  assert.deepEqual(byClass(tree, 'assistant-output-mark').map(text), ['▤', '{}']);
  assert.equal(byClass(tree, 'assistant-details-fold-count').map(text)[0], '2 deliverables');
});

test('an artifact row shows its newest version and folds away again', () => {
  const harness = mount();
  let tree = harness.render();
  assert.equal(rowFor(tree, 'brief.md').props['aria-expanded'], false);
  rowFor(tree, 'brief.md').props.onClick();
  tree = harness.render();
  assert.equal(rowFor(tree, 'brief.md').props['aria-expanded'], true);
  assert.equal(text(byClass(tree, 'assistant-output-source')[0]).trim(), '# Brief v2');
  rowFor(tree, 'brief.md').props.onClick();
  tree = harness.render();
  assert.equal(byClass(tree, 'assistant-output-source').length, 0);
});

test('a file row opens the file in its own app, with the folder it sits in', () => {
  const harness = mount();
  const tree = harness.render();
  rowFor(tree, 'data.json').props.onClick();
  assert.deepEqual(harness.events, ['file:out/data.json:/work/a']);
});

test('the section says what it is doing instead of showing nothing', () => {
  const note = (tree) => text(byClass(byId(tree, 'assistant-outputs'), 'assistant-details-note')[0]);
  assert.match(note(mount().render({ outputs: [] })), /When a task writes a document/);
  assert.match(note(mount().render({ outputs: [], outputsLoading: true })), /Reading this session/);
  assert.match(note(mount().render({ outputs: [], outputsProblem: 'Could not read this session’s outputs.' })), /Could not read/);
});

test('the Outputs fold closes and opens', () => {
  const harness = mount();
  let tree = harness.render();
  const head = () => byClass(tree, 'assistant-details-fold-head')[0];
  assert.equal(head().props['aria-expanded'], true);
  assert.equal(byId(tree, 'assistant-outputs').props.open, true);
  head().props.onClick();
  tree = harness.render();
  assert.equal(head().props['aria-expanded'], false);
  assert.equal(byId(tree, 'assistant-outputs').props.open, undefined, 'a closed fold hides its body');
});

test('the footer walks into its sections, and the close button closes', () => {
  const harness = mount();
  const tree = harness.render();
  const links = byClass(tree, 'assistant-details-links')[0];
  links.children.forEach((button) => button.props.onClick());
  byClass(tree, 'assistant-details-close')[0].props.onClick();
  assert.deepEqual(harness.events, ['nav:memory', 'nav:projects', 'nav:settings', 'close']);
});

test('the browser card opens the browser when this host has one', () => {
  const harness = mount();
  const tree = harness.render();
  byClass(tree, 'assistant-details-action')[0].props.onClick();
  assert.deepEqual(harness.events, ['browser']);
  const without = mount().render({ onOpenBrowser: undefined });
  assert.equal(byClass(without, 'assistant-details-action').length, 0);
  assert.match(text(byClass(without, 'assistant-details-note')[0]), /does not show the assistant browser/);
});
