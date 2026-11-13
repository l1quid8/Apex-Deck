import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lineReader } from './lines.mjs';

/** Separate client identity; never reuse the local daemon's host identity. */
export function desktopKey(folder) {
  const file = path.join(folder, 'desktop-remote.key');
  try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error('Desktop pairing identity is invalid.');
  return [...key];
}

/** The private Rust bridge receives secrets only through its stdin pipe. */
export function remotePipe(bin, key, config, onEvent) {
  const child = spawn(bin, ['remote-client'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let ended = false, stderr = '';
  const close = () => { ended = true; child.kill(); };
  const fail = reason => { if (!ended) { ended = true; onEvent({ type: 'closed', code: 1005, reason }); child.kill(); } };
  child.stdout.on('data', lineReader(line => {
    if (ended) return;
    try { onEvent(JSON.parse(line)); } catch { fail('The paired transport sent invalid data.'); }
  }, fail));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr = (stderr + text).slice(-2048); });
  child.on('error', error => fail(error.message));
  child.on('close', () => fail(stderr.trim() || 'The paired connection closed.'));
  child.stdin.on('error', error => fail(error.message));
  child.stdin.write(JSON.stringify({ ...config, key }) + '\n');
  return { close, send: line => { if (!ended) child.stdin.write(line + '\n'); } };
}

export function pairedLink(bin, key, host, handlers, signal) {
  return new Promise((resolve, reject) => {
    const close = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pipe.close(); };
    const abort = () => { close(); if (!opened) reject(new Error('Pairing cancelled.')); else handlers.onClose('Pairing cancelled.'); };
    const timer = setTimeout(() => { close(); reject(new Error('The paired host did not answer.')); }, 25000);
    let opened = false;
    const pipe = remotePipe(bin, key, { op: 'connect', hostEndpointId: host.hostEndpointId, addrs: host.addrs }, event => {
      if (event.type === 'opened') { opened = true; clearTimeout(timer); resolve({ send: pipe.send, close }); }
      else if (event.type === 'line') handlers.onLine(event.line);
      else if (event.type === 'closed') {
        close();
        const reason = [1, 2].includes(event.code) ? 'This desktop’s access was removed. Pair this host again.' : event.reason;
        if (!opened) reject(new Error(reason || 'The paired host disconnected.'));
        else handlers.onClose(reason);
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
