import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/assistant-handoff.css';
import { AgentClarification, HandoffPillView, PausedQuestion } from '/src/AssistantHandoff.tsx';
import { classifyPlainHandoffReply, preserveTypedAgentOrder } from '/src/assistantHandoffModel.ts';

const owner = { workspaceId: 'watchdog-test', cwd: '/work/watchdog-test', hostId: 'local', conversationId: 'monitor-1' };
const agents = ['Hyke', 'Muck', 'Null', 'Jigga'];

function task(overrides = {}) {
  return {
    id: 'at-409',
    workspaceId: owner.workspaceId,
    owner,
    destination: { threadId: 'watchdog-qa', workers: ['Hyke'], newThread: false },
    origin: 'human_request',
    originalRequest: 'Run the watchdog steps.',
    brief: 'From the project folder, run tools/step.sh 1 up to 40',
    evidence: [],
    reviewCriteria: [],
    parentThreadId: 'alfred',
    executionThreadId: 'watchdog-qa',
    workers: ['Hyke'],
    attempts: [{ number: 1, runId: 'run-1', status: 'running', startedAtMs: 1, finishedAtMs: null, reviewRevision: null, usage: null }],
    status: 'running',
    result: null,
    revision: 7,
    mode: 'in_place',
    usage: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    ...overrides,
  };
}

const steps = Array.from({ length: 40 }, (_, index) => ({ text: `step ${index + 1}`, status: index < 20 ? 'done' : 'open' }));
const progress = { taskId: 'at-409', runId: 'run-1', todos: steps, latestActivity: 'ran tools/step.sh 21' };

const scenarios = {
  running: { task: task(), progress },
  team: { task: task({ workers: ['Muck', 'Null'], destination: { threadId: 'watchdog-qa', workers: ['Muck', 'Null'], newThread: false } }), progress },
  needs_ok: { task: task({ status: 'proposed', attempts: [] }), progress: undefined },
  needs_you: { task: task({ status: 'needs_you' }), progress },
  failed: { task: task({ status: 'failed', attempts: [{ number: 1, runId: 'run-1', status: 'failed', startedAtMs: 1, finishedAtMs: 2, reviewRevision: null, usage: null }] }), progress },
  queued: { task: task({ status: 'queued', attempts: [] }), progress: undefined },
  stopping: { task: task({ status: 'running', desiredState: 'paused' }), progress },
  stopped: { task: task({ status: 'cancelled' }), progress },
  done: { task: task({ status: 'done' }), progress },
  no_total: { task: task(), progress: { taskId: 'at-409', runId: 'run-1', latestActivity: 'ran tools/step.sh 21' } },
};

function record(type, args) {
  window.calls.push({ type, args });
}

function Harness() {
  const [name, setName] = React.useState('running');
  const [capability, setCapability] = React.useState(true);
  const [offline, setOffline] = React.useState(false);
  const [order, setOrder] = React.useState([]);
  const [firstQuestion, setFirstQuestion] = React.useState(true);
  const [line, setLine] = React.useState('');
  const scenario = scenarios[name] ?? scenarios.running;

  window.setScenario = next => {
    window.calls = [];
    setName(next);
    setOffline(false);
    setCapability(true);
  };
  window.setCapability = on => setCapability(!!on);
  window.setOffline = on => setOffline(!!on);
  window.setFirstQuestion = on => setFirstQuestion(!!on);
  window.setOrder = next => setOrder(next);
  window.applyTyped = text => setOrder(preserveTypedAgentOrder(text, agents));
  window.setComposerLine = text => setLine(text);
  window.classify = classifyPlainHandoffReply;

  const pill = !offline && capability ? (
    <HandoffPillView
      key={name}
      task={scenario.task}
      progress={scenario.progress}
      threadLabel="Watchdog QA"
      onStop={(taskId, revision) => record('stop', [taskId, revision])}
      onRetry={(taskId, revision) => record('retry', [taskId, revision])}
      onOpen={taskId => record('open', [taskId])}
    />
  ) : (
    <p className="assistant-handoff-fallback">
      {offline ? 'Alfred is offline. This task can’t be changed from here.' : 'Handing this to Hyke in Watchdog QA.'}
    </p>
  );

  return (
    <main>
      <div className="assistant-handoff-stage">{pill}</div>
      <div id="composer-line" className="assistant-handoff-composer-line">{line}</div>
      <AgentClarification
        allAgents={agents}
        typedOrder={order}
        questionId="who"
        isFirstQuestion={firstQuestion}
        onOrderChange={setOrder}
        onStart={ordered => record('start', [ordered])}
      />
      <PausedQuestion
        workerName="Hyke"
        questionText="Should I keep going?"
        questionId="q-keep"
        taskRev={7}
        onContinue={(questionId, rev) => record('continue', [questionId, rev])}
        onStop={(questionId, rev) => record('pause-stop', [questionId, rev])}
        onAsk={text => record('ask', [text])}
      />
    </main>
  );
}

