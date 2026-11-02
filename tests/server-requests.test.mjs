import test from 'node:test';
import assert from 'node:assert/strict';
import { parseServerRequests, resolveServerRequests } from '../src/serverRequests.ts';
import { findTrigger, menuItems } from '../src/composerMenu.ts';
import { replyText } from '../src/reply.ts';
test('bang requests respect prose, escaping and code boundaries', () => {
 assert.deepEqual(parseServerRequests('!x-mcp !X_MCP wow! != ![img](url) !! \\!skip `!code` ```\n!hidden\n``` !Hyper-MCP').map(x=>x.name), ['x-mcp','Hyper-MCP']);
});
test('normalization resolves original names and reports typos', () => {
 assert.deepEqual(resolveServerRequests(['hyper_mcp','x-mpc'], [{token:'hyper-mcp',label:'Hyper MCP',aliases:['Hyper MCP']}]), {matched:['hyper-mcp'],unknown:['x-mpc']});
});
test('quoted code selections cannot request tool servers', () => {
 const text = replyText('Make this change !github', {id:'null',name:'Null',text:'Guard that branch with !curating too.'}, [{id:'null',display_name:'Null'}]);
 assert.deepEqual(parseServerRequests(text), [{name:'github',start:23,end:30}]);
 const quoted = '> Guard with !curating';
 assert.equal(findTrigger(quoted, quoted.length), null);
});
test('quoted backticks do not hide tool requests in the human prose that follows', () => {
 const text = '> Use `!curating\r\n  >> !missing\r\n\r\nUse !github';
 assert.deepEqual(parseServerRequests(text), [{name:'github',start:39,end:46}]);
 assert.equal(findTrigger(text, text.length)?.query, 'github');
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
