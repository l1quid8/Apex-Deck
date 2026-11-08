import test from 'node:test';
import assert from 'node:assert/strict';
import { composerCommandRegistry, appComposerCommands } from '../src/composerCommandRegistry.ts';
import vectors from '../shared/cli-runner-vectors.json' with {type:'json'};
import {parseRunnerCommand} from '../src/runner/commands.ts';
test('app runner parser matches the shared terminal vectors',()=>{
  for(const row of vectors){const result=parseRunnerCommand(row.kind,row.arg);
    if(row.error){assert.equal(result.kind,'error');assert.equal(result.message,row.error);}
    else if(row.expected.action){assert.equal(result.kind,row.expected.action);}
    else{assert.equal(result.kind,'start');for(const [key,value]of Object.entries(row.expected))assert.equal(result[key],value);}
  }
});
test('catalog has unique keys and preserves app surface', () => {
  assert.equal(new Set(composerCommandRegistry.map(r=>r.key)).size,composerCommandRegistry.length);
  for (const row of composerCommandRegistry) {
    assert.equal(row.label,'/'+row.key);
    assert.ok(row.handler);
    assert.ok(['client','thread','participant'].includes(row.scope));
  }
  assert.ok(!appComposerCommands.some(r=>r.key==='threads'));
  assert.ok(appComposerCommands.some(r=>r.key==='image'));
});
