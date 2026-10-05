import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openTauriApps, tauriStorage } from '../desktop/legacy.mjs';

/** A WebKit localStorage database for `origin` under a fake home, the way the Tauri window left it. */
function webkitStorage(home, folder, origin, items, { wal = false } = {}) {
  const dir = path.join(home, 'Library/WebKit/dev.apexdeck.app/WebsiteData/Default', folder, folder);
  fs.mkdirSync(path.join(dir, 'LocalStorage'), { recursive: true });
  // WebKit's origin file is binary; the scheme and host appear in it as text.
  fs.writeFileSync(path.join(dir, 'origin'), Buffer.concat([Buffer.from([0, 5]), Buffer.from(origin.join('\0'))]));
  const db = new DatabaseSync(path.join(dir, 'LocalStorage/localstorage.sqlite3'));
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)');
  const put = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(items)) put.run(key, Buffer.from(value, 'utf16le'));
  return { dir, db };
}

test("the Tauri window's storage comes back as text, and other sites' storage is left out", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
  webkitStorage(home, 'a', ['tauri', 'localhost'], { 'deck.mods': '[{"name":"tldr"}]', 'apex-deck.sidebars.v1': '{"rail":210}', wide: 'ünï 🙂' }).db.close();
  webkitStorage(home, 'b', ['https', 'example.com'], { 'deck.mods': '[]' }).db.close();
  assert.deepEqual(tauriStorage(home), { 'deck.mods': '[{"name":"tldr"}]', 'apex-deck.sidebars.v1': '{"rail":210}', wide: 'ünï 🙂' });
  fs.rmSync(home, { recursive: true });
});

test('writes still in the write-ahead log of an open Tauri app are read, and its files are not changed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
  // Left open, as by a Tauri app that is still running: the rows stay in the -wal file.
  const { dir, db } = webkitStorage(home, 'a', ['tauri', 'localhost'], { 'deck.mods': '[1]' }, { wal: true });
  const file = path.join(dir, 'LocalStorage/localstorage.sqlite3');
  const before = ['', '-wal', '-shm'].map((suffix) => fs.readFileSync(file + suffix));
  assert.deepEqual(tauriStorage(home), { 'deck.mods': '[1]' });
  assert.deepEqual(['', '-wal', '-shm'].map((suffix) => fs.readFileSync(file + suffix)), before);
  db.close();
  fs.rmSync(home, { recursive: true });
});

test('no Tauri storage, or storage that cannot be read, gives nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
  assert.deepEqual(tauriStorage(home), {});
  const { dir, db } = webkitStorage(home, 'a', ['tauri', 'localhost'], {});
  db.close();
  fs.writeFileSync(path.join(dir, 'LocalStorage/localstorage.sqlite3'), 'not a database');
  assert.deepEqual(tauriStorage(home), {});
  fs.rmSync(home, { recursive: true });
});

test('an open Tauri build of Apex Deck is found by its bundle id, and nothing else is', () => {
  const ids = {
    '/Applications/Apex Deck.app/Contents/Info.plist': 'dev.apexdeck.app',
    '/tmp/Preview Deck.app/Contents/Info.plist': 'dev.apexdeck.preview',
  };
  const run = (program, args) => {
    if (program === '/bin/ps') {
      return ['/Applications/Apex Deck.app/Contents/MacOS/apex-deck', '/tmp/Preview Deck.app/Contents/MacOS/apex-deck',
        '/Applications/Apex Deck.app/Contents/MacOS/Apex Deck', '/Users/me/apex/target/debug/apex-deck', '/sbin/launchd', ''].join('\n');
    }
    if (!(args.at(-1) in ids)) throw new Error('no such file');
    return `${ids[args.at(-1)]}\n`;
  };
  assert.deepEqual(openTauriApps(run), ['/Applications/Apex Deck.app/Contents/MacOS/apex-deck']);
  assert.deepEqual(openTauriApps(() => { throw new Error('no ps'); }), []);
});
