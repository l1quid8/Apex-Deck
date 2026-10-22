// Settings → Remote access talks to the running daemon. Turning phone
// connections on or off is a `remote_set` on that daemon. Nothing restarts.
//
// The old `desktop-settings.json` key `remoteAccess` is imported once, and
// only when the daemon has no saved setting of its own. If deleting the key
// fails, the next launch sends the import again and the daemon ignores it.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const words = (error) => String(error instanceof Error ? error.message : error).trim();

/** The object in `file`, or {} when it is missing or not an object. */
export function readDesktopSettings(file) {
  try {
    const read = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (read && typeof read === 'object' && !Array.isArray(read)) return read;
  } catch {
    // Missing or unreadable: there is nothing to import.
  }
  return {};
}

/** True while the old Remote access key is still in `file`. */
export function hasRemoteAccessKey(file) {
  return Object.prototype.hasOwnProperty.call(readDesktopSettings(file), 'remoteAccess');
}

/** Write `settings`, keeping every key the caller left in it. */
export function writeDesktopSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ ...settings, version: 1 }, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/**
 * One request on the daemon's socket. Says hello, then sends `cmd`, and
 * skips every other frame. Rejects with the daemon's words.
 */
export function callDaemon(socketPath, cmd, args, { timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('The background service did not answer.')), timeout);
    socket.once('error', (error) => finish(reject, new Error(words(error) || 'Could not reach the background service.')));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: 0, cmd: 'hello', args: { protocol: 1 } })}\n`);
      socket.write(`${JSON.stringify({ id: 1, cmd, args: args ?? {} })}\n`);
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.id !== 1) continue;
        if (typeof frame.err === 'string') finish(reject, new Error(frame.err));
        else finish(resolve, frame.ok);
      }
    });
    socket.on('close', () => finish(reject, new Error('The background service closed the connection without answering.')));
  });
}

/** Turn phone connections on or off. `call` is `(cmd, args) => daemon answer`. */
export function setPhoneConnections({ enabled, call }) {
  return call('remote_set', { enabled: enabled === true, import: false });
}

/**
 * Send the old desktop setting once. The daemon applies it only when it has
 * no saved setting. The key is deleted after that answer. A failed delete
 * leaves the key, so the next launch can send the import again.
 * Throws when the daemon call fails, and leaves the key in that case too.
 */
export async function importSavedRemoteAccess(file, call) {
  const saved = readDesktopSettings(file);
  if (!Object.prototype.hasOwnProperty.call(saved, 'remoteAccess')) return null;
  const info = await call('remote_set', { enabled: saved.remoteAccess === true, import: true });
  const next = readDesktopSettings(file);
  if (!Object.prototype.hasOwnProperty.call(next, 'remoteAccess')) return info;
  delete next.remoteAccess;
  try {
    writeDesktopSettings(file, next);
  } catch {
    // The daemon already recorded the import. The key stays so a later launch
    // sends it again, and a daemon that already has a setting ignores it.
  }
  return info;
}
