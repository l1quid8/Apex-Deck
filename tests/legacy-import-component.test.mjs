import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import * as model from '../src/legacyImportModel.ts';

// The screen is rendered through the same sucrase harness the other component tests
// use, so this exercises the real JSX and the real model functions.
const source = readFileSync(new URL('../src/LegacyImportScreen.tsx', import.meta.url), 'utf8');
// Import *declarations* here span several lines, so strip them as a whole rather than
// line by line. Everything imported is passed into the Function scope below.
const code = transform(source.replace(/^import\s+[\s\S]*?;\n/gm, '').replaceAll('export ', ''), {
  transforms: ['typescript', 'jsx'], jsxRuntime: 'classic',
}).code;

const hash = (seed) => (seed.repeat(64)).slice(0, 64);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function ledger(name, overrides = {}) {
  return {
    ledger: name, sourcePath: `/data/${name}`, size: 4096, sha256: hash('a'), state: 'ready', reason: '',
    counts: { records: 2, importable: 2, notImported: 0 }, records: [], problems: [], ...overrides,
  };
}
const taskRow = {
  id: 'legacy-3', kind: 'task', title: 'Sort the invoices', originalStatus: 'queued', importStatus: 'interrupted',
  reason: 'It will not run until you start it again.',
};
const ruleRow = {
  id: 'legacy-r1', kind: 'rule', title: 'Always allow shell', originalStatus: 'approved', importStatus: 'skipped',
  reason: 'Rules are not carried over, so this asks you again.',
};
const snapshot = { id: '20261022-204152', path: '/data/legacy-import/20261022-204152', createdAtMs: 1792700000000, reused: false };

function harness({ previewDoc, result, applyError } = {}) {
  const states = []; const refs = []; const effects = []; let cursor = 0;
  const applies = []; const previewCalls = [];
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  };
  const useState = (initial) => {
    const i = cursor++;
    if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
    return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
  };
  const useRef = (value) => { const i = cursor++; if (!(i in refs)) refs[i] = { current: value }; return refs[i]; };
  const useEffect = (fn) => { effects.push(fn); };
  const api = {
    unavailable: () => undefined,
    preview: async () => { previewCalls.push(1); return structuredClone(previewDoc); },
    apply: async (shown, ledgers) => { applies.push({ shown, ledgers }); if (applyError) throw applyError; return structuredClone(result); },
    history: async () => { throw new Error('not used here'); },
  };
  const built = new Function('React', 'useState', 'useEffect', 'useRef', ...Object.keys(model), 'createLegacyImportClient',
    `${code}; return { LegacyImportScreen, LegacyImportPanel, LegacyBadge, legacyImportFor };`)(
    React, useState, useEffect, useRef, ...Object.values(model), () => api);
  return {
    api, applies, previewCalls, built,
    render(props = {}) {
      cursor = 0;
      const before = effects.length;
      const tree = built.LegacyImportScreen({ api, onClose: props.onClose ?? (() => {}), onImported: props.onImported ?? (() => {}) });
      for (const fn of effects.slice(before)) fn();
      return tree;
    },
    renderPanel(props = {}) {
      cursor = 0;
      const before = effects.length;
      const tree = built.LegacyImportPanel({ backend: { supports: () => true, call: async () => previewDoc, dataFolder: async () => '/data' }, ...props });
      for (const fn of effects.slice(before)) fn();
      return tree;
    },
  };
}

const findAll = (node, predicate, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
};
const text = (node) => {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.children);
};
const button = (tree, label) => findAll(tree, (n) => n.type === 'button' && (text(n) === label || n.props['aria-label'] === label))[0];

function previewWith(records = [taskRow]) {
  return { snapshot, ledgers: [ledger('assistant-tasks-v1.json', { records, counts: { records: records.length, importable: 1, notImported: records.length - 1 } })] };
}

test('the preview names what each record becomes and why', async () => {
  const h = harness({ previewDoc: previewWith([taskRow, ruleRow]) });
  h.render(); await tick();
  const tree = h.render();
  const shown = text(tree);
  assert.match(shown, /queued → stopped/);
  assert.match(shown, /It will not run until you start it again\./);
  assert.match(shown, /approved → not imported/);
  assert.match(shown, /Rules are not carried over/);
  assert.match(shown, /Sort the invoices/);
  // Counts and the source fingerprint, so a person can compare what they see.
  assert.match(shown, /1 record\)? to import|1 record/);
  assert.match(shown, /\/data\/assistant-tasks-v1\.json/);
  assert.match(shown, /4\.0 KB/);
  // The confirm action counts records, not files.
  assert.ok(button(tree, 'Import 1 record'), 'one explicit confirm action');
});

