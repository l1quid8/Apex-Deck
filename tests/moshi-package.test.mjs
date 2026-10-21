import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPackage } from '@electron/asar';
import electron from 'electron';

// Exercise Electron's real archive filesystem: Node's ordinary filesystem
// cannot reproduce fs.cp failing on an app.asar directory.
test('Moshi extracts its runner and voice page from app.asar before launching', { skip: process.platform !== 'darwin' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moshi-asar-'));
  try {
    const source = path.join(root, 'source'), runtime = path.join(root, 'runtime');
    await fs.mkdir(source);
    for (const name of ['moshi.mjs', 'moshiRuntime.mjs', 'moshi']) {
      await fs.cp(new URL(`../desktop/${name}`, import.meta.url), path.join(source, name), { recursive: true });
    }
    const archive = path.join(root, 'app.asar');
    await createPackage(source, archive);
    await fs.mkdir(path.join(runtime, 'venv/bin'), { recursive: true });
    await fs.writeFile(path.join(runtime, 'installed-v1'), 'test');
    const server = path.join(root, 'server.cjs');
    await fs.writeFile(server, "require('node:http').createServer((q,s)=>s.end('ready')).listen(Number(process.argv[process.argv.indexOf('--port')+1]), '127.0.0.1');");
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(path.join(runtime, 'venv/bin/python'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(server)} "$@"\n`, { mode: 0o755 });
    const entry = path.join(root, 'entry.mjs');
    await fs.writeFile(entry, `import {app} from 'electron';
import {moshiRuntime} from ${JSON.stringify('file://' + archive + '/moshiRuntime.mjs')};
void app.whenReady().then(async () => {
const voice = moshiRuntime(${JSON.stringify(runtime)});
try { await voice.start(); console.log('MOSHI_ASAR_READY'); }
catch(error) { console.error(error.stack); process.exitCode = 1; }
finally { await voice.stop(); app.exit(process.exitCode || 0); }
});
`);
    const { stdout } = await promisify(execFile)(electron, [entry], { timeout: 15000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    assert.match(stdout, /MOSHI_ASAR_READY/);
    for (const name of ['runner.py', 'index.html', 'voice.js', 'voice.css', 'audio-worklet.js']) {
      assert.deepEqual(await fs.readFile(path.join(runtime, 'client', name)), await fs.readFile(new URL(`../desktop/moshi/${name}`, import.meta.url)));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
