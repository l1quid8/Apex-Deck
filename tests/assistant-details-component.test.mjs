import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transform } = require('sucrase');
const source = fs.readFileSync(new URL('../src/AssistantDetails.tsx', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const compiled = transform(source.replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;

const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }) };
const all = (tree) => (tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(all)] : []);
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''));
const byClass = (tree, name) => all(tree).filter((node) => String(node.props?.className ?? '').split(' ').includes(name));
const byId = (tree, id) => all(tree).find((node) => node.props?.id === id);

const Avatar = (props) => React.createElement('span', { className: 'identicon', ...props });
const assistantAppearance = () => ({ seed: 'null', color: '#888888', kind: 'identicon' });
// The rendering contract only; the parsing itself is proven in assistant-outputs.test.mjs.
const OUTPUT_MARK = { doc: '▤', data: '{}', view: '◇' };
const OUTPUT_LABEL = { doc: 'Document', data: 'Data', view: 'View' };
const outputsLine = (list) => (list.length === 0 ? 'No deliverables yet' : list.length === 1 ? '1 deliverable' : `${list.length} deliverables`);
const previewSource = (artifact) => artifact.versions[artifact.versions.length - 1].source;

const lane = { name: 'Null', hostName: 'machine', ref: { hostId: 'host', assistantId: 'null' }, assistant: { hostId: 'host', id: 'null' } };
// The status vocabulary and the two heavy children are proven elsewhere; here we
// only check which of them Details reaches for and what it passes down.
const assistantStatus = ({ offline, paused, delegatedTasks = [] }) => {
  const waiting = delegatedTasks.some((task) => ['proposed', 'needs_clarification', 'needs_you', 'ready_for_review'].includes(task.status));
  const state = offline ? 'offline' : paused ? 'paused' : waiting ? 'needs_you' : 'ready';
  return { state, needsYou: 0, failed: 0, working: 0, label: state };
};
const createAssistantAvatarApi = () => undefined;
const AssistantAvatarEditor = () => React.createElement('div', { className: 'avatar-editor-stub' });
const AssistantRuntimeSettings = (props) => React.createElement('div', { className: 'runtime-stub', 'data-inline': props.inline === true });
const brief = {
  id: 'artifact:a', name: 'brief.md', kind: 'doc', folder: 'notes', at: 5,
  artifact: { id: 'a', title: 'Brief', kind: 'markdown', versions: [{ n: 1, source: '# Brief', by: null, seq: 1, at: 5 }, { n: 2, source: '# Brief v2', by: null, seq: 2, at: 6 }] },
};
const data = { id: 'file:out/data.json', name: 'data.json', kind: 'data', folder: 'out', path: 'out/data.json', cwd: '/work/a', at: 0 };

function mount(props = {}) {
  const states = [];
  const events = [];
  let cursor = 0;
  const useState = (initial) => {
    const i = cursor++;
    if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
    return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
  };
  const harness = {
    events,
    render(extra = {}) {
      cursor = 0;
      const base = {
        lane,
        outputs: [brief, data],
        onClose: () => events.push('close'),
        onNavigate: (section) => events.push(`nav:${section}`),
        onOpenBrowser: () => events.push('browser'),
        onOpenFile: (path, cwd) => events.push(`file:${path}:${cwd}`),
        onGoToChat: (taskId) => events.push(`chat:${taskId}`),
      };
      return renderWith({ ...base, ...props, ...extra });    },
  };
  function renderWith(finalProps) {
    const local = new Function(
      'React', 'useState', 'useMemo', 'Avatar', 'assistantAppearance', 'assistantStatus', 'createAssistantAvatarApi', 'AssistantAvatarEditor', 'AssistantRuntimeSettings', 'OUTPUT_MARK', 'OUTPUT_LABEL', 'outputsLine', 'previewSource',
      `${compiled}\nreturn AssistantDetails;`,
    )(React, useState, (factory) => factory(), Avatar, assistantAppearance, assistantStatus, createAssistantAvatarApi, AssistantAvatarEditor, AssistantRuntimeSettings, OUTPUT_MARK, OUTPUT_LABEL, outputsLine, previewSource);
    return local(finalProps);
  }
  return harness;
}

