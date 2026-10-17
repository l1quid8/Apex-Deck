import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transform } from 'sucrase';
import * as model from '../src/workSteps.ts';

const source = fs.readFileSync(new URL('../src/WorkSteps.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), {
  transforms: ['typescript', 'jsx'], jsxRuntime: 'classic',
}).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };

/** Mounts WorkSteps with a fake React: hook state lives across renders, the returned tree is plain data. */
function mount(props) {
  const slots = [];
  let at = 0;
  const useState = (initial) => {
    const i = at++;
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
  };
  const { WorkSteps } = new Function('React', 'useState', 'stepTree', 'stepsCountLabel', `${compiled}\nreturn { WorkSteps };`)(
    React, useState, model.stepTree, model.stepsCountLabel,
  );
  return (updates = {}) => { Object.assign(props, updates); at = 0; return WorkSteps(props); };
}

const all = (node, pick, out = []) => {
  if (node && typeof node === 'object') {
    if (pick(node)) out.push(node);
    for (const child of node.children ?? []) all(child, pick, out);
  }
  return out;
};
const text = (node) => (node == null || node === false || node === true ? '' : typeof node === 'object' ? (node.children ?? []).map(text).join('') : String(node));
const buttons = (tree) => all(tree, (n) => n.type === 'button');
const button = (tree, words) => {
  const found = buttons(tree).find((b) => text(b).includes(words));
  assert.ok(found, `a button reading "${words}" in: ${buttons(tree).map(text).join(' | ')}`);
  return found;
};
const rows = (tree) => all(tree, (n) => n.type === 'button' && n.props.className?.split(' ').includes('work-steps-step'));

const step = (n, extra = {}) => ({
  key: `s${n}`, parent: null, kind: 'command', label: `Ran step ${n}`, folder: null, detail: `echo ${n}`,
  output: `out ${n}`, status: 'done', exit_code: 0, duration_ms: 400, ...extra,
});
const turn = (steps, todo = []) => ({ steps, todo, structured: true });

test('a long list shows the last 4 rows under an earlier-steps button, and opens to all of them', () => {
  const render = mount({ turn: turn(Array.from({ length: 10 }, (_, i) => step(i + 1))), live: true });
  let tree = render();
  assert.equal(rows(tree).length, 4);
  assert.deepEqual(rows(tree).map(text).map((t) => t.match(/Ran step \d+/)[0]), ['Ran step 7', 'Ran step 8', 'Ran step 9', 'Ran step 10']);
  button(tree, '6 earlier steps').props.onClick();
  tree = render();
  assert.equal(rows(tree).length, 10);
  assert.ok(button(tree, 'Show fewer'));
  // Open survives a new event in the same turn.
  tree = render({ turn: turn(Array.from({ length: 11 }, (_, i) => step(i + 1))) });
  assert.equal(rows(tree).length, 11);
  button(tree, 'Show fewer').props.onClick();
  assert.equal(rows(render()).length, 4);
});

test('one hidden row reads "1 earlier step"', () => {
  const tree = mount({ turn: turn(Array.from({ length: 5 }, (_, i) => step(i + 1))), live: true })();
  assert.ok(button(tree, '1 earlier step'));
});

test('clicking a row opens its command and output', () => {
  const render = mount({ turn: turn([step(1, { detail: 'npm test -- --grep x', output: 'all 12 passed', exit_code: 2, duration_ms: 65_000, status: 'failed', folder: 'ios-sim-upgrade' })]), live: true });
  let tree = render();
  const row = rows(tree)[0];
  assert.equal(row.props['aria-expanded'], false);
  assert.match(text(row), /in ios-sim-upgrade/);
  assert.match(text(row), /✕/);
  assert.ok(!text(tree).includes('all 12 passed'));
  row.props.onClick();
  tree = render();
  assert.equal(rows(tree)[0].props['aria-expanded'], true);
  const pres = all(tree, (n) => n.type === 'pre');
  assert.deepEqual(pres.map(text), ['npm test -- --grep x', 'all 12 passed']);
  assert.match(text(tree), /Exit code 2/);
  assert.match(text(tree), /1m 05s/);
  assert.ok(!text(tree).includes('Output was cut to fit'));
});

test('a cut output says so', () => {
  for (const extra of [{ output_cut: true }, { output: 'head\n… 1200 lines cut …\ntail' }]) {
    const render = mount({ turn: turn([step(1, extra)]), live: true });
    rows(render())[0].props.onClick();
    assert.match(text(render()), /Output was cut to fit/);
  }
});

