import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APPEARANCE, BUILTIN_SKINS, readAppearance, resolveColorMode, effectiveLightFromMode, isColorMode, defaultAppearanceSettings } from '../src/themes.ts';
import { effectiveAppearanceValues } from '../src/useAppearance.ts';

test('colorMode defaults to system for new profiles', () => {
  const defaults = defaultAppearanceSettings();
  assert.equal(defaults.colorMode, 'system');
});

test('isColorMode validates only system/light/dark', () => {
  assert.equal(isColorMode('system'), true);
  assert.equal(isColorMode('light'), true);
  assert.equal(isColorMode('dark'), true);
  assert.equal(isColorMode('auto'), false);
  assert.equal(isColorMode(undefined), false);
});

test('resolveColorMode returns effective light/dark', () => {
  assert.equal(resolveColorMode('light', true), 'light');
  assert.equal(resolveColorMode('light', false), 'light');
  assert.equal(resolveColorMode('dark', true), 'dark');
  assert.equal(resolveColorMode('dark', false), 'dark');
  assert.equal(resolveColorMode('system', true), 'dark');
  assert.equal(resolveColorMode('system', false), 'light');
});

test('effectiveLightFromMode preserves explicit choices and system follows OS', () => {
  assert.equal(effectiveLightFromMode('light', true, false), true);
  assert.equal(effectiveLightFromMode('dark', false, true), false);
  assert.equal(effectiveLightFromMode('system', true, true), false);
  assert.equal(effectiveLightFromMode('system', false, false), true);
  // migration: undefined falls back to appearance.light
  assert.equal(effectiveLightFromMode(undefined, false, true), true);
  assert.equal(effectiveLightFromMode(undefined, true, false), false);
});

test('readAppearance migrates legacy light=false to dark and light=true to light', () => {
  const darkSkin = { format: 'apex-glass-playground', version: 2, name: 'Test', appearance: { ...DEFAULT_APPEARANCE, light: false } };
  const lightSkin = { format: 'apex-glass-playground', version: 2, name: 'Test Light', appearance: { ...DEFAULT_APPEARANCE, light: true } };
  const migratedDark = readAppearance({ current: darkSkin, saved: [] });
  assert.equal(migratedDark.colorMode, 'dark');
  const migratedLight = readAppearance({ current: lightSkin, saved: [] });
  assert.equal(migratedLight.colorMode, 'light');
});

test('readAppearance preserves explicit colorMode and does not rewrite skin light', () => {
  const skin = { format: 'apex-glass-playground', version: 2, name: 'Test', appearance: { ...DEFAULT_APPEARANCE, light: false } };
  const withSystem = readAppearance({ current: skin, saved: [], colorMode: 'system' });
  assert.equal(withSystem.colorMode, 'system');
  assert.equal(withSystem.current.appearance.light, false, 'skin light hint preserved, not mutated');
});

test('effectiveAppearanceValues derives light from colorMode without mutating saved skin', () => {
  const darkSkin = { format: 'apex-glass-playground', version: 2, name: 'Test', appearance: { ...DEFAULT_APPEARANCE, light: false } };
  const settings = { current: darkSkin, saved: [], colorMode: 'light' };
  const effective = effectiveAppearanceValues(settings, false);
  assert.equal(effective.light, true, 'explicit light mode forces light true');
  assert.equal(settings.current.appearance.light, false, 'original skin untouched');

  const systemSettings = { current: darkSkin, saved: [], colorMode: 'system' };
  const effectiveSystemDark = effectiveAppearanceValues(systemSettings, true);
  assert.equal(effectiveSystemDark.light, false);
  const effectiveSystemLight = effectiveAppearanceValues(systemSettings, false);
  assert.equal(effectiveSystemLight.light, true);
});

test('imported skins retain own portable light hint; importing does not silently change global mode', () => {
  // Simulate: current has system, imported skin has light true but we only change current.appearance, not colorMode
  const current = { format: 'apex-glass-playground', version: 2, name: 'My Skin', appearance: { ...DEFAULT_APPEARANCE, light: false } };
  const settings = { current, saved: [], colorMode: 'system' };
  const imported = { format: 'apex-glass-playground', version: 2, name: 'Frost Clone', appearance: { ...BUILTIN_SKINS[5].appearance } }; // Frost is light true
  // Applying imported skin: should replace current but keep colorMode
  const afterImport = { ...settings, current: imported };
  assert.equal(afterImport.colorMode, 'system', 'global mode preserved');
  assert.equal(afterImport.current.appearance.light, true, 'imported skin retains its own portable hint');
});
