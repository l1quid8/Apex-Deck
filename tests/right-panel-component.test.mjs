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
const build = (useState) => new Function('React', 'model', 'useRef', 'useState', 'useEffect', 'useLayoutEffect', `const {FIXED, KINDS, TAB_GAP, openTab, closeTab, activate, fitTabs, moveTab, outsideViewport, tabIndexAt, tabReleaseAction} = model; ${code}; return { RightPanel };`)(React, model, React.useRef, useState, React.useEffect, React.useLayoutEffect).RightPanel;
const RightPanel = build(React.useState);
// The ⋯ menu and its Add tool list open on clicks, which a static render can't make, so this copy starts with both open.
const RightPanelMenuOpen = build((initial) => typeof initial === 'boolean' ? [true, () => {}] : React.useState(initial));
const renderMenu = (state) => {
  const html = renderToStaticMarkup(React.createElement(RightPanelMenuOpen, { state, onChange() {}, onClose() {}, onFull() {}, bodies: {} }));
  return html.slice(html.indexOf('role="menu"'));
};

const render = (state, bodies = {}) => renderToStaticMarkup(React.createElement(RightPanel, { state, onChange() {}, onClose() {}, bodies }));

test('tab strip lists every tab with only ⋯ and × beside it, and no per-tab close buttons', () => {
  const html = render({ ...model.defaultPanel(), open: true });
  assert.match(html, /role="tablist"/);
  for (const label of ['Dashboard', 'Tasks', 'Details']) assert.match(html, new RegExp(`>${label}<`));
  assert.equal((html.match(/aria-label="Close /g) ?? []).length, 0);
  const controls = html.slice(html.indexOf('right-panel-ctl'), html.indexOf('right-panel-name'));
  assert.deepEqual([...controls.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]), ['⋯', '×']);
  assert.match(controls, /aria-label="Sidebar options"[^>]*aria-haspopup="menu" aria-expanded="false"/);
  assert.match(controls, /aria-label="Hide side panel"/);
  assert.doesNotMatch(html, /role="menu"/);
});

test('⋯ holds Add tool, Remove the open tool, and Expand; Remove is off for permanent tools', () => {
  const fixed = renderMenu({ ...model.defaultPanel(), open: true });
  assert.match(fixed, /aria-expanded="true"[^>]*>.*?Add tool/);
  assert.match(fixed, /disabled=""[^>]*title="Dashboard is a permanent tool"[^>]*>.*?Remove Dashboard</);
  assert.match(fixed, />Expand</);
  const removable = renderMenu({ ...model.defaultPanel(), open: true, active: 'details' });
  assert.match(removable, /Remove Details/);
  assert.doesNotMatch(removable, /disabled=""[^>]*>.*?Remove Details/);
  assert.match(renderMenu({ ...model.defaultPanel(), open: true, full: true }), />Collapse</);
});

test('Add tool starts collapsed each time ⋯ opens', () => {
  assert.match(source, /const toggleMenu = \(\) => \{ setAddOpen\(false\);/);
});

test('names never ellipsize: the strip clips and each tab shows a full name or an icon', async () => {
  const css = await fs.readFile(new URL('../src/right-panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.right-panel-tab-label \{ white-space: nowrap; \}/);
  assert.match(css, /\.right-panel-tabs \{[^}]*overflow: hidden;/);
  assert.match(css, /\.right-panel\[data-fit="mid"\] \.right-panel-tab:not\(\.active\) \.right-panel-tab-label/);
  assert.match(css, /\.right-panel\[data-fit="icons"\] \.right-panel-name \{ display: block; \}/);
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

test('the add menu lists Phone', () => {
  assert.match(renderMenu({ ...model.defaultPanel(), open: true }), /role="menuitem" class="indent"><span class="right-panel-menu-glyph"><svg[^>]*>.*?<\/svg><\/span>Phone</);
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
