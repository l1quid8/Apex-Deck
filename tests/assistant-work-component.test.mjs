import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { transform } = createRequire(import.meta.url)('sucrase');
const source = fs.readFileSync(new URL('../src/AssistantWork.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };
const text = n => n == null || typeof n === 'boolean' ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : n.children?.map(text).join('') ?? '';
const find = (n, p) => !n || typeof n !== 'object' ? null : p(n) ? n : (n.children ?? []).map(c => find(c, p)).find(Boolean) ?? null;
const all = (n, p) => !n || typeof n !== 'object' ? [] : [...(p(n) ? [n] : []), ...(n.children ?? []).flatMap(c => all(c, p))];
const { AssistantWork } = new Function('React', `${compiled}\nreturn {AssistantWork};`)(React);

const item = (taskId, extra = {}) => ({ key: `delegated:${taskId}`, source: 'delegated', taskId, title: `Task ${taskId}`, projectName: 'apex-deck', worker: 'hyke', status: 'ready_for_review', atMs: Date.UTC(2026, 9, 23, 7, 55), ...extra });
const empty = { needsYou: [], working: [], finished: [], cancelled: [] };
const work = (items = {}, extra = {}) => AssistantWork({ items: { ...empty, ...items }, projects: 'Project cards', onOpenTask() {}, ...extra });

test('v8 groups tasks by urgency and omits empty groups', () => {
 const tree=work({needsYou:[item('a')],working:[item('r',{status:'running'})]});
 assert.deepEqual(all(tree,n=>n.type==='h3').map(text),['Needs you1','In progress1']);
 assert.equal(all(work(),n=>n.type==='h3').length,0);
 assert.match(text(work()),/You’re caught up/);assert.doesNotMatch(text(work()),/Nothing running|Nothing is waiting/);
});

test('finished is collapsed and groups cancelled tasks', () => {
  const tree = work({ finished: [item('d', { status: 'done' })], cancelled: [item('c1', { status: 'cancelled' }), item('c2', { status: 'cancelled' }), item('c3', { status: 'cancelled' })] });
  const details = find(tree, n => n.type === 'details' && n.props.className === 'assistant-work-finished');
  assert.ok(details);
  assert.notEqual(details.props.open, true);
  assert.match(text(details), /History/);assert.match(text(details), /Finished & cancelled/);assert.match(text(details), /Task c3/);
  assert.match(text(details), /Task d/);
});

test('review opens the task', () => {
  const opened = [];
  const target = item('a');
  find(work({ needsYou: [target] }, { onOpenTask: i => opened.push(i) }), n => n.type === 'button' && text(n) === 'Review result').props.onClick();
  assert.deepEqual(opened, [target]);
});

test('a row shows project, worker and words for the status', () => {
  const row = text(work({ needsYou: [item('a'), item('f', { status: 'failed' })] }));
  assert.match(row, /Task a/);
  assert.match(row, /apex-deck · hyke/);
  assert.match(row, /Failed/);
});

test('the projects slot is rendered', () => {
  assert.match(text(work()), /Project cards/);
});

test('running, done and cancelled rows all open their task with the state action', () => {
  for (const [bucket, status, label] of [['working','running','View task'], ['finished','done','View result'], ['cancelled','cancelled','View task'], ['needsYou','ready_for_review','Review result'], ['needsYou','proposed','Review plan']]) {
    const opened = [], target = item(status, {status});
    const tree = work({[bucket]: [target]}, {onOpenTask: task => opened.push(task)});
    const button = find(tree, node => node.type === 'button' && text(node) === label);
    assert.ok(button, `${status} action`); button.props.onClick(); assert.deepEqual(opened, [target]);
  }
});

test('delete has explicit cancellation wording for active work and restore for deleted records', () => {
  const deleted = [], restored = [], active = item('r', {status:'running'}), done = item('d', {status:'done'});
  const tree = work({working:[active], deleted:[done]}, {onDeleteTask: task => deleted.push(task), onRestoreTask: task => restored.push(task)});
  find(tree, node => node.type === 'button' && text(node) === 'Cancel and delete').props.onClick();
  find(tree, node => node.type === 'button' && text(node) === 'Restore').props.onClick();
  assert.deepEqual(deleted, [active]); assert.deepEqual(restored, [done]);
});

test('Empty requires irreversible confirmation for the displayed exact task keys', () => {
 const calls=[],prompts=[],original=globalThis.window;
 try {
  const deleted=[item('a'),item('b')];
  const tree=work({deleted},{onEmptyDeleted:keys=>calls.push(keys)});
  const empty=find(tree,node=>node.type==='button'&&text(node)==='Empty deleted tasks (2)');assert.equal(empty.props.disabled,false);
  globalThis.window={confirm:prompt=>(prompts.push(prompt),false)};empty.props.onClick();assert.deepEqual(calls,[]);
  globalThis.window.confirm=prompt=>(prompts.push(prompt),true);empty.props.onClick();
  assert.match(prompts[0],/Permanently delete 2 deleted tasks/);assert.match(prompts[0],/cannot be undone/);assert.deepEqual(calls,[['delegated:a','delegated:b']]);
  assert.equal(find(work({}, {onEmptyDeleted(){}}),node=>node.type==='button'&&text(node)==='Empty deleted tasks (0)').props.disabled,true);
 } finally {globalThis.window=original;}
});


test('New task is one header action and Projects is an explicit collapsed management drawer',()=>{
 let created=0,toggled=0;const tree=work({}, {projectCount:2,projectsOpen:false,onNewTask:()=>created++,onProjectsToggle:()=>toggled++});
 const create=find(tree,n=>n.type==='button'&&text(n)==='+ New task');assert.ok(create);assert.equal(create.props.disabled,false);create.props.onClick();assert.equal(created,1);
 const projects=find(tree,n=>n.type==='button'&&n.props['aria-controls']==='assistant-work-project-management');
 assert.equal(projects.props['aria-expanded'],false);assert.match(text(projects),/Projects/);assert.match(text(projects),/2/);projects.props.onClick();assert.equal(toggled,1);
 assert.equal(find(tree,n=>n.props.id==='assistant-work-project-management').props.hidden,undefined,'management host remains mounted for focus and dialogs');
 assert.equal(find(work({}, {projectsOpen:true}),n=>n.props['aria-controls']==='assistant-work-project-management').props['aria-expanded'],true);
});
test('each task title opens the same identity as its next action',()=>{
 const target=item('one'),opened=[];const tree=work({needsYou:[target]}, {onOpenTask:i=>opened.push(i)});
 const row=find(tree,n=>n.props.className==='assistant-work-row');assert.ok(row);
 find(row,n=>n.type==='button'&&text(n)==='Task one').props.onClick();
 find(row,n=>n.type==='button'&&text(n)==='Review result').props.onClick();assert.deepEqual(opened,[target,target]);
 assert.equal(all(tree,n=>n.props.className==='assistant-work-row').length,1);
});
test('New task explains unavailable creation without dropping project management',()=>{
 const tree=work({}, {onNewTask(){},newTaskDisabledReason:'Assign a project first.'});
 const create=find(tree,n=>n.type==='button'&&text(n)==='+ New task');assert.equal(create.props.disabled,true);assert.equal(create.props.title,'Assign a project first.');assert.match(text(tree),/Projects/);
});
