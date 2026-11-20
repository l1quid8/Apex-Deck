import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WidgetStore } from '../desktop/generated-ui/widget-store.mjs';
import { normalizeWidgetState } from '../shared/generatedWidgetState.mjs';

test('widget snapshots accept bounded JSON only and detach caller references', () => {
  const input = {stage: 2, mode: 'change', values: [true, null, 1.5]};
  const result = normalizeWidgetState(input);
  input.stage = 9;
  assert.equal(result.stage, 2);
  for (const value of [undefined, NaN, Infinity, ()=>{}, {a:undefined}, {a:1n}, new Date(), {get a(){throw Error('getter');}}, {text:'é'.repeat(4096)}]) assert.throws(()=>normalizeWidgetState(value));
  const circular = {}; circular.self = circular;
  assert.throws(()=>normalizeWidgetState(circular));
  let deep = {}; for (let i=0;i<20;i++) deep={deep};
  assert.throws(()=>normalizeWidgetState(deep));
  assert.throws(()=>normalizeWidgetState(Array(600).fill(0)));
  assert.deepEqual(normalizeWidgetState(JSON.parse('{"__proto__":{"polluted":true}}')),JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal({}.polluted, undefined);
});

test('host store survives reconstruction, isolates revisions, bounds entries and ignores corrupt disk', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deck-widget-test-'));
  try {
    const a='a'.repeat(64), b='b'.repeat(64), png='data:image/png;base64,'+Buffer.from('image').toString('base64');
    const store=new WidgetStore(root,{maxEntries:2});
    store.saveState(a,{step:3}); store.saveImage(a,png); store.flush();
    const reopened=new WidgetStore(root,{maxEntries:2});
    assert.deepEqual(reopened.get(a),{widgetState:{step:3},image:png});
    assert.deepEqual(reopened.get(b),{widgetState:null,image:null});
    const copy=reopened.get(a); copy.widgetState.step=7;
    assert.equal(reopened.get(a).widgetState.step,3);
    reopened.saveState(b,{step:1}); reopened.saveState('c'.repeat(64),{}); reopened.flush();
    assert.equal(reopened.get(a).widgetState,null);
    assert.throws(()=>reopened.saveState('../escape',{}));
    assert.throws(()=>reopened.saveImage(b,'https://outside.invalid/pixel'));
    fs.writeFileSync(path.join(root,'widgets.json'),'broken');
    assert.equal(new WidgetStore(root).get(a).widgetState,null);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});


test('image pressure drops old raster pixels before saved settings',()=>{
 const store=new WidgetStore(null,{maxEntries:128,maxBytes:1000});
 const a='a'.repeat(64),b='b'.repeat(64);
 store.saveState(a,{step:9});store.saveState(b,{mode:'change'});
 store.saveImage(a,'data:image/png;base64,'+'A'.repeat(900));
 assert.equal(store.get(a).widgetState.step,9);
 assert.equal(store.get(b).widgetState.mode,'change');
 assert.equal(store.get(a).image,null);
});
