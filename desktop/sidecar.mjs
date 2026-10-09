// The apex-daemon this Mac's Deck runs on: find the binary, ask it which data
// folder it would use, and start `serve` when nothing answers there.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** `APEX_DAEMON_BIN`, else the copy bundled with the app, else the dev build. */
export function daemonBinary({ packaged, resourcesPath, repo, env }) {
  if (env.APEX_DAEMON_BIN) return env.APEX_DAEMON_BIN;
  if (packaged) return path.join(resourcesPath, 'bin', 'apex-daemon');
  return path.join(repo, 'target', 'debug', 'apex-daemon');
}

const withDataDir = (args, dataDir) => (dataDir ? [...args, '--data-dir', dataDir] : args);

/** A persistent but checkout-specific data folder for `npm run desktop:dev`. */
export function developmentDataDir(repo, env = process.env, home = os.homedir()) {
  const explicit = env.APEX_DECK_DATA_DIR?.trim();
  if (explicit) return explicit;
  const checkout = path.resolve(repo);
  const label = path.basename(checkout).replace(/[^a-zA-Z0-9_-]/g, '-') || 'checkout';
  const identity = crypto.createHash('sha256').update(checkout).digest('hex').slice(0, 12);
  return path.join(home, '.apex-deck', 'dev', `${label}-${identity}`);
}

/**
 * `serve` that stops when the app does; `--remote` when Remote access is on,
 * so paired phones can reach it from anywhere; a data folder only when one is set.
 */
export const serveArgs = (dataDir, { remote = false } = {}) =>
  withDataDir(['serve', '--exit-on-stdin-close', ...(remote ? ['--remote'] : [])], dataDir);
export const dataDirArgs = (dataDir) => withDataDir(['data-dir'], dataDir);

/** Settings → Remote access, kept in `file` (the app's own settings); off unless saved as on. */
export function remoteAccessSaved(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.remoteAccess === true;
  } catch {
    return false;
  }
}

/** Save the Remote access switch, keeping anything else in `file`. */
export function saveRemoteAccess(file, on) {
  let saved = {};
  try {
    const read = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (read && typeof read === 'object' && !Array.isArray(read)) saved = read;
  } catch {
    // Missing or unreadable: start again.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ ...saved, version: 1, remoteAccess: Boolean(on) }, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/** The folder the daemon would use. */
export function dataFolder(bin, dataDir) {
  return new Promise((resolve, reject) => {
    execFile(bin, dataDirArgs(dataDir), (error, stdout, stderr) => {
      if (error) reject(new Error(error.code === 'ENOENT' ? `There is no apex-daemon at ${bin}.` : (stderr.trim() || error.message)));
      else resolve(stdout.trim());
    });
  });
}

/** Whether something is listening on the socket at `socket`. */
export function answers(socket) {
  return new Promise((resolve) => {
    const probe = net.createConnection(socket);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until something answers on `socket` (or, with `wanted` false, until
 * nothing does). Resolves false when that takes longer than `timeout`.
 */
export async function waitForSocket(socket, { wanted = true, timeout = 15_000 } = {}) {
  const started = Date.now();
  while ((await answers(socket)) !== wanted) {
    if (Date.now() - started > timeout) return false;
    await sleep(50);
  }
  return true;
}

/**
 * A daemon on this Mac's data folder: the one already running there (left
 * running when the app quits), or a `serve` started now that ends with the
 * app. Rejects with the daemon's own words when it won't start.
 */
export async function localDaemon({ bin, dataDir, remote = false, log = () => {} }) {
  const folder = await dataFolder(bin, dataDir);
  const socket = path.join(folder, 'daemon.sock');
  if (await answers(socket)) return { socket, owned: false, child: null, alive: () => true, stop: async () => {} };

  const child = spawn(bin, serveArgs(dataDir, { remote }), { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  let exited = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    stderr = (stderr + text).slice(-4096);
    log(text);
  });
  const gone = new Promise((resolve) => child.once('exit', (code, signal) => { exited = { code, signal }; resolve(); }));
  child.once('error', (e) => { exited ??= { code: null, signal: null }; stderr ||= e.message; });
  // A write to a daemon that has left must not take the app down.
  child.stdin.on('error', () => {});

  const started = Date.now();
  for (;;) {
    if (exited) {
      const words = stderr.trim().split('\n').filter(Boolean).at(-1)?.replace(/^apex-daemon: /, '');
      throw new Error(words || `apex-daemon stopped as it started (${exited.code ?? exited.signal}).`);
    }
    if (await answers(socket)) break;
    if (Date.now() - started > 15_000) {
      child.kill('SIGKILL');
      throw new Error('apex-daemon did not start within 15 seconds.');
    }
    await sleep(50);
  }
  return {
    socket,
    owned: true,
    child,
    alive: () => exited === null,
    /** Close its stdin and give it 15 s to wind down, then kill it. */
    stop: async () => {
      if (exited) return;
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      await gone;
      clearTimeout(timer);
    },
  };
}
