import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import * as model from '../src/planRunModel.ts';

const read = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const compile = (source) => transform(source.replace(/^import .*;\n/gm, '').replaceAll('export ', ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const walk = (node, seen = []) => {
  if (!node || typeof node !== 'object') return seen;
  seen.push(node);
  for (const child of node.children ?? []) walk(child, seen);
  return seen;
};
const text = (node) => (node === null || node === undefined || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.children ?? []).map(text).join(''));
const buttons = (tree) => walk(tree).filter((n) => n.type === 'button');
const named = (tree, words) => buttons(tree).find((n) => text(n) === words);
const boxes = (tree) => walk(tree).filter((n) => n.type === 'input' && n.props.type === 'checkbox');
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };

function panel(run, others = []) {
  const states = []; let cursor = 0; const decisions = []; const stops = [];
  const useState = (initial) => { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; };
  const PlanPanel = new Function('React', 'useState', 'useRef', 'Markdown', ...Object.keys(model), `${compile(read('PlanPanel.tsx'))}; return PlanPanel;`)(React, useState, (value) => ({ current: value }), 'Markdown', ...Object.values(model));
  return { decisions, stops, render() {
    cursor = 0;
    return PlanPanel({ run, others, onDecide: async (...args) => { decisions.push(args); }, onStop: async (who) => { stops.push(who); }, onClose() {}, onExpand() {}, expanded: false });
  } };
}
const chip = (run, onOpen = () => {}) => new Function('React', ...Object.keys(model), `${compile(read('PlanChip.tsx'))}; return PlanChip;`)(React, ...Object.values(model))({ run, onOpen });

const step = (id, state = 'open') => ({ id, text: `Step ${id}`, state, off_plan: false });
const run = (over = {}) => ({ request: 'r1', by: 'ada', detail: '# Fix colours\n\nWhy it matters.', version: 1, state: 'waiting', steps: [step('a'), step('b')], reporting: true, started_seq: 1, ...over });
const planAction = { kind: 'plan', title: 'Start?', detail: '', risky: false };

test('chip_replaces_the_plan_card_when_the_host_supports_it', () => {
  assert.equal(model.planShowsChip(planAction, 'r1', [run()], true), true);
  const tree = chip(run());
  assert.equal(tree.type, 'button');
  assert.match(text(tree), /Fix colours/);
  assert.match(text(tree), /Needs your decision/);
  assert.equal(walk(tree).some((n) => n.type === 'button' && /Start/.test(text(n))), false, 'the decision lives in the panel, not the chip');
  assert.match(read('ChatPane.tsx'), /planShowsChip\(ask\.action, ask\.request, planRuns, planTab\)/);
});

test('old_host_keeps_the_approval_card', () => {
  assert.equal(model.planShowsChip(planAction, 'r1', [run()], false), false);
  assert.equal(model.planShowsChip(planAction, 'r1', [], true), false, 'no run for this request yet keeps the card');
});

test('other_approval_cards_are_unchanged', () => {
  assert.equal(model.planShowsChip({ ...planAction, kind: 'command' }, 'r1', [run()], true), false);
});

test('unticking_changes_the_button_and_sends_skips', async () => {
  const p = panel(run({ steps: [step('a'), step('b'), step('c')] }));
  let tree = p.render();
  assert.ok(named(tree, 'Start the work'));
  boxes(tree)[1].props.onChange();
  tree = p.render();
  const start = named(tree, 'Start 2 of 3 steps');
  assert.ok(start);
  await start.props.onClick();
  assert.deepEqual(p.decisions, [['r1', true, ['b']]]);
});

test('all_unticked_disables_start', () => {
  const p = panel(run());
  let tree = p.render();
  boxes(tree).forEach((box) => { box.props.onChange(); });
  tree = p.render();
  const start = buttons(tree).find((n) => /^Start/.test(text(n)));
  assert.equal(start.props.disabled, true);
  assert.match(text(tree), /Tick at least one step/);
});

