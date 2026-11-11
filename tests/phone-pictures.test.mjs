import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PictureCache, pictureBlock, pictureError } from '../src/phone/pictureRules.ts';

test('pictures need Full access on the machine, and say so instead of a blank gap', () => {
  assert.equal(pictureBlock({ access: { tier: 'read' }, online: true, machine: 'Mac' }), 'Pictures need Full access on Mac');
  assert.equal(pictureBlock({ access: { tier: 'full' }, online: true, machine: 'Mac' }), null);
  // A WebSocket pair carries no access level and keeps what it had.
  assert.equal(pictureBlock({ access: null, online: true, machine: 'Mac' }), null);
  assert.equal(pictureBlock({ access: { tier: 'full' }, online: false, machine: 'Hetzner' }), 'Hetzner is offline');
});

test('a failed read names the reason in plain words', () => {
  assert.equal(pictureError(new Error('frame of 11534336 bytes exceeds the limit')), 'Too large to show on the phone');
  assert.equal(pictureError('Error: No such file or directory'), 'The file is gone');
  assert.equal(pictureError(new Error('denied')), "Couldn't load");
});

test('the cache reads a picture once, forgets failures so Try again reads again, and keeps only the newest', async () => {
  const cache = new PictureCache(2);
  let reads = 0;
  const ok = () => { reads++; return Promise.resolve(new ArrayBuffer(1)); };
  await cache.get('a', ok); await cache.get('a', ok);
  assert.equal(reads, 1, 'the second look is served from the cache');
  let fails = 0;
  const bad = () => { fails++; return Promise.reject(new Error('x')); };
  await cache.get('b', bad).catch(() => {});
  await new Promise((r) => setTimeout(r));
  await cache.get('b', bad).catch(() => {});
  assert.equal(fails, 2, 'a failure is not kept');
  await cache.get('c', ok); await cache.get('d', ok);
  assert.equal(cache.size, 2);
  await cache.get('a', ok);
  assert.equal(reads, 4, 'the oldest picture fell out and is read again');
});

test('the phone thread draws pictures for replies and for what you sent, and the viewer never switches threads', () => {
  const src = fs.readFileSync('src/phone/PhoneApp.tsx', 'utf8');
  assert.match(src, /<PhonePictures paths=\{replyImages\(message\.text\)\} read=\{readPicture\(person\(message\.speaker\.id\)\.display_name\)\}/);
  assert.match(src, /<PhonePictures paths=\{attachedImages\(message\.text\)\} read=\{readPicture\(null\)\}/);
  assert.match(src, /importReplyImage\(paneId, path, by\)/, 'a reply picture is imported first, as on the Mac');
  const viewer = fs.readFileSync('src/phone/PhonePictures.tsx', 'utf8');
  assert.match(viewer, /className="ph-viewer" data-no-swipe/);
});
