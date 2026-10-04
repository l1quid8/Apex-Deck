import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentName, isImage, withAttachments } from '../src/attachments.ts';

test('pasted screenshots get a usable name from their type', () => {
  assert.equal(attachmentName('image.png', 'image/png'), 'image.png');
  assert.equal(attachmentName('', 'image/jpeg'), 'image.jpg');
  assert.equal(attachmentName('', ''), 'file');
});

test('names become plain ASCII with no leading dots or slashes', () => {
  assert.equal(attachmentName('Screenshot 2026-10-03 at 3.14.15 PM.png'), 'Screenshot-2026-10-03-at-3.14.15-PM.png');
  assert.equal(attachmentName('../../.ssh/id'), 'ssh-id');
  assert.equal(attachmentName('café.jpg'), 'cafe.jpg');
  assert.ok(!attachmentName('.env').startsWith('.'));
});

test('images are told apart from other files', () => {
  assert.ok(isImage('/a/shot.PNG'));
  assert.ok(isImage('photo.jpeg'));
  assert.ok(!isImage('notes.pdf'));
});

test('attachments are appended as one line per path', () => {
  assert.equal(withAttachments('look at this', ['/x/a.png', '/x/b.pdf']), 'look at this\n\nAttached image: /x/a.png\nAttached file: /x/b.pdf');
  assert.equal(withAttachments('', ['/x/a.png']), 'Attached image: /x/a.png');
  assert.equal(withAttachments('hi', []), 'hi');
});
