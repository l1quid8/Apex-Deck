// The apex-daemon this Mac's Deck runs on: find the binary, ask it which data
// folder it would use, and start `serve` when nothing answers there.

import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

/** `APEX_DAEMON_BIN`, else the copy bundled with the app, else the dev build. */
export function daemonBinary({ packaged, resourcesPath, repo, env }) {
  if (env.APEX_DAEMON_BIN) return env.APEX_DAEMON_BIN;
  if (packaged) return path.join(resourcesPath, 'bin', 'apex-daemon');
  return path.join(repo, 'target', 'debug', 'apex-daemon');
}

const withDataDir = (args, dataDir) => (dataDir ? [...args, '--data-dir', dataDir] : args);

/** `serve` that stops when the app does; a data folder only when one is set. */
export const serveArgs = (dataDir) => withDataDir(['serve', '--exit-on-stdin-close'], dataDir);
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
 * A daemon on this Mac's data folder: the one already running there (left
 * running when the app quits), or a `serve` started now that ends with the
 * app. Rejects with the daemon's own words when it won't start.
 */
export async function localDaemon({ bin, dataDir, log = () => {} }) {
  const folder = await dataFolder(bin, dataDir);
  const socket = path.join(folder, 'daemon.sock');
  if (await answers(socket)) return { socket, owned: false, child: null, alive: () => true, stop: async () => {} };

  const child = spawn(bin, serveArgs(dataDir), { stdio: ['pipe', 'ignore', 'pipe'] });
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
