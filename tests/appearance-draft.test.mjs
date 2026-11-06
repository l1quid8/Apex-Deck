import test from 'node:test';
import assert from 'node:assert/strict';
import * as draft from '../src/appearanceDraft.ts';
import * as themes from '../src/themes.ts';
import { DEFAULT_LANDING_TEXTURE, DEFAULT_SETTINGS, readSettings } from '../src/settings.ts';

const built = id => themes.BUILTIN_SKINS.find(s => s.id === id);
const skin = (name, appearance) => ({ format: 'apex-glass-playground', version: 2, name, appearance });
const tide = { kind: 'builtin', id: 'tide' };
const tideValues = { ...built('tide').appearance };
const clayValues = { ...built('clay').appearance };
const applied = (current, saved = [], extra = {}) => ({ current, saved, colorMode: 'dark', ...extra });

const base = () => ({ ...DEFAULT_SETTINGS, appearance: applied(skin('Clay Warm', clayValues)) });
/** Stores a draft built from `change`; values merge over the working values. */
const withDraft = (settings, change = {}) => {
  const d = draft.workingDraft(settings);
  return { ...settings, appearanceDraft: { ...d, ...change, values: { ...d.values, ...change.values } } };
};
const editing = (d, values, theme) => {
  const onTheme = draft.pickTheme(d, theme, []);
  return { ...onTheme, values: { ...onTheme.values, ...values } };
};
const goodDraft = (change = {}) => ({ version: 1, colorMode: 'dark', source: { kind: 'builtin', id: 'clay' }, values: clayValues, botChips: DEFAULT_SETTINGS.botChips, landingTexture: DEFAULT_LANDING_TEXTURE, lastPreset: {}, materialEdits: {}, ...change });
const onSavedPreset = (name, values) => {
  const mine = skin(name, { ...clayValues, radius: 20, ...values });
  return { ...DEFAULT_SETTINGS, appearance: applied(mine, [mine], { source: { kind: 'saved', name } }) };
};
const onSavedPresetWithEdits = () => withDraft(onSavedPreset('Mine'), { values: { radius: 26 } });
const onSavedPresetWithDraft = name => withDraft(onSavedPreset(name), { values: { radius: 26 } });

