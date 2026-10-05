import test from 'node:test';
import assert from 'node:assert/strict';
import { childLink } from '../desktop/link.mjs';

function run(script) {
  return new Promise((resolve) => {
    const lines = [];
    const link = childLink('sh', ['-c', script], {
      onLine: (line) => lines.push(line),
      onClose: (reason) => resolve({ lines, reason }),
    });
    link.send('{"id":0}');
  });
}

test('a child carries lines both ways, and its last words are the close reason', async () => {
  const { lines, reason } = await run('read line; echo "got $line"; echo "Permission denied (publickey)." >&2; exit 255');
  assert.deepEqual(lines, ['got {"id":0}']);
  assert.equal(reason, 'Permission denied (publickey).');
});

test('only the last 2 KB of what it said are kept', async () => {
  const { reason } = await run('head -c 5000 /dev/zero | tr "\\0" "x" >&2; echo " the end" >&2; exit 1');
  assert.ok(reason.length <= 2048, String(reason.length));
  assert.ok(reason.endsWith('the end'));
});

test('a child that says nothing still gives a reason', async () => {
  const { reason } = await run('exit 3');
  assert.equal(reason, 'sh stopped (exit code 3).');
});

test('close ends the child', async () => {
  const closed = new Promise((resolve) => {
    const link = childLink('sh', ['-c', 'sleep 30'], { onLine: () => {}, onClose: resolve });
    setTimeout(() => link.close(), 50);
  });
  assert.match(await closed, /stopped/);
});
