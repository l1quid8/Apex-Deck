import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transform } from 'sucrase';
import { videoType } from '../src/attachments.ts';

const source = fs.readFileSync(new URL('../src/AttachedImages.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), {
  transforms: ['typescript', 'jsx'], jsxRuntime: 'classic',
}).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };

function mount(kind, props) {
  let state = null;
  let cleanup;
  let started = false;
  const component = new Function('React', 'useState', 'useEffect', 'videoType', `${compiled}\nreturn ${kind};`)(
    React,
    () => [state, value => { state = value; }],
    effect => { if (!started) { started = true; cleanup = effect(); } },
    videoType,
  );
  return { render: () => component(props), unmount: () => cleanup?.() };
}

for (const [kind, extension, event] of [['Picture', 'png', 'onLoad'], ['Video', 'mp4', 'onLoadedMetadata']]) {
  test(`${kind} settles the transcript after its displayed size becomes known`, async () => {
    // Sending settles before the file read finishes. Loading media later grows
    // scrollHeight without changing the transcript's observed clientHeight.
    const scroll = { scrollTop: 200, clientHeight: 400, scrollHeight: 600 };
    let finishRead;
    const h = mount(kind, {
      path: `/attachments/shot.${extension}`,
      read: () => new Promise(resolve => { finishRead = resolve; }),
      onOpen() {},
      onLoad: () => { scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight; },
    });
    try {
      assert.equal(h.render(), null);
      finishRead(new Uint8Array([1, 2, 3]).buffer);
      await new Promise(resolve => setImmediate(resolve));
      const media = h.render().children[0];
      scroll.scrollHeight = 920;
      media.props[event]?.();
      assert.equal(scroll.scrollTop, 520, 'the latest message stays visible after media loads');
    } finally { h.unmount(); }
  });
}
