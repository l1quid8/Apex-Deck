import test from 'node:test';
import assert from 'node:assert/strict';
import { imageInputNotice } from '../src/imageInput.ts';

const roster = ['Vision', 'Text', 'Custom'].map((name, id) => ({
  id: String(id), display_name: name, can_read_images: name === 'Text',
  backend: { kind: 'open_ai_compatible', model: name },
}));
const lookup = b => ({ image_input: { Vision: true, Text: false }[b.model] });
test('only routed recipients affect an image draft, regardless of legacy profile flags', () => {
  assert.equal(imageInputNotice(['0'], roster, lookup), null);
  const notice = imageInputNotice(['0', '1', '2'], roster, lookup);
  assert.equal(notice.blocked, true);
  assert.match(notice.text, /Text can’t receive images/);
  assert.equal(imageInputNotice(['2'], roster, lookup).blocked, false);
});