test('exit code shows only when known', () => {
  const render = mount({ turn: turn([step(1, { exit_code: null, duration_ms: null })]), live: true });
  rows(render())[0].props.onClick();
  assert.ok(!/Exit code/.test(text(render())));
});

test('a helper renders as a folded box and opens to its own steps', () => {
  const steps = [
    step(1, { key: 'h', kind: 'helper', label: 'Check the tests', detail: '', output: null }),
    step(2, { parent: 'h' }), step(3, { parent: 'h' }), step(4, { parent: 'h' }),
  ];
  const render = mount({ turn: turn(steps), live: true });
  let tree = render();
  const box = button(tree, 'Check the tests');
  assert.equal(box.props['aria-expanded'], false);
  assert.match(text(box), /Done/);
  assert.match(text(box), /3 steps/);
  assert.equal(rows(tree).length, 0);
  box.props.onClick();
  tree = render();
  assert.equal(rows(tree).length, 3);
});

test('a working helper shows its latest step under the title', () => {
  const steps = [
    step(1, { key: 'h', kind: 'helper', label: 'Check the tests', status: 'running', detail: '', output: null }),
    step(2, { parent: 'h' }), step(3, { parent: 'h', label: 'Reading the logs', status: 'running' }),
  ];
  const tree = mount({ turn: turn(steps), live: true })();
  const box = button(tree, 'Check the tests');
  assert.match(text(box), /Working/);
  assert.match(text(box), /Reading the logs/);
});

test('output is set as text, never as HTML', () => {
  const render = mount({ turn: turn([step(1, { output: '<b>bold</b>' })]), live: true });
  rows(render())[0].props.onClick();
  const tree = render();
  assert.ok(text(tree).includes('<b>bold</b>'));
  assert.equal(all(tree, (n) => n.type === 'b' || 'dangerouslySetInnerHTML' in n.props).length, 0);
});

test('the to-do list sits above the steps with the current item marked', () => {
  const todo = [
    { text: 'Read the code', status: 'completed' },
    { text: 'Write the fix', status: 'in_progress' },
    { text: 'Run the tests', status: 'pending' },
  ];
  const tree = mount({ turn: turn([step(1)], todo), live: true })();
  const items = all(tree, (n) => n.type === 'li' && n.props.className?.includes('work-steps-todo-item'));
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(text), ['✔Read the code', '▸Write the fix', '□Run the tests']);
  assert.equal(items[1].props['aria-current'], 'step');
  assert.equal(items.filter((i) => i.props['aria-current']).length, 1);
  const flat = text(tree);
  assert.ok(flat.indexOf('Run the tests') < flat.indexOf('Ran step 1'));
});

test('initiallyOpen shows every row', () => {
  const tree = mount({ turn: turn(Array.from({ length: 10 }, (_, i) => step(i + 1))), live: false, initiallyOpen: true })();
  assert.equal(rows(tree).length, 10);
});

test('a phone can show more rows', () => {
  const tree = mount({ turn: turn(Array.from({ length: 10 }, (_, i) => step(i + 1))), live: true, maxShown: 6 })();
  assert.equal(rows(tree).length, 6);
  assert.ok(button(tree, '4 earlier steps'));
});

test('durations read compactly', () => {
  const { formatDuration } = new Function('React', 'useState', 'stepTree', 'stepsCountLabel', `${compiled}\nreturn { formatDuration };`)(React, () => [], model.stepTree, model.stepsCountLabel);
  assert.deepEqual([400, 12_000, 65_000, 9_960, 59_700].map(formatDuration), ['0.4s', '12s', '1m 05s', '10s', '1m 00s']);
});

