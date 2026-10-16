import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_SKINS, defaultAppearanceSettings } from '../src/themes.ts';
import { PHONE_APPEARANCE_KEY, loadPhoneAppearance, savePhoneAppearance, applyPhoneTheme, watchPhoneTransparency } from '../src/phone/appearance.ts';

test('phone appearance survives a restart without writing desktop settings', () => {
  const values = new Map([['apex-deck.settings', 'desktop stays here']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const state = { current: { format: 'apex-glass-playground', version: 2, name: 'My Tide', appearance: BUILTIN_SKINS.find(s => s.id === 'tide').appearance }, saved: [] };
  state.saved.push(state.current);
  assert.equal(savePhoneAppearance(storage, state), true);
  assert.deepEqual(loadPhoneAppearance(storage), state);
  assert.equal(values.get('apex-deck.settings'), 'desktop stays here');
  assert.ok(values.has(PHONE_APPEARANCE_KEY));
});

test('damaged or unavailable storage falls back to Classic and reports failed writes', () => {
  assert.deepEqual(loadPhoneAppearance({ getItem: () => '{bad json' }), defaultAppearanceSettings());
  const blocked = { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } };
  assert.deepEqual(loadPhoneAppearance(blocked), defaultAppearanceSettings());
  assert.equal(savePhoneAppearance(blocked, defaultAppearanceSettings()), false);
});

test('switching from custom glass to Classic removes every theme override', () => {
  const properties = new Map();
  const root = { dataset: {}, style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) } };
  const stop = applyPhoneTheme(root, { ...BUILTIN_SKINS.find(s => s.id === 'frost').appearance, accentColor: '#ff3344' });
  assert.equal(root.dataset.deckTheme, 'glass');
  assert.equal(root.dataset.deckLight, 'true');
  assert.equal(properties.get('--deck-custom-accent'), '#ff3344');
  stop();
  const classic = applyPhoneTheme(root, defaultAppearanceSettings().current.appearance);
  assert.equal(root.dataset.deckTheme, 'classic');
  assert.equal(root.dataset.deckLight, 'false');
  assert.equal(properties.size, 0);
  classic();
  assert.deepEqual(root.dataset, {});
});

test('native transparency changes win over a late initial read and stop after cleanup', async () => {
  let listener, resolveInitial, removed = false;
  const native = {
    async addListener(_name, fn) { listener = fn; return { async remove() { removed = true; } }; },
    getTransparency: () => new Promise(resolve => { resolveInitial = resolve; }),
  };
  const seen = [];
  const stop = watchPhoneTransparency(native, value => seen.push(value));
  await new Promise(resolve => setImmediate(resolve));
  listener({ reduced: true });
  resolveInitial({ reduced: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, [true]);
  listener({ reduced: false });
  stop();
  listener({ reduced: true });
  assert.deepEqual(seen, [true, false]);
  assert.equal(removed, true);
});