const rowFor = (tree, name) => byClass(tree, 'assistant-output-row').find((row) => text(row).includes(name));

test('each output is one row with its mark, folder and version', () => {
  const tree = mount().render();
  const rows = byClass(tree, 'assistant-output-row');
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]), /brief\.md/);
  assert.match(text(rows[0]), /notes · Document · v2/);
  assert.match(text(rows[1]), /out · Data$/);
  assert.deepEqual(byClass(tree, 'assistant-output-mark').map(text), ['▤', '{}']);
  const outputsHead = byClass(tree, 'assistant-details-fold-head').find((node) => text(node).includes('Outputs'));
  assert.match(text(outputsHead), /2 deliverables/);
});

test('an artifact row shows its newest version and folds away again', () => {
  const harness = mount();
  let tree = harness.render();
  assert.equal(rowFor(tree, 'brief.md').props['aria-expanded'], false);
  rowFor(tree, 'brief.md').props.onClick();
  tree = harness.render();
  assert.equal(rowFor(tree, 'brief.md').props['aria-expanded'], true);
  assert.equal(text(byClass(tree, 'assistant-output-source')[0]).trim(), '# Brief v2');
  rowFor(tree, 'brief.md').props.onClick();
  tree = harness.render();
  assert.equal(byClass(tree, 'assistant-output-source').length, 0);
});

test('a file row opens the file in its own app, with the folder it sits in', () => {
  const harness = mount();
  const tree = harness.render();
  rowFor(tree, 'data.json').props.onClick();
  assert.deepEqual(harness.events, ['file:out/data.json:/work/a']);
});

test('the section says what it is doing instead of showing nothing', () => {
  const note = (tree) => text(byClass(byId(tree, 'assistant-outputs'), 'assistant-details-note')[0]);
  assert.match(note(mount().render({ outputs: [] })), /When a task writes a document/);
  assert.match(note(mount().render({ outputs: [], outputsLoading: true })), /Reading this session/);
  assert.match(note(mount().render({ outputs: [], outputsProblem: 'Could not read this session’s outputs.' })), /Could not read/);
});

test('the Outputs fold closes and opens', () => {
  const harness = mount();
  let tree = harness.render();
  const head = () => byClass(tree, 'assistant-details-fold-head').find((node) => text(node).includes('Outputs'));
  assert.equal(head().props['aria-expanded'], true);
  assert.equal(byId(tree, 'assistant-outputs').props.hidden, false);
  head().props.onClick();
  tree = harness.render();
  assert.equal(head().props['aria-expanded'], false);
  assert.equal(byId(tree, 'assistant-outputs').props.open, undefined, 'a closed fold hides its body');
});

test('the footer walks into its sections, and the close button closes', () => {
  const harness = mount();
  const tree = harness.render();
  const links = byClass(tree, 'assistant-details-links')[0];
  links.children.forEach((button) => button.props.onClick());
  byClass(tree, 'assistant-details-close')[0].props.onClick();
  assert.deepEqual(harness.events, ['nav:memory', 'nav:projects', 'nav:settings', 'close']);
});

test('the browser card opens the browser when this host has one', () => {
  const harness = mount();
  const tree = harness.render();
  const open = byClass(tree, 'assistant-details-action').find((node) => text(node) === 'Open browser');
  assert.ok(open, 'the browser card carries its own button');
  open.props.onClick();
  assert.deepEqual(harness.events, ['browser']);
  const without = mount().render({ onOpenBrowser: undefined });
  assert.equal(byClass(without, 'assistant-details-action').filter((node) => text(node) === 'Open browser').length, 0);
  assert.match(text(byClass(without, 'assistant-details-note')[0]), /does not show the assistant browser/);
});

