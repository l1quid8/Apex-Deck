import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { confirmAgentFullAccess } from '../src/agentFullAccess.ts';
const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/AgentFullAccessStatus.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') ?? '';
const find = (node, predicate) => !node || typeof node !== 'object' ? null : predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean);
const tick = () => new Promise(resolve => setImmediate(resolve));
function mount(props) {
  let cursor = 0;
  const state = [], deps = [], effects = [], cleanups = [];
  const useState = initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value; }]; };
  const useRef = initial => { const i = cursor++; return state[i] ??= { current: initial }; };
  const useEffect = (effect, next) => { const i = cursor++; if (!deps[i] || next.some((v, j) => deps[i][j] !== v)) { deps[i] = next; effects.push(() => { cleanups[i]?.(); cleanups[i] = effect(); }); } };
  const bindings = { window: { confirm: () => true }, React, useState, useRef, useEffect, confirmAgentFullAccess: (backend, config) => confirmAgentFullAccess(backend, config, () => true) };
  const Component = new Function(...Object.keys(bindings), compiled + '\nreturn AgentFullAccessStatus;')(...Object.values(bindings));
  return { props, render() { cursor = 0; const tree = Component(this.props); effects.splice(0).forEach(effect => effect()); return tree; } };
}
test('a blocked Full agent can confirm from settings without sending a thread message', async () => {
  const calls = []; let approved = false;
  const backend = { supports: () => true, call: async (cmd, args) => { calls.push([cmd, args]); if (args.confirm) approved = true; if (args.revoke) approved = false; return { approved }; } };
  const config = { id: 'null', display_name: 'Null', access: 'full' };
  const h = mount({ backend, config }); h.render(); await tick();
  const button = find(h.render(), node => node.type === 'button');
  assert.equal(text(button), 'Confirm Full access');
  await button.props.onClick();
  assert.match(text(h.render()), /Full access confirmed/);
  assert.ok(calls.every(([cmd]) => cmd === 'agent_full_access'));
  assert.equal(calls.filter(([, args]) => args.confirm).length, 1);
  h.props = { backend, config: { ...config, access: 'ask' } };
  h.render(); await tick();
  const revoke = find(h.render(), node => node.type === 'button');
  assert.equal(text(revoke), 'Revoke Full access approval');
  await revoke.props.onClick();
  assert.equal(calls.at(-1)[1].revoke, true);
  assert.equal(h.render(), null);
});
test('unsupported service explains why confirmation is unavailable', () => {
  const h = mount({ backend: { supports: () => false }, config: { id: 'null', access: 'full' } });
  const tree = h.render();
  assert.match(text(tree), /Update this machine/);
  assert.equal(find(tree, node => node.type === 'button'), undefined);
});
