import { assistantComposerDraftFor, draftHookFor } from './helpers/assistant-draft-hook.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { attachmentName, isImage, withAttachments } from '../src/attachments.ts';
import { insertAt } from '../src/composerMenu.ts';

const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/ApexAgentComposerTools.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const find = (node, predicate) => !node || typeof node !== 'object' ? null : predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean) ?? null;
const textOf = node => typeof node === 'string' ? node : node?.children?.map(textOf).join('') ?? '';
const ComposerMenu = () => null;
function harness(props) {
  const states = [], refs = [], effects = [], cleanups = [];
  let cursor = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++; if (!effects[i] || deps.some((v, j) => v !== effects[i][j])) { cleanups[i]?.(); cleanups[i] = fn(); effects[i] = deps; } },
    useImperativeHandle(ref, create) { cursor++; ref.current = create(); },
  };
  const component = new Function('assistantComposerDraftFor', 'useAssistantComposerDraftState', 'React', 'forwardRef', ...Object.keys(hooks), 'ComposerMenu', 'insertAt', 'attachmentName', 'isImage', 'withAttachments', `${compiled}\nreturn ApexAgentComposerTools;`)(assistantComposerDraftFor, draftHookFor(hooks), React, fn => fn, ...Object.values(hooks), ComposerMenu, insertAt, attachmentName, isImage, withAttachments);
  const handle = { current: null };
  return { handle, render() { cursor = 0; return component({ value: '', onChange() {}, participants: [], inputRef: { current: null }, onCommand() {}, trigger: null, ...props }, handle); }, unmount() { cleanups.forEach(fn => fn?.()); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const file = { name: 'report.md', type: 'text/markdown', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };

test('an upload finishing after switching completes in its original draft and restores its metadata', async () => {
  let finish;
  const uploaded = new Promise(resolve => { finish = resolve; });
  const saves = [];
  const a = harness({ draftKey: '["upload-host","a"]', saveAttachment: async (...args) => { saves.push(args); return uploaded; } });
  let tree = a.render();
  find(tree, node => node.type === 'input').props.onChange({ currentTarget: { files: [file], value: 'report.md' } });
  await tick();
  a.render();
  assert.equal(a.handle.current.pending(), true);
  a.unmount();
  const b = harness({ draftKey: '["upload-host","b"]', saveAttachment: async () => '/b/wrong.md' });
  b.render();
  assert.deepEqual(b.handle.current.paths(), []);
  const returnedWhilePending = harness({ draftKey: '["upload-host","a"]' });
  returnedWhilePending.render();
  assert.equal(returnedWhilePending.handle.current.pending(), true);
  finish('/a/report.md');
  await tick();
  tree = harness({ draftKey: '["upload-host","a"]' }).render();
  assert.match(textOf(tree), /report.md/);
  const returned = harness({ draftKey: '["upload-host","a"]' });
  returned.render();
  assert.deepEqual(returned.handle.current.paths(), ['/a/report.md']);
  assert.equal(returned.handle.current.pending(), false);
  assert.equal(returned.handle.current.decorate('A brief'), 'A brief\n\nAttached file: /a/report.md');
  assert.equal(saves.length, 1);
  returnedWhilePending.render();
  assert.deepEqual(returnedWhilePending.handle.current.paths(), ['/a/report.md']);
  a.handle.current.clear(['/a/report.md']);
  returnedWhilePending.render();
  assert.deepEqual(returnedWhilePending.handle.current.paths(), [], 'an original send handle clears the current original-owner draft');
  b.render();
  assert.deepEqual(b.handle.current.paths(), []);
});


test('legacy composer tools without a draft owner keep attachments local to their mount', async () => {
  const first = harness({ saveAttachment: async () => '/legacy/report.md' });
  const tree = first.render();
  find(tree, node => node.type === 'input').props.onChange({ currentTarget: { files: [file], value: '' } });
  await tick();
  first.render();
  assert.deepEqual(first.handle.current.paths(), ['/legacy/report.md']);
  const next = harness({}); next.render();
  assert.deepEqual(next.handle.current.paths(), []);
});
