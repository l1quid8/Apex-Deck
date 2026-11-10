import test from 'node:test';
import assert from 'node:assert/strict';
import { composeWire } from '../src/wireText.ts';
import { withAttachments, attachedImages } from '../src/attachments.ts';
import { withTldr } from '../src/tldr.ts';
test('wire composition matches Send and preserves image lines through repeated blank edits',()=>{for(const body of ['', 'hello'])for(const paths of [[],['/a.png','/b.txt']])for(const tldr of [false,true])assert.equal(composeWire(body,paths,tldr),withTldr(withAttachments(body,paths),tldr));assert.equal(composeWire('',[],true),'');for(const typed of ['hi','','hello'])assert.deepEqual(attachedImages(composeWire(typed,['/a.png'],true)),['/a.png']);});
