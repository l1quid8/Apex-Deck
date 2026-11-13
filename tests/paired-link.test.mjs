import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopKey, remotePipe, pairedLink } from '../desktop/pairedLink.mjs';

test('desktop client identity persists separately and rejects a damaged key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-key-'));
  try {
    const key = desktopKey(dir);
    assert.equal(key.length, 32); assert.deepEqual(desktopKey(dir), key);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'desktop-remote.key')).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(dir, 'desktop-remote.key'), 'bad');
    assert.throws(() => desktopKey(dir), /identity/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('paired transport opens, forwards protocol lines, and closes on cancellation', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pipe-'));
  const bin = path.join(dir, 'fixture');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const readline = require('node:readline');
let configured = false;
readline.createInterface({input:process.stdin}).on('line', line => {
  if (!configured) { configured = true; const config = JSON.parse(line); if (config.key.length !== 32 || process.argv.some(a => a.includes('secret-link'))) process.exit(2); console.log(JSON.stringify({type:'opened'})); }
  else console.log(JSON.stringify({type:'line',line}));
});
`, { mode: 0o700 });
  let link;
  try {
    let receive, closed;
    const received = new Promise(resolve => { receive = resolve; });
    const ended = new Promise(resolve => { closed = resolve; });
    const controller = new AbortController();
    link = await pairedLink(bin, Array(32).fill(1), { hostEndpointId: 'a'.repeat(64), addrs: [] }, { onLine: receive, onClose: closed }, controller.signal);
    link.send('{"id":1,"cmd":"hello"}');
    assert.equal(await received, '{"id":1,"cmd":"hello"}');
    controller.abort(); assert.match(await ended, /cancelled/);
    const problem = await new Promise(resolve => remotePipe(path.join(dir, 'missing'), [], { op: 'pair', link: 'secret-link' }, resolve));
    assert.equal(problem.type, 'closed');
  } finally { link?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
