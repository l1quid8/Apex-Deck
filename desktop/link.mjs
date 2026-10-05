// One connection to a daemon, carrying protocol lines: the local socket here.

import net from 'node:net';
import { lineReader } from './lines.mjs';

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
