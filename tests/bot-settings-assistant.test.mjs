import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { latestSaveQueue } from '../src/settingsSave.ts';
import { applyTurnChange } from '../src/participantSettings.ts';
const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/BotSettings.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const find = (tree, test) => !tree || typeof tree !== 'object' ? null : test(tree) ? tree : tree.children?.map(child => find(child, test)).find(Boolean);
const Segmented = () => null, ReasoningSlider = () => null;
function mount(extra = {}) {
  const profile = { id: 'a', display_name: 'Null', backend: { kind: 'agent', tool: 'codex', model: 'old' }, access: 'ask', effort: 'high', persona: '' };
  const saves = [], rooms = [];
  const props = { config: profile, roomId: '', anchor: {}, backend: { roomCreate: async (...args) => { rooms.push(args); return { participants: [profile] }; } }, loadCurrent: async () => ({ ...profile, persona: 'Assistant-owned current snapshot' }), save: async (...args) => saves.push(args), close() {}, ...extra };
  const state = []; let cursor = 0;
  const useState = initial => { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => state[i] = typeof value === 'function' ? value(state[i]) : value]; };
  const useRef = initial => { const i = cursor++; return state[i] ??= { current: initial }; };
  const bindings = { document: { body: {} }, window: { innerWidth: 1200, innerHeight: 900 }, menuPlacement: () => ({}), React, Fragment: 'fragment', useState, useRef, useEffect() {}, useLayoutEffect() {}, createPortal: tree => tree, latestSaveQueue, applyTurnChange, Segmented, ReasoningSlider, supportsSpeed: () => true, SPEED_OPTIONS: [], speedHint: () => '', AGENT_EFFORTS: { codex: [] }, API_EFFORTS: [], modelGroups: () => [{ models: [{ id: 'old' }] }], apiModelGroups: () => [], effortsFor: () => ['low', 'high'], findModel: () => ({ id: 'old' }), mediaKind: () => null };
  const Component = new Function(...Object.keys(bindings), compiled + '\nreturn BotSettings;')(...Object.values(bindings));
  return { saves, rooms, render() { cursor = 0; return Component(props); } };
}

test('assistant quick settings loads the assistant snapshot without creating a routing room', async () => {
  const h = mount();
  find(h.render(), node => node.type === ReasoningSlider).props.onCommit('low');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.rooms.length, 0);
  assert.equal(h.saves[0][0].effort, 'low');
  assert.equal(h.saves[0][0].persona, 'Assistant-owned current snapshot');
});

test('unsupported assistant controls are disabled with a reason while provider and Settings routes remain visible', () => {
  const h = mount({ disabledReason: 'Reconnect the owning machine.', provider: React.createElement('a', { href: '#settings' }, 'Full Settings') });
  const tree = h.render();
  assert.equal(find(tree, node => node.type === 'fieldset').props.disabled, true);
  assert.ok(find(tree, node => node.type === 'a' && node.props.href === '#settings'));
  assert.ok(find(tree, node => node.props.role === 'status'));
});

test('assistant model menu disables an unavailable saved model and offers only host-reported replacements', () => {
  const h = mount({ offeredModels: [{ id: 'new', label: 'Offered replacement' }], allowDefaultModel: false });
  const trigger = find(h.render(), node => node.props.className === 'model-select-trigger');
  trigger.props.ref.current = { getBoundingClientRect: () => ({ left: 20, right: 300, bottom: 60 }) };
  trigger.props.onClick();
  const tree = h.render();
  const old = find(tree, node => node.props.role === 'menuitemradio' && node.props['aria-checked']);
  assert.equal(old.props.disabled, true);
  const replacement = find(tree, node => node.props.role === 'menuitemradio' && node.children.some(child => child?.children?.includes('Offered replacement')));
  assert.ok(replacement, 'host-offered replacement is available');
  assert.equal(replacement.props.disabled, false);
});

test('an assistant provider default appears once and stays selectable without an invented model id',()=>{
 const config={id:'a',display_name:'Assistant',backend:{kind:'agent',tool:'codex',model:null},access:'ask',effort:null,persona:''};
 const h=mount({config,offeredModels:[{id:'',label:'Provider default',efforts:[]}],allowDefaultModel:true});
 const trigger=find(h.render(),node=>node.props.className==='model-select-trigger');
 trigger.props.ref.current={getBoundingClientRect:()=>({left:20,right:300,bottom:60})};trigger.props.onClick();
 const collect=node=>!node||typeof node!=='object'?[]:[...(node.props.role==='menuitemradio'?[node]:[]),...(node.children??[]).flatMap(collect)];
 const choices=collect(h.render());assert.equal(choices.length,1);assert.equal(choices[0].props.disabled,false);
});
