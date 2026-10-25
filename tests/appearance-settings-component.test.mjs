import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'sucrase';
import * as themes from '../src/themes.ts';

const source = await fs.readFile(new URL('../src/AppearanceSettings.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace('export function AppearanceSettings', 'function AppearanceSettings'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const Component = new Function('React', 'useState', 'useRef', 'useEffect', ...Object.keys(themes), `${compiled}; return AppearanceSettings;`)(React, value => [value, () => {}], value => ({ current: value }), () => {}, ...Object.values(themes));
const all = (node, predicate) => !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...(node.children ?? []).flatMap(child => all(child, predicate))];
const skin = (name, hue = 172) => ({ format: 'apex-glass-playground', version: 2, name, appearance: { ...themes.BUILTIN_SKINS[0].appearance, hue } });

test('only saved skins have delete buttons, outside the apply buttons', () => {
  const tree = Component({ value: { current: skin('Mine'), saved: [skin('Mine')] }, onChange() {} });
  const buttons = all(tree, n => n.type === 'button' && n.props['aria-label'] === 'Delete skin Mine');
  assert.equal(buttons.length, 1);
  for (const button of all(tree, n => n.type === 'button')) assert.equal(all(button, n => n !== button && n.type === 'button').length, 0);
  const builtins = Component({ value: { current: skin('Mine'), saved: [] }, onChange() {} });
  assert.equal(all(builtins, n => n.type === 'button' && n.props.className === 'appearance-skin-delete').length, 0);
});

test('deleting one of two same-name saved skins preserves current appearance and other entries', () => {
  const first = skin('Same', 100), second = skin('Same', 200);
  const value = { current: second, saved: [first, second] };
  let next;
  const tree = Component({ value, onChange(updated) { next = updated; } });
  const buttons = all(tree, n => n.type === 'button' && n.props['aria-label'] === 'Delete skin Same');
  assert.equal(buttons.length, 2);
  buttons[1].props.onClick();
  assert.deepEqual(next.saved, [first]);
  assert.equal(next.current, second);
  assert.deepEqual(value.saved, [first, second]);
});