test('nothing pending means nothing stored', () => {
  const s = base();
  assert.equal(draft.storeDraft(s, draft.workingDraft(s)).appearanceDraft, undefined);
});
test('a pending change is stored, and going back removes it', () => {
  const s = base();
  const d = draft.workingDraft(s);
  const edited = draft.storeDraft(s, { ...d, values: { ...d.values, radius: 20 } });
  assert.equal(edited.appearanceDraft.values.radius, 20);
  assert.equal(draft.storeDraft(edited, d).appearanceDraft, undefined);
});
test('a draft leaves every applied key alone', () => {
  const s = withDraft(base(), { colorMode: 'light', values: { radius: 20 } });
  assert.deepEqual(s.appearance.current, base().appearance.current);
  assert.deepEqual(s.botChips, base().botChips);
  assert.equal(s.appearance.colorMode, base().appearance.colorMode);
});
test('every pending kind is listed once, Mode first', () => {
  const s = withDraft(base(), { colorMode: 'light', source: tide, botChips: { ...base().botChips, usage: false }, landingTexture: { ...DEFAULT_LANDING_TEXTURE, enabled: false } });
  assert.deepEqual(draft.pendingChanges(s, s.appearanceDraft, true).map(c => c.label), ['Mode', 'Theme and preset', 'Agent chips', 'Empty thread']);
});
test('reverting one row leaves the others', () => {
  const s = withDraft(base(), { colorMode: 'light', values: { radius: 20 } });
  const d = draft.revertPending(s, s.appearanceDraft, 'Mode');
  assert.deepEqual(draft.pendingChanges(s, d, true).map(c => c.label), ['Theme and preset']);
  assert.equal(d.values.radius, 20);
  const e = draft.revertPending(s, s.appearanceDraft, 'Theme and preset');
  assert.deepEqual(draft.pendingChanges(s, e, true).map(c => c.label), ['Mode']);
});
test('System mode follows the OS without counting as a change', () => {
  const s = { ...base(), appearance: { ...base().appearance, colorMode: 'system' } };
  const d = draft.workingDraft(s);
  assert.deepEqual(draft.pendingChanges(s, d, true), []);
  assert.deepEqual(draft.pendingChanges(s, d, false), []);
});
test('Apply copies everything, removes the draft and keeps presets', () => {
  const s = withDraft(base(), { colorMode: 'light', source: tide, values: tideValues });
  const next = draft.applyDraft(s);
  assert.equal(next.appearanceDraft, undefined);
  assert.equal(next.appearance.colorMode, 'light');
  assert.equal(next.appearance.current.name, 'Liquid Tide');
  assert.deepEqual(next.appearance.source, tide);
  assert.deepEqual(next.appearance.saved, s.appearance.saved);
});
test('Apply leaves an untouched default field out of the file', () => {
  const next = draft.applyDraft(withDraft(base(), { colorMode: 'light' }));
  assert.equal('landingTexture' in next, false);
  const changed = { ...DEFAULT_LANDING_TEXTURE, enabled: false };
  assert.deepEqual(draft.applyDraft(withDraft(base(), { landingTexture: changed })).landingTexture, changed);
});
test('Discard drops the draft and keeps a preset saved during it', () => {
  const saved = draft.savePreset(withDraft(base(), { values: { radius: 20 } }), 'Mine');
  const next = draft.discardDraft(saved);
  assert.equal(next.appearanceDraft, undefined);
  assert.ok(next.appearance.saved.some(s => s.name === 'Mine'));
  assert.deepEqual(next.appearance.current, base().appearance.current);
});
test('Saving never changes applied values', () => {
  const s = draft.savePreset(withDraft(base(), { values: { radius: 20 } }), 'Mine');
  assert.deepEqual(s.appearance.current, base().appearance.current);
  assert.deepEqual(s.appearanceDraft.source, { kind: 'saved', name: 'Mine' });
});
test('Saving what Deck already shows only names it', () => {
  const edited = { ...base().appearance.current, appearance: { ...clayValues, radius: 20 } };
  const s = { ...base(), appearance: applied(edited) };
  const next = draft.savePreset(s, 'Mine');
  assert.deepEqual(next.appearance.current.appearance, edited.appearance);
  assert.deepEqual(next.appearance.source, { kind: 'saved', name: 'Mine' });
  assert.deepEqual(draft.pendingChanges(next, draft.workingDraft(next), true), []);
});
test('a saved preset never stores which mode it was made in', () => {
  const s = draft.savePreset(withDraft(base(), { colorMode: 'light', values: { radius: 20 } }), 'Mine');
  assert.equal(s.appearance.saved[0].appearance.light, clayValues.light);
  assert.equal('colorMode' in s.appearance.saved[0], false);
});
test('Updating the preset Deck uses leaves Deck on the earlier version', () => {
  const s = draft.updatePreset(onSavedPresetWithEdits());
  assert.equal(s.appearance.sourceBehind, true);
  assert.notEqual(s.appearance.current.appearance.radius, s.appearance.saved[0].appearance.radius);
  assert.match(draft.deckLabel(s, true), /Mine \(earlier version\)/);
});
test('Apply clears the earlier-version mark', () => {
  const s = draft.applyDraft(draft.updatePreset(onSavedPresetWithEdits()));
  assert.equal('sourceBehind' in s.appearance, false);
  assert.equal(s.appearance.current.appearance.radius, 26);
});
test('switching theme carries shared edits and keeps Material edits for the way back', () => {
  let d = editing(draft.workingDraft(base()), { radius: 20, blur: 12 }, 'liquid');
  d = draft.pickTheme(d, 'clay', []);
  assert.equal(d.values.radius, 20);
  assert.equal(d.values.blur, 0);
  assert.equal(draft.pickTheme(d, 'liquid', []).values.blur, 12);
});
test('Material edits survive a stop on the applied theme', () => {
  const s = base();
  const liquid = editing(draft.workingDraft(s), { blur: 12 }, 'liquid');
  const back = draft.storeDraft(s, draft.pickTheme(liquid, 'clay', []));
  assert.equal(draft.pickTheme(back.appearanceDraft, 'liquid', []).values.blur, 12);
});
test('a theme never inherits the other theme\'s identity', () => {
  const d = draft.pickTheme(draft.workingDraft(base()), 'liquid', []);
  assert.equal('theme' in d.values, false);
  assert.equal(themes.themeFamily(d.values), 'liquid');
  const black = draft.pickPreset(draft.workingDraft(base()), { kind: 'builtin', id: 'clay-black' }, []);
  assert.equal('palette' in draft.pickTheme(black, 'classic', []).values, false);
});
test('Clear edits returns to the preset and leaves Mode alone', () => {
  const s = withDraft(base(), { colorMode: 'light', values: { radius: 20 } });
  const d = draft.clearEdits(s.appearanceDraft, []);
  assert.deepEqual(draft.editedKeys(d, []), []);
  assert.equal(d.colorMode, 'light');
});
test('editedKeys ignores what the theme has no control for', () => {
  const d = draft.workingDraft(base());
  assert.deepEqual(draft.editedKeys({ ...d, values: { ...d.values, blur: 30 } }, []), []);
  assert.deepEqual(draft.editedKeys({ ...d, values: { ...d.values, edges: 'strong' } }, []), ['edges']);
});
test('an exact accent counts as one edit', () => {
  const d = draft.workingDraft(base());
  const exact = { ...d, values: { ...d.values, ...themes.colorAppearance('#35aabb') } };
  assert.deepEqual(draft.editedKeys(exact, []), ['accentColor']);
});
test('deleting a preset in use keeps the look as edits on its built-in', () => {
  const s = draft.deletePreset(onSavedPreset('Mine', { theme: 'clay', palette: 'black' }), 'Mine');
  assert.deepEqual(s.appearance.source, { kind: 'builtin', id: 'clay-black' });
  assert.ok(draft.editedKeys(draft.workingDraft(s), s.appearance.saved).length > 0);
});
test('deleting the preset a draft points at keeps the draft values', () => {
  const s = draft.deletePreset(onSavedPresetWithDraft('Mine'), 'Mine');
  assert.equal(s.appearanceDraft.source.kind, 'builtin');
  assert.equal(s.appearanceDraft.values.radius, 26);
});
test('renaming follows into Deck and the draft', () => {
  const s = draft.renamePreset(onSavedPresetWithDraft('Mine'), 'Mine', 'Ours');
  assert.deepEqual(s.appearance.source, { kind: 'saved', name: 'Ours' });
  assert.deepEqual(s.appearanceDraft.source, { kind: 'saved', name: 'Ours' });
});
test('preset names must be new and not blank', () => {
  const saved = [skin('Mine', clayValues)];
  assert.match(draft.presetNameError('  ', saved), /Enter a name/);
  assert.match(draft.presetNameError('mine', saved), /already exists/);
  assert.match(draft.presetNameError('clay warm', saved), /already exists/);
  assert.equal(draft.presetNameError('Mine', saved, 'Mine'), null);
  assert.equal(draft.presetNameError('Ours', saved), null);
});
test('a full preset list refuses another', () => {
  const saved = Array.from({ length: 50 }, (_, i) => skin(`P${i}`, clayValues));
  assert.match(draft.presetNameError('Ours', saved), /50 presets/);
});
test('a broken draft is dropped alone', () => {
  for (const raw of [{}, { version: 9 }, { version: 1, values: { hue: 'x' } }, 7, goodDraft({ botChips: 3 }), goodDraft({ colorMode: 'purple' })]) assert.equal(draft.readAppearanceDraft(raw, []), undefined);
  const missing = draft.readAppearanceDraft(goodDraft({ source: { kind: 'saved', name: 'Gone' } }), []);
  assert.equal(missing.source.kind, 'builtin');
});
test('settings.json read keeps the draft and survives a bad one', () => {
  assert.equal(readSettings({ appearanceDraft: { version: 9 }, confirmSteer: false }).confirmSteer, false);
  assert.equal(readSettings({ appearanceDraft: { version: 9 } }).appearanceDraft, undefined);
  assert.ok(readSettings({ appearanceDraft: goodDraft() }).appearanceDraft);
});
test('a control reverts to its preset alone', () => {
  const d = { ...draft.workingDraft(base()), values: { ...clayValues, radius: 20, density: 0.72 } };
  const e = draft.revertKeys(d, ['radius'], []);
  assert.equal(e.values.radius, clayValues.radius);
  assert.equal(e.values.density, 0.72);
  const exact = { ...d, values: { ...clayValues, ...themes.colorAppearance('#35aabb') } };
  assert.equal('accentColor' in draft.revertKeys(exact, ['accentColor', 'hue'], []).values, false);
});
test('import adds a preset and leaves the draft and Deck alone', () => {
  const s = withDraft(base(), { values: { radius: 20 } });
  const next = draft.importPreset(s, skin('Harbor', tideValues));
  assert.deepEqual(next.appearance.saved.map(p => p.name), ['Harbor']);
  assert.deepEqual(next.appearance.current, s.appearance.current);
  assert.deepEqual(next.appearanceDraft, s.appearanceDraft);
});
test('import of a preset whose name exists keeps both', () => {
  const s = draft.importPreset(onSavedPreset('Mine'), skin('Mine', tideValues));
  assert.deepEqual(s.appearance.saved.map(p => p.name), ['Mine', 'Mine 2']);
});
test('import of a preset named like a built-in keeps both', () => {
  const s = draft.importPreset(base(), skin('Clay Warm', tideValues));
  assert.deepEqual(s.appearance.saved.map(p => p.name), ['Clay Warm 2']);
});
test('a draft keeps the applied object, so pop-outs see nothing until Apply', () => {
  const s = base();
  const edited = draft.storeDraft(s, { ...draft.workingDraft(s), values: { ...clayValues, radius: 20 } });
  assert.equal(edited.appearance, s.appearance);
  assert.notEqual(draft.applyDraft(edited).appearance, s.appearance);
});

