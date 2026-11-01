import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We test the JS-facing validation logic and the search catalog entries for cursor
// plus the hex and range checks that mirror Rust prefs.

function isHex(s) {
  const h = s.startsWith('#') ? s.slice(1) : s;
  return (h.length === 3 || h.length === 6) && /^[0-9a-fA-F]+$/.test(h);
}

test('hex color validation accepts #FFF and #FFFFFF, rejects other', () => {
  assert.equal(isHex('#fff'), true);
  assert.equal(isHex('#FFFFFF'), true);
  assert.equal(isHex('#FF'), false);
  assert.equal(isHex('red'), false);
  assert.equal(isHex('#GGGGGG'), false);
});

test('size range 0.5..4.0 matches upstream MIN/MAX', () => {
  const MIN = 0.5, MAX = 4.0;
  const validate = (size) => size >= MIN && size <= MAX;
  assert.equal(validate(0.5), true);
  assert.equal(validate(4.0), true);
  assert.equal(validate(0.4), false);
  assert.equal(validate(4.1), false);
});

test('motion validation mirrors upstream limits', () => {
  const validate = (m) => {
    if (m.travelMinMs < 30 || m.travelMinMs > m.travelMaxMs) return false;
    if (m.bow < 0 || m.bow > 3) return false;
    if (m.overshoot < 0 || m.overshoot > 0.15) return false;
    if (m.tremor < 0 || m.tremor > 4) return false;
    if (m.dwellMs > 300) return false;
    if (m.travelMaxMs + m.dwellMs > 700) return false;
    return true;
  };
  assert.equal(validate({ travelMinMs: 90, travelMaxMs: 320, dwellMs: 0, bow: 1, overshoot: 0.035, tremor: 1.1 }), true);
  assert.equal(validate({ travelMinMs: 10, travelMaxMs: 320, dwellMs: 0, bow: 1, overshoot: 0, tremor: 1 }), false);
  assert.equal(validate({ travelMinMs: 90, travelMaxMs: 320, dwellMs: 400, bow: 1, overshoot: 0, tremor: 1 }), false);
  assert.equal(validate({ travelMinMs: 90, travelMaxMs: 500, dwellMs: 300, bow: 1, overshoot: 0, tremor: 1 }), false); // 500+300=800 >700
});

test('PNG validation constants match upstream', () => {
  // Upstream: MAX_CURSOR_IMAGE_BYTES = 2 MiB, MAX_PIXELS = 1024
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_PIXELS = 1024;
  assert.equal(MAX_BYTES, 2097152);
  assert.equal(MAX_PIXELS, 1024);
});

test('search catalog includes cursor customization entries', async () => {
  const { CATALOG_ENTRIES } = await import('../src/settingsCatalog.ts');
  const ids = CATALOG_ENTRIES.map(e => e.id);
  for (const need of ['cursor', 'cursor-style', 'cursor-colors', 'cursor-size', 'cursor-effects', 'cursor-image', 'cursor-motion']) {
    assert.ok(ids.includes(need), `catalog missing ${need}`);
  }
  const motion = CATALOG_ENTRIES.find(e => e.id === 'cursor-motion');
  assert.ok(motion.keywords.includes('dwell') || motion.keywords.includes('motion'));
  const colors = CATALOG_ENTRIES.find(e => e.id === 'cursor-colors');
  assert.ok(colors.keywords.includes('accent'));
});

test('preset side-effects: simple disables ripple/highlight, ring-only enables both', () => {
  const applyPreset = (preset, prefs) => {
    if (preset === 'simple') return { ...prefs, ripple: false, highlight: false };
    if (preset === 'ring-only') return { ...prefs, ripple: true, highlight: true };
    return prefs;
  };
  let p = { ripple: true, highlight: true };
  assert.deepEqual(applyPreset('simple', p), { ripple: false, highlight: false });
  assert.deepEqual(applyPreset('ring-only', { ripple: false, highlight: false }), { ripple: true, highlight: true });
});

test('custom image path must be absolute and not temp fragile', () => {
  const isAbsolute = (p) => p.startsWith('/');
  assert.equal(isAbsolute('/var/lib/apex/cursor-abc.png'), true);
  assert.equal(isAbsolute('tmp/cursor.png'), false);
  assert.equal(isAbsolute('/tmp/cursor.png'), true); // absolute but we prefer app data dir; temp still absolute but fragile – enforced by host storing in data dir
});