window.calls = [];
window.__handoffReady = false;

function settle() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function setValue(el, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

window.runHandoffChecks = async () => {
  const failures = [];
  const check = (name, ok, detail) => { if (!ok) failures.push(detail ? `${name}: ${detail}` : name); };
  const q = selector => document.querySelector(selector);
  const text = selector => q(selector)?.textContent || '';
  const style = el => getComputedStyle(el);
  const pill = () => q('.assistant-handoff-pill');
  const stop = () => q('.assistant-handoff-stop');
  const calls = () => window.calls.map(call => `${call.type}:${JSON.stringify(call.args)}`);
  const use = async name => { window.setScenario(name); await settle(); };

  await use('running');
  check('sentence', text('.assistant-handoff-sentence') === "Handing this to Hyke in Watchdog QA, I'll tell you when it's done.", text('.assistant-handoff-sentence'));
  check('running label', text('.assistant-handoff-pill') === 'Hyke · step 20/40 ▾', text('.assistant-handoff-pill'));
  check('stop name', stop()?.getAttribute('aria-label') === 'Stop Hyke', stop()?.getAttribute('aria-label'));
  check('stop quiet', stop()?.textContent === 'Stop' && !/Esc/.test(stop()?.textContent || ''));
  const before = q('.assistant-handoff-pill-wrap').getBoundingClientRect().width;
  check('stop hidden', style(stop()).opacity === '0' && style(stop()).pointerEvents === 'none', `${style(stop()).opacity} ${style(stop()).pointerEvents}`);
  const hiddenRect = stop().getBoundingClientRect();
  check('hidden stop is not the click target', document.elementFromPoint(hiddenRect.x + hiddenRect.width / 2, hiddenRect.y + hiddenRect.height / 2) !== stop());
  pill().focus();
  await new Promise(resolve => setTimeout(resolve, 180));
  check('focus reveals stop', style(stop()).opacity === '1' && style(stop()).pointerEvents === 'auto', `opacity ${style(stop()).opacity} active ${document.activeElement?.className || ''} within ${q('.assistant-handoff-pill-wrap').matches(':focus-within')}`);
  check('stop height matches pill', Math.abs(stop().getBoundingClientRect().height - pill().getBoundingClientRect().height) < 1);
  check('reveal does not move the wrap', q('.assistant-handoff-pill-wrap').getBoundingClientRect().width === before);
  check('pill is not draggable', pill().draggable !== true);
  stop().click();
  check('stop sends task id and revision', calls().includes('stop:["at-409",7]'), calls().join('|'));

  window.calls = [];
  pill().click();
  await settle();
  check('popover opens', q('.assistant-handoff-popover')?.getAttribute('role') === 'dialog');
  check('popover title', q('.assistant-handoff-popover-head strong')?.textContent === '20 of 40 done');
  check('no handover', !/Hand the rest|Branch|Causal/.test(q('.assistant-handoff-popover').textContent));
  check('view only note', /View-only/.test(q('.assistant-handoff-popover').textContent));
  check('no try again while running', ![...document.querySelectorAll('.assistant-handoff-popover button')].some(button => button.textContent === 'Try again'));
  const cells = [...document.querySelectorAll('.assistant-handoff-cell')];
  check('forty cells', cells.length === 40, String(cells.length));
  cells[34].click();
  await settle();
  check('future step stays queued', /Step 35 · queued/.test(q('.assistant-handoff-step-title')?.textContent || '') && !/lines|done/.test(q('.assistant-handoff-step-title')?.textContent || '') && !/lines/.test(q('.assistant-handoff-step-text')?.textContent || ''), `${q('.assistant-handoff-step-title')?.textContent} / ${q('.assistant-handoff-step-text')?.textContent}`);
  check('inspect does not stop', calls().length === 0, calls().join('|'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  check('escape closes', !q('.assistant-handoff-popover'));
  check('escape does not stop', calls().length === 0);
  pill().click();
  await settle();
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await settle();
  check('outside click closes', !q('.assistant-handoff-popover'));

  const line = q('#composer-line');
  let lineStyle = style(line);
  check('composer line is 24px', lineStyle.height === '24px' && lineStyle.minHeight === '24px', lineStyle.height);
  check('empty composer line stays blank', line.textContent === '' && lineStyle.visibility === 'hidden' && lineStyle.borderLeftWidth === '0px');
  window.setComposerLine('Tell Hyke');
  await settle();
  lineStyle = style(line);
  check('composer line keeps its height', lineStyle.height === '24px' && line.textContent === 'Tell Hyke' && lineStyle.borderLeftWidth === '0px', `${lineStyle.height} ${line.textContent}`);
  window.setComposerLine('');
  await settle();

  await use('team');
  check('team label', text('.assistant-handoff-pill') === 'Muck + Null · 20/40 ▾', text('.assistant-handoff-pill'));
  check('team stop name', stop()?.getAttribute('aria-label') === 'Stop Muck + Null · Muck leads', stop()?.getAttribute('aria-label'));

  await use('needs_ok');
  check('needs ok', text('.assistant-handoff-pill') === 'needs your OK ▾', text('.assistant-handoff-pill'));
  check('needs ok has no stop', !stop());

  await use('needs_you');
  check('needs you', text('.assistant-handoff-pill') === 'Hyke · needs you ▾', text('.assistant-handoff-pill'));
  check('needs you can stop', !!stop());

  await use('failed');
  check('could not start', text('.assistant-handoff-pill') === "Hyke · couldn't start ▾", text('.assistant-handoff-pill'));
  check('failed has no live stop', !stop());
  pill().click();
  await settle();
  check('try again after failure', [...document.querySelectorAll('.assistant-handoff-popover button')].some(button => button.textContent === 'Try again'));
  q('.assistant-handoff-popover button.primary').click();
  check('retry uses current revision', calls().includes('retry:["at-409",7]'), calls().join('|'));

  await use('queued');
  check('queued', text('.assistant-handoff-pill') === 'Hyke · queued ▾', text('.assistant-handoff-pill'));
  await use('stopping');
  check('stopping', text('.assistant-handoff-pill') === 'Hyke · stopping ▾', text('.assistant-handoff-pill'));
  await use('done');
  check('done', text('.assistant-handoff-pill') === 'Hyke · done ▾', text('.assistant-handoff-pill'));
  check('done has no stop', !stop());
  pill().click();
  await settle();
  check('done has no try again', ![...document.querySelectorAll('button')].some(button => button.textContent === 'Try again'));

  await use('no_total');
  check('no total', text('.assistant-handoff-pill') === 'Hyke · working · ran tools/step.sh 21 ▾', text('.assistant-handoff-pill'));
  pill().click();
  await settle();
  check('no invented tape', !q('.assistant-handoff-cell'));
  check('working without a count', q('.assistant-handoff-popover-head strong')?.textContent === 'Working');

  window.setOffline(true);
  await settle();
  check('offline withholds controls', text('.assistant-handoff-fallback') === 'Alfred is offline. This task can’t be changed from here.' && !pill() && !stop());
  window.setCapability(false);
  window.setOffline(false);
  await settle();
  check('older host keeps a plain sentence', text('.assistant-handoff-fallback') === 'Handing this to Hyke in Watchdog QA.' && !pill() && !stop());
  window.setCapability(true);
  await settle();

  const filter = q('[aria-label="Filter agents"]');
  check('no back on the first question', ![...document.querySelectorAll('.assistant-handoff-clarify button')].some(button => button.textContent === 'Back'));
  check('start disabled', q('.assistant-handoff-clarify button.primary').disabled);
  filter.focus();
  setValue(filter, 'Mu');
  await settle();
  const visible = [...document.querySelectorAll('.assistant-handoff-agent-list [role="option"]')].map(row => row.textContent);
  check('filter finds Muck', visible.length === 1 && visible[0].includes('Muck'), visible.join(','));
  filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  check('enter ticks the highlighted agent', q('.assistant-handoff-preview')?.textContent === 'Muck · Muck leads', q('.assistant-handoff-preview')?.textContent);
  check('enter does not start', !calls().some(call => call.startsWith('start:')));
  setValue(filter, '');
  await settle();
  filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await settle();
  filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await settle();
  const highlighted = q('.assistant-handoff-agent-list .is-highlighted')?.textContent || '';
  filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
  check('second tick keeps typed order', q('.assistant-handoff-preview')?.textContent === 'Muck + Null · Muck leads', `${q('.assistant-handoff-preview')?.textContent} highlight ${highlighted}`);
  check('lead badge', [...document.querySelectorAll('.assistant-handoff-lead')].some(node => node.textContent === '· leads'));
  filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  await settle();
  check('command enter starts', calls().includes('start:[["Muck","Null"]]'), calls().join('|'));

  window.setOrder([]);
  window.calls = [];
  await settle();
  const boxes = [...document.querySelectorAll('.assistant-handoff-agent-list input')];
  boxes[1].click();
  boxes[0].click();
  await settle();
  check('checkbox order is selection order', q('.assistant-handoff-preview')?.textContent === 'Muck + Hyke · Muck leads', q('.assistant-handoff-preview')?.textContent);
  window.applyTyped('Hyke and Muck');
  await settle();
  check('typed names keep left to right order', q('.assistant-handoff-preview')?.textContent === 'Hyke + Muck · Hyke leads', q('.assistant-handoff-preview')?.textContent);
  window.setFirstQuestion(false);
  await settle();
  check('later question has back', [...document.querySelectorAll('.assistant-handoff-clarify button')].some(button => button.textContent === 'Back'));

  const paused = q('.assistant-handoff-paused input');
  const send = async (value, init) => {
    window.calls = [];
    setValue(paused, value);
    await settle();
    paused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }));
    await settle();
  };
  check('paused prompt', text('.assistant-handoff-paused-head') === 'Waiting for you · Hyke: Should I keep going?');
  await send('No, wait for me');
  check('wait stays paused', calls().join('|') === 'ask:["No, wait for me"]', calls().join('|'));
  await send('What did step 12 do?');
  check('question stays paused', calls().join('|') === 'ask:["What did step 12 do?"]', calls().join('|'));
  await send('hmm');
  check('unclear stays paused', calls().join('|') === 'ask:["hmm"]');
  await send("Don't give it to Muck");
  check('negation does not redirect', calls().join('|') === 'ask:["Don\'t give it to Muck"]', calls().join('|'));
  await send("Also check stderr and don't stop on warnings");
  check('stop inside a note does not stop', calls()[0]?.startsWith('ask:'), calls().join('|'));
  await send('stop?');
  check('stop question is not a stop', calls()[0]?.startsWith('ask:'));
  window.calls = [];
  setValue(paused, 'keep going');
  paused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  await settle();
  check('shift enter stays in the draft', calls().length === 0 && paused.value === 'keep going');
  await send('keep going');
  check('clear yes continues', calls().join('|') === 'continue:["q-keep",7]', calls().join('|'));
  await send('cancel that');
  check('clear stop stops', calls().join('|') === 'pause-stop:["q-keep",7]', calls().join('|'));
  window.calls = [];
  [...document.querySelectorAll('.assistant-handoff-paused-actions button')].find(button => button.textContent === 'Keep going').click();
  [...document.querySelectorAll('.assistant-handoff-paused-actions button')].find(button => button.textContent === 'Stop here').click();
  check('paused buttons are explicit', calls().join('|') === 'continue:["q-keep",7]|pause-stop:["q-keep",7]', calls().join('|'));
  return failures;
};

createRoot(document.getElementById('root')).render(<Harness />);
requestAnimationFrame(() => { window.__handoffReady = true; });