test('keep_planning_sends_no_skips', async () => {
  const p = panel(run());
  let tree = p.render();
  boxes(tree)[0].props.onChange();
  tree = p.render();
  await named(tree, 'Keep planning').props.onClick();
  assert.deepEqual(p.decisions, [['r1', false, []]]);
});

test('running_footer_shows_stop_and_calls_roomStop', async () => {
  const p = panel(run({ state: 'running', steps: [step('a', 'done'), step('b', 'active')] }));
  const tree = p.render();
  assert.equal(boxes(tree).length, 0);
  await named(tree, 'Stop').props.onClick();
  assert.deepEqual(p.stops, ['ada']);
  assert.match(read('ChatPane.tsx'), /stop: \(who\) => current\.current\.roomStop\(pane\.id, who\)/);
});

test('skipped_steps_stay_visible_when_done', () => {
  const tree = panel(run({ state: 'done', steps: [step('a', 'done'), step('b', 'skipped')] })).render();
  assert.match(text(tree), /Step b/);
  assert.match(text(tree), /Skipped/);
  assert.equal(named(tree, 'Stop'), undefined);
});

test('second_bot_run_is_listed', () => {
  const tree = panel(run(), [run({ request: 'r2', by: 'null', detail: '# Other plan', state: 'running' })]).render();
  assert.match(text(tree), /Other plan/);
});

test('plan_with_no_steps_shows_markdown_without_ticks', () => {
  const tree = panel(run({ steps: [] })).render();
  assert.equal(boxes(tree).length, 0);
  assert.ok(walk(tree).some((n) => n.type === 'Markdown' && n.props.text.includes('Why it matters')));
  const go = named(tree, 'Start the work');
  assert.ok(go);
  assert.equal(go.props.disabled, false, 'a prose plan can be approved from the panel');
});

test('prose_plan_start_sends_approve', async () => {
  const p = panel(run({ steps: [] }));
  await named(p.render(), 'Start the work').props.onClick();
  assert.deepEqual(p.decisions, [['r1', true, []]]);
});

test('busy_stays_until_the_run_changes', async () => {
  const p = panel(run());
  await named(p.render(), 'Start the work').props.onClick();
  assert.equal(named(p.render(), 'Start the work').props.disabled, true, 'no second click after a successful send');
});

test('chip_open_names_its_run_and_pane_and_popout_points_home', () => {
  assert.match(read('ChatPane.tsx'), /onOpenPlan\?\.\(pane\.id, planChipRun\.request\)/);
  assert.match(read('PlanPanel.tsx'), /want/);
  assert.match(read('PopoutApp.tsx'), /tabKind === "plan"/);
});

test('keyboard_can_reach_every_control', () => {
  const tree = panel(run()).render();
  const controls = [...buttons(tree), ...boxes(tree)];
  for (const name of ['Tt', '</>', '⤢', '✕']) assert.ok(named(tree, name), name);
  assert.ok(controls.length >= 8);
  for (const control of controls) {
    assert.notEqual(control.props.tabIndex, -1);
    assert.ok(control.props['aria-label'] || text(control), 'every control has a name');
  }
  assert.ok(named(tree, '✕').props['aria-label']);
});

test('expired_run_has_no_live_start_control', () => {
  const tree = panel(run({ state: 'expired' })).render();
  assert.equal(buttons(tree).some((n) => /^Start|Keep planning/.test(text(n))), false);
  assert.equal(boxes(tree).length, 0);
  assert.match(text(tree), /never answered/);
});

test('narrow_work_area_stacks_the_plan_instead_of_covering_the_chat', () => {
  assert.equal(model.planStacks(1100, 320), false);
  assert.equal(model.planStacks(760, 320), true);
  assert.equal(model.planStacks(699, 100), true);
});

test('runs_update_in_place', () => {
  const next = model.upsertRun([run()], run({ state: 'running' }));
  assert.equal(next.length, 1);
  assert.equal(next[0].state, 'running');
  assert.equal(model.upsertRun(next, run({ request: 'r2' })).length, 2);
  assert.equal(model.planTitle('Intro\n\n## Real title'), 'Real title');
  assert.equal(model.planTitle('no heading'), 'Plan');
});
