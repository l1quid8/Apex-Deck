// tests/right-panel-component.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'sucrase';
import * as model from '../src/rightPanelModel.ts';

const source = await fs.readFile(new URL('../src/RightPanel.tsx', import.meta.url), 'utf8');
const code = transform(source.replace(/^import .*;\n/gm, '').replace(/export (function|const)/g, '$1'), { transforms: ['typescript', 'jsx'], jsxRuntime: 'classic' }).code;
const { RightPanel } = new Function('React', 'model', 'useRef', 'useState', `const {FIXED, KINDS, openTab, closeTab, activate, moveTab} = model; ${code}; return { RightPanel };`)(React, model, React.useRef, React.useState);

const render = (state, bodies = {}) => renderToStaticMarkup(React.createElement(RightPanel, { state, onChange() {}, onClose() {}, bodies }));

test('tab strip lists every tab; only non-fixed tabs have a close button', () => {
  const html = render({ ...model.defaultPanel(), open: true });
  assert.match(html, /role="tablist"/);
  for (const label of ['Dashboard', 'Tasks', 'Details']) assert.match(html, new RegExp(`>${label}<`));
  assert.equal((html.match(/aria-label="Close /g) ?? []).length, 1);
});

test('only the active tab body is shown, others stay mounted but hidden', () => {
  const s = { ...model.defaultPanel(), open: true, active: 'tasks' };
  const html = render(s, { dashboard: (_t, v) => `dash:${v}`, tasks: (_t, v) => `tasks:${v}` });
  assert.match(html, /dash:false/);
  assert.match(html, /tasks:true/);
});

test('details tab without a thread says so', () => {
  const s = { ...model.defaultPanel(), open: true, active: 'details' };
  const html = render(s, {});
  assert.match(html, /Open a thread to see its details\./);
});
