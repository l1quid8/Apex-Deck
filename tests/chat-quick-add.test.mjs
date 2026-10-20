import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/ChatPane.tsx', import.meta.url), 'utf8');

test('the roster Add bot dialog escapes the thread pane into the document body', () => {
  const expression = source.split('\n').find(line => line.includes('{quickAdd === "roster" && rosterAnchor &&'))?.trim().slice(1, -1);
  assert.ok(expression, 'roster dialog render exists');
  const compiled = transform(`return (${expression});`, { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const body = {};
  const menu = {};
  const render = new Function('React', 'quickAdd', 'rosterAnchor', 'quickAddMenu', 'window', 'document', 'createPortal', compiled);
  const result = render(React, 'roster', { left: 20, bottom: 100 }, menu, { innerHeight: 600 }, { body }, (child, target) => ({ child, target }));
  assert.equal(result.target, body, 'fixed dialog must escape clipping and backdrop-filter ancestors');
  assert.equal(result.child.props.role, 'dialog');
  assert.equal(result.child.props.style.left, 20);
  assert.equal(result.child.props.style.bottom, 100);
  assert.equal(result.child.children[0], menu);
});

test('an empty thread keeps an Add bot seat after a kick notice', () => {
  const guard = source.match(/const botChips = \([\s\S]*?\{\((participants\.length > 0 \|\| entries\.length > 0)\) && \(/)?.[1];
  assert.ok(guard, 'the composer add chip guard exists');
  const shows = new Function('participants', 'entries', `return (${guard});`);
  assert.equal(shows([], [{ kind: 'notice' }]), true, 'a kick notice must not leave the thread with no way to add a bot');
  assert.equal(shows([], []), false, 'the empty state already offers the button on a fresh thread');
  assert.equal(shows([{ id: 'a' }], []), true);
});

test('quick add names a second bot after the queued ones', () => {
  const effect = source.match(/In the quick add menu the name follows the model[\s\S]*?\}, \[([^\]]*)\]\);/);
  assert.ok(effect, 'the name-follows-model effect exists');
  const taken = effect[0].match(/uniqueName\([^\n]*?,\s*(\[[^\n]*?\]),\s*slug\)/)?.[1];
  assert.ok(taken, 'uniqueName gets a taken list');
  assert.match(taken, /queued/, 'bots waiting in the batch count as taken names');
  assert.match(effect[1], /queued/, 'the effect re-runs when the batch changes');
});

test('the quick add menu has effort, persona and API fields', () => {
  const menu = source.slice(source.indexOf('const quickAddMenu = ('), source.indexOf('const quickAddButton = ('));
  for (const name of ['quick-effort', 'quick-persona', 'quick-base-url', 'quick-key-env', 'quick-api-key']) {
    assert.match(menu, new RegExp(`name="${name}"`), `${name} field`);
  }
  assert.match(menu, /type="password"/, 'the API key is a password field');
});

test('the key lookup also runs for the quick add menu', () => {
  assert.match(source, /const keyName = \(adding \|\| quickAdd\) && takesKey\(draft\.preset\)/);
});
