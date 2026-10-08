import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseFeed, totals, pickName, roomFile, snippet} from '../hooks/feed.ts';
test('empty feed',()=>assert.equal(totals(parseFeed('bad')).checked,0));
test('names and utf8 filenames',()=>{assert.equal(pickName([]),'nobody');assert.equal(pickName(['a','b']),'@a + @b');assert.equal(roomFile('pane-muukzmb4-0'),'70616e652d6d75756b7a6d62342d30.json');});
test('snippet requires human and causal timestamp',()=>{const row={message_index:0,at_ms:1000000}; const msg={speaker:{kind:'human'},at:999999,text:'\nhello\nworld'}; const room={snapshot:{transcript:[msg]}};assert.equal(snippet(room,row),'hello');for(const patch of [{speaker:{kind:'bot'}},{at:1000001},{at:699999},{at:undefined},{text:''}])assert.equal(snippet({snapshot:{transcript:[{...msg,...patch}]}},row),null); assert.equal(snippet({},row),null);assert.equal(snippet({snapshot:{transcript:[{...msg,text:'x'.repeat(70)}]}},row).length,60);});

test('thinking success, error and stale rows do not affect routing totals',()=>{const routing={result:{latency_ms:500,usage:{cost:.002}},deck_targets:['null'],suggested_targets:['null']};const thinking=[{kind:'thinking',result:{latency_ms:9000,usage:{cost:1}}},{kind:'thinking',error:'timeout'},{kind:'thinking',stale:true}];assert.deepEqual(totals([routing,...thinking]),totals([routing]));assert.equal(totals(thinking).checked,0);});
