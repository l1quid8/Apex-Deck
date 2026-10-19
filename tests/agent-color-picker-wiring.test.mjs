import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { AGENT_COLORS } from '../src/identicon.ts';

const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/ChatPane.tsx', import.meta.url), 'utf8');

/** The appearance block of the Agents tab's agent form, from `{formAppearance &&`
 *  to the closing `</div>}`. */
function appearanceBlock() {
  const start = source.indexOf('{formAppearance && <div className="appearance-controls">');
  assert.ok(start > 0, 'the agents form has an appearance block');
  const end = source.indexOf('</div>}', start);
  assert.ok(end > start, 'the appearance block closes');
  return source.slice(start + 1, end + '</div>'.length);
}

/** Render the real block with a stand-in for React, so the props the picker
 *  receives and sends back are the ones ChatPane really passes. */
function renderAppearance({ draft = {}, set = () => {}, formAppearance = { seed: 'seeded', color: '#a78bfa' } }) {
  const compiled = transform(`return (${appearanceBlock()});`, { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const Avatar = function Avatar() {};
  const HexColorPicker = function HexColorPicker() {};
  const render = new Function('React', 'Avatar', 'HexColorPicker', 'AGENT_COLORS', 'draft', 'set', 'createAppearance', 'identities', 'formAppearance', compiled);
  return render(React, Avatar, HexColorPicker, AGENT_COLORS, draft, set, () => ({ seed: 'new-seed', color: '#f472b6' }), { current: new Map() }, formAppearance);
}

function pickerIn(tree) {
  const stack = [tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type?.name === 'HexColorPicker') return node;
    stack.push(...(node.children ?? []));
  }
  return null;
}

test('the agents form offers a hex picker over the preset palette instead of a colour dropdown', () => {
  const tree = renderAppearance({ draft: {} });
  assert.equal(tree.type, 'div');
  const picker = pickerIn(tree);
  assert.ok(picker, 'the appearance block renders the hex picker');
  assert.deepEqual(picker.props.presets, AGENT_COLORS, 'presets are the agent palette');
  // A dropdown cannot express an arbitrary colour, which is the whole point.
  assert.doesNotMatch(appearanceBlock(), /<select/, 'no fixed colour dropdown is left');
  for (const child of tree.children) {
    assert.notEqual(child?.type, 'select', 'no select element remains');
  }
});

test('picking a colour edits the agent draft and keeps its pattern', () => {
  const saved = [];
  const appearance = { seed: 'kept-seed', color: '#a78bfa' };
  const tree = renderAppearance({ draft: { appearance }, formAppearance: appearance, set: (key, value) => saved.push([key, value]) });
  pickerIn(tree).props.onChange('#123456');
  assert.deepEqual(saved, [['appearance', { seed: 'kept-seed', color: '#123456' }]], 'the pattern seed survives a colour change');
});

test('an agent with a saved appearance shows the colour it already has', () => {
  const tree = renderAppearance({ draft: {}, formAppearance: { seed: 'saved-seed', color: '#2dd4bf' } });
  assert.equal(pickerIn(tree).props.value, '#2dd4bf', 'value comes from the saved appearance');
  assert.equal(pickerIn(tree).props.label, 'Color', 'the field is labelled');
});

test('a brand new agent gets the picker too, keeping the seeded pattern', () => {
  // Creating an agent: nothing saved yet, no @handle, so the block must not
  // depend on `editing`. openNewForm seeds the appearance it will save.
  const saved = [];
  const seeded = { seed: 'new-seed', color: '#a78bfa' };
  const tree = renderAppearance({ draft: {}, formAppearance: seeded, set: (key, value) => saved.push([key, value]) });
  const picker = pickerIn(tree);
  assert.ok(picker, 'the new-agent form renders the hex picker');
  assert.equal(picker.props.value, '#a78bfa', 'it starts on the colour the save will keep');
  picker.props.onChange('#00ff88');
  assert.deepEqual(saved, [['appearance', { seed: 'new-seed', color: '#00ff88' }]], 'the chosen hex lands in the draft with its pattern');
  assert.doesNotMatch(appearanceBlock(), /editing/, 'the block no longer depends on an existing agent');
});

test('the new-agent form mints its appearance when it opens, not when it saves', () => {
  const start = source.indexOf('function openNewForm()');
  assert.ok(start > 0, 'openNewForm exists');
  const body = source.slice(start, source.indexOf('\n  }', start));
  assert.match(body, /appearance: createAppearance\(\[\.\.\.identities\.current\.values\(\)\]\)/, 'the form seeds a pattern and colour');
  assert.match(body, /base\.appearance \? base :/, 'a draft that already has a look keeps it');
});

test('every way into the new-agent form goes through openNewForm so it seeds a colour', () => {
  // startEditing is the other one: it edits a saved agent that already has an
  // appearance. Anything else would open a colourless new-agent form.
  const opens = source.match(/setAdding\(true\)/g) ?? [];
  assert.equal(opens.length, 2, 'only openNewForm and startEditing set adding directly');
  assert.match(source, /if \(adding\) return closeForm\(draft\.preset\);\s*\n\s*openNewForm\(\);/);
});
