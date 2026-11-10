import test from 'node:test';
import assert from 'node:assert/strict';
import { singleToMultiDoc } from '../src/sliceDraft.ts';
test('single conversion preserves real line boundaries and replaces only the typed thread query',()=>{
  const picked={paneId:'A',hostId:'local'};
  assert.deepEqual(singleToMultiDoc('please #Lin check',7,11,picked),[[{kind:'text',text:'please '},{kind:'thread',...picked},{kind:'text',text:' check'}]]);
  assert.deepEqual(singleToMultiDoc('first\n#Lin last\n',6,10,picked),[[{kind:'text',text:'first'}],[{kind:'thread',...picked},{kind:'text',text:' last'}],[]]);
});
