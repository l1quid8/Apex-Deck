import test from 'node:test';
import assert from 'node:assert/strict';
import { appFile } from '../desktop/files.mjs';

test('app:// serves files inside dist and nothing outside it', () => {
  assert.equal(appFile('/d/dist', 'app://deck/'), '/d/dist/index.html');
  assert.equal(appFile('/d/dist', 'app://deck/assets/index-abc.js'), '/d/dist/assets/index-abc.js');
  assert.equal(appFile('/d/dist', 'app://deck/branding/mark%20one.svg?x=1#y'), '/d/dist/branding/mark one.svg');
  // The URL parser folds encoded dot segments, which keeps this one inside.
  assert.equal(appFile('/d/dist', 'app://deck/assets/%2E%2E/%2E%2E/secret'), '/d/dist/secret');
  assert.equal(appFile('/d/dist', 'app://deck/..%2Fsecret'), null);
  assert.equal(appFile('/d/dist', 'app://deck/a%00b'), null);
  assert.equal(appFile('/d/dist', 'app://other/index.html'), null);
  assert.equal(appFile('/d/dist', 'app://deck/%E0%A4%A'), null);
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
  const isDir = (p) => ['/w/one', '/w/two', '/repo'].includes(p);
  assert.deepEqual(startupFolders(['/bin/electron', '/repo', '/w/one', '--inspect', '/w/file.txt', '/w/two'], false, isDir), ['/w/one', '/w/two']);
  assert.deepEqual(startupFolders(['/Applications/Apex Deck.app/Contents/MacOS/Apex Deck', '/w/one'], true, isDir), ['/w/one']);
  assert.deepEqual(startupFolders(['/Applications/Apex Deck.app/Contents/MacOS/Apex Deck', '-psn_0_123'], true, isDir), []);
});
