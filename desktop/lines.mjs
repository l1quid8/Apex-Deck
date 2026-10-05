// Bytes from a socket or a child's stdout, split into protocol lines.

/** The daemon's MAX_FRAME (crates/apex-daemon/src/protocol.rs). */
export const MAX_LINE = 32 * 1024 * 1024;

/**
 * Returns a function to feed chunks to. Each whole line (without its `\n` or
 * `\r\n`; empty ones skipped) goes to `onLine`. A line that grows past
 * MAX_LINE goes to `onError` once, and nothing is read after it.
 */
export function lineReader(onLine, onError) {
  let parts = [];
  let size = 0;
  let broken = false;
  const finish = (last) => {
    parts.push(last);
    let line = Buffer.concat(parts).toString('utf8');
    parts = [];
    size = 0;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line) onLine(line);
  };
  return (chunk) => {
    if (broken) return;
    let bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    // A newline byte never sits inside a multi-byte character.
    for (let at = bytes.indexOf(0x0a); at >= 0; at = bytes.indexOf(0x0a)) {
      finish(bytes.subarray(0, at));
      bytes = bytes.subarray(at + 1);
    }
    if (bytes.length === 0) return;
    size += bytes.length;
    if (size > MAX_LINE) {
      broken = true;
      parts = [];
      onError('The host sent a line longer than 32 MB.');
      return;
    }
    parts.push(bytes);
  };
}
