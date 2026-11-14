import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const chatPane = readFileSync(new URL('../src/ChatPane.tsx', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { transform } = require('sucrase');

test('Threads bot replies include Read aloud in the message action row', () => {
  const actions = chatPane.match(/const messageActions = \(message: Message\) => \{([\s\S]*?)\n  const threadExport/);
  assert.ok(actions, 'Threads message action row exists');
  assert.match(actions[1], /message\.speaker\.kind === "bot" && <ReadAloudAction key="read-aloud" text=\{message\.text\} \/>/);
});

function actionFixture(readResponseAloud) {
  const source = readFileSync(new URL('../src/ReadAloudAction.tsx', import.meta.url), 'utf8');
  const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
  const states = [], refs = [], cleanups = [];
  let stateIndex = 0, refIndex = 0, mounted = false;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const action = new Function('React', 'useEffect', 'useRef', 'useState', 'readResponseAloud', `${compiled}\nreturn ReadAloudAction;`)(
    React,
    effect => { if (!mounted) cleanups.push(effect()); },
    initial => (refs[refIndex++] ??= { current: initial }),
    initial => { const i = stateIndex++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    readResponseAloud,
  );
  return {
    render(text = 'Read this from the thread.') { stateIndex = refIndex = 0; const tree = action({ text }); mounted = true; return tree; },
    unmount() { cleanups.forEach(fn => fn?.()); },
  };
}
const button = tree => tree.type === 'button' ? tree : tree.children.find(child => child?.type === 'button');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the shared action reads the response and stops its own pending playback', async () => {
  let complete, stopped = 0;
  const texts = [];
  const f = actionFixture(text => {
    texts.push(text);
    return { done: new Promise(resolve => { complete = resolve; }), stop() { stopped++; complete(); } };
  });
  button(f.render()).props.onClick();
  assert.deepEqual(texts, ['Read this from the thread.']);
  assert.equal(button(f.render()).props['aria-pressed'], true);
  button(f.render()).props.onClick();
  await tick();
  assert.equal(stopped, 1);
  assert.equal(button(f.render()).props['aria-pressed'], false);
  assert.equal(f.render('  '), null);
});

test('Read aloud displays synthesis and playback errors and permits retry', async () => {
  const f = actionFixture(() => ({ done: Promise.reject(Error('Speakers unavailable')), stop() {} }));
  button(f.render()).props.onClick();
  await tick();
  const tree = f.render();
  assert.equal(button(tree).props['aria-pressed'], false);
  const alert = tree.children.find(child => child?.props?.role === 'alert');
  assert.ok(alert, 'failure is visible to the user');
  assert.ok(alert.children.includes('Speakers unavailable'));
  button(tree).props.onClick();
  await tick();
  f.unmount();
});

test('unmount stops loading and an old completion cannot reset a new playback', async () => {
  const jobs = [];
  const f = actionFixture(() => {
    let complete;
    const job = { done: new Promise(resolve => { complete = resolve; }), stopped: false, stop() { job.stopped = true; }, complete: () => complete() };
    jobs.push(job);
    return job;
  });
  button(f.render()).props.onClick();
  button(f.render()).props.onClick();
  button(f.render()).props.onClick();
  jobs[0].complete();
  await tick();
  assert.equal(button(f.render()).props['aria-pressed'], true);
  f.unmount();
  assert.equal(jobs[1].stopped, true);
  jobs[1].complete();
  await tick();
});
