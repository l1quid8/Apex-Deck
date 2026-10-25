import test from 'node:test';
import assert from 'node:assert/strict';
import { appFile } from '../desktop/files.mjs';

test('app:// serves files inside dist and nothing outside it', () => {
  // Windows resolves '/d/dist' onto the current drive and joins with '\', so the
  // expected paths go through the same path module instead of being spelled out.
  const root = '/d/dist';
  const inRoot = (rel) => path.resolve(root, rel);
  assert.equal(appFile(root, 'app://deck/'), inRoot('./index.html'));
  assert.equal(appFile(root, 'app://deck/assets/index-abc.js'), inRoot('./assets/index-abc.js'));
  assert.equal(appFile(root, 'app://deck/branding/mark%20one.svg?x=1#y'), inRoot('./branding/mark one.svg'));
  // The URL parser folds encoded dot segments, which keeps this one inside.
  assert.equal(appFile(root, 'app://deck/assets/%2E%2E/%2E%2E/secret'), inRoot('./secret'));
  assert.equal(appFile(root, 'app://deck/..%2Fsecret'), null);
  assert.equal(appFile(root, 'app://deck/a%00b'), null);
  assert.equal(appFile(root, 'app://other/index.html'), null);
  assert.equal(appFile(root, 'app://deck/%E0%A4%A'), null);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeName, writeNew, startupFolders } from '../desktop/files.mjs';

test('a saved file keeps only a plain name', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('  Notes.md '), 'Notes.md');
  assert.equal(safeName('a\\b\\c.txt'), 'c.txt');
  for (const bad of ['', '   ', '.', '..', '/', '//', 'dir/', '.env', 'a\0b']) {
    assert.throws(() => safeName(bad), /not a usable file name/, JSON.stringify(bad));
  }
});

test('writeNew numbers the name before its extension and never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-files-'));
  try {
    fs.writeFileSync(path.join(dir, 'Thread.md'), 'old');
    assert.equal(writeNew(dir, 'Thread.md', Buffer.from('two')), path.join(dir, 'Thread (2).md'));
    assert.equal(writeNew(dir, 'Thread.md', Buffer.from('three')), path.join(dir, 'Thread (3).md'));
    assert.equal(writeNew(dir, 'notes', Buffer.from('x')), path.join(dir, 'notes'));
    assert.equal(writeNew(dir, 'notes', Buffer.from('y')), path.join(dir, 'notes (2)'));
    assert.equal(writeNew(dir, '../escape.txt', Buffer.from('z')), path.join(dir, 'escape.txt'));
    assert.equal(fs.readFileSync(path.join(dir, 'Thread.md'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(dir, 'Thread (3).md'), 'utf8'), 'three');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup folders are the existing folders named after the app', () => {
  // startupFolders resolves each argument, so the folder check and the expected
  // list both have to see resolved paths on every platform.
  const resolved = (p) => path.resolve(p);
  const isDir = (p) => ['/w/one', '/w/two', '/repo'].map(resolved).includes(p);
  assert.deepEqual(startupFolders(['/bin/electron', '/repo', '/w/one', '--inspect', '/w/file.txt', '/w/two'], false, isDir), ['/w/one', '/w/two'].map(resolved));
  assert.deepEqual(startupFolders(['/Applications/Apex Deck.app/Contents/MacOS/Apex Deck', '/w/one'], true, isDir), ['/w/one'].map(resolved));
  assert.deepEqual(startupFolders(['/Applications/Apex Deck.app/Contents/MacOS/Apex Deck', '-psn_0_123'], true, isDir), []);
});