const full = () => {
  const saved = Array.from({ length: 50 }, (_, i) => skin(`P${i}`, { ...clayValues, radius: 5 + (i % 20) }));
  return { ...base(), appearance: applied(skin('Clay Warm', clayValues), saved) };
};
test('a chip style matching the omitted default is not a change', () => {
  const s = base();
  const d = draft.workingDraft(s);
  assert.deepEqual(draft.pendingChanges(s, { ...d, botChips: { ...d.botChips, style: 'classic' } }, true), []);
});
test('a full preset list refuses imports and saves instead of dropping the oldest', () => {
  const s = full();
  assert.equal(draft.presetLimitError(s.appearance.saved), 'You have 50 presets. Delete one first.');
  assert.equal(draft.presetLimitError(s.appearance.saved.slice(1)), null);
  assert.equal(draft.importPreset(s, skin('New', clayValues)), s);
  assert.equal(draft.savePreset(s, 'New'), s);
});
test('Undo keeps a preset saved since, but puts Deck back', () => {
  const before = withDraft(base(), { values: { radius: 20 } });
  const after = draft.savePreset(draft.applyDraft(before), 'Later');
  const undone = draft.restoreAppearance(after, before);
  assert.deepEqual(undone.appearance.saved.map(p => p.name), ['Later']);
  assert.equal(undone.appearance.current.appearance.radius, clayValues.radius);
  assert.equal(undone.appearanceDraft.values.radius, 20);
});
test('Undo keeps a preset updated since', () => {
  const start = onSavedPreset('Mine');
  const before = { ...start };
  const later = withDraft(start, { values: { radius: 26 } });
  const undone = draft.restoreAppearance(draft.updatePreset(later), before);
  assert.equal(undone.appearance.saved[0].appearance.radius, 26);
});
test('Undo of a delete brings that preset back in its place', () => {
  const a = skin('A', { ...clayValues, radius: 7 }); const b = skin('B', { ...clayValues, radius: 8 });
  const before = { ...base(), appearance: applied(skin('Clay Warm', clayValues), [a, b]) };
  const later = draft.importPreset(draft.deletePreset(before, 'A'), skin('C', { ...clayValues, radius: 9 }));
  const undone = draft.restoreAppearance(later, before, 'A');
  assert.deepEqual(undone.appearance.saved.map(p => p.name), ['A', 'B', 'C']);
});
test('Undo does not leave a draft on a preset deleted since', () => {
  const liquid = skin('Glass', { ...tideValues, radius: 7 });
  const start = { ...base(), appearance: applied(skin('Clay Warm', clayValues), [liquid]) };
  const before = draft.storeDraft(start, draft.pickPreset(draft.workingDraft(start), { kind: 'saved', name: 'Glass' }, [liquid]));
  const undone = draft.restoreAppearance(draft.deletePreset(before, 'Glass'), before);
  assert.equal(undone.appearanceDraft.source.kind, 'builtin');
  assert.equal(draft.draftTheme(undone.appearanceDraft, undone.appearance.saved), 'liquid');
});
test('Undo with no earlier appearance record still keeps presets saved since', () => {
  const before = withDraft({ ...DEFAULT_SETTINGS }, { values: { radius: 20 } });
  const after = draft.savePreset(before, 'Later');
  assert.deepEqual(draft.restoreAppearance(after, before).appearance.saved.map(p => p.name), ['Later']);
});
test('updating another preset keeps the label on the one Deck is behind', () => {
  const mine = onSavedPreset('Mine');
  const other = skin('Other', { ...clayValues, radius: 8 });
  const s = { ...mine, appearance: { ...mine.appearance, saved: [...mine.appearance.saved, other], sourceBehind: true } };
  const next = draft.updatePreset(withDraft(s, { source: { kind: 'saved', name: 'Other' }, values: { radius: 9 } }));
  assert.equal(next.appearance.sourceBehind, true);
});
test('the Update note only mentions the earlier version when Deck differs', () => {
  const same = onSavedPreset('Mine');
  const unchanged = { ...same, appearance: { ...same.appearance, saved: [skin('Mine', { ...clayValues, radius: 12 })] } };
  assert.equal(draft.presetUpdateNote(withDraft(unchanged, {})), 'Mine updated.');
  assert.equal(draft.presetUpdateNote(onSavedPresetWithEdits()), 'Mine updated. Deck keeps the earlier version until you apply.');
});