/** Mounts SavedSteps (the "83 steps" line) the same way. */
function mountSaved(props) {
  const slots = [];
  let at = 0;
  const useState = (initial) => {
    const i = at++;
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
  };
  // A nested component is expanded in place, sharing the hook slots.
  const Nested = { createElement: (type, p, ...kids) => (typeof type === 'function' ? type(p ?? {}) : React.createElement(type, p, ...kids)) };
  const { SavedSteps } = new Function('React', 'useState', 'stepTree', 'stepsCountLabel', `${compiled}\nreturn { SavedSteps };`)(
    Nested, useState, model.stepTree, model.stepsCountLabel,
  );
  return () => { at = 0; return SavedSteps(props); };
}
const reply = (extra = {}) => ({ by: 'bot', seq: 7, steps: [step(1), step(2)], todo: [], dropped: 0, ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a saved reply shows "83 steps", loads nothing until clicked, loads once, and folds on a second click', async () => {
  let calls = 0;
  const render = mountSaved({ count: 83, load: async () => { calls++; return reply(); } });
  let tree = render();
  assert.equal(text(button(tree, '83 steps')), '83 steps');
  assert.equal(calls, 0);
  assert.equal(rows(tree).length, 0);
  button(tree, '83 steps').props.onClick();
  tree = render();
  assert.match(text(tree), /Loading steps…/);
  await settle();
  tree = render();
  assert.equal(calls, 1);
  assert.equal(rows(tree).length, 2);
  assert.ok(!text(tree).includes('Loading steps'));
  button(tree, '83 steps').props.onClick();
  tree = render();
  assert.equal(rows(tree).length, 0);
  assert.equal(calls, 1);
  button(tree, '83 steps').props.onClick();
  assert.equal(rows(render()).length, 2);
  assert.equal(calls, 1);
});

test('one step reads "1 step"; a cached reply opens without a call', () => {
  let calls = 0;
  const render = mountSaved({ count: 1, cached: reply(), load: async () => { calls++; return null; } });
  button(render(), '1 step').props.onClick();
  assert.equal(rows(render()).length, 2);
  assert.equal(calls, 0);
});

test('a failed or empty load says the steps are not available', async () => {
  for (const load of [async () => null, async () => { throw new Error('boom'); }]) {
    const render = mountSaved({ count: 5, load });
    button(render(), '5 steps').props.onClick();
    await settle();
    assert.match(text(render()), /Steps aren't available for this reply\./);
  }
});

test('dropped steps are counted quietly after the list', async () => {
  const render = mountSaved({ count: 9, load: async () => reply({ dropped: 12 }) });
  button(render(), '9 steps').props.onClick();
  await settle();
  const tree = render();
  assert.match(text(tree), /12 more steps weren't kept/);
  const none = mountSaved({ count: 9, cached: reply() });
  button(none(), '9 steps').props.onClick();
  assert.ok(!text(none()).includes("weren't kept"));
});

test('the index loader coalesces, shuts off for an unknown command, and retries after other errors', async () => {
  const indexOf = (n) => ({ version: 1, replies: { 3: { by: 'bot', count: n, helpers: 0, offset: 0, len: 1 } } });
  // Coalescing: three requests while one is in flight make exactly one more call.
  let calls = 0;
  let release;
  const seen = [];
  const loader = model.createStepsIndexLoader(() => { calls++; return calls === 1 ? new Promise((r) => { release = () => r(indexOf(1)); }) : Promise.resolve(indexOf(calls)); }, (i) => seen.push(i));
  const first = loader.refresh();
  loader.refresh(); loader.refresh(); loader.refresh();
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(calls, 2);
  assert.equal(seen.at(-1).replies[3].count, 2);
  // Unknown command: no line, never called again.
  let unknownCalls = 0;
  const old = model.createStepsIndexLoader(async () => { unknownCalls++; throw new Error('unknown variant `room_steps`'); }, (i) => seen.push(i));
  await old.refresh();
  await old.refresh();
  assert.equal(unknownCalls, 1);
  assert.equal(old.unsupported(), true);
  assert.equal(seen.at(-1), null);
  // Other errors: no line now, retried on the next refresh.
  let tries = 0;
  const flaky = model.createStepsIndexLoader(async () => { if (tries++ === 0) throw new Error('offline'); return indexOf(4); }, (i) => seen.push(i));
  await flaky.refresh();
  assert.equal(seen.at(-1), null);
  await flaky.refresh();
  assert.equal(seen.at(-1).replies[3].count, 4);
  assert.equal(flaky.unsupported(), false);
});

test('an opened saved reply lists every step with no "Show fewer"', () => {
  const render = mountSaved({ count: 10, cached: reply({ steps: Array.from({ length: 10 }, (_, i) => step(i + 1)) }), load: async () => null });
  button(render(), '10 steps').props.onClick();
  const tree = render();
  assert.equal(rows(tree).length, 10);
  assert.ok(!buttons(tree).some((b) => /Show fewer|earlier/.test(text(b))));
});
