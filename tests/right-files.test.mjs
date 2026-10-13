import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'sucrase';
import * as model from '../src/filesTreeModel.ts';
import { isEditable } from '../src/fileEditorModel.ts';

const source = await fs.readFile(new URL('../src/RightFiles.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replace(/export function/g, 'function'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const root = '/sample-project';
const changed = { files: [{ path: 'src/main.ts', added: 1, removed: 1, by: ['luna'], patch: '--- a/src/main.ts\n+++ b/src/main.ts' }], note: null };
const row = { path: `${root}/src/main.ts`, name: 'main.ts', depth: 1, folder: false, changed: 'M', hasChangedInside: false };

function setup({ local = true, withContext = false } = {}) {
  let hooks = 0;
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }) };
  const useState = (initial) => {
    const index = hooks++;
    let value = typeof initial === 'function' ? initial() : initial;
    if (index === 0) {
      value = model.createTree(root);
      value.entries.set(root, { state: 'ready', listing: { path: root, parent: null, folders: ['src'], files: ['README.md', '.hidden'], truncated: false } });
    }
    if (index === 17 && withContext) value = { row, x: 12, y: 18 };
    return [value, () => {}];
  };
  const components = new Function('React', 'useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'changeMarks', 'collapseAll', 'createTree', 'moveSelection', 'parseFilesPrefs', 'modelRevealPath', 'toggle', 'visibleRows', 'writeClipboard', 'FilePreviewPanel', `${code}; return { RightFiles, TextSearchResults };`)(
    React, useState, () => {}, (current) => ({ current }), (fn) => fn(), (fn) => fn,
    model.changeMarks, model.collapseAll, model.createTree, model.moveSelection, model.parseFilesPrefs, model.revealPath, model.toggle, model.visibleRows,
    async () => false, () => null,
  );
  return { React, ...components, props: { root, list: async () => ({}), diff: changed, onOpen() {}, local, paneId: 'chat-1', backend: { openTarget: async () => {} } } };
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}
function find(node, predicate) {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const item of node) { const result = find(item, predicate); if (result) return result; } return null; }
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

test('Files tree shows changed paths and hides dotfiles by default', () => {
  const { RightFiles, props, React } = setup();
  const tree = RightFiles(props);
  const markup = textOf(tree);
  assert.match(markup, /README\.md/);
  assert.match(markup, /Changed in this thread/);
  assert.doesNotMatch(markup, /\.hidden/);
  assert.equal(find(tree, (node) => node.props?.role === 'tree')?.props['aria-label'], 'Files');
});

test('right-click actions omit Mac-only entries for remote projects', () => {
  const { RightFiles, props } = setup({ local: false, withContext: true });
  const menu = RightFiles(props);
  const labels = [];
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!node || typeof node !== 'object') return;
    if (node.props?.role === 'menuitem') labels.push(textOf(node));
    collect(node.props?.children);
  };
  collect(menu);
  assert.ok(labels.includes('Open'));
  assert.ok(labels.includes('Copy relative path'));
  assert.ok(labels.includes('Add to chat'));
  assert.ok(!labels.includes('Open in default app'));
  assert.ok(!labels.includes('Reveal in Finder'));
  assert.ok(labels.includes('New file…'));
  assert.ok(labels.includes('New folder…'));
  assert.ok(labels.includes('Rename…'));
  assert.ok(labels.includes('Duplicate'));
  assert.ok(labels.includes('Move to Trash…'));
});

test('Add to chat sends the relative path and owning pane id without using clipboard', () => {
  const { RightFiles, props, React } = setup({ withContext: true });
  let sent;
  globalThis.window = { dispatchEvent: (event) => { sent = event; return true; }, setTimeout() {} };
  try {
    const tree = RightFiles(props);
    const add = find(tree, (node) => node.props?.role === 'menuitem' && textOf(node) === 'Add to chat');
    assert.ok(add);
    add.props.onClick();
    assert.equal(sent.type, 'deck:insert-composer');
    assert.deepEqual(sent.detail, { paneId: 'chat-1', text: '`src/main.ts`' });
  } finally { delete globalThis.window; }
});