const now = 1_700_000_000_000;
const tasks = [
  { id: 't1', brief: 'Rewrite the release notes', originalRequest: 'Rewrite the release notes', status: 'ready_for_review', result: 'Drafted a shorter note.', createdAtMs: now - 7_200_000, updatedAtMs: now - 120_000 },
  { id: 't2', brief: 'Check the login flow', originalRequest: 'Check login', status: 'running', result: null, createdAtMs: now - 600_000, updatedAtMs: now - 60_000 },
];

test('Needs you lists only what is waiting, newest idea first, and hides when nothing waits', () => {
  const tree = mount({ tasks }).render();
  assert.deepEqual(byClass(byId(tree, 'assistant-needs'), 'assistant-activity-name').map(text), ['Rewrite the release notes']);
  assert.match(text(byClass(byId(tree, 'assistant-needs'), 'assistant-activity-line')[0]), /Ready to review/);
  assert.equal(byId(mount({ tasks: [] }).render(), 'assistant-needs'), undefined, 'nothing waiting means no section');
});

test('an activity row opens its detail inside Details, and Go to chat asks for the chat', () => {
  const harness = mount({ tasks });
  let tree = harness.render();
  assert.deepEqual(byClass(byId(tree, 'assistant-activity'), 'assistant-activity-name').map(text), ['Check the login flow', 'Rewrite the release notes'], 'newest activity first');
  byClass(byId(tree, 'assistant-activity'), 'assistant-activity-row').find((row) => text(row).includes('Rewrite')).props.onClick();
  tree = harness.render();
  const detail = byClass(tree, 'assistant-activity-detail')[0];
  assert.match(text(detail), /Rewrite the release notes/);
  assert.match(text(detail), /You asked/);
  assert.match(text(detail), /Drafted a shorter note\./);
  assert.match(text(detail), /Worked for/);
  assert.deepEqual(byClass(tree, 'assistant-output-row'), [], 'the detail replaces the overview, it does not stack on it');
  byClass(detail, 'assistant-details-action')[0].props.onClick();
  assert.deepEqual(harness.events, ['chat:t1']);
  byClass(tree, 'assistant-details-back')[0].props.onClick();
  tree = harness.render();
  assert.equal(byClass(tree, 'assistant-activity-detail').length, 0, 'Back returns to the overview');
  assert.ok(byId(tree, 'assistant-outputs'), 'the overview is whole again');
});

const runtimeLane = {
  ...lane,
  assistant: {
    ...lane.assistant, revision: 7, profile: { access: 'ask' }, projects: [{}, {}],
    schedules: [
      { id: 's1', goal: 'Run the tests', everyMs: 7_200_000, status: 'active', nextAt: now + 3_600_000, runs: 2 },
      { id: 's2', goal: 'Draft me', status: 'proposed', runs: 0 },
    ],
  },
};
const foldHead = (tree, name) => byClass(tree, 'assistant-details-fold-head').find((node) => text(node).includes(name));

test('Model & access starts folded, shows its summary, and opens the controls inline', () => {
  const harness = mount();
  const folded = harness.render({ lane: runtimeLane, backend: {} });
  const head = foldHead(folded, 'Model & access');
  assert.ok(head, 'the fold is in Details');
  assert.equal(head.props['aria-expanded'], false);
  assert.match(text(head), /Ask first · 2 projects/);
  assert.equal(all(folded).filter((node) => node.type === AssistantRuntimeSettings).length, 0, 'nothing is fetched or mounted while folded');
  foldHead(harness.render({ lane: runtimeLane, backend: {} }), 'Model & access').props.onClick();
  const opened = harness.render({ lane: runtimeLane, backend: {} });
  const inline = all(opened).filter((node) => node.type === AssistantRuntimeSettings);
  assert.equal(inline.length, 1);
  assert.equal(inline[0].props.inline, true, 'the same controls, drawn in the sidebar');
  assert.equal(byClass(opened, 'assistant-details-fold-body').some((body) => body.props.role === 'dialog'), false, 'no popover is left');
});

