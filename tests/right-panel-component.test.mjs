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
const build = (useState) => new Function('React', 'model', 'useRef', 'useState', `const {FIXED, KINDS, openTab, closeTab, activate, moveTab, outsideViewport, tabIndexAt, tabReleaseAction} = model; ${code}; return { RightPanel };`)(React, model, React.useRef, useState).RightPanel;
const RightPanel = build(React.useState);
// The add menu opens on a click, which a static render can't make, so this copy starts with it open.
const RightPanelMenuOpen = build(() => [true, () => {}]);

const render = (state, bodies = {}) => renderToStaticMarkup(React.createElement(RightPanel, { state, onChange() {}, onClose() {}, bodies }));

test('tab strip lists every tab with one shared remove control and no individual close buttons', () => {
  const html = render({ ...model.defaultPanel(), open: true });
  assert.match(html, /role="tablist"/);
  for (const label of ['Dashboard', 'Tasks', 'Details']) assert.match(html, new RegExp(`>${label}<`));
  assert.equal((html.match(/aria-label="Close /g) ?? []).length, 0);
  assert.equal((html.match(/aria-label="Remove selected tool"/g) ?? []).length, 1);
  assert.match(html, /aria-label="Remove selected tool"[^>]*disabled=""/);
  const removable = render({ ...model.defaultPanel(), open: true, active: 'details' });
  assert.match(removable, /aria-label="Remove selected tool" title="Remove Details"[^>]*>−<\/button>/);
  assert.doesNotMatch(removable, /aria-label="Remove selected tool"[^>]*disabled/);
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

test('the expand button sits before the hide button and says what it will do', () => {
  const docked = render({ ...model.defaultPanel(), open: true });
  assert.match(docked, /aria-label="Expand side panel" aria-pressed="false"/);
  assert.ok(docked.indexOf('Expand side panel') < docked.indexOf('Hide side panel'));
  const full = render({ ...model.defaultPanel(), open: true, full: true });
  assert.match(full, /aria-label="Collapse side panel" aria-pressed="true"/);
});

test('the add menu lists Phone', () => {
  const html = renderToStaticMarkup(React.createElement(RightPanelMenuOpen, { state: { ...model.defaultPanel(), open: true }, onChange() {}, onClose() {}, bodies: {} }));
  const menu = html.slice(html.indexOf('role="menu"'));
  assert.match(menu, /role="menuitem"[^>]*><svg[^>]*>.*?<\/svg>Phone</);
});

test('a Phone tab is labelled Phone', () => {
  const html = render({ ...model.openTab(model.defaultPanel(), 'phone', 1), open: true });
  assert.match(html, /aria-label="Phone"/);
  assert.match(html, />Phone</);
});

test('fixed Dashboard and Tasks tabs can drag out; reordering them still refuses', () => {
  const html = render({ ...model.defaultPanel(), open: true });
  // Every tab is a pointer-drag target, fixed ones included: HTML5 drag is gone,
  // whose dragend never delivered a usable release outside the window.
  for (const id of ['dashboard', 'tasks', 'details']) assert.match(html, new RegExp(`data-tab-id="${id}"`));
  assert.doesNotMatch(html, /draggable=/);
  assert.match(source, /onPointerDown/);
  assert.match(source, /setPointerCapture/);
  // A release past the window's edge pops out whichever tab was dragged, fixed included;
  // inside it reorders, and a press that never travelled stays a click.
  assert.equal(model.outsideViewport(-4, 40, 800, 600), true);
  assert.equal(model.outsideViewport(40, 40, 800, 600), false);
  assert.equal(model.tabReleaseAction(true, true), 'popout');
  assert.equal(model.tabReleaseAction(true, false), 'reorder');
  assert.equal(model.tabReleaseAction(false, true), 'click');
  const state = model.defaultPanel();
  assert.deepEqual(model.moveTab(state, 'dashboard', 2), state);
  assert.deepEqual(model.moveTab(state, 'tasks', 2), state);
});

test('a tab release lands on the tab whose center it passed', () => {
  const rects = [{ left: 0, right: 100 }, { left: 100, right: 200 }, { left: 200, right: 300 }];
  assert.equal(model.tabIndexAt(rects, 10), 0);
  assert.equal(model.tabIndexAt(rects, 60), 1);
  assert.equal(model.tabIndexAt(rects, 299), 2);
  assert.equal(model.tabIndexAt([], 10), -1);
});
