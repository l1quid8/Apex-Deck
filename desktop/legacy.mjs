// The Tauri app, v0.4.0 and before. What it kept in its window's storage
// (installed mods, model names typed before, sidebar widths and the like)
// lived in WebKit, so the Electron window starts without it; preload.cjs
// copies it over once. The old files are only ever read from a copy, so a
// Tauri app that is still open is not disturbed. It also kept no lock on
// the data folder, so main.mjs asks for it to be quit first.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const list = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** Each localStorage database WebKit kept for the Tauri window, whose origin is tauri://localhost. */
function storageFiles(home) {
  const data = path.join(home, 'Library/WebKit/dev.apexdeck.app/WebsiteData');
  // Older macOS kept one file per origin here.
  const found = [path.join(data, 'LocalStorage/tauri_localhost_0.localstorage')].filter((file) => fs.existsSync(file));
  const root = path.join(data, 'Default');
  for (const top of list(root)) {
    for (const frame of list(path.join(root, top))) {
      const dir = path.join(root, top, frame);
      let origin;
      try {
        origin = fs.readFileSync(path.join(dir, 'origin'), 'latin1');
      } catch {
        continue;
      }
      const file = path.join(dir, 'LocalStorage/localstorage.sqlite3');
      if (origin.includes('tauri') && origin.includes('localhost') && fs.existsSync(file)) found.push(file);
    }
  }
  return found;
}

/** Every key and value the Tauri window stored under `home`; {} when there is none or it can't be read. */
export function tauriStorage(home = os.homedir()) {
  const items = {};
  for (const file of storageFiles(home)) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-deck-import-'));
    try {
      // With its write-ahead log, which holds the latest writes of an app still open.
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, path.join(scratch, `storage${suffix}`));
      }
      const db = new DatabaseSync(path.join(scratch, 'storage'));
      try {
        for (const { key, value } of db.prepare('SELECT key, value FROM ItemTable').all()) {
          // WebKit keeps each value as UTF-16 bytes.
          items[key] = typeof value === 'string' ? value : Buffer.from(value).toString('utf16le');
        }
      } finally {
        db.close();
      }
    } catch {
      // Unreadable: nothing comes over from this file.
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  return items;
}

/**
 * Each open Tauri build of Apex Deck: an `apex-deck` program in an app
 * whose bundle id is this app's. `run` is execFileSync, or a stand-in.
 */
export function openTauriApps(run = execFileSync) {
  let programs;
  try {
    programs = String(run('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' })).split('\n').map((line) => line.trim());
  } catch {
    return [];
  }
  return programs.filter((program) => {
    const bundle = program.match(/^(.*\.app)\/Contents\/MacOS\/apex-deck$/)?.[1];
    if (!bundle) return false;
    try {
      const plist = path.join(bundle, 'Contents/Info.plist');
      return String(run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { encoding: 'utf8' })).trim() === 'dev.apexdeck.app';
    } catch {
      return false;
    }
  });
}
