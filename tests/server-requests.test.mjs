import test from 'node:test';
import assert from 'node:assert/strict';
import { parseServerRequests, resolveServerRequests } from '../src/serverRequests.ts';
import { findTrigger, menuItems } from '../src/composerMenu.ts';
test('bang requests respect prose, escaping and code boundaries', () => {
 assert.deepEqual(parseServerRequests('!x-mcp !X_MCP wow! != ![img](url) !! \\!skip `!code` ```\n!hidden\n``` !Hyper-MCP').map(x=>x.name), ['x-mcp','Hyper-MCP']);
});
test('normalization resolves original names and reports typos', () => {
 assert.deepEqual(resolveServerRequests(['hyper_mcp','x-mpc'], [{token:'hyper-mcp',label:'Hyper MCP',aliases:['Hyper MCP']}]), {matched:['hyper-mcp'],unknown:['x-mpc']});
});
test('bang menu matches loose prefixes, ignores code, and inserts canonical spelling', () => {
 const trigger = findTrigger('@null !hy',9);
 assert.equal(trigger?.kind,'server');
 assert.deepEqual(menuItems(trigger,[],[{agent:'null',token:'hyper-mcp',label:'Hyper MCP',aliases:['Hyper MCP']}]).map(x=>x.label),['!hyper-mcp']);
 for(const text of ['wow!','`!x','```\n!x','\\!x','!!']) assert.equal(findTrigger(text,text.length),null);
});

test('plugin aliases search one canonical row and resolve to its token', () => {
 const entry = {token:'computer-use',label:'Computer Use',aliases:['native_control','Computer Use','computer_use']};
 for (const query of ['','native','Computer','computer_']) {
  const items = menuItems({kind:'server',query,start:0,end:0},[],[{agent:'null',...entry}]);
  assert.deepEqual(items.map(x=>x.label),['!computer-use']);
  assert.equal(items[0].detail,'Computer Use · null');
 }
 assert.deepEqual(resolveServerRequests(['native-control','computer_use','Computer-Use'],[entry]),{matched:['computer-use'],unknown:[]});
});
