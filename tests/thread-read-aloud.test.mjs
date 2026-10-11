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

test('the shared action starts speech and its second click stops playback', async () => {
  const source = readFileSync(new URL('../src/ReadAloudAction.tsx', import.meta.url), 'utf8');
  const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
  const speechSource = readFileSync(new URL('../src/personalSpeech.ts', import.meta.url), 'utf8');
  const speechCompiled = transform(speechSource.replace(/^export /gm, ''), { transforms: ['typescript'] }).code;
  const { getSpeech } = new Function(`${speechCompiled}\nreturn { getSpeech };`)();

  let speaking = false;
  let speechRef;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const action = new Function('React', 'useEffect', 'useRef', 'useState', 'getSpeech', `${compiled}\nreturn ReadAloudAction;`)(
    React,
    () => {},
    initial => (speechRef ??= { current: initial }),
    () => [speaking, value => { speaking = typeof value === 'function' ? value(speaking) : value; }],
    getSpeech,
  );
  const spoken = [];
  let canceled = 0;
  const previousSynth = globalThis.speechSynthesis;
  const previousUtterance = globalThis.SpeechSynthesisUtterance;
  class Utterance { constructor(text) { this.text = text; } }
  globalThis.SpeechSynthesisUtterance = Utterance;
  globalThis.speechSynthesis = { speak: utterance => spoken.push(utterance), cancel: () => { canceled++; }, getVoices: () => [{ name: 'Ava (Enhanced)', lang: 'en-US' }] };

  try {
    const idle = action({ text: 'Read this from the thread.' });
    assert.equal(idle.props['aria-label'], 'Read aloud');
    idle.props.onClick();
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0].text, 'Read this from the thread.');
    assert.equal(spoken[0].voice.name, 'Ava (Enhanced)');

    const active = action({ text: 'Read this from the thread.' });
    assert.equal(active.props['aria-label'], 'Stop reading aloud');
    assert.equal(active.props['aria-pressed'], true);
    active.props.onClick();
    await Promise.resolve();
    assert.equal(canceled, 1);
    assert.equal(speaking, false);
    assert.equal(action({ text: '  ' }), null);
  } finally {
    if (previousSynth === undefined) delete globalThis.speechSynthesis;
    else globalThis.speechSynthesis = previousSynth;
    if (previousUtterance === undefined) delete globalThis.SpeechSynthesisUtterance;
    else globalThis.SpeechSynthesisUtterance = previousUtterance;
  }
});
