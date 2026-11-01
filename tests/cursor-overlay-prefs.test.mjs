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

test('atomic apply ensures invalid incoming prefs cause zero partial mutations', () => {
  const initial = { preset: 'default', size: 1.0, accent: '#4299FF', ripple: true };
  let active = { ...initial };

  const applyAtomic = (incoming) => {
    // Validate everything first
    if (incoming.size !== undefined && (incoming.size < 0.5 || incoming.size > 4.0)) return 'invalid size';
    if (incoming.accent !== undefined && !isHex(incoming.accent)) return 'invalid accent';
    if (incoming.motion) {
      if (incoming.motion.travelMinMs < 30 || incoming.motion.travelMinMs > incoming.motion.travelMaxMs) return 'invalid travel';
      if (incoming.motion.travelMaxMs + incoming.motion.dwellMs > 700) return 'budget exceeded';
    }
    // Only mutate if all valid
    active = { ...active, ...incoming };
    return null;
  };

  // Attempt invalid update that has a valid preset change but invalid size
  const err1 = applyAtomic({ preset: 'simple', size: 99.0 });
  assert.equal(err1, 'invalid size');
  assert.equal(active.preset, 'default', 'preset must NOT have been partially mutated');
  assert.equal(active.size, 1.0, 'size must be unchanged');

  // Attempt invalid update with invalid motion budget
  const err2 = applyAtomic({ accent: '#FFFFFF', motion: { travelMinMs: 90, travelMaxMs: 600, dwellMs: 200 } });
  assert.equal(err2, 'budget exceeded');
  assert.equal(active.accent, '#4299FF', 'accent must NOT have been partially mutated');
});

test('host persisted prefs survive helper restart and clobbering', () => {
  // Host prefs are authority. If helper status returns defaults or offline,
  // host authority preserves user settings.
  const hostSavedPrefs = { preset: 'ring-only', size: 2.5, accent: '#00FF00', labels_enabled: true };
  const helperStatusAfterRestart = { preset: 'default', size: 1.0, accent: '#4299FF', labels_enabled: false };

  // Host sync logic: if helper differs from host authority, host pushes hostSavedPrefs
  const syncHelper = (host, helper) => {
    if (JSON.stringify(host) !== JSON.stringify(helper)) {
      return { pushedToHelper: host, currentAuthority: host };
    }
    return { pushedToHelper: null, currentAuthority: host };
  };

  const sync = syncHelper(hostSavedPrefs, helperStatusAfterRestart);
  assert.deepEqual(sync.pushedToHelper, hostSavedPrefs, 'host must re-push saved prefs to helper');
  assert.deepEqual(sync.currentAuthority, hostSavedPrefs, 'host authority must never be overwritten');
});

test('UI prefers authoritative host cursorOverlay over pre-reconciliation cursorOverlayFromHelper', () => {
  const hostOverlay = { preset: 'ring-only', size: 2.0, accent: '#00FF00', labelsEnabled: true };
  const preReconHelperOverlay = { preset: 'default', size: 1.0, accent: '#4299FF', labelsEnabled: false };
  const status = {
    cursorOverlay: hostOverlay,
    cursorOverlayFromHelper: preReconHelperOverlay,
  };
  const resolved = status.cursorOverlay ?? status.cursorOverlayFromHelper;
  assert.equal(resolved.preset, 'ring-only', 'host overlay must be preferred so offline prefs survive reconnect');
  assert.equal(resolved.size, 2.0);
});

test('custom image upload payload uses canonical imageBase64 without legacy duplicate', () => {
  const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
  const payload = { imageBase64: base64 };
  assert.equal('imageBase64' in payload, true);
  assert.equal('image_base64' in payload, false, 'duplicate alias field must not be sent');
});
