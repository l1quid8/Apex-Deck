import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'sucrase';
import * as model from '../src/legacyImportModel.ts';
import { LEGACY_IMPORT_CAPABILITY } from '../src/legacyImport.ts';
import { announceImport, forgetImportListeners, subscribeToImports } from '../src/legacyImportRefresh.ts';

// The screen is rendered through the same sucrase harness the other component tests
// use, so this exercises the real JSX and the real model functions.
const source = readFileSync(new URL('../src/LegacyImportScreen.tsx', import.meta.url), 'utf8');
// Import *declarations* here span several lines, so strip them as a whole rather than
// line by line. Everything imported is passed into the Function scope below.
const code = transform(source.replace(/^import\s+[\s\S]*?;\n/gm, '').replaceAll('export ', ''), {
  transforms: ['typescript', 'jsx'], jsxRuntime: 'classic',
}).code;

const refresh = await import('../src/legacyImportRefresh.ts');
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

function harness({ previewDoc, result, applyError, nextPreviews, routePreviews } = {}) {
  const states = []; const refs = []; const effectSlots = []; let cursor = 0; let prefix = 'screen';
  const applies = []; const previewCalls = []; const queued = nextPreviews ? [...nextPreviews] : [];
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  };
  const useState = (initial) => {
    const i = `${prefix}:${cursor++}`;
    if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
    return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
  };
  const useRef = (value) => { const i = `${prefix}:${cursor++}`; if (!(i in refs)) refs[i] = { current: value }; return refs[i]; };
  // Dependency arrays are modelled, because the lifecycle findings are about *when*
  // an effect runs: a harness that re-ran every effect on every render would report
  // a passing cache that never actually caches. Cleanups are not run (the components
  // here only flag liveness), but unchanged deps skip the effect exactly as React does.
  const useEffect = (fn, deps) => {
    const i = `${prefix}:${cursor++}`;
    const previous = effectSlots[i];
    const same = previous && Array.isArray(deps) && previous.deps
      && previous.deps.length === deps.length && deps.every((value, index) => Object.is(value, previous.deps[index]));
    if (same) return;
    effectSlots[i] = { deps: Array.isArray(deps) ? [...deps] : null };
    queued_effects.push(fn);
  };
  let queued_effects = [];
  const makeApi = (route) => ({
    unavailable: () => (route.supports && !route.supports(LEGACY_IMPORT_CAPABILITY) ? 'This service cannot import yet.' : undefined),
    preview: async () => {
      previewCalls.push(1);
      if (route.__preview) return await route.__preview();
      const thunk = queued.shift();
      return thunk ? await thunk() : structuredClone(previewDoc);
    },
    apply: async (shown, ledgers) => { applies.push({ shown, ledgers }); if (applyError) throw applyError; return structuredClone(result); },
    history: async () => { throw new Error('not used here'); },
  });
  const backend = { supports: () => true, call: async () => previewDoc, dataFolder: async () => '/data' };
  // Explicit per-call previews for the default backend, for flows where the *number*
  // of reads matters (a reload after a stale refusal, then a failure).
  if (routePreviews) {
    backend.__preview = () => {
      const step = routePreviews.shift();
      return step ? step() : Promise.resolve(structuredClone(previewDoc));
    };
  }
  const api = makeApi(backend);
  const createLegacyImportClient = (options) => makeApi(options.route);
  const built = new Function('React', 'useState', 'useEffect', 'useRef', ...Object.keys(model), ...Object.keys(refresh),
    'createLegacyImportClient',
    `${code}; return { LegacyImportScreen, LegacyImportPanel, LegacyBadge, legacyImportFor, previewOnce, PREVIEW_TTL_MS };`)(
    React, useState, useEffect, useRef, ...Object.values(model), ...Object.values(refresh), createLegacyImportClient);
  const run = (render) => {
    cursor = 0;
    queued_effects = [];
    const tree = render();
    for (const fn of queued_effects) fn();
    return tree;
  };
  return {
    api, applies, previewCalls, built, backend,
    render(props = {}) {
      prefix = 'screen';
      return run(() => built.LegacyImportScreen({ api, onClose: props.onClose ?? (() => {}), onImported: props.onImported ?? (() => {}) }));
    },
    renderPanel(props = {}) {
      prefix = 'panel';
      return run(() => built.LegacyImportPanel({ backend, ...props }));
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

// --- Item 4: the confirmation while a stale preview reloads -------------------

const staleError = () => Object.assign(new Error('Your old files changed since this preview — review again.'), { code: 'LEGACY_IMPORT_PREVIEW_CHANGED' });

test('a stale preview clears the confirmation until the new read answers', async () => {
  let release;
  const reloading = new Promise((resolve) => { release = resolve; });
  const h = harness({
    previewDoc: previewWith(), applyError: staleError(),
    routePreviews: [() => Promise.resolve(structuredClone(previewWith())), () => reloading],
  });
  h.render(); await tick();
  button(h.render(), 'Import 1 record').props.onClick();
  await tick();

  const waiting = h.render();
  assert.equal(findAll(waiting, (n) => n.type === 'button' && /^Import /.test(text(n))).length, 0,
    'no confirm sits on a preview known to be wrong');
  assert.match(text(waiting), /Your files changed\. Reading them again…/);
  assert.match(text(waiting), /review again/);

  release(structuredClone(previewWith([{ ...taskRow, id: 'legacy-4' }])));
  await tick();
  const ready = h.render();
  assert.ok(button(ready, 'Import 1 record'), 'the confirm returns only after the new preview answers');
  assert.equal(h.applies.length, 1, 'the failure never re-applies');
});

test('a stale reload that fails keeps the confirmation unavailable', async () => {
  const h = harness({
    previewDoc: previewWith(), applyError: staleError(),
    routePreviews: [() => Promise.resolve(structuredClone(previewWith())),
      () => Promise.reject(new Error('The saved copy could not be read.'))],
  });
  h.render(); await tick();
  button(h.render(), 'Import 1 record').props.onClick();
  await tick();
  const failed = h.render();
  assert.equal(findAll(failed, (n) => n.type === 'button' && /^Import /.test(text(n))).length, 0,
    'a failed re-read does not bring the button back');
  assert.match(text(failed), /could not be read/);
  await tick();
  h.render();
  assert.equal(h.applies.length, 1, 'still never a second apply');
});

// --- Item 6: preview lifecycle ----------------------------------------------

test('a different backend is read again and does not inherit the old folder', async () => {
  const h = harness({ previewDoc: previewWith() });
  const store = { read: () => null, write: () => {} };
  h.renderPanel({ store }); await tick();
  assert.match(text(h.renderPanel({ store })), /Older records found/);
  const reads = h.previewCalls.length;

  const other = { supports: () => true, call: async () => ({}), dataFolder: async () => '/other', __preview: async () => ({ snapshot: null, ledgers: [] }) };
  const swapped = h.renderPanel({ store, backend: other });
  await tick();
  assert.ok(h.previewCalls.length > reads, 'the new backend is read, not the cached one');
  assert.ok(swapped, 'the swapped render happens before effects run, as in React');
  assert.equal(text(h.renderPanel({ store, backend: other })), '', 'nothing to import on the other backend');
});

test('an import anywhere refreshes the notice everywhere', async () => {
  forgetImportListeners();
  const store = { read: () => null, write: () => {} };
  const imported = { snapshot, ledgers: [ledger('assistant-tasks-v1.json', { state: 'imported', counts: { records: 1, importable: 0, notImported: 1 } })] };
  let importedAlready = false;
  const route = { supports: () => true, call: async () => ({}), dataFolder: async () => '/data',
    __preview: async () => structuredClone(importedAlready ? imported : previewWith()) };
  const watcher = harness({ previewDoc: previewWith() });
  watcher.renderPanel({ store, backend: route }); await tick();
  assert.match(text(watcher.renderPanel({ store, backend: route })), /Older records found/);

  importedAlready = true;
  announceImport();
  await tick();
  assert.equal(text(watcher.renderPanel({ store, backend: route })), '', 'the notice goes when the host no longer offers records');
  forgetImportListeners();
});

test('a service that cannot import yet is not hidden forever', () => {
  const h = harness({ previewDoc: previewWith() });
  let supported = false;
  const backend = { supports: () => supported, call: async () => ({}), dataFolder: async () => '/data' };
  assert.equal(h.built.legacyImportFor(backend), undefined);
  supported = true;
  assert.ok(h.built.legacyImportFor(backend), 'a later yes is not masked by the earlier no');
});

test('a shared preview expires and is not remembered when it failed', async () => {
  const h = harness({ previewDoc: previewWith(), nextPreviews: [() => Promise.reject(new Error('nope'))] });
  const first = h.built.previewOnce(h.api, 1000);
  await first.catch(() => {});
  const second = h.built.previewOnce(h.api, 1001);
  assert.notEqual(first, second, 'a failed read is retried even inside the window');

  const base = 1001 + h.built.PREVIEW_TTL_MS + 10;
  const third = h.built.previewOnce(h.api, base);
  const fourth = h.built.previewOnce(h.api, base + h.built.PREVIEW_TTL_MS - 1);
  assert.equal(third, fourth, 'inside the window the same read is shared');
  const fifth = h.built.previewOnce(h.api, base + h.built.PREVIEW_TTL_MS + 1);
  assert.notEqual(third, fifth, 'past the window the files are read again');
  await fifth.catch(() => {});
});
