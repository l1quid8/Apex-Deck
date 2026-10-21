import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transform } from 'sucrase';
const source = fs.readFileSync(new URL('../src/LocalVoiceButton.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const find = (node, predicate) => !node || typeof node !== 'object' ? null : predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean) ?? null;
function harness(api) {
  const states = []; let cursor = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useEffect() {},
  };
  const component = new Function('React', 'window', ...Object.keys(hooks), `${compiled}\nreturn LocalVoiceButton;`)(React, { apexDeck: { moshi: api } }, ...Object.values(hooks));
  return () => { cursor = 0; return component(); };
}
test('local voice renders only when the desktop supports its bridge, and never starts on render', async () => {
  assert.equal(harness(undefined)(), null);
  let starts = 0;
  const render = harness({ open: async () => { starts++; }, status: async () => ({ phase: 'off' }), stop: async () => {} });
  let tree = render(); assert.equal(starts, 0);
  find(tree, n => n.props['aria-label'] === 'Local voice (Moshi)').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = render(); assert.equal(starts, 1);
  assert.equal(find(tree, n => n.props.role === 'dialog'), null);
});
test('setup failure remains visible and closing it stops the helper', async () => {
  let stops = 0;
  const render = harness({ open: async () => { throw new Error('Download failed'); }, status: async () => ({ phase: 'off' }), stop: async () => { stops++; } });
  find(render(), n => n.props['aria-label'] === 'Local voice (Moshi)').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const tree = render();
  assert.equal(find(tree, n => n.props.role === 'alert').children[0], 'Download failed');
  find(tree, n => n.type === 'button' && n.children[0] === 'Close').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 1); assert.equal(find(render(), n => n.props.role === 'dialog'), null);
});
