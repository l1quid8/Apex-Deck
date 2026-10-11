import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transform } from 'sucrase';
import { videoType } from '../src/attachments.ts';
import { guardHostWrites } from '../src/hostBackends.ts';
import { hostConnectionStore } from '../src/hostConnections.ts';

const source = fs.readFileSync(new URL('../src/AttachedImages.tsx', import.meta.url), 'utf8');
const compiled = transform(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), {
  transforms: ['typescript', 'jsx'], jsxRuntime: 'classic',
}).code;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) };

function mount(kind, props) {
  let state = null;
  let cleanup;
  let previousDeps;
  const component = new Function('React', 'useState', 'useEffect', 'videoType', `${compiled}\nreturn ${kind};`)(
    React,
    () => [state, value => { state = value; }],
    (effect, deps) => {
      if (!previousDeps || deps.some((value, i) => !Object.is(value, previousDeps[i]))) {
        cleanup?.();
        previousDeps = deps;
        cleanup = effect();
      }
    },
    videoType,
  );
  return { render: (updates = {}) => { Object.assign(props, updates); return component(props); }, unmount: () => cleanup?.() };
}

for (const [kind, extension, event] of [['Picture', 'png', 'onLoad'], ['Video', 'mp4', 'onLoadedMetadata']]) {
  test(`${kind} keeps its displayed media URL usable through chat rerenders`, async () => {
    let reads = 0;
    const backend = guardHostWrites({ readAttachment: async () => { reads++; return new Uint8Array([1, 2, 3]).buffer; } }, hostConnectionStore('local', 'Mac'));
    const h = mount(kind, { path: `/attachments/shot.${extension}`, read: backend.readAttachment, onOpen() {} });
    let url;
    try {
      h.render();
      await new Promise(resolve => setImmediate(resolve));
      url = h.render().children[0].props.src;
      for (let i = 0; i < 10; i++) {
        const media = h.render({ read: backend.readAttachment }).children[0];
        assert.equal(media.props.src, url);
        assert.deepEqual([...new Uint8Array(await (await fetch(media.props.src)).arrayBuffer())], [1, 2, 3]);
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(reads, 1, 'chat updates must not reread the attachment');
    } finally { h.unmount(); }
    await assert.rejects(fetch(url), 'unmount still releases the media URL');
  });
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