const previewSource = await fs.readFile(new URL('../src/FilePreview.tsx', import.meta.url), 'utf8');
const previewCode = transform(previewSource.replace(/^import .*;\n/gm, '').replace(/export function/g, 'function'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
function renderPreview({ value = null, view = 'file', path = '/sample-project/README.md', diff = changed } = {}) {
  const React = { Fragment: Symbol('Fragment'), createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }) };
  let hook = 0;
  const useState = (initial) => { const index = hook++; return [index === 0 ? value : initial, () => {}]; };
  const Markdown = ({ text }) => React.createElement('div', { className: 'rendered-markdown' }, text);
  const component = new Function('React', 'useState', 'useEffect', 'useMemo', 'Markdown', 'writeClipboard', 'isEditable', 'FileEditSession', `${previewCode}; return FilePreviewPanel;`)(React, useState, () => {}, (fn) => fn(), Markdown, async () => false, isEditable, () => null);
  const element = component({ root: '/sample-project', path, backend: { fileRead: async () => value, openTarget: async () => {} }, diff, local: false, paneId: null, view, onView() {}, onClose() {} });
  const expand = (node) => {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map(expand);
    if (node.type === React.Fragment) return expand(node.props.children);
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
  };
  return { React, element: expand(element) };
}

test('text previews render numbered lines and a truncated notice', () => {
  const { element } = renderPreview({ value: { kind: 'text', text: 'first\nsecond', size: 600000, truncated: true } });
  const markup = textOf(element);
  assert.match(markup, /first/);
  assert.match(markup, /second/);
  assert.match(markup, /Truncated — showing the first 512 KB/);
  assert.match(markup, /1/);
  assert.match(markup, /2/);
});

test('image previews use a data image, while binary previews expose no bytes', () => {
  const image = renderPreview({ value: { kind: 'image', mime: 'image/png', data: 'c2FmZQ==', size: 4 } });
  const imageNode = find(image.element, (node) => node.type === 'img');
  assert.equal(imageNode.props.src, 'data:image/png;base64,c2FmZQ==');
  const binary = renderPreview({ value: { kind: 'binary', size: 3 } });
  assert.match(textOf(binary.element), /Binary file · 3 B/);
  assert.doesNotMatch(textOf(binary.element), /c2FmZQ==/);
});

test('Changes view renders added and removed lines from the thread diff', () => {
  const diff = { note: null, files: [{ path: 'README.md', added: 1, removed: 1, by: ['luna'], patch: '--- a/README.md\n+++ b/README.md\n-old\n+new' }] };
  const { element } = renderPreview({ view: 'changes', diff });
  assert.match(textOf(element), /old/);
  assert.match(textOf(element), /new/);
  assert.ok(find(element, (node) => node.props?.className?.includes('removed')));
  assert.ok(find(element, (node) => node.props?.className?.includes('added')));
});

test('text search results group by file, highlight matches and open at the result line', () => {
  const { React, TextSearchResults } = setup();
  const opened = [];
  const tree = TextSearchResults({ result: { hits: [
    { path: 'src/main.ts', line: 7, text: 'export const value = 1;' },
    { path: 'src/main.ts', line: 9, text: 'return value;' },
  ], truncated: true }, query: 'value', onOpen: (...args) => opened.push(args) });
  assert.match(textOf(tree), /src\/main\.ts · 2/);
  assert.match(textOf(tree), /Showing the first 500 matches/);
  assert.ok(find(tree, (node) => node.type === 'mark' && textOf(node) === 'value'));
  const hit = find(tree, (node) => node.props?.className === 'right-files-search-hit');
  hit.props.onClick();
  assert.deepEqual(opened, [['src/main.ts', 7]]);
});

test('the Edit button shows only for whole text files in the file view', () => {
  const hasEdit = (options) => !!find(renderPreview(options).element, (node) => node.type === 'button' && node.props['aria-label'] === 'Edit file');
  const text = { kind: 'text', text: 'a', size: 1, truncated: false, version: '1-1' };
  assert.equal(hasEdit({ value: text }), true);
  assert.equal(hasEdit({ value: { ...text, truncated: true } }), false);
  assert.equal(hasEdit({ value: { kind: 'binary', size: 3 } }), false);
  assert.equal(hasEdit({ value: { kind: 'image', mime: 'image/png', data: '', size: 1 } }), false);
  assert.equal(hasEdit({ value: { kind: 'too_large', size: 9 } }), false);
  assert.equal(hasEdit({ value: text, view: 'changes' }), false);
});
