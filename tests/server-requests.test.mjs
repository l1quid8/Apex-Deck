import test from 'node:test';
import assert from 'node:assert/strict';
import { parseServerRequests, resolveServerRequests } from '../src/serverRequests.ts';
import { findTrigger, menuItems } from '../src/composerMenu.ts';
test('bang requests respect prose, escaping and code boundaries', () => {
 assert.deepEqual(parseServerRequests('!x-mcp !X_MCP wow! != ![img](url) !! \\!skip `!code` ```\n!hidden\n``` !Hyper-MCP').map(x=>x.name), ['x-mcp','Hyper-MCP']);
});
test('normalization resolves original names and reports typos', () => {
 assert.deepEqual(resolveServerRequests(['hyper_mcp','x-mpc'], ['Hyper MCP']), {matched:['Hyper MCP'],unknown:['x-mpc']});
});
test('bang menu matches loose prefixes, ignores code, and inserts canonical spelling', () => {
 const trigger = findTrigger('@null !hy',9);
 assert.equal(trigger?.kind,'server');
 assert.deepEqual(menuItems(trigger,[],[{agent:'null',name:'Hyper MCP'}]).map(x=>x.label),['!hyper-mcp']);
 for(const text of ['wow!','`!x','```\n!x','\\!x','!!']) assert.equal(findTrigger(text,text.length),null);
});
