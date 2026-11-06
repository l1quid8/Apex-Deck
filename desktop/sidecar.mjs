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

/** Keep the development daemon's socket separate from an installed service. */
export const developmentHostDataDir = (dataDir) => `${dataDir}-checkout-host`;

/**
 * Shared `serve` survives desktop exit; `--remote` when Remote access is on,
 * so paired phones can reach it from anywhere; a data folder only when one is set.
 */
export const serveArgs = (dataDir, { remote = false } = {}) =>
  withDataDir(['serve', ...(remote ? ['--remote'] : [])], dataDir);
export const dataDirArgs = (dataDir) => withDataDir(['data-dir'], dataDir);

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
 * running when the app quits), or a persistent `serve` started now. CLI clients
 * share its rooms, so closing the desktop must not interrupt it.
 * Rejects with the daemon's own words when it won't start.
 */
export async function localDaemon({ bin, dataDir, remote = false, log = () => {} }) {
  const folder = await dataFolder(bin, dataDir);
  const socket = path.join(folder, 'daemon.sock');
  if (await answers(socket)) return { socket, owned: false, child: null, alive: () => true, stop: async () => {} };

  // A detached service cannot keep Electron's pipes open or receive SIGHUP
  // when the desktop exits. Keep diagnostics available without owning its life.
  const logPath = path.join(folder, 'desktop-daemon.log');
  fs.mkdirSync(folder, { recursive: true });
  const logFd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  let child;
  try {
    child = spawn(bin, serveArgs(dataDir, { remote }), { detached: true, stdio: ['ignore', 'ignore', logFd] });
  } finally { fs.closeSync(logFd); }
  child.unref();
  let exited = null;
  let spawnError = '';
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  child.once('error', (error) => { exited ??= { code: null, signal: null }; spawnError = error.message; });

  const started = Date.now();
  for (;;) {
    if (exited) {
      // CLI or another desktop may have won the startup lock after our probe.
      if (!spawnError && await waitForSocket(socket, { timeout: Math.max(0, 15_000 - (Date.now() - started)) })) {
        return { socket, owned: false, child: null, alive: () => true, stop: async () => {} };
      }
      const stderr = spawnError || fs.readFileSync(logPath, 'utf8').slice(-4096);
      log(stderr);
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
    /** The daemon belongs to all connected clients, even if we started it. */
    stop: async () => {},
  };
}
