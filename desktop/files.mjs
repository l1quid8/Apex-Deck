// Files the Electron shell reads or writes itself.

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
