import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'sucrase';
const source = await fs.readFile(new URL('../src/RightWorktrees.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replace(/export function/g, 'function'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const { WorktreeRow } = new Function('React', 'useEffect', 'useRef', 'useState', code + '; return { WorktreeRow };')(React, React.useEffect, React.useRef, React.useState);
const noop = () => {};
const row = (state) => React.createElement(WorktreeRow, { item: {path:'/copy/work', head:'123456789', branch:null, main:false, locked:true, prunable:false, changes:3, task:false, copy:{bot:'Forge',thread:'thread-1',threadTitle:'Fix search',state,reason:state === 'needs_you' ? 'Check failed' : null}}, busy:false,confirm:false,onOpen:noop,onCopy:noop,onMount:noop,onRemove:noop,onPrune:noop,onCancel:noop });
test('bot copy row shows owner thread and needs-you chip', () => {
 const html=renderToStaticMarkup(row('needs_you'));
 for(const text of ["Forge&#x27;s copy",'Fix search','3 changed files','Needs you','Check failed','Discard copy']) assert.ok(html.includes(text),text);
 assert.doesNotMatch(html, />Mount<|>Prune<|>Remove</);
 assert.doesNotMatch(html, /disabled=""[^>]*>Discard copy</);
});
test('active bot copies offer no discard or mount controls', () => {
 for(const state of ['working','folding','reconciling']) {
  const html=renderToStaticMarkup(row(state));
  assert.doesNotMatch(html, /Discard copy|>Mount<|>Prune<|>Remove</);
 }
});

test('copy row falls back to its thread id when no title is saved', () => {
 const element = row('working');
 const item = {...element.props.item, copy: {...element.props.item.copy, threadTitle: ''}};
 const html = renderToStaticMarkup(React.cloneElement(element, {item}));
 assert.ok(html.includes('thread-1'));
 assert.ok(!html.includes('undefined'));
});
