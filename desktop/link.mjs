// One connection to a daemon, carrying protocol lines: the local socket on
// this Mac, or an `ssh HOST apex-daemon --stdio --attach` child for another.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { sshArgs } from './hosts.mjs';
import { lineReader } from './lines.mjs';

/** How much of a child's stderr becomes the close reason. */
const LAST_WORDS = 2048;

/**
 * Connect to the daemon's socket. `onLine` gets each line and `onClose` the
 * reason, once, however the connection ends (including `close()`).
 */
export function socketLink(socketPath, { onLine, onClose }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let why = 'The connection to the host closed.';
    let closed = false;
    const end = () => {
      if (closed) return;
      closed = true;
      onClose(why);
    };
    const read = lineReader(onLine, (problem) => {
      why = problem;
      socket.destroy();
    });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      socket.on('error', (e) => { why = e.message; });
      socket.on('data', read);
      socket.on('close', end);
      resolve({
        send: (line) => { if (!closed) socket.write(line + '\n'); },
        close: () => socket.destroy(),
      });
    });
  });
}

/**
 * A child speaking the protocol on its stdin and stdout. When it ends, the
 * reason is the end of what it wrote to stderr: ssh's "Permission denied
 * (publickey)." or "Host key verification failed.", or the daemon's own words.
 */
export function childLink(program, args, { onLine, onClose }) {
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let problem = '';
  let closed = false;
  const read = lineReader(onLine, (why) => {
    problem = why;
    child.kill();
  });
  child.stdout.on('data', read);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => { stderr = (stderr + text).slice(-LAST_WORDS * 2); });
  child.stdin.on('error', () => {});
  child.once('error', (e) => { problem ||= e.code === 'ENOENT' ? `There is no ${program} on this Mac.` : e.message; });
  child.once('close', (code, signal) => {
    if (closed) return;
    closed = true;
    const said = stderr.trim().slice(-LAST_WORDS).trim();
    onClose(problem || said || `${path.basename(program)} stopped (${code === null ? signal : `exit code ${code}`}).`);
  });
  return {
    send: (line) => { if (!closed && child.stdin.writable) child.stdin.write(line + '\n'); },
    close: () => child.kill(),
  };
}

/** `host`'s daemon over SSH. */
export function sshLink(host, handlers) {
  return childLink('ssh', sshArgs(host), handlers);
}
