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

test('attached pictures are found by their lines', async () => {
  const { attachedImages } = await import('../src/attachments.ts');
  assert.deepEqual(attachedImages('Picture from Grok: an apple\n\nAttached image: /a/grok-image.png\nAttached file: /a/notes.txt'), ['/a/grok-image.png']);
  assert.deepEqual(attachedImages('Attached image: is how I say it'), ['is how I say it']);
  assert.deepEqual(attachedImages('no pictures'), []);
});

test('reply pictures include local markdown links and attachments, once each', async () => {
  const { replyImages } = await import('../src/attachments.ts');
  assert.equal(typeof replyImages, 'function');
  assert.deepEqual(replyImages('Here is [apple.png](/Users/me/.codex/generated_images/apple.png).\n![photo](</a/photo (2).jpg>)\nAttached image: /a/photo (2).jpg'), ['/Users/me/.codex/generated_images/apple.png', '/a/photo (2).jpg']);
});

test('reply pictures ignore remote URLs, nonimages, and code examples', async () => {
  const { replyImages } = await import('../src/attachments.ts');
  assert.equal(typeof replyImages, 'function');
  assert.deepEqual(replyImages('`[example](/a/fake.png)`\n```md\n![example](/a/fake2.png)\n```\n[web](https://example.com/a.png) [notes](/a/notes.txt)\n[encoded](/a/my%20apple.png)'), ['/a/my apple.png']);
});

test('videos are told apart and labelled in attachment lines', async () => {
  const { isVideo, withAttachments, attachedVideos } = await import('../src/attachments.ts');
  assert.ok(isVideo('/a/clip.MP4'));
  assert.ok(isVideo('take.mov') && isVideo('a.webm') && isVideo('b.m4v'));
  assert.ok(!isVideo('photo.png'));
  assert.equal(withAttachments('', ['/x/clip.mp4', '/x/a.png']), 'Attached video: /x/clip.mp4\nAttached image: /x/a.png');
  assert.deepEqual(attachedVideos('Attached video: /a/seedance.mp4\nAttached image: /a/x.png'), ['/a/seedance.mp4']);
});

test('reply videos include local links and attached video lines, and reply pictures stay pictures only', async () => {
  const { replyVideos, replyImages } = await import('../src/attachments.ts');
  const message = 'Clip [run](/Users/me/clip%20one.mov) and ![pic](/a/apple.png)\nAttached video: /a/seedance.mp4\n`[example](/a/fake.mp4)`\n[web](https://example.com/b.mp4)';
  assert.deepEqual(replyVideos(message), ['/Users/me/clip one.mov', '/a/seedance.mp4']);
  assert.deepEqual(replyImages(message), ['/a/apple.png']);
});
