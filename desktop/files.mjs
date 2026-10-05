// Files the Electron shell reads or writes itself.

import fs from 'node:fs';
import path from 'node:path';

/** The file under `root` (the built UI) for an `app://deck/...` URL, or null when it would be outside. */
export function appFile(root, url) {
  let pathname;
  try {
    const parsed = new URL(url);
    if (parsed.host !== 'deck') return null;
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const file = path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
  return file.startsWith(path.resolve(root) + path.sep) ? file : null;
}

/** The last part of `name`, if it's a plain visible file name; throws otherwise. */
export function safeName(name) {
  const last = String(name).split(/[/\\]/).filter((part) => part.trim()).at(-1)?.trim() ?? '';
  if (!last || last.startsWith('.') || last.includes('\0') || String(name).trim().match(/[/\\]$/)) {
    throw new Error('that is not a usable file name');
  }
  return last;
}

function numbered(name, number) {
  if (number === 1) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${number})${name.slice(dot)}` : `${name} (${number})`;
}

/** Write `bytes` under `name` in `dir`, numbering the name when it's taken. Never overwrites. */
export function writeNew(dir, name, bytes) {
  const safe = safeName(name);
  fs.mkdirSync(dir, { recursive: true });
  for (let number = 1; ; number++) {
    const file = path.join(dir, numbered(safe, number));
    try {
      fs.writeFileSync(file, bytes, { flag: 'wx' });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

/** Folders named on the command line after the app (`electron .` has the app's own path first). */
export function startupFolders(argv, packaged, isDir) {
  return argv
    .slice(packaged ? 1 : 2)
    .filter((arg) => !arg.startsWith('-'))
    .map((arg) => path.resolve(arg))
    .filter((folder) => isDir(folder));
}