test('confirm imports exactly the hashes the preview showed', async () => {
  const previewDoc = previewWith();
  const h = harness({ previewDoc, result: { snapshot: snapshot.id, complete: true, ledgers: [{ ledger: 'assistant-tasks-v1.json', state: 'imported', imported: 1, skipped: 0, verified: false }] } });
  h.render(); await tick();
  const tree = h.render();
  assert.equal(h.applies.length, 0, 'nothing is applied before the person asks');
  button(tree, 'Import 1 record').props.onClick();
  await tick();
  assert.equal(h.applies.length, 1);
  assert.deepEqual(h.applies[0].ledgers, ['assistant-tasks-v1.json']);
  assert.deepEqual(h.applies[0].shown, previewDoc, 'the apply is bound to the preview that was on screen');
});

test('a changed file asks for review again and never imports twice', async () => {
  const h = harness({
    previewDoc: previewWith(),
    applyError: Object.assign(new Error('Review again.'), { code: 'LEGACY_IMPORT_PREVIEW_CHANGED' }),
  });
  h.render(); await tick();
  const tree = h.render();
  const previewsBefore = h.previewCalls.length;
  button(tree, 'Import 1 record').props.onClick();
  await tick();
  const after = h.render();
  const shown = text(after);
  assert.equal(h.applies.length, 1, 'exactly one apply, never a retry');
  assert.match(shown, /Your old files changed since this preview — review again\./);
  assert.ok(!/broker|ledger|provenance|snapshot/i.test(shown), 'no internals in the review-again text');
  assert.ok(h.previewCalls.length > previewsBefore, 'the preview is read again');
  // A second render and another tick must not import on their own.
  await tick();
  h.render();
  await tick();
  assert.equal(h.applies.length, 1, 'no second apply without a person asking');
});

test('the result lists what came in and what stayed behind, marked unverified', async () => {
  const h = harness({
    previewDoc: previewWith(),
    result: {
      snapshot: snapshot.id, complete: true,
      ledgers: [
        { ledger: 'assistant-tasks-v1.json', state: 'imported', imported: 2, skipped: 1, skippedIds: ['legacy-9'], verified: false },
        { ledger: 'room-authority-v1.json', state: 'failed', imported: 0, skipped: 0, verified: false, error: 'The broker refused the write.' },
      ],
    },
  });
  h.render(); await tick();
  button(h.render(), 'Import 1 record').props.onClick();
  await tick();
  const shown = text(h.render());
  assert.match(shown, /Imported 2 records, 1 left behind, 1 file failed\./);
  assert.match(shown, /Tasks/);
  assert.match(shown, /Group chats/);
  assert.match(shown, /legacy-9/);
  assert.equal(text(h.built.LegacyBadge({})), 'Imported · unverified', 'the marker says unverified');
  assert.ok(findAll(h.render(), (n) => n.type === h.built.LegacyBadge).length > 0, 'the result shows the marker');
  assert.ok(!/broker/i.test(shown), 'a failed file reason is shown without internals');
  assert.ok(!/the the/i.test(shown), 'the scrubbed text still reads as a sentence');
  assert.ok(button(h.render(), 'Done'), 'the result closes back to the app');
});

test('an empty preview offers no import action', async () => {
  const h = harness({ previewDoc: { snapshot, ledgers: [ledger('assistant-tasks-v1.json', { state: 'imported', counts: { records: 2, importable: 0, notImported: 2 } })] } });
  h.render(); await tick();
  const tree = h.render();
  assert.equal(findAll(tree, (n) => n.type === 'button' && /^Import /.test(text(n))).length, 0);
  assert.match(text(tree), /2 stay behind/);
});

test('the notice appears for new records, stays dismissed, and returns when the files change', async () => {
  const written = [];
  const store = { read: () => written[0] ?? null, write: (key) => { written[0] = key; } };
  const h = harness({ previewDoc: previewWith() });
  const first = h.renderPanel({ store });
  await tick();
  const shown = h.renderPanel({ store });
  assert.match(text(shown), /Older records found/);
  button(shown, 'Dismiss until my saved files change').props.onClick();
  const hidden = h.renderPanel({ store });
  assert.equal(text(hidden), '', 'a dismissal hides the notice for these files');
  assert.equal(written.length, 1, 'the dismissal is remembered against the files seen');

  // Same content, dismissed: still hidden.
  assert.equal(text(h.renderPanel({ store })), '');

  // Changed files: a different key, so the notice comes back on its own.
  const newer = { snapshot, ledgers: [ledger('assistant-tasks-v1.json', { sha256: hash('b'), records: [taskRow], counts: { records: 1, importable: 1, notImported: 0 } })] };
  const changed = harness({ previewDoc: newer });
  changed.renderPanel({ store });
  await tick();
  const back = changed.renderPanel({ store });
  assert.notEqual(model.noticeKey('/data', newer), written[0], 'new content is a new question');
  assert.match(text(back), /Older records found/);
});