test('a folded section hides its body instead of drawing it', () => {
  const harness = mount();
  assert.equal(byId(harness.render(), 'assistant-outputs').props.hidden, false);
  foldHead(harness.render(), 'Outputs').props.onClick();
  assert.equal(byId(harness.render(), 'assistant-outputs').props.hidden, true);
  foldHead(harness.render(), 'Outputs').props.onClick();
  assert.equal(byId(harness.render(), 'assistant-outputs').props.hidden, false);
});

test('a schedule can be cancelled from Details', async () => {
  const events = [];
  const tree = mount().render({
    lane: { ...runtimeLane, cancelSchedule: async (id) => { events.push(`cancel:${id}`); } },
  });
  const rows = all(tree).filter((node) => node.type === 'div' && String(node.props?.className ?? '') === 'assistant-schedule');
  assert.equal(rows.length, 1, 'only active schedules are listed');
  assert.match(text(rows[0]), /Run the tests/);
  assert.match(text(rows[0]), /Every 2h/);
  const cancel = byClass(rows[0], 'assistant-schedule-cancel')[0];
  assert.equal(text(cancel), 'Cancel');
  cancel.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['cancel:s1']);
});

test('with no active schedule Details says what to do instead', () => {
  const tree = mount().render({ lane: { ...lane, assistant: { ...lane.assistant, schedules: [{ id: 's', goal: 'g', status: 'proposed', runs: 0 }] } } });
  assert.match(text(byId(tree, 'assistant-schedules')), /One draft is waiting for you in chat/);
  const empty = mount().render();
  assert.match(text(byId(empty, 'assistant-schedules')), /No schedules\. Ask in chat to set one up\./);
});

test('Call starts the assistant call, and says so when it cannot', () => {
  const events = [];
  const tree = mount().render({ onStartCall: () => events.push('call') });
  const call = byClass(tree, 'assistant-details-action').find((node) => text(node) === 'Call');
  assert.equal(call.props.disabled, false);
  call.props.onClick();
  assert.deepEqual(events, ['call']);
  const offline = mount().render();
  assert.equal(byClass(offline, 'assistant-details-action').find((node) => text(node) === 'Call').props.disabled, true);
});

test('the pencil opens the avatar editor over the 64px portrait', () => {
  const harness = mount();
  const closed = harness.render();
  assert.equal(byClass(closed, 'avatar-editor-stub').length, 0);
  assert.equal(byClass(closed, 'assistant-details-portrait').length, 1);
  const pencil = byClass(closed, 'assistant-details-pencil')[0];
  assert.equal(pencil.props['aria-expanded'], false);
  assert.match(pencil.props['aria-label'], /avatar/);
  pencil.props.onClick();
  const opened = harness.render();
  const editor = all(opened).find((node) => node.type === AssistantAvatarEditor);
  assert.ok(editor, 'the existing avatar editor is mounted by the pencil');
  assert.equal(editor.props.owner.kind, 'assistant');
  assert.equal(byClass(opened, 'assistant-details-pencil')[0].props['aria-expanded'], true);
});

test('the word under the name is the resting status, not a count', () => {
  assert.equal(text(byClass(mount().render(), 'assistant-details-role')[0]), 'Active now');
  const paused = mount().render({ lane: { ...lane, assistant: { ...lane.assistant, paused: true } } });
  assert.equal(text(byClass(paused, 'assistant-details-role')[0]), 'Paused');
  const waiting = mount().render({ tasks: [{ id: 't', brief: 'Do it', originalRequest: 'Do it', status: 'needs_you', updatedAtMs: 1, createdAtMs: 1, revision: 1, reviewCriteria: [], attempts: [], workers: [], mode: 'in_place' }] });
  assert.equal(text(byClass(waiting, 'assistant-details-role')[0]), 'Needs you');
});
