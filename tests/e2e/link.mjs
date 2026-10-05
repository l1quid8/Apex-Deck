// Node links for DaemonClient in tests: a unix socket, or a child's stdio.
import net from 'node:net';

/** Calls `onLine` with each whole line, across chunk boundaries. */
export function lineSplitter(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (line) onLine(line);
    }
  };
}

/** A Link over the daemon's local socket; `socket` is there for tests to break. */
export function socketLink(path) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.setEncoding('utf8');
    let lineCb = () => {};
    let closeCb = () => {};
    let why = 'the connection closed';
    socket.on('data', lineSplitter((line) => lineCb(line)));
    socket.on('error', (e) => { why = e.message; });
    socket.once('connect', () => {
      socket.off('error', reject);
      socket.on('close', () => closeCb(why));
      resolve({
        socket,
        send: (line) => socket.write(line + '\n'),
        close: () => socket.destroy(),
        onLine: (cb) => { lineCb = cb; },
        onClose: (cb) => { closeCb = cb; },
      });
    });
    socket.once('error', reject);
  });
}
