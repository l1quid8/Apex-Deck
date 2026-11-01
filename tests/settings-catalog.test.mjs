import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_ENTRIES, CATALOG_SECTIONS, searchSettings, resolveSectionId, groupSections , STUDIO_ANCHORS} from '../src/settingsCatalog.ts';

test('catalog preserves every existing feature from README coverage', () => {
  // Representative coverage from mockup README
  const required = [
    'mode','skin','accent','chips','effort','usage',
    'engine','voice','call-controls','provider-list','api-key',
    'connections','paired','ucu-enable','cursor','gateway-endpoint','extension-list','shortcut-list','updates'
  ];
  // We check that for each required substring there is at least one entry whose anchor or id contains it
  for (const id of required) {
    const found = CATALOG_ENTRIES.some(e=>e.anchorId.includes(id) || e.id.includes(id) || e.label.toLowerCase().includes(id.replace('-',' ')));
    assert.ok(found, `catalog must include ${id}`);
  }
});

test('groupSections returns 5 groups with expected titles', () => {
  const groups = groupSections();
  assert.equal(groups.length, 5);
  assert.deepEqual(groups.map(g=>g.title), ['Everyday','Work','Connections','Capabilities','Maintenance']);
  const everyday = groups.find(g=>g.title==='Everyday');
  assert.ok(everyday.sections.some(s=>s.id==='appearance'));
  assert.ok(everyday.sections.some(s=>s.id==='general'));
});

test('resolveSectionId handles legacy aliases', () => {
  assert.equal(resolveSectionId('hosts'), 'computers');
  assert.equal(resolveSectionId('providers'), 'models');
  assert.equal(resolveSectionId('mods'), 'extensions');
  assert.equal(resolveSectionId('appearance'), 'appearance');
  assert.equal(resolveSectionId('unknown'), null);
});

test('searchSettings ranks exact label before keyword and respects visible filter', () => {
  const results = searchSettings('dark', CATALOG_ENTRIES);
  assert.ok(results.length>0);
  assert.ok(results[0].id==='mode' || results[0].label.toLowerCase().includes('dark'));

  const results2 = searchSettings('SSH', CATALOG_ENTRIES);
  assert.ok(results2.some(r=>r.section==='computers'));

  // Visibility filtering: hide computers
  const visible = new Set(['general','appearance']);
  const filtered = searchSettings('SSH', CATALOG_ENTRIES, visible);
  assert.equal(filtered.length, 0, 'should not return hidden section results');
});

test('searchSettings returns empty for empty query and handles case-insensitive', () => {
  assert.deepEqual(searchSettings('', CATALOG_ENTRIES), []);
  const a = searchSettings('VOICE', CATALOG_ENTRIES);
  const b = searchSettings('voice', CATALOG_ENTRIES);
  assert.deepEqual(a.map(x=>x.id).sort(), b.map(x=>x.id).sort());
});

test('every entry has required fields and scope label', () => {
  for (const e of CATALOG_ENTRIES) {
    assert.ok(e.id);
    assert.ok(e.section);
    assert.ok(e.label);
    assert.ok(Array.isArray(e.keywords));
    assert.ok(e.scopeLabel);
    assert.ok(e.anchorId);
  }
});

test('every Appearance catalog entry maps to a real control', () => {
  for (const item of CATALOG_ENTRIES.filter(i => i.section === 'appearance')) assert.ok(STUDIO_ANCHORS[item.anchorId], item.id);
});
test('labels use the new words', () => {
  for (const item of CATALOG_ENTRIES) assert.doesNotMatch(item.label, /\bskins?\b/i);
});
test('new Studio words can be searched, and skin still finds it', () => {
  const visible = new Set(['appearance']);
  for (const word of ['preset', 'reply', 'panel edges', 'skin']) assert.ok(searchSettings(word, CATALOG_ENTRIES, visible).some(r => r.section === 'appearance'), word);
});
